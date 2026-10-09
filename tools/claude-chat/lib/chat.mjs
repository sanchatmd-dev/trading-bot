import {randomUUID} from 'node:crypto';
import path from 'node:path';

// Every inherited CLAUDE*/ANTHROPIC* variable is dropped: launched from inside
// another Claude Code session, they carry its OAuth token, gateway, cloud
// provider or host-managed session and would bill that instead of the Console
// API key. Monthly API credits apply only to the Claude API with that key.
const INHERITED = /^(CLAUDE|ANTHROPIC_)/;

export const MODELS = [
  {id: 'claude-opus-5-5', label: 'Opus 5.5'},
  {id: 'claude-sonnet-5-5', label: 'Sonnet 5.5'},
  {id: 'claude-haiku-5-5', label: 'Haiku 5.5'},
];
export const MODES = ['default', 'acceptEdits', 'plan'];

const SYSTEM_APPEND = `You are running inside Astra Claude Chat, a private local web chat the repository owner uses to direct work on this Git repository. Reply in the user's language (Thai unless they write otherwise). Work on a feature branch rather than the default branch unless asked. Commit or push only when the user asks, and never force-push. Before you say a change is done, run the relevant checks and report their results faithfully.`;

export function agentEnv(base, apiKey) {
  const env = {};
  for (const [key, value] of Object.entries(base)) if (!INHERITED.test(key)) env[key] = value;
  return {...env, ANTHROPIC_API_KEY: apiKey, CLAUDE_AGENT_SDK_CLIENT_APP: 'astra-claude-chat/1.0.0'};
}

const clip = (text, max) => text.length > max ? text.slice(0, max) + `\n… (${text.length - max} more characters)` : text;

export function summarizeTool(name, input, cwd) {
  const rel = p => typeof p === 'string' && cwd && p.startsWith(cwd + path.sep) ? path.relative(cwd, p) : p;
  switch (name) {
    case 'Bash': return {summary: String(input.command ?? ''), detail: input.description ? String(input.description) : ''};
    case 'Read': case 'Write': case 'Edit': case 'NotebookEdit': {
      const detail = name === 'Edit' ? `- ${clip(String(input.old_string ?? ''), 1500)}\n+ ${clip(String(input.new_string ?? ''), 1500)}`
        : name === 'Write' ? clip(String(input.content ?? ''), 3000) : '';
      return {summary: String(rel(input.file_path ?? input.notebook_path ?? '')), detail};
    }
    case 'Grep': return {summary: `${input.pattern ?? ''}${input.path ? ' in ' + rel(input.path) : ''}`, detail: ''};
    case 'Glob': return {summary: String(input.pattern ?? ''), detail: ''};
    case 'WebFetch': return {summary: String(input.url ?? ''), detail: ''};
    case 'WebSearch': return {summary: String(input.query ?? ''), detail: ''};
    case 'Task': case 'Agent': return {summary: String(input.description ?? ''), detail: clip(String(input.prompt ?? ''), 2000)};
    case 'TodoWrite': return {summary: `${input.todos?.length ?? 0} items`, detail: (input.todos ?? []).map(t => `[${t.status === 'completed' ? 'x' : ' '}] ${t.content}`).join('\n')};
    case 'ExitPlanMode': return {summary: 'Plan ready', detail: clip(String(input.plan ?? ''), 6000)};
    default: return {summary: '', detail: clip(JSON.stringify(input, null, 2), 2000)};
  }
}

function resultText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map(b => b.type === 'text' ? b.text : `[${b.type}]`).join('\n');
}

const API_ERRORS = {
  billing_error: 'เครดิต API หมดหรือบัญชีมีปัญหาเรื่องการเงิน (ดูที่ platform.claude.com → Settings → Billing)',
  authentication_failed: 'API key ไม่ถูกต้องหรือถูกยกเลิก',
  rate_limit: 'ชน rate limit ของ API ชั่วคราว ลองใหม่อีกครั้งภายหลัง',
  overloaded: 'เซิร์ฟเวอร์ Claude ทำงานหนัก ลองใหม่อีกครั้ง',
  model_not_found: 'ไม่พบโมเดลนี้ในบัญชี API',
};

class Inbox {
  items = []; waiters = []; closed = false;
  push(item) { const waiter = this.waiters.shift(); if (waiter) waiter({value: item, done: false}); else this.items.push(item); }
  close() { this.closed = true; for (const waiter of this.waiters.splice(0)) waiter({value: undefined, done: true}); }
  [Symbol.asyncIterator]() {
    return {
      next: () => this.items.length ? Promise.resolve({value: this.items.shift(), done: false})
        : this.closed ? Promise.resolve({value: undefined, done: true})
        : new Promise(resolve => this.waiters.push(resolve)),
      return: () => { this.close(); return Promise.resolve({value: undefined, done: true}); },
    };
  }
}

