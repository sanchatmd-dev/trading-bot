import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomBytes} from 'node:crypto';
import {Chat, MODELS} from './lib/chat.mjs';
import {createApp} from './lib/http.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const env = process.env;

function config() {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required: create a key in the Console organization linked to your Max plan (see README).');
  // OAuth and admin tokens are not Console API keys and would not draw the monthly API credits.
  if (/^sk-ant-(oat|admin)/.test(apiKey)) throw new Error('ANTHROPIC_API_KEY must be a Console API key, not an OAuth or Admin key.');
  const model = env.CHAT_MODEL || 'claude-opus-5-5';
  if (!MODELS.some(m => m.id === model)) throw new Error(`CHAT_MODEL must be one of: ${MODELS.map(m => m.id).join(', ')}`);
  const effort = env.CHAT_EFFORT || 'high';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('CHAT_EFFORT must be low, medium, high, xhigh or max');
  const maxBudgetUsd = Number(env.CHAT_MAX_BUDGET_USD || 5);
  if (!(maxBudgetUsd > 0)) throw new Error('CHAT_MAX_BUDGET_USD must be a positive number');
  const token = env.CHAT_TOKEN || randomBytes(24).toString('base64url');
  if (token.length < 24) throw new Error('CHAT_TOKEN must be at least 24 characters');
  const port = Number(env.CHAT_PORT || 8787);
  return {apiKey, model, effort, maxBudgetUsd, token, port, host: env.CHAT_HOST || '127.0.0.1',
    cwd: path.resolve(env.CHAT_REPO_DIR || path.join(here, '..', '..')), permissionMode: 'acceptEdits', env};
}

let settings;
try { settings = config(); } catch (error) { console.error(error.message); process.exit(1); }
// Imported here so the chat/http modules stay testable without the SDK installed.
const {query, listSessions, getSessionMessages} = await import('@anthropic-ai/claude-agent-sdk');
const chat = new Chat({query, listSessions, getSessionMessages, config: settings});
const server = createApp({chat, token: settings.token, publicDir: path.join(here, 'public')});

server.listen(settings.port, settings.host, () => {
  const shown = settings.host === '0.0.0.0' || settings.host === '::' ? '127.0.0.1' : settings.host;
  console.log(`Astra Claude Chat — repo: ${settings.cwd}`);
  console.log(`Model ${settings.model}, effort ${settings.effort}, budget $${settings.maxBudgetUsd} per run`);
  console.log(`Open: http://${shown}:${settings.port}/#token=${settings.token}`);
  if (!['127.0.0.1', 'localhost', '::1'].includes(settings.host)) console.warn('WARNING: listening beyond loopback. Expose only through a private network or SSH tunnel.');
});

for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { chat.stop(); server.close(); process.exit(0); });
