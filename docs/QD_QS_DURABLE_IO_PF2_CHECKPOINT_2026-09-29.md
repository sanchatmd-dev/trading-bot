# QD/QS durable I/O and PF-2 local checkpoint — 2026-09-29

## Scope

This is a local engineering checkpoint on branch
`codex/app3a-market-wait-checkpoint`, prepared on top of `2c5dfea`. This record
covers local acceptance. The subsequent
[runtime checkpoint](QD_QS_RUNTIME_CANCEL_CHECKPOINT_2026-09-29.md) records the
later scoped staging evidence; neither record claims production acceptance.

## QD/QS durable I/O

A new PostgreSQL adapter and standalone offline SQL implement a durable I/O
ledger. The adapter derives the valid scheduler V2 contract using trusted policy
and device data. Reservation and transition updates use compare-and-swap (CAS).
The ledger persists accounting, restart state and quarantine state without an
outer transaction. Final local PostgreSQL checks passed 10/10 in 2.60 seconds.
Coverage includes V2 scheduler enqueue/claim, concurrent revision CAS, restart,
crash quarantine, stale/expired lease, STOPPING terminal, transaction-boundary
denial, lost COMMIT acknowledgement, revoked-policy terminal, and persisted
bind/observe/settle transitions with idempotent duplicate settlement. Scheduler
pause/claim used a new token and preserved 5 read bytes and 6 write bytes in the
synthetic fixture. Independent source/test review found no blocker for this local
persistence scope.

The adapter exposes committed reservations only, not permission to launch after
cancellation. Policy and device enrollment and terminal proof verification remain
trusted integration responsibilities. The optional SQL was applied only to fresh
isolated test databases. Those databases were removed by their fixtures; the local
test cluster started for this work was stopped after review, with files retained.

The adapter has no executable launch callback or runtime wiring. Launch/cancel
serialization remains unresolved. Worker and public V2 admission integration
are absent. Physical enforcement and staging acceptance are not claimed. Local
persistence scope is accepted; broader runtime fault matrix remains open.

## PF-2 finalizer

A new isolated Python order finalizer matches Node parity in reviewed scope. It
fixes trailing-zero scale handling, caller Decimal context dependence and null
semantics. Independent audit confirmed explicit context, trailing-zero, null and
CI fixes. Final checks: Python 12/12, latest focused cross-language parity 1/1
with 17 vectors, and Ruff passed. Earlier Node 30/30 included 29 existing tests
plus one parity test; do not add overlapping counts. Full Risk Manager,
position and historical replay parity remain unproved.

The root workflow now pins Python 3.12 in Node CI and adds a parity step to
Quant CI. Hosted CI has not run. Historical V2 replay remains denied. This
finalizer alone does not establish full Risk Manager, position or replay parity.
Stateful replay and trusted evidence resolver work remain open.

## Scope and next action

Production remains at 10K bars. Spot/Paper-only, holdout and candidate gates are
unchanged. No new market wait or collection was started. The next primary gate
is launch/cancel serialization, runtime accounting integration and its fault
matrix. PF-2 stateful replay and trusted resolver can proceed in parallel after
their contracts are clear.

Readiness retention remains pending genuine age expiry at 2026-09-30 13:53:52
Asia/Bangkok. It does not block local engineering.

## Effort and review

Elapsed engineering time is not fully measured. I/O test duration was 2.60
seconds; it is not engineering time. Approximate author effort was 15 minutes
for I/O and 5 minutes for initial PF-2 work; PF-2 review/correction time is
unknown. No speedup or total-hours reduction is claimed. Per-model cost is
unknown. Auditor review identified two numerical issues and one CI issue; root
corrected two early I/O contract/terminal issues.
The implementation author also corrected terminal accounting under revoked policy.
Documentation required root reconciliation of stale intermediate check statuses;
this rework is included without claiming measured model savings.
