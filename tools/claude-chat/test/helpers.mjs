import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Chat} from '../lib/chat.mjs';
import {createApp} from '../lib/http.mjs';

export const TOOL_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const TOKEN = 'fixture-token-not-a-secret-000';
export const SESSION = '11111111-2222-4333-8444-555555555555';
export const DUMMY_KEY = 'sk-ant-api03-dummy-not-a-real-key';
export const baseConfig = {cwd: '/repo', model: 'claude-opus-5-5', effort: 'high', permissionMode: 'default', maxBudgetUsd: 5, apiKey: 'sk-ant-api03-fixture', env: {PATH: '/bin'}};

// Stands in for the Agent SDK query(): one scripted turn per user message.
export function fakeQuery(turn) {
  const calls = [];
  const fn = ({prompt, options}) => {
    const call = {options, closed: false};
    calls.push(call);
    const gen = (async function* () { for await (const message of prompt) yield* turn(message, options, call); })();
    return Object.assign(gen, {interrupt: async () => {}, setModel: async () => {}, setPermissionMode: async () => {}, close: () => { call.closed = true; }});
  };
  fn.calls = calls;
  return fn;
}
export const init = options => ({type: 'system', subtype: 'init', apiKeySource: 'ANTHROPIC_API_KEY', session_id: SESSION, model: options.model, cwd: options.cwd, permissionMode: options.permissionMode});
export const resultTurn = total => async function* (message, options) {
  yield init(options);
  yield {type: 'result', subtype: 'success', is_error: false, total_cost_usd: total, duration_ms: 1, num_turns: 1, errors: []};
};
export const idleTurn = async function* (message, options) { yield init(options); await new Promise(() => {}); };

export async function serve({query, config = baseConfig, token = TOKEN, allowedHosts, port = 0, chatOptions = {}}) {
  const chat = new Chat({query, config, ...chatOptions});
  const server = createApp({chat, token, publicDir: path.join(TOOL_DIR, 'public'), allowedHosts});
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  const actualPort = server.address().port;
  return {chat, server, port: actualPort, base: `http://127.0.0.1:${actualPort}`, close() { chat.stop(); server.closeAllConnections(); server.close(); }};
}

export function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { const {port} = server.address(); server.close(() => resolve(port)); });
  });
}

// node:http, unlike fetch, lets a test send any Host or Origin header.
export function rawRequest(port, {method = 'GET', route = '/api/state', headers = {}, body} = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({host: '127.0.0.1', port, method, path: route, headers}, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({status: res.statusCode, text: Buffer.concat(chunks).toString('utf8')}));
    });
    req.once('error', reject);
    req.end(body);
  });
}