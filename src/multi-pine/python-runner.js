import {spawn} from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

/*
 * F11 S3: direct-spawn Python runner for the combined multi-Pine job (docs/MULTI_PINE_CONTRACT.md RD-MP-32, root ruling R-10).
 * It copies the limits of `pythonEvaluation` (src/postgres/quant-research-worker.js): 8 MiB request, 2 MiB response, a call timeout (at most 30 s and at most the
 * time left to the run deadline), stderr discarded (private source and contract text never leave through a Python error), PYTHONPATH set to quant_lab/src, the
 * child killed on abort, timeout or output overflow (SIGTERM, then SIGKILL after a grace period when the child ignores it).
 * The child gets a MINIMAL environment: PATH, LANG, LC_ALL, PYTHONPATH, PYTHONHASHSEED and the explicit `env` option, never the parent environment (no DATABASE_URL,
 * MP_FIXTURE_DATABASE_URL or secret). It starts with `-P` (no script directory or working directory on sys.path) and with the working directory quant_lab/src, so a
 * stray json.py or decimal.py in a directory outside the engine hash cannot shadow the standard library. There is no fallback to a bare `python` from PATH. It does not use `runQuantProcess` (that supervisor needs systemd-run and a user bus, which an isolated
 * local cluster does not have).
 *
 * createPythonRunner(options) returns `runEvaluator(payload, {signal, timeoutMs})` for MultiPineFixtureExecutor. One call is one process and one step.
 * Failure is an Error whose `code` is one of:
 *   RESEARCH_REQUEST_TOO_LARGE     the serialized request passes 8 MiB (nothing was spawned)
 *   RESEARCH_INTERRUPTED           the abort signal fired
 *   EVALUATION_TIMED_OUT           the call timeout passed
 *   EVALUATION_OUTPUT_TOO_LARGE    the response passes 2 MiB
 *   QUANT_PYTHON_UNAVAILABLE       the interpreter could not be started
 *   INVALID_EVALUATION_RESPONSE    exit status 0 but stdout is not one JSON object
 *   <JOB CODE>                     exit status 1 with a stdout object {"error":"<UPPER_CASE_CODE>"} (the code only, e.g. MP_CROSS_SOURCE_TARGET)
 *   EVALUATION_FAILED              any other non-zero exit
 * The job writes its own code only, never a message, so the code is safe to relay.
 *
 * Options (all optional): python (default QUANT_RESEARCH_PYTHON, else quant_lab/.venv when present; with neither, every call fails QUANT_PYTHON_UNAVAILABLE), module
 * (default robot_quant.mp_combined_job), args (replaces the "-m module" arguments; a TEST-ONLY seam: the PostgreSQL test runs the real job module through a one-line
 * wrapper that replaces the private source gate), cwd (TEST-ONLY seam, default quant_lab/src), env (extra variables for the child; a name that looks like a secret or a
 * database setting, or starts with PYTHON, throws TypeError), timeoutMs (default 30000, at most 30000), killGraceMs (default 2000: SIGKILL after SIGTERM).
 */

export const RUNNER_REQUEST_LIMIT = 8 * 1024 * 1024;
export const RUNNER_RESPONSE_LIMIT = 2 * 1024 * 1024;
export const RUNNER_MAX_TIMEOUT_MS = 30000;
export const RUNNER_MODULE = 'robot_quant.mp_combined_job';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const RUNNER_KILL_GRACE_MS = 2000;
const CODE = /^[A-Z][A-Z0-9_]{1,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const ENV_REFUSED = /(DATABASE|SECRET|TOKEN|PASSW|CREDENTIAL|PRIVATE|API_?KEY|_KEY$|^PG|^PYTHON)/i;
const ENV_INHERITED = ['PATH', 'LANG', 'LC_ALL'];
const fail = code => Object.assign(new Error(code), {code});

/** The job's own error object: exactly {"error":"CODE"} with a safe code. Anything else is a plain failure. */
function jobCode(output) {
  try {
    const value = JSON.parse(output);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 1 && typeof value.error === 'string' && CODE.test(value.error)) return value.error;
  } catch { /* not a job error */ }
  return null;
}

