import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const publicFile = name => fs.readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

function setup(t, paperAccounts, language = 'en') {
  const dom = new JSDOM(publicFile('index.html'), { url: 'https://robot.test', runScripts: 'outside-only' });
  const w = dom.window, d = w.document;
  t.after(() => w.close());
  w.localStorage.setItem('robotLanguage', language);
  w.eval(publicFile('i18n.js') + '\n' + publicFile('app.js') + '\n' + publicFile('bots.js') + `
    me = { user: { id: 'main' }, risk: { paperTrading: true }, paperAccounts: ${JSON.stringify(paperAccounts)}, dailyAccounts: [] };
    window.fixture = { card: renderAllBotsCard };
  `);
  w.fixture.card();
  const lines = () => [...d.querySelectorAll('.all-bots-stat .all-bots-equity')].map(n => n.textContent);
  return { d, lines, text: () => d.querySelector('.all-bots-stat').textContent };
}

test('All Bots card: USDT and THB Bots give separate totals, never one summed number', t => {
  const h = setup(t, [
    { bot_id: 'a', currency: 'USDT', bookEquity: '1000.5', configuredEquity: '1000' },
    { bot_id: 'b', currency: 'USDT', bookEquity: '2000', configuredEquity: '2000' },
    { bot_id: 'c', currency: 'THB', bookEquity: '35000', configuredEquity: '35000' }
  ]);
  assert.deepEqual(h.lines(), ['3,000.5 USDT', '35,000 THB']);
  assert.ok(!h.text().includes('38,000.5'), 'no cross-currency sum');
  assert.match(h.d.querySelector('.all-bots-stat span').textContent, /^Book equity by currency$/);
});

test('All Bots card: single currency keeps the same total', t => {
  const h = setup(t, [
    { bot_id: 'a', currency: 'USDT', bookEquity: '1000.5', configuredEquity: '1000' },
    { bot_id: 'b', currency: 'USDT', bookEquity: '2000', configuredEquity: '2000' },
    { bot_id: 'b', currency: 'THB', bookEquity: '0', configuredEquity: '0' }
  ]);
  assert.deepEqual(h.lines(), ['3,000.5 USDT']);
});

test('All Bots card: missing or invalid equity never renders NaN', t => {
  const h = setup(t, [
    { bot_id: 'a', currency: 'USDT' },
    { bot_id: 'b', currency: 'THB', bookEquity: 'abc' },
    { bot_id: 'c', currency: 'USDT', bookEquity: null, configuredEquity: '100' }
  ]);
  assert.ok(!/NaN/.test(h.text()));
  assert.deepEqual(h.lines(), ['—']);
  const none = setup(t, []);
  assert.deepEqual(none.lines(), ['—']);
  const mixed = setup(t, [{ bot_id: 'a', currency: 'USDT', bookEquity: '5', configuredEquity: '5' }, { bot_id: 'b', currency: 'THB' }]);
  assert.deepEqual(mixed.lines(), ['5 USDT']);
});

test('All Bots card: Thai label for the relabelled stat', t => {
  const h = setup(t, [{ bot_id: 'a', currency: 'USDT', bookEquity: '10', configuredEquity: '10' }], 'th');
  assert.match(h.d.querySelector('.all-bots-stat span').textContent, /Book equity แยกตามสกุลเงิน/);
});
