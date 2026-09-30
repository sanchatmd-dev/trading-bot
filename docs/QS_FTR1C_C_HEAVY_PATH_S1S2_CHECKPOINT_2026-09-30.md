# QS-1 FTR-1c-C commit barrier and heavy-path S1/S2 containment checkpoint — 2026-09-30

## Scope

Local code slices, pushed on branch `codex/app3a-market-wait-checkpoint`:

- `f5616f2` (feature): FTR-1c-C, the owner-approved journal commit barrier and
  host-derived writeback drain plan for the frozen PROFILE terminal, with the
  scheduler-review amendment (70 s cap, 5 s tail margin, bounded commit
  transaction, SIGKILL for drained units).
- `ff1805d` (fix): heavy-path S1/S2 containment, so `POST /api/quant/research/jobs`
  checks the research queue limits and the bar-range coverage before it loads any
  bar row or publishes a dataset file, plus legacy HTTP denial tests.

Both slices are local only. Nothing is deployed, and no staging or production
service changed. Scope stays Spot/Paper only, BINANCE:BTCUSDT Spot 1m, the 10K-bar
ceiling including warm-up, independent holdout gates, no production rollout and no
Live.

## FTR-1c-C: commit barrier and writeback drain plan

The owner approved FTR-1c after the scheduler review of a long STOPPING terminal.
`f5616f2` implements the local part. While a drained unit is frozen, the launcher
now fsyncs the StorageBudget root directory, bounded at 2,000 ms, so child-owned
metadata reaches the journal before the final counter reads. A new
`writebackDrainPlan` sizes the required drain from the host writeback sysctls
(2,000 + dirty_expire + 2 x dirty_writeback + 2,500 + 500 ms) and fails closed
when a sysctl cannot be parsed or when the configured drain is shorter than the
host requires. The terminal diagnostic moves to v2 and records the barrier and
required-drain figures.

The amendment from the scheduler review is folded in. A drain of 5,000-45,000 ms
now requires a StorageBudget, the runtime cap rises from 60,000 ms to 70,000 ms so
the host-required 45 s drain still fits with a 5 s tail margin, the launcher checks
for a stop request before it freezes the unit, and drained units run with
`KillSignal=SIGKILL`. `commitFrozen` now bounds its locks and statements
(`lock_timeout` 2,000 ms, `statement_timeout` 3,000 ms) and maps a timeout to
`QUANT_IO_ACCOUNTING_UNAVAILABLE`, so the job ends `COMMIT_FAILED` and falls back
to the unknown-final charge instead of holding the frozen unit open.

Evidence, all local: the architecture auditor accepted with no blocking defect, an
independent tester accepted (focused suites, mutation checks on a scratch copy all
killed), and an independent second audit by a different model, the first pilot of
that model on an audit task, also accepted with 5 low and 4 info follow-ups. Root
spot checks: focused unit tests 72 (71 pass, 1 Linux-only skip); PostgreSQL
io-runtime, ledger and recovery tests 94/94; full unit suite 623 (621 pass, 2 skip,
0 fail). CI on `ff1805d`, which includes `f5616f2`, passed 9/9.

The follow-ups are planned as one hardening packet, FTR-1c-D: a drain-plan check
before spawn so a host-static failure rejects the launch instead of crash-charging
a job; an ext4 filesystem gate before any freeze; two added tests (a stop between
freeze and barrier, and a full-length drain from the latest permitted terminate
start); a transaction-level commit bound before wiring step W2; swap exposure for
drained units; and comment fixes. None of these blocks the Linux proof.

## Heavy-path S1/S2: queue limits and bar coverage before loading bars

A read-only heavy-path trace found that `POST /api/quant/research/jobs` prepared
the whole request (bar load, per-row validation, dataset publish) before it checked
the queue limits, so a rejected request still cost CPU and disk and left orphan
artifacts. `ff1805d` is containment for that gap only.