// One conversation at a time, driven through the Agent SDK's streaming input
// mode so follow-ups, interrupts and model/mode switches reach the same run.
export class Chat {
  constructor({query, listSessions = async () => [], getSessionMessages = async () => [], config}) {
    this.queryFn = query; this.listSessionsFn = listSessions; this.getSessionMessagesFn = getSessionMessages;
    this.config = config;
    this.model = config.model; this.mode = config.permissionMode;
    this.events = []; this.seq = 0; this.listeners = new Set();
    this.pending = new Map();
    this.q = null; this.inbox = null; this.gen = 0;
    this.sessionId = null; this.busy = false; this.cost = 0;
  }

  emit(event) {
    const entry = {...event, seq: ++this.seq};
    this.events.push(entry);
    if (this.events.length > 3000) this.events.splice(0, this.events.length - 3000);
    for (const listener of this.listeners) listener(entry);
  }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  since(seq) { return this.events.filter(e => e.seq > seq); }
  state() { return {busy: this.busy, sessionId: this.sessionId, model: this.model, mode: this.mode, cost: this.cost, cwd: this.config.cwd, models: MODELS, modes: MODES, maxBudgetUsd: this.config.maxBudgetUsd}; }

  start(resume) {
    const gen = ++this.gen, inbox = new Inbox();
    const options = {
      cwd: this.config.cwd,
      model: this.model,
      effort: this.config.effort,
      permissionMode: this.mode,
      canUseTool: (name, input, opts) => this.ask(gen, name, input, opts),
      // The model asks questions in chat text; the browser has no dialog for this tool.
      disallowedTools: ['AskUserQuestion', 'Bash(git push --force*)', 'Bash(git push -f*)'],
      settingSources: ['project'],
      systemPrompt: {type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND},
      includePartialMessages: true,
      maxBudgetUsd: this.config.maxBudgetUsd,
      env: agentEnv(this.config.env, this.config.apiKey),
      ...(resume ? {resume} : {}),
    };
    this.inbox = inbox;
    this.q = this.queryFn({prompt: inbox, options});
    this.pump(this.q, gen);
  }

  async pump(q, gen) {
    try {
      for await (const message of q) {
        if (gen !== this.gen) break;
        this.handle(message);
      }
    } catch (error) {
      if (gen === this.gen) this.emit({type: 'error', message: String(error?.message ?? error)});
    } finally {
      if (gen === this.gen) { this.q = null; this.inbox = null; this.setBusy(false); this.denyPending('Session ended'); }
    }
  }

  setBusy(busy) { if (this.busy !== busy) { this.busy = busy; this.emit({type: 'busy', busy}); } }

