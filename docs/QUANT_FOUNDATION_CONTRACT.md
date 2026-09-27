# QD-1 / QS-1 foundation contract

Version: `quant-foundation-v1`. Local engineering foundation, not an enabled
customer API, expanded evaluator capability or production scheduler.

The [worker integration checkpoint](QD_QS_WORKER_CHECKPOINT_2026-09-28.md)
extends this initial contract with an opt-in research adapter, true SPT/Paper
continuation, versioned offline migration, process supervision and trusted
health admission. Initial-slice limitations below describe module boundaries;
the checkpoint owns integration evidence and remaining deployment gates.

## Shared interfaces

Root owns `src/quant-research/foundation-contract.js`. Dataset storage and the
scheduler import its validators. Validation errors have stable `.code` values.

`validateDatasetMetadata(value)` returns a canonical, validated metadata object:
`{version, venue, market, symbol, timeframe, start_time, end_time,
warmup_bars, total_bars, cutoff, source}`. Version is `spot-dataset-v1`, venue
`binance-global`, market `SPOT`, symbol `BTCUSDT`, timeframe `1`. Timestamps are
UTC milliseconds; interval is half-open and includes warm-up. All bars are closed
by cutoff. Source is `binance-spot-klines-v1`. Counts are positive, at most 1M
including warm-up, and consistent with the interval. This storage contract does
not grant evaluator or research admission.

`validateDatasetReference(value)` accepts only
`{dataset_id, sha256, metadata}`. Both IDs are the same lowercase SHA-256 hex;
metadata passes the validator above. No filesystem paths or embedded bars.

`validateFoundationRequest(value)` accepts only
`{version, owner_id, bot_id, kind, dataset, engine_hash, snapshot_hash, budget}`.
Version is `quant-foundation-v1`; kind is `PREFLIGHT`, `BACKTEST`, `OPTIMIZE`,
`REPORT` or `BACKFILL`. Hashes are lowercase SHA-256. Owner/Bot IDs are bounded
nonempty strings. Budget is `{candidates, max_evaluations, chunk_bars,
max_runtime_ms, max_output_bytes, max_state_bytes}`. The foundation admits only
the current 10K-bar/1m ceiling, candidates <=100, evaluations <=125, chunks <=50K
and <=dataset size, runtime <=900000 ms, output <=8 MiB and state <=1 MiB.
All numbers are positive safe integers. The absolute deadline starts at enqueue;
queue waiting consumes this deadline, and resume never resets it. A job has at
most three claims, including cooperative resumes. Queue limits are 100 active
jobs globally and 20 per owner for this internal foundation. These are engineering
bounds requiring later entitlement and load calibration, not production
entitlements. Authorization and hash resolution remain
server responsibilities, supplied as trusted callbacks to foundation services.

## QD-1 storage slice

Protected, caller-configured storage root; content-addressed immutable datasets
outside job JSON. Bars contain only `time`, `open`, `high`, `low`, `close` and
`volume`, with finite decimal values and consistent OHLC bounds. Derived ATR and
venue execution increments belong to the evaluator/model snapshots. Reject
gaps, duplicates, wrong boundaries and incomplete bars; preserve decimal values.
Chunk files contain at most 50K bars. Publish atomically without overwriting
existing content; verify hashes on read. References contain no local paths.
Read ranges are explicit half-open bar indices and never silently truncated.
Cancellation leaves no published partial dataset. No exchange fetch or deletion
of existing evidence in this slice. Local synthetic data proves storage behavior,
not source/evaluator parity or larger research readiness.

## QS-1 scheduler slice

Optional isolated PostgreSQL extension, separate from current research tables.
Durable idempotent submissions, owner checks via trusted authorization callback,
bounded queues, immutable contracts and fenced progress/checkpoints. One global
execution slot across admitted kinds. Fair owner selection persists across restart.
Trusted health callback must return `{ok:true}` before claim/resume; unknown or
unhealthy input blocks admission to execution. Numeric health thresholds and OS
resource controls remain later integration work.

Lease expiry alone must never permit overlapping compute. Expired/cancelled
running work retains the global slot in `STOPPING`; a trusted supervisor confirms
the old executor stopped before release/requeue/cancellation. Old tokens cannot
heartbeat or publish. Checkpoint contains opaque bounded evaluator state plus
dataset/engine/snapshot identity and monotonically advancing next-bar index.
Foundation checkpoints do not certify SPT state serialization. Scheduler methods
own their transactions; an enclosing caller transaction is rejected so rollback
cannot undo a committed stop quarantine. Callers must stop
execution before cooperative pause/finish; process supervision is not supplied by
this module. No routes, production migration, worker switching or VPS jobs here.
