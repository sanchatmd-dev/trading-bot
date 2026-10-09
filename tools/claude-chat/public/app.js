const $ = id => document.getElementById(id);
const log = $('log'), input = $('input');
const storage = {
  get: () => { try { return localStorage.getItem('claude-chat-token'); } catch { return null; } },
  set: value => { try { localStorage.setItem('claude-chat-token', value); } catch {} },
};

let token = null, lastSeq = 0, epoch = null;
let assistants = new Map(), tools = new Map(), asks = new Map();

function readToken() {
  const match = location.hash.match(/token=([^&]+)/);
  if (match) {
    token = decodeURIComponent(match[1]); storage.set(token);
    history.replaceState(null, '', location.pathname);
  } else token = storage.get();
}

function showLogin() { if (!$('login').open) $('login').showModal(); }
$('login-form').addEventListener('submit', event => {
  event.preventDefault();
  const raw = $('login-link').value.trim(), match = raw.match(/token=([^&\s]+)/);
  storage.set(match ? decodeURIComponent(match[1]) : raw);
  location.reload();
});

async function api(path, body) {
  const res = await fetch(path, {
    method: body ? 'POST' : 'GET',
    headers: {'x-chat-token': token ?? '', ...(body ? {'content-type': 'application/json'} : {})},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { showLogin(); throw new Error('ต้องเชื่อมต่อใหม่'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// --- Minimal Markdown: input is escaped first, so only the tags added here render.
const esc = s => s.replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const inline = s => esc(s)
  .replace(/`([^`]+)`/g, '<code>$1</code>')
  .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
const LIST = /^\s*([-*]|\d+\.)\s+/;
const cells = line => line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
function markdown(md) {
  const lines = md.split('\n'), out = [];
  for (let i = 0; i < lines.length;) {
    const line = lines[i];
    if (/^```/.test(line)) {
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      i++; out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.*)$/);
    if (heading) { const level = Math.min(4, heading[1].length + 1); out.push(`<h${level}>${inline(heading[2])}</h${level}>`); i++; continue; }
    if (/^\s*\|/.test(line) && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? '')) {
      const head = cells(line), rows = [];
      for (i += 2; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(cells(lines[i]));
      out.push(`<table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    if (LIST.test(line)) {
      const tag = /^\s*\d+\./.test(line) ? 'ol' : 'ul', items = [];
      while (i < lines.length && LIST.test(lines[i])) items.push(lines[i++].replace(LIST, ''));
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`); continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^```|^#{1,4}\s|^\s*\|/.test(lines[i]) && !LIST.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${para.map(inline).join('<br>')}</p>`);
  }
  return out.join('');
}

// --- Rendering
function el(tag, cls, text) { const node = document.createElement(tag); if (cls) node.className = cls; if (text !== undefined) node.textContent = text; return node; }
function append(node) {
  const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  $('empty').hidden = true; log.append(node);
  if (stick) log.scrollTop = log.scrollHeight;
}
function clearLog() {
  for (const node of [...log.children]) if (node.id !== 'empty') node.remove();
  $('empty').hidden = false; assistants = new Map(); tools = new Map(); asks = new Map();
  setCost(0);
}
function setCost(cost) { $('cost').textContent = '$' + Number(cost || 0).toFixed(cost >= 10 ? 2 : 4); }
function setBusy(busy) { $('status').hidden = !busy; $('stop').hidden = !busy; }
function note(text, error) { append(el('div', 'note' + (error ? ' error' : ''), text)); }

let frame = 0;
const dirty = new Set();
function paint(entry) {
  dirty.add(entry);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
    for (const a of dirty) a.bubble.innerHTML = markdown(a.final + (a.final && a.live ? '\n\n' : '') + a.live);
    dirty.clear();
    if (stick) log.scrollTop = log.scrollHeight;
  });
}
function assistant(id, history) {
  let entry = assistants.get(id);
  if (!entry) {
    const node = el('article', 'msg assistant' + (history ? ' history' : ''));
    entry = {bubble: el('div', 'bubble'), final: '', live: ''};
    node.append(entry.bubble); append(node); assistants.set(id, entry);
  }
  return entry;
}
const TOOL_NAMES = {Bash: 'รันคำสั่ง', Read: 'อ่านไฟล์', Edit: 'แก้ไฟล์', Write: 'เขียนไฟล์', Grep: 'ค้นหา', Glob: 'หาไฟล์', WebFetch: 'เปิดเว็บ', WebSearch: 'ค้นเว็บ', TodoWrite: 'รายการงาน', Task: 'งานย่อย', Agent: 'งานย่อย', ExitPlanMode: 'แผนงาน'};

