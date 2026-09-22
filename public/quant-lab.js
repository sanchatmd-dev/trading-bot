/* Offline Quant Lab: a research UI only. All calculations come from /api/quant. */
const q = id => document.getElementById(id);
const qNum = id => Number(q(id).value);
const qText = value => String(value ?? '—');
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
function qParams(params, candles, balance) { q('qlRunParameters').innerHTML = [`EMA ${qText(params.ema_fast)} / ${qText(params.ema_slow)}`, `ATR ${qText(params.atr_period)} × ${qText(params.atr_multiplier)}`, `${qFixed(candles, 0)} candles`, `${qMoney(balance)} start`].map(value => `<span class="ql-pill">${value}</span>`).join(''); }
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
  
  container.innerHTML = qIndicators.map((ind, i) => `
    <fieldset class="ql-fieldset">
      <legend>Indicator ${i+1}: ${ind.name} <button type="button" class="mini danger" onclick="qRemoveIndicator(${i})">X</button></legend>
      ${ind.params.map((p, j) => `
        <div class="ql-input-pair" style="margin-bottom: 8px;">
          <label>${p.name} Min <input type="number" value="${p.min}" onchange="qUpdateParam(${i},${j},'min',this.value)" ${isMulti?'disabled':''}></label>
          <label>Max <input type="number" value="${p.max}" onchange="qUpdateParam(${i},${j},'max',this.value)" ${isMulti?'disabled':''}></label>
        </div>
      `).join('')}
    </fieldset>
  `).join('');
}

window.qRemoveIndicator = (i) => { qIndicators.splice(i, 1); qRenderIndicators(); };
window.qUpdateParam = (i, j, key, val) => { qIndicators[i].params[j][key] = Number(val); };

function qCandidateRow(candidate, index) { 
  const p = candidate.params || {}, status = candidate.status || (candidate.passed_stress && candidate.stability_ok ? 'passed' : 'rejected'); 
  return `<tr><td>${index + 1}</td><td><pre style="margin:0;font-size:11px">${JSON.stringify(p, null, 2)}</pre></td><td>${qFixed(candidate.train_score)}</td><td>${qFixed(candidate.validation_score)}</td><td>${qFixed(candidate.test_score)}</td><td><span class="ql-candidate-status ${status === 'passed' ? 'passed' : ''}">${status}</span></td></tr>`; 
}

function qShowOptimizer(result) {
  const best = result.best, candidates = Array.isArray(result.candidates) ? result.candidates : [], split = result.dataset_split || {};
  const intro = best ? `<section class="ql-best-params"><div><span class="ql-mini-label">Best validated candidate</span><pre>${JSON.stringify(best.params, null, 2)}</pre><p>Train ${qFixed(best.train_score)} · validation ${qFixed(best.validation_score)} · test ${qFixed(best.test_score)}</p></div><span class="ql-candidate-status passed">passed</span></section>` : '<p class="ql-empty-state">No candidate passed every validation gate. Adjust bounds or budget and run again.</p>';
  const table = candidates.length ? `<div class="table-wrap ql-candidate-table"><table><thead><tr><th>#</th><th>Parameters</th><th>Train</th><th>Validation</th><th>Test</th><th>Gate</th></tr></thead><tbody>${candidates.map(qCandidateRow).join('')}</tbody></table></div>` : '';
  q('qlOptResults').innerHTML = `${intro}${table}<p class="ql-split-info">Dataset split: <strong>${qText(split.train_end)}</strong> train · <strong>${qText(split.validation_end)}</strong> validation · <strong>${qText(split.test_end)}</strong> test</p>`;
}

