import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {HandoffError, PREAMBLE, openCommand, parseArgs, readCheckpoint, runHandoff, serverEnv} from '../handoff.mjs';
import {SESSION, TOOL_DIR, baseConfig, fakeQuery, freePort, idleTurn, resultTurn, serve} from './helpers.mjs';

const POISONED = {
  PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'sk-ant-api03-from-the-shell', Anthropic_Auth_Token: 'x', anthropic_base_url: 'https://gateway.test',
  CLAUDECODE: '1', claude_code_oauth_token: 'oauth', CLAUDE_CODE_SESSION_ID: 'parent', Claude_Agent_Sdk_Client_App: 'x', CHAT_ALLOW_REMOTE: '1', CHAT_ALLOWED_HOSTS: 'evil.test:1',
};

function workspace() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-handoff-'));
  const qa = path.join(repoRoot, '.qa-local');
  fs.mkdirSync(qa);
  fs.writeFileSync(path.join(qa, 'checkpoint.md'), '# Checkpoint\nBranch codex/x, next action: finish CHAT-2.\n');
  return {repoRoot, qa, checkpoint: path.join(qa, 'checkpoint.md'), cleanup: () => fs.rmSync(repoRoot, {recursive: true, force: true})};
}

// A spawn that starts the real HTTP app in-process, on the port and token the
// handoff chose, in place of a detached node server.
function fakeSpawn(query = fakeQuery(resultTurn(0))) {
  const runs = [];
  const spawn = (command, args, options) => {
    const run = {command, args, options, child: Object.assign(new EventEmitter(), {pid: 4242, unref() {}})};
    runs.push(run);
    run.ready = serve({query, port: Number(options.env.CHAT_PORT), token: options.env.CHAT_TOKEN, config: {...baseConfig, permissionMode: options.env.CHAT_PERMISSION_MODE}})
      .then(app => { run.app = app; return app; });
    return run.child;
  };
  return {spawn, runs, async close() { for (const run of runs) (await run.ready).close(); }};
}

const quiet = () => { const lines = []; const out = line => lines.push(line); out.lines = lines; return out; };
const sent = chat => chat.events.filter(e => e.type === 'user').map(e => e.text);

test('handoff starts the server with a clean loopback environment and sends the checkpoint as a new chat', async () => {
  const ws = workspace(), fake = fakeSpawn(), out = quiet(), opened = [];
  const port = await freePort();
  try {
    const result = await runHandoff({checkpoint: ws.checkpoint, port: String(port), env: POISONED, repoRoot: ws.repoRoot, out,
      deps: {spawn: fake.spawn, openUrl: url => opened.push(url), pollMs: 10}});
    const [run] = fake.runs, {env} = run.options;
    assert.equal(run.command, process.execPath);
    assert.deepEqual(run.args, ['--env-file-if-exists=.env', 'server.mjs']);
    assert.equal(path.resolve(run.options.cwd), path.resolve(TOOL_DIR));
    assert.equal(run.options.detached, true);
    assert.deepEqual(Object.keys(env).filter(key => /^(claude|anthropic_)/i.test(key)), [], 'no CLAUDE* or ANTHROPIC_* variable, in any case');
    assert.equal(env.PATH, '/bin');
    assert.equal(env.CHAT_HOST, '127.0.0.1');
    assert.equal(env.CHAT_PORT, String(port));
    assert.equal(env.CHAT_PRINT_URL, '0');
    assert.equal(env.CHAT_PERMISSION_MODE, 'default');
    assert.equal(env.CHAT_ALLOW_REMOTE, '0');
    assert.equal(env.CHAT_ALLOWED_HOSTS, '');
    assert.ok(env.CHAT_TOKEN.length >= 24);
    assert.equal(POISONED.ANTHROPIC_API_KEY.startsWith('sk-ant'), true, 'the caller environment is not modified');

    const app = await run.ready;
    const messages = sent(app.chat);
    assert.equal(messages.length, 1);
    assert.ok(messages[0].startsWith(PREAMBLE));
    assert.ok(messages[0].includes('next action: finish CHAT-2.'));
    assert.equal(app.chat.mode, 'default', 'handoff chats ask before editing');
    assert.equal(app.chat.events[0].type, 'reset', 'a new chat was opened first');

    assert.equal(result.url, `http://127.0.0.1:${port}/#token=${env.CHAT_TOKEN}`);
    assert.deepEqual(opened, [result.url]);
    assert.ok(out.lines.some(line => line === `Open: ${result.url}`));
    const state = JSON.parse(fs.readFileSync(path.join(ws.qa, 'claude-chat-state.json'), 'utf8'));
    assert.deepEqual({pid: state.pid, port: state.port, token: state.token}, {pid: 4242, port, token: env.CHAT_TOKEN});
    const log = path.join(ws.qa, 'claude-chat.log');
    assert.ok(fs.existsSync(log));
    assert.equal(fs.readFileSync(log, 'utf8').includes(env.CHAT_TOKEN), false, 'the token is not in the log');
  } finally { await fake.close(); ws.cleanup(); }
});

