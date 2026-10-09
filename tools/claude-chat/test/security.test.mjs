import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {Chat, agentEnv, memorySessionStore} from '../lib/chat.mjs';
import {DENY_RULES, checkBashTripwire, checkGitPush, checkTool, guardHooks} from '../lib/guard.mjs';
import {loadConfig} from '../lib/config.mjs';
import {fileSessionStore} from '../lib/sessions.mjs';
import {TOKEN, SESSION, TOOL_DIR, DUMMY_KEY, baseConfig, fakeQuery, init, resultTurn, serve, freePort, rawRequest} from './helpers.mjs';

const tick = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const EDIT_TOOLS = [['Edit', 'file_path'], ['Write', 'file_path'], ['NotebookEdit', 'notebook_path'], ['MultiEdit', 'file_path']];
const READ_TOOLS = [['Read', 'file_path'], ['Grep', 'path'], ['Glob', 'path']];

// --- SEC-1 and SEC-2: protected paths

const EDIT_REFUSED = [
  '.git/config', '.git', '.git/hooks/pre-commit', '.claude/settings.json', '.claude/agents/x.md', '.github/workflows/ci.yml',
  'tools/claude-chat/server.mjs', 'tools/claude-chat/lib/guard.mjs', 'package.json', 'web/package.json', 'package-lock.json', 'a/b/package-lock.json',
  '.env', '.env.local', 'apps/api/.env.production', '.env.example',
  '/repo/.git/config', '/repo/tools/claude-chat/lib/chat.mjs', '/repo/.env', 'src/../.git/config', './.github/CODEOWNERS',
  '.GIT/config', '.Env', 'Tools/Claude-Chat/x.mjs', 'PACKAGE.JSON', '.env.', '.env ', '.git./config', 'GIT~1/config',
  // S-F1: the chat state, the Codex configuration and MCP servers are persistence points as well.
  '.qa-local/claude-chat-sessions.json', '.qa-local/claude-chat-state.json', '.qa-local/claude-chat.log', '.QA-LOCAL/Claude-Chat-State.json', '/repo/.qa-local/claude-chat-state.json',
  '.codex', '.codex/config.toml', '.codex/agents/coder.toml', 'a/.codex/x.toml', '/repo/.codex/config.toml', '.CODEX/config.toml',
  '.mcp.json', 'sub/.mcp.json', '/repo/.mcp.json', '.MCP.JSON',
  // S-F2: tools/claude-chat at any depth.
  'sub/tools/claude-chat/x', '/repo/sub/tools/claude-chat/x', 'a/b/Tools/Claude-Chat/lib/guard.mjs',
];
const EDIT_ALLOWED = ['src/app.js', 'docs/ROADMAP.md', 'tools/other/run.mjs', 'tools/claude-chat-notes.md', 'src/tools/claude-chat-notes.md', 'README.md', '.envrc', 'environment.md', 'src/package.json.md',
  '.qa-local/checkpoint.md', 'docs/codex-notes.md', 'mcp.json', 'src/codex/run.js', 'tools/other/claude-chat/x'];
const READ_REFUSED = [
  '.env', '.env.local', 'a/b/.env', '.env.production', '.env.example', '/repo/.env', 'tools/claude-chat/.env', '.ENV',
  '.qa-local/claude-chat-state.json', '.qa-local/claude-chat.log', '.qa-local/claude-chat-sessions.json', '.qa-local/claude-chat', '/repo/.qa-local/claude-chat-state.json',
];
const READ_ALLOWED = ['README.md', 'src/env.js', 'tools/claude-chat/server.mjs', '.git/config', 'package.json', 'docs/claude-chat-notes.md', '.codex/config.toml'];

test('Edit, Write and NotebookEdit refuse every protected path; ordinary files pass', () => {
  for (const [tool, field] of EDIT_TOOLS) {
    for (const file of EDIT_REFUSED) assert.match(checkTool(tool, {[field]: file}, '/repo') ?? '', /refused/, `${tool} ${file}`);
    for (const file of EDIT_ALLOWED) assert.equal(checkTool(tool, {[field]: file}, '/repo'), null, `${tool} ${file}`);
  }
  // Windows spelling of the same paths, with a drive letter and backslashes.
  for (const file of ['C:\\repo\\.git\\config', 'C:\\repo\\tools\\claude-chat\\server.mjs', '.claude\\settings.json', 'C:\\repo\\sub\\.ENV',
    'C:\\repo\\.qa-local\\claude-chat-state.json', 'C:\\repo\\.codex\\config.toml', 'C:\\repo\\.mcp.json', 'C:/repo/sub/tools/claude-chat/x', 'C:\\repo\\sub\\tools\\claude-chat\\x']) {
    assert.match(checkTool('Edit', {file_path: file}, 'C:\\repo') ?? '', /refused/, file);
  }
  assert.equal(checkTool('Edit', {file_path: 'C:\\repo\\src\\a.js'}, 'C:\\repo'), null);
});

test('Read, Grep and Glob refuse env files and the chat state; searches that name them too', () => {
  for (const [tool, field] of READ_TOOLS) {
    for (const file of READ_REFUSED) assert.match(checkTool(tool, {[field]: file}, '/repo') ?? '', /refused/, `${tool} ${file}`);
    for (const file of READ_ALLOWED) assert.equal(checkTool(tool, {[field]: file}, '/repo'), null, `${tool} ${file}`);
  }
  for (const glob of ['.env*', '**/.env', '**/.env.*', '*.env', '.qa-local/claude-chat-*', '.qa-local/claude-chat.log']) {
    assert.match(checkTool('Glob', {pattern: glob}, '/repo') ?? '', /protected/, `Glob ${glob}`);
    assert.match(checkTool('Grep', {pattern: 'KEY', glob}, '/repo') ?? '', /protected/, `Grep ${glob}`);
  }
  for (const glob of ['**/*.md', 'src/**/*.js', '**/environment*']) {
    assert.equal(checkTool('Glob', {pattern: glob}, '/repo'), null, glob);
    assert.equal(checkTool('Grep', {pattern: 'x', glob}, '/repo'), null, glob);
  }
});