async function qLoadHistory() {
  const botId = q('qlOptBotId').value;
  if (!botId) return;
  try {
    const runs = await api(`/api/quant/runs?bot_id=${botId}`);
    q('qlRunHistoryRows').innerHTML = runs.map(r => `
      <tr>
        <td style="font-size:11px">${r.run_id}</td>
        <td style="font-size:11px">${r.indicators_config.map(i=>i.name||'Ind').join(', ')}</td>
        <td><span class="ql-candidate-status ${r.status==='COMPLETED'?'passed':''}">${r.status}</span></td>
        <td>${r.metrics ? qFixed(r.metrics.train_score) : '-'}</td>
        <td>${r.metrics ? qFixed(r.metrics.test_score) : '-'}</td>
      </tr>
    `).join('');
  } catch (e) {
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
  const rules = Array.isArray(result.active_limiting_rules) ? result.active_limiting_rules : []; q('qlRiskConstraints').hidden = false; q('qlRiskConstraints').innerHTML = `<span class="ql-mini-label">Active constraints</span>${(rules.length ? rules : ['No active constraint']).map(rule => `<span class="ql-pill warn">${qText(rule)}</span>`).join('')}`;
}
async function qRiskPreview() {
  const button = q('qlRisk'); qSetBusy(button, true, 'Computing…'); qStatus('Computing risk preview…');
  try { const input = {balance: qNum('qlRiskBalance'), max_risk_percent: qNum('qlRiskMax'), requested_risk_percent: qNum('qlRiskRequested'), max_order_notional: qNum('qlRiskOrder'), max_daily_notional: qNum('qlRiskDaily'), reference_price: qNum('qlRiskPrice')}; if (!Object.values(input).every(value => Number.isFinite(value) && value > 0)) throw new Error('All risk inputs must be positive.'); const result = await api('/api/quant/risk-preview', {method: 'POST', body: JSON.stringify({input})}); qShowRisk(result); q('qlRiskMeta').textContent = `Computed · ${qDate()}`; qStatus('Risk preview complete. It does not authorize an order.', 'ok'); } catch (error) { qStatus(error.message || 'Risk preview unavailable.', 'err'); } finally { qSetBusy(button, false); }
}
function qSetTab(tab) { document.querySelectorAll('[data-ql-tab]').forEach(item => { const active = item === tab; item.classList.toggle('active', active); item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1; }); document.querySelectorAll('[data-ql-panel]').forEach(item => { item.hidden = item.dataset.qlPanel !== tab.dataset.qlTab; }); }
async function initQuantLab() {
  ['qlBacktest', 'qlOptimize', 'qlRisk'].forEach(id => q(id).dataset.label = q(id).textContent); q('qlBacktest').addEventListener('click', qBacktest); q('qlOptimize').addEventListener('click', qOptimize); q('qlRisk').addEventListener('click', qRiskPreview);
  q('qlResetBacktest').addEventListener('click', () => { Object.entries({qlEmaFast: 10, qlEmaSlow: 30, qlAtrPeriod: 14, qlAtrMult: 2, qlCandles: 2000, qlBalance: 10000}).forEach(([id, value]) => { q(id).value = value; }); qBacktestValid(); });
  document.querySelectorAll('[data-ql-tab]').forEach(tab => tab.addEventListener('click', () => qSetTab(tab))); document.querySelectorAll('[data-ql-basis]').forEach(button => button.addEventListener('click', () => { qBasis = button.dataset.qlBasis; document.querySelectorAll('[data-ql-basis]').forEach(item => { const active = item === button; item.classList.toggle('active', active); item.setAttribute('aria-pressed', String(active)); }); qDrawCurve(); }));
  ['qlEmaFast', 'qlEmaSlow', 'qlAtrPeriod', 'qlAtrMult', 'qlCandles', 'qlBalance'].forEach(id => q(id).addEventListener('input', qBacktestValid));
  
  q('qlAddIndicator').addEventListener('click', () => {
    qIndicators.push({ name: 'CustomIndicator', params: [{name: 'param1', min: 10, max: 20, default: 15, step: 1, unit: 'bars', optimizable: true, locked: false}] });
    qRenderIndicators();
  });
  
  document.querySelector('[data-view="quant"]').addEventListener('click', async () => { 
    try { const health = await api('/api/quant/health'); q('qlEngineStatus').textContent = `Ready · ${health.mode}`; q('qlEngineStatus').className = 'ql-engine-state ready'; qStatus(`Quant engine ready · ${health.mode}`, 'ok'); } catch { q('qlEngineStatus').textContent = 'Offline'; q('qlEngineStatus').className = 'ql-engine-state offline'; qStatus('Quant engine offline. Research functions are unavailable.', 'err'); }
    
    // Load bots for selector
    try {
        const bots = await api('/api/bots');
        q('qlOptBotId').innerHTML = bots.bots.map(b => `<option value="${b.id}">${b.label}</option>`).join('');
        qLoadHistory();
    } catch(e) {}
  });
  
  q('qlOptBotId').addEventListener('change', qLoadHistory);
  qRenderIndicators();
}
initQuantLab();
