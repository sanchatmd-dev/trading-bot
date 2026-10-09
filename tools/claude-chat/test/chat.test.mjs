import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Chat, agentEnv, memorySessionStore} from '../lib/chat.mjs';
import {createApp} from '../lib/http.mjs';

const TOKEN = 'fixture-token-not-a-secret-000';
const SESSION = '11111111-2222-4333-8444-555555555555';
const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const config = {cwd: '/repo', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'acceptEdits', maxBudgetUsd: 5, apiKey: 'sk-ant-api03-fixture',
  env: {PATH: '/bin', ANTHROPIC_AUTH_TOKEN: 'subscription', CLAUDE_CODE_OAUTH_TOKEN: 'oauth', CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_BASE_URL: 'https://gateway.test',
    // Variables a parent Claude Code session exports to its own subprocesses.
    CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1', CLAUDE_CODE_SESSION_ID: 'parent-session', CLAUDECODE: '1'}};

// Stands in for the Agent SDK's query(): one scripted turn per user message.
function fakeQuery(turn) {
  const calls = [];
  const fn = ({prompt, options}) => {
    const call = {options, closed: false, interrupted: 0};
    calls.push(call);
    const gen = (async function* () { for await (const message of prompt) yield* turn(message, options, call); })();
    return Object.assign(gen, {
      interrupt: async () => { call.interrupted++; },
      setModel: async model => { call.model = model; },
      setPermissionMode: async mode => { call.mode = mode; },
      close: () => { call.closed = true; },
    });
  };
  fn.calls = calls;
  return fn;
}
const init = (options, apiKeySource = 'ANTHROPIC_API_KEY') => ({type: 'system', subtype: 'init', apiKeySource, session_id: SESSION, model: options.model, cwd: options.cwd, permissionMode: options.permissionMode});
async function* bashTurn(message, options, call) {
  yield init(options);
  yield {type: 'stream_event', parent_tool_use_id: null, event: {type: 'message_start', message: {id: 'm1'}}};
  yield {type: 'stream_event', parent_tool_use_id: null, event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'ตรวจสถานะ'}}};
  yield {type: 'assistant', parent_tool_use_id: null, message: {id: 'm1', content: [{type: 'text', text: 'ตรวจสถานะ'}, {type: 'tool_use', id: 't1', name: 'Bash', input: {command: 'git status'}}]}};
  call.decision = await options.canUseTool('Bash', {command: 'git status'}, {signal: new AbortController().signal, toolUseID: 't1',
    suggestions: [{type: 'addRules', rules: [{toolName: 'Bash', ruleContent: 'git status'}], behavior: 'allow', destination: 'localSettings'}]});
  const allowed = call.decision.behavior === 'allow';
  yield {type: 'user', parent_tool_use_id: null, message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't1', content: allowed ? 'clean' : 'denied', is_error: !allowed}]}};
  yield {type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0.0123, duration_ms: 1200, num_turns: 2, errors: [], result: 'done'};
}

async function serve(query) {
  const chat = new Chat({query, config});
  const server = createApp({chat, token: TOKEN, publicDir});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {chat, base, close() { chat.stop(); server.closeAllConnections(); server.close(); }};
}
const post = (base, route, body, headers = {}) => fetch(base + route, {method: 'POST', headers: {'x-chat-token': TOKEN, 'content-type': 'application/json', ...headers}, body: JSON.stringify(body)});
async function events(base) {
  const controller = new AbortController();
  const res = await fetch(base + '/api/events?after=0', {headers: {'x-chat-token': TOKEN}, signal: controller.signal});
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  const seen = []; let buffer = '';
  return {
    seen,
    async until(match) {
      for (;;) {
        const hit = seen.find(match);
        if (hit) return hit;
        const {value, done} = await reader.read();
        if (done) throw new Error('event stream ended');
        buffer += value;
        for (let i; (i = buffer.indexOf('\n')) >= 0;) { const line = buffer.slice(0, i); buffer = buffer.slice(i + 1); if (line) seen.push(JSON.parse(line)); }
      }
    },
    close: () => controller.abort(),
  };
}

test('API requires the access token; the page itself carries no secrets', async () => {
  const app = await serve(fakeQuery(bashTurn));
  try {
    assert.equal((await fetch(app.base + '/api/state')).status, 401);
    assert.equal((await fetch(app.base + '/api/state', {headers: {'x-chat-token': TOKEN + 'x'}})).status, 401);
    const page = await fetch(app.base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /default-src 'none'/);
    assert.equal((await post(app.base, '/api/send', {text: 'hi'}, {'content-type': 'text/plain'})).status, 415);
    assert.equal((await post(app.base, '/api/send', {text: '  '})).status, 400);
  } finally { app.close(); }
});

