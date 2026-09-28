import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {JSDOM} from 'jsdom';

const html = fs.readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const script = fs.readFileSync(new URL('../public/quant-lab.js', import.meta.url), 'utf8');
const capability = {enabled: true, version: 'spot-ingestion-v1', broker: 'binance-global', symbol: 'BTCUSDT', market: 'SPOT', timeframe: '1', max_total_bars: 10000, max_page_bars: 1000, raw_only: true, verified_execution_profile: false};
const tick = () => new Promise(resolve => setImmediate(resolve));

function page(handler) {
  const dom = new JSDOM(html, {url: 'http://localhost/', runScripts: 'outside-only'});
  const calls = [];
  dom.window.api = async (path, options = {}) => { calls.push({path, options}); return handler(path, options); };
  dom.window.eval(script);
  const get = id => dom.window.document.getElementById(id);
  const set = (id, value) => { get(id).value = value; get(id).dispatchEvent(new dom.window.Event('input', {bubbles: true})); };
  return {dom, calls, get, set};
}

async function ready(ui, enabled = true) {
  ui.dom.window.api = async (path, options = {}) => {
    ui.calls.push({path, options});
    if (path === '/api/bots') return {bots: [{id: 'bot-1', label: 'Paper bot'}]};
    if (path === '/api/quant/data/capability') return {...capability, enabled};
    throw new Error(`Unexpected ${path}`);
  };
  await ui.dom.window.qDataLoadBots();
  await ui.dom.window.qDataLoadCapability();
  ui.set('qlDataBot', 'bot-1');
  ui.set('qlDataStart', '2024-01-01T00:00');
  ui.set('qlDataEnd', '2024-01-01T01:00');
}

test('UTC inputs become epoch milliseconds; preview invalidates after input or bot change', async () => {
  const ui = page(() => ({}));
  await ready(ui);
  let previewCalls = 0;
  ui.dom.window.api = async (path, options = {}) => {
    ui.calls.push({path, options});
    if (path !== '/api/quant/data/range-preview') throw new Error('Unexpected request');
    previewCalls++;
    const body = JSON.parse(options.body);
    assert.equal(body.start_time, Date.UTC(2024, 0, 1, 0));
    assert.equal(body.end_time, Date.UTC(2024, 0, 1, 1));
    assert.equal(body.bot_id, 'bot-1');
    return {capability, request: {...body, cutoff: Date.UTC(2024, 0, 2)}, plan: {evaluation_bars: 60, warmup_bars: 0, total_bars: 60, page_count: 1, evaluation_start: body.start_time, evaluation_end: body.end_time, metadata: {start_time: body.start_time}}};
  };
  assert.equal(ui.get('qlDataPreview').disabled, false);
  await ui.dom.window.qDataPreviewRange();
  assert.equal(previewCalls, 1);
  assert.equal(ui.get('qlDataQueue').disabled, false);
  assert.match(ui.get('qlDataInterval').textContent, /UTC.*end exclusive/);
  ui.set('qlDataWarmup', '10');
  assert.equal(ui.get('qlDataQueue').disabled, true);
  assert.equal(ui.get('qlDataPlan').hidden, true);
  ui.set('qlDataBot', '');
  assert.equal(ui.get('qlDataPreview').disabled, true);
  ui.dom.window.close();
});

test('disabled capability, invalid UTC, and over 10K including warmup never submit', async () => {
  const ui = page(() => ({}));
  await ready(ui, false);
  assert.equal(ui.get('qlDataPreview').disabled, true);
  await ui.dom.window.qDataPreviewRange();
  assert.equal(ui.calls.some(call => call.path === '/api/quant/data/range-preview'), false);
  ui.dom.window.api = async path => {
    if (path === '/api/quant/data/capability') return capability;
    throw new Error(`Unexpected ${path}`);
  };
  await ui.dom.window.qDataLoadCapability();
  ui.set('qlDataStart', '2024-02-30T00:00');
  assert.match(ui.get('qlDataValidation').textContent, /valid UTC/);
  ui.set('qlDataStart', '2024-01-01T00:00');
  ui.set('qlDataEnd', '2024-01-08T00:00');
  assert.match(ui.get('qlDataValidation').textContent, /exceeds the 10,000 bar cap/);
  assert.equal(ui.get('qlDataPreview').disabled, true);
  await ui.dom.window.qDataQueue();
  assert.equal(ui.calls.some(call => call.path === '/api/quant/data/jobs'), false);
  ui.dom.window.close();
});