test('the state file is private on POSIX', { skip: process.platform === 'win32' ? 'Windows has no POSIX mode; the file relies on the ACL inherited from .qa-local/ (README)' : false }, async () => {
  const ws = workspace(), fake = fakeSpawn();
  try {
    await runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(await freePort()), env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}});
    const stateFile = path.join(ws.qa, 'claude-chat-state.json');
    assert.equal(fs.statSync(stateFile).mode & 0o777, 0o600);
    fs.chmodSync(stateFile, 0o644);
    await runHandoff({checkpoint: ws.checkpoint, noOpen: true, replace: true, port: String(fake.runs[0].options.env.CHAT_PORT), env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}});
    assert.equal(fake.runs.length, 1, 'the running server was reused');
    fs.rmSync(stateFile);
    fake.runs[0].app.server.close();
  } finally { await fake.close(); ws.cleanup(); }
});

test('--no-open prints the link and opens nothing; a running server is reused', async () => {
  const ws = workspace(), fake = fakeSpawn(), opened = [];
  const port = String(await freePort());
  const options = {checkpoint: ws.checkpoint, noOpen: true, port, env: {PATH: '/bin'}, repoRoot: ws.repoRoot, deps: {spawn: fake.spawn, openUrl: url => opened.push(url), pollMs: 10}};
  try {
    const first = await runHandoff({...options, out: quiet()});
    assert.deepEqual(opened, []);
    assert.equal(first.started, true);
    await new Promise(resolve => setTimeout(resolve, 20));
    const second = await runHandoff({...options, replace: true, out: quiet()});
    assert.equal(second.started, false);
    assert.equal(fake.runs.length, 1, 'no second server');
    assert.equal(second.url, first.url);
    const messages = sent((await fake.runs[0].ready).chat);
    assert.equal(messages.length, 1, 'the second handoff opened a fresh chat');
  } finally { await fake.close(); ws.cleanup(); }
});

test('a busy chat is refused and left untouched', async () => {
  const ws = workspace(), fake = fakeSpawn(fakeQuery(idleTurn));
  const port = String(await freePort());
  const options = {checkpoint: ws.checkpoint, noOpen: true, port, env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}};
  try {
    await runHandoff(options);
    const {chat} = await fake.runs[0].ready;
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(chat.busy, true);
    const before = chat.events.length;
    await assert.rejects(runHandoff(options), error => error instanceof HandoffError && error.code === 3 && /busy/.test(error.message));
    assert.equal(chat.events.length, before, 'no reset, mode change or message');
    assert.equal(chat.busy, true);
  } finally { await fake.close(); ws.cleanup(); }
});

const until = async (condition, ms = 2000) => { const end = Date.now() + ms; while (!condition() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.ok(condition(), 'condition not met in time'); };

// S-F5: an idle chat with history is the owner's work; a handoff must not reset it.
test('an idle chat that holds a session is refused with its id unless --replace is given', async () => {
  const ws = workspace(), fake = fakeSpawn();
  const port = String(await freePort());
  const options = {checkpoint: ws.checkpoint, noOpen: true, port, env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}};
  try {
    await runHandoff(options);
    const {chat} = await fake.runs[0].ready;
    await until(() => chat.sessionId === SESSION && !chat.busy);
    const before = chat.events.length;
    await assert.rejects(runHandoff(options), error => error instanceof HandoffError && error.code === 3 && error.message.includes(SESSION) && /--replace/.test(error.message));
    assert.equal(chat.events.length, before, 'no reset, mode change or message');
    assert.equal(chat.sessionId, SESSION);
    assert.equal(fake.runs.length, 1, 'no second server');
    const result = await runHandoff({...options, replace: true});
    assert.equal(result.started, false);
    assert.equal(chat.events[0].type, 'reset', '--replace opens the new chat');
    assert.equal(sent(chat).length, 1, 'the new chat holds the new checkpoint only');
  } finally { await fake.close(); ws.cleanup(); }
});

