#!/usr/bin/env node
// Deterministic synthetic BINANCE:BTCUSDT 1m fixture bars for the F11 combined evaluator (RD-MP-33).
//
//   node scripts/build-mp-fixture-bars.mjs            write test/fixtures/mp-combined/bars-v1.json
//   node scripts/build-mp-fixture-bars.mjs --check    rebuild in memory and compare with the committed
//                                                      file and with manifest.json (exit 1 on any difference)
//   node scripts/build-mp-fixture-bars.mjs --stdout [--bars N]   print the same series to stdout with N bars
//                                                      (default 6000; other counts are for timing only, never committed)
//
// Local only: no network, no database, no clock. The price path uses a fixed-seed integer PRNG and only
// +, -, *, / on doubles (no transcendental functions), so it is identical on every IEEE-754 platform.
// atr14 comes from the project's own closed-ohlcv-atr14-v1 derivation (src/pine-bridge/market-data.js
// barsFromKlines and extendBarsFromKlines), not from a second formula: 500 seed klines warm the ATR and are
// not stored, exactly as barsFromKlines does (warmup 500, atr_period 14).
import {createHash} from 'node:crypto';
import {readFileSync, writeFileSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {barsFromKlines, extendBarsFromKlines} from '../src/pine-bridge/market-data.js';

export const GENERATOR_VERSION = 'mp-fixture-bars-v1';
export const SEED = 20261021;
export const TOTAL_BARS = 6000;
export const SEED_KLINES = 500;
// Closed-bar time of row 0: Fri 2026-01-02T00:00:00Z, minute aligned. Every bar, row 5999 included, lies in the
// past of any real clock after 2026-01-06, so a real-clock admission never refuses a fixture bar as future.
export const FIRST_BAR_TIME = 1767312000000;
const MINUTE = 60000;
const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_DIR = join(here, '..', 'test', 'fixtures', 'mp-combined');
export const BARS_PATH = join(FIXTURE_DIR, 'bars-v1.json');
export const MANIFEST_PATH = join(FIXTURE_DIR, 'manifest.json');

function mulberry32(seed) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Regimes: a fixed table, so the same bars come out on every run. Each regime is a sawtooth: `up` bars of
// mean return `rise`, then `down` bars of mean return `fall`, repeated until `length` bars. Long regimes
// trend up with pullbacks (SPT BUY setups); short regimes trend down (SPT native exits). rise/fall are
// per-bar mean returns and noise the per-bar spread, in basis points of price.
// Tuned once so each member below has at least 15 native BUY in each of train, validation and test.
const REGIMES = [
  {length: 650, up: 28, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 300, up: 10, down: 30, rise: 5, fall: -3, noise: 6},
  {length: 600, up: 30, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 320, up: 10, down: 28, rise: 5, fall: -3, noise: 6},
  {length: 700, up: 32, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 280, up: 10, down: 26, rise: 5, fall: -3, noise: 6},
  {length: 560, up: 28, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 300, up: 10, down: 30, rise: 5, fall: -3, noise: 6},
  {length: 680, up: 30, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 260, up: 10, down: 28, rise: 5, fall: -3, noise: 6},
  {length: 620, up: 32, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 300, up: 10, down: 26, rise: 5, fall: -3, noise: 6},
  {length: 640, up: 28, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 290, up: 10, down: 30, rise: 5, fall: -3, noise: 6},
  {length: 600, up: 30, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 310, up: 10, down: 28, rise: 5, fall: -3, noise: 6},
  {length: 660, up: 32, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 280, up: 10, down: 26, rise: 5, fall: -3, noise: 6},
  {length: 580, up: 28, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 300, up: 10, down: 30, rise: 5, fall: -3, noise: 6},
  {length: 700, up: 30, down: 9, rise: 3.2, fall: -5.5, noise: 6},
  {length: 300, up: 10, down: 28, rise: 5, fall: -3, noise: 6},
];

const cents = value => Math.max(1, Math.round(value * 100)) / 100;
const fixed = (value, places) => value.toFixed(places);

/** Klines [openTime, open, high, low, close, volume, closeTime] as Binance returns them (decimal strings). */
export function buildKlines(total = TOTAL_BARS) {
  const random = mulberry32(SEED);
  const gauss = () => (random() + random() + random() + random() - 2) * 1.7320508075688772; // unit variance
  const count = SEED_KLINES + total;
  const firstOpen = FIRST_BAR_TIME - (SEED_KLINES + 1) * MINUTE;
  const klines = [];
  let price = 30000;
  let regime = 0, inRegime = 0, phase = 0, inPhase = 0;
  for (let i = 0; i < count; i++) {
    let spec = REGIMES[regime % REGIMES.length];
    if (inRegime >= spec.length) {regime++; inRegime = 0; phase = 0; inPhase = 0; spec = REGIMES[regime % REGIMES.length];}
    const leg = phase === 0 ? spec.up : spec.down;
    if (inPhase >= leg) {phase = 1 - phase; inPhase = 0;}
    const mean = phase === 0 ? spec.rise : spec.fall;
    const open = price;
    const close = cents(open * (1 + (mean + spec.noise * gauss()) / 10000));
    const wickUp = random() * spec.noise * 0.9 / 10000, wickDown = random() * spec.noise * 0.9 / 10000;
    const high = cents(Math.max(open, close) * (1 + wickUp));
    const low = cents(Math.min(open, close) * (1 - wickDown));
    const volume = 1 + Math.floor(random() * 90000) / 1000;
    const openTime = firstOpen + i * MINUTE;
    klines.push([openTime, fixed(open, 2), fixed(Math.max(high, open, close), 2), fixed(Math.min(low, open, close), 2),
      fixed(close, 2), fixed(volume, 3), openTime + MINUTE - 1]);
    price = close;
    inRegime++; inPhase++;
  }
  return klines;
}

const METADATA = Object.freeze({price_tick: '0.01', quantity_step: '0.00001'});
const FAR_FUTURE = 8_000_000_000_000_000; // fixed constant clock, later than every close: the build reads no clock

/** The 6,000 stored bars: first 500 klines seed the ATR (barsFromKlines), the rest extend it in chunks of at most 1,000. */
export function buildBars(total = TOTAL_BARS) {
  const klines = buildKlines(total);
  const first = barsFromKlines(klines.slice(0, 1000), METADATA, FAR_FUTURE);
  const bars = [...first.bars];
  let offset = 1000;
  while (offset < klines.length) {
    const chunk = klines.slice(offset, offset + 1000);
    bars.push(...extendBarsFromKlines(chunk, bars[bars.length - 1], METADATA, FAR_FUTURE));
    offset += chunk.length;
  }
  if (bars.length !== total || bars[0].time !== FIRST_BAR_TIME) throw new Error('FIXTURE_BAR_COUNT');
  return bars.map(({time, open, high, low, close, volume, atr14}) => ({time, open, high, low, close, volume, atr14}));
}

export function renderFile(bars) {
  const head = {
    version: GENERATOR_VERSION,
    fixture: true,
    label: 'BINANCE:BTCUSDT fixture (synthetic, not market data)',
    venue: 'binance-global', market: 'SPOT', symbol: 'BTCUSDT', timeframe: '1',
    price_tick: METADATA.price_tick, quantity_step: METADATA.quantity_step,
    provenance: {
      profile: 'closed-ohlcv-atr14-v1', source: 'synthetic fixture mp-combined-v1', fixture: true,
      generator: 'scripts/build-mp-fixture-bars.mjs', seed: SEED, seed_klines: SEED_KLINES, atr_period: 14,
    },
    first_time: FIRST_BAR_TIME, bar_count: bars.length,
  };
  const lines = bars.map(bar => JSON.stringify(bar));
  return JSON.stringify(head).slice(0, -1) + ',"bars":[\n' + lines.join(',\n') + '\n]}\n';
}

const sha256 = text => createHash('sha256').update(text).digest('hex');

function main() {
  const at = process.argv.indexOf('--bars');
  const total = at > 0 ? Number(process.argv[at + 1]) : TOTAL_BARS;
  if (!Number.isInteger(total) || total < 1 || (total !== TOTAL_BARS && !process.argv.includes('--stdout'))) throw new Error('BARS_ONLY_WITH_STDOUT');
  const text = renderFile(buildBars(total));
  const digest = sha256(text);
  if (process.argv.includes('--check')) {
    const manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
    const committed = readFileSync(BARS_PATH, 'utf8');
    const problems = [];
    if (committed !== text) problems.push('committed bars differ from a fresh build');
    if (sha256(committed) !== manifest.bars.sha256) problems.push('manifest bars.sha256 differs from the committed file');
    if (digest !== manifest.bars.sha256) problems.push('manifest bars.sha256 differs from a fresh build');
    if (problems.length) {console.error(problems.join('\n')); process.exit(1);}
    console.log(`ok ${digest}`);
    return;
  }
  if (process.argv.includes('--stdout')) {process.stdout.write(text); return;}
  writeFileSync(BARS_PATH, text);
  console.log(`wrote ${BARS_PATH} sha256 ${digest}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
