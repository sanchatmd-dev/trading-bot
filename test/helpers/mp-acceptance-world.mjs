import fs from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {guard, PrivateInputError, sha256Hex} from './mp-private-inputs.mjs';

/*
 * F11-01 R6-6: the world builder and the throwaway-cluster context of the RD-MP-34 private-source acceptance (docs/MULTI_PINE_CONTRACT.md RD-MP-43).
 * Used by test/postgres/mp-private-acceptance.test.mjs only. It is the `newWorld` of test/postgres/mp-executor.test.mjs and test/postgres/mp-package-build.test.mjs, parameterised by the
 * reviewed source and the reviewed analyses, using SPT_SIGNAL_MAPPING. It seeds as the cluster admin of a throwaway PostgreSQL cluster (TEST_DATABASE_URL) and nothing else.
 *
 * Every store, executor and Python-runner module is imported lazily, inside loadModules(), so a module that statically imports this file loads none of them. The source and the analyses
 * reach the database only through guard(), which replaces any error with a hash-only error (leak controls of RD-MP-43). Nothing here prints, logs or writes a file.
 */

const T0 = 1790000000000;
const MINUTE = 60000;
const FIXTURES = new URL('../fixtures/mp-combined/', import.meta.url);
const SRC = new URL('../../src/postgres/', import.meta.url);
const GRANT_SCRIPT = new URL('../../scripts/grant-postgres-runtime.sql', import.meta.url);
const RUN_FIXTURE_SCRIPT = new URL('../../scripts/grant-postgres-mp-fixture.sql', import.meta.url);
const PACKAGE_FIXTURE_SCRIPT = new URL('../../scripts/grant-postgres-mp-package-fixture.sql', import.meta.url);
export const MARKET = Object.freeze({broker: 'binance-global', symbol: 'BTCUSDT', timeframe: '1'});
/** The Bridge domains of the fixture runs: the bars-v2 grid that selects 2/2 (test/postgres/mp-package-build.test.mjs V2_DOMAINS). */
export const V2_DOMAINS = Object.freeze({atr_multiplier: {min: '2', max: '3', step: '0.5'}, rr: {min: '1', max: '2', step: '0.5'}});
/** A grid whose every candidate fails the cost stress on the fixture inputs (mp-executor.test.mjs STRESS_FAILS): the F20 case. */
export const STRESS_FAILS = Object.freeze({atr_multiplier: {min: '1.5', max: '2.5', step: '0.5'}, rr: {min: '1', max: '2.5', step: '0.5'}});
/** The synthetic source and gate wrapper of the SYN fallback for F24 and F29 (RD-MP-43 with O7 answered no). Same as test/postgres/mp-executor.test.mjs. */
export const SYN_SOURCE = '//@version=6\nindicator("mp executor fixture")\nbuySignal = ta.crossover(close, ta.sma(close, 20))\nsellSignal = ta.crossunder(close, ta.sma(close, 20))\nplot(close)\n';
export const GATE_WRAPPER = [
  'import json,os',
  'from robot_quant import mp_combined_job as job',
  'from robot_quant.spt_custom_evaluator import CustomSignalInputs',
  'INPUTS=json.loads(os.environ["MP_TEST_INPUTS"])',
  'def gate(source,snapshot):',
  '    rows=snapshot["membership"]',
  '    if len(rows)!=1: raise ValueError("MISSING_SOURCE_MEMBERSHIP")',
  '    return CustomSignalInputs.from_source_values(INPUTS[rows[0]["pine_import_id"]]),[]',
  'job.validate_custom_snapshot=gate',
  'job.main()'
].join('\n');

let modules, fixtureCache;

