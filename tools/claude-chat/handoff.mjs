#!/usr/bin/env node
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import {spawn as nodeSpawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

// Hands the Claude Code root's checkpoint to Astra Claude Chat: starts the
// server if it is not running, opens a new chat with the checkpoint as its
// first message and opens the browser. Developer tooling only; it is not part
// of the bot runtime or the Docker image.
//
//   node tools/claude-chat/handoff.mjs <checkpoint.md> [--no-open] [--port N] [--replace]
//
// Exit codes: 0 handed off, 1 bad input, 2 server could not start, the port
// belongs to another process or Astra already runs on another port, 3 Astra is
// busy or holds an idle chat (--replace allows replacing the idle chat; a busy
// chat is never touched).

const toolDir = path.dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = path.resolve(toolDir, '..', '..');

export const PREAMBLE = 'Continue work handed off by the Claude Code root under the AGENTS.md API-credit continuation rules. '
  + 'Verify the Git branch, revision and dirty paths first. Do not redo finished work. You are the only writer of this checkout. '
  + 'Work solo: do not use the Workflow tool, and start subagents only within a limit the owner sets. '
  + 'Every safety, Git, host, browser and approval (GO) rule in AGENTS.md still applies, and the ultracode opt-in written for the root does not apply to you. '
  + 'Never buy credits or enable auto-reload. When the owner says stop, save a checkpoint to .qa-local/ and stop. '
  + 'The checkpoint follows.';
const MAX_MESSAGE = 100000; // server limit for one message
const READY_TIMEOUT_MS = 30000;

export class HandoffError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const USAGE = 'Usage: node tools/claude-chat/handoff.mjs <checkpoint.md> [--no-open] [--port N] [--replace]\nThe checkpoint must be a file under the repository .qa-local/ folder.';

export function parseArgs(argv) {
  const out = {checkpoint: null, noOpen: false, port: null, replace: false};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-open') out.noOpen = true;
    else if (arg === '--replace') out.replace = true;
    else if (arg === '--port') out.port = argv[++i];
    else if (arg.startsWith('--')) throw new HandoffError(1, `Unknown option ${arg}\n${USAGE}`);
    else if (out.checkpoint === null) out.checkpoint = arg;
    else throw new HandoffError(1, `Only one checkpoint file is allowed\n${USAGE}`);
  }
  if (out.checkpoint === null) throw new HandoffError(1, USAGE);
  return out;
}

const inside = (child, parent) => { const rel = path.relative(parent, child); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); };

// The checkpoint is read into a chat that can act on the repository, so only a
// regular file whose real path lies under <repo>/.qa-local/ is accepted:
// traversal, symlinks and junctions that lead out are refused. The chat's own
// state and log hold the access token and are never a checkpoint.
export function readCheckpoint(arg, repoRoot) {
  const lexical = path.resolve(arg);
  const qaLocal = path.join(repoRoot, '.qa-local');
  if (!inside(lexical, qaLocal)) throw new HandoffError(1, `Checkpoint must be under ${qaLocal}`);
  let real;
  try { real = fs.realpathSync(lexical); } catch { throw new HandoffError(1, `Checkpoint not found: ${lexical}`); }
  if (!inside(real, path.join(fs.realpathSync(repoRoot), '.qa-local'))) throw new HandoffError(1, 'Checkpoint resolves outside .qa-local/ (symlink or junction)');
  if (path.basename(real).toLowerCase().startsWith('claude-chat')) throw new HandoffError(1, 'The chat state and log files cannot be a checkpoint');
  const stat = fs.statSync(real);
  if (!stat.isFile()) throw new HandoffError(1, 'Checkpoint must be a regular file');
  if (stat.size > MAX_MESSAGE * 4) throw new HandoffError(1, 'Checkpoint is too large; compact it first');
  const text = fs.readFileSync(real, 'utf8').trim();
  if (!text) throw new HandoffError(1, 'Checkpoint is empty');
  const message = `${PREAMBLE}\n\n---\n${text}`;
  if (message.length > MAX_MESSAGE) throw new HandoffError(1, `Checkpoint is too long for one message (${message.length} > ${MAX_MESSAGE} characters); compact it first`);
  return message;
}

