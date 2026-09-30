# PF-2 staging acceptance packet

Status: prepared locally; not executed or approved as a release. Local fault
acceptance, independent review and final regression must finish before freezing
the release. This packet does not certify the current server state.

Execution requires the reviewed release to be pushed and its required CI checks
to pass. Preparing this packet does not supply commit/push authorization.

The owner requested PF-2 API activation on staging after acceptance. Scope is
10,000 raw BTCUSDT Spot 1m bars including warm-up, Paper only. The earliest
registered same-owner sibling holdout boundary applies. Production, Live,
capacity expansion and automatic retry remain outside this packet.

## Release and operating record

Before execution, record the reviewed release revision, clean release manifest,
host-derived ingestion/foundation/PF-2 engine hashes, capacity-policy hash,
existing staging service identities and configuration fingerprints. Do not copy
credentials or host locations into this document. The current implementation is
uncommitted; commit/push and successful CI are not recorded facts.

The owner performs Linux setup and launch under the existing handoff. One
designated operations worker coordinates observation and evidence under a bounded
root dispatch. Each case has its own job ID, deadline, log destination and stop
plan. One attempt per case; a failed case does not authorize a retry. Preserve
the failure and review its cause first.

## Offline prerequisites

1. Accept E1–E4, W1–W6, R5/R6 and independent accounting review. Preserve the
   earlier FTR-1c-INT measured result as historical evidence; it does not replace
   W7 on the new release.
2. Stop admission and the dedicated staging research worker using the existing
   controlled procedure. Confirm actual processes and transient units have
   stopped. Keep existing production and capture services unchanged.
3. Run `node scripts/check-quant-foundation-idle.mjs` with the private staging
   environment. Require exit 0, no RUNNING/STOPPING jobs, no unresolved launches
   or ledger operations. This read-only snapshot is not a lock: keep admission
   disabled throughout installation. Review queued/paused policy hashes; cancel
   stale jobs through supported controls, never rewrite immutable contracts.
4. Back up the database/configuration under the existing staging procedure.
   Run `node scripts/migrate-quant-foundation.mjs --mode=FOUNDATION` offline.
   Require schema assertions, including enrollment receipt immutability and the
   I/O release guard. Do not install extensions from an API request.
5. Verify the real release root, storage binding, block-device identity, free
   space, cgroup delegation, I/O controls and current health. Require ext4 and
   the host-derived journal drain plan. Verify `MemorySwapMax=0` with actual
   `memory.swap.max=0`, or the accepted no-swap host condition. Recheck the
   filesystem and commit-age bound in the real terminal path.
6. Pin terminal policy to `runtime_max_ms=70000`, `terminal_drain_ms=45000`,
   `tail_margin_ms=5000`, provided the current host gates accept it. Require
   worker `TimeoutStopSec=90` and `KillMode=mixed`; record actual readback.
   A different host requirement blocks this packet; do not silently shorten it.

The private environment must identify real reviewed policy, recovery, health and
I/O control files. Startup checks require `QUANT_CAPACITY_POLICY_FILE`,
`QUANT_RECOVERY_POLICY_FILE`, `QUANT_HEALTH_RECOVERY_FILE` and
`QUANT_IO_CONTROLS_FILE`. Verify the existing `QUANT_HEALTH_LIMITS_FILE`,
`QUANT_HEALTH_URL`, `QUANT_WORKER_UNIT` and `QUANT_RESEARCH_DATASET_ROOT` values,
the recovery policy's release/storage bindings, the absolute Python interpreter
and `PG_POOL_SIZE` of at least 3 for health recovery. These are checks of reviewed
staging configuration, not instructions to invent replacement values.
Never use the Windows test loader, synthetic policy,
synthetic telemetry, receipt fixtures or source-hash overrides on staging.

## W7: product Linux proof

Use the diagnostic PROFILE mode first: `QUANT_PROFILE_V2_ENABLED=1`,
`QUANT_PROFILE_V2_ENROLLMENT_ENABLED=0`, `QUANT_PREFLIGHT_ENABLED=0`.
The diagnostic result remains CANCELLED with null SQL result. The public V1
PROFILE route cannot enqueue this case. A reviewed owner-only diagnostic
enqueue helper must create the unmarked V2 contract from trusted raw/deployment
records; its final path, digest and dry-run evidence belong in the release record.
That helper is being prepared and is an execution prerequisite.