  handle(m) {
    if (m.type === 'system' && m.subtype === 'init') {
      this.sessionId = m.session_id;
      if (m.apiKeySource !== 'ANTHROPIC_API_KEY') {
        this.emit({type: 'error', message: `หยุดทำงาน: Claude ไม่ได้ใช้ ANTHROPIC_API_KEY (ได้ "${m.apiKeySource}") จึงอาจไม่ได้ใช้เครดิต API`});
        this.stop();
        return;
      }
      this.emit({type: 'init', sessionId: m.session_id, model: m.model, cwd: m.cwd, mode: m.permissionMode});
      return;
    }
    // Subagent traffic is summarised by its Task/Agent tool call and result.
    if (m.parent_tool_use_id) return;
    if (m.type === 'stream_event') {
      const e = m.event;
      if (e.type === 'message_start') this.liveId = e.message.id;
      else if (e.type === 'content_block_delta' && e.delta.type === 'text_delta') this.emit({type: 'delta', id: this.liveId, text: e.delta.text});
      return;
    }
    if (m.type === 'assistant') {
      // On an API error the CLI's text is a synthetic copy of the error; show ours once.
      if (m.error) { this.turnError = true; this.emit({type: 'error', message: API_ERRORS[m.error] ?? `API error: ${m.error}`}); return; }
      for (const block of m.message.content ?? []) {
        if (block.type === 'text' && block.text) this.emit({type: 'text', id: m.message.id, text: block.text});
        else if (block.type === 'tool_use') this.emit({type: 'tool', id: block.id, name: block.name, ...summarizeTool(block.name, block.input ?? {}, this.config.cwd)});
      }
      return;
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const block of m.message.content) {
        if (block.type === 'tool_result') this.emit({type: 'tool_result', id: block.tool_use_id, isError: !!block.is_error, text: clip(resultText(block.content), 4000)});
      }
      return;
    }
    if (m.type === 'result') {
      this.cost = m.total_cost_usd ?? this.cost;
      this.emit({type: 'result', subtype: m.subtype, isError: m.is_error, cost: this.cost, durationMs: m.duration_ms, turns: m.num_turns, errors: m.errors ?? [], text: m.subtype === 'success' && m.is_error && !this.turnError ? m.result : undefined});
      this.turnError = false;
      if (!(m.queued_turn_count > 0)) this.setBusy(false);
      // The per-run cap stops this run; the next message resumes the same
      // conversation as a new run with a fresh allowance.
      if (m.subtype === 'error_max_budget_usd') this.stop();
    }
  }

  ask(gen, name, input, {signal, suggestions, title}) {
    if (gen !== this.gen) return Promise.resolve({behavior: 'deny', message: 'Session ended'});
    return new Promise(resolve => {
      const id = randomUUID();
      const finish = (result) => {
        if (!this.pending.delete(id)) return;
        signal?.removeEventListener('abort', onAbort);
        this.emit({type: 'permission_done', id, allow: result.behavior === 'allow'});
        resolve(result);
      };
      const onAbort = () => finish({behavior: 'deny', message: 'Cancelled'});
      signal?.addEventListener('abort', onAbort, {once: true});
      // "Always" is scoped to this session; never written to settings files.
      const always = suggestions?.length ? suggestions.map(s => ({...s, destination: 'session'})) : null;
      this.pending.set(id, {finish, input, always});
      this.emit({type: 'permission', id, name, title: title ?? name, canAlways: !!always, ...summarizeTool(name, input, this.config.cwd)});
    });
  }

  answer(id, {allow, always}) {
    const p = this.pending.get(id);
    if (!p) return false;
    p.finish(allow ? {behavior: 'allow', updatedInput: p.input, ...(always && p.always ? {updatedPermissions: p.always} : {})}
      : {behavior: 'deny', message: 'The user declined this action. Ask what they would like instead.'});
    return true;
  }

  denyPending(message) { for (const p of [...this.pending.values()]) p.finish({behavior: 'deny', message}); }

  send(text) {
    if (!this.q) this.start(this.sessionId);
    this.emit({type: 'user', text});
    this.inbox.push({type: 'user', message: {role: 'user', content: text}, parent_tool_use_id: null});
    this.setBusy(true);
  }

  async interrupt() {
    this.denyPending('Interrupted by the user');
    if (this.q) await this.q.interrupt().catch(() => {});
  }

  stop() {
    const q = this.q;
    this.gen++; this.q = null; this.inbox?.close(); this.inbox = null;
    this.denyPending('Session ended');
    this.setBusy(false);
    q?.close();
  }

  async setModel(model) {
    if (!MODELS.some(m => m.id === model)) throw Object.assign(new Error('Unknown model'), {status: 400});
    this.model = model;
    if (this.q) await this.q.setModel(model);
    this.emit({type: 'model', model});
  }

  async setMode(mode) {
    if (!MODES.includes(mode)) throw Object.assign(new Error('Unknown mode'), {status: 400});
    this.mode = mode;
    if (this.q) await this.q.setPermissionMode(mode);
    this.emit({type: 'mode', mode});
  }

  reset() {
    this.stop();
    this.events = []; this.sessionId = null; this.cost = 0;
    this.emit({type: 'reset'});
  }

  async sessions() {
    const list = await this.listSessionsFn({dir: this.config.cwd, limit: 30});
    return list.map(s => ({sessionId: s.sessionId, title: s.customTitle || s.summary || s.firstPrompt || s.sessionId, lastModified: s.lastModified, gitBranch: s.gitBranch ?? null}));
  }

  async resume(sessionId) {
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) throw Object.assign(new Error('Invalid session'), {status: 400});
    const history = await this.getSessionMessagesFn(sessionId, {dir: this.config.cwd});
    this.reset();
    this.sessionId = sessionId;
    for (const entry of history) {
      if (entry.parent_tool_use_id) continue;
      const content = entry.message?.content;
      if (entry.type === 'user') {
        const text = typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b.type === 'text').map(b => b.text).join('\n') : '';
        if (text.trim()) this.emit({type: 'user', text, history: true});
      } else if (entry.type === 'assistant' && Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text' && block.text) this.emit({type: 'text', id: entry.message.id ?? entry.uuid, text: block.text, history: true});
          else if (block.type === 'tool_use') this.emit({type: 'tool', id: block.id, name: block.name, history: true, ...summarizeTool(block.name, block.input ?? {}, this.config.cwd)});
        }
      }
    }
    this.emit({type: 'resumed', sessionId});
  }
}