/** Every product module the private path needs, imported once and only on first use. */
export async function loadModules() {
  if (modules) return modules;
  const [db, store, password, memberSetMigration, runStoreMigration, packageStoreMigration, exposureMigration, memberSetStore, runStore, source, template, fixtureService, admission, executor, runner,
    engineClosure, packageClosure, packageStore, pineBridge, quantResearch, readiness, bridgeExecution, bridgeContract, comparisonContext, comparisonCommon, pg] = await Promise.all([
    import('../../src/postgres/db.js'), import('../../src/postgres/store.js'), import('./test-role-password.mjs'), import('../../src/postgres/mp-member-set-migration.js'),
    import('../../src/postgres/mp-run-store-migration.js'), import('../../src/postgres/mp-package-store-migration.js'), import('../../src/postgres/quant-exposure-register-migration.js'),
    import('../../src/postgres/mp-member-set-store.js'), import('../../src/postgres/mp-run-store.js'), import('../../src/pine-bridge/source.js'), import('../../src/pine-bridge/template.js'),
    import('../../src/multi-pine/fixture-service.js'), import('../../src/multi-pine/member-admission.js'), import('../../src/multi-pine/executor.js'), import('../../src/multi-pine/python-runner.js'),
    import('../../src/multi-pine/engine-closure.js'), import('../../src/multi-pine/package-closure.js'), import('../../src/postgres/mp-package-store.js'), import('../../src/postgres/pine-bridge.js'),
    import('../../src/postgres/quant-research.js'), import('../../src/postgres/pine-bridge-readiness.js'), import('../../src/postgres/pine-bridge-execution.js'), import('../../src/pine-bridge/contract.js'),
    import('../../src/comparison/context.js'), import('../../src/comparison/common.js'), import('pg')
  ]);
  modules = Object.freeze({
    PostgresDatabase: db.PostgresDatabase, Store: store.Store, rolePasswordClause: password.rolePasswordClause,
    migrateMpMemberSet: memberSetMigration.migrateMpMemberSet, inspectMpRunStore: runStoreMigration.inspectMpRunStore, migrateMpRunStore: runStoreMigration.migrateMpRunStore,
    migrateMpPackageStore: packageStoreMigration.migrateMpPackageStore, migrateQuantExposureRegister: exposureMigration.migrateQuantExposureRegister,
    storeBotState: memberSetStore.storeBotState, getMultiRun: runStore.getMultiRun, listMultiRuns: runStore.listMultiRuns,
    canonical: source.canonical, hash: source.hash, inspectSource: source.inspectSource, validateSelection: source.validateSelection, assemble: template.assemble,
    MultiPineFixtureService: fixtureService.MultiPineFixtureService, effectiveInputsHash: fixtureService.effectiveInputsHash,
    SPT_SIGNAL_MAPPING: admission.SPT_SIGNAL_MAPPING, SPT_CUSTOM_SETTINGS: admission.SPT_CUSTOM_SETTINGS,
    MultiPineFixtureExecutor: executor.MultiPineFixtureExecutor, createPythonRunner: runner.createPythonRunner, mpCombinedEngineHash: engineClosure.mpCombinedEngineHash,
    mpPackageTraceClosureHash: packageClosure.mpPackageTraceClosureHash, MultiPineFixturePackageService: packageStore.MultiPineFixturePackageService, PACKAGE_STORE_CODES: packageStore.PACKAGE_STORE_CODES,
    PineBridgeService: pineBridge.PineBridgeService, QuantResearchService: quantResearch.QuantResearchService, activateDeployment: readiness.activateDeployment,
    prepareBridgeExecution: bridgeExecution.prepareBridgeExecution, executionPrice: bridgeContract.executionPrice,
    validateRequest: comparisonContext.validateRequest, COMPARISON_CODES: comparisonCommon.CODES, pg: pg.default
  });
  return modules;
}

/** The committed fixtures the world needs (manifest, bars-v2): synthetic, public, labelled fixture. */
export async function loadFixtures() {
  if (fixtureCache) return fixtureCache;
  const read = async name => JSON.parse(await fs.readFile(new URL(name, FIXTURES), 'utf8'));
  const [manifest, bars] = await Promise.all([read('manifest.json'), read('bars-v2.json')]);
  const model = {version: 'paper-close-v1', price_tick: 0.01, quantity_step: 0.00001, fee_bps: 10, slippage_bps: 1, risk_percent: 0.05, data_profile: 'closed-ohlcv-atr14-v1'};
  const policy = {paperTrading: true, requireReduceOnlySell: true, ...manifest.policy};
  const start = bars.first_time, end = start + (bars.bar_count - 1) * MINUTE;
  fixtureCache = Object.freeze({manifest, bars, model, policy, start, end, now: end + 3600000, warmup: manifest.split.warmup, split: manifest.split, capital: manifest.capital});
  return fixtureCache;
}

/* ------------------------------------------------------------------ analyses ------------------------------------------------------------------ */

/**
 * A copy of a reviewed analysis with some effective values replaced and the hashes recomputed (RD-MP-43 with O7 answered yes: a fixture-labelled variant, kept only inside the throwaway
 * cluster). overrides: {pine_variable: value}. A variable the analysis does not hold refuses.
 */
export function variantAnalysis(M, analysis, overrides) {
  const copy = structuredClone(analysis);
  for (const [name, value] of Object.entries(overrides)) {
    const input = copy.inputs.find(item => item.pine_variable === name);
    if (!input) throw new PrivateInputError('PRIVATE_INPUT_SHAPE', 'variant');
    input.effective_value = value;
  }
  const effective = M.effectiveInputsHash(copy);
  copy.effective_inputs_hash = effective;
  copy.effective_input_review = {...copy.effective_input_review, effective_inputs_hash: effective};
  return copy;
}

/** The fixture input values of the manifest that differ between two named members (for example M2 and M2_ZERO), as {pine_variable: value} of the second. */
export function fixtureDifference(manifest, from, to) {
  const a = manifest.members[from].inputs, b = manifest.members[to].inputs;
  return Object.fromEntries(Object.entries(b).filter(([name, value]) => a[name] !== value));
}