/** The environment of the child: a short fixed list from the parent plus the explicit extras. Throws TypeError for an extra that could carry a secret. */
function childEnvironment(extra) {
  const out = {};
  for (const name of ENV_INHERITED) if (typeof process.env[name] === 'string') out[name] = process.env[name];
  for (const [name, value] of Object.entries(extra)) {
    if (!ENV_NAME.test(name) || ENV_REFUSED.test(name) || typeof value !== 'string') throw new TypeError('createPythonRunner: env variable refused: ' + name);
    out[name] = value;
  }
  return {...out, PYTHONPATH: path.join(root, 'quant_lab/src'), PYTHONHASHSEED: '0'};
}

export function createPythonRunner({python, module = RUNNER_MODULE, args, env = {}, cwd, timeoutMs: defaultTimeout = RUNNER_MAX_TIMEOUT_MS, killGraceMs = RUNNER_KILL_GRACE_MS} = {}) {
  const venv = path.join(root, 'quant_lab', '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const interpreter = python ?? process.env.QUANT_RESEARCH_PYTHON ?? (fs.existsSync(venv) ? venv : null);
  const spawnArgs = ['-P', ...(args ?? ['-m', module])];
  const environment = childEnvironment(env);
  const workdir = cwd ?? path.join(root, 'quant_lab/src');
  return function runEvaluator(payload, {signal, timeoutMs = defaultTimeout} = {}) {
    return new Promise((resolve, reject) => {
      const limit = Math.min(RUNNER_MAX_TIMEOUT_MS, Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : RUNNER_MAX_TIMEOUT_MS);
      const input = JSON.stringify(payload);
      if (Buffer.byteLength(input) > RUNNER_REQUEST_LIMIT) { reject(fail('RESEARCH_REQUEST_TOO_LARGE')); return; }
      if (signal?.aborted) { reject(fail('RESEARCH_INTERRUPTED')); return; }
      if (!interpreter) { reject(fail('QUANT_PYTHON_UNAVAILABLE')); return; }
      const child = spawn(interpreter, spawnArgs, {cwd: workdir, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
      let output = '', settled = false, interrupted = null, killer = null;
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(killer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error); else resolve(value);
      };
      // SIGTERM first; a child that ignores it is killed with SIGKILL after the grace period (the promise settles only when the child has closed).
      const stop = () => {
        child.kill();
        killer ??= setTimeout(() => { child.kill('SIGKILL'); }, killGraceMs);
      };
      const abort = () => { interrupted ??= 'RESEARCH_INTERRUPTED'; stop(); };
      const timer = setTimeout(() => { interrupted ??= 'EVALUATION_TIMED_OUT'; stop(); }, limit);
      signal?.addEventListener('abort', abort, {once: true});
      child.stdout.on('data', data => {
        if (interrupted) return;
        output += data;
        if (Buffer.byteLength(output) > RUNNER_RESPONSE_LIMIT) { interrupted = 'EVALUATION_OUTPUT_TOO_LARGE'; stop(); }
      });
      child.stderr.on('data', () => {}); // never echo private source or contract text through Python errors
      child.stdin.on('error', () => {});
      child.on('error', () => finish(fail('QUANT_PYTHON_UNAVAILABLE')));
      child.on('close', code => {
        if (interrupted) { finish(fail(interrupted)); return; }
        if (code !== 0) { finish(fail(jobCode(output) ?? 'EVALUATION_FAILED')); return; }
        try {
          const value = JSON.parse(output);
          if (value === null || typeof value !== 'object' || Array.isArray(value) || value.error !== undefined) throw new Error('shape');
          finish(null, value);
        } catch { finish(fail('INVALID_EVALUATION_RESPONSE')); }
      });
      child.stdin.end(input);
    });
  };
}
