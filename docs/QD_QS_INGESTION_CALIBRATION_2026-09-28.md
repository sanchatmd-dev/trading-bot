# QD-1 / QS-1 ingestion and calibration checkpoint

## Scope

The owner authorized capability/UI agreement, scheduler-backed ingestion and
bounded sustained-load calibration. This work continues the recovery/storage
checkpoint `91e7e95`. Admission remains **10,000 total bars including warm-up**,
BINANCE:BTCUSDT Spot 1m, Paper-only. No larger capacity or production rollout is
granted by this checkpoint.

## Implemented contracts

- The Data panel previews an exact UTC range against the server capability.
  End time is exclusive. Invalid or oversized ranges reject without truncation.
  A seven-day 1m request already contains 10,080 bars before warm-up.
- BACKFILL uses the same managed worker and global scheduler slot as research.
  Its immutable contract binds the requested range before a dataset exists.
- Durable progress records only pages whose immutable files were published.
  Resume verifies stored pages before fetching the remaining range. Final raw
  publication is separate from acceptance of an execution profile.
- Cancellation waits for fetch, publication and cleanup to stop before releasing
  the slot. Offline recovery retains managed-process and exclusive-lock proofs.
- Retention preserves checkpoint pages and successful output, including references
  held by terminal jobs. Raw history does not enroll ATR14, create Paper trades,
  open the original holdout or produce Best Inputs.

## Verification status

Local implementation is present. Actual PostgreSQL HTTP checks cover session,
CSRF, owner/Bot scope, range admission, idempotency, status and queued cancellation.
The disabled capability remains readable and rejects submission. Both HTTP tests
passed after adding the same `bot_id` query parameter used by the real UI.

An initial browser run exposed a query-scope integration error: the shared API
helper appended `bot_id`, while the new route rejected every query string. The
route now accepts one optional Bot scope and checks it against the body or stored
job. An isolated Chrome run against the real local server and PostgreSQL then
passed oversized-range rejection, a 120+20-bar preview, invalidation after an input
change, queue/cancel, and desktop/mobile rendering. There were no page errors or
horizontal overflow at 390 px. Browser execution used a fresh headless profile;
the desktop browser connector could not initialize in this environment.

The complete local Node suite passed **318/318 in 53.178 seconds**. Focused
contract/ingestion/UI/storage checks passed 22/22 in 15.532 seconds. PostgreSQL
HTTP passed 2/2 in 6.127 seconds. New PostgreSQL BACKFILL checks passed 2/2:
checkpoint at 1,000 bars, simulated offline recovery, resume to 2,100 raw bars,
retention of references, and STOPPING ownership until delayed I/O settles.
Only exchange transport and OS stop inspection were simulated in these checks;
the scheduler, database and budgeted dataset store were real. Research adapter
regressions passed 7 with one private Python-fixture test skipped. Existing
scheduler/recovery/retention suites passed 13/7/3 checks respectively.

An independent audit found a polling race as well as the query-scope bug. The UI
now permits one in-flight status request and invalidates stale replies after a
tab/visibility change. A deferred-response regression passed. Successful BACKFILL
also releases its in-memory stop marker; focused Node and PostgreSQL checks
passed after that correction. Physical staging ingestion and sustained-load
results are recorded separately below; local recovery tests do not certify a
Linux BACKFILL crash drill.

## Isolated staging raw ingestion

The immutable application archive contains 367 files; SHA256 is
`00ca6aae42b25347ea7e3fbaeb0434296eaa25e4e1a126007ff6337531331d57`.
The manifest SHA256 is
`a17befa3de4f1d60d2e8ae07aef0079b0f7aeada9c145f1770f9a6442d391ed5`.
Primary documents changed after packaging; runtime code stayed frozen. A new
isolated database uses base schema 14 and foundation/research/storage extensions
v1 in FOUNDATION mode. Its base backup is 93,755 bytes. Existing production and
staging databases/releases were not switched.

Authenticated API submission and the actual managed worker completed
BACKFILL job `fb1e12b2-cbec-4221-8019-1dd38b6833a1` on attempt 1. It fetched
**2,100 actual Binance Spot 1m bars in three pages**, published an immutable raw
dataset and verified the stored rows. There were zero research jobs and zero
ATR sidecars; `verified_execution_profile` remained false.