// T-F1 / S-F7: a search below .qa-local or a pattern form that still reaches .env is refused.
test('Grep and Glob below .qa-local are refused; Read of one named checkpoint is allowed', () => {
  for (const dir of ['.qa-local', '.qa-local/', '.qa-local/checkpoint.md', '.qa-local/sub', '/repo/.qa-local', '/repo/.QA-LOCAL/x', 'C:\\repo\\.qa-local']) {
    assert.match(checkTool('Grep', {pattern: 'token', path: dir}, dir.startsWith('C:') ? 'C:\\repo' : '/repo') ?? '', /refused.*\.qa-local/, `Grep path ${dir}`);
    assert.match(checkTool('Glob', {pattern: '**/*', path: dir}, dir.startsWith('C:') ? 'C:\\repo' : '/repo') ?? '', /refused.*\.qa-local/, `Glob path ${dir}`);
  }
  assert.equal(checkTool('Read', {file_path: '.qa-local/checkpoint.md'}, '/repo'), null);
  assert.equal(checkTool('Grep', {pattern: 'x', path: 'src'}, '/repo'), null);
  assert.equal(checkTool('Grep', {pattern: 'x'}, '/repo'), null, 'root-level Grep stays allowed (README residual: ripgrep honours .gitignore)');
  assert.equal(checkTool('Glob', {pattern: '**/*.md'}, '/repo'), null);
});

test('search patterns that name or can match .env, or the chat state with a wildcard, are refused', () => {
  const refused = [
    // .env wildcard spellings (S-F7)
    '.e[n]v', '.en[v]', '.e[a-z]v', '.e?v', '**/.e?v', '.en?', '{.env,x}', '{x,.env.*}', '**/{a,.env.*}', '{a,{b,.env}}', '.env.[a-z]*', '.e*', '[.]env', '!.env',
    // chat state with a wildcard (T-F2)
    '.qa-local/claude-chat*', '.qa-local/claude-chat-?', 'claude-chat*', '**/claude-chat-?', '{.qa-local/claude-chat-state.json,x}', '.qa-local/**', '.qa-local/*.json',
  ];
  for (const glob of refused) {
    assert.match(checkTool('Glob', {pattern: glob}, '/repo') ?? '', /protected/, `Glob ${glob}`);
    assert.match(checkTool('Grep', {pattern: 'KEY', glob}, '/repo') ?? '', /protected/, `Grep ${glob}`);
  }
  const allowed = ['**/*', '*', '*.js', '**/*.md', 'tools/claude-chat/**', 'tools/claude-chat/**/*.mjs', '**/environment*', '.envrc', '.eslintrc*', '**/.git*', 'src/**/{a,b}.js', '**/*v', 'docs/*.md'];
  for (const glob of allowed) {
    assert.equal(checkTool('Glob', {pattern: glob}, '/repo'), null, `Glob ${glob}`);
    assert.equal(checkTool('Grep', {pattern: 'x', glob}, '/repo'), null, `Grep ${glob}`);
  }
});

// A2a-REG2: a .qa-local pattern whose final segment cannot match a state file is allowed.
test('a .qa-local search pattern is allowed when its final segment cannot match the Astra state', () => {
  const allowed = ['.qa-local/*.md', '**/.qa-local/*.md', '.qa-local/**/*.md', '.qa-local/*.{md,txt}', '.qa-local/checkpoint-*.md', '.qa-local/notes.md'];
  for (const glob of allowed) {
    assert.equal(checkTool('Glob', {pattern: glob}, '/repo'), null, `Glob ${glob}`);
    assert.equal(checkTool('Grep', {pattern: 'x', glob}, '/repo'), null, `Grep ${glob}`);
  }
  const refused = [
    '.qa-local', '.qa-local/', '.qa-local/*', '.qa-local/**', '**/.qa-local/**', '.qa-local/*.json', '.qa-local/*.log', '.qa-local/c*', '.qa-local/*-state*', '.qa-local/?laude-chat.log',
    '.qa-local/*.{md,json}', '.qa-local/{notes.md,claude-chat-state.json}', '.qa-local/[c]*', '!.qa-local/**', '.qa-local/claude-chat', '.qa-local/*.md/', '.qa-local/**/',
  ];
  for (const glob of refused) {
    assert.match(checkTool('Glob', {pattern: glob}, '/repo') ?? '', /protected/, `Glob ${glob}`);
    assert.match(checkTool('Grep', {pattern: 'x', glob}, '/repo') ?? '', /protected/, `Grep ${glob}`);
  }
  // A search path inside .qa-local stays refused whatever the pattern is.
  assert.match(checkTool('Glob', {pattern: '*.md', path: '.qa-local'}, '/repo') ?? '', /refused.*\.qa-local/);
  assert.match(checkTool('Grep', {pattern: 'x', path: '.qa-local', glob: '*.md'}, '/repo') ?? '', /refused.*\.qa-local/);
});

