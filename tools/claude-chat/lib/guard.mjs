import fs from 'node:fs';
import path from 'node:path';

// Code-enforced tool guards for every Astra session. They are layered on top of
// the SDK permission rules below, so a protected path stays refused even if a
// rule syntax detail or a settings file changes, and they run before the
// owner is asked. They cover the file tools, git push and a text tripwire for
// the Bash tool. Bash can still reach any file through an obfuscated command,
// which is why handoff sessions run in 'default' permission mode: the owner
// reads and approves every command.

// Permission-rule globs (gitignore style, relative to the session cwd). The
// "**/" prefix matches the entry at any depth; the bare form also matches a
// worktree .git file.
const EDIT_DENY_PATHS = [
  '**/.git', '**/.git/**', '**/.claude', '**/.claude/**', '**/.github', '**/.github/**',
  '**/.codex', '**/.codex/**', '**/.mcp.json', '**/.qa-local/claude-chat*',
  '**/tools/claude-chat/**', '**/package.json', '**/package-lock.json', '**/.env', '**/.env.*',
];
// The rule syntax has no negation, so ".env.example" stays denied too.
// claude-chat* covers the state, sessions and log files of this tool.
const READ_DENY_PATHS = ['**/.env', '**/.env.*', '**/.qa-local/claude-chat*'];

const EDIT_TOOLS = ['Edit', 'Write', 'NotebookEdit', 'MultiEdit'];
const GIT_PUSH_RULES = ['--force', '-f', '--force-with-lease', '--mirror', '--delete', '-d'].map(flag => `Bash(git push ${flag}*)`);

export const DENY_RULES = [
  'AskUserQuestion', // the model asks in chat text; the browser has no dialog for this tool
  ...EDIT_TOOLS.flatMap(tool => EDIT_DENY_PATHS.map(glob => `${tool}(${glob})`)),
  // Read rules also filter Grep and Glob results in the CLI (best effort); the hook checks the tool input.
  ...READ_DENY_PATHS.map(glob => `Read(${glob})`),
  ...GIT_PUSH_RULES,
];

const PATH_FIELDS = {
  Edit: ['file_path'], Write: ['file_path'], NotebookEdit: ['notebook_path'], MultiEdit: ['file_path'],
  Read: ['file_path'], Grep: ['path', 'glob'], Glob: ['path', 'pattern'],
};

// Windows and macOS match names case-insensitively and Windows ignores trailing
// dots and spaces and alternate data streams, so every segment is folded first.
function segmentKey(segment) {
  return segment.split(':')[0].replace(/[. ]+$/, '').toLowerCase();
}
const shortName = segment => /^[^.]*~\d+(\..*)?$/.test(segment);

function splitPath(raw, cwd) {
  let value = String(raw).replace(/\\/g, '/');
  const absolute = /^([a-z]:)?\//i.test(value);
  if (!absolute) value = `${String(cwd).replace(/\\/g, '/')}/${value}`;
  const drive = value.match(/^[a-z]:/i)?.[0] ?? '';
  return path.posix.normalize(value.slice(drive.length)).split('/').filter(Boolean);
}

function realpathOrNull(target) { try { return fs.realpathSync.native(target); } catch { return null; } }

// Real path of the target, or for a file that does not exist yet the real path
// of its deepest existing ancestor plus the missing tail, so a new file under
// a junction or symlink is judged where it will really be created.
function realpathDeep(target) {
  const tail = [];
  let current = target;
  for (;;) {
    const real = realpathOrNull(current);
    if (real) return tail.length ? path.join(real, ...tail.reverse()) : real;
    const parent = path.dirname(current);
    if (parent === current) return null;
    tail.push(path.basename(current));
    current = parent;
  }
}

// Segments below the session directory (the segments of the cwd are removed
// when the path starts with them, by the given spelling or by its real path).
function relativeSegments(segments, roots) {
  const keys = segments.map(segmentKey);
  for (const root of roots) {
    if (root.length <= keys.length && root.every((part, i) => keys[i] === part)) return {keys: keys.slice(root.length), raw: segments.slice(root.length)};
  }
  return {keys, raw: segments};
}