/** O3: true when every fixture input value of a member is the effective value of the same variable in the analysis. A boolean only. */
export function analysisMatchesFixture(analysis, inputs) {
  const values = new Map(analysis.inputs.map(item => [item.pine_variable, item.effective_value]));
  return Object.entries(inputs).every(([name, value]) => values.has(name) && values.get(name) === value);
}

/** A synthetic analysis (the fixture analysisFor of the executor test) for the SYN fallback. */
export function syntheticAnalysis(M, inputs, sourceHash) {
  const list = Object.entries(M.SPT_CUSTOM_SETTINGS).map(([name, value]) => ({pine_variable: name, type: typeof value === 'boolean' ? 'bool' : 'string', effective_value: value}));
  list.push({pine_variable: 'emaFastInput', type: 'int', effective_value: inputs.emaFastInput}, {pine_variable: 'emaSlowInput', type: 'int', effective_value: inputs.emaSlowInput});
  list.push({pine_variable: 'minRiskATRInput', type: 'float', effective_value: inputs.minRiskATRInput});
  for (let i = list.length; i < 58; i++) list.push({pine_variable: 'fixtureInput' + i, type: 'int', effective_value: i});
  list.forEach((input, i) => Object.assign(input, {input_id: 'in-' + i, eligible: true, declared_domain: {min: null, max: null}}));
  const effective = M.effectiveInputsHash({inputs: list});
  return {inputs: list, declarations: ['buySignal', 'sellSignal'], effective_inputs_hash: effective,
    effective_input_review: {source_hash: sourceHash, effective_inputs_hash: effective, input_count: 58, reviewed_by: 'fixture-reviewer', reviewed_at: 1700000000000}};
}

/** A runner for the SYN fallback: the real job module with the source gate replaced by the fixture inputs of the member (same wrapper as the executor test). */
export function gatedRunner(M, inputsByImport) {
  return M.createPythonRunner({args: ['-c', GATE_WRAPPER], env: {MP_TEST_INPUTS: JSON.stringify(inputsByImport)}});
}

/* ------------------------------------------------------------------ the throwaway cluster ------------------------------------------------------------------ */

const LOG_CONTROLS = Object.freeze({log_statement: 'none', log_min_messages: 'panic', log_min_error_statement: 'panic', log_min_duration_statement: '-1',
  log_parameter_max_length: '0', log_parameter_max_length_on_error: '0'});

/** The boundary table is part of the preflight extension, which needs the whole foundation schema; the harness installs exactly the table, its function and its trigger from that file. */
async function boundarySql() {
  const body = await fs.readFile(new URL('quant-preflight-schema.sql', SRC), 'utf8');
  const start = body.indexOf('CREATE TABLE quant_holdout_boundaries('), marker = 'EXECUTE FUNCTION quant_holdout_boundary_write_once();', end = body.indexOf(marker) + marker.length;
  if (!(start >= 0 && end > start)) throw new PrivateInputError('HARNESS_SCHEMA_SOURCE');
  return body.slice(start, end);
}
const roleScript = async (file, roles) => { let body = await fs.readFile(file, 'utf8'); for (const [variable, value] of Object.entries(roles)) body = body.replaceAll(":'" + variable + "'", "'" + value + "'"); return body; };

/**
 * Creates the throwaway databases of one acceptance run and returns the context. TEST_DATABASE_URL names the cluster admin of a throwaway cluster (loopback). The main database gets the log controls
 * of RD-MP-43 (statement logging off, error logging at panic, no parameter logging) BEFORE any private byte is written, and the harness verifies them through a fresh session; if it cannot, it
 * refuses with PRIVATE_LOG_CONTROL_UNSAFE and writes nothing. The template database is built without any private content.
 *   bars: the parsed bars-v2.json fixture; the context owns the pools and close() drops databases and roles.
 */