// S-F2: Windows path spellings the segment check cannot judge, and the real path of a file that does not exist yet.
test('device, UNC and network spellings are refused for every file tool', () => {
  const spellings = [
    '\\\\?\\C:\\repo\\tools\\claude-chat\\server.mjs', '\\\\.\\C:\\repo\\x', '\\\\localhost\\C$\\repo\\tools\\claude-chat\\server.mjs', '\\\\server\\share\\x',
    '//?/C:/repo/x', '//server/share/x', '//localhost/C$/repo/src/a.js', '\\/server/share/x',
  ];
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
    for (const spelling of spellings) assert.match(checkTool(tool, {file_path: spelling, notebook_path: spelling}, 'C:\\repo') ?? '', /device, UNC/, `${tool} ${spelling}`);
  }
  for (const [tool, field] of [['Read', 'file_path'], ['Grep', 'path'], ['Glob', 'path']]) {
    for (const spelling of spellings) assert.match(checkTool(tool, {[field]: spelling}, 'C:\\repo') ?? '', /device, UNC/, `${tool} ${spelling}`);
  }
  assert.equal(checkTool('Edit', {file_path: 'C:/repo/src/a.js'}, 'C:\\repo'), null, 'a single leading drive path stays allowed');
});

test('a Windows short name is refused for Read, Grep and Glob as well as for edits', () => {
  for (const name of ['ENV~1', 'tools/claude-chat/ENV~1', 'tools/CLAUDE~1/server.mjs', '.qa-local/CLAUDE~1.LOG', 'a/PROGRA~1/x', 'a~1', 'GIT~1/config']) {
    for (const [tool, field] of [['Read', 'file_path'], ['Grep', 'path'], ['Glob', 'path'], ['Edit', 'file_path']]) {
      assert.match(checkTool(tool, {[field]: name}, '/repo') ?? '', /short-name/, `${tool} ${name}`);
    }
  }
  assert.equal(checkTool('Read', {file_path: 'docs/a~b.md'}, '/repo'), null, 'a tilde that is not a short name');
  assert.equal(checkTool('Read', {file_path: 'src/a.js'}, 'C:\\Users\\USERNA~1\\repo'), null, 'a short name in the session directory itself is not the model path');
});

