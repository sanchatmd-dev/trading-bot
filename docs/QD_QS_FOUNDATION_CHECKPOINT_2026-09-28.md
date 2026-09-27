# QD-1 / QS-1 foundation checkpoint

Date: 2026-09-28. Local engineering extension after PF-1 `cf8913d`.
This is the earlier storage/scheduler slice. See the subsequent
[worker integration checkpoint](QD_QS_WORKER_CHECKPOINT_2026-09-28.md) for actual
executor wiring, state parity and bounded Linux supervision evidence.
The shared [foundation contract](QUANT_FOUNDATION_CONTRACT.md) was fixed before
two implementation agents worked on independent storage and scheduler modules.
An independent architecture review covers the scheduler and storage boundaries.

## Implemented scope

QD-1 introduces a content-addressed, protected filesystem store for shared raw
Spot OHLCV. A reference contains only dataset identity, checksum and metadata;
job contracts do not embed price arrays. Metadata binds BINANCE:BTCUSDT Spot 1m,
the UTC half-open interval, warm-up and completed-bar cutoff. Publication checks
decimal precision, OHLC consistency, exact counts and contiguous timestamps.

Atomic publication exposes only a completed directory. Concurrent identical
publishers reuse a verified winner, and cancellation removes unpublished temporary
files. Manifest hashes bind chunk layout and hashes; changing chunk layout gives
a different dataset identity. Inspection verifies the manifest; reads also verify
every selected chunk before yielding bars. Explicit range reads never silently
truncate. Root protection is required; the service rejects linked directories but
does not defend against an administrator replacing filesystem objects concurrently.
Power-loss durability of directory publication and orphan cleanup remain unproven.

QS-1 introduces an optional PostgreSQL extension and internal scheduler service.
It provides bounded, idempotent job submission, immutable contracts, persistent
owner fairness, one global slot across its job classes, fresh lease tokens,
bounded checkpoint/result JSON and resumable progress. Admission and current
identity checks are trusted server callbacks; user-provided `{ok:true}` is not
an acceptable implementation of those callbacks.

Expired or cancelled running jobs retain the slot as `STOPPING`. Lease expiry
does not permit new compute to overlap an executor that might still be alive.
Only a trusted supervisor acknowledgement releases the slot after the old executor
has stopped. Cooperative pause and finish also require the caller to stop first.
Unknown or failed health blocks claims and makes a heartbeat request stop.

The foundation does not install a supervisor or OS resource limits. It is not
connected to the existing research worker, HTTP routes, production migrations or
current Bot sessions. Its global slot coordinates only callers of this new service;
it does not yet constrain other existing Quant paths. Existing research retains
its 10K/1m admission and V1 execution-model gates. The storage metadata ceiling of
1M and chunk ceiling of 50K do not enable expanded evaluator admission.

## Verification

Final local verification:

| Check | Result | Evidence scope |
| --- | --- | --- |
| `npm test` | 291/291, 43.637 seconds | Existing Node suite plus four contract and six storage tests. |
| `test/postgres/quant-foundation.test.mjs` | 13/13, 7.469 seconds | Real disposable PostgreSQL database; two independent connections, fairness, lease quarantine, cancellation, integrity, authorization and callback timing. |
| `test/postgres/quant-foundation-storage.test.mjs` | 1/1, 4.265 seconds | Actual immutable artifact read, persisted checkpoint, expired executor fencing, supervisor acknowledgement and restart on another connection. |

The architecture audit identified two P2 issues: revoked-owner work could block
other owners, and slow callbacks could invalidate the lease/deadline time used
for a mutation. Both were corrected with regression tests. Explicit revocation
terminates the affected queued job; authorization infrastructure errors preserve
the queue for retry. Time is rechecked after awaited callbacks. An external
caller transaction is rejected so its rollback cannot undo committed quarantine.

The first scheduler run passed 8/11: three fixtures incorrectly assumed ordering
between equal timestamps or ignored owner fairness. Fixtures were corrected;
the final expanded suite above passed. Synthetic storage/checkpoint fixtures prove
transport and resume mechanics, not SPT indicator/accounting state parity,
holdout eligibility or a qualified strategy. No VPS staging validation occurred.

Test databases were dropped. The temporary local PostgreSQL cluster was stopped
after verification. Private logs remain in the ignored local QA workspace.
Usage was 71% weekly remaining before dispatch and 68% at integration; the short
window was unavailable. These are shared account observations, not task token
accounting. The 20-percentage-point reserve remains. Full active engineering
hours were not recorded; test durations are not development time.

## Remaining QD-1 / QS-1 gates

1. Build bounded paged exchange ingestion/cache with source provenance, calendar
   and timeframe capability/range contracts, exact warm-up and UI agreement.
2. Connect the existing research executor to referenced datasets and serialize
   complete indicator/Bridge/account/guard state. Compare uninterrupted, chunked
   and restarted SPT calculations against the accepted baseline.
3. Route all heavy job paths through the shared scheduler. Implement a real
   supervisor, process-tree termination, trusted telemetry, bounded pause latency,
   CPU/memory/I/O limits and measured health thresholds.
4. Add atomic disk/temp reservations, retention and queue/compute quotas. Prove
   migration/restore and production headroom on isolated staging before rollout.
5. Admit larger datasets only after capability, state parity and resource evidence.
   PF-2 V2 historical evaluator parity remains separate from these foundations.

No new research campaign, market collection, production change or deployment is
part of this checkpoint. Full QD-1/QS-1 acceptance remains open.
