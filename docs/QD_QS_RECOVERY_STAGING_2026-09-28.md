# QD/QS recovery, storage and staging checkpoint

Date: 2026-09-28. Continues committed worker integration `2f6b1be` on the existing
work branch. The owner authorized cold recovery/crash drills, isolated staging
worker rollout with Trading/Web/DB measurements, and storage/ingestion contracts.
This record separates implemented code from executed acceptance.

## Implemented scope

Offline recovery pins an exclusive PostgreSQL maintenance session lock to the
same connection used for recovery writes. A trusted, owner-controlled policy
binds the worker unit and immutable release root. Recovery requires the launcher
masked and stopped, checks process/cgroup/job state, verifies persisted identities
and checkpoints, and fences old transient unit names before releasing a slot.
Original deadlines, runtime budgets and immutable evidence are retained.
Foundation startup requires the configured systemd unit, direct Node MainPID,
control-group kill mode and matching release. Manual launch is rejected.

Storage publication reserves disk and temporary capacity before writing. Separate
limits cover total root quota, temporary quota and minimum filesystem free space.
Cross-process accounting includes committed bytes, partial files and outstanding
reservations. Unknown state and stale locks fail closed. The configured API/worker
must use `QUANT_STORAGE_LIMITS_FILE`; test-injected stores remain explicit fixtures.

Retention is offline and dry-run by default. Its authoritative keep set includes
all research/foundation contracts, including terminal evidence. Only verified
unreferenced artifacts at least 24 hours old may be deleted. Unknown, malformed
or extra files are preserved. A namespace binds the artifact root to the database
identity; a copied database cannot silently manage the original root. A crash
between first root-marker creation and database commit requires reviewed offline
repair. There is no automatic adoption of a nonempty root.

Stale storage-lock recovery is explicit, with the same offline proof required
before lock removal and every deletion. Filesystem scans use a session lock
without an idle SQL transaction. Losing the connection stops further mutations.
Database maintenance alone does not establish absence of unmanaged file writers;
only controlled service writers belong in this namespace.

The internal Spot ingestion contract uses UTC open timestamps and a half-open
evaluation range. Warm-up is additional and counted toward the unchanged 10K
total-bar limit. Calendar month/year subtraction clamps to the last valid day.
Missing start boundaries, unsupported timeframes and oversized ranges reject;
there is no silent truncation or timeframe substitution. The paged reader requires
admission before each page, bounded responses, cancellation, strict continuity and
per-page hashes. It publishes only a complete budgeted raw dataset and returns
provenance. Raw ingestion does not enroll the accepted frozen ATR14 execution
profile or increase naturally observed Paper trades. Public UI/API range exposure
and full scheduler-driven backfill remain separate work.

