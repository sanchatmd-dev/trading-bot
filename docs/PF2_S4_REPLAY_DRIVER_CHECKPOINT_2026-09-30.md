# PF-2 S4 replay driver checkpoint — 2026-09-30

## Scope

PF-2 S4 is a local, development-only code slice, pushed as commit `9a340af`
(`feat(quant): add development-only PF-2 replay driver`) on branch
`codex/app3a-market-wait-checkpoint`. It builds on the
[S3 trusted resolver](PF2_S3_RESOLVER_CHECKPOINT_2026-09-30.md) (`5006feb`) and the
[S1 stateful replay core](QD_QS_FTR1_PF2_S1_CHECKPOINT_2026-09-29.md) (`cda2857`). New
files: `src/quant-research/preflight-replay.js`, `test/preflight-replay.test.js` and
the test-only `test/helpers/pf2_replay_shim.py`. The commit also adds the driver to
the PF-2 engine file list in `src/quant-research/preflight-resolver.js`, which
changes the PF-2 engine hash, extends the resolver's import-closure test, and gives
the shared test fixture an optional bar generator whose default is unchanged.

Nothing is deployed. The driver is not wired to any scheduler, database, route or
UI. Scope stays Spot/Paper only, BINANCE:BTCUSDT Spot 1m, the 10K-bar ceiling
including warm-up, independent holdout gates, no production rollout and no Live.

## What the slice does

`runHistoricalPreflight` runs a resolved preflight through the S1 Python replay
core in chunks and returns a result envelope:

- It reads only bars from zero up to the enrolled bar count of the development
  dataset and never past the development end. Rows must be the stored decimal
  strings; they are forwarded in normalized form.
- It sends canonical chunk requests and validates every response and checkpoint:
  plan binding, a recomputed integrity hash and a strictly increasing next bar.
- After each non-final chunk it emits a resume token bound to the plan, the
  resolved input and the executable hashes. A run resumed from a token gives the
  same result as an uninterrupted run.
- It re-checks the engine and evaluator file hashes before every chunk and after
  the final response.
- One run-level wall deadline (counted across resumes), a per-chunk timeout and
  byte limits for requests, responses, checkpoints, results and tokens bound each
  run. Cancellation kills the child process: `taskkill /T /F` on Windows and
  `SIGKILL` on POSIX.
- The final result is re-checked against Node-side invariants, including order and
  fill balance, episodes, loss streak, guard and pause consistency, and no
  collection ETA under a persistent pause. The deep-frozen envelope
  (`pf2-preflight-replay-v1`) keeps fixed flags: development-only, evaluator
  admission off, holdout not accessed, no orders executed, V1 only.

The local runner, `createLocalPythonRunner`, spawns Python directly with `-B -s`, a
pinned module path and an allowlisted environment, and accepts only an absolute
interpreter path. Callers must inject a runner; there is no default.

## Evidence

Local evidence only.

- 34 driver tests pass with the project's Python environment, including an
  end-to-end run from the S3 resolver through the S1 core. The private signal
  source is replaced by a test-only shim; the rest of the Python path (SPT
  evaluator, Bridge, Risk, paper state, checkpoint) is real. On a synthetic price
  series the run produced BUY signals, four buy and four exit fills and three
  losing episodes, and ended in a persistent loss-streak pause with no ETA.
- Resuming after the first or second chunk gave a byte-identical result and
  envelope, apart from the run section.
- A kill proof on the Windows development machine passed: after an abort no
  Python process remained.
- The S1 Python tests (51) still pass. The root reran the full Node suite at about
  23:40 UTC: 573 tests, 572 pass, 1 pre-existing skip, 0 fail.
- Without an absolute interpreter that has the quant dependencies, as on the CI
  Node job, the 18 Python-dependent driver tests skip with an explicit reason.
- An independent tester accepted every round. An independent auditor (Opus 5.5
  xhigh) found one blocking-medium defect, a text-hygiene test that would fail on a
  Windows checkout with CRLF line endings, and low items (two backslash-escaping
  defects and the test probe's skip rule); all were fixed and the re-check
  accepted. A later root-directed fix restricted the runner and tests to absolute
  interpreter paths, and the root made one timing-sensitive test helper wait on
  real time instead of a fixed number of event-loop turns.

## Not proved

- Not wired to any scheduler, database, route or UI; production adapters and
  runtime admission remain open.
- The private signal source is not exercised; the test-only shim replaces it.
- The Python interpreter, standard library, site-packages and cached bytecode are
  not hashed. Checkpoint and token integrity hashes are not authentication. There
  is no OS isolation locally, and the POSIX kill reaches only the direct child.
- On CI the Python-dependent driver tests are skipped; wiring them into the Quant
  Lab workflow is a later integration step.
- Full Risk Manager or position parity, V2 evaluator parity and the 50K maximum
  remain open.

## Development-machine incident

During verification, a simulated no-dependency run started a bare `python` with the
runner's allowlisted environment. On the Windows development machine that name
resolved to the Python install manager, which installed a Python 3.14 runtime into
the working directory and registered it for the current user. The project's own
Python environment was not affected, and nothing from it was committed. The runner
and tests now accept only absolute interpreter paths. Removing that local install
is the owner's decision.

## Next action

1. Owner decision on FTR-1c (see the [S3 record](PF2_S3_RESOLVER_CHECKPOINT_2026-09-30.md)).
2. PF-2 production adapters (authorization, records, enrollment lookup, provenance,
   holdout registry), runtime admission through the scheduler and I/O controls, CI
   wiring of the real-Python driver tests and research engine-hash integration.
   V2 historical admission stays denied until full evaluator parity.
3. The readiness retention cleanup still waits for real age expiry at 2026-09-30
   13:53:52 Asia/Bangkok.

## Effort and usage

Measured wall-clock: wave D2 about 21:21-22:59 UTC (build, tester and auditor, one
fix round, plus the S3 documentation worker), with the shared 5-hour usage window
going from 42% to 54% used; wave D3 about 23:05-23:33 UTC (a second fix round and a
tester re-check), then root checks until about 23:40 UTC. The 5-hour window reset
at 23:30 UTC during wave D3, so that wave's share is not separable; the weekly
all-models counter went from 14% to 16% used across both waves. Shared counters do
not attribute cost to an agent or step. The agents ran under the owner-approved
temporary elevated tier (coder Sonnet 5.5 xhigh, tester Sonnet 5.5 high, auditor
Opus 5.5 xhigh). No engineering hours are booked and no speedup is claimed.

## Scope and status

Commit and acceptance are separate facts: `9a340af` is pushed, was accepted by the
independent tester and auditor, and passed all nine CI checks. Nothing is deployed.
