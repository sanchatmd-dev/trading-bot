import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {JSDOM} from 'jsdom';

const source = fs.readFileSync(new URL('../public/quant-lab.js', import.meta.url), 'utf8');
const fixtureSource = source.replace(/\binitQuantLab\(\);\s*$/, '') + '\nglobalThis.fixtureLoadHistory = qLoadHistory;';

function setup(t, response) {
  const dom = new JSDOM('<select id="qlOptBotId"><option value="bot-1">Bot</option></select><table><tbody id="qlRunHistoryRows"></tbody></table>', {runScripts: 'outside-only'});
  t.after(() => dom.window.close());
  const context = dom.getInternalVMContext(), calls = [], errors = [];
  context.api = async (path, options) => {
    calls.push({path, options});
    assert.match(path, /^\/api\/quant\/runs\?bot_id=/);
    assert.ok(!options || !options.method || options.method === 'GET');
    return typeof response === 'function' ? response() : response;
  };
  context.console = {error: (...args) => errors.push(args)};
  vm.runInContext(fixtureSource, context);
  return {d: dom.window.document, calls, errors, load: () => context.fixtureLoadHistory(), rows: () => [...dom.window.document.querySelectorAll('#qlRunHistoryRows tr')].map(row => [...row.cells].map(cell => cell.textContent))};
}

test('history renders legacy array and stored whole-body indicators without changing metrics or completed styling', async t => {
  const h = setup(t, [
    {run_id: 'legacy', indicators_config: [{name: 'EMA'}, {name: 'ATR'}], status: 'COMPLETED', metrics: {train_score: 1.25, test_score: 2.5}},
    {run_id: 'body', indicators_config: {bot_id: 'bot-1', indicators: [{name: 'Nested EMA'}, 'Named indicator'], unrelated: 'ignored'}, status: 'RUNNING', metrics: null}
  ]);
  await h.load();
  assert.deepEqual(h.rows(), [['legacy', 'EMA, ATR', 'COMPLETED', '1.25', '2.5'], ['body', 'Nested EMA, Named indicator', 'RUNNING', '-', '-']]);
  assert.equal(h.d.querySelectorAll('.passed').length, 1);
  assert.equal(h.errors.length, 0);
  assert.equal(h.calls.length, 1);
});

for (const [label, config] of [['missing', undefined], ['null', null], ['string', 'not JSON'], ['number', 9], ['unknown object', {source: 'do not infer'}], ['nested nonarray', {indicators: {name: 'wrong'}}], ['empty array', []], ['invalid entries', [null, 8, {}, {name: 7}, {name: ' '}]]]) {
  test(`history config ${label} uses explicit unavailable fallback`, async t => {
    const h = setup(t, [{run_id: 'run', indicators_config: config, status: 'FAILED'}]);
    await h.load();
    assert.deepEqual(h.rows(), [['run', 'Unavailable', 'FAILED', '-', '-']]);
    assert.equal(h.errors.length, 0);
  });
}

test('malformed rows and indicator entries preserve neighboring valid rows', async t => {
  const h = setup(t, [null, 5, 'bad', [], {run_id: 'first', indicators_config: [null, {name: 'First'}, {name: {}}, 'Second'], status: 'FAILED'}, {}, {run_id: 'last', indicators_config: {indicators: [{name: 'Last'}]}, status: 'COMPLETED'}]);
  await h.load();
  assert.deepEqual(h.rows(), [['first', 'First, Second', 'FAILED', '-', '-'], ['—', 'Unavailable', '—', '-', '-'], ['last', 'Last', 'COMPLETED', '-', '-']]);
  assert.equal(h.errors.length, 0);
});

test('every untrusted text cell stays inert and malformed metrics do not invent values', async t => {
  const payload = '<img src=x onerror="globalThis.injected=true"><script>globalThis.injected=true</script>&"';
  const h = setup(t, [{run_id: payload, indicators_config: [{name: payload}], status: payload, metrics: {train_score: payload, test_score: {valueOf: 'bad'}}}]);
  await h.load();
  assert.deepEqual(h.rows(), [[payload, payload, payload, '—', '—']]);
  assert.equal(h.d.querySelectorAll('img, script, [onerror]').length, 0);
  assert.equal(h.d.querySelectorAll('.passed').length, 0);
  assert.equal(h.errors.length, 0);
});

test('unknown ID/status shapes and metric null/boolean/array remain safe placeholders', async t => {
  const h = setup(t, [
    {run_id: {toString: 'bad'}, status: [], indicators_config: [{name: 'Known'}], metrics: {train_score: null, test_score: true}},
    {run_id: 12, status: 'FAILED', indicators_config: ['Known'], metrics: []}
  ]);
  await h.load();
  assert.deepEqual(h.rows(), [['—', 'Known', '—', '—', '—'], ['12', 'Known', 'FAILED', '—', '—']]);
  assert.equal(h.errors.length, 0);
});

for (const response of [null, undefined, {}, {runs: []}, 'wrong', [null, 5, []]]) {
  test(`malformed response ${JSON.stringify(response)} shows unavailable without throwing`, async t => {
    const h = setup(t, response);
    await h.load();
    assert.deepEqual(h.rows(), [['History unavailable.']]);
    assert.equal(h.d.querySelector('td').colSpan, 5);
  });
}

test('empty history clears prior rows', async t => {
  const h = setup(t, []);
  h.d.querySelector('#qlRunHistoryRows').innerHTML = '<tr><td>stale</td></tr>';
  await h.load();
  assert.deepEqual(h.rows(), []);
});

test('network failure clears stale rows and displays only static safe text', async t => {
  const h = setup(t, () => { throw Error('<img src=x onerror=alert(1)>'); });
  h.d.querySelector('#qlRunHistoryRows').innerHTML = '<tr><td>stale</td></tr>';
  await h.load();
  assert.deepEqual(h.rows(), [['History unavailable.']]);
  assert.equal(h.d.querySelectorAll('img, script, [onerror]').length, 0);
  assert.equal(h.errors.length, 1);
  assert.deepEqual(h.calls.map(call => call.options), [undefined]);
});

test('history fetch remains read-only and encodes selected bot ID', async t => {
  const h = setup(t, []);
  h.d.querySelector('option').value = 'bot&other=value';
  await h.load();
  assert.deepEqual(h.calls, [{path: '/api/quant/runs?bot_id=bot%26other%3Dvalue', options: undefined}]);
  h.d.querySelector('select').value = '';
  await h.load();
  assert.equal(h.calls.length, 1);
});