test('preview errors leave fetch disabled and show server message', async () => {
  const ui = page(() => ({}));
  await ready(ui);
  ui.dom.window.api = async () => { throw new Error('Range unavailable'); };
  await ui.dom.window.qDataPreviewRange();
  assert.equal(ui.get('qlDataQueue').disabled, true);
  assert.match(ui.get('qlDataStatus').textContent, /Range unavailable/);
  ui.dom.window.close();
});

test('period preview reports exact UTC bars, never queues over limit or All Available', async () => {
  const ui=page(() => ({}));await ready(ui);
  ui.set('qlDataPeriod','1W');
  ui.dom.window.api=async (path,options={})=>{
    ui.calls.push({path,options});
    assert.equal(path,'/api/quant/data/period-preview');
    const body=JSON.parse(options.body);
    assert.equal(body.timezone,'UTC');assert.equal(body.period,'1W');
    return {period:'1W',start_time:Date.UTC(2023,11,25,1),end_time:body.end_time,evaluation_bars:10080,warmup_bars:0,total_bars:10080,admission:'OVER_RAW_LIMIT'};
  };
  await ui.dom.window.qDataPreviewPeriod();
  assert.match(ui.get('qlDataPeriodResult').textContent,/10,080.*shorten period/);
  assert.equal(ui.get('qlDataQueue').disabled,true);
  assert.equal(ui.get('qlDataStart').value,'2024-01-01T00:00');
  ui.set('qlDataPeriod','ALL_AVAILABLE');
  ui.dom.window.api=async()=>{throw new Error('AVAILABLE_HISTORY_UNVERIFIED');};
  await ui.dom.window.qDataPreviewPeriod();
  assert.match(ui.get('qlDataPeriodResult').textContent,/verified venue history/);
  ui.dom.window.close();
});

test('period responses and errors cannot overwrite inputs changed during the request', async () => {
  const ui=page(()=>({}));await ready(ui);
  let resolve,reject;
  ui.dom.window.api=()=>new Promise((yes,no)=>{resolve=yes;reject=no;});
  const pending=ui.dom.window.qDataPreviewPeriod();
  ui.set('qlDataWarmup','25');
  resolve({start_time:Date.UTC(2024,0,1),end_time:Date.UTC(2024,0,1,1),
    evaluation_bars:60,warmup_bars:0,total_bars:60,admission:'WITHIN_RAW_LIMIT'});
  await pending;
  assert.equal(ui.get('qlDataPeriodResult').textContent,'Choose a period and end UTC.');
  const failed=ui.dom.window.qDataPreviewPeriod();
  ui.set('qlDataPeriod','1W');reject(new Error('stale error'));
  await failed;
  assert.equal(ui.get('qlDataPeriodResult').textContent,'Choose a period and end UTC.');
  assert.equal(ui.get('qlDataQueue').disabled,true);
  ui.dom.window.close();
});

test('repeated Data opens and hide/show keep one status request active; stale reply is ignored', async () => {
  const pending = [];
  let active = 0, maximumActive = 0, statusCalls = 0;
  const ui = page((path) => {
    if (path === '/api/bots') return {bots: [{id: 'bot-1', label: 'Paper bot'}]};
    if (path === '/api/quant/data/capability') return capability;
    if (path.startsWith('/api/quant/data/jobs/')) {
      statusCalls++; active++; maximumActive = Math.max(maximumActive, active);
      return new Promise(resolve => pending.push(value => { active--; resolve(value); }));
    }
    throw new Error(`Unexpected ${path}`);
  });
  const document = ui.dom.window.document;
  let hidden = false;
  Object.defineProperty(document, 'hidden', {configurable: true, get: () => hidden});
  document.querySelector('[data-page="quant"]').hidden = false;
  ui.get('qlPanelData').hidden = false;
  ui.dom.window.qDataRenderJob({job_id: 'job-1', status: 'QUEUED', next_bar: 0, total_bars: 60});
  ui.dom.window.qDataOpen();
  ui.dom.window.qDataOpen();
  assert.equal(statusCalls, 1);
  hidden = true;
  document.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
  hidden = false;
  document.dispatchEvent(new ui.dom.window.Event('visibilitychange'));
  ui.dom.window.qDataOpen();
  assert.equal(statusCalls, 1);
  pending.shift()({job_id: 'job-1', status: 'RUNNING', next_bar: 59, total_bars: 60});
  await tick();
  assert.equal(statusCalls, 2);
  assert.match(ui.get('qlDataProgress').textContent, /0 \/ 60/);
  pending.shift()({job_id: 'job-1', status: 'SUCCEEDED', next_bar: 60, total_bars: 60, result: {dataset_ref: 'fixture-ref'}});
  await tick();
  assert.equal(maximumActive, 1);
  assert.match(ui.get('qlDataResult').textContent, /fixture-ref/);
  ui.dom.window.close();
});