function addTool(e) {
  const node = el('details', 'tool'), head = el('summary');
  head.append(el('span', 'name', TOOL_NAMES[e.name] ?? e.name), el('span', 'target', e.summary || ''), el('span', 'state', e.history ? '' : '…'));
  node.append(head);
  if (e.detail) node.append(el('pre', '', e.detail));
  tools.set(e.id, node); append(node);
}
function toolResult(e) {
  const node = tools.get(e.id); if (!node) return;
  node.querySelector('.state').textContent = e.isError ? 'ผิดพลาด' : '✓';
  node.classList.toggle('error', e.isError);
  if (e.text) node.append(el('pre', '', e.text));
}

function addAsk(e) {
  const node = el('section', 'ask');
  node.append(el('div', 'title', `${TOOL_NAMES[e.name] ?? e.name} — ขออนุญาต`));
  if (e.title && e.title !== e.name) node.append(el('div', 'muted', e.title));
  if (e.summary) node.append(el('pre', '', e.summary));
  if (e.detail) node.append(el('pre', '', e.detail));
  const actions = el('div', 'actions');
  const choose = (allow, always) => api('/api/permission', {id: e.id, allow, always}).catch(err => note(err.message, true));
  const yes = el('button', '', 'อนุญาต'), always = el('button', 'ghost', 'อนุญาตเสมอในแชทนี้'), no = el('button', 'ghost', 'ไม่อนุญาต');
  yes.onclick = () => choose(true, false); always.onclick = () => choose(true, true); no.onclick = () => choose(false, false);
  actions.append(yes, ...(e.canAlways ? [always] : []), no);
  node.append(actions); asks.set(e.id, node); append(node);
}
function askDone(e) {
  const node = asks.get(e.id); if (!node) return;
  node.classList.add('done'); node.querySelector('.actions').replaceWith(el('div', 'verdict', e.allow ? 'อนุญาตแล้ว' : 'ไม่อนุญาต'));
}

function seconds(ms) { return ms >= 60000 ? `${Math.floor(ms / 60000)} นาที ${Math.round(ms % 60000 / 1000)} วิ` : `${(ms / 1000).toFixed(1)} วิ`; }
const RESULT = {
  error_max_budget_usd: 'ถึงเพดานงบต่อรอบ (CHAT_MAX_BUDGET_USD) แล้ว — ส่งข้อความต่อเพื่อทำต่อในแชทเดิมด้วยงบรอบใหม่',
  error_max_turns: 'ถึงจำนวนรอบสูงสุด',
  error_during_execution: 'หยุดระหว่างทำงาน',
};

function handle(e) {
  if (e.seq) lastSeq = e.seq;
  switch (e.type) {
    case 'hello': if (e.epoch !== epoch) { clearLog(); epoch = e.epoch; } break;
    case 'reset': clearLog(); break;
    case 'user': { const node = el('article', 'msg user' + (e.history ? ' history' : '')); node.append(el('div', 'bubble', e.text)); append(node); break; }
    case 'delta': { const a = assistant(e.id); a.live += e.text; paint(a); break; }
    case 'text': { const a = assistant(e.id, e.history); a.final += (a.final ? '\n\n' : '') + e.text; a.live = ''; paint(a); break; }
    case 'tool': addTool(e); break;
    case 'tool_result': toolResult(e); break;
    case 'permission': addAsk(e); break;
    case 'permission_done': askDone(e); break;
    case 'busy': setBusy(e.busy); break;
    case 'init': $('repo').textContent = e.cwd; break;
    case 'model': $('model').value = e.model; break;
    case 'mode': $('mode').value = e.mode; break;
    case 'resumed': note('โหลดแชทเดิมแล้ว — พิมพ์ต่อได้เลย'); break;
    case 'error': note(e.message, true); break;
    case 'result':
      setCost(e.cost);
      if (e.text) note(e.text, true);
      if (RESULT[e.subtype]) note(RESULT[e.subtype], e.subtype !== 'error_during_execution');
      for (const err of e.errors ?? []) note(err, true);
      note(`เสร็จ · ${seconds(e.durationMs ?? 0)} · รวมแชทนี้ ~$${Number(e.cost || 0).toFixed(4)}`);
      break;
  }
}

