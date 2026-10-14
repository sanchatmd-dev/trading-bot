import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as H from './fixtures/dp1s-r5-signal/host.mjs';
import * as L from './fixtures/dp1s-r5-signal/lib.mjs';

const fixture = fileURLToPath(new URL('./fixtures/dp1s-r5-signal/', import.meta.url));
const names = ['must', 'codeOf', 'canon', 'sleep', 'termPoint', 'timeLeft', 'needTime',
  'startOut', 'stopWorker', 'startWorker', 'startLimitWait', 'startWithLimit', 'rbMain'];
const scenarios = ['slow-stop', 'first-start', 'start-limit-recovery', 'start-limit-exhaustion'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const identity = bytes => ({ bytes: bytes.length, sha256: sha(bytes) });
const read = name => fs.readFileSync(path.join(fixture, name));

test('DP1-S r5 signal projection preserves frozen source and selected exports', () => {
  const manifestBytes = read('provenance.json');
  assert.equal(sha(manifestBytes), 'e4d3289c7283fca022c84e1790607c20702e0e3f5cffb2c1be86a3604a7f3158');
  const m = JSON.parse(manifestBytes);
  assert.equal(m.schema, 'dp1s-r5-signal-projection-v1');
  assert.equal(m.originals['lib.mjs'].sha256, 'e31c644b3a10cf80cdce09728ef950a4401ac5b301b98fc7a49448378474cb72');
  assert.equal(m.originals['host.mjs'].sha256, 'db1847ecacb136e1005be80ff5d476b72818c7b132433fdc9586c3178c85a4ca');
  assert.equal(m.originals['EVIDENCE.json'].sha256, '9fea067302b997bfee4c5a429ce3cb0c6ff0fa076eeb4b268e90da3e1c461031');
  assert.deepEqual(m.generated['signal-r5.mjs'], m.originals['signal-r5.mjs']);
  for (const [name, expected] of Object.entries(m.generated)) assert.deepEqual(identity(read(name)), expected, name);
  assert.deepEqual(Object.keys(H).sort(), [...names].sort());
  assert.deepEqual(Object.keys(L).sort(), ['LIMITS', 'PRELUDE']);
  assert.deepEqual(Object.keys(m.functions).sort(), [...names].sort());
  for (const name of names) assert.deepEqual(identity(Buffer.from(H[name].toString())), m.functions[name], name);
  const lib = read('lib.mjs').toString();
  const limits = lib.slice(lib.indexOf('export const LIMITS='), lib.indexOf('\nexport const PRELUDE='));
  const prelude = lib.slice(lib.indexOf('export const PRELUDE='), -1);
  assert.deepEqual(identity(Buffer.from(limits)), m.exports.LIMITS.statement);
  assert.deepEqual(identity(Buffer.from(prelude)), m.exports.PRELUDE.statement);
  assert.deepEqual(identity(Buffer.from(JSON.stringify(L.LIMITS))), m.exports.LIMITS.value);
  assert.deepEqual(identity(Buffer.from(L.PRELUDE)), m.exports.PRELUDE.value);
});

// The detached group belongs only to this synthetic fixture. GNU timeout runs in
// foreground mode, so payload and seam commands remain in that group. /proc
// observations below cover this group only, not global process containment.
function signalGroup(pid) {
  try { process.kill(-pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
}

function liveGroup(pid) {
  const live = [];
  for (const name of fs.readdirSync('/proc').filter(name => /^\d+$/.test(name))) {
    let stat;
    try { stat = fs.readFileSync(`/proc/${name}/stat`, 'utf8'); }
    catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) continue; throw error; }
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (Number(fields[2]) === pid && !['Z', 'X'].includes(fields[0])) live.push(Number(name));
  }
  return live;
}

async function runFixture(output) {
  const child = spawn(process.execPath, [path.join(fixture, 'signal-r5.mjs'), output], {
    detached: true, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let stdout = '', stderr = '', bytes = 0, failure = null;
  const timer = setTimeout(() => { failure = 'OUTER_WALL_55000MS'; signalGroup(child.pid); }, 55_000);
  const capture = key => chunk => {
    bytes += chunk.length;
    if (bytes > 2 * 1024 * 1024) { failure = 'OUTER_OUTPUT_2MIB'; signalGroup(child.pid); return; }
    if (key === 'stdout') stdout += chunk; else stderr += chunk;
  };
  child.stdout.on('data', capture('stdout'));
  child.stderr.on('data', capture('stderr'));
  try {
    return await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (status, signal) => resolve({ status, signal, failure, stdout, stderr }));
    });
  } finally {
    clearTimeout(timer);
    if (child.pid) {
      const before = liveGroup(child.pid);
      signalGroup(child.pid);
      for (let attempt = 0; liveGroup(child.pid).length && attempt < 20; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      const remaining = liveGroup(child.pid);
      if (remaining.length) throw Object.assign(new Error('Live fixture group members remain after cleanup'), { retainTemp: true });
      assert.deepEqual(before, [], 'Fixture exited while descendants remained alive');
    }
  }
}

function caseEvidence(output, scenario) {
  const dir = path.join(output, scenario);
  const json = name => JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
  const transport = json('transport.json');
  return { scenario, state: json('state.json'), events: fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').trim().split('\n').map(JSON.parse),
    transport, report: JSON.parse(transport.stdout.trim()) };
}

test('DP1-S r5 Linux GNU timeout signal ordering (synthetic seam only)', {
  skip: process.platform !== 'linux' ? 'Linux GNU timeout required; Windows provides integrity evidence only' : false,
  timeout: 60_000,
}, async t => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'dp1s-r5-signal-'));
  const output = path.join(temp, 'results');
  let passed = false;
  let cleanupSafe = true;
  try {
    const execution = await runFixture(output);
    t.diagnostic(JSON.stringify({ outer: { status: execution.status, signal: execution.signal, failure: execution.failure,
      stdout: execution.stdout.trim().slice(0, 4096), stderrBytes: Buffer.byteLength(execution.stderr) } }));
    assert.equal(execution.failure, null);
    assert.equal(execution.signal, null);
    assert.equal(execution.status, 0);
    assert.equal(execution.stderr, '');
    assert.deepEqual(JSON.parse(execution.stdout.trim()), { cases: 4, passed: 4 });
    const results = JSON.parse(fs.readFileSync(path.join(output, 'results.json'), 'utf8'));
    assert.equal(results.schema, 'dp1s-r5-linux-signal-v1');
    assert.equal(results.scaled, true);
    assert.equal(results.systemdProven, false);
    assert.deepEqual(results.results.map(row => row.scenario), scenarios);
    for (const [i, scenario] of scenarios.entries()) {
      const { state, transport, report, events } = caseEvidence(output, scenario);
      const row = results.results[i];
      const exhaustion = scenario === 'start-limit-exhaustion';
      const recovery = scenario === 'start-limit-recovery';
      const expected = ['archive', 'reload', 'stop-begin', 'stop-end', 'start-begin', 'start-end'];
      if (!exhaustion) expected.push('term-handler');
      if (recovery) expected.push('start-begin', 'start-end');
      expected.push('report');
      t.diagnostic(JSON.stringify({ scenario, state, status: transport.status, signal: transport.signal,
        error: transport.error, report: { code: report.code, phase: report.phase, effects: report.effects,
          startLimitWaitMs: report.startLimitWaitMs }, events }));
      assert.deepEqual(events.map(event => event.event), expected, scenario);
      assert.ok(events.every((event, j) => Number.isSafeInteger(event.at) && (j === 0 || event.at >= events[j - 1].at)), scenario);
      assert.deepEqual(state, exhaustion ? { active: 'failed', pid: 0, result: 'start-limit-hit', starts: 1 }
        : { active: 'active', pid: 2, result: 'success', starts: recovery ? 2 : 1 }, scenario);
      assert.equal(transport.status, exhaustion ? 0 : 124, scenario);
      assert.equal(transport.signal, null, scenario);
      assert.equal(transport.error, null, scenario);
      assert.equal(transport.stderr, '', scenario);
      assert.equal(report.code, exhaustion ? 'RB_START_LIMIT_WAIT' : 'TERMINATED', scenario);
      assert.equal(report.phase, 'EFFECT', scenario);
      assert.equal(report.pass, false, scenario);
      assert.equal(report.verdict, 'STOP', scenario);
      assert.equal(report.branch, 'A', scenario);
      assert.equal(report.noRetry, true, scenario);
      assert.deepEqual(report.effects, { pending: 'NOT_ATTEMPTED', archive: 'ARCHIVED', reload: 'RELOADED', stop: 'STOPPED_VERIFIED', start: 'ATTEMPTED' }, scenario);
      assert.equal(report.startLimitWaitMs, recovery ? 1900 : 0, scenario);
      assert.deepEqual(row.events, events, scenario);
      assert.equal(row.pass, true, scenario);
      assert.equal(row.rc, transport.status, scenario);
      assert.equal(row.signal, null, scenario);
      assert.equal(row.code, report.code, scenario);
      assert.equal(row.oldWorkerStarted, !exhaustion, scenario);
      assert.equal(row.sectionMs, exhaustion ? 6400 : 6900, scenario);
      assert.equal(row.waitAllowanceMs, exhaustion ? 1500 : 2000, scenario);
      assert.equal(row.killAfterMs, exhaustion ? 7400 : 7900, scenario);
      assert.equal(row.parentWallMs, exhaustion ? 10100 : 10600, scenario);
      if (scenario === 'slow-stop') assert.ok(events[3].at - events[2].at >= 1000);
      if (scenario === 'first-start') assert.ok(events[5].at - events[4].at >= 1000);
      if (recovery) assert.ok(events[7].at - events[5].at >= 1900);
    }
    passed = true;
  } catch (error) {
    cleanupSafe = error.retainTemp !== true;
    throw error;
  } finally {
    if (!passed) {
      for (const scenario of scenarios) {
        try {
          const e = caseEvidence(output, scenario);
          t.diagnostic(JSON.stringify({ failureEvidence: scenario, state: e.state, events: e.events,
            status: e.transport.status, signal: e.transport.signal, error: e.transport.error,
            stderrBytes: Buffer.byteLength(e.transport.stderr), report: e.report }));
        } catch (error) {
          const partial = { failureEvidence: scenario, unavailable: error.code || error.name };
          for (const name of ['state.json', 'events.jsonl', 'transport.json']) {
            try {
              const bytes = fs.readFileSync(path.join(output, scenario, name));
              partial[name] = { bytes: bytes.length, sha256: sha(bytes) };
              if (name === 'state.json') partial.state = JSON.parse(bytes);
              if (name === 'events.jsonl') partial.events = bytes.toString().trim().split('\n').map(JSON.parse);
              if (name === 'transport.json') {
                const transport = JSON.parse(bytes);
                partial.transport = { status: transport.status, signal: transport.signal, error: transport.error,
                  stdoutBytes: Buffer.byteLength(transport.stdout), stderrBytes: Buffer.byteLength(transport.stderr) };
              }
            } catch (readError) { partial[name] = { unavailable: readError.code || readError.name }; }
          }
          t.diagnostic(JSON.stringify(partial));
        }
      }
    }
    // Only the fresh directory returned by mkdtemp is eligible for removal.
    assert.equal(path.dirname(output), temp);
    assert.ok(path.basename(temp).startsWith('dp1s-r5-signal-'));
    if (cleanupSafe) fs.rmSync(temp, { recursive: true, force: true });
    else t.diagnostic(JSON.stringify({ retainedTemporaryDirectory: path.basename(temp), reason: 'Fixture group cleanup unconfirmed' }));
  }
});