export async function createAcceptanceContext() {
  const M = await loadModules(), F = await loadFixtures();
  const base = process.env.TEST_DATABASE_URL;
  if (!base) throw new PrivateInputError('TEST_DATABASE_URL_REQUIRED');
  const parsed = new URL(base);
  if (!['127.0.0.1', '::1', '[::1]', 'localhost'].includes(parsed.hostname)) throw new PrivateInputError('TEST_DATABASE_URL_NOT_LOOPBACK');
  const urlOf = (name, user) => { const url = new URL(base); url.pathname = '/' + name; if (user) url.username = user; return url.toString(); };
  const serialOf = (name, user) => { const url = new URL(urlOf(name, user)); url.searchParams.set('options', '-c default_transaction_isolation=serializable'); return url.toString(); };
  const ser = pool => { const original = pool.transaction.bind(pool); pool.transaction = (fn, options = {}) => original(fn, {isolation: 'SERIALIZABLE', ...options}); return pool; };
  const pools = [], extraRoles = [], databases = [];
  const track = pool => { pools.push(pool); return pool; };
  const ENGINE = await M.mpCombinedEngineHash(), CLOSURE = await M.mpPackageTraceClosureHash();
  const admin = new M.PostgresDatabase({connectionString: base});
  const suffix = randomUUID().replaceAll('-', '');
  const templateName = 'robot_pa_tpl_' + suffix, databaseName = 'robot_pa_main_' + suffix, runtimeName = 'robot_pa_rt_' + suffix.slice(0, 14), fixtureName = 'robot_pa_fx_' + suffix.slice(0, 14);
  databases.push(databaseName, templateName);
  const close = async () => {
    for (const pool of pools) await pool.close().catch(() => {});
    // a raw client: the application pool times a statement out after 15 s, and dropping a database can take longer
    const dropper = new M.pg.Client({connectionString: base});
    try {
      await dropper.connect();
      for (const name of databases) await dropper.query('DROP DATABASE IF EXISTS ' + name + ' WITH (FORCE)').catch(() => {});
      for (const name of extraRoles) await dropper.query('DROP ROLE IF EXISTS ' + name).catch(() => {});
    } finally { await dropper.end().catch(() => {}); await admin.close().catch(() => {}); }
  };
  try {
    for (const name of [runtimeName, fixtureName]) { await admin.query('CREATE ROLE ' + name + ' LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE' + M.rolePasswordClause()); extraRoles.push(name); }
    await admin.query('CREATE DATABASE ' + templateName);
    const builder = ser(new M.PostgresDatabase({connectionString: urlOf(templateName), max: 2}));
    try {
      await builder.migrate();
      for (const name of ['pine-bridge-schema.sql', 'quant-research-schema.sql']) await builder.transaction(async () => builder.query(await fs.readFile(new URL(name, SRC), 'utf8')));
      await builder.transaction(async () => builder.query(await boundarySql()));
      await M.migrateQuantExposureRegister(builder);
      await M.migrateMpMemberSet(builder);
      await M.migrateMpRunStore(builder);
      await M.migrateMpPackageStore(builder);
    } finally { await builder.close(); }
    await admin.query('CREATE DATABASE ' + databaseName + ' TEMPLATE ' + templateName);
    // leak controls first: database-level settings (a superuser setting), then a fresh session proves them
    let applied = true;
    for (const [name, value] of Object.entries(LOG_CONTROLS)) { try { await admin.query('ALTER DATABASE ' + databaseName + " SET " + name + " = '" + value + "'"); } catch { applied = false; } }
    const db = ser(track(new M.PostgresDatabase({connectionString: serialOf(databaseName), max: 8})));
    const seen = Object.fromEntries((await db.query('SELECT name, setting FROM pg_settings WHERE name = ANY($1::text[])', [Object.keys(LOG_CONTROLS)])).rows.map(row => [row.name, row.setting]));
    for (const [name, value] of Object.entries(LOG_CONTROLS)) if (seen[name] !== value) throw new PrivateInputError('PRIVATE_LOG_CONTROL_UNSAFE', applied ? name : 'not_applied');
    const store = new M.Store(db);
    await db.query(await roleScript(GRANT_SCRIPT, {runtime_role: runtimeName}));
    await db.query(await roleScript(RUN_FIXTURE_SCRIPT, {runtime_role: runtimeName, fixture_role: fixtureName}));
    await db.query(await roleScript(PACKAGE_FIXTURE_SCRIPT, {runtime_role: runtimeName, fixture_role: fixtureName}));
    const fx = ser(track(new M.PostgresDatabase({connectionString: serialOf(databaseName, fixtureName), max: 8})));
    const fx2 = ser(track(new M.PostgresDatabase({connectionString: serialOf(databaseName, fixtureName), max: 4})));
    const rt = ser(track(new M.PostgresDatabase({connectionString: serialOf(databaseName, runtimeName), max: 2})));
    const report = await M.inspectMpRunStore(db, {runtimeRole: runtimeName, fixtureRole: fixtureName});
    if (report.ok !== true) throw new PrivateInputError('HARNESS_RUN_STORE_NOT_INSTALLED');
    // the verified bars of the dataset, as the market-data writer stores them
    const rows = F.bars.bars.map(bar => ({time: bar.time, open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume, atr14: bar.atr14, price_tick: F.bars.price_tick, quantity_step: F.bars.quantity_step}));
    const provenance = {profile: F.model.data_profile, source: F.bars.provenance.source, fixture: true};
    await db.query(`INSERT INTO pine_market_bars SELECT 'binance-global','BTCUSDT','1',t,b::jsonb,$4::jsonb,h FROM unnest($1::bigint[],$2::text[],$3::text[]) AS u(t,b,h)`,
      [rows.map(row => row.time), rows.map(row => JSON.stringify(row)), rows.map(row => M.hash(M.canonical(row))), JSON.stringify(provenance)]);
    let tick = 0;
    const ctx = {
      M, F, admin, db, store, fx, fx2, rt, ENGINE, CLOSURE, databaseName, runtimeName, fixtureName, close, urlOf, serialOf, ser, track, databases,
      bars: F.bars, rows,
      /** The admission service on a fixture-role handle for a supported source hash. */
      admission(sourceHash, handle = fx) {
        const own = new M.Store(handle);
        return new M.MultiPineFixtureService({db: handle, store: own, readBotState: M.storeBotState({store: own, defaultRisk: F.policy}), clock: () => F.now, engineHash: ENGINE, supported_source_hash: sourceHash});
      },
      /** The package service; the clock is strictly increasing so records order. */
      packages(handle = fx, over = {}) {
        const own = new M.Store(handle);
        return new M.MultiPineFixturePackageService({db: handle, store: own, readBotState: M.storeBotState({store: own, defaultRisk: F.policy}), clock: () => F.now + 5000 + (tick++), engineHash: () => ENGINE, ...over});
      },
      /** The executor with a runner: the real default runner (the unreplaced source gate) when none is given. */
      executor(runner = M.createPythonRunner(), handle = fx) {
        const own = new M.Store(handle);
        return new M.MultiPineFixtureExecutor({db: handle, store: own, readBotState: M.storeBotState({store: own, defaultRisk: F.policy}), clock: () => F.now + 1000, runEvaluator: runner, engineHash: () => ENGINE});
      }
    };
    return ctx;
  } catch (error) {
    await close();
    throw error;
  }
}