test('a busy chat is refused even with --replace', async () => {
  const ws = workspace(), fake = fakeSpawn(fakeQuery(idleTurn));
  const port = String(await freePort());
  const options = {checkpoint: ws.checkpoint, noOpen: true, port, env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}};
  try {
    await runHandoff(options);
    const {chat} = await fake.runs[0].ready;
    await until(() => chat.busy && chat.sessionId);
    const before = chat.events.length;
    await assert.rejects(runHandoff({...options, replace: true}), error => error.code === 3 && /busy/.test(error.message));
    assert.equal(chat.events.length, before);
  } finally { await fake.close(); ws.cleanup(); }
});

// S-F5: a live saved server on another port means a second Astra commander; refuse it.
test('a live saved server on another port is reported, and no second server starts', async () => {
  const ws = workspace(), fake = fakeSpawn();
  const first = await freePort();
  try {
    await runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(first), env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}});
    const {chat} = await fake.runs[0].ready;
    await until(() => chat.sessionId === SESSION);
    const stateFile = path.join(ws.qa, 'claude-chat-state.json');
    const savedState = fs.readFileSync(stateFile, 'utf8');
    const other = await freePort();
    for (const [portArg, env] of [[String(other), {PATH: '/bin'}], [null, {PATH: '/bin', CHAT_PORT: String(other)}]]) {
      await assert.rejects(runHandoff({checkpoint: ws.checkpoint, noOpen: true, replace: true, port: portArg, env, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}}),
        error => error instanceof HandoffError && error.code === 2 && error.message.includes(`port ${first}`) && !error.message.includes(JSON.parse(savedState).token));
    }
    assert.equal(fake.runs.length, 1, 'no second server');
    assert.equal(fs.readFileSync(stateFile, 'utf8'), savedState, 'the state file still names the first server');
    assert.equal(chat.sessionId, SESSION, 'the first chat was not touched');
  } finally { await fake.close(); ws.cleanup(); }
});

test('a stale state file does not block a handoff on another port', async () => {
  const ws = workspace(), fake = fakeSpawn();
  const dead = await freePort(), wanted = await freePort();
  fs.writeFileSync(path.join(ws.qa, 'claude-chat-state.json'), JSON.stringify({pid: 1, port: dead, token: 'T'.repeat(30)}));
  try {
    const result = await runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(wanted), env: {PATH: '/bin'}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn, pollMs: 10}});
    assert.equal(result.started, true);
    assert.equal(result.port, wanted);
    assert.equal(JSON.parse(fs.readFileSync(path.join(ws.qa, 'claude-chat-state.json'), 'utf8')).port, wanted);
  } finally { await fake.close(); ws.cleanup(); }
});

// S-F6: the first message carries the continuation limits, not only the checkpoint.
test('the preamble states the solo, safety, credit and stop rules', () => {
  const required = [
    /AGENTS\.md API-credit continuation rules/, /Verify the Git branch, revision and dirty paths first/, /Do not redo finished work/, /only writer of this checkout/,
    /Work solo/, /do not use the Workflow tool/, /subagents only within a limit the owner sets/,
    /Every safety, Git, host, browser and approval \(GO\) rule in AGENTS\.md still applies/, /ultracode opt-in written for the root does not apply to you/,
    /Never buy credits or enable auto-reload/, /When the owner says stop, save a checkpoint to \.qa-local\/ and stop/, /The checkpoint follows\.$/,
  ];
  for (const pattern of required) assert.match(PREAMBLE, pattern);
});