The route now checks the queue limits first: the legacy limits (10 total and 2 per
owner) give `QUANT_QUEUE_FULL` with status 429, and the foundation limits (100
total and 20 per owner) give `FOUNDATION_QUEUE_FULL`, now 429 where it was 400. A
count/min/max precheck of the bar range then runs before any bar row is loaded or
any dataset file is published. Error codes for single-defect ranges are unchanged.
Error precedence changed: queue-full now beats bar-data and capital errors. The
same per-row validation still runs afterwards, so the precheck can neither accept a
bad range nor reject a valid one.

S2 adds legacy HTTP denial tests on a real HTTP server: a stale API flag gives 409,
and a missing executor-mode row gives 503 with no rows created and the bridge not
reached. One known defect stays marked as a todo test: the `quantBridge` catch in
`server.js` drops the `QUANT_EXECUTOR_MODE_UNAVAILABLE` code on backtest and
optimize; the status stays 503 and fail-closed, but the code is missing from the
body. A small fix packet is planned and must remove the todo mark.

Evidence, all local: the auditor returned ACCEPT-WITH-FIXES, one fix round landed
(the known-defect test marked todo, a visible skip when the fixed test port is busy,
a corrected comment on the queue lock), and the re-audit returned ACCEPT. The four
PostgreSQL test files ran 30 tests: 28 pass, 1 skip that needs a private contract
file, 1 todo. The changed module is in neither engine-hash list.

This slice does not close the heavy-path gate. The gate stays open until
prepare-under-lease (S3), S3c and staging evidence exist. Orphan-publish paths after
publish are S3 scope.

## Not yet proven

- The default commit barrier has not run on a real ext4 Linux host. The
  Linux-only test is skipped on Windows, so the barrier mechanism is proved only
  through seams and fakes. This is the FTR-1c-INT proof.
- The FTR-1c-INT packet is being prepared and independently audited. The owner runs
  setup and launch after the readiness retention check at 2026-09-30 06:53:52 UTC;
  one run, no retry. The previously prepared FTR-1b-INT case is retired unrun.
- Real systemd behavior at the runtime limit on a frozen unit remains unverified;
  the tail margin avoids the overlap rather than proving the behavior.
- Deploying FTR-1c rotates `engine_hash`, because `io-terminal.js` is in the engine
  file list; re-check hash-bound evidence before any deploy. Nothing is deployed.
- Heavy-path S1/S2 is containment only. The scheduler singleton lock is still held
  during preparation, so slow preparation can still block the heartbeat; that
  exposure is unmeasured until S3.

## Effort and usage

Measured intervals, all wall-clock: the heavy-path S1/S2 wave (build, audit, one
fix round and re-audit) about 02:14-03:18 UTC; the FTR-1c-C build and verification
about 02:20-02:55 UTC, in parallel; the independent second audit about 02:54-03:10
UTC; root checks, commits and push about 03:10-03:22 UTC, with CI green by about
03:30 UTC. The shared 5-hour usage window went from 35% to 64% used over the
overlapping waves and the weekly all-models counter from 20% to 24%; the second
audit's model has its own weekly counter, which went from 0% to 4%. Shared counters
do not attribute cost to an agent or a step. The agents ran under the
owner-approved temporary elevated tier. No engineering hours are booked and no
speedup is claimed.

## Next steps

1. FTR-1c-INT: independent packet audit, then owner-run setup and launch on the
   Linux host after the retention check; one run, no retry.
2. FTR-1c-D hardening packet (the follow-ups above), then wiring step W2 after the
   B2 abort path and B4 policy-pinned terminal parameters.
3. Heavy-path S3 (prepare-under-lease), S3c and staging evidence before the
   heavy-path gate closes; a small fix packet for the `server.js` catch.
4. PF-2 R2 and R3 after owner decisions OD-2 and OD-3.

## Scope and status

Commit and acceptance are separate facts: both commits are pushed, were accepted by
independent reviewers, and passed CI. Planned: FTR-1c-INT, FTR-1c-D, heavy-path S3
and the `server.js` fix. Local: everything in this record. Staging: nothing new.
Production: nothing. Nothing is deployed.