/* ------------------------------------------------------------------ worlds ------------------------------------------------------------------ */

const JOB_SQL = `INSERT INTO pine_bridge_jobs(job_id,owner_id,bot_id,operation,idempotency_key,request_hash,request,pine_import_id,status,created_at,updated_at,deadline,result)
  VALUES($1,$2,$3,'generate',$4,$5,'{}',$6,'SUCCEEDED',$7,$7,$7,$8)`;
const evidenceFor = (snapshot, snapshotHash, tag, model) => ({snapshot_hash: snapshotHash, artifact_hash: snapshot.artifact_hash, source_hash: snapshot.source_hash, compilation_errors: 0, warnings: 0, reviewed_warnings: 0,
  binding_coverage: 100, source_changed_bytes: 0, unresolved_references: 0, identifier_collisions: 0, duplicate_bindings: 0, native_alerts_isolated: true,
  effective_inputs_reviewed: true, signals_reviewed: true, cases: {sl: 10, tp: 10, native_and_bridge: 5, both_touched: 5, rejected: 5, capped: 5, buy: 1, targeted_exit: 1, duplicate_delivery: 1},
  decision_match_percent: 100, duplicate_ledger_effects: 0, unrelated_payloads: 0, level_difference_ticks: 0, execution_model: structuredClone(model),
  references: {tradingview: tag + '-tv', source_review: tag + '-sr', paper_fixture: tag + '-pf'}});

/**
 * A new owner (= Bot) with one connected member per analysis, each with the given source, its own reviewed analysis, a DRAFT deployment with an assemble() artifact, Bridge evidence and a
 * generate job (mp-executor.test.mjs newWorld). db is the cluster-admin handle, store a Store on it. options:
 *   source        the source text (the reviewed SPT source, or SYN_SOURCE for the SYN fallback)
 *   sourceHash    its SHA-256, the supported source hash of the admission service
 *   analyses      one analysis object per member in ordinal order (2 or 3)
 *   bars          the parsed bars fixture; its first_time and bar_count give the dataset
 *   warmup_bars   the dataset warm-up (default: the fixture manifest's)
 * Returns {id, bot, specs: [{n, pine, dep, analysis}], dataset, sourceHash}. The source and the analyses are written only through guard().
 */
