import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const publicFile = name => fs.readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const profiles = [
  { id: 'main', label: 'Main', bot_slot_index: 1 },
  { id: 'existing', label: 'Existing', bot_slot_index: 3 }
];
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });

function setup(t, { max = 3, bots = profiles, language = 'en' } = {}) {
  const dom = new JSDOM(publicFile('index.html'), { url: 'https://robot.test', runScripts: 'outside-only' });
  const w = dom.window, d = w.document, calls = [];
  t.after(() => w.close());
  w.localStorage.setItem('robotLanguage', language);
  let quota = { bots, maxBots: max };
  let post = async () => response({ id: 'new', label: 'Bot 2', bot_slot_index: 2 }, 201);
  w.fetch = async (path, options) => {
    calls.push({ path, options });
    if (path === '/api/bots' && options.method === 'POST') return post();
    if (path === '/api/bots') return response(quota);
    if (path.startsWith('/api/bot/session?')) return response({ state: path.includes('existing') ? 'PAUSED' : 'SETUP', run_id: null });
    throw new Error('Unexpected API call: ' + path);
  };
  w.eval(publicFile('i18n.js') + '\n' + publicFile('app.js') + '\n' + publicFile('bots.js') + `
    me = { user: { id: 'main' }, risk: { paperTrading: true }, paperAccounts: [] };
    selectedBot = 'existing';
    botProfiles = ${JSON.stringify(bots)};
    window.fixture = {
      refresh: refreshBots,
      render: renderBots,
      authenticate: () => { authenticated = true; csrfToken = 'fixture-csrf'; },
      all: () => { selectedBot = 'all'; renderBots(); },
      selected: () => selectedBot,
      sessions: () => JSON.stringify(botSessions),
      policy: () => JSON.stringify(me.risk),
      click: button => $('#botSlots').onclick({ target: button })
    };
  `);
  w.fixture.authenticate();
  return {
    w, d, calls,
    quota: value => { quota = value; },
    post: callback => { post = callback; },
    create: () => d.querySelector('[data-bot-create]'),
    posts: () => calls.filter(call => call.options.method === 'POST')
  };
}

test('quota remains unavailable until authenticated response, including missing quota', async t => {
  const h = setup(t);
  h.w.fixture.render();
  assert.equal(h.create().disabled, true);
  assert.match(h.d.querySelector('#botSlots').textContent, /Bot capacity unavailable/);
  await h.w.fixture.click(h.create());
  assert.equal(h.calls.length, 0);
  h.quota({ bots: profiles });
  await h.w.fixture.refresh();
  assert.equal(h.create().disabled, true);
  assert.match(h.d.querySelector('#botSlots').textContent, /Bot capacity unavailable/);
});

for (const max of [0, 2]) {
  test(`quota ${max} disables creation with explicit capacity and limit`, async t => {
    const h = setup(t, { max });
    await h.w.fixture.refresh();
    assert.equal(h.create().disabled, true);
    assert.match(h.d.querySelector('#botSlots').textContent, new RegExp(`0 of ${max} bot slots available`));
    assert.match(h.d.querySelector('#botSlots').textContent, /Bot limit reached/);
    await h.w.fixture.click(h.create());
    assert.equal(h.posts().length, 0);
  });
}

test('available capacity creates only a label through normal authenticated API and preserves selection/policy/session', async t => {
  const h = setup(t);
  await h.w.fixture.refresh();
  assert.equal(h.create().disabled, false);
  assert.match(h.d.querySelector('#botSlots').textContent, /1 of 3 bot slots available/);
  const policy = h.w.fixture.policy();
  const oldSession = JSON.parse(h.w.fixture.sessions()).existing;
  h.post(async () => {
    h.quota({ bots: [...profiles, { id: 'new', label: 'Bot 2', bot_slot_index: 2 }], maxBots: 3 });
    return response({ id: 'new' }, 201);
  });
  await h.w.fixture.click(h.create());
  assert.equal(h.posts().length, 1);
  const request = h.posts()[0];
  assert.equal(request.path, '/api/bots');
  assert.deepEqual(JSON.parse(request.options.body), { label: 'Bot 2' });
  assert.equal(request.options.credentials, 'same-origin');
  assert.equal(request.options.headers['x-csrf-token'], 'fixture-csrf');
  assert.equal(h.w.fixture.selected(), 'existing');
  assert.equal(h.d.querySelector('#botSwitcher').value, 'existing');
  assert.ok(h.d.querySelector('[data-bot-card="existing"]'));
  assert.equal(h.w.fixture.policy(), policy);
  assert.deepEqual(JSON.parse(h.w.fixture.sessions()).existing, oldSession);
  assert.equal(JSON.parse(h.w.fixture.sessions()).new.state, 'SETUP');
  assert.equal(h.d.querySelector('#botSwitcher').options.length, 4);
  assert.equal(h.create().disabled, true);
  assert.equal(h.calls.some(call => /run|risk|webhook|deploy|broker/.test(call.path)), false);
});

test('pending request blocks duplicate dispatch through old and newly rendered buttons', async t => {
  const h = setup(t);
  await h.w.fixture.refresh();
  let finish;
  h.post(() => new Promise(resolve => { finish = resolve; }));
  const old = h.create();
  const creating = h.w.fixture.click(old);
  assert.equal(h.create().disabled, true);
  assert.equal(h.create().textContent, 'Creating Bot…');
  h.w.fixture.render();
  await h.w.fixture.click(h.create());
  await h.w.fixture.click(old);
  assert.equal(h.posts().length, 1);
  h.quota({ bots: [...profiles, { id: 'new', bot_slot_index: 2, label: 'Bot 2' }], maxBots: 3 });
  finish(response({ id: 'new' }, 201));
  await creating;
  assert.equal(h.create().textContent, 'Create Bot');
  assert.equal(h.create().disabled, true);
});

test('stale server quota rejection remains visible and refresh disables creation', async t => {
  const h = setup(t);
  await h.w.fixture.refresh();
  const message = 'Bot limit reached. Your FREE plan allows up to 1 bots.';
  h.post(async () => {
    h.quota({ bots: profiles, maxBots: 1 });
    return response({ error: message }, 403);
  });
  await h.w.fixture.click(h.create());
  assert.equal(h.d.querySelector('#botMessage').textContent, message);
  assert.equal(h.create().disabled, true);
  assert.equal(h.w.fixture.selected(), 'existing');
  assert.equal(h.posts().length, 1);
});

test('failed creation shows error, preserves old bot and allows deliberate retry', async t => {
  const h = setup(t);
  await h.w.fixture.refresh();
  h.post(async () => response({ error: 'Create unavailable' }, 500));
  await h.w.fixture.click(h.create());
  assert.equal(h.d.querySelector('#botMessage').textContent, 'Create unavailable');
  assert.equal(h.create().disabled, false);
  assert.equal(h.w.fixture.selected(), 'existing');
  assert.ok(h.d.querySelector('[data-bot-card="existing"]'));
  assert.equal(h.posts().length, 1);
});

test('Thai create/capacity labels render; All Bots remains read-only even for detached create control', async t => {
  const h = setup(t, { language: 'th' });
  await h.w.fixture.refresh();
  assert.equal(h.create().textContent, 'สร้าง Bot');
  assert.match(h.d.querySelector('#botSlots').textContent, /เหลือ 1 จาก 3 ช่อง Bot/);
  const detached = h.create();
  h.w.fixture.all();
  assert.equal(h.create(), null);
  await h.w.fixture.click(detached);
  assert.equal(h.posts().length, 0);
  assert.ok(h.d.querySelector('.all-bots-readonly-badge'));
});