The Binance request contract was checked against the official
[Spot market-data documentation](https://developers.binance.com/docs/binance-spot-api-docs/rest-api/market-data-endpoints).
Implementation uses explicit UTC, bounded pages and matching requested timestamps.
No live historical data download was required for these fixture checks.

## Evidence recorded so far

- Initial recovery mocks: 5/5 passed; these alone do not certify physical recovery.
- Initial storage suites: 16/16 passed. Follow-up stale-lock and retention checks
  add proof callbacks, bounded scans and protection of unknown file contents.
- Ingestion/range tests: 5/5 passed, including leap/month boundaries, 1,003-row
  pagination, missing/duplicate bars, rate limits, cancellation and atomic publish.
- Health checks: 4/4 passed, including a separate trading database so an isolated
  research database cannot report an empty queue as production health.
- Storage namespace/retention PostgreSQL: 3/3 passed, including terminal reference
  preservation, runtime exclusion and filesystem work beyond a short SQL idle
  transaction timeout. Offline migration regression also passed.
- Separate staging database and restore database were prepared from an empty
  schema, with schema 14 and Bridge/research extensions 1, zero users/signals/jobs.
  A 93,745-byte base-schema backup was restored and verified.
- Production baseline: 30 samples, API healthy 30/30, API p95 11.68 ms, DB p95
  1.12 ms, queue depth/age 0/0, maximum load1 0.06, minimum available memory
  6,690.94 MiB, minimum free disk 91.97 GiB. These are baseline measurements,
  not proof of behavior under research load.

## Staging operating bounds

Use one new isolated worker, database and protected artifact root. Keep all
existing production and staging services intact. The mechanical fixture uses
only the previously exposed 4,533 bars and one baseline candidate; no new search
or original holdout evaluation. Keep CPU at most 50% of one core, memory 512 MiB,
one heavy process, dataset quota 512 MiB, temp quota 128 MiB and free-space floor
10 GiB for this bounded drill. These are staging settings, not customer capacity.

Abort on API p95 above 250 ms or twice baseline (whichever is larger), DB p95
above 50 ms or three times baseline, queue age above 5 seconds, load1 above 1.5,
available memory below 2 GiB or free disk below 10 GiB. Retain logs and stop only
the new units on failure. A crash drill targets the worker process, not a reboot
of the shared VPS. Full-machine reboot recovery requires separate acceptance.

## Local verification checkpoint after resume

The full Node suite passed **312/312** in 79.443 seconds. PostgreSQL research
adapter passed 7 tests with its private Python fixture explicitly skipped in this
run; storage namespace/retention passed 3, offline migration passed 1 and scheduler
passed 13. The separate cold-restart PostgreSQL drill passed 1 in 2.095 seconds.
That drill proves preserved checkpoint/deadline, a new token and old-token fencing
with a simulated service manager; physical Linux service recovery remains open.
Storage suites passed 17 before final hardening, followed by five focused checks
covering stale-lock proof, retention shapes and bounded accounting. No full Python
suite was repeated because this slice changed no Python evaluator code.

Usage reached the configured reserve again after resumed local verification.
That rollout attempt stopped with its prepared assets retained. A subsequent
owner-requested continuation refreshed allowance and live state before proceeding.
Local passes or uploaded code alone do not establish a completed staging rollout.

### Recovery audit corrections

A focused independent review identified two recovery defects before the physical
worker drill. A lost maintenance connection during awaited systemd/process checks
could leave a stale successful guard result. Recovery also retained an old chunk
unit token after acknowledgement, which could block a second recovery if the new
worker crashed before launching its first process. Both failures were reproduced
in focused tests before correction.

The guard now checks connection loss after awaited operations and probes the
pinned connection again before returning. Recovery clears only the verified old
run/token unit fields in the same acknowledgement transaction; checkpoint,
progress and original deadline remain unchanged. Retention still holds its
filesystem lock throughout scanning and deletion, and supported publication
writers require that same lock. This is a controlled namespace guarantee, not a
general atomic transaction across PostgreSQL and arbitrary filesystem writers.

Focused recovery checks passed **7/7**. The revised real-PostgreSQL test passed
**1/1** in 2.564 seconds, including recovery after a second crash; its service
manager remains simulated. Storage namespace/retention checks repeated **3/3**
in 2.989 seconds. The isolated local PostgreSQL runtime was stopped afterward.
The final combined recovery/storage unit run passed **14/14** in 15.687 seconds.

### First physical worker and monitor attempt

The new isolated database was migrated to foundation/storage extension 1 and
FOUNDATION mode. Its loopback API initially reported an unhealthy worker
heartbeat because no Paper worker existed in that database. Starting its own
isolated Paper worker restored HTTP 200/PAPER_ONLY; existing services were not
changed. The fixture seeder was adjusted to recognize the API-created bootstrap
admin while still requiring no research jobs, signals or deployments.

The actual managed Quant worker completed one baseline evaluation over the
predeclared train/validation portion (3,876 of the 4,533 exposed bars). It returned
`NO_VALID_CANDIDATE` with the foundation job `SUCCEEDED`, attempt 1, and no held
transient unit. It did not evaluate the holdout. It completed before the first
progress poll, so this run did not establish crash recovery.

The first impact monitor aborted after 10 samples: API p95 292.30 ms exceeded
the 250 ms stop threshold. All 10 API responses were healthy; DB p95 was 2.45 ms,
queue depth/age 0/0 and maximum load1 0.14. The new Quant worker was stopped and
no transient research unit remained. The 292 ms sample occurred on the first
probe; subsequent samples were 2–5 ms. Client initialization overhead is a
hypothesis, not proof that the failed window should pass. The raw failed window
is retained. A revised measurement must record client warm-up separately and
use the same long-lived probe for baseline and load, with unchanged thresholds.

## Current acceptance boundary

The actual isolated main-worker baseline and physical Linux cold recovery passed
the bounded mechanical drill described below. This does not close all QD-1/QS-1
work or establish sustained shared-host capacity. Capacity remains **10K bars,
BINANCE:BTCUSDT Spot 1m, PAPER_ONLY, V1**. Expanded ranges, absolute I/O quotas,
full backup/artifact restore and PF-2 V2 evaluator parity remain gated.

## Physical recovery and revised impact evidence

The first crash watcher had a SQL type mismatch when joining the text research
run ID to the UUID foundation job ID. It failed before sending SIGKILL; that
identical mechanical replay completed normally and is retained as an unsuccessful
drill attempt. The watcher query was corrected and checked read-only against the
completed job before a separately identified final replay. No completed job,
contract, deadline or research parameters were reset.

Before the final replay, the idle test unit's runtime mask/unmask procedure was
checked. After the actual crash its failed transient state required a scoped
`reset-failed` and `daemon-reload` before the runtime mask reported `LoadState=masked`.
Recovery proceeded only after that state was verified. Only the new test unit
was reset; existing services were not restarted.

The final watcher sent SIGKILL to the managed worker after a durable checkpoint
at **1,000 bars**, with a persisted in-flight subprocess identity. Offline recovery
returned `PAUSED`, preserved the checkpoint hash and original deadline, and
cleared only the verified old unit fields. The old lease token was rejected with
`FOUNDATION_LEASE_LOST`. The old transient service remained runtime-masked.

The restarted worker acquired a new token and completed on **attempt 2**, with
**one charged evaluation** and final cursor **3,876**. Its final checkpoint and
candidate step result exactly matched the uninterrupted baseline. The outcome
was `NO_VALID_CANDIDATE`; no original holdout was evaluated and no recommendation
or new research campaign was created.

The revised monitor recorded three client warm-up probes separately, then used
the same long-lived process for 30 baseline samples and 60 impact samples. The
final impact window had API p95 **2.90 ms**, DB p95 **1.28 ms**, healthy API responses
throughout, queue depth/age **0/0**, maximum load1 **0.25**, and minimum available
memory approximately **6,515 MiB**. Thresholds remained 250 ms API / 50 ms DB with
the original host and queue stop limits. These short, low-duty measurements are
not a sustained-load benchmark or approval for larger datasets.

That final window ran from 05:59:17 to 06:00:17 UTC and overlapped approximately
three seconds of computation before SIGKILL. It did not overlap resumed computation
at 06:01:37 UTC. A separate healthy 60-sample window overlapped the full second
uninterrupted replay (API p95 3.66 ms, DB p95 1.03 ms). Neither window measures
sustained evaluator utilization. Journal memory peaks of 59.9, 47.3 and 25.8 MiB
refer to the main Node service windows, not evaluator cgroup maxima.

### Storage and cleanup

The physical offline retention dry-run returned `applied:false`, zero stale
reservations and no deletion candidates. All three terminal engineering jobs
retain references to the same raw dataset and ATR sidecar; both artifacts were
present. A 513 MiB reservation was rejected with `STORAGE_CAPACITY_EXCEEDED`
under the 512 MiB quota, leaving zero reservations and pending bytes. No retention
deletion or historical backfill was performed on the VPS.

At 06:05 UTC, all four production and four preexisting staging services were
active. Both existing API health endpoints reported `ok:true`, `PAPER_ONLY` and
queue zero. All new test processes were stopped; the test Quant worker and old
evaluator were runtime-masked. Failed monitor/watcher unit status was retained
for diagnostics; no test process remained active. The isolated databases,
backup, logs and immutable artifacts remain protected for review. The original
production release, configuration and existing Bot settings were unchanged.

The final staged archive contained 354 verified files. Its manifest SHA256 was
`612743befb7b873e26c35931d13855cc082aae815b35ca8b688f877dd1b48a5e`.
A final local comparison of 180 runtime/package files against that manifest
found zero mismatches. Documentation was updated after packaging. This work is
recorded after the preceding worker checkpoint `2f6b1be`; use Git history for
the recovery checkpoint revision.

Development was interrupted at the configured usage reserve, then resumed after
a fresh allowance check. Account percentages are not per-task token accounting.
No complete active-hour measurement exists; verification and wait times must not
be subtracted from the project engineering estimate as if they were work hours.