| Case | Action | Required evidence |
| --- | --- | --- |
| C1 measured completion | One bounded diagnostic PROFILE through the product worker | MEASURED_FINAL_SETTLED, frozen deltas equal ledger charge, STOP_PROVEN, released slot, no heartbeat after cancellation; record claim-to-ack duration. |
| C2 worker stop | Stop the dedicated worker at terminal start plus 10 seconds | UNKNOWN_FINAL_CHARGED once, STOP_PROVEN, CANCELLED; exit before 90 seconds, no worker SIGKILL, no STOPPING job after verified recovery. |
| C3 supervision observation | Observe C1/C2 | Actual stop timeout/KillMode, systemd-run client exit and helper termination evidence. |
| C5 idle observation | Before and after each case | Exit 0 and coherent job/launch/ledger state; unchanged unrelated service identities and healthy postflight. |

The optional C4 SIGKILL case is not automatically added to this packet. A lost or
double charge, mismatched delta, unresolved stop or slot, or unexpected worker
SIGKILL fails acceptance. A safe fallback is not a measured-completion pass.

## Durable enrollment and R7 API proof

After W7 passes, enable the reviewed staging-only configuration in the API and
dedicated worker: `PINE_BRIDGE_ENV=staging`, `PAPER_TRADING=true`,
`PINE_BRIDGE_ENABLED=1`, `QUANT_RESEARCH_ENABLED=1`,
`QUANT_RESEARCH_FOUNDATION_ENABLED=1`, `QUANT_PROFILE_V2_ENABLED=1` and
`QUANT_PROFILE_V2_ENROLLMENT_ENABLED=1`. Keep `QUANT_PREFLIGHT_ENABLED=0` until
the enrollment below passes. Data admission derives from the research and
foundation flags; there is no separate `QUANT_DATA_ENABLED` flag.

Using the owner's authenticated session and CSRF protection, send exactly one
`POST /api/quant/data/profile-enrollments` with a fresh idempotency key and
`{bot_id, raw_job_id, deployment_id}` referring to real authorized records.
The raw dataset must be eligible and the deployment fresh. The server creates
the enrollment contract; do not insert a success row or receipt manually.

Require the same job to have SUCCEEDED, the immutable receipt, a matching valid
result, SETTLED ledger operation, STOP_PROVEN launch, cleared worker/lease and
released slot. Validate the receipt through the product validator and retained
raw/research/ATR references. The result must retain `evaluator_admission=false`.

Enable `QUANT_PREFLIGHT_ENABLED=1` only after that evidence passes. Register the
owner's reviewed, minute-aligned, write-once holdout boundary using
`POST /api/quant/data/holdout-boundaries`. An existing boundary is inspected,
not reset. Refuse a boundary later than the earliest sibling boundary or a
conflicting legacy holdout; never infer a boundary from test data.

Send one `POST /api/quant/data/preflights` with a fresh idempotency key and
`{bot_id, deployment_id, profile_job_id}` using the exact enrollment job above.
Observe it through `GET /api/quant/data/preflights/{job_id}`. Require successful
worker completion, a valid immutable envelope, unchanged idempotent response,
strict development-only range and `holdout_accessed=false`,
`orders_executed=false`, `evaluator_admission=false`. API-only activation does
not grant V2 evaluator parity, optimization or a Bot start.

## Failure and completion record

On any failed or ambiguous gate, disable new PF-2/enrollment admission. Use the
supported cancellation/worker-stop and offline recovery procedure for the exact
job; retain STOPPING and resource ownership until physical stop and accounting
are proven. Do not clear database flags, delete receipts or undo ledger charges
to make the gate pass. Do not roll back schema or immutable evidence blindly.

Record each case's actual status, job IDs, release/policy hashes, measured
accounting, retained references, logs, health and delayed postflight. Only a
completed real R7 result plus healthy final state supports the statement
“PF-2 API enabled on staging.” Local synthetic tests cannot support it.
