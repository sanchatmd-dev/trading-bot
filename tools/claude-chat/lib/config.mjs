import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {MODELS, MODES} from './chat.mjs';

export const LOOPBACK_HOSTS = ['127.0.0.1', 'localhost', '::1'];

// Reads and validates the server settings. `here` is the tools/claude-chat
// directory; the repository root and its ignored .qa-local/ state folder are
// derived from it, never from the working directory.
export function loadConfig(env, here) {
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
  const maxSessionUsd = env.CHAT_MAX_SESSION_USD ? Number(env.CHAT_MAX_SESSION_USD) : null;
  if (maxSessionUsd !== null && !(maxSessionUsd > 0)) throw new Error('CHAT_MAX_SESSION_USD must be a positive number when set');
  const permissionMode = env.CHAT_PERMISSION_MODE || 'acceptEdits';
  if (!MODES.includes(permissionMode)) throw new Error(`CHAT_PERMISSION_MODE must be one of: ${MODES.join(', ')}`);
  const token = env.CHAT_TOKEN || randomBytes(24).toString('base64url');
  if (token.length < 24) throw new Error('CHAT_TOKEN must be at least 24 characters');
  const port = Number(env.CHAT_PORT || 8787);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('CHAT_PORT must be a port number');
  const host = (env.CHAT_HOST || '127.0.0.1').trim().toLowerCase();
  if (!LOOPBACK_HOSTS.includes(host) && env.CHAT_ALLOW_REMOTE !== '1') {
    throw new Error(`CHAT_HOST=${host} is not a loopback address. The chat can edit files and run commands, so it listens on ${LOOPBACK_HOSTS.join(', ')} only. For a private network or tunnel set CHAT_ALLOW_REMOTE=1 and CHAT_ALLOWED_HOSTS.`);
  }
  const repoRoot = path.resolve(here, '..', '..');
  return {
    apiKey, model, effort, maxBudgetUsd, maxSessionUsd, token, port, host, permissionMode, env,
    cwd: path.resolve(env.CHAT_REPO_DIR || repoRoot),
    stateDir: path.join(repoRoot, '.qa-local'),
    allowedHosts: String(env.CHAT_ALLOWED_HOSTS || '').split(',').map(entry => entry.trim().toLowerCase()).filter(Boolean),
    // The link carries the access token; handoff keeps it out of the log.
    printUrl: env.CHAT_PRINT_URL !== '0',
  };
}