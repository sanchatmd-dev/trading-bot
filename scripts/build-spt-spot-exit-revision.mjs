// Prepare a private, source-bound research revision. Never installs a Bridge or alert.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {canonical, executable, hash, inspectSource} from '../src/pine-bridge/source.js';
import {SOURCE_HASH} from '../src/quant-research/contract.js';

const [requestPath, outputPath] = process.argv.slice(2);
const privateRoot = path.resolve('.qa-local') + path.sep;
assert.ok([requestPath, outputPath].every(p => p && path.resolve(p).startsWith(privateRoot)), 'Private paths required');
assert.ok(outputPath.endsWith('.pine'), 'Pine output required');
const {request} = JSON.parse(await fs.readFile(requestPath, 'utf8'));
const contract = request.contract;
const original = contract.source;
assert.equal(hash(original), SOURCE_HASH);
const inspected = inspectSource(original);
const values = Object.fromEntries([
  ...contract.snapshot.selection.fixed_inputs,
  ...contract.snapshot.selection.bindings,
].map(row => [row.pine_variable, row.effective_value]));
assert.equal(inspected.inputs.length, 58);
assert.equal(Object.keys(values).length, 58);
assert.equal(values.preset, 'Custom');
assert.equal(values.tradeDirectionectionection, 'Long + Exit');
assert.equal(values.useMTF, false);
assert.equal(values.notifyEnabled, false);

// Change only input defaults to the frozen effective values, before changing EXIT.
const edits = inspected.inputs.map(row => {
  assert.ok(Object.hasOwn(values, row.pine_variable));
  const span = original.slice(row.source_span.start, row.source_span.end);
  const masked = executable(span);
  const start = masked.indexOf('(') + 1;
  let depth = 0, end = start;
  for (; end < masked.length; end++) {
    const ch = masked[end];
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) { if (depth === 0) break; depth--; }
    if (ch === ',' && depth === 0) break;
  }
  const named = span.slice(start, end).match(/^(\s*defval\s*=\s*)/);
  return {start: row.source_span.start + start, end: row.source_span.start + end,
    text: (named?.[1] ?? '') + JSON.stringify(values[row.pine_variable])};
});
let revised = original;
for (const edit of edits.reverse()) revised = revised.slice(0, edit.start) + edit.text + revised.slice(edit.end);
function once(before, after) {
  assert.equal(revised.split(before).length, 2, 'Expected unique revision anchor');
  revised = revised.replace(before, after);
}
once('"SPT PRO Indicator — Spot review",', '"SPT Spot EXIT v1 — research draft",');
once(`rawSellSignal =
     barstate.isconfirmed and
     allowExitSignal and
     inSession and
     cooldownOK and
     shortSetupActive and
     shortBias and
     confirmShort and
     rsiShortOK and
     bosShortOK and
     sweepShortOK and
     validShortRisk`, `// Spot EXIT v1: first confirmed bar of a bearish ST / below-fast-EMA regime.
// EXIT is independent of short-entry setup, slow EMA, session and entry filters.
// This is a reduce-only candidate; Bot/Bridge owns actual positions and fills.
spotExitInvalidation = stBear and close < emaFast
rawSellSignal = barstate.isconfirmed and allowExitSignal and spotExitInvalidation and not spotExitInvalidation[1]`);
once('sellSignal = rawSellSignal and not rawBuySignal', 'sellSignal = rawSellSignal');
for (const row of inspectSource(revised).inputs) {
  const actual = ['int', 'float'].includes(row.type) ? row.default : JSON.parse(row.default);
  assert.equal(actual, values[row.pine_variable], row.pine_variable);
}
assert.ok(!revised.includes('bridge-native-trace-v1'));
const suffix = `

// SPT Spot EXIT v1 research evidence. No execution Bridge or webhook.
plot(buySignal ? 1 : 0, title="Spot EXIT v1 BUY", display=display.data_window)
plot(sellSignal ? 1 : 0, title="Spot EXIT v1 EXIT", display=display.data_window)
plot(spotExitInvalidation ? 1 : 0, title="Spot EXIT v1 invalidation", display=display.data_window)
plot(emaFast, title="Spot EXIT v1 fast EMA", display=display.data_window)
plot(emaSlow, title="Spot EXIT v1 slow EMA", display=display.data_window)
plot(atr, title="Spot EXIT v1 source ATR", display=display.data_window)
plot(stLine, title="Spot EXIT v1 SuperTrend", display=display.data_window)
plot(longSetupActive ? 1 : 0, title="Spot EXIT v1 long setup", display=display.data_window)
plot(shortSetupActive ? 1 : 0, title="Spot EXIT v1 legacy exit setup", display=display.data_window)
// End SPT Spot EXIT v1 research evidence.
`;
const artifact = revised + suffix;
const manifest = {
  version: 'spt-spot-exit-v1-draft', status: 'AWAITING_TRADINGVIEW_PARITY',
  original_source_hash: SOURCE_HASH, revised_source_hash: hash(revised), artifact_hash: hash(artifact),
  effective_inputs_hash: hash(canonical(values)), input_count: 58,
  original_input_lock_hash: contract.input_lock.lock_hash ?? null,
  exit_rule: 'confirmed rising edge of (stBear AND close < emaFast)',
  priority: 'EXIT suppresses BUY', entry_filters_changed: false,
  cooldown_state_note: 'New EXIT timing resets the existing shared tradeStartBar and setup state; later BUY timing can change.',
  risk_policy_changed: false, pyramiding_changed: false, execution_bridge: false,
  optimizer_enabled: false, lines: artifact.split('\n').length,
};
await fs.writeFile(outputPath, artifact, {flag: 'wx', mode: 0o600});
await fs.writeFile(outputPath + '.json', JSON.stringify(manifest, null, 2) + '\n', {flag: 'wx', mode: 0o600});
console.log(JSON.stringify(manifest));
