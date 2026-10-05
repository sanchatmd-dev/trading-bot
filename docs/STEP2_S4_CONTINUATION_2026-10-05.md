# Step 2 selection coherence and prototype continuation — 2026-10-05

## Scope and decision

The owner resumed work on the prototype blockers and authorized Computer Use.
Owner-only actions are parked while the owner is away. Codex remains the sole
root. Existing staging downtime and checkpoint commit/push authority persists.

S4 now requires a new research submission to preserve the selection in its READY
deployment. Previously, enqueue could replace the deployment selection with a
different valid set of research slots. The new guard compares canonical selected
slot identities, types, effective values and source search domains, the effective
fixed-input map, signal mapping and Bridge baseline. Array order and presentation
metadata do not affect equality. Bridge search grids remain independently
validated because they are not stored as deployment source domains.

A mismatch returns `409 RESEARCH_SELECTION_MISMATCH` before candidate planning,
market-data loading, dataset publication or job creation. Exact retries of a
persisted job still return the original job before this new guard; conflicting
request bodies retain the existing idempotency conflict. No historical contract,
owner lock, active deployment, Pine source or Risk policy is rewritten. General
Bridge support for zero to eight source slots is unchanged.

This is local code only. `contract.js` participates in engine hashing, so a
compatible release and its runtime checks remain separate gates. Staging
research admission remains closed.

## Verification

The coder's focused Node checks passed 46 tests. Independent review found no
substantive code blocker; its focused suite passed 16 tests and its adversarial
suite passed five tests, covering 19 malformed-input cases. These counts overlap
and are not an aggregate total. Final isolated PostgreSQL checks passed: LEGACY
10/10, FOUNDATION 24 passed and one intentional private-Python-fixture skip,
HTTP 4/4 and preparation/recovery 12/12 (50 passed, one skipped in total).
The final LEGACY test proves that a new key is rejected after deployment selection
drift, while the exact historical retry preserves the stored job and a conflicting
body still returns 409. Its final test addition received independent review.

The first local PostgreSQL harness attempt started the database but timed out on
the Windows `pg_ctl` output pipe before running tests. The root stopped that
cluster explicitly and corrected only the private harness to use file-backed
output. Fresh isolated clusters completed the checks and were stopped. No shared
database was used. Root accepts S4 local implementation; staging acceptance is
still pending.

The backend checkpoint `5e2ba93` passed all nine CI checks, including PostgreSQL
and the Windows and Ubuntu test jobs. This confirms the committed test results;
it does not establish staging release compatibility or runtime acceptance.

## Input capability labels

The local Bridge input picker now labels dimensions supported by the known SPT
research catalog separately from inputs supported only by Bridge. Unknown sources
retain the pending label. A visible count explains when an AI proposal omitted
otherwise eligible numeric inputs; it does not add those inputs back. These labels
do not certify parity, readiness or profitability.

English and Thai labels update without changing selected inputs, domain values,
defaults, duplicate-choice protections or the eight-slot request. The related
wizard, activation and Pine suites passed 51 tests; independent focused verification
passed six tests and found no blocker. The counts overlap. This UI change is also
local only, with no staging browser acceptance claim.

Release preparation found that the changed scripts still used their old asset
URLs while static JavaScript is cached for one hour. The HTML now versions both
the Bridge panel and translations as `s4b1`; existing loading-order expectations
were updated. The package built before this correction is not a release target.
The three affected UI suites passed 98 tests with no failures or skips.

## Authenticated journey and current runtime

Authenticated browser checks on 2026-10-05 verified the journey, Bot Manager,
Readiness report and Research Library. Bot capacity is fully used (three of
three), and Create Bot is correctly disabled. The successful creation path is
therefore still unaccepted on staging. Local Create Bot UI regressions passed
eight tests; they do not replace the staging creation proof.

Read-only staging intake at 05:18 UTC confirmed API `2919f9b`, trading worker
`f2bd332` and research worker `3309d07`, their unchanged process identities,
Paper health, schema 14 and 66 tables. Research jobs, leases and launches were
idle. The current prototype deployment is READY with its snapshot and Paper
policy hashes verified. The current prototype bot had no OPEN allocation; the
old QL-3A allocation remained OPEN for 0.01181 BTC. Its alert must stay stopped.
These observations are time-specific, not ongoing health guarantees.

The latest preserved research run evaluated all 21 candidates. Each had zero
validation trades and failed `INSUFFICIENT_VALIDATION_TRADES`; holdout was not
evaluated. This gives no finite data-collection estimate and no qualified winner.
More bars alone are not yet proved to solve the problem. Guard-state and signal
activity diagnosis must precede any proposal for another research campaign.

Read-only checkpoint inspection at 06:00 UTC confirmed loss-streak pause
rejections in every candidate (13 to 24 each). Across the 21 candidates there
were 343 loss-streak pauses, 60 daily-trade-limit rejections, 190 quantities below
the exchange step and 484 exits whose target was not open. These counters span
training and validation together; they do not locate each rejection within a
partition. The result supports investigating persistent guard state rather than
assuming more bars will produce validation trades. No guard was reset and no
new evaluation was run. Historical boundary metadata was collected separately;
it still requires validation before any new data range is approved.

## Remaining work

- S6: decide the replacement for `confirmLookback`, freeze a new owner input
  lock if approved, and prove TradingView axis parity. Synthetic reachability
  does not establish the required effect on real data.
- S7: prepare a predeclared RR/multiplier replay on a proven development-only
  prefix. Report target changes separately from realized decisions. No ranking,
  holdout access, parameter search or automatic optimizer loop is authorized.
- PF-2: read-only inventory at 05:28 UTC found no eligible BACKFILL for the
  current bot and no registered current/sibling boundary in the new holdout
  registry. This does not erase holdout constraints in historical contracts.
  B3, W7, D6 and R7 remain open, in that order. B2 is already complete and must
  not be repeated from the older October 1 packet.
- The same inventory confirmed idle research and protected service identities.
  It did not certify native closure, grants, dataset content or capacity. Worker
  capacity and health-recovery policy files were absent; device mapping and
  cgroup memory limits remain unverified. Prepare a reviewed transition packet
  before any job or runtime change.
- The prerequisite review separates B3 from W7: BACKFILL runs in the main Node
  worker and does not require PROFILE V2 capacity calibration. B3 still needs
  verified main-worker controls, storage, health, grants, executable closure and
  historical holdout boundaries. Existing calibration receipts do not establish
  the six physical I/O bounds needed for W7. Historical synthetic policy values
  must not be relabelled as measured capacity.
- Authenticated Create Bot success needs spare capacity or an explicitly
  authorized test-account arrangement. No existing bot was deleted or license
  expanded to manufacture this proof.

Private read-only receipts and local test logs remain in the ignored checkpoint
namespaces. No PF-2 activation, new research campaign, guard reset, forced close,
Live activation or production change occurred in this continuation.
