# Quant capacity and production resource protection

Planning specification, 2026-09-27. Reviewed from the owner's capacity handoff.
[Roadmap](ROADMAP.md#quant-resource-protection-and-infrastructure-scaling) owns
sequencing, status, infrastructure stages and acceptance. This document defines
contracts; it does not authorize configuration changes or claim deployed limits.

Implementation update, 2026-09-28: the local
[QD-1/QS-1 foundation](QD_QS_FOUNDATION_CHECKPOINT_2026-09-28.md) implements
referenced immutable storage and a separate fenced PostgreSQL scheduler under
the [shared contract](QUANT_FOUNDATION_CONTRACT.md). The subsequent
[worker checkpoint](QD_QS_WORKER_CHECKPOINT_2026-09-28.md) connects the research
executor behind an offline opt-in mode, carries SPT/Paper state, and adds local
health checks plus Linux transient-service supervision. The bounded supervisor
smoke is separate from a full research staging rollout. Other heavy paths,
cold-crash recovery, calibrated headroom, disk reservations and capacity expansion
remain open. Targets below are not enabled production settings.

## Current facts and target decisions

The owner supplied the initial hardware envelope: 2 vCPU, 8 GB RAM, 100 GB NVMe,
8 TB bandwidth and one provider snapshot. Keep this VPS for now. These are
owner-provided planning facts, not a fresh server inventory or performance test.
Current research remains capped at 10,000 bars with its narrow supported profile.
The primary market remains BINANCE:BTCUSDT Spot 1m. Existing 100-candidate results
remain NO_VALID_CANDIDATE, zero validation closed trades, holdout unopened.

Target classes: Historical Preflight <=50,000 total primary bars; processing
chunks <=50,000 bars; research dataset budgets depend on timeframe and stage.
Use the canonical [capacity table](ROADMAP.md#report-range-and-research-capacity-contract).
All dataset budgets include evaluator-required warm-up. Record evaluation bars,
warm-up bars and total separately; secondary MTF data has additional budgets.
Ranges are operating targets, not minimum sample requirements or entitlement to
run immediately. A smaller declared study is permitted within its admission/gates.

## Admission and scheduler

Target heavy Quant concurrency is **one globally** on the initial VPS, including
historical preflight, backtest, optimize, heavy reporting and maintenance/backfill
work. Coordinate I/O-heavy fetch/export work under the same resource budget; do
not bypass controls by classifying it as a lightweight HTTP request. Lightweight
status reads can continue within separately bounded request/DB limits.

Bot quotas do not grant compute concurrency. Server admission resolves ownership,
capability, source complexity, parameter dimensions, candidates, evaluation and
warm-up counts, MTF work, state/result bytes, disk/temp reserve, queue limits and
production health. Unknown estimates require bounded profiling or rejection.
Approximate work units are bars × candidates × evaluator complexity × MTF work;
calibrate the model from measurements rather than treating it as a runtime SLA.

Use a durable queue with idempotent submission and bounded per-user queued jobs,
jobs/day, candidate/dataset budgets, retention/storage and Deep Research access.
Persist job identity, snapshots, admission version/reason and progress. Queue
position and ETA may change with health and priority; explain changes to users.
Use fairness and aging so tier priority cannot starve other customers. Internal
verification/operational priority still obeys concurrency and production gates.

Acquire a globally exclusive execution lease atomically. Heartbeats, lease expiry,
fencing and idempotent artifact publication must prevent two executors committing
the same job after restart. An expired lease does not permit overlapping execution
until the previous executor is fenced/stopped. Persist checkpoints and cancellation
requests; resumed execution must match the frozen engine/dataset/snapshot versions.
Planned QUEUED/RUNNING/PAUSED/CANCELLED/FAILED outcomes are design concepts, not a
claim that every state already exists in the API. No direct trading-state mutation.

## Production health and isolation

Trading execution/reduce-only exits and Risk Engine have first operational priority,
then webhook intake, PostgreSQL service health, Web/API user operations, operational
notifications and Quant. PostgreSQL is a dependency of trading/intake and must retain
headroom; this priority list is not permission to starve the database.

Check trading queue lag, database latency/health, API/webhook latency, CPU/load,
available memory, I/O pressure and disk reserves before starting or resuming work.
Unknown/unavailable critical health telemetry blocks new heavy work. When pressure
appears, checkpoint and yield; establish a measured maximum checkpoint/pause latency.
50K is a chunk ceiling, not a mandatory minimum: use smaller chunks and cooperative
cancellation checks when needed. Waiting for a slow 50K chunk cannot be the sole
production protection. Hard process/resource limits and safe termination/recovery
are required for jobs that fail to cooperate. Resume with health hysteresis/backoff
to avoid repeated pause/resume oscillation. Numerical thresholds await benchmarking.

Benchmark candidates for same-host isolation (not deployed settings):

- Quant around one vCPU-equivalent maximum; evaluate CPUQuota/CPUWeight, Nice and
  I/O priority. Limit child processes and numerical-library thread pools, including
  OMP_NUM_THREADS, OPENBLAS_NUM_THREADS, MKL_NUM_THREADS and NUMEXPR_NUM_THREADS.
- Quant preferred memory envelope about 2–2.5 GB, candidate hard ceiling about 3 GB;
  evaluate MemoryHigh/MemoryMax and total process-tree RSS. Preserve measured OS,
  PostgreSQL, Web/API and trading headroom, including concurrent temporary operations.
- Quant failure is acceptable; host OOM or production starvation is not. No memory,
  CPU or disk number in this plan should be applied blindly to systemd.

CPU > RAM/disk > bandwidth is a planning hypothesis only. Profile actual workloads.
Admission can reject too-large work, queue capacity-limited work, pause under pressure
or return insufficient activity/NO_VALID_CANDIDATE as correct accepted behavior.

## Dataset and chunk contracts

Use a shared immutable dataset, referenced by ID/hash across candidates and runs.
Fetch matching exchange history once where valid; do not clone/download the complete
dataset for each candidate. Market caches may be shared; owner source, settings,
results and authorized download handles remain isolated. Avoid large job JSON.

Metadata: dataset_id, venue, market, symbol, timeframe, start/end, warmup_start,
last_completed_bar, evaluation_bar_count, warmup_bar_count, total_bar_count, source,
version/hash, creation time and gap/duplicate/incomplete-bar status. Reject wrong
venue/symbol/TF, order/timestamp/boundary mismatch, hash mismatch and unverified
resampling. No silent interpolation, gap fill, truncation or timeframe change.

Carry indicator/MTF/warm-up/signal/Bridge state, pending orders, positions,
allocations, entry/exit ownership, reduce-only state, cash/reservations/book equity,
daily/session counters and loss streak across chunks and recovery. Chunk boundaries
must not reset warm-up or risk. For 500K/1M total bars, 50K chunks produce 10/20
chunks respectively; smaller safe chunks produce more, not a maximum of 20 chunks.
Avoid counting any implementation overlap twice as evaluation data.

Acceptance compares uninterrupted, chunked, paused/resumed and restarted execution
on the same frozen inputs: signals, intents, risk decisions, fills, allocations,
positions, cash, PnL and metrics agree under existing declared numeric tolerances.
Portability requires versioned job/data/result contracts and storage references,
not local machine paths, in-process shared memory or browser-authoritative state.
PostgreSQL remains authoritative for ownership, policy, capital, sessions, fills,
ledger/audit and job identity. Quant computes against immutable snapshots.

## Staged validation without leakage

Before a workflow, freeze stage datasets/cutoffs, partitions, warm-up, shortlist
rule, candidate budget, objective, costs, risk and final decision procedure.
Search and extended validation may overlap only as declared development history;
only untouched disjoint evaluation periods can count as independent evidence.
Larger datasets do not erase earlier exposure. Re-evaluating search history on
500K/1M bars must not be labelled wholly independent validation.

One predeclared bounded workflow may execute conditional stages for qualified
candidates. It is not an open-ended optimization loop. Typical shortlist 5–20 and
final 1–5 are examples to freeze before execution, not rights to inspect holdout
and choose top-N. If final holdout selects among finalists, it becomes selection
data; an independent performance claim needs a reserved untouched evaluation and
predeclared multiple-comparison treatment. No holdout-driven dataset extension,
source/policy change, guard reset or automatic rerun. A new study requires an
explicit owner action and new lineage.

## Disk, retention and recovery

Initial disk watermarks to evaluate, not configured production thresholds:
below 65% normal; 65–75% warning/eligible-cache cleanup; above 75% block large new
datasets; above 85% block heavy Quant admission. At boundaries take the stricter
action during design. Measured absolute free-byte reserves for PostgreSQL/WAL,
logs, releases, temporary writes and backup/restore override percentage headroom.
Reserve projected output and temporary space atomically to prevent over-admission.

Retain parameter values, metrics/gates, trade/episode and rejection summaries,
validation status and provenance for all candidates. Retain detailed trades,
decisions/equity and stress evidence for shortlist/final outputs as required.
Record retention tier/completeness; do not imply every candidate has a full trace.
Final exports retain required audit artifacts. Exact reruns need original engine
and dataset artifacts; report when reproduction is no longer available.

Classify A required immutable evidence, B rebuildable market cache, C temporary
intermediates, D downloadable packages and E logs. Only expired, unreferenced and
policy-eligible objects may be removed; pinned evidence is not generic cache.
Authorize downloads per owner and bound export size/retention. Low disk cannot
silently remove required evidence or corrupt accounting history.

One provider snapshot does not satisfy disaster recovery. APP-4 retains scheduled
off-host backups, failure alerts, restore verification and a full-system restore
drill. Scaling must preserve backup, encryption/access and recovery guarantees.

## Future benchmark acceptance

After isolated implementation, measure representative combinations of 10K/50K/
100K/250K/500K/1M bars and 1/5/10/25/50/100 candidates. The matrix is not permission
to run its full Cartesian product or default to 1M × 100. Begin small with explicit
work budgets, abort conditions and production-independent load fixtures.

Measure wall/CPU time, peak RSS, disk I/O, input/result bytes, recovery/pause latency,
fairness and PostgreSQL/API/webhook/worker lag under representative concurrent load.
Calibrate admission, service objectives and thresholds before customer enablement
or changing concurrency. Stage III+ scaling is optional and telemetry-driven;
see the canonical infrastructure review gates in Roadmap.
