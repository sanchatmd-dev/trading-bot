import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID, timingSafeEqual} from 'node:crypto';

const STATIC = {'/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8']};
const HEADERS = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
};

const fail = (status, message) => Object.assign(new Error(message), {status});

function sameToken(given, token) {
  const a = Buffer.from(String(given ?? '')), b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function body(req) {
  if (!String(req.headers['content-type'] ?? '').startsWith('application/json')) throw fail(415, 'JSON required');
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > 256 * 1024) throw fail(413, 'Body too large'); chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); if (value && typeof value === 'object' && !Array.isArray(value)) return value; } catch {}
  throw fail(400, 'Invalid JSON');
}

export function createApp({chat, token, publicDir}) {
  const json = (res, status, value) => { res.writeHead(status, {...HEADERS, 'content-type': 'application/json; charset=utf-8'}); res.end(JSON.stringify(value)); };
  const routes = {
    'GET /api/state': () => chat.state(),
    'GET /api/sessions': () => chat.sessions(),
    'POST /api/send': ({text}) => {
      if (typeof text !== 'string' || !text.trim() || text.length > 100000) throw fail(400, 'Message required');
      chat.send(text); return {ok: true};
    },
    'POST /api/interrupt': async () => { await chat.interrupt(); return {ok: true}; },
    'POST /api/permission': ({id, allow, always}) => {
      if (!chat.answer(String(id), {allow: allow === true, always: always === true})) throw fail(404, 'No pending request');
      return {ok: true};
    },
    'POST /api/new': () => { chat.reset(); return {ok: true}; },
    'POST /api/model': async ({model}) => { await chat.setModel(String(model)); return {ok: true}; },
    'POST /api/mode': async ({mode}) => { await chat.setMode(String(mode)); return {ok: true}; },
    'POST /api/resume': async ({sessionId}) => { await chat.resume(String(sessionId)); return {ok: true}; },
  };

  // Identifies this server process, so a browser reconnecting after a restart
  // drops its stale view and receives the full log instead of a partial one.
  const epoch = randomUUID();
  function events(req, res, after, clientEpoch) {
    res.writeHead(200, {...HEADERS, 'content-type': 'application/x-ndjson; charset=utf-8', 'x-accel-buffering': 'no'});
    const write = event => res.write(JSON.stringify(event) + '\n');
    write({type: 'hello', epoch});
    for (const event of clientEpoch === epoch ? chat.since(after) : chat.events) write(event);
    const unsubscribe = chat.subscribe(write);
    const ping = setInterval(() => res.write('{"type":"ping"}\n'), 15000);
    req.on('close', () => { clearInterval(ping); unsubscribe(); });
  }

  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [file, type] = STATIC[url.pathname];
        res.writeHead(200, {...HEADERS, 'content-type': type});
        res.end(await readFile(path.join(publicDir, file)));
        return;
      }
      if (!url.pathname.startsWith('/api/')) throw fail(404, 'Not found');
      if (!sameToken(req.headers['x-chat-token'], token)) throw fail(401, 'Unauthorized');
      if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res, Number(url.searchParams.get('after')) || 0, url.searchParams.get('epoch'));
      const route = routes[`${req.method} ${url.pathname}`];
      if (!route) throw fail(404, 'Not found');
      json(res, 200, await route(req.method === 'POST' ? await body(req) : {}));
    } catch (error) {
      if (res.headersSent) { res.end(); return; }
      json(res, error.status ?? 500, {error: error.status ? error.message : 'Internal error'});
      if (!error.status) console.error(error);
    }
  });
}
