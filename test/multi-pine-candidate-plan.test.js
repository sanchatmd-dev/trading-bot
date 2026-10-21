import test from 'node:test';
import assert from 'node:assert/strict';
import {candidatePlan} from '../src/quant-research/contract.js';
import {canonical} from '../src/pine-bridge/source.js';
import {multiCandidatePlan,planFromContract,assertEvaluationBudget,gridValues,MULTI_EVALUATION_OVERHEAD,MULTI_PLAN_VERSION,PLAN_CODES} from '../src/multi-pine/candidate-plan.js';

/*
 * F11 S3: the multi-Pine candidate plan (RD-MP-29) against the one-Pine `candidatePlan` on an equivalent numeric grid. The one-Pine lock needs two EMA fixed
 * inputs (validParameters compares them), and its domains are number arrays; the multi plan works on decimal strings. Both must pick the same grid points
 * in the same order with the same labels, and must refuse the same budgets.
 */

const FIXED = [{pine_variable: 'emaFastInput', effective_value: 20}, {pine_variable: 'emaSlowInput', effective_value: 200}];
const DOMAINS = {atr_multiplier: {min: '1', max: '3', step: '0.5'}, rr: {min: '0.5', max: '2.5', step: '0.5'}};
const BASELINE = {atr_multiplier: '2', rr: '1.5'};

const numbers = grid => grid.map(Number);
function oneLock(domains, baseline) {
  return {
    baseline: Object.fromEntries(Object.entries(baseline).map(([key, value]) => [key, Number(value)])),
    domains: Object.fromEntries(Object.entries(domains).map(([key, domain]) => [key, numbers(gridValues(domain))])),
    selection: {fixed_inputs: FIXED, bindings: []}
  };
}
const asNumbers = rows => rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)])));
const planOf = (over = {}) => multiCandidatePlan({bridge_domains: DOMAINS, baseline: BASELINE, budget: 30, seed: 42, ...over});

test('grid values are exact canonical decimal strings, ascending', () => {
  assert.deepEqual(gridValues(DOMAINS.atr_multiplier), ['1', '1.5', '2', '2.5', '3']);
  assert.deepEqual(gridValues({min: '0.01', max: '0.05', step: '0.01'}), ['0.01', '0.02', '0.03', '0.04', '0.05']);
  assert.deepEqual(gridValues({min: '0.1', max: '0.4', step: '0.1'}), ['0.1', '0.2', '0.3', '0.4']);
  assert.equal(gridValues({min: '0.01', max: '10', step: '0.01'}).length, 1000);
  // a binary float would give 0.30000000000000004 here; the exact grid never does
  assert.ok(gridValues({min: '0.1', max: '0.4', step: '0.1'}).includes('0.3'));
  for (const bad of [{min: '1', max: '1', step: '0.5'}, {min: '1', max: '3', step: '0.7'}, {min: '1', max: '3', step: '0'}, {min: '1.0', max: '3', step: '0.5'},
    {min: 1, max: '3', step: '0.5'}, {min: '0.001', max: '10', step: '0.001'}, null, [], {min: '1', max: '3'}]) {
    assert.throws(() => gridValues(bad), {code: PLAN_CODES.INVALID_PLAN_INPUT}, JSON.stringify(bad));
  }
});

test('the exhaustive plan equals candidatePlan on the equivalent grid (parity)', () => {
  for (const budget of [25, 30, 100]) {
    const mine = planOf({budget}), theirs = candidatePlan(oneLock(DOMAINS, BASELINE), budget, 42);
    assert.deepEqual(asNumbers(mine.candidates), theirs.candidates, 'budget ' + budget);
    assert.equal(mine.algorithm, 'exhaustive-grid-v1');
    assert.equal(mine.algorithm, theirs.algorithm);
    assert.equal(mine.planned_candidates, theirs.planned_candidates);
    assert.equal(mine.grid_combinations, theirs.grid_combinations);
    assert.equal(mine.requested_budget, theirs.requested_budget);
    assert.equal(mine.seed, theirs.seed);
  }
});