// Spawn environment: no inherited CLAUDE* or ANTHROPIC_* variable in any case
// (the Console key comes only from tools/claude-chat/.env), loopback only, and
// a server that does not print the access link into the log.
export function serverEnv(base, {port, token}) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!/^(claude|anthropic_)/i.test(key)) env[key] = value;
  return {...env, CHAT_HOST: '127.0.0.1', CHAT_PORT: String(port), CHAT_TOKEN: token, CHAT_PRINT_URL: '0',
    CHAT_PERMISSION_MODE: 'default', CHAT_ALLOW_REMOTE: '0', CHAT_ALLOWED_HOSTS: ''};
}

// POSIX gets 0600. Windows has no such mode: the file keeps the ACL inherited
// from .qa-local/ (normally the current user, SYSTEM and Administrators only).
function writeState(file, state) {
  fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
  fs.writeFileSync(file, JSON.stringify(state, null, 2), {mode: 0o600});
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}
function readState(file) {
  try {
    const state = JSON.parse(fs.readFileSync(file, 'utf8'));
    return typeof state?.token === 'string' && state.token.length >= 24 && Number.isInteger(state.port) ? state : null;
  } catch { return null; }
}

async function call(deps, port, token, method, route, body) {
  const res = await deps.fetch(`http://127.0.0.1:${port}${route}`, {
    method, signal: AbortSignal.timeout(10000),
    headers: {'x-chat-token': token, ...(body ? {'content-type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new HandoffError(2, `Astra ${method} ${route} failed: ${res.status} ${data.error ?? ''}`.trim());
  return data;
}
const peek = (deps, port, token) => call(deps, port, token, 'GET', '/api/state').catch(() => null);

function portInUse(port) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => resolve(false));
  });
}

// One retry: a failed spawn reports its error asynchronously and has no pid.
async function startServer({deps, env, port, token, tool, logFile}) {
  fs.mkdirSync(path.dirname(logFile), {recursive: true, mode: 0o700});
  let lastError;
  for (let attempt = 0; attempt < 2; attempt++) {
    const fd = fs.openSync(logFile, 'a', 0o600);
    let child;
    try {
      child = deps.spawn(process.execPath, ['--env-file-if-exists=.env', 'server.mjs'], {
        cwd: tool, env: serverEnv(env, {port, token}), detached: true, windowsHide: true, stdio: ['ignore', fd, fd],
      });
    } catch (error) { lastError = error; continue; } finally { fs.closeSync(fd); }
    if (child.pid) { child.on('error', () => {}); return child; }
    lastError = await new Promise(resolve => child.once('error', resolve));
  }
  throw new HandoffError(2, `Could not start the server detached: ${lastError?.message ?? 'unknown error'}`);
}

async function waitReady({deps, port, token, child, timeoutMs}) {
  let exitCode = null;
  child.once('exit', code => { exitCode = code ?? 'signal'; });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exitCode !== null) return {exited: exitCode};
    const state = await peek(deps, port, token);
    if (state) return {state};
    await new Promise(resolve => setTimeout(resolve, deps.pollMs));
  }
  return {timeout: true};
}

export function openCommand(url, platform = process.platform) {
  if (platform === 'darwin') return {command: 'open', args: [url], options: {}};
  if (platform === 'win32') return {command: 'cmd.exe', args: ['/d', '/s', '/c', `start "" "${url}"`], options: {windowsVerbatimArguments: true}};
  return {command: 'xdg-open', args: [url], options: {}};
}
function openUrl(url) {
  const {command, args, options} = openCommand(url);
  const child = nodeSpawn(command, args, {...options, detached: true, stdio: 'ignore', windowsHide: true});
  child.on('error', () => {});
  child.unref();
}