test('a checkpoint outside .qa-local/ is rejected before anything starts', async () => {
  const ws = workspace(), fake = fakeSpawn();
  const outside = path.join(ws.repoRoot, 'README.md');
  fs.writeFileSync(outside, 'not a checkpoint');
  fs.writeFileSync(path.join(ws.qa, 'claude-chat-state.json'), '{}');
  fs.writeFileSync(path.join(ws.qa, 'claude-chat.log'), 'log');
  fs.writeFileSync(path.join(ws.qa, 'empty.md'), '  \n');
  fs.mkdirSync(path.join(ws.qa, 'folder'));
  const attempts = [
    outside, path.join(ws.qa, '..', 'README.md'), '..', path.join(os.tmpdir(), 'other.md'), path.join(ws.qa, 'missing.md'),
    path.join(ws.qa, 'claude-chat-state.json'), path.join(ws.qa, 'claude-chat.log'), path.join(ws.qa, 'empty.md'), path.join(ws.qa, 'folder'), ws.qa,
  ];
  try {
    for (const checkpoint of attempts) {
      await assert.rejects(runHandoff({checkpoint, noOpen: true, port: '1', env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn}}),
        error => error instanceof HandoffError && error.code === 1, checkpoint);
    }
    assert.equal(fake.runs.length, 0);
    assert.equal(fs.existsSync(path.join(ws.qa, 'claude-chat-state.json')) && fs.readFileSync(path.join(ws.qa, 'claude-chat-state.json'), 'utf8'), '{}', 'state untouched');
  } finally { await fake.close(); ws.cleanup(); }
});

test('a symlink or junction in .qa-local/ that leads outside is rejected', () => {
  const ws = workspace();
  const secret = path.join(ws.repoRoot, 'secret.md');
  fs.writeFileSync(secret, 'secret');
  try {
    // A file symlink needs a privilege on Windows; the junction below does not.
    let linked = true;
    try { fs.symlinkSync(secret, path.join(ws.qa, 'link.md')); } catch { linked = false; }
    if (linked) assert.throws(() => readCheckpoint(path.join(ws.qa, 'link.md'), ws.repoRoot), error => error.code === 1 && /outside/.test(error.message));
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-real-'));
    fs.writeFileSync(path.join(real, 'x.md'), 'x');
    fs.rmSync(ws.qa, {recursive: true});
    fs.symlinkSync(real, ws.qa, 'junction');
    assert.throws(() => readCheckpoint(path.join(ws.qa, 'x.md'), ws.repoRoot), error => error.code === 1 && /outside/.test(error.message));
    fs.rmSync(ws.qa); fs.rmSync(real, {recursive: true, force: true});
  } finally { ws.cleanup(); }
});

test('a port held by another process is reported, not taken over', async () => {
  const ws = workspace(), fake = fakeSpawn();
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  try {
    await assert.rejects(runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(blocker.address().port), env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: fake.spawn}}),
      error => error.code === 2 && /in use by another process/.test(error.message));
    assert.equal(fake.runs.length, 0);
  } finally { blocker.close(); ws.cleanup(); }
});

test('a server that exits early gets the .env hint and no state file is left', async () => {
  const ws = workspace(), spawned = [];
  const spawn = () => { const child = Object.assign(new EventEmitter(), {pid: 99999999, unref() {}}); spawned.push(child); setTimeout(() => child.emit('exit', 1), 30); return child; };
  try {
    await assert.rejects(runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(await freePort()), env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn, pollMs: 10, readyTimeoutMs: 5000}}),
      error => error.code === 2 && /set ANTHROPIC_API_KEY in tools\/claude-chat\/\.env/.test(error.message) && !/sk-ant/.test(error.message));
    assert.equal(fs.existsSync(path.join(ws.qa, 'claude-chat-state.json')), false);
  } finally { ws.cleanup(); }
});

test('a server that never answers is stopped after the readiness wait', async () => {
  const ws = workspace(), killed = [];
  const spawn = () => Object.assign(new EventEmitter(), {pid: 4242, unref() {}});
  try {
    await assert.rejects(runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(await freePort()), env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn, kill: pid => killed.push(pid), pollMs: 10, readyTimeoutMs: 150}}),
      error => error.code === 2 && /did not answer/.test(error.message));
    assert.deepEqual(killed, [4242]);
  } finally { ws.cleanup(); }
});