test('the seeded plan equals candidatePlan for many seeds and budgets (same LCG, same labels)', () => {
  for (const seed of [0, 1, 42, 7777, 2147483647]) {
    for (const budget of [5, 9, 12, 20, 24]) {
      const mine = planOf({budget, seed}), theirs = candidatePlan(oneLock(DOMAINS, BASELINE), budget, seed);
      assert.deepEqual(asNumbers(mine.candidates), theirs.candidates, `seed ${seed} budget ${budget}`);
      assert.equal(mine.algorithm, 'axis-covered-seeded-grid-v1');
      assert.equal(mine.algorithm, theirs.algorithm);
      assert.equal(mine.planned_candidates, theirs.planned_candidates);
      assert.equal(mine.grid_combinations, theirs.grid_combinations);
    }
  }
});

test('parity holds on a skewed grid, an edge baseline and a fractional step', () => {
  const cases = [
    {domains: {atr_multiplier: {min: '0.5', max: '4', step: '0.5'}, rr: {min: '1', max: '2', step: '0.25'}}, baseline: {atr_multiplier: '0.5', rr: '2'}},
    {domains: {atr_multiplier: {min: '0.1', max: '0.6', step: '0.1'}, rr: {min: '0.2', max: '1', step: '0.2'}}, baseline: {atr_multiplier: '0.3', rr: '0.6'}},
    {domains: {atr_multiplier: {min: '2', max: '12', step: '1'}, rr: {min: '1', max: '9', step: '1'}}, baseline: {atr_multiplier: '12', rr: '1'}}
  ];
  for (const {domains, baseline} of cases) {
    for (const [budget, seed] of [[30, 3], [100, 3], [8, 99], [40, 12345]]) {
      let mine, theirs, mineError, theirError;
      try { mine = multiCandidatePlan({bridge_domains: domains, baseline, budget, seed}); } catch (error) { mineError = error.code; }
      try { theirs = candidatePlan(oneLock(domains, baseline), budget, seed); } catch (error) { theirError = error.code; }
      assert.equal(mineError, theirError, 'same refusal');
      if (mine) {
        assert.deepEqual(asNumbers(mine.candidates), theirs.candidates);
        assert.equal(mine.algorithm, theirs.algorithm);
      }
    }
  }
});

test('the baseline pair is row 0 and its axis neighbours follow in sorted name order', () => {
  const plan = planOf();
  assert.deepEqual(plan.candidates[0], BASELINE);
  assert.deepEqual(plan.candidates.slice(1, 5), [
    {atr_multiplier: '1.5', rr: '1.5'}, {atr_multiplier: '2.5', rr: '1.5'}, {atr_multiplier: '2', rr: '1'}, {atr_multiplier: '2', rr: '2'}]);
  assert.equal(plan.planned_candidates, 25);
  assert.equal(plan.grid_combinations, 25);
  // an edge baseline has one neighbour per axis only
  const edge = multiCandidatePlan({bridge_domains: DOMAINS, baseline: {atr_multiplier: '1', rr: '0.5'}, budget: 30, seed: 1});
  assert.deepEqual(edge.candidates.slice(0, 3), [{atr_multiplier: '1', rr: '0.5'}, {atr_multiplier: '1.5', rr: '0.5'}, {atr_multiplier: '1', rr: '1'}]);
});

test('too small a budget refuses INSUFFICIENT_DIMENSION_BUDGET, as candidatePlan does', () => {
  assert.throws(() => planOf({budget: 4}), {code: PLAN_CODES.INSUFFICIENT_DIMENSION_BUDGET});
  assert.throws(() => candidatePlan(oneLock(DOMAINS, BASELINE), 4, 42), {code: 'INSUFFICIENT_DIMENSION_BUDGET'});
  assert.equal(planOf({budget: 5}).planned_candidates, 5);
  assert.throws(() => planOf({budget: 1}), {code: PLAN_CODES.INSUFFICIENT_DIMENSION_BUDGET});
});

