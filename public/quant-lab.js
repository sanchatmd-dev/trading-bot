/* Offline Quant Lab: a research UI only. All calculations come from /api/quant. */
const q = id => document.getElementById(id);
const qNum = id => Number(q(id).value);
// Values placed into innerHTML templates are escaped; server and user text never becomes markup.
const qEsc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'})[c]);
const qMoney = value => Number.isFinite(Number(value)) ? `${Number(value).toLocaleString(undefined, {maximumFractionDigits: 2})} USDT` : '—';
const qFixed = (value, digits = 2) => Number.isFinite(Number(value)) ? Number(value).toLocaleString(undefined, {maximumFractionDigits: digits}) : '—';
const qDate = () => new Intl.DateTimeFormat(undefined, {dateStyle: 'medium', timeStyle: 'short'}).format(new Date());
let qLastCurve = [];
let qBasis = 'mtm';

function qStatus(text, type = 'info') { q('qlStatus').textContent = text; q('qlStatus').className = `ql-status ${type}`; }
function qSetBusy(button, busy, label) { button.disabled = busy; button.classList.toggle('is-running', busy); button.textContent = busy ? label : button.dataset.label; }
function qSetValidation(id, message = '') { const node = q(id); node.hidden = !message; node.textContent = message; return !message; }
function qBacktestValid() {
  const fast = qNum('qlEmaFast'), slow = qNum('qlEmaSlow');
  const valid = [fast, slow, qNum('qlAtrPeriod'), qNum('qlAtrMult'), qNum('qlCandles'), qNum('qlBalance')].every(Number.isFinite) && fast >= 1 && slow > fast && qNum('qlAtrPeriod') >= 1 && qNum('qlAtrMult') > 0 && qNum('qlCandles') >= 30 && qNum('qlBalance') > 0;
  return qSetValidation('qlBacktestValidation', valid ? '' : 'EMA slow must exceed EMA fast; all values must be positive.') && valid;
}
function qOptimizeValid() {
  const fastMin = qNum('qlFastMin'), fastMax = qNum('qlFastMax'), slowMin = qNum('qlSlowMin'), slowMax = qNum('qlSlowMax');
  const valid = [fastMin, fastMax, slowMin, slowMax, qNum('qlOptCandles'), qNum('qlCandidates')].every(Number.isFinite) && fastMin >= 1 && fastMax >= fastMin && slowMin > fastMax && slowMax >= slowMin && qNum('qlOptCandles') >= 30 && qNum('qlCandidates') >= 1;
  return qSetValidation('qlOptimizeValidation', valid ? '' : 'Fast range must stay below slow range. Check all bounds.') && valid;
}
function qMetric(label, value, detail, tone = '') { return `<article class="ql-metric ${tone}"><span>${label}</span><strong>${value}</strong><small>${detail}</small></article>`; }
function qShowMetrics(summary) {
  const profit = Number(summary.net_profit), drawdown = Number(summary.max_drawdown_percent), wins = Number(summary.wins) || 0, losses = Number(summary.losses) || 0;
  q('qlSummaryGrid').innerHTML = [qMetric('Net profit', qMoney(profit), `${profit >= 0 ? '+' : ''}${qFixed((profit / Math.max(1, qNum('qlBalance'))) * 100)}% on starting balance`, profit >= 0 ? 'positive' : 'negative'), qMetric('Max drawdown', `${qFixed(drawdown)}%`, `${qMoney(summary.max_drawdown)} peak to trough`, 'negative'), qMetric('Win rate', `${qFixed(summary.win_rate, 1)}%`, `${wins} wins · ${losses} losses`), qMetric('Total trades', qFixed(summary.total_trades, 0), `PF ${qFixed(summary.profit_factor)} · fees ${qMoney(summary.fee_impact)}`)].join('');
}
function qDrawCurve() {
  const chart = q('qlEquityCurve'); if (!qLastCurve.length) return;
  const values = qLastCurve.map(row => Number(row[qBasis])).filter(Number.isFinite); if (!values.length) return;
  const width = 860, height = 250, pad = {left: 58, right: 18, top: 16, bottom: 34}, low = Math.min(...values), high = Math.max(...values), range = high - low || 1;
  const x = index => pad.left + index / Math.max(values.length - 1, 1) * (width - pad.left - pad.right), y = value => pad.top + (high - value) / range * (height - pad.top - pad.bottom);
  const points = values.map((value, index) => `${x(index).toFixed(1)},${y(value).toFixed(1)}`).join(' '), positive = values.at(-1) >= values[0];
  const ticks = [0, .5, 1].map(ratio => { const value = high - range * ratio, py = pad.top + (height - pad.top - pad.bottom) * ratio; return `<g><line x1="${pad.left}" x2="${width - pad.right}" y1="${py}" y2="${py}"/><text x="4" y="${py + 4}">${qFixed(value, 0)}</text></g>`; }).join('');
  chart.setAttribute('aria-label', `${qBasis === 'mtm' ? 'Mark-to-market' : 'Book'} equity curve. Start ${qMoney(values[0])}; end ${qMoney(values.at(-1))}.`);
  chart.innerHTML = `<svg viewBox="0 0 ${width} ${height}" width="100%" height="250" role="img"><g class="ql-chart-grid">${ticks}</g><polyline class="ql-curve ${positive ? 'positive' : 'negative'}" points="${points}"/><text class="ql-axis-label" x="${pad.left}" y="${height - 8}">Start</text><text class="ql-axis-label" x="${width - pad.right - 24}" y="${height - 8}">End</text></svg>`;
}
function qParams(params, candles, balance) { q('qlRunParameters').innerHTML = [`EMA ${qEsc(params.ema_fast)} / ${qEsc(params.ema_slow)}`, `ATR ${qEsc(params.atr_period)} × ${qEsc(params.atr_multiplier)}`, `${qFixed(candles, 0)} candles`, `${qMoney(balance)} start`].map(value => `<span class="ql-pill">${value}</span>`).join(''); }
async function qBacktest() {
  if (!qBacktestValid()) return; const button = q('qlBacktest'); qSetBusy(button, true, 'Running research…'); qStatus('Running offline synthetic backtest…');
  const params = {ema_fast: qNum('qlEmaFast'), ema_slow: qNum('qlEmaSlow'), atr_period: qNum('qlAtrPeriod'), atr_multiplier: qNum('qlAtrMult')}, config = {num_candles: qNum('qlCandles'), starting_balance: qNum('qlBalance')};
  try { const result = await api('/api/quant/backtest', {method: 'POST', body: JSON.stringify({params, config})}); qShowMetrics(result.summary); qLastCurve = result.equity_curve || []; qDrawCurve(); qParams(params, result.num_candles, config.starting_balance); q('qlRunMeta').textContent = `Complete · ${qDate()}`; qStatus(`Backtest complete: ${result.num_candles} synthetic candles.`, 'ok'); } catch (error) { qStatus(error.message || 'Backtest unavailable.', 'err'); } finally { qSetBusy(button, false); }
}
let qIndicators = [{
  name: 'SyntheticEma',
  params: [
    { name: 'ema_fast', min: 5, max: 25, default: 10, step: 1, optimizable: true, locked: false, unit: 'bars' },
    { name: 'ema_slow', min: 30, max: 80, default: 30, step: 1, optimizable: true, locked: false, unit: 'bars' }
  ]
}];