test('a failed detached spawn is retried once, then reported', async () => {
  const ws = workspace(), fake = fakeSpawn();
  let calls = 0;
  const failing = () => { calls++; const child = new EventEmitter(); setImmediate(() => child.emit('error', Object.assign(new Error('spawn EPERM'), {code: 'EPERM'}))); return child; };
  const flaky = (...args) => (calls++ === 0 ? (() => { const child = new EventEmitter(); setImmediate(() => child.emit('error', new Error('spawn EPERM'))); return child; })() : fake.spawn(...args));
  try {
    await assert.rejects(runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(await freePort()), env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: failing, pollMs: 10}}),
      error => error.code === 2 && /Could not start the server detached: spawn EPERM/.test(error.message));
    assert.equal(calls, 2);
    calls = 0;
    await runHandoff({checkpoint: ws.checkpoint, noOpen: true, port: String(await freePort()), env: {}, repoRoot: ws.repoRoot, out: quiet(), deps: {spawn: flaky, pollMs: 10}});
    assert.equal(calls, 2);
  } finally { await fake.close(); ws.cleanup(); }
});

test('argument parsing, spawn environment and the opener command', () => {
  assert.deepEqual(parseArgs(['a.md', '--no-open', '--port', '9000']), {checkpoint: 'a.md', noOpen: true, port: '9000', replace: false});
  assert.deepEqual(parseArgs(['--replace', 'a.md']), {checkpoint: 'a.md', noOpen: false, port: null, replace: true});
  for (const argv of [[], ['a.md', 'b.md'], ['a.md', '--wat']]) assert.throws(() => parseArgs(argv), error => error.code === 1, argv.join(' '));
  assert.throws(() => parseArgs([]), /Usage: node tools\/claude-chat\/handoff\.mjs/);
  const env = serverEnv({claudecode: '1', Anthropic_Api_Key: 'k', FOO: 'bar'}, {port: 1234, token: 'T'.repeat(24)});
  assert.equal(env.FOO, 'bar');
  assert.equal(Object.keys(env).some(key => /^(claude|anthropic_)/i.test(key)), false);
  const url = 'http://127.0.0.1:8787/#token=abc';
  assert.deepEqual(openCommand(url, 'darwin'), {command: 'open', args: [url], options: {}});
  assert.deepEqual(openCommand(url, 'linux'), {command: 'xdg-open', args: [url], options: {}});
  const win = openCommand(url, 'win32');
  assert.equal(win.command, 'cmd.exe');
  assert.equal(win.args.at(-1), `start "" "${url}"`);
});

// Runs the real script, a real detached node server and the real log file.
// Only when the repository .qa-local/ holds no handoff state and tools/claude-chat
// has no .env, so neither a live Astra server nor a real API key can be involved.
const realState = path.join(TOOL_DIR, '..', '..', '.qa-local', 'claude-chat-state.json');
const skipReal = fs.existsSync(path.join(TOOL_DIR, '.env')) ? 'tools/claude-chat/.env exists; a real key could be used'
  : fs.existsSync(realState) ? 'a handoff state file exists in .qa-local/' : false;
test('the real script detaches a real server; without a key it exits early and the log holds no token', { skip: skipReal }, async () => {
  const qa = path.join(TOOL_DIR, '..', '..', '.qa-local');
  const madeDir = !fs.existsSync(qa);
  fs.mkdirSync(qa, {recursive: true});
  const checkpoint = path.join(qa, `handoff-test-${process.pid}.md`);
  const log = path.join(qa, 'claude-chat.log');
  const hadLog = fs.existsSync(log);
  fs.writeFileSync(checkpoint, 'test checkpoint');
  try {
    const run = spawnSync(process.execPath, [path.join(TOOL_DIR, 'handoff.mjs'), checkpoint, '--no-open', '--port', String(await freePort())],
      {encoding: 'utf8', env: {...process.env, ANTHROPIC_API_KEY: 'sk-ant-api03-must-be-stripped'}, timeout: 60000});
    assert.equal(run.status, 2, run.stderr);
    assert.match(run.stderr, /set ANTHROPIC_API_KEY in tools\/claude-chat\/\.env/);
    assert.equal(fs.existsSync(realState), false);
    const text = fs.readFileSync(log, 'utf8');
    assert.match(text, /ANTHROPIC_API_KEY is required/, 'the server saw no inherited key');
    assert.equal(text.includes('must-be-stripped'), false);
  } finally {
    fs.rmSync(checkpoint, {force: true});
    if (!hadLog) fs.rmSync(log, {force: true});
    fs.rmSync(realState, {force: true});
    if (madeDir) try { fs.rmdirSync(qa); } catch {}
  }
});