test('no validParameters filter: nothing is dropped, every point of an exhaustive grid is planned once', () => {
  const plan = planOf({budget: 100});
  assert.equal(new Set(plan.candidates.map(canonical)).size, 25);
  assert.equal(plan.candidates.length, 25);
  for (const atr of gridValues(DOMAINS.atr_multiplier)) for (const rr of gridValues(DOMAINS.rr))
    assert.ok(plan.candidates.some(row => row.atr_multiplier === atr && row.rr === rr), atr + '/' + rr);
});

test('the plan is deterministic, carries a plan_hash and the evaluation cap planned + 9', () => {
  const a = planOf({budget: 12, seed: 5}), b = planOf({budget: 12, seed: 5}), c = planOf({budget: 12, seed: 6});
  assert.deepEqual(a, b);
  assert.match(a.plan_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(a.plan_hash, c.plan_hash, 'another seed gives another plan');
  assert.notEqual(a.plan_hash, planOf({budget: 13, seed: 5}).plan_hash);
  assert.equal(a.version, MULTI_PLAN_VERSION);
  assert.equal(MULTI_EVALUATION_OVERHEAD, 9);
  assert.equal(a.max_evaluations, a.planned_candidates + 9);
  // the one-Pine cap: planned + 2 * dimensions + 2 + 3 with the same two dimensions
  assert.equal(a.max_evaluations, candidatePlan(oneLock(DOMAINS, BASELINE), 12, 5).planned_candidates + 2 * 2 + 2 + 3);
});

test('the evaluation cap refuses the evaluation after planned + 9', () => {
  const plan = planOf({budget: 25});
  for (let started = 0; started < plan.max_evaluations; started++) assert.doesNotThrow(() => assertEvaluationBudget(plan, started));
  assert.throws(() => assertEvaluationBudget(plan, plan.max_evaluations), {code: PLAN_CODES.EVALUATION_BUDGET_EXCEEDED});
  assert.throws(() => assertEvaluationBudget(plan, plan.max_evaluations + 5), {code: PLAN_CODES.EVALUATION_BUDGET_EXCEEDED});
  assert.throws(() => assertEvaluationBudget(plan, -1), {code: PLAN_CODES.EVALUATION_BUDGET_EXCEEDED});
});

test('malformed input is refused, never defaulted', () => {
  const base = {bridge_domains: DOMAINS, baseline: BASELINE, budget: 30, seed: 42};
  for (const bad of [null, [], {}, {...base, budget: 0}, {...base, budget: 101}, {...base, budget: 1.5}, {...base, seed: -1}, {...base, seed: 2147483648}, {...base, seed: '1'},
    {...base, baseline: {atr_multiplier: '2'}}, {...base, baseline: {...BASELINE, extra: '1'}}, {...base, baseline: {atr_multiplier: '2.25', rr: '1.5'}},
    {...base, baseline: {atr_multiplier: 2, rr: '1.5'}}, {...base, bridge_domains: {atr_multiplier: DOMAINS.atr_multiplier}},
    {...base, bridge_domains: {...DOMAINS, extra: DOMAINS.rr}}]) {
    assert.throws(() => multiCandidatePlan(bad), {code: PLAN_CODES.INVALID_PLAN_INPUT}, JSON.stringify(bad));
  }
});

test('planFromContract reads domains, budget and seed from the contract and the pair from the frozen set it names', () => {
  const contract = {set_hash: 'a'.repeat(64), member_set_id: 'set-1', bridge_domains: DOMAINS, budget: {candidates: 30}, seed: 42};
  const set = {set_hash: 'a'.repeat(64), member_set_id: 'set-1', bridge_pair: BASELINE};
  assert.deepEqual(planFromContract(contract, set), planOf());
  assert.throws(() => planFromContract(contract, {...set, set_hash: 'b'.repeat(64)}), {code: PLAN_CODES.INVALID_PLAN_INPUT});
  assert.throws(() => planFromContract(contract, {...set, member_set_id: 'other'}), {code: PLAN_CODES.INVALID_PLAN_INPUT});
  assert.throws(() => planFromContract(contract, null), {code: PLAN_CODES.INVALID_PLAN_INPUT});
});
