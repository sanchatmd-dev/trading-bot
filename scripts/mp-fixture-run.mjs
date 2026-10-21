import {PostgresDatabase} from '../src/postgres/db.js';
import {Store} from '../src/postgres/store.js';
import {storeBotState} from '../src/postgres/mp-member-set-store.js';
import {config} from '../src/config.js';
import {MultiPineFixtureExecutor, readFixtureRole} from '../src/multi-pine/executor.js';
import {createPythonRunner} from '../src/multi-pine/python-runner.js';
import {mpCombinedEngineHash} from '../src/multi-pine/engine-closure.js';

// F11 S3 operator script: run ONE admitted internal multi-Pine fixture run to a terminal event (docs/MULTI_PINE_CONTRACT.md RD-MP-32).
//   node scripts/mp-fixture-run.mjs --isolated-cluster --owner-id=OWNER --run-id=RUN_UUID [--sweep]
//   MP_FIXTURE_DATABASE_URL=postgresql://<fixture role>:<password>@127.0.0.1:<port>/<database>
// ISOLATED LOCAL CLUSTERS ONLY. The run store is never installed on staging or production before APP-3B, and this script starts no service, installs nothing, and
// opens no connection to any host. It refuses to start unless ALL of these hold:
//   1. the flag --isolated-cluster is given explicitly (it is never inferred);
//   2. MP_FIXTURE_DATABASE_URL names a loopback host (127.0.0.1, ::1 or localhost) and carries NO query parameter at all (pg lets `?host=` override the host of the
//      URL, and `?options=` can set search_path; the script adds its own isolation option); DATABASE_URL is never read;
//   3. the connected role is the FIXTURE role of scripts/grant-postgres-mp-fixture.sql: not a superuser, not the owner of a run-store table, SELECT and INSERT on the
//      run and event tables, and no UPDATE, DELETE or TRUNCATE on them; the run-store marker is installed;
//   4. NODE_ENV is not production.
// --sweep ends a RUNNING run past its deadline (TIMED_OUT JOB_DEADLINE_EXCEEDED) instead of executing. SIGINT or SIGTERM aborts the running step and ends the run
// CANCELLED RESEARCH_INTERRUPTED. The Python job runs in a direct child process (src/multi-pine/python-runner.js). Output: one JSON line, no secrets.
// Exit status: 0 when the call completed (including a run that ended FAILED, CANCELLED or TIMED_OUT, which is a recorded outcome), 1 on a refusal or a defect.
// A defect prints one JSON line {"ok":false,"error":"<CODE>"} on stderr and nothing else: no message, stack, SQL or database detail.

const args = process.argv.slice(2);
const OWNER = /^--owner-id=([A-Za-z0-9][A-Za-z0-9_.:-]{0,127})$/, RUN = /^--run-id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '[::1]', 'localhost']);
const fail = (message, code = 1) => { console.error(JSON.stringify({ok: false, error: message})); process.exit(code); };

const known = arg => arg === '--isolated-cluster' || arg === '--sweep' || OWNER.test(arg) || RUN.test(arg);
if (args.some(arg => !known(arg))) fail('USAGE: node scripts/mp-fixture-run.mjs --isolated-cluster --owner-id=OWNER --run-id=RUN_UUID [--sweep]', 2);
if (!args.includes('--isolated-cluster')) fail('REFUSED: --isolated-cluster is required (isolated local clusters only; never staging or production)', 2);
const owner_id = args.map(arg => OWNER.exec(arg)?.[1]).find(Boolean), run_id = args.map(arg => RUN.exec(arg)?.[1]).find(Boolean);
if (!owner_id || !run_id) fail('USAGE: --owner-id and --run-id are required', 2);
if (args.filter(arg => OWNER.test(arg)).length !== 1 || args.filter(arg => RUN.test(arg)).length !== 1) fail('USAGE: give --owner-id and --run-id once', 2);
if (process.env.NODE_ENV === 'production') fail('REFUSED: NODE_ENV is production', 2);

const raw = process.env.MP_FIXTURE_DATABASE_URL;
if (!raw) fail('REFUSED: MP_FIXTURE_DATABASE_URL (the fixture-role connection of an isolated cluster) is required', 2);
let url;
try { url = new URL(raw); } catch { fail('REFUSED: MP_FIXTURE_DATABASE_URL is not a URL', 2); }
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !LOOPBACK.has(url.hostname)) fail('REFUSED: the connection must name a loopback host (isolated cluster only)', 2);
if (url.search !== '' || url.hash !== '' || raw.includes('?')) fail('REFUSED: MP_FIXTURE_DATABASE_URL must not carry a query parameter (host, options, ... are set by this script only)', 2);
url.searchParams.set('options', '-c default_transaction_isolation=serializable');

const controller = new AbortController();
for (const name of ['SIGINT', 'SIGTERM']) process.on(name, () => controller.abort());
let exitCode = 0, db = null;
try {
  db = new PostgresDatabase({connectionString: url.toString(), max: 4});
  let facts;
  try { facts = await readFixtureRole(db); }
  catch { fail('REFUSED: the run store is not installed on this cluster or the role cannot read it'); }
  if (!facts.fixture_role) fail('REFUSED: the connected role is not the fixture role of scripts/grant-postgres-mp-fixture.sql');
  const store = new Store(db);
  const executor = new MultiPineFixtureExecutor({
    db, store, readBotState: storeBotState({store, defaultRisk: config.defaultRisk}), clock: Date.now,
    runEvaluator: createPythonRunner(), engineHash: () => mpCombinedEngineHash()
  });
  const out = args.includes('--sweep') ? await executor.sweep({owner_id, run_id}) : await executor.execute({owner_id, run_id, signal: controller.signal});
  console.log(JSON.stringify({run_id, ...out}));
  exitCode = out.ok ? 0 : 1;
} catch (error) {
  // A defect: only a code leaves, never a message, stack or database detail.
  const code = typeof error?.code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(error.code) ? error.code : 'UNEXPECTED_ERROR';
  console.error(JSON.stringify({ok: false, error: code}));
  exitCode = 1;
} finally {
  try { await db?.close(); } catch { /* nothing to report */ }
}
process.exitCode = exitCode;
