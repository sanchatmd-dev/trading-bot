import {canonical,hash} from '../pine-bridge/source.js';
import {decimalString} from './member-set.js';

/*
 * F11 S3: candidate plan of a multi-Pine run (docs/MULTI_PINE_CONTRACT.md RD-MP-29).
 * `multiCandidatePlan` is the `candidatePlan` algorithm of src/quant-research/contract.js on grid INDEXES over the decimal-string bridge_domains of the stored
 * contract: the baseline pair first, then the neighbours of the baseline on each axis in sorted name order, then the whole grid when it has at most `budget`
 * points, else the same seeded linear congruential generator with the same labels. There is no validParameters filter (that filter compares EMA inputs; a multi
 * run has no source slot, so the only dimensions are atr_multiplier and rr). A candidate is {atr_multiplier, rr} as canonical decimal strings: ONE pair for all
 * members. The plan depends on the stored contract and the frozen set's shared pair only, so a retry or a recovery yields the same plan and the same plan_hash.
 * The evaluation cap is planned + 2 * dimensions + 2 + 3, the one-Pine cap of src/postgres/quant-research.js; with two dimensions that is planned + 9.
 * Pure: no database, file, clock or randomness (the generator is seeded by the contract).
 */

export const MULTI_PLAN_VERSION = 'mp-candidate-plan-v1';
export const MULTI_DIMENSIONS = Object.freeze(['atr_multiplier', 'rr']);
export const MULTI_EVALUATION_OVERHEAD = 2 * MULTI_DIMENSIONS.length + 2 + 3;
export const PLAN_CODES = Object.freeze({
  INSUFFICIENT_DIMENSION_BUDGET: 'INSUFFICIENT_DIMENSION_BUDGET',
  EVALUATION_BUDGET_EXCEEDED: 'EVALUATION_BUDGET_EXCEEDED',
  INVALID_PLAN_INPUT: 'INVALID_PLAN_INPUT'
});

const fail = code => Object.assign(new Error(code), {code});
const invalid = () => fail(PLAN_CODES.INVALID_PLAN_INPUT);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fraction = value => (value.split('.')[1] ?? '').length;
const scaled = (value, scale) => {
  const [whole, part = ''] = value.split('.');
  return BigInt(whole + part.padEnd(scale, '0'));
};
const render = (units, scale) => {
  const digits = units.toString().padStart(scale + 1, '0');
  const text = scale === 0 ? digits : digits.slice(0, -scale) + '.' + digits.slice(-scale);
  return decimalString(text);
};

/** The grid values of one domain {min, max, step} as canonical decimal strings, ascending, in exact arithmetic. */
export function gridValues(domain) {
  if (!isObject(domain)) throw invalid();
  for (const key of ['min', 'max', 'step']) if (typeof domain[key] !== 'string' || decimalString(domain[key]) !== domain[key]) throw invalid();
  const scale = Math.max(fraction(domain.min), fraction(domain.max), fraction(domain.step));
  const min = scaled(domain.min, scale), max = scaled(domain.max, scale), step = scaled(domain.step, scale);
  if (step <= 0n || min >= max || (max - min) % step !== 0n) throw invalid();
  const count = (max - min) / step + 1n;
  if (count > 1000n) throw invalid();
  return Array.from({length: Number(count)}, (_, index) => render(min + step * BigInt(index), scale));
}

/**
 * input = {bridge_domains: {atr_multiplier:{min,max,step}, rr:{...}}, baseline: {atr_multiplier, rr} (canonical decimal strings, on the grid), budget, seed}.
 * Returns {version, algorithm, seed, requested_budget, planned_candidates, grid_combinations, max_evaluations, baseline, candidates, plan_hash}.
 * Throws an Error with code INSUFFICIENT_DIMENSION_BUDGET (the baseline and its neighbours do not fit the budget, or a dimension has fewer than two values)
 * or INVALID_PLAN_INPUT.
 */
export function multiCandidatePlan(input) {
  if (!isObject(input) || !isObject(input.bridge_domains) || !isObject(input.baseline)) throw invalid();
  const {budget, seed} = input;
  if (!Number.isSafeInteger(budget) || budget < 1 || budget > 100 || !Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw invalid();
  const names = [...MULTI_DIMENSIONS].sort();
  if (Object.keys(input.bridge_domains).length !== names.length || Object.keys(input.baseline).length !== names.length) throw invalid();
  const grids = {};
  for (const name of names) {
    if (!Object.hasOwn(input.bridge_domains, name) || !Object.hasOwn(input.baseline, name)) throw invalid();
    grids[name] = gridValues(input.bridge_domains[name]);
  }
  const at = {};
  for (const name of names) {
    at[name] = grids[name].indexOf(input.baseline[name]);
    if (at[name] < 0) throw invalid();
  }
  const rows = [], seen = new Set();
  const add = indexes => {
    const key = names.map(name => indexes[name]).join(',');
    if (seen.has(key)) return;
    seen.add(key);
    rows.push(Object.fromEntries(names.map(name => [name, grids[name][indexes[name]]])));
  };
  add(at);
  // Adjacent values ensure every dimension actually participates.
  for (const name of names) for (const index of [at[name] - 1, at[name] + 1]) if (index >= 0 && index < grids[name].length) add({...at, [name]: index});
  if (rows.length > budget || names.some(name => new Set(rows.map(row => row[name])).size < 2)) throw fail(PLAN_CODES.INSUFFICIENT_DIMENSION_BUDGET);
  const combinations = names.reduce((total, name) => total * grids[name].length, 1);
  if (combinations <= budget) {
    const walk = (position, indexes) => {
      if (position === names.length) { add(indexes); return; }
      for (let index = 0; index < grids[names[position]].length; index++) walk(position + 1, {...indexes, [names[position]]: index});
    };
    walk(0, {});
  } else {
    // Versioned deterministic PRNG: retries and recovery keep the identical plan.
    let state = seed >>> 0;
    const next = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
    for (let tries = 0; rows.length < budget && tries < budget * 100; tries++)
      add(Object.fromEntries(names.map(name => [name, Math.floor(next() * grids[name].length)])));
  }
  const plan = {
    version: MULTI_PLAN_VERSION,
    algorithm: combinations <= budget ? 'exhaustive-grid-v1' : 'axis-covered-seeded-grid-v1',
    seed, requested_budget: budget, planned_candidates: rows.length, grid_combinations: combinations,
    max_evaluations: rows.length + MULTI_EVALUATION_OVERHEAD,
    baseline: {...input.baseline}, candidates: rows
  };
  return {...plan, plan_hash: hash(canonical(plan))};
}

/**
 * The plan of a stored run: domains, budget and seed come from the validated contract, the baseline pair from the frozen member set it names (the contract
 * binds that set by set_hash). A set that does not match the contract refuses with INVALID_PLAN_INPUT.
 */
export function planFromContract(contract, member_set) {
  if (!isObject(contract) || !isObject(member_set) || contract.set_hash !== member_set.set_hash || contract.member_set_id !== member_set.member_set_id) throw invalid();
  return multiCandidatePlan({bridge_domains: contract.bridge_domains, baseline: member_set.bridge_pair, budget: contract.budget.candidates, seed: contract.seed});
}

/** The refusal of the evaluation cap: `started` evaluations already ran, and one more would pass the plan's cap. */
export function assertEvaluationBudget(plan, started) {
  if (!Number.isSafeInteger(started) || started < 0 || started >= plan.max_evaluations) throw fail(PLAN_CODES.EVALUATION_BUDGET_EXCEEDED);
}