export async function newAcceptanceWorld(db, store, {source, sourceHash, analyses, bars, warmup_bars} = {}) {
  const M = await loadModules(), F = await loadFixtures();
  if (typeof source !== 'string' || typeof sourceHash !== 'string' || !Array.isArray(analyses) || analyses.length < 1 || !bars) throw new PrivateInputError('HARNESS_WORLD_INPUT');
  if (M.hash(source) !== sourceHash) throw new PrivateInputError('PRIVATE_INPUT_HASH_MISMATCH', 'world_source');
  const user = await store.createUser({email: 'pa-' + randomUUID() + '@example.test', passwordHash: 'unused-fixture-hash'});
  const bot = user.id;
  await db.query("INSERT INTO paper_funding(user_id,broker,at,equity_delta,cash_delta,kind) VALUES($1,'binance-global',$2,$3,$3,'CONFIGURATION')", [bot, T0, F.capital.equity]);
  const capital = await store.paperAccounts(bot);
  const funding_cutoff = (await db.query('SELECT COALESCE(max(id),0)::int AS cutoff FROM paper_funding WHERE user_id=$1', [bot])).rows[0].cutoff;
  const ids = Array.from({length: analyses.length}, () => randomUUID()).sort();
  const deps = Array.from({length: analyses.length}, () => randomUUID()).sort();
  const specs = ids.map((id, i) => ({n: i + 1, pine: id, dep: deps[i], analysis: analyses[i]}));
  for (const m of specs) {
    const analysisJson = JSON.stringify(m.analysis);
    await guard('seed_pine_sources', () => db.query('INSERT INTO pine_sources VALUES($1,$2,$3,1,$4,$5,$6,$7,$8)', [m.pine, user.id, bot, sourceHash, 'Member fixture', source, analysisJson, T0]));
    await guard('seed_pine_source_revisions', () => db.query('INSERT INTO pine_source_revisions VALUES($1,1,$2,$3,$4,$5)', [m.pine, sourceHash, source, analysisJson, T0]));
    await db.query('INSERT INTO pine_memberships(pine_import_id,owner_id,bot_id,source_version,connected) VALUES($1,$2,$3,1,true)', [m.pine, user.id, bot]);
  }
  const projection = specs.map(m => ({pine_import_id: m.pine, source_version: 1, source_hash: sourceHash, analysis: m.analysis}));
  const selection = await guard('seed_selection', () => M.validateSelection(M.inspectSource(source), {...M.SPT_SIGNAL_MAPPING}, []));
  for (const m of specs) {
    const artifact = await guard('seed_assemble', () => M.assemble(source, selection, {deployment_id: m.dep, pine_import_id: m.pine, source_version: 1, ...MARKET}).integrated_pine);
    const snapshot = {policy: F.policy, policy_hash: M.hash(M.canonical(F.policy)), capital, funding_cutoff, membership: projection, session: {state: 'SETUP', run_id: null}, captured_at: 1,
      selection, market: {deployment_id: m.dep, pine_import_id: m.pine, source_version: 1, ...MARKET}, source_hash: sourceHash, instruction_versions: {template: 'fixture'}, artifact_hash: M.hash(artifact)};
    const snapshotHash = M.hash(M.canonical(snapshot)), body = evidenceFor(snapshot, snapshotHash, 'fixture-' + m.n, F.model);
    await guard('seed_deployment', () => db.query("INSERT INTO pine_deployments(deployment_id,owner_id,bot_id,pine_import_id,source_version,snapshot,snapshot_hash,state,created_at) VALUES($1,$2,$3,$4,1,$5,$6,'DRAFT',$7)",
      [m.dep, user.id, bot, m.pine, JSON.stringify(snapshot), snapshotHash, T0]));
    await db.query('INSERT INTO pine_bridge_evidence(deployment_id,snapshot_hash,evidence,evidence_hash,recorded_at) VALUES($1,$2,$3,$4,$5)', [m.dep, snapshotHash, JSON.stringify(body), M.hash(M.canonical(body)), T0]);
    await guard('seed_job', () => db.query(JOB_SQL, [randomUUID(), user.id, bot, randomUUID(), M.hash('request-' + randomUUID()), m.pine, T0, JSON.stringify({integrated_pine: artifact, deployment_id: m.dep, artifact_status: 'DRAFT'})]));
  }
  const start = bars.first_time, end = start + (bars.bar_count - 1) * MINUTE;
  return {id: user.id, bot, specs, sourceHash, dataset: {start_time: start, end_time: end, warmup_bars: warmup_bars ?? F.warmup}};
}

export const namesOf = world => world.specs.map(m => ({pine_import_id: m.pine, deployment_id: m.dep}));
export const keyOf = () => 'pa-key-' + randomUUID().replaceAll('-', '');
export const inputOf = (world, over = {}) => ({owner_id: world.id, bot_id: world.bot, fixture: true, idempotency_key: keyOf(), member_deployments: namesOf(world), bridge_domains: structuredClone(V2_DOMAINS),
  dataset: {...world.dataset}, budget: {candidates: 30}, seed: 42, ...over});

/** Admits a run of the world through the fixture admission service. Returns the service result (ok false is a refusal with a code). */
export const admitWorldRun = (ctx, world, over = {}, handle = ctx.fx) => ctx.admission(world.sourceHash, handle).admit(inputOf(world, over));

/**
 * Admits and executes one run to a terminal event with the given runner (default: the real runner with the unreplaced source gate).
 * Returns {admitted, run_id, out, events} where events are the stored events {seq, status, reason_code, result, result_hash}. Failures are codes only.
 */
export async function runWorld(ctx, world, {runner, over = {}} = {}) {
  const admitted = await admitWorldRun(ctx, world, over);
  if (admitted.ok !== true) return {admitted, run_id: null, out: null, events: []};
  const out = await ctx.executor(runner).execute({owner_id: world.id, run_id: admitted.run.run_id});
  const events = (await ctx.db.query('SELECT seq,status,reason_code,result,result_hash FROM mp_research_run_events WHERE run_id=$1 ORDER BY seq', [admitted.run.run_id])).rows;
  return {admitted, run_id: admitted.run.run_id, out, events};
}

/* ------------------------------------------------------------------ digests (hashes only) ------------------------------------------------------------------ */