test('a turn streams text, asks before running a command and records cost', async () => {
  const query = fakeQuery(bashTurn), app = await serve(query);
  const stream = await events(app.base);
  try {
    assert.equal((await post(app.base, '/api/send', {text: 'ช่วยดู git status'})).status, 200);
    const ask = await stream.until(e => e.type === 'permission');
    assert.equal(ask.summary, 'git status');
    assert.equal(ask.canAlways, true);
    assert.equal((await post(app.base, '/api/permission', {id: ask.id, allow: true, always: true})).status, 200);
    const result = await stream.until(e => e.type === 'result');
    assert.equal(result.cost, 0.0123);
    const types = stream.seen.map(e => e.type);
    for (const type of ['hello', 'user', 'busy', 'init', 'delta', 'text', 'tool', 'permission_done', 'tool_result']) assert.ok(types.includes(type), type);
    assert.equal(stream.seen.find(e => e.type === 'tool_result').text, 'clean');
    // "Always" stays in this session; it is never written to a settings file.
    assert.equal(query.calls[0].decision.updatedPermissions[0].destination, 'session');
    const state = await (await fetch(app.base + '/api/state', {headers: {'x-chat-token': TOKEN}})).json();
    assert.equal(state.busy, false);
    assert.equal(state.sessionId, SESSION);
    assert.equal((await post(app.base, '/api/permission', {id: ask.id, allow: true})).status, 404);
  } finally { stream.close(); app.close(); }
});

test('the agent only receives the Console API key and the reviewed options', async () => {
  const query = fakeQuery(bashTurn), app = await serve(query);
  try {
    await post(app.base, '/api/send', {text: 'hi'});
    const {options} = query.calls[0];
    assert.equal(options.env.ANTHROPIC_API_KEY, 'sk-ant-api03-fixture');
    for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'ANTHROPIC_BASE_URL', 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST', 'CLAUDE_CODE_SESSION_ID', 'CLAUDECODE']) assert.equal(key in options.env, false, key);
    assert.equal(options.env.PATH, '/bin');
    assert.deepEqual(options.settingSources, ['project']);
    assert.equal(options.model, 'claude-opus-5-5');
    assert.equal(options.permissionMode, 'acceptEdits');
    assert.equal(options.maxBudgetUsd, 5);
    assert.ok(options.disallowedTools.includes('AskUserQuestion'));
    assert.equal(options.resume, undefined);
  } finally { app.close(); }
  assert.deepEqual(Object.keys(agentEnv({CLAUDE_CODE_USE_VERTEX: '1', HOME: '/h'}, 'k')).sort(), ['ANTHROPIC_API_KEY', 'CLAUDE_AGENT_SDK_CLIENT_APP', 'HOME']);
});

test('stops when the CLI reports any credential other than the API key', async () => {
  const query = fakeQuery(async function* (message, options) { yield init(options, 'none'); yield {type: 'result', subtype: 'success', is_error: false, total_cost_usd: 0}; });
  const chat = new Chat({query, config}), seen = [];
  chat.subscribe(e => seen.push(e));
  chat.send('hi');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.ok(seen.some(e => e.type === 'error' && e.message.includes('ANTHROPIC_API_KEY')));
  assert.equal(seen.some(e => e.type === 'init' || e.type === 'result'), false);
  assert.equal(query.calls[0].closed, true);
  assert.equal(chat.busy, false);
});

test('a budget stop ends the run; the next message resumes the same conversation', async () => {
  const query = fakeQuery(async function* (message, options) { yield init(options); yield {type: 'result', subtype: 'error_max_budget_usd', is_error: true, total_cost_usd: 5.01, errors: []}; });
  const chat = new Chat({query, config});
  chat.send('งานใหญ่');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(query.calls[0].closed, true);
  assert.equal(chat.q, null);
  chat.send('ทำต่อ');
  assert.equal(query.calls[1].options.resume, SESSION);
  chat.stop();
});

test('model and mode switches reach the running session and reject unknown values', async () => {
  const query = fakeQuery(bashTurn), chat = new Chat({query, config});
  chat.send('hi');
  await chat.setModel('claude-sonnet-5-5');
  await chat.setMode('plan');
  assert.equal(query.calls[0].model, 'claude-sonnet-5-5');
  assert.equal(query.calls[0].mode, 'plan');
  await assert.rejects(chat.setModel('gpt-4.1'), {status: 400});
  await assert.rejects(chat.setMode('bypassPermissions'), {status: 400});
  await chat.interrupt();
  assert.equal(query.calls[0].interrupted, 1);
  chat.stop();
});

test('resume replays the saved transcript before continuing it', async () => {
  const history = [
    {type: 'user', uuid: 'u1', parent_tool_use_id: null, message: {role: 'user', content: 'สรุป README'}},
    {type: 'assistant', uuid: 'a1', parent_tool_use_id: null, message: {id: 'm9', content: [{type: 'text', text: 'สรุปแล้ว'}, {type: 'tool_use', id: 't9', name: 'Read', input: {file_path: '/repo/README.md'}}]}},
    {type: 'user', uuid: 'u2', parent_tool_use_id: null, message: {role: 'user', content: [{type: 'tool_result', tool_use_id: 't9', content: '...'}]}},
  ];
  const query = fakeQuery(bashTurn);
  const chat = new Chat({query, config, sessionStore: memorySessionStore([SESSION]), getSessionMessages: async (id, opts) => { assert.equal(id, SESSION); assert.equal(opts.dir, '/repo'); return history; }});
  await chat.resume(SESSION);
  assert.deepEqual(chat.events.map(e => e.type), ['reset', 'user', 'text', 'tool', 'resumed']);
  assert.equal(chat.events.find(e => e.type === 'tool').summary, 'README.md');
  chat.send('ต่อเลย');
  assert.equal(query.calls[0].options.resume, SESSION);
  await assert.rejects(chat.resume('../etc'), {status: 400});
  chat.stop();
});