function qRenderIndicators() {
  const container = q('qlIndicatorsList');
  const isMulti = qIndicators.length > 1;
  q('qlOptModeLabel').textContent = isMulti ? 'Multi-Indicator (Locked)' : 'Single Indicator (Optimizable)';
  
  // DOM nodes, not markup: the production CSP blocks inline handlers, and names render as text.
  // Remove and Min/Max edits reach qRemoveIndicator and qUpdateParam through the delegated listeners in initQuantLab.
  container.replaceChildren(...qIndicators.map((ind, i) => {
    const fieldset = document.createElement('fieldset'), legend = document.createElement('legend'), remove = document.createElement('button');
    fieldset.className = 'ql-fieldset';
    remove.type = 'button'; remove.className = 'mini danger'; remove.dataset.qlRemove = String(i); remove.textContent = 'X';
    legend.append(`Indicator ${i + 1}: ${String(ind.name ?? '')} `, remove);
    fieldset.append(legend);
    ind.params.forEach((p, j) => {
      const field = (text, key) => {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'number'; input.value = String(p[key]); input.dataset.qlParam = `${i}:${j}:${key}`; input.disabled = isMulti;
        label.append(text, input);
        return label;
      };
      const pair = document.createElement('div');
      pair.className = 'ql-input-pair ql-input-pair-gap';
      pair.append(field(`${String(p.name ?? '')} Min `, 'min'), field('Max ', 'max'));
      fieldset.append(pair);
    });
    return fieldset;
  }));
}

function qRemoveIndicator(i) { qIndicators.splice(i, 1); qRenderIndicators(); }
function qUpdateParam(i, j, key, val) { qIndicators[i].params[j][key] = Number(val); }

