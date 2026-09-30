# PF-2 holdout and W3 local integration checkpoint

## Scope and owner decisions

The owner requested end-to-end PF-2 wiring and API activation on staging after
acceptance gates. Production and expanded bar capacity are outside this request.
The owner also approved the strictest shared holdout boundary across their bots,
and a temporary usage floor of 1% for this named continuation only. The standing
15-point reserve is unchanged.

This checkpoint contains local source and test changes only. No commit, push,
migration, deployment, VPS operation or staging activation occurred.

## Holdout policy

New registrations cannot be later than the earliest registered PF-2 boundary
for the same owner and exact venue, market, symbol and timeframe. Existing
per-bot registrations remain immutable and idempotent. Each bot still needs its
own explicit registration.

Plan construction and trusted resolution use the effective owner-wide minimum.
When a sibling registers an earlier boundary, an existing frozen plan is refused
at its next authorization or resolve. New plans use the tighter boundary; no
automatic re-enqueue occurs. This cannot undo previously consumed data, and a
running child is bounded by its next authorization fence, not immediate rollback.

An independent source review found no blocking issue in this change. The prior
behavior was reproduced by a regression that still authorized a stale plan.
The final PostgreSQL service suite passes 47/47, including registration racing
enqueue under SERIALIZABLE and READ COMMITTED isolation. The initial new test
needed an explicit cancellation before replacement admission; the active-job
guard was preserved.

## W3 and W5 local integration — updated 2026-10-01

The local draft wires a flag-gated capacity-policy loader, ledger, launcher and
PROFILE V2 runtime into the foundation worker. It adds trusted startup guards,
terminal heartbeat handling, emergency cancellation, durable stop reconciliation,
policy-invalid queue cancellation and one-attempt PROFILE semantics. V2 PROFILE
results remain provisional and jobs end CANCELLED. W5 now authorizes exact V2
contracts against the reviewed capacity policy and trusted owner, raw-data and
deployment bindings. Its direct stop acknowledgement requires matching durable
job, lease and I/O proof. An independent source audit found no W5 blocker.

The resumed W3 evidence includes worker shutdown during frame wait and terminal
drain, health-loss cancellation, empty-memory reconciliation, unresolved-stop
quarantine, actual start/stop loop completion and enabled constructor wiring.
Terminal logs contain only bounded identifiers, enums and available integer
timings. Independent review caught a misleading COMPLETE reason after runtime
failure; the corrected log preserves the failure reason and measures elapsed
time over the complete worker run. The final source audit found no blocker.
Native Linux startup and W7 behavior remain unverified by these local tests.

Root ran the following PostgreSQL suites serially on an isolated local cluster:

| Suite | Result |
| --- | --- |
| PF-2 service and holdout | 47 passed |
| Foundation scheduler | 15 passed |
| Research foundation worker | 10 passed, 1 skipped |
| Foundation recovery | 46 passed |
| PROFILE service | 4 passed |
| PROFILE V2 runtime | 43 passed |

The scheduler regression previously expected a missing policy to throw and leave
the queue head stuck. It now checks cancellation with CAPACITY_POLICY_MISMATCH,
then verifies a fresh job's slot and stop behavior. Provisional PROFILE finish is
explicitly refused. Focused W3 helper/worker tests passed 7/7 and startup tests
passed 2/2. These checks do not establish full staging readiness.

The resumed PostgreSQL total is 167 passed and one skipped, including two BACKFILL regressions. The first run of the
new runtime cases exposed fixture errors: attempted mutation of an immutable
contract and inconsistent fake terminal timing evidence. Fixtures were corrected
without weakening production guards; the final runtime suite passes 43/43.
Focused helper checks pass 12/12 and worker-unit startup checks pass 2/2.

The earlier full Node attempt exceeded its 180-second budget. The final frozen
source run completed in 242.9 seconds: 728 passed, three skipped, zero failed.
The isolated local PostgreSQL cluster is currently running under root control
for the next bounded acceptance lane. Diff whitespace checks pass.

## Remaining gates

A precise stale-engine PROFILE queue regression remains before closing every
W3 matrix item. S3 implementation proceeds locally under the Roadmap dependencies
for S3 prepare-under-lease, PF-2 R5/R6 and W4-W7. A separate durable trusted
PROFILE V2 enrollment slice is required before R7: W3/W5 intentionally discard
provisional results, while PF-2 admission requires SUCCEEDED with a validated
non-null result. Do not fabricate enrollment or use fixtures as staging evidence.
The root accepted an explicit enrollment-mode design with mandatory immutable
receipts, measured accounting and atomic result publication. That design is not
implemented or enabled by this checkpoint.

Historical holdout evidence remains immutable. The current 10K/1m admission
limit, Spot/Paper-only execution and locked Live mode remain in force.