export async function runHandoff({checkpoint, noOpen = false, replace = false, port: portArg = null, env = process.env, repoRoot = defaultRepoRoot, tool = toolDir, deps: given = {}, out = console.log}) {
  const deps = {fetch: globalThis.fetch, spawn: nodeSpawn, kill: process.kill.bind(process), openUrl, readyTimeoutMs: READY_TIMEOUT_MS, pollMs: 250, ...given};
  const message = readCheckpoint(checkpoint, repoRoot);
  const stateFile = path.join(repoRoot, '.qa-local', 'claude-chat-state.json');
  const logFile = path.join(repoRoot, '.qa-local', 'claude-chat.log');
  const wanted = portArg ?? env.CHAT_PORT ?? '8787';
  if (!/^\d+$/.test(String(wanted)) || Number(wanted) < 1 || Number(wanted) > 65535) throw new HandoffError(1, 'Port must be a number from 1 to 65535');

  let port = Number(wanted), token, state = null, started = false;
  const saved = readState(stateFile), explicitPort = portArg !== null || env.CHAT_PORT !== undefined;
  if (saved) {
    const live = await peek(deps, saved.port, saved.token);
    if (live) {
      // A second server would be a second commander; the first stays controllable from its tab.
      if (explicitPort && saved.port !== port) throw new HandoffError(2, `Astra is already running on port ${saved.port} (see .qa-local/claude-chat-state.json). Use that port or stop that server first; no second server was started.`);
      port = saved.port; token = saved.token; state = live;
    }
  }
  if (!state) {
    if (await portInUse(port)) throw new HandoffError(2, `Port ${port} is in use by another process. Stop it or pick another port with --port.`);
    token = randomBytes(24).toString('base64url');
    const child = await startServer({deps, env, port, token, tool, logFile});
    child.unref?.();
    started = true;
    writeState(stateFile, {pid: child.pid, port, token, startedAt: new Date().toISOString()});
    const ready = await waitReady({deps, port, token, child, timeoutMs: deps.readyTimeoutMs});
    if (ready.exited !== undefined) {
      fs.rmSync(stateFile, {force: true});
      throw new HandoffError(2, `The server exited early (code ${ready.exited}): set ANTHROPIC_API_KEY in tools/claude-chat/.env, then retry. Log: ${logFile}`);
    }
    if (ready.timeout) {
      try { deps.kill(child.pid); } catch {}
      fs.rmSync(stateFile, {force: true});
      throw new HandoffError(2, `The server did not answer within ${Math.round(deps.readyTimeoutMs / 1000)} s and was stopped. Log: ${logFile}`);
    }
    state = ready.state;
  }
  if (state.busy) throw new HandoffError(3, 'Astra chat is busy. Finish or stop that chat in the browser first; it was not touched.');
  // An idle chat with history is the owner's work: a new chat would reset it.
  if (state.sessionId && !replace) {
    throw new HandoffError(3, `Astra already holds chat ${state.sessionId} (idle) and it was not touched. A handoff would replace it: save or close that chat first, then run again with --replace.`);
  }

  await call(deps, port, token, 'POST', '/api/new', {});
  await call(deps, port, token, 'POST', '/api/mode', {mode: 'default'});
  await call(deps, port, token, 'POST', '/api/send', {text: message});

  const url = `http://127.0.0.1:${port}/#token=${token}`;
  out(`Astra Claude Chat ${started ? 'started' : 'already running'} on port ${port}; checkpoint sent as a new chat (${message.length} characters, permission mode default).`);
  out(`Open: ${url}`);
  if (!noOpen) deps.openUrl(url);
  return {url, port, started};
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    await runHandoff(parseArgs(process.argv.slice(2)));
  } catch (error) {
    if (!(error instanceof HandoffError)) console.error(error);
    else console.error(error.message);
    process.exitCode = error instanceof HandoffError ? error.code : 2;
  }
}