function qCandidateRow(candidate, index) { 
  const p = candidate.params || {}, status = candidate.status || (candidate.passed_stress && candidate.stability_ok ? 'passed' : 'rejected'); 
  return `<tr><td>${index + 1}</td><td><pre class="ql-param-pre">${qEsc(JSON.stringify(p, null, 2))}</pre></td><td>${qFixed(candidate.train_score)}</td><td>${qFixed(candidate.validation_score)}</td><td>${qFixed(candidate.test_score)}</td><td><span class="ql-candidate-status ${status === 'passed' ? 'passed' : ''}">${qEsc(status)}</span></td></tr>`; 
}

function qShowOptimizer(result) {
  const best = result.best, candidates = Array.isArray(result.candidates) ? result.candidates : [], split = result.dataset_split || {};
  const intro = best ? `<section class="ql-best-params"><div><span class="ql-mini-label">Best validated candidate</span><pre>${qEsc(JSON.stringify(best.params, null, 2))}</pre><p>Train ${qFixed(best.train_score)} · validation ${qFixed(best.validation_score)} · test ${qFixed(best.test_score)}</p></div><span class="ql-candidate-status passed">passed</span></section>` : '<p class="ql-empty-state">No candidate passed every validation gate. Adjust bounds or budget and run again.</p>';
  const table = candidates.length ? `<div class="table-wrap ql-candidate-table"><table><thead><tr><th>#</th><th>Parameters</th><th>Train</th><th>Validation</th><th>Test</th><th>Gate</th></tr></thead><tbody>${candidates.map(qCandidateRow).join('')}</tbody></table></div>` : '';
  q('qlOptResults').innerHTML = `${intro}${table}<p class="ql-split-info">Dataset split: <strong>${qEsc(split.train_end)}</strong> train · <strong>${qEsc(split.validation_end)}</strong> validation · <strong>${qEsc(split.test_end)}</strong> test</p>`;
}

async function qLoadHistory() {
  const botId = q('qlOptBotId').value;
  if (!botId) return;
  const rows = q('qlRunHistoryRows');
  const message = text => {
    const row = document.createElement('tr'), cell = document.createElement('td');
    cell.colSpan = 5; cell.textContent = text; row.append(cell); rows.replaceChildren(row);
  };
  const text = value => typeof value === 'string' ? value : typeof value === 'number' && Number.isFinite(value) ? String(value) : '—';
  const indicators = config => {
    const list = Array.isArray(config) ? config : config && typeof config === 'object' && Array.isArray(config.indicators) ? config.indicators : [];
    const names = list.map(item => typeof item === 'string' ? item : item && typeof item === 'object' && typeof item.name === 'string' ? item.name : '').filter(name => name.trim());
    return names.length ? names.join(', ') : 'Unavailable';
  };
  const metric = (metrics, key) => {
    if (!metrics) return '-';
    const value = typeof metrics === 'object' && !Array.isArray(metrics) ? metrics[key] : undefined;
    return (typeof value === 'number' || typeof value === 'string' && value.trim()) && Number.isFinite(Number(value)) ? qFixed(value) : '—';
  };
  try {
    const runs = await api(`/api/quant/runs?bot_id=${encodeURIComponent(botId)}`);
    if (!Array.isArray(runs)) { message('History unavailable.'); return; }
    const rendered = [];
    for (const run of runs) {
      if (!run || typeof run !== 'object' || Array.isArray(run)) continue;
      const row = document.createElement('tr');
      for (const value of [text(run.run_id), indicators(run.indicators_config)]) {
        const cell = document.createElement('td'); cell.style.fontSize = '11px'; cell.textContent = value; row.append(cell);
      }
      const statusCell = document.createElement('td'), status = document.createElement('span');
      status.className = `ql-candidate-status ${run.status === 'COMPLETED' ? 'passed' : ''}`;
      status.textContent = text(run.status); statusCell.append(status); row.append(statusCell);
      for (const value of [metric(run.metrics, 'train_score'), metric(run.metrics, 'test_score')]) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      rendered.push(row);
    }
    if (runs.length && !rendered.length) { message('History unavailable.'); return; }
    rows.replaceChildren(...rendered);
  } catch (e) {
    message('History unavailable.');
    console.error('Failed to load history', e);
  }
}

