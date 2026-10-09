import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Chat} from './lib/chat.mjs';
import {loadConfig} from './lib/config.mjs';
import {createApp} from './lib/http.mjs';
import {fileSessionStore} from './lib/sessions.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

let settings;
try { settings = loadConfig(process.env, here); } catch (error) { console.error(error.message); process.exit(1); }
// Imported here so the chat/http modules stay testable without the SDK installed.
const {query, listSessions, getSessionMessages} = await import('@anthropic-ai/claude-agent-sdk');
const chat = new Chat({query, listSessions, getSessionMessages, config: settings,
  sessionStore: fileSessionStore(path.join(settings.stateDir, 'claude-chat-sessions.json'))});
const server = createApp({chat, token: settings.token, publicDir: path.join(here, 'public'), allowedHosts: settings.allowedHosts});

server.on('error', error => { console.error(`Cannot listen on ${settings.host}:${settings.port}: ${error.message}`); process.exit(1); });
server.listen(settings.port, settings.host, () => {
  const shown = settings.host === '0.0.0.0' || settings.host === '::' ? '127.0.0.1' : settings.host;
  const base = `http://${shown.includes(':') ? `[${shown}]` : shown}:${server.address().port}`;
  console.log(`Astra Claude Chat — repo: ${settings.cwd}`);
  console.log(`Model ${settings.model}, effort ${settings.effort}, mode ${settings.permissionMode}, budget $${settings.maxBudgetUsd} per run${settings.maxSessionUsd ? `, $${settings.maxSessionUsd} per chat` : ''}`);
  // The token is part of the link, so a log-writing launcher turns this off (CHAT_PRINT_URL=0).
  console.log(settings.printUrl ? `Open: ${base}/#token=${settings.token}` : `Listening: ${base}/ (access link not printed)`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(settings.host)) console.warn('WARNING: listening beyond loopback. Expose only through a private network or SSH tunnel.');
});

// SIGBREAK is what Ctrl+Break sends on Windows. A forced kill (taskkill /F, Stop-Process) runs no handler.
function shutdown() { chat.stop(); server.close(); process.exit(0); }
for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) process.on(signal, shutdown);