A separate raw-ingestion monitor excluded three warm probes, collected 30
baseline samples and 24 impact samples. Impact production API p95 was 4.86 ms,
Web 5.35 ms and DB 0.93 ms; queue age was zero, maximum load1 0.26, minimum
available RAM 6,502 MiB and free disk 91.86 GiB. No cgroup-counter error was
reported. This short raw-ingestion run is not sustained evaluator-load evidence.

## Sustained evaluator calibration

The first calibration attempt stopped before an evaluator was claimed. A private
driver query joined the foundation UUID to the research text ID without a cast.
Read-only database inspection confirmed attempts 0, evaluations 0, cursor 0,
no lease, and no chunk/unit records. Its queued job and original 60-second
deadline were preserved. The driver query was corrected and checked read-only
before a fresh immutable job and fresh baseline. The original job naturally
expired through the scheduler as research TIMED_OUT / foundation CANCELLED;
this attempt supplies no sustained-load evidence.

The corrected attempt passed the declared criterion of at least 120 seconds of
observed nonidle evaluator intervals within 300 seconds. From 11:59:28.314 to
12:04:28.314 UTC, it recorded **173.210 seconds of nonidle intervals and 87.443
evaluator CPU seconds**. The root independently recalculated these values from
the saved cgroup samples. Nonidle intervals require a positive CPU counter delta,
the same cgroup inode and consecutive samples no more than 250 ms apart; they
are not a claim of continuous CPU saturation.

The full 300-sample impact series lasted 304.585 seconds. Its results were:

| Metric | Observed impact | Declared stop threshold |
| --- | ---: | ---: |
| Production API p95 | 7.20 ms | 250 ms |
| Production Web p95 | 6.80 ms | 250 ms |
| Existing staging API / Web p95 | 6.68 / 6.73 ms | 250 ms each |
| Production DB p95 | 1.53 ms | 50 ms |
| Trading queue depth / oldest age | 0 / 0 | age 5 seconds |
| Maximum host load1 | 0.88 | 1.5 |
| Minimum available memory | 6,354.9 MiB | 2,048 MiB |
| Minimum free disk | 91.86 GiB | 10 GiB |

All HTTP probes and all eight existing services were healthy. Highest observed
individual managed-unit memory peak was 92.64 MiB; this is not an aggregate memory
limit or a guarantee for larger jobs. One cgroup sampling gap was excluded.
`io.stat` was empty, so I/O counters are **unavailable**, not zero.

There were 32 completed immutable mechanical replays, each with one evaluation,
NO_VALID_CANDIDATE and no holdout evaluation. The monitor finished before the
driver's independently started deadline. A watchdog immediately stopped further
work and the new Quant worker by 12:04:33.58 UTC. The 33rd replay stopped after a
2,000-bar checkpoint and finished research FAILED / foundation CANCELLED, with
no active slot. Its evidence and deadline were preserved. Acceptance covers the
observed 300-second workload; an uninterrupted complete driver window is not
claimed. A future driver should bind its deadline directly to monitor readiness.

Cleanup was verified at 12:07 UTC. All new API/Paper/Quant/monitor processes were
inactive, the scheduler had no active slot, and the interrupted transient unit
had no process or cgroup. All eight existing services remained healthy. Thirty
post-cleanup samples recorded production API/Web p95 of 4.80/3.94 ms, existing
staging API/Web of 4.24/4.42 ms, DB of 1.16 ms, and queue depth/age of zero.
Maximum load1 was 1.14; minimum available memory was 6,683 MiB and free disk
91.85 GiB. About 0.68 seconds of shutdown tail after monitor completion lacked
probes and is excluded from the measured load window. No production release or
configuration changed. Private artifacts and failed attempts remain preserved.

The root also compared 162 runtime files against the release manifest with zero
mismatches. Local and bounded isolated-staging acceptance is complete for this
slice. This checkpoint does not accept production rollout or expanded capacity.

The calibration used isolated engineering jobs and previously exposed data.
Repetition of a fixed baseline measures runtime behavior, not independent
research evidence or strategy quality. These measurements apply only to this
bounded workload, one evaluator and the current per-unit CPU50%/512 MiB/16-task
limits. They do not authorize larger datasets or more concurrency.

## Remaining project gates

QD-1/QS-1 remain open for expanded admission, other heavy paths, absolute I/O
budgets and broader recovery/restore evidence. PF-2 V2 evaluator parity and
recommendation eligibility remain separate gates.