const isEnvName = name => name === '.env' || name.startsWith('.env.');

function editProtected(keys, raw) {
  if (raw.some(shortName)) return 'a Windows short-name path';
  if (keys.some(key => key === '.git' || key === '.claude' || key === '.github' || key === '.codex')) return 'repository, CI and agent configuration';
  if (keys.some((key, i) => key === 'tools' && keys[i + 1] === 'claude-chat')) return 'the Astra chat tool itself';
  const name = keys[keys.length - 1] ?? '';
  if (name === 'package.json' || name === 'package-lock.json') return 'package manifests (install scripts)';
  if (name === '.mcp.json') return 'MCP server configuration';
  if (isEnvName(name)) return 'environment files';
  if (keys.includes('.qa-local') && name.startsWith('claude-chat')) return 'the Astra chat state and log';
  return null;
}

function readProtected(tool, keys, raw) {
  if (raw.some(shortName)) return 'a Windows short-name path';
  const name = keys[keys.length - 1] ?? '';
  if (isEnvName(name)) return 'environment files';
  if (keys.includes('.qa-local') && name.startsWith('claude-chat')) return 'the Astra chat state and log';
  // A search below .qa-local would list or read the state files; Read of one named checkpoint stays allowed.
  if ((tool === 'Grep' || tool === 'Glob') && keys.includes('.qa-local')) return 'searching inside .qa-local (it holds the Astra state)';
  return null;
}

// --- search patterns (Glob pattern, Grep glob)

// Expands {a,b} groups (cap 64 results) so every alternative can be tested.
function expandBraces(pattern) {
  const open = pattern.indexOf('{');
  if (open < 0) return [pattern];
  let depth = 0, close = -1;
  for (let i = open; i < pattern.length; i++) {
    if (pattern[i] === '{') depth++;
    else if (pattern[i] === '}' && --depth === 0) { close = i; break; }
  }
  if (close < 0) return [pattern.replace('{', '')];
  const parts = [];
  let level = 0, start = open + 1;
  for (let i = open + 1; i < close; i++) {
    if (pattern[i] === '{') level++;
    else if (pattern[i] === '}') level--;
    else if (pattern[i] === ',' && level === 0) { parts.push(pattern.slice(start, i)); start = i + 1; }
  }
  parts.push(pattern.slice(start, close));
  const results = [];
  for (const part of parts) {
    for (const rest of expandBraces(pattern.slice(close + 1))) {
      for (const inner of expandBraces(part)) {
        results.push(pattern.slice(0, open) + inner + rest);
        if (results.length >= 64) return results;
      }
    }
  }
  return results;
}

// One glob segment as a regular expression: * ? and [class] are wildcards.
function segmentRegExp(segment) {
  let source = '';
  for (let i = 0; i < segment.length; i++) {
    const c = segment[i];
    if (c === '*') source += '[^/]*';
    else if (c === '?') source += '[^/]';
    else if (c === '[') {
      const end = segment.indexOf(']', i + 2);
      if (end < 0) { source += '\\['; continue; }
      const body = segment.slice(i + 1, end).replace(/^!/, '^').replace(/\\/g, '\\\\');
      source += `[${body}]`;
      i = end;
    } else source += c.replace(/[.+^${}()|\\\]]/g, '\\$&');
  }
  try { return new RegExp(`^${source}$`, 'i'); } catch { return null; }
}

const ENV_NAMES = ['.env', '.env.x', '.env.local', '.env.example', '.env.production'];
const literalCount = segment => segment.replace(/[*?]|\[[^\]]*\]/g, '').length;

// True when a glob segment with at least two literal characters can match an
// environment file name; a bare * or **/* (every file) stays allowed.
function segmentNamesEnv(segment) {
  if (!segment || segment === '**' || literalCount(segment) < 2) return false;
  const regexp = segmentRegExp(segment);
  return Boolean(regexp) && ENV_NAMES.some(name => regexp.test(name));
}