async function qOptimize() {
  const button = q('qlOptimize'); qSetBusy(button, true, 'Running sweep…'); qStatus('Running constrained optimization…');
  try { 
    const isMulti = qIndicators.length > 1;
    const payload = {
      bot_id: q('qlOptBotId').value,
      indicators: qIndicators.map(ind => ({
        name: ind.name,
        params: ind.params.map(p => ({
          name: p.name, unit: p.unit, minimum: p.min, maximum: p.max, step: p.step, default: p.default,
          optimizable: !isMulti, locked: isMulti
        }))
      })),
      sl_atr_multiplier: { minimum: qNum('qlSlAtrMin'), maximum: qNum('qlSlAtrMax'), step: 0.5, default: 2.0, optimizable: true, locked: false },
      rr_ratio: { minimum: qNum('qlRrMin'), maximum: qNum('qlRrMax'), step: 0.5, default: 1.5, optimizable: true, locked: false },
      config: { num_candles: qNum('qlOptCandles'), max_candidates: qNum('qlCandidates') }
    };
    const result = await api('/api/quant/optimize', {method: 'POST', body: JSON.stringify(payload)}); 
    qShowOptimizer(result); 
    q('qlOptMeta').textContent = `Complete · ${qFixed(result.total_evaluated, 0)} candidates`; 
    qStatus(`Optimization complete: ${result.total_evaluated} candidates.`, 'ok'); 
    qLoadHistory();
  } catch (error) { qStatus(error.message || 'Optimizer unavailable.', 'err'); } finally { qSetBusy(button, false); }
}

function qRiskItem(label, value, detail = '') { return `<article class="ql-rp-item"><span>${label}</span><strong>${value}</strong>${detail ? `<small>${detail}</small>` : ''}</article>`; }
function qShowRisk(result) {
  q('qlRiskResults').innerHTML = [qRiskItem('Order notional', qMoney(result.effective_order_notional), `${qFixed(result.effective_quantity, 8)} units`), qRiskItem('Consumed capital', qMoney(result.consumed_capital), `of ${qMoney(result.available_balance)}`), qRiskItem('Free capital', qMoney(result.free_capital)), qRiskItem('Position capacity', qFixed(result.position_capacity, 2)), qRiskItem('Daily trade capacity', qFixed(result.daily_trades_capacity, 2)), qRiskItem('Effective risk', `${qFixed(result.requested_risk_percent)}%`)].join('');
  const used = Math.max(0, Math.min(100, Number(result.consumed_capital) / Math.max(Number(result.available_balance), 1) * 100)); q('qlCapitalUse').hidden = false; q('qlCapitalUseText').textContent = `${qFixed(used, 1)}% used`; q('qlCapitalUseBar').style.width = `${used}%`;
  const rules = Array.isArray(result.active_limiting_rules) ? result.active_limiting_rules : []; q('qlRiskConstraints').hidden = false; q('qlRiskConstraints').innerHTML = `<span class="ql-mini-label">Active constraints</span>${(rules.length ? rules : ['No active constraint']).map(rule => `<span class="ql-pill warn">${qEsc(rule)}</span>`).join('')}`;
}
async function qRiskPreview() {
  const button = q('qlRisk'); qSetBusy(button, true, 'Computing…'); qStatus('Computing risk preview…');
  try { const input = {balance: qNum('qlRiskBalance'), max_risk_percent: qNum('qlRiskMax'), requested_risk_percent: qNum('qlRiskRequested'), max_order_notional: qNum('qlRiskOrder'), max_daily_notional: qNum('qlRiskDaily'), reference_price: qNum('qlRiskPrice')}; if (!Object.values(input).every(value => Number.isFinite(value) && value > 0)) throw new Error('All risk inputs must be positive.'); const result = await api('/api/quant/risk-preview', {method: 'POST', body: JSON.stringify({input})}); qShowRisk(result); q('qlRiskMeta').textContent = `Computed · ${qDate()}`; qStatus('Risk preview complete. It does not authorize an order.', 'ok'); } catch (error) { qStatus(error.message || 'Risk preview unavailable.', 'err'); } finally { qSetBusy(button, false); }
}
function qSetTab(tab) { document.querySelectorAll('[data-ql-tab]').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; }); document.querySelectorAll('[data-ql-panel]').forEach(item => { item.hidden = item.dataset.qlPanel !== tab.dataset.qlTab; }); if (tab.dataset.qlTab === 'data') qDataOpen(); else qDataStopPoll(); }

