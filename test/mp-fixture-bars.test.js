import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {
  BARS_PATH, BARS_PATH_V2, FIRST_BAR_TIME, FIRST_BAR_TIME_V2, GENERATOR_VERSION, GENERATOR_VERSION_V2, MANIFEST_PATH, MANIFEST_PATH_V2,
  REGIMES, REGIME_SCALE_V2, TOTAL_BARS, barsPin, buildBars, regimeTable, renderFile
} from '../scripts/build-mp-fixture-bars.mjs';
import {RULES} from '../src/quant-research/contract.js';

/*
 * F11 S1 follow-up (b): the second deterministic fixture bars-v2. Node only (no Python): the CI unit jobs on ubuntu and windows have no venv.
 * v1 stays byte-identical (a literal pin guards it), v2 is the v1 regime table with rise, fall and noise multiplied by 3 and row 0 eight hours later.
 */

const V1_SHA256 = '5a333fcb0b716a98448fdfef11328a0f1d973ea76ce89d7e312265f8afbb59c8';
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const read = path => readFileSync(path, 'utf8');
const json = path => JSON.parse(read(path));
const runScript = (...args) => execFileSync(process.execPath, ['--max-old-space-size=512', 'scripts/build-mp-fixture-bars.mjs', ...args], {cwd: ROOT, encoding: 'utf8'});

const v1 = {text: renderFile(buildBars(TOTAL_BARS, 1), 1)};
const v2 = {text: renderFile(buildBars(TOTAL_BARS, 2), 2)};

test('v1 rebuilds byte for byte equal to the committed file and its manifest pin', () => {
  const committed = read(BARS_PATH);
  assert.equal(v1.text, committed);
  assert.equal(sha256(committed), V1_SHA256);
  const manifest = json(MANIFEST_PATH);
  assert.equal(manifest.bars.sha256, V1_SHA256);
  assert.equal(manifest.bars.generator.version, GENERATOR_VERSION);
  assert.deepEqual(manifest.bars, barsPin(buildBars(TOTAL_BARS, 1), V1_SHA256, 1));
});

test('v2 rebuilds byte for byte equal to the committed file and its manifest pin', () => {
  const committed = read(BARS_PATH_V2);
  assert.equal(v2.text, committed);
  const manifest = json(MANIFEST_PATH_V2);
  assert.equal(manifest.bars.sha256, sha256(committed));
  assert.equal(manifest.bars.generator.version, GENERATOR_VERSION_V2);
  assert.deepEqual(manifest.bars, barsPin(buildBars(TOTAL_BARS, 2), sha256(committed), 2));
  assert.deepEqual(Object.keys(manifest.bars), ['path', 'sha256', 'bar_count', 'first_time', 'last_time', 'generator', 'atr']);
  assert.deepEqual(Object.keys(manifest.bars.generator), ['script', 'version', 'seed', 'seed_klines']);
  assert.equal(manifest.fixture, true);
});

test('v2 differs from v1 in header, times and prices', () => {
  assert.notEqual(v2.text, v1.text);
  assert.notEqual(sha256(v2.text), V1_SHA256);
  const a = json(BARS_PATH), b = json(BARS_PATH_V2);
  assert.equal(a.version, 'mp-fixture-bars-v1');
  assert.equal(b.version, 'mp-fixture-bars-v2');
  assert.equal(a.bar_count, TOTAL_BARS);
  assert.equal(b.bar_count, TOTAL_BARS);
  assert.equal(a.bars.length, TOTAL_BARS);
  assert.equal(b.bars.length, TOTAL_BARS);
  assert.equal(a.provenance.seed, b.provenance.seed);
  assert.equal(a.provenance.seed_klines, b.provenance.seed_klines);
  assert.equal(a.provenance.profile, b.provenance.profile);
  assert.notEqual(a.bars[0].close, b.bars[0].close);
  assert.notEqual(a.bars[TOTAL_BARS - 1].close, b.bars[TOTAL_BARS - 1].close);
});

test('v2 first_time is v1 plus eight hours and every bar is one minute after the last', () => {
  assert.equal(FIRST_BAR_TIME, 1767312000000);
  assert.equal(FIRST_BAR_TIME_V2, 1767340800000);
  assert.equal(FIRST_BAR_TIME_V2 - FIRST_BAR_TIME, 8 * 3600 * 1000);
  const file = json(BARS_PATH_V2);
  assert.equal(file.first_time, 1767340800000);
  assert.equal(file.bars[0].time, 1767340800000);
  file.bars.forEach((bar, index) => assert.equal(bar.time, 1767340800000 + index * 60000));
  assert.equal(json(MANIFEST_PATH_V2).bars.first_time, 1767340800000);
  assert.equal(json(MANIFEST_PATH_V2).bars.last_time, 1767340800000 + (TOTAL_BARS - 1) * 60000);
});