test('a new file below a junction or symlink that leads to a protected folder is refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-real-'));
  try {
    fs.mkdirSync(path.join(dir, '.git'));
    fs.mkdirSync(path.join(dir, 'tools', 'claude-chat'), {recursive: true});
    fs.mkdirSync(path.join(dir, 'ok'));
    let linked = true;
    try {
      fs.symlinkSync(path.join(dir, '.git'), path.join(dir, 'safe'), 'junction');
      fs.symlinkSync(path.join(dir, 'tools', 'claude-chat'), path.join(dir, 'ok', 'chat'), 'junction');
    } catch { linked = false; }
    if (!linked) return;
    for (const tool of ['Edit', 'Write', 'NotebookEdit']) {
      const field = tool === 'NotebookEdit' ? 'notebook_path' : 'file_path';
      assert.match(checkTool(tool, {[field]: 'safe/hooks/pre-push'}, dir) ?? '', /refused/, `${tool} missing file under .git junction`);
      assert.match(checkTool(tool, {[field]: path.join(dir, 'ok', 'chat', 'new', 'deep.mjs')}, dir) ?? '', /refused/, `${tool} missing file under chat junction`);
      assert.equal(checkTool(tool, {[field]: 'ok/new/a.js'}, dir), null, `${tool} missing ordinary file`);
    }
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('a symlink inside the repository that leads to an env file is refused', { skip: process.platform === 'win32' ? 'symlinks need privileges on Windows' : false }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-guard-'));
  try {
    fs.writeFileSync(path.join(dir, '.env'), 'X=1');
    fs.symlinkSync(path.join(dir, '.env'), path.join(dir, 'notes.txt'));
    assert.match(checkTool('Read', {file_path: 'notes.txt'}, dir) ?? '', /refused/);
    assert.match(checkTool('Write', {file_path: 'notes.txt'}, dir) ?? '', /refused/);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('the deny rules list every protected path for each tool', () => {
  for (const tool of ['Edit', 'Write', 'NotebookEdit', 'MultiEdit']) {
    for (const glob of ['**/.git/**', '**/.claude/**', '**/.github/**', '**/tools/claude-chat/**', '**/package.json', '**/package-lock.json', '**/.env', '**/.env.*',
      '**/.qa-local/claude-chat*', '**/.codex', '**/.codex/**', '**/.mcp.json']) {
      assert.ok(DENY_RULES.includes(`${tool}(${glob})`), `${tool}(${glob})`);
    }
  }
  for (const glob of ['**/.env', '**/.env.*', '**/.qa-local/claude-chat*']) assert.ok(DENY_RULES.includes(`Read(${glob})`), `Read(${glob})`);
  assert.ok(DENY_RULES.includes('AskUserQuestion'));
});

test('deny rules, the hook and canUseTool apply in every permission mode', async () => {
  for (const permissionMode of ['default', 'acceptEdits', 'plan']) {
    const query = fakeQuery(async function* (message, options, call) {
      yield init(options);
      call.decisions = [
        await options.canUseTool('Edit', {file_path: '.git/config'}, {signal: new AbortController().signal}),
        await options.canUseTool('Read', {file_path: '.env'}, {signal: new AbortController().signal}),
        await options.canUseTool('Bash', {command: 'git push --force'}, {signal: new AbortController().signal}),
      ];
      yield {type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0};
    });
    const chat = new Chat({query, config: {...baseConfig, permissionMode}});
    const seen = [];
    chat.subscribe(event => seen.push(event.type));
    chat.send('go');
    await tick();
    const [call] = query.calls;
    assert.equal(call.options.permissionMode, permissionMode);
    assert.deepEqual(call.options.disallowedTools, DENY_RULES);
    assert.deepEqual(call.decisions.map(d => d.behavior), ['deny', 'deny', 'deny']);
    assert.equal(seen.includes('permission'), false, 'a protected action never reaches the owner as a question');
    // The hook returns the documented PreToolUse deny shape.
    const hook = call.options.hooks.PreToolUse[0].hooks[0];
    const denied = await hook({hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {file_path: 'package.json'}});
    assert.equal(denied.hookSpecificOutput.hookEventName, 'PreToolUse');
    assert.equal(denied.hookSpecificOutput.permissionDecision, 'deny');
    assert.deepEqual(await hook({hook_event_name: 'PreToolUse', tool_name: 'Write', tool_input: {file_path: 'src/a.js'}}), {});
    chat.stop();
  }
  assert.equal(typeof guardHooks('/repo').PreToolUse[0].hooks[0], 'function');
});

// --- SEC-6: force pushes

test('git push variants that force, mirror, delete or use a + refspec are refused', () => {
  const refused = [
    'git push -f', 'git push -f origin main', 'git push --force', 'git push origin main --force', 'git push --force-with-lease',
    'git push --force-with-lease=main:abc123 origin main', 'git push --force-if-includes', 'git push --mirror', 'git push --mirror origin',
    'git push --delete origin old', 'git push origin --delete old', 'git push -d origin old', 'git push origin +main', 'git push origin +HEAD:main',
    'git push origin :old-branch', 'git push -fu origin x', 'git push -uf origin x', 'git -C . push -f', 'git -c core.x=1 push --force',
    'cd repo && git push origin main -f', 'git status; git push --delete origin x', 'sh -c "git push --force"', "bash -lc 'git push -f origin main'",
    '(git push -f)', 'echo $(git push --force)', 'git.exe push -f', '/usr/bin/git push --force', 'git push --prune origin',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  for (const command of ['git push', 'git push origin feature', 'git push -u origin feature', 'git push --dry-run', 'git push origin HEAD:refs/heads/feature', 'git status', 'git log --oneline -5', 'git fetch --force', 'npm test', 'git commit -m "fix: drop the delete flag"']) {
    assert.equal(checkGitPush(command), null, command);
  }
  for (const flag of ['--force', '-f', '--force-with-lease', '--mirror', '--delete']) assert.ok(DENY_RULES.includes(`Bash(git push ${flag}*)`), flag);
});

// S-F3 / T-F3: spellings the first guard missed (Windows case, shell quoting and escaping, git settings that create a forced push).
test('git push spellings by case, quoting and escaping are refused', () => {
  const refused = [
    'GIT push -f', 'Git push --force', 'GIT.EXE push --force', 'Git.exe push --force', 'g\\it push -f', 'gi\\t push --force', 'git pu\\sh -f', 'g"i"t push -f', "g'i't push -f", 'git "push" -f', "git 'push' --force",
    'git -C "x y" push -f', "git -C 'x y' push --force", 'git -C "a b" -c core.x=1 push --mirror', '"C:\\Program Files\\Git\\bin\\git.exe" push -f', 'C:\\Git\\bin\\git.exe push --force',
    'sh -c "git -C \\"x y\\" push -f"', 'cmd /c "git push --force"', "bash -lc 'GIT push -f'", 'echo ok && Git.exe push origin +main',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  for (const command of ['git -C "x y" push origin feature', 'GIT push origin feature', 'git -C "x y" status', 'echo "git push" is not run', 'git commit -m "push -f"']) {
    assert.equal(checkTool('Bash', {command}, '/repo'), null, command);
  }
});

test('git settings that make a plain push forced, mirrored or aliased are refused', () => {
  const refused = [
    'git -c alias.p=push p --force', 'git -c alias.p="push -f" p', "git -c alias.pf='!git push -f' pf", 'git -c ALIAS.p=push p --force',
    'git -c remote.origin.push=+refs/heads/main:refs/heads/main push', 'git -c remote.origin.mirror=true push', 'git -c remote.origin.mirror push', 'git -c Remote.Upstream.Push=+HEAD push',
    'git --config-env=alias.p=PUSHCMD p', 'git --config-env alias.p=PUSHCMD p', 'git --config-env=remote.origin.push=REFSPEC push', 'git --config-env remote.origin.mirror=M push',
    'git config remote.origin.push +refs/heads/main:refs/heads/main', 'git config --add remote.origin.push +HEAD', 'git config --global remote.origin.mirror true', 'git config --local Remote.Origin.Push :old',
    'git config alias.p "!git push -f"', 'git config --global alias.pf "push --force"', 'git config alias.go "push"', 'git -C repo config remote.origin.push +x',
    'git send-pack --force origin main', 'git send-pack -f origin', 'git send-pack --mirror origin', 'git send-pack origin +main', 'git send-pack origin :old', 'git -C x send-pack --force',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  for (const command of [
    'git -c core.pager=cat log', 'git -c push.default=current push', 'git -c user.name=x commit -m y', 'git config user.name x', 'git config --get remote.origin.push', 'git config --get-regexp alias',
    'git config --list', 'git config alias.st status', 'git config remote.origin.url https://example.test/r.git', 'git send-pack origin feature', 'git remote -v', 'git --config-env=core.pager=PAGER log',
  ]) assert.equal(checkGitPush(command), null, command);
});

// A2a-F3: git takes a unique prefix of a long option, and a + or : argument counts after --.
test('abbreviated forceful push options are refused; other long options stay allowed', () => {
  const refused = [
    'git push --force-w', 'git push --force-with', 'git push --force-if', 'git push --force-if-inc origin', 'git push --fo origin main', 'git push --forc', 'git push --force-with-lease=main:abc',
    'git push --mirr', 'git push --mi', 'git push --dele origin feature', 'git push --de origin feature', 'git push origin --delet=x', 'git push --prun', 'git push --pru origin',
    'git -C "x y" push --mirr', 'echo ok && git push --force-w', 'sh -c "git push --dele origin x"', 'git send-pack --force-w origin', 'git send-pack --mirr origin',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  const allowed = [
    'git push --dry-run', 'git push --no-verify origin feature', 'git push --set-upstream origin feature', 'git push --follow-tags', 'git push --tags', 'git push --porcelain', 'git push --progress',
    'git push --signed=if-asked', 'git push --atomic origin feature', 'git push --push-option=ci.skip', 'git push --receive-pack=git-receive-pack origin feature', 'git push --verbose origin feature', 'git fetch --prune',
  ];
  for (const command of allowed) assert.equal(checkGitPush(command), null, command);
});

test('after -- a +refspec or :ref argument is still refused', () => {
  const refused = ['git push -- origin +main', 'git push origin -- :main', 'git push -- origin +HEAD:refs/heads/main', 'git push -- origin :old', 'git push origin -- feature +main', 'git send-pack -- origin +main', 'git send-pack -- origin :old', "git -C x push -- 'origin' '+main'"];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  // A dash-led word after -- is a repository or refspec name, not an option, so it is not judged as a flag.
  for (const command of ['git push -- origin feature', 'git push origin -- feature', 'git push -- origin HEAD:refs/heads/feature', 'git push --dry-run -- origin feature']) assert.equal(checkGitPush(command), null, command);
});

test('GIT_CONFIG_COUNT, KEY_n, VALUE_n and PARAMETERS settings are refused as assignments or exports', () => {
  const refused = [
    'GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0="push -f" git p', 'GIT_CONFIG_COUNT=1 git p', 'GIT_CONFIG_KEY_0=alias.p git p', 'GIT_CONFIG_VALUE_3=x git p',
    "GIT_CONFIG_PARAMETERS=\"'alias.p=push -f'\" git p", 'git_config_count=1 git p', 'export GIT_CONFIG_COUNT=1', 'export GIT_CONFIG_KEY_0=alias.p; git p', 'env GIT_CONFIG_COUNT=1 git p',
    'declare -x GIT_CONFIG_COUNT', 'export GIT_CONFIG_PARAMETERS', 'sh -c "export GIT_CONFIG_COUNT=1; git p"', 'cd x && GIT_CONFIG_COUNT=1 git p', 'readonly GIT_CONFIG_COUNT',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  for (const command of ['GIT_AUTHOR_NAME=x git commit -m y', 'GIT_CONFIG_NOSYSTEM=1 git status', 'echo GIT_CONFIG_COUNT', 'git config --get-regexp alias', 'GIT_TRACE=1 git status', 'git commit -m GIT_CONFIG_COUNT=1']) {
    assert.equal(checkGitPush(command), null, command);
  }
});

// A2a-REG1: a commit message is text, not a command.
test('a git commit message that mentions git push -f or other commands is not judged as a command', () => {
  const allowed = [
    'git commit -m "docs: never run git push -f"', "git commit -m 'docs: never run git push --force'", 'git commit -m "docs: git push --delete origin x is refused"', 'git commit -am "git push --mirror notes"',
    'git commit --message="docs: git push -f is refused"', 'git commit --message "docs: git push -f"', 'git -C repo commit -m "x; git push -f"', 'git commit -m "a" -m "git push -f"', 'git tag -m "note: git push -f" v1',
    'git merge -m "merge; git push -f" feature', 'git commit -F "message file.txt"', 'git commit --file="message file.txt"', 'GIT_AUTHOR_NAME=x git commit -m "git push -f"', 'git commit -m "docs: GIT_CONFIG_COUNT=1 is refused"',
    'sh -c "git commit -m \'docs: git push -f\'"',
  ];
  for (const command of allowed) {
    assert.equal(checkGitPush(command), null, command);
    assert.equal(checkTool('Bash', {command}, '/repo'), null, command);
  }
  // The message exemption never covers a real push, a second command, a command substitution or another program's -m.
  const refused = [
    'git commit -m "x" && git push -f', 'git commit -m "x"; git push --force-w', 'git commit -m "$(git push -f)"', 'git commit -m "`git push -f`"', 'git commit -m "$(git push --mirror)"',
    'git commit -m "x" -- && git push --delete origin x', 'git push -m x -f',
  ];
  for (const command of refused) {
    assert.match(checkGitPush(command) ?? '', /refused/, command);
  }
  assert.match(checkGitPush('git log -m "git push -f"') ?? '', /refused/, 'only commit, tag, merge, notes and stash read -m as a message');
  assert.match(checkGitPush('sh -c "git log -m x; git push -f"') ?? '', /refused/);
});

// --- S-F4: Bash text tripwire

test('Bash commands that name env files, the chat state, the key variable or dump the environment are refused', () => {
  const refused = [
    'cat .env', 'cat tools/claude-chat/.env', 'type tools\\claude-chat\\.env', 'cat .env.local', 'cat ./.ENV', 'grep KEY .env.production', 'cp .env /tmp/x', 'git check-ignore .env', 'ls .env/',
    'cat .e"n"v', "cat .e'n'v", 'cat .e\\nv',
    'cat .qa-local/claude-chat-state.json', 'cat .qa-local/claude-chat-sessions.json', 'Get-Content .qa-local\\claude-chat.log', 'tail -f .qa-local/claude-chat.log', 'mv .qa-local/claude-chat-state.json /tmp/x',
    'echo $ANTHROPIC_API_KEY', 'echo "${ANTHROPIC_API_KEY}"', 'printenv ANTHROPIC_API_KEY', 'node -e "console.log(process.env.ANTHROPIC_API_KEY)"', 'echo $anthropic_api_key',
    'env', 'printenv', 'set', 'env | grep KEY', 'env > /tmp/e', 'cd x && env', 'ls; printenv', 'ENV', 'sh -c "env"', "bash -c 'printenv'", '/usr/bin/env', 'set | sort',
    'Write-Output $env:ANTHROPIC_API_KEY', '$env:PATH', 'echo $Env:Path', 'cat /proc/self/environ', 'cat /proc/1234/environ', 'strings /proc/$$/environ',
  ];
  for (const command of refused) {
    assert.match(checkBashTripwire(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  const allowed = [
    'npm test', 'git status', 'git log --oneline -5', 'ls -la', 'cat README.md', 'cat .env.example', 'cat tools/claude-chat/.env.example', 'cat .envrc', 'node scripts/x.mjs', 'git commit -m "fix: tripwire"',
    'env FOO=1 node x.js', 'env -i node x.js', 'set -e', 'sh -c "set -e; npm test"', 'echo environment', 'ls docs/environment.md', 'git push origin feature', 'rg environ src', 'cat src/set.js', 'echo env',
  ];
  for (const command of allowed) {
    assert.equal(checkBashTripwire(command), null, command);
    assert.equal(checkTool('Bash', {command}, '/repo'), null, command);
  }
});

// A2a-F4: env, printenv and export with only options (or -u NAME pairs) dump the environment too.
test('env, printenv, export, declare and similar with only options dump the environment and are refused', () => {
  const refused = [
    'env -0', 'env -u FOO', 'env -u FOO -u BAR', 'env --unset=FOO', 'env --unset FOO', 'env -0 -u FOO', 'env -i', 'env FOO=1', 'env -C /tmp', 'env -0 > /tmp/e', 'env -0 | sort', 'env -0 2>&1', 'cd x && env -0', '/usr/bin/env -0', 'ENV.EXE -0',
    'printenv -0', 'printenv --null', 'ls; printenv -0', '/usr/bin/printenv -0',
    'export -p', 'export', 'export -p | sort', 'declare -x', 'declare -p', 'declare -px', 'declare', 'typeset -x', 'typeset -p', 'typeset', 'compgen -e', 'compgen -e | sort',
    'sh -c "env -0"', "bash -c 'export -p'", 'sh -c "declare -x"', 'sh -c "compgen -e"', '(export -p)', 'echo ok && env -u FOO',
    'powershell -c "gci env:"', 'Get-ChildItem Env:', 'ls env:', 'dir ENV:\\PATH', 'Get-Content Env:\\PATH', 'powershell -c "(gci -Path env:).Count"',
  ];
  for (const command of refused) {
    assert.match(checkBashTripwire(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
  const allowed = [
    'env -u FOO node x.js', 'env -i FOO=1 node x.js', 'env FOO=1 npm test', 'env -C /tmp ls', 'env --unset=FOO node x.js', 'env -S "node x.js"', 'printenv HOME', 'printenv HOME PATH', 'export FOO=1', 'export FOO', 'export -n FOO',
    'declare -r X=1', 'declare -x FOO=1', 'declare -f', 'declare -a list', 'typeset -i n=1', 'typeset x', 'compgen -c', 'compgen -W "a b" -- a', 'set -e', 'set -o pipefail', 'sh -c "export FOO=1; npm test"', 'npm run dev:env:ci',
    'echo environment:', 'git log --grep=env',
  ];
  for (const command of allowed) {
    assert.equal(checkBashTripwire(command), null, command);
    assert.equal(checkTool('Bash', {command}, '/repo'), null, command);
  }
});

// A2a-REG1: .env counts only as a path segment, so process.env and a commit message pass.
test('the .env tripwire matches a path segment, not process.env or a commit message', () => {
  const allowed = [
    'node -e "console.log(process.env.HOME)"', 'node -e "const e = process.env; console.log(Object.keys(e).length)"', 'grep -rn process.env tools/', 'grep -rn "process.env" src', 'rg process.env.NODE_ENV src', 'cat prod.env', 'node -e "console.log(import.meta.env)"',
    'git commit -m "docs: document .env handling"', 'git commit -m "docs: never run git push -f"', "git commit -m 'refuse cat .env in Bash'", 'git commit --message="mention .env"', 'git commit -am "tripwire: .env and env -0"',
    'git tag -m "release .env note" v1', 'git commit -m "docs: ANTHROPIC_API_KEY and /proc/self/environ are refused"', 'git commit -m "first" -m "second: .env"',
  ];
  for (const command of allowed) {
    assert.equal(checkBashTripwire(command), null, command);
    assert.equal(checkTool('Bash', {command}, '/repo'), null, command);
  }
  const refused = [
    'cat .env', 'cat ./.env', 'cat tools/claude-chat/.env', 'cat .env.local', 'grep KEY .env.production', 'cp .env /tmp/x', 'type tools\\claude-chat\\.env', 'cat <.env', 'cat<.env', 'FOO=.env cat $FOO', 'source=.env cat x', 'echo x >.env', '(cat .env)', 'cat "$HOME/.env"',
    'cat .e"n"v', "cat .e'n'v", 'cat .e\\nv', 'sh -c "cat .env"', 'git commit -m "x" && cat .env', 'git commit -F .env', 'git commit -m "$(cat .env)"', 'git commit -m "$(env)"', 'git commit -m "`cat .env`"', 'sort -m .env', 'git log -m .env',
  ];
  for (const command of refused) {
    assert.match(checkBashTripwire(command) ?? '', /refused/, command);
    assert.match(checkTool('Bash', {command}, '/repo') ?? '', /refused/, command);
  }
});

// --- SEC-3 and SEC-4: network exposure

const goodEnv = {ANTHROPIC_API_KEY: DUMMY_KEY};

test('a non-loopback CHAT_HOST is refused unless CHAT_ALLOW_REMOTE=1', () => {
  for (const host of ['0.0.0.0', '192.168.1.5', '::', 'chat.example.test']) {
    assert.throws(() => loadConfig({...goodEnv, CHAT_HOST: host}, TOOL_DIR), /not a loopback address/, host);
    assert.equal(loadConfig({...goodEnv, CHAT_HOST: host, CHAT_ALLOW_REMOTE: '1'}, TOOL_DIR).host, host);
  }
  for (const host of [undefined, '127.0.0.1', 'localhost', '::1', 'LOCALHOST']) assert.doesNotThrow(() => loadConfig({...goodEnv, ...(host ? {CHAT_HOST: host} : {})}, TOOL_DIR), String(host));
  assert.throws(() => loadConfig({...goodEnv, CHAT_HOST: '0.0.0.0', CHAT_ALLOW_REMOTE: 'true'}, TOOL_DIR), /not a loopback/);
});

test('config validates the new settings and keeps the repository paths script-relative', () => {
  const config = loadConfig({...goodEnv, CHAT_MAX_SESSION_USD: '12.5', CHAT_PERMISSION_MODE: 'default', CHAT_ALLOWED_HOSTS: ' Chat.test:8787 ,', CHAT_PRINT_URL: '0'}, TOOL_DIR);
  assert.equal(config.maxSessionUsd, 12.5);
  assert.equal(config.permissionMode, 'default');
  assert.deepEqual(config.allowedHosts, ['chat.test:8787']);
  assert.equal(config.printUrl, false);
  assert.equal(config.stateDir, path.join(TOOL_DIR, '..', '..', '.qa-local').replace(/[\\/]tools[\\/]claude-chat[\\/]\.\.[\\/]\.\./, ''));
  assert.equal(loadConfig(goodEnv, TOOL_DIR).printUrl, true);
  assert.equal(loadConfig(goodEnv, TOOL_DIR).maxSessionUsd, null);
  assert.equal(loadConfig(goodEnv, TOOL_DIR).permissionMode, 'acceptEdits');
  assert.throws(() => loadConfig({...goodEnv, CHAT_MAX_SESSION_USD: '-1'}, TOOL_DIR), /CHAT_MAX_SESSION_USD/);
  assert.throws(() => loadConfig({...goodEnv, CHAT_PERMISSION_MODE: 'bypassPermissions'}, TOOL_DIR), /CHAT_PERMISSION_MODE/);
  assert.throws(() => loadConfig({}, TOOL_DIR), /ANTHROPIC_API_KEY is required/);
});

test('Host and Origin checks: only this server on loopback, never a foreign page', async () => {
  const app = await serve({query: fakeQuery(resultTurn(0))});
  const {port} = app;
  const headers = host => ({'x-chat-token': TOKEN, host});
  try {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, `LOCALHOST:${port}`]) assert.equal((await rawRequest(port, {headers: headers(host)})).status, 200, host);
    for (const host of ['evil.test', `evil.test:${port}`, `127.0.0.1:${port + 1}`, '127.0.0.1', `127.0.0.1.evil.test:${port}`]) {
      assert.equal((await rawRequest(port, {headers: headers(host)})).status, 403, `Host ${host}`);
      assert.equal((await rawRequest(port, {route: '/', headers: {host}})).status, 403, `page with Host ${host}`);
    }
    const post = origin => rawRequest(port, {method: 'POST', route: '/api/mode', body: JSON.stringify({mode: 'plan'}),
      headers: {...headers(`127.0.0.1:${port}`), 'content-type': 'application/json', ...(origin === undefined ? {} : {origin})}});
    assert.equal((await post(undefined)).status, 200, 'no Origin (scripts, handoff)');
    assert.equal((await post(`http://127.0.0.1:${port}`)).status, 200);
    assert.equal((await post(`http://localhost:${port}`)).status, 200);
    for (const origin of ['http://evil.test', `http://evil.test:${port}`, 'null', 'https://127.0.0.1.evil.test', `http://127.0.0.1:${port + 1}`, 'file://', 'not a url']) {
      assert.equal((await post(origin)).status, 403, `Origin ${origin}`);
    }
    assert.equal((await rawRequest(port, {headers: {...headers(`127.0.0.1:${port}`), origin: 'http://evil.test'}})).status, 403, 'GET with foreign Origin');
  } finally { app.close(); }
});

test('CHAT_ALLOWED_HOSTS adds exact Host values for a private network name', async () => {
  const app = await serve({query: fakeQuery(resultTurn(0)), allowedHosts: ['chat.tailnet.test:8787']});
  try {
    assert.equal((await rawRequest(app.port, {headers: {'x-chat-token': TOKEN, host: 'chat.tailnet.test:8787'}})).status, 200);
    assert.equal((await rawRequest(app.port, {headers: {'x-chat-token': TOKEN, host: 'other.tailnet.test:8787'}})).status, 403);
  } finally { app.close(); }
});

// --- SEC-5: the access link stays out of logs

async function startServerProcess(extraEnv) {
  const port = await freePort();
  const env = {};
  for (const [key, value] of Object.entries(process.env)) if (!/^(claude|anthropic_|chat_)/i.test(key)) env[key] = value;
  const child = spawn(process.execPath, ['server.mjs'], {cwd: TOOL_DIR, env: {...env, ANTHROPIC_API_KEY: DUMMY_KEY, CHAT_PORT: String(port), CHAT_TOKEN: TOKEN, ...extraEnv}, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true});
  let output = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 20000;
  while (!/Open: |Listening: /.test(output) && Date.now() < deadline) {
    if (child.exitCode !== null) break;
    await tick(50);
  }
  return {child, port, output: () => output, stop: () => child.kill()};
}

test('the server prints the access link only when CHAT_PRINT_URL allows it', async () => {
  const quiet = await startServerProcess({CHAT_PRINT_URL: '0'});
  try {
    assert.match(quiet.output(), /Listening: http:\/\/127\.0\.0\.1:\d+\/ \(access link not printed\)/);
    assert.equal(quiet.output().includes(TOKEN), false, 'token in output');
    assert.equal(quiet.output().includes(DUMMY_KEY), false, 'key in output');
  } finally { quiet.stop(); }
  const open = await startServerProcess({});
  try { assert.ok(open.output().includes(`#token=${TOKEN}`)); } finally { open.stop(); }
});

// --- SEC-7: cumulative cost and the per-chat cap

test('cost accumulates across runs; CHAT_MAX_SESSION_USD stops the chat', async () => {
  let turns = 0;
  const totals = [5.01, 1, 0.5];
  const query = fakeQuery(async function* (message, options) {
    yield init(options);
    const total = totals[turns++];
    yield {type: 'result', subtype: total > 5 ? 'error_max_budget_usd' : 'success', is_error: total > 5, total_cost_usd: total, errors: []};
  });
  const chat = new Chat({query, config: {...baseConfig, maxSessionUsd: 6}});
  const seen = [];
  chat.subscribe(event => seen.push(event));
  chat.send('one');
  await tick();
  assert.equal(chat.state().cost, 5.01, 'first run');
  assert.equal(chat.q, null, 'the per-run cap ended the run');
  assert.equal(query.calls[0].options.maxBudgetUsd, 5);
  chat.send('two');
  assert.equal(query.calls[1].options.maxBudgetUsd < 1, true, 'second run is capped by what is left of the chat budget');
  assert.ok(Math.abs(query.calls[1].options.maxBudgetUsd - 0.99) < 1e-9);
  await tick();
  assert.ok(Math.abs(chat.state().cost - 6.01) < 1e-9, 'cumulative cost');
  assert.equal(chat.state().maxSessionUsd, 6);
  assert.ok(seen.some(e => e.type === 'error' && /CHAT_MAX_SESSION_USD/.test(e.message)));
  assert.equal(chat.q, null);
  assert.throws(() => chat.send('three'), {status: 402});
  assert.equal(turns, 2, 'no third run started');
  chat.reset();
  assert.equal(chat.state().cost, 0);
  chat.send('fresh');
  assert.equal(query.calls[2].options.maxBudgetUsd, 5);
  chat.stop();
});

test('without a per-chat cap the cost still adds up and the per-run cap is unchanged', async () => {
  const query = fakeQuery(resultTurn(1.25));
  const chat = new Chat({query, config: baseConfig});
  chat.send('a');
  await tick();
  assert.equal(chat.cost, 1.25);
  chat.stop();
  chat.send('b');
  await tick();
  assert.equal(chat.cost, 2.5);
  assert.equal(chat.state().maxSessionUsd, null);
  assert.equal(query.calls[1].options.maxBudgetUsd, 5);
  chat.stop();
});

// --- SEC-9: environment strip

test('the agent environment drops CLAUDE*, ANTHROPIC_* in any case and the access token', () => {
  const env = agentEnv({
    PATH: '/bin', claudecode: '1', Claude_Code_Oauth_Token: 'x', CLAUDE_CODE_USE_BEDROCK: '1', anthropic_auth_token: 'x', Anthropic_Base_Url: 'x', ANTHROPIC_API_KEY: 'sk-other',
    CHAT_TOKEN: TOKEN, chat_token: TOKEN, CHAT_PORT: '8787', HOME: '/h',
  }, 'sk-ant-api03-chosen');
  assert.deepEqual(Object.keys(env).sort(), ['ANTHROPIC_API_KEY', 'CHAT_PORT', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'HOME', 'PATH']);
  assert.equal(env.ANTHROPIC_API_KEY, 'sk-ant-api03-chosen');
});

// --- SEC-10: only Astra sessions

test('only sessions created by Astra are listed and resumable', async () => {
  const other = '99999999-8888-4777-8666-555555555555';
  const listed = [{sessionId: SESSION, summary: 'ours', lastModified: 2}, {sessionId: other, summary: 'a personal Claude Code session', lastModified: 3}];
  const store = memorySessionStore();
  const query = fakeQuery(resultTurn(0));
  const chat = new Chat({query, config: baseConfig, sessionStore: store, listSessions: async () => listed, getSessionMessages: async () => []});
  assert.deepEqual(await chat.sessions(), [], 'nothing before Astra created a session');
  chat.send('hello');
  await tick();
  assert.equal(store.has(SESSION), true, 'the init message registers the session');
  assert.deepEqual((await chat.sessions()).map(s => s.sessionId), [SESSION]);
  await assert.rejects(chat.resume(other), {status: 404});
  await assert.rejects(chat.resume('../etc'), {status: 400});
  await chat.resume(SESSION);
  chat.stop();
});

test('a session started with the wrong credential is not registered', async () => {
  const store = memorySessionStore();
  const query = fakeQuery(async function* (message, options) { yield {...init(options), apiKeySource: 'oauth'}; });
  const chat = new Chat({query, config: baseConfig, sessionStore: store});
  chat.send('hi');
  await tick();
  assert.equal(store.has(SESSION), false);
});

test('the session store persists ids, ignores bad ones and fails closed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-sessions-'));
  const file = path.join(dir, 'state', 'claude-chat-sessions.json');
  try {
    const store = fileSessionStore(file);
    assert.equal(store.has(SESSION), false);
    store.add(SESSION);
    store.add('../../etc/passwd');
    store.add(SESSION);
    assert.equal(fileSessionStore(file).has(SESSION), true);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), {sessions: [SESSION]});
    if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    fs.writeFileSync(file, '{not json');
    assert.equal(fileSessionStore(file).has(SESSION), false);
    assert.equal(fileSessionStore(path.join(dir, 'missing.json')).has(SESSION), false);
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});