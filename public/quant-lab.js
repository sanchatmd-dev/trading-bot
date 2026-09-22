/* Offline Quant Lab UI. It only calls the loopback research bridge through /api/quant. */
const q = id => document.getElementById(id);
const qNum = id => q(id).value;
const qStatus = (text, type = 'info') => { q('qlStatus').textContent = text; q('qlStatus').className = `ql-status ${type}`; };
const qRequest = async (path, body) => api(path, {method: 'POST', body: JSON.stringify(body)});
function qMetrics(summary) {
  const values = [['Trades', summary.total_trades], ['Win rate', `${Number(summary.win_rate).toFixed(1)}%`], ['Net profit', summary.net_profit], ['Profit factor', summary.profit_factor ?? '—'], ['Max drawdown', summary.max_drawdown], ['Expectancy', summary.expectancy], ['Fees', summary.fee_impact]];
  const target = q('qlSummaryGrid'); target.hidden = false;
  target.innerHTML = values.map(([label, value]) => `<article class="metric ql-metric"><span>${label}</span><strong>${value}</strong></article>`).join('');
}
function qCurve(rows) {
  const box = q('qlEquityCurve'); box.hidden = false;
  const values = rows.map(row => Number(row.mtm)); const low = Math.min(...values), range = Math.max(...values) - low || 1;
  const points = values.map((value, index) => `${(index / Math.max(values.length - 1, 1) * 800).toFixed(1)},${(170 - ((value - low) / range * 150)).toFixed(1)}`).join(' ');
  const positive = values.at(-1) >= values[0];
  box.innerHTML = `<svg viewBox="0 0 800 180" width="100%" height="180" role="img" aria-label="Mark-to-market equity curve"><polyline points="${points}" fill="none" stroke="${positive ? '#35e0b1' : '#ff7187'}" stroke-width="3"/></svg>`;
}
async function qBacktest() {
  const button = q('qlBacktest'); button.disabled = true; qStatus('Running offline synthetic backtest…');
  try {
    const result = await qRequest('/api/quant/backtest', {params: {ema_fast: qNum('qlEmaFast'), ema_slow: qNum('qlEmaSlow'), atr_period: qNum('qlAtrPeriod'), atr_multiplier: qNum('qlAtrMult')}, config: {num_candles: qNum('qlCandles'), starting_balance: qNum('qlBalance')}});
    qMetrics(result.summary); qCurve(result.equity_curve); qStatus(`Backtest complete: ${result.num_candles} synthetic candles.`, 'ok');
  } catch (error) { qStatus(error.message, 'err'); } finally { button.disabled = false; }
}
async function qOptimize() {
  const button = q('qlOptimize'); button.disabled = true; qStatus('Running constrained optimization…');
  try {
    const result = await qRequest('/api/quant/optimize', {bounds: {ema_fast_min: qNum('qlFastMin'), ema_fast_max: qNum('qlFastMax'), ema_slow_min: qNum('qlSlowMin'), ema_slow_max: qNum('qlSlowMax')}, config: {num_candles: qNum('qlOptCandles'), max_candidates: qNum('qlCandidates')}});
    const target = q('qlOptResults'); target.hidden = false;
    target.innerHTML = result.best ? `<h3>Best candidate</h3><p>EMA ${result.best.params.ema_fast}/${result.best.params.ema_slow} · ATR ${result.best.params.atr_period} × ${result.best.params.atr_multiplier}</p><p>Train ${result.best.train_score} · Validation ${result.best.validation_score} · Out-of-sample ${result.best.test_score}</p>` : '<p>No candidate passed every validation gate.</p>';
    qStatus(`Optimization complete: ${result.total_evaluated} candidates.`, 'ok');
  } catch (error) { qStatus(error.message, 'err'); } finally { button.disabled = false; }
}
async function qRiskPreview() {
  const button = q('qlRisk'); button.disabled = true; qStatus('Computing risk preview…');
  try {
    const result = await qRequest('/api/quant/risk-preview', {input: {balance: qNum('qlRiskBalance'), max_risk_percent: qNum('qlRiskMax'), requested_risk_percent: qNum('qlRiskRequested'), max_order_notional: qNum('qlRiskOrder'), max_daily_notional: qNum('qlRiskDaily'), reference_price: qNum('qlRiskPrice')}});
    const fields = [['Order notional', result.effective_order_notional], ['Quantity', result.effective_quantity], ['Consumed capital', result.consumed_capital], ['Free capital', result.free_capital], ['Position capacity', result.position_capacity], ['Daily trade capacity', result.daily_trades_capacity]];
    const target = q('qlRiskResults'); target.hidden = false; target.innerHTML = fields.map(([label, value]) => `<div class="ql-rp-item"><span>${label}</span><strong>${value}</strong></div>`).join('');
    qStatus('Risk preview complete. It does not authorize an order.', 'ok');
  } catch (error) { qStatus(error.message, 'err'); } finally { button.disabled = false; }
}
function initQuantLab() {
  q('qlBacktest').onclick = qBacktest; q('qlOptimize').onclick = qOptimize; q('qlRisk').onclick = qRiskPreview;
  document.querySelectorAll('[data-ql-tab]').forEach(tab => tab.onclick = () => { document.querySelectorAll('[data-ql-tab]').forEach(item => item.classList.toggle('active', item === tab)); document.querySelectorAll('[data-ql-panel]').forEach(item => item.hidden = item.dataset.qlPanel !== tab.dataset.qlTab); });
  document.querySelector('[data-view="quant"]').addEventListener('click', async () => { try { const health = await api('/api/quant/health'); qStatus(`Quant engine ready · ${health.mode}`, 'ok'); } catch { qStatus('Quant engine offline. Research functions are unavailable.', 'err'); } });
}
initQuantLab();