test('the v2 regime table is the v1 table with rise, fall and noise multiplied by 3', () => {
  assert.equal(REGIME_SCALE_V2, 3);
  assert.deepEqual(regimeTable(1), REGIMES);
  const scaled = regimeTable(2);
  assert.equal(scaled.length, REGIMES.length);
  scaled.forEach((spec, index) => {
    const base = REGIMES[index];
    assert.equal(spec.length, base.length);
    assert.equal(spec.up, base.up);
    assert.equal(spec.down, base.down);
    assert.equal(spec.rise, base.rise * 3);
    assert.equal(spec.fall, base.fall * 3);
    assert.equal(spec.noise, base.noise * 3);
  });
  // spot values written out by hand, so a change of the v1 table or of the factor is seen here
  assert.deepEqual([scaled[1].rise, scaled[1].fall, scaled[1].noise], [15, -9, 18]);
  assert.deepEqual([REGIMES[1].rise, REGIMES[1].fall, REGIMES[1].noise], [5, -3, 6]);
  assert.throws(() => regimeTable(3), /UNKNOWN_FIXTURE_VERSION/);
});

test('the committed v2 bars move about three times as far per bar as v1', () => {
  const spread = path => {
    const returns = json(path).bars.map(bar => Number(bar.close) / Number(bar.open) - 1);
    const mean = returns.reduce((sum, value) => sum + value, 0) / returns.length;
    return Math.sqrt(returns.reduce((sum, value) => sum + (value - mean) ** 2, 0) / returns.length);
  };
  const ratio = spread(BARS_PATH_V2) / spread(BARS_PATH);
  assert.ok(ratio > 2.5 && ratio < 3.5, `per-bar spread ratio ${ratio}`);
  const atr = path => { const bars = json(path).bars; return bars.reduce((sum, bar) => sum + Number(bar.atr14) / Number(bar.close), 0) / bars.length; };
  const atrRatio = atr(BARS_PATH_V2) / atr(BARS_PATH);
  assert.ok(atrRatio > 2.5 && atrRatio < 3.5, `relative atr ratio ${atrRatio}`);
});

test('the v2 manifest records a HOLDOUT measurement that meets the one-Pine gates', () => {
  const {measured} = json(MANIFEST_PATH_V2);
  assert.deepEqual(measured.members, ['M1', 'M2']);
  assert.deepEqual(measured.pair, {atr_multiplier: '2', rr: '1.5'});
  assert.deepEqual(measured.split, json(MANIFEST_PATH).split);
  assert.ok(measured.test.closed_trades >= RULES.minimum_closed_trades_test);
  assert.ok(Number(measured.test.net_return_percent) >= 0);
  assert.ok(Number(measured.test.max_drawdown_percent) <= RULES.maximum_drawdown_percent);
  assert.equal(measured.holdout_gates.passes, true);
  assert.equal(measured.holdout_gates.minimum_closed_trades_test, RULES.minimum_closed_trades_test);
  assert.equal(measured.holdout_gates.maximum_drawdown_percent, RULES.maximum_drawdown_percent);
  assert.ok(measured.train.closed_trades >= RULES.minimum_closed_trades_train);
  assert.ok(measured.validation.closed_trades >= RULES.minimum_closed_trades_validation);
  assert.equal(measured.open_allocations, 0);
});

test('the command line keeps the v1 output and checks v2 against bars-v2.json and manifest-v2.json', () => {
  assert.equal(runScript('--check'), `ok ${V1_SHA256}\n`);
  assert.equal(runScript('--version', '1', '--check'), `ok ${V1_SHA256}\n`);
  assert.equal(runScript('--version', '2', '--check'), `ok ${json(MANIFEST_PATH_V2).bars.sha256}\n`);
  assert.equal(sha256(runScript('--stdout')), V1_SHA256);
  assert.equal(runScript('--version', '2', '--stdout'), read(BARS_PATH_V2));
  assert.throws(() => execFileSync(process.execPath, ['scripts/build-mp-fixture-bars.mjs', '--version', '3', '--check'], {cwd: ROOT, stdio: 'pipe'}), /UNKNOWN_FIXTURE_VERSION/);
});