let qDataCapability = null, qDataPreview = null, qDataGeneration = 0, qDataJob = null, qDataJobBotId = '', qDataTimer = null, qDataPollCount = 0, qDataPollEpoch = 0, qDataPollInFlight = false, qDataPollResume = false, qDataKey = null, qDataBusy = false;
const qDataTerminal = status => ['COMPLETED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'CANCELED', 'TIMED_OUT'].includes(status);
const qDataVisible = () => !document.hidden && !document.querySelector('[data-page="quant"]').hidden && !q('qlPanelData').hidden;
const qDataUtc = value => {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) return NaN;
  const time = Date.parse(`${value}:00.000Z`);
  return Number.isSafeInteger(time) && new Date(time).toISOString().slice(0, 16) === value ? time : NaN;
};
const qDataTime = value => Number.isSafeInteger(value) ? `${new Date(value).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '—';
function qDataStatus(message, tone = 'info') { q('qlDataStatus').textContent = message; q('qlDataStatus').className = `ql-status ${tone}`; }
function qDataStopPoll() { qDataPollEpoch++; qDataPollResume = false; if (qDataTimer) clearTimeout(qDataTimer); qDataTimer = null; }
function qDataInput() {
  const bot_id = q('qlDataBot').value, start_time = qDataUtc(q('qlDataStart').value), end_time = qDataUtc(q('qlDataEnd').value), warmup_bars = Number(q('qlDataWarmup').value);
  const cutoff = Math.floor(Date.now() / 60000) * 60000;
  return {bot_id, start_time, end_time, warmup_bars, cutoff};
}
function qDataValidation(input = qDataInput()) {
  if (!qDataCapability?.enabled) return 'Raw history capability is unavailable.';
  if (!input.bot_id) return 'Select a bot.';
  if (!Number.isSafeInteger(input.start_time) || !Number.isSafeInteger(input.end_time)) return 'Enter valid UTC minute start and end times.';
  if (input.start_time >= input.end_time) return 'End UTC must follow start UTC.';
  if (input.end_time > input.cutoff) return 'End UTC must exclude the current open minute.';
  if (q('qlDataWarmup').value === '' || !Number.isSafeInteger(input.warmup_bars) || input.warmup_bars < 0 || input.warmup_bars > 5000) return 'Warmup bars must be an integer from 0 to 5,000.';
  if (input.start_time - input.warmup_bars * 60000 <= 0) return 'Warmup starts before supported UTC history.';
  const total = (input.end_time - input.start_time) / 60000 + input.warmup_bars;
  if (total > Math.min(10000, Number(qDataCapability.max_total_bars) || 0)) return `Requested ${total.toLocaleString()} total bars exceeds the ${qDataCapability.max_total_bars.toLocaleString()} bar cap, including warmup.`;
  return '';
}
function qDataUpdate() {
  const error = qDataValidation();
  qSetValidation('qlDataValidation', error);
  q('qlDataPreview').disabled = !!error || qDataBusy;
  q('qlDataQueue').disabled = !!error || !qDataPreview || qDataBusy || !!qDataJob && !qDataTerminal(qDataJob.status);
}
function qDataInvalidate() {
  qDataGeneration++;
  qDataPreview = null;
  qDataKey = null;
  q('qlDataPlan').hidden = true;
  q('qlDataPeriodResult').textContent = 'Choose a period and end UTC.';
  qDataUpdate();
}
function qDataRenderPlan(plan, request) {
  q('qlDataEvaluation').textContent = Number(plan.evaluation_bars).toLocaleString();
  q('qlDataWarmupCount').textContent = Number(plan.warmup_bars).toLocaleString();
  q('qlDataTotal').textContent = Number(plan.total_bars).toLocaleString();
  q('qlDataPages').textContent = Number(plan.page_count).toLocaleString();
  q('qlDataFirst').textContent = qDataTime(plan.metadata?.start_time);
  q('qlDataInterval').textContent = `${qDataTime(plan.evaluation_start)} to ${qDataTime(plan.evaluation_end)} (end exclusive)`;
  q('qlDataCutoff').textContent = `${qDataTime(request.cutoff)} (exclusive)`;
  q('qlDataPlan').hidden = false;
}
async function qDataPreviewPeriod() {
  const input=qDataInput(), period=q('qlDataPeriod').value, target=q('qlDataPeriodResult');
  qDataInvalidate();
  const generation=qDataGeneration;
  if (!qDataCapability?.enabled || !input.bot_id || !Number.isSafeInteger(input.end_time) ||
      !Number.isSafeInteger(input.warmup_bars)) {target.textContent='Select a bot, valid end UTC and warmup.';return;}
  const body={bot_id:input.bot_id,period,end_time:input.end_time,warmup_bars:input.warmup_bars,
    timezone:'UTC',...(period==='CUSTOM'?{custom_start_time:input.start_time}:{})};
  target.textContent='Checking period…';
  try {
    const result=await api('/api/quant/data/period-preview',{method:'POST',silent:true,botId:input.bot_id,body:JSON.stringify(body)});
    if (generation!==qDataGeneration) return;
    if(result.admission==='WITHIN_RAW_LIMIT'){
      q('qlDataStart').value=new Date(result.start_time).toISOString().slice(0,16);
      qDataInvalidate();
    }
    target.textContent=`${period} · ${qDataTime(result.start_time)} to ${qDataTime(result.end_time)} (end exclusive) · ${result.evaluation_bars.toLocaleString()} evaluation + ${result.warmup_bars.toLocaleString()} warmup = ${result.total_bars.toLocaleString()} bars. Available history unverified. ${result.admission==='WITHIN_RAW_LIMIT'?'Within 10,000 raw bar limit; profile remains unverified.':'Over 10,000 raw bar limit; shorten period. No automatic truncation.'}`;
  } catch(error){if(generation!==qDataGeneration)return;target.textContent=period==='ALL_AVAILABLE'?'All Available needs verified venue history and is unavailable.':error.message||'Period preview unavailable.';}
}
async function qDataLoadCapability() {
  const generation = ++qDataGeneration;
  qDataCapability = null; qDataPreview = null; q('qlDataPlan').hidden = true; qDataUpdate();
  qDataStatus('Checking raw history capability…');
  try {
    const capability = await api('/api/quant/data/capability', {silent: true, botId: ''});
    if (generation !== qDataGeneration) return;
    qDataCapability = capability;
    const profile = capability.broker === 'binance-global' && capability.symbol === 'BTCUSDT' && capability.market === 'SPOT' && capability.timeframe === '1' && capability.raw_only === true && capability.verified_execution_profile === false && capability.max_total_bars <= 10000;
    if (!profile) qDataCapability = {...capability, enabled: false};
    q('qlDataCapability').textContent = qDataCapability.enabled ? `Available · ${capability.max_total_bars.toLocaleString()} bars max` : 'Unavailable';
    const budgets=capability.planned_stage_budgets;
    q('qlDataStageBudget').textContent=budgets ? `Planned 1m stage totals, including warmup: ${Object.entries(budgets).map(([stage,limits])=>`${stage} ${limits[0].toLocaleString()}–${limits[1].toLocaleString()}`).join('; ')}. Current raw limit: ${capability.max_total_bars.toLocaleString()}; research profile unverified.` : 'Planned stage budgets do not enable research.';
    qDataStatus(qDataCapability.enabled ? 'Choose a UTC range, then preview before fetching.' : 'Raw history capability is disabled or outside supported Spot 1m profile.', qDataCapability.enabled ? 'info' : 'warn');
  } catch (error) {
    if (generation !== qDataGeneration) return;
    q('qlDataCapability').textContent = 'Unavailable';
    qDataStatus(error.message || 'Capability check failed.', 'err');
  }
  qDataUpdate();
}
async function qDataLoadBots() {
  try {
    const response = await api('/api/bots', {silent: true});
    const select = q('qlDataBot'), previous = select.value;
    select.replaceChildren(new Option('Select a bot', ''));
    for (const bot of response.bots || []) select.add(new Option(bot.label, bot.id));
    select.value = [...select.options].some(option => option.value === previous) ? previous : '';
    qDataInvalidate();
  } catch (error) { qDataStatus(error.message || 'Bot list unavailable.', 'err'); }
}
async function qDataPreviewRange() {
  const input = qDataInput(), error = qDataValidation(input);
  if (error) { qDataUpdate(); return; }
  const generation = ++qDataGeneration;
  qDataBusy = true; qDataUpdate(); qDataStatus('Checking exact range…');
  try {
    const result = await api('/api/quant/data/range-preview', {method: 'POST', silent: true, botId: input.bot_id, body: JSON.stringify({bot_id: input.bot_id, start_time: input.start_time, end_time: input.end_time, warmup_bars: input.warmup_bars})});
    if (generation !== qDataGeneration) return;
    if (!result.capability?.enabled || result.plan?.total_bars > 10000 || result.plan?.total_bars > result.capability.max_total_bars || result.request?.bot_id !== input.bot_id) throw new Error('Server preview does not match the supported range.');
    qDataPreview = result;
    qDataKey = null;
    qDataRenderPlan(result.plan, result.request);
    qDataStatus('Range preview ready. Fetch starts only when you choose Fetch raw history.', 'ok');
  } catch (failure) {
    if (generation === qDataGeneration) { qDataPreview = null; q('qlDataPlan').hidden = true; qDataStatus(failure.message || 'Range preview failed.', 'err'); }
  } finally { qDataBusy = false; qDataUpdate(); }
}
function qDataRenderJob(job) {
  qDataJob = job; q('qlDataJob').hidden = false;
  const complete = qDataTerminal(job.status);
  q('qlDataProgress').textContent = `${job.status || 'UNKNOWN'} · ${Number(job.next_bar) || 0} / ${Number(job.total_bars) || 0} bars${job.diagnostic ? ` · ${typeof job.diagnostic === 'string' ? job.diagnostic : JSON.stringify(job.diagnostic)}` : ''}`;
  q('qlDataCancel').disabled = complete;
  q('qlDataResult').textContent = ['COMPLETED', 'SUCCEEDED'].includes(job.status) ? `Raw dataset ready: ${JSON.stringify(job.result || {})}` : '';
  qDataStatus(complete ? `Raw history job ${job.status.toLowerCase()}.` : 'Raw history fetch in progress.', ['FAILED', 'CANCELLED', 'CANCELED', 'TIMED_OUT'].includes(job.status) ? 'err' : complete ? 'ok' : 'info');
  qDataUpdate();
  if (complete) qDataStopPoll();
  if(job.status==='SUCCEEDED'&&job.job_id)qDataLoadProfileReadiness(job.job_id,qDataJobBotId);
}
async function qDataLoadProfileReadiness(id,botId){
  try{
    const result=await api(`/api/quant/data/jobs/${encodeURIComponent(id)}/profile-readiness`,{silent:true,botId});
    if(qDataJob?.job_id===id)q('qlDataProfile').textContent=result.enrollment_ready?'Verified research profile ready.':`Research profile unavailable: ${(result.blockers||[]).join(', ')}. Raw history remains separate.`;
  }catch(error){if(qDataJob?.job_id===id)q('qlDataProfile').textContent=error.message||'Research profile status unavailable.';}
}
async function qDataPoll() {
  if (!qDataJob?.job_id || !qDataVisible() || qDataTerminal(qDataJob.status)) return;
  if (qDataPollInFlight) { qDataPollResume = true; return; }
  if (qDataTimer || qDataPollCount >= 30) return;
  const id = qDataJob.job_id, epoch = qDataPollEpoch;
  qDataPollInFlight = true; qDataPollCount++;
  try {
    const job = await api(`/api/quant/data/jobs/${encodeURIComponent(id)}`, {silent: true, botId: qDataJobBotId});
    if (epoch === qDataPollEpoch && qDataJob?.job_id === id && qDataVisible()) qDataRenderJob(job);
  } catch (error) {
    if (epoch === qDataPollEpoch && qDataJob?.job_id === id && qDataVisible()) { qDataStatus(error.message || 'Job status unavailable.', 'err'); qDataStopPoll(); }
  } finally {
    qDataPollInFlight = false;
    if (epoch !== qDataPollEpoch) {
      if (qDataPollResume && qDataVisible()) { qDataPollResume = false; qDataPoll(); }
    } else {
      qDataPollResume = false;
      if (qDataVisible() && qDataJob?.job_id === id && !qDataTerminal(qDataJob.status) && qDataPollCount < 30) {
        qDataTimer = setTimeout(() => { qDataTimer = null; qDataPoll(); }, 2000);
      }
    }
  }
}
async function qDataQueue() {
  if (!qDataPreview || qDataValidation() || qDataBusy) return;
  qDataBusy = true; qDataUpdate();
  qDataKey ||= crypto.randomUUID();
  const preview = qDataPreview;
  try {
    const job = await api('/api/quant/data/jobs', {method: 'POST', silent: true, botId: preview.request.bot_id, headers: {'Idempotency-Key': qDataKey}, body: JSON.stringify(preview.request)});
    qDataJobBotId = preview.request.bot_id; qDataRenderJob(job); qDataPollCount = 0; qDataPoll();
  } catch (error) { qDataStatus(`${error.message || 'Fetch request failed.'} Retry keeps the same request key.`, 'err'); }
  finally { qDataBusy = false; qDataUpdate(); }
}
async function qDataCancel() {
  if (!qDataJob?.job_id || q('qlDataCancel').disabled) return;
  q('qlDataCancel').disabled = true;
  try { qDataRenderJob(await api(`/api/quant/data/jobs/${encodeURIComponent(qDataJob.job_id)}/cancel`, {method: 'POST', silent: true, botId: qDataJobBotId})); }
  catch (error) { qDataStatus(error.message || 'Cancel failed.', 'err'); q('qlDataCancel').disabled = false; }
}
function qDataOpen() { qDataLoadBots().then(qDataLoadCapability); if (qDataJob && !qDataTerminal(qDataJob.status) && qDataVisible()) { if (!qDataPollInFlight && !qDataTimer && qDataPollCount >= 30) qDataPollCount = 0; qDataPoll(); } }
async function initQuantLab() {
  ['qlBacktest', 'qlOptimize', 'qlRisk'].forEach(id => q(id).dataset.label = q(id).textContent); q('qlBacktest').addEventListener('click', qBacktest); q('qlOptimize').addEventListener('click', qOptimize); q('qlRisk').addEventListener('click', qRiskPreview);
  q('qlResetBacktest').addEventListener('click', () => { Object.entries({qlEmaFast: 10, qlEmaSlow: 30, qlAtrPeriod: 14, qlAtrMult: 2, qlCandles: 2000, qlBalance: 10000}).forEach(([id, value]) => { q(id).value = value; }); qBacktestValid(); });
  document.querySelectorAll('[data-ql-tab]').forEach(tab => tab.addEventListener('click', () => qSetTab(tab))); document.querySelectorAll('[data-ql-basis]').forEach(button => button.addEventListener('click', () => { qBasis = button.dataset.qlBasis; document.querySelectorAll('[data-ql-basis]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); qDrawCurve(); }));
  ['qlEmaFast', 'qlEmaSlow', 'qlAtrPeriod', 'qlAtrMult', 'qlCandles', 'qlBalance'].forEach(id => q(id).addEventListener('input', qBacktestValid));
  ['qlDataBot', 'qlDataStart', 'qlDataEnd', 'qlDataWarmup', 'qlDataPeriod'].forEach(id => { q(id).addEventListener('input', qDataInvalidate); q(id).addEventListener('change', qDataInvalidate); });
  q('qlDataPreview').addEventListener('click', qDataPreviewRange);
  q('qlDataPeriodPreview').addEventListener('click', qDataPreviewPeriod);
  q('qlDataQueue').addEventListener('click', qDataQueue);
  q('qlDataCancel').addEventListener('click', qDataCancel);
  document.querySelectorAll('[data-view]').forEach(button => { if (button.dataset.view !== 'quant') button.addEventListener('click', qDataStopPoll); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) qDataStopPoll(); else if (qDataVisible() && qDataJob && !qDataTerminal(qDataJob.status)) { qDataPollCount = 0; qDataPoll(); } });
  
  q('qlIndicatorsList').addEventListener('click', event => { const button = event.target.closest('[data-ql-remove]'); if (button) qRemoveIndicator(Number(button.dataset.qlRemove)); });
  q('qlIndicatorsList').addEventListener('change', event => { const input = event.target.closest('[data-ql-param]'); if (!input) return; const [i, j, key] = input.dataset.qlParam.split(':'); qUpdateParam(Number(i), Number(j), key, input.value); });
  q('qlAddIndicator').addEventListener('click', () => {
    qIndicators.push({ name: 'CustomIndicator', params: [{name: 'param1', min: 10, max: 20, default: 15, step: 1, unit: 'bars', optimizable: true, locked: false}] });
    qRenderIndicators();
  });
  
  document.querySelector('[data-view="quant"]').addEventListener('click', async () => { 
    if (!q('qlPanelData').hidden) qDataOpen();
    try { const health = await api('/api/quant/health'); q('qlEngineStatus').textContent = `Ready · ${health.mode}`; q('qlEngineStatus').className = 'ql-engine-state ready'; qStatus(`Synthetic research engine ready · ${health.mode}. Data capability is checked separately.`, 'ok'); } catch { q('qlEngineStatus').textContent = 'Offline'; q('qlEngineStatus').className = 'ql-engine-state offline'; qStatus('Synthetic backtest and optimizer unavailable. Data capability is checked separately.', 'warn'); }
    
    // Load bots for selector
    try {
        const bots = await api('/api/bots');
        // Bot labels are user text: options are built as nodes, never as markup.
        q('qlOptBotId').replaceChildren(...bots.bots.map(b => { const option = document.createElement('option'); option.value = String(b.id); option.textContent = String(b.label ?? b.id); return option; }));
        qLoadHistory();
    } catch(e) {}
  });
  
  q('qlOptBotId').addEventListener('change', qLoadHistory);
  qRenderIndicators();
}
initQuantLab();