const rowDigest = async (db, table, where = '', params = []) => (await db.query(`SELECT count(*)::int n,encode(sha256(convert_to(COALESCE(string_agg(row_to_json(t)::text,'|' ORDER BY row_to_json(t)::text),''),'UTF8')),'hex') d FROM public.${table} t ${where}`, params)).rows[0];

/** A digest of every table of the schema and every sequence: what a side effect would change. Only counts and hashes leave the database. */
export async function digestAll(db) {
  const tables = (await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY tablename")).rows.map(row => row.tablename);
  const out = {};
  for (const table of tables) out[table] = await rowDigest(db, table);
  const sequences = (await db.query("SELECT string_agg(sequencename||':'||COALESCE(last_value::text,'-'),',' ORDER BY sequencename) AS s FROM pg_sequences WHERE schemaname='public'")).rows[0].s;
  out._sequences = {n: 0, d: sha256Hex(String(sequences ?? ''))};
  return out;
}
/** One hash of a digest map without the named tables (the tables the step may change). */
export const digestHash = (digest, except = []) => sha256Hex(JSON.stringify(Object.entries(digest).filter(([name]) => !except.includes(name)).sort(([a], [b]) => (a < b ? -1 : 1))));
/** The names of the tables whose digest differs (table names are safe to print). */
export const changedTables = (before, after, except = []) => Object.keys({...before, ...after}).filter(name => !except.includes(name) && before[name]?.d !== after[name]?.d || (!except.includes(name) && before[name]?.n !== after[name]?.n));

export const PACKAGE_TABLES = Object.freeze(['mp_package_blobs', 'mp_package_exports', 'mp_package_files', 'mp_package_status_events', 'mp_package_attempts', 'mp_package_validations', 'mp_package_compile_records',
  'mp_package_evidence_records', 'mp_package_clearances', 'mp_package_trace_records']);
export const SIDE_TABLES = Object.freeze(['mp_research_runs', 'mp_research_run_events', 'mp_member_sets', 'mp_member_set_members', 'pine_deployments', 'pine_memberships', 'pine_sources', 'pine_source_revisions',
  'paper_funding', 'quant_exposure_register', 'quant_jobs', 'audit']);
export const packageDigest = async db => Object.fromEntries(await Promise.all(PACKAGE_TABLES.map(async table => [table, await rowDigest(db, table)])));
export const sideDigest = async db => Object.fromEntries(await Promise.all(SIDE_TABLES.map(async table => [table, await rowDigest(db, table)])));
export const packageCounts = async db => Object.fromEntries(await Promise.all(PACKAGE_TABLES.map(async table => [table, (await db.query(`SELECT count(*)::int n FROM public.${table}`)).rows[0].n])));
export const rowsFor = async (db, table, exportId) => (await db.query(`SELECT * FROM public.${table} WHERE export_id=$1`, [exportId])).rows;

/* ------------------------------------------------------------------ writes the insert-only guards would refuse (cluster admin only) ------------------------------------------------------------------ */

/**
 * A write the insert-only guards would refuse: the cluster admin of the throwaway cluster switches the user triggers of ONE table off, writes, and switches each trigger back to the state it had,
 * in one committed transaction (the quietWrite of test/postgres/mp-package-build.test.mjs).
 */
export const quietWrite = (db, table, sql, params = []) => db.transaction(async () => {
  const triggers = (await db.query('SELECT tgname,tgenabled FROM pg_trigger WHERE tgrelid=$1::regclass AND NOT tgisinternal', [table])).rows;
  await db.query('ALTER TABLE ' + table + ' DISABLE TRIGGER USER');
  const out = await db.query(sql, params);
  for (const {tgname, tgenabled} of triggers) await db.query('ALTER TABLE ' + table + ({O: ' ENABLE TRIGGER ', A: ' ENABLE ALWAYS TRIGGER ', R: ' ENABLE REPLICA TRIGGER ', D: ' DISABLE TRIGGER '}[tgenabled]) + tgname);
  return out;
}, {isolation: 'SERIALIZABLE'});

/**
 * F18 setup: one default of the text changes by one byte. It looks for, in this order, the first numeric default of an input.int or input.float call, the first boolean default of an input.bool call
 * (true and false swap), and finally any digit. C2 compares the whole member file with the assemble() of the original bytes and the pair, so any byte outside the approved edits is a logic change.
 * A text with none of them refuses.
 */
export function changeOneDefaultByte(text) {
  const number = /(input\.(?:int|float)\([^)\d]*?)(\d)/.exec(text);
  if (number) { const at = number.index + number[1].length; return text.slice(0, at) + String((Number(text[at]) + 1) % 10) + text.slice(at + 1); }
  const bool = /(input\.bool\([^)]*?\b)(true|false)\b/.exec(text);
  if (bool) { const at = bool.index + bool[1].length; return text.slice(0, at) + (bool[2] === 'true' ? 'false' : 'true') + text.slice(at + bool[2].length); }
  const digit = /\d/.exec(text);
  if (digit) return text.slice(0, digit.index) + String((Number(digit[0]) + 1) % 10) + text.slice(digit.index + 1);
  throw new PrivateInputError('PRIVATE_TAMPER_NO_SITE', 'member_file');
}

/**
 * Replaces the stored bytes of ONE package file by mutate(text) (cluster admin only, a new blob and an updated file row). The stored integrity check of the package service still passes
 * (file hash and size agree); the manifest, which names the old checksum, is not rewritten. Returns the SHA-256 of the old and the new file (hashes only).
 */
export async function tamperStoredFile(ctx, exportId, filePath, mutate) {
  const {M, db} = ctx;
  const row = (await db.query("SELECT f.sha256, convert_from(b.content,'UTF8') AS t FROM public.mp_package_files f JOIN public.mp_package_blobs b ON b.sha256=f.sha256 WHERE f.export_id=$1 AND f.path=$2", [exportId, filePath])).rows[0];
  if (!row) throw new PrivateInputError('HARNESS_FILE_NOT_FOUND', 'package_file');
  const bytes = Buffer.from(mutate(row.t), 'utf8'), changed = M.hash(bytes);
  await guard('tamper_blob', () => db.query('INSERT INTO public.mp_package_blobs(sha256,size,content) VALUES($1,$2,$3) ON CONFLICT (sha256) DO NOTHING', [changed, bytes.length, bytes]));
  await quietWrite(db, 'public.mp_package_files', 'UPDATE public.mp_package_files SET sha256=$3, bytes=$4 WHERE export_id=$1 AND path=$2', [exportId, filePath, changed, bytes.length]);
  return {old_sha256: row.sha256, new_sha256: changed};
}

/* ------------------------------------------------------------------ F22: the three multi-Pine refusals still fire after a run ------------------------------------------------------------------ */

const DOMAINS = {atr_multiplier: {min: '1', max: '3', step: '0.5'}, rr: {min: '0.5', max: '2.5', step: '0.5'}};
const codeOfRejection = async promise => { try { await promise; return 'NO_REJECTION'; } catch (error) { return typeof error?.code === 'string' ? error.code : 'UNEXPECTED_ERROR'; } };

/**
 * T-R1 to T-R3 on the world after its run: the public enqueue, the activation and the BUY execution refuse (RD-MP-43 F22). The first deployment is set READY for the duration of the call and
 * set back to DRAFT at the end. Returns the three rejection codes. Rows it adds: one signal and one Bridge event of the Bot (the executor test adds the same).
 */
export async function multiPineRefusals(ctx, world) {
  const {M, F, db, store} = ctx;
  const pine = new M.PineBridgeService(store, {defaultRisk: F.policy});
  const dep = world.specs[0].dep;
  await db.query("UPDATE pine_deployments SET state='READY' WHERE deployment_id=$1", [dep]);
  try {
    const quant = new M.QuantResearchService({pineService: pine, clock: () => F.now, supportedSourceHash: world.sourceHash, foundation: false});
    const t1 = await codeOfRejection(db.transaction(() => quant.enqueue(world.id, {bot_id: world.bot, deployment_id: dep, parameter_slots: [], bridge_domains: DOMAINS, dataset: world.dataset, budget: {candidates: 30}, seed: 42}, keyOf())));
    const t2 = await codeOfRejection(M.activateDeployment(pine, world.id, dep));
    const bar = F.bars.bars[100], row = ctx.rows[100];
    const signalId = (await db.query(`INSERT INTO signals(user_id,trade_id,received_at,signal_time,broker,symbol,event,side,payload,status)
      VALUES($1,$2,$3,$3,'binance-global','BTCUSDT','BUY','BUY','{}','PENDING') RETURNING id`, [world.bot, 'tr3-' + randomUUID(), T0])).rows[0].id;
    await db.query('INSERT INTO pine_bridge_events(deployment_id,event_id,event_hash,entry_ref,bar_time,payload,signal_id,outcome) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
      [dep, 'tr3-event', M.hash('tr3'), dep + ':' + bar.time + ':0', bar.time, JSON.stringify({event_type: 'BUY'}), signalId, 'QUEUED']);
    const evidence = (await db.query('SELECT evidence_hash FROM pine_bridge_evidence WHERE deployment_id=$1', [dep])).rows[0].evidence_hash;
    const t3 = await codeOfRejection(M.prepareBridgeExecution(store, {id: signalId, user_id: world.bot}, {referencePrice: M.executionPrice(Number(bar.close), 'BUY', F.model.slippage_bps, F.model.price_tick),
      bridge: {deployment_id: dep, event_id: 'tr3-event', event_type: 'BUY', bar_time: bar.time, evidence_hash: evidence, market_hash: M.hash(M.canonical(row))}}, F.policy));
    return {t_r1: t1, t_r2: t2, t_r3: t3};
  } finally {
    await db.query("UPDATE pine_deployments SET state='DRAFT' WHERE deployment_id=$1", [dep]);
  }
}