// Names a pattern under .qa-local could reach: the Astra state, session list
// and log, the folder itself. An empty final segment (a trailing /) reaches all.
const STATE_NAMES = ['claude-chat-state.json', 'claude-chat-sessions.json', 'claude-chat.log', 'claude-chat', '.qa-local'];
function finalSegmentReachesState(alternative) {
  const last = alternative.split(/[\\/]/).pop();
  if (!last) return true;
  const regexp = segmentRegExp(last);
  return !regexp || STATE_NAMES.some(name => regexp.test(name));
}

// A search pattern that names a protected file (for example **/.env* or
// .e[n]v) is refused as well.
function searchesProtected(text) {
  if (/(^|[\\/*?])\.env($|[.*?\\/])/i.test(text) || /claude-chat-|claude-chat\.log/i.test(text)) return true;
  // claude-chat with a wildcard in the same name (claude-chat*, claude-chat-?), but not tools/claude-chat/**.
  if (/claude-chat[^/\\]*[*?[{]/i.test(text)) return true;
  const alternatives = expandBraces(text.replace(/^!/, ''));
  // A pattern below .qa-local is refused when its final segment can match a state file (.qa-local/*.md cannot).
  if (alternatives.some(alternative => /\.qa-local/i.test(alternative) && finalSegmentReachesState(alternative))) return true;
  return alternatives.some(alternative => alternative.split(/[\\/]/).some(segmentNamesEnv));
}

export function checkFileTool(name, input, cwd) {
  const fields = PATH_FIELDS[name];
  if (!fields) return null;
  const editing = EDIT_TOOLS.includes(name);
  const nativeSpelling = raw => process.platform === 'win32' || !/^[a-z]:|\\/i.test(raw);
  const roots = [splitPath(cwd, '/').map(segmentKey)];
  const realCwd = realpathOrNull(cwd);
  if (realCwd) roots.push(splitPath(realCwd, '/').map(segmentKey));
  for (const field of fields) {
    const raw = input?.[field];
    if (typeof raw !== 'string' || !raw) continue;
    const searchOnly = (name === 'Glob' && field === 'pattern') || (name === 'Grep' && field === 'glob');
    if (searchOnly) { if (searchesProtected(raw)) return `${name} ${field} names protected files (environment files or Astra state)`; continue; }
    // Device (\\?\, \\.\) and UNC (\\server\share) spellings cannot be judged by segment: refuse them.
    if (raw.replace(/\\/g, '/').startsWith('//')) return `${name} on ${field} "${raw}" is refused: device, UNC and network paths are not allowed. Use a path inside the repository.`;
    const candidates = [raw];
    const resolved = nativeSpelling(raw) ? realpathDeep(path.resolve(cwd, raw)) : null;
    if (resolved) candidates.push(resolved);
    for (const candidate of candidates) {
      const {keys, raw: rawKeys} = relativeSegments(splitPath(candidate, cwd), roots);
      const why = editing ? editProtected(keys, rawKeys) : readProtected(name, keys, rawKeys);
      if (why) return `${name} on ${keys.join('/') || '.'} is refused: ${why}. Ask the owner to change it by hand.`;
    }
  }
  return null;
}

// --- shell command guards (git push and the Bash text tripwire)

// Quote-aware split of a shell string. A token is {text, raw}: text has the
// quotes and escaping backslashes removed (what the shell passes on), raw keeps
// the backslashes (a Windows path such as C:\Git\bin\git.exe). SEP marks the
// end of a command: ; && || | & newline, a subshell, a backquote or a brace.
// This is a guard rail for approvals, not a sandbox: indirect forms
// (variables, scripts) still reach the owner approval card.
const SEP = Symbol('separator');
function tokenize(command) {
  const s = String(command), tokens = [];
  let text = '', raw = '', open = false;
  const flush = () => { if (open) tokens.push({text, raw}); text = raw = ''; open = false; };
  const separate = () => { flush(); if (tokens[tokens.length - 1] !== SEP) tokens.push(SEP); };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "'") {
      open = true;
      const end = s.indexOf("'", i + 1), stop = end < 0 ? s.length : end;
      text += s.slice(i + 1, stop); raw += s.slice(i + 1, stop); i = stop;
    } else if (c === '"') {
      open = true;
      for (i++; i < s.length && s[i] !== '"'; i++) {
        if (s[i] === '\\' && i + 1 < s.length && '$`"\\'.includes(s[i + 1])) { text += s[i + 1]; raw += s[i] + s[i + 1]; i++; } else { text += s[i]; raw += s[i]; }
      }
    } else if (c === '\\') {
      if (s[i + 1] === '\n') i++;
      else if (s[i + 1] === '\r' && s[i + 2] === '\n') i += 2;
      else { open = true; raw += c; if (i + 1 < s.length) { text += s[i + 1]; raw += s[i + 1]; i++; } }
    } else if (/\s/.test(c)) {
      if (c === '\n' || c === '\r') separate(); else flush();
    } else if (c === '$' && s[i + 1] === '(') { separate(); i++; }
    else if (';&|`(){}'.includes(c)) separate();
    else { open = true; text += c; raw += c; }
  }
  flush();
  return tokens;
}

const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path', '--config-env']);
// git -c / --config-env settings that turn a later plain command into a forced or mirror push.
const BAD_CONFIG = /^(alias\.[^=]*=.*push|remote\.[^=]*\.(push|mirror)(=|$))/i;
const BAD_CONFIG_ENV = /^(alias\.|remote\.[^=]*\.(push|mirror)(=|$))/i;
const BAD_CONFIG_KEY = /^remote\.[^=]*\.(push|mirror)(=|$)/i;
const gitName = word => [word.text, word.raw].some(value => path.posix.basename(value.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '') === 'git');

// A word is checked again as a command line when it holds a command separator or space, or follows a -c / -Command style flag (sh -c env).
const nestedCommand = (prev, word) => /[\s;&|$`(){}]/.test(word.text.trim()) || (prev && prev !== SEP && /^-[a-z]*c$|^-command$/i.test(prev.text));

const refusedPush = detail => `git ${detail} is refused: force, delete, mirror and +refspec pushes, and git settings that create them, are never allowed here. Ask the owner to run it by hand.`;

// git accepts any unique prefix of a long option (--force-w, --mirr, --dele), so a
// prefix of two or more characters of a forceful option is refused. An ambiguous
// prefix makes git fail anyway.
const FORCEFUL_LONG_OPTIONS = ['force', 'force-with-lease', 'force-if-includes', 'mirror', 'delete', 'prune'];
function forcefulLongOption(arg) {
  if (!arg.startsWith('--')) return false;
  const name = arg.slice(2).split('=')[0];
  return name.length >= 2 && FORCEFUL_LONG_OPTIONS.some(option => option.startsWith(name));
}

function checkPushArguments(args, label) {
  let options = true;
  for (const arg of args) {
    // After -- git reads only repository and refspec arguments; a +refspec or :ref still forces or deletes.
    if (options && arg === '--') { options = false; continue; }
    const flag = options && (forcefulLongOption(arg) || /^-[A-Za-z]*[fd][A-Za-z]*$/.test(arg));
    if (flag || arg.startsWith('+') || /^:[^:]/.test(arg)) return refusedPush(`${label} with "${arg}"`);
  }
  return null;
}

// Environment settings that give git a config: GIT_CONFIG_COUNT/KEY_n/VALUE_n and
// GIT_CONFIG_PARAMETERS can create an alias or remote.*.push without a -c option.
const GIT_ENV_CONFIG = /^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+|PARAMETERS)(=|$)/i;
const commandName = word => path.posix.basename(word.raw.replace(/\\/g, '/')).toLowerCase().replace(/\.exe$/, '');
function gitEnvConfig(tokens, i) {
  const word = tokens[i];
  if (!GIT_ENV_CONFIG.test(word.text)) return false;
  if (word.text.includes('=')) return true;
  let j = i - 1;
  while (j >= 0 && tokens[j] !== SEP && tokens[j].text.startsWith('-')) j--;
  return j >= 0 && tokens[j] !== SEP && ['export', 'declare', 'typeset', 'readonly'].includes(commandName(tokens[j]));
}

// The value of git commit/tag/merge -m (or --message) and of -F is free text, not a
// command: a message that mentions "git push -f" or ".env" is not scanned. A value
// with $ or a backquote stays scanned, because a double-quoted message can still
// run a command substitution.
const MESSAGE_SUBCOMMANDS = new Set(['commit', 'tag', 'merge', 'notes', 'stash']);
const plainText = word => !/[$`]/.test(word.text);

function markMessageValues(tokens, start, end, all, nested) {
  let i = start;
  while (i < end && /^[A-Za-z_]\w*=/.test(tokens[i].text)) i++;
  if (i >= end || !gitName(tokens[i])) return;
  for (i++; i < end && tokens[i].text.startsWith('-'); i += GIT_VALUE_OPTIONS.has(tokens[i].text) ? 2 : 1);
  if (i >= end || !MESSAGE_SUBCOMMANDS.has(tokens[i].text.toLowerCase())) return;
  for (i++; i < end; i++) {
    const text = tokens[i].text;
    if (/^-[A-Za-z]*m$|^--message$/.test(text)) {
      if (i + 1 < end && plainText(tokens[i + 1])) all.add(i + 1);
      i++;
    } else if ((/^--message=/.test(text) || /^-m./.test(text)) && plainText(tokens[i])) all.add(i);
    else if (text === '-F' || text === '--file') { if (i + 1 < end) nested.add(i + 1); i++; }
    else if (text.startsWith('--file=')) nested.add(i);
  }
}

// Token indexes whose text is a commit message (all: not scanned at all) or a
// message file name (nested: only the nested command re-check is skipped).
function messageValues(tokens) {
  const all = new Set(), nested = new Set();
  for (let start = 0; start < tokens.length;) {
    if (tokens[start] === SEP) { start++; continue; }
    let end = start;
    while (end < tokens.length && tokens[end] !== SEP) end++;
    markMessageValues(tokens, start, end, all, nested);
    start = end;
  }
  return {all, nested};
}

function checkGitInvocation(tokens, start) {
  const configs = [];
  let i = start + 1;
  while (i < tokens.length && tokens[i] !== SEP && tokens[i].text.startsWith('-')) {
    const option = tokens[i].text, valued = GIT_VALUE_OPTIONS.has(option) && tokens[i + 1] && tokens[i + 1] !== SEP;
    if (valued && (option === '-c' || option === '--config-env')) configs.push([option, tokens[i + 1].text]);
    else if (option.startsWith('--config-env=')) configs.push(['--config-env', option.slice(13)]);
    i += valued ? 2 : 1;
  }
  for (const [option, value] of configs) {
    if ((option === '-c' ? BAD_CONFIG : BAD_CONFIG_ENV).test(value)) return refusedPush(`${option} ${value}`);
  }
  if (i >= tokens.length || tokens[i] === SEP) return null;
  const sub = tokens[i].text.toLowerCase(), args = [];
  for (i++; i < tokens.length && tokens[i] !== SEP; i++) args.push(tokens[i].text);
  if (sub === 'push') return checkPushArguments(args, 'push');
  if (sub === 'send-pack') return checkPushArguments(args, 'send-pack');
  if (sub === 'config') {
    // Writes only; --get, --list and the like stay allowed.
    if (args.some(arg => /^--(get|get-all|get-regexp|get-urlmatch|list)$|^-l$/.test(arg))) return null;
    const key = args.findIndex(arg => BAD_CONFIG_KEY.test(arg) || /^alias\./i.test(arg));
    if (key >= 0) {
      const aliasKey = /^alias\./i.test(args[key]);
      if (!aliasKey || args.slice(key).some(arg => /push/i.test(arg))) return refusedPush(`config ${args[key]}`);
    }
  }
  return null;
}

// Windows (case-insensitive) and Linux executable spellings reduce to "git"; a
// quoted payload (sh -c "git push -f") is checked again word by word.
export function checkGitPush(command, depth = 0) {
  const tokens = tokenize(command), messages = messageValues(tokens);
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === SEP || messages.all.has(i)) continue;
    if (gitEnvConfig(tokens, i)) return refusedPush(`setting ${word.text.split('=')[0]}`);
    if (gitName(word)) {
      const reason = checkGitInvocation(tokens, i);
      if (reason) return reason;
    } else if (depth < 3 && !messages.nested.has(i) && nestedCommand(tokens[i - 1], word)) {
      const reason = checkGitPush(word.text, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

// Text tripwire for Bash: a command that names the environment files, the Astra
// state or log, the API key variable, or dumps the environment. It narrows the
// gap and never closes it (an obfuscated read still works), so default mode
// stays the real control.
const TRIPWIRE = [
  // .env as a path segment (after space, quote, = / \ or a shell operator), so process.env and foo.env pass.
  [/(^|[\s'"=/\\<>(){};&|:,])\.env(?!\.example)\b/i, 'an environment file'],
  [/claude-chat-(state|sessions)|claude-chat\.log/i, 'the Astra chat state or log'],
  [/anthropic_api_key/i, 'the API key variable'],
  [/(^|[^\w.:-])env:/i, 'the environment drive'],
  [/\/proc\/[^\s]*\/environ/i, 'the process environment'],
];

// True when the command line has no command word: only options, option values
// and (for env) NAME=value assignments. Then env, printenv and export print the
// whole environment.
const ENV_VALUE_OPTIONS = new Set(['-u', '-C', '--unset', '--chdir']);
function hasNoCommand(args, valued, assignments) {
  for (let k = 0; k < args.length; k++) {
    if (args[k].startsWith('-')) { if (valued.has(args[k])) k++; continue; }
    if (assignments && /^[A-Za-z_]\w*=/.test(args[k])) continue;
    return false;
  }
  return true;
}

function printsEnvironment(name, args) {
  switch (name) {
    case 'env': return hasNoCommand(args, ENV_VALUE_OPTIONS, true);
    case 'printenv': case 'export': return hasNoCommand(args, new Set(), false);
    case 'set': return args.length === 0;
    case 'declare': case 'typeset': return args.length === 0 || (hasNoCommand(args, new Set(), false) && args.some(arg => /^-[A-Za-z]*[px]/.test(arg)));
    case 'compgen': return args.some(arg => /^-[A-Za-z]*e/.test(arg));
    default: return false;
  }
}

export function checkBashTripwire(command, depth = 0) {
  const tokens = tokenize(command), messages = messageValues(tokens);
  const words = tokens.filter((token, i) => token !== SEP && !messages.all.has(i));
  // The raw command string still holds a skipped commit message, so it is only scanned when there is none.
  const texts = [...(messages.all.size ? [] : [String(command)]), words.map(word => word.text).join(' '), words.map(word => word.raw).join(' ')];
  for (const [pattern, what] of TRIPWIRE) {
    if (texts.some(text => pattern.test(text))) return `Bash command names ${what} and is refused. Ask the owner to run it by hand.`;
  }
  for (let i = 0; i < tokens.length; i++) {
    const word = tokens[i];
    if (word === SEP || messages.all.has(i)) continue;
    if (i === 0 || tokens[i - 1] === SEP) {
      const args = [];
      for (let k = i + 1; k < tokens.length && tokens[k] !== SEP && !/^\d*[<>]/.test(tokens[k].text); k++) args.push(tokens[k].text); // a redirect is not an argument
      if (printsEnvironment(commandName(word), args)) {
        return 'Bash command that prints the whole environment (env, printenv, set, export -p, declare -x) is refused: it would show the API key. Ask the owner to run it by hand.';
      }
    }
    if (depth < 3 && !messages.nested.has(i) && nestedCommand(tokens[i - 1], word)) {
      const reason = checkBashTripwire(word.text, depth + 1);
      if (reason) return reason;
    }
  }
  return null;
}

// One entry point for the PreToolUse hook and for canUseTool.
export function checkTool(name, input, cwd) {
  if (name === 'Bash') return checkGitPush(input?.command ?? '') ?? checkBashTripwire(input?.command ?? '');
  return checkFileTool(name, input ?? {}, cwd);
}

// PreToolUse hook for query() options.hooks.
export function guardHooks(cwd) {
  return {
    PreToolUse: [{
      hooks: [async input => {
        const reason = checkTool(input.tool_name, input.tool_input, cwd);
        return reason ? {hookSpecificOutput: {hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason}} : {};
      }],
    }],
  };
}