async function listen() {
  for (;;) {
    try {
      const res = await fetch(`/api/events?after=${lastSeq}&epoch=${encodeURIComponent(epoch ?? '')}`, {headers: {'x-chat-token': token ?? ''}});
      if (res.status === 401) { showLogin(); return; }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = '';
      for (;;) {
        const {value, done} = await reader.read();
        if (done) break;
        buffer += value;
        for (let i; (i = buffer.indexOf('\n')) >= 0;) {
          const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
          if (line) handle(JSON.parse(line));
        }
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 1500));
  }
}

// --- Controls
function grow() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, innerHeight * 0.4) + 'px'; }
input.addEventListener('input', grow);
input.addEventListener('keydown', event => {
  const touch = matchMedia('(pointer: coarse)').matches;
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && !touch) { event.preventDefault(); $('send-form').requestSubmit(); }
});
$('send-form').addEventListener('submit', async event => {
  event.preventDefault();
  const text = input.value.trim(); if (!text) return;
  $('send').disabled = true;
  try { await api('/api/send', {text}); input.value = ''; grow(); }
  catch (err) { note(err.message, true); }
  finally { $('send').disabled = false; input.focus(); }
});
$('stop').addEventListener('click', () => api('/api/interrupt', {}).catch(err => note(err.message, true)));
$('new').addEventListener('click', () => {
  if (log.querySelector('.msg') && !confirm('เริ่มแชทใหม่? แชทนี้ยังเปิดต่อได้จาก “ประวัติ”')) return;
  api('/api/new', {}).catch(err => note(err.message, true));
});
$('model').addEventListener('change', () => api('/api/model', {model: $('model').value}).catch(err => note(err.message, true)));
$('mode').addEventListener('change', () => api('/api/mode', {mode: $('mode').value}).catch(err => note(err.message, true)));
$('history').addEventListener('click', async () => {
  const list = $('session-list'); list.replaceChildren(el('li', 'muted', 'กำลังโหลด…'));
  $('sessions').showModal();
  try {
    const sessions = await api('/api/sessions');
    list.replaceChildren(...(sessions.length ? sessions.map(s => {
      const item = el('li'), button = el('button', '');
      button.type = 'button';
      button.append(el('span', '', s.title.slice(0, 120)), el('span', 'muted', `${new Date(s.lastModified).toLocaleString('th-TH')}${s.gitBranch ? ' · ' + s.gitBranch : ''}`));
      button.onclick = async () => { $('sessions').close(); try { await api('/api/resume', {sessionId: s.sessionId}); } catch (err) { note(err.message, true); } };
      item.append(button); return item;
    }) : [el('li', 'muted', 'ยังไม่มีแชทก่อนหน้า')]));
  } catch (err) { list.replaceChildren(el('li', 'muted', err.message)); }
});

// Pasting the link into an open tab only changes the hash; reload to pick it up.
addEventListener('hashchange', () => { if (/token=/.test(location.hash)) location.reload(); });

async function init() {
  readToken();
  if (!token) { showLogin(); return; }
  try {
    const state = await api('/api/state');
    $('model').replaceChildren(...state.models.map(m => { const o = el('option', '', m.label); o.value = m.id; return o; }));
    $('model').value = state.model; $('mode').value = state.mode; $('repo').textContent = state.cwd;
    setCost(state.cost); setBusy(state.busy);
  } catch { return; }
  if (!matchMedia('(pointer: coarse)').matches) input.placeholder += ' (Enter ส่ง, Shift+Enter ขึ้นบรรทัดใหม่)';
  listen();
  input.focus();
}
init();
