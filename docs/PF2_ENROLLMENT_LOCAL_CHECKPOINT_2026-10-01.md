# PF-2 enrollment and API integration: local checkpoint

PF-2 staging activation remains gated by measured enrollment completion and the
Linux acceptance packet. The admitted scope remains 10,000 raw BTCUSDT Spot 1m
bars including warm-up, Paper only, with the earliest same-owner sibling holdout
boundary. No deployment, commit or push is recorded by this checkpoint.

## Verified local scope

- E1 enrollment admission and receipt schema: 3 PostgreSQL checks; migration
  integration: 9. The server constructs the explicit enrollment-mode contract.
- E3 receipt consumers: 47 resolver checks, 48 preflight PostgreSQL checks and
  one historical inspection/retention check. Independent source review found no
  remaining blocker in those paths. Historical inspection uses the receipt's
  recorded policy; new PF-2 admission requires the current policy.
- R5 worker/recovery: 10 PostgreSQL checks. The first test attempt had an invalid
  synthetic replay fixture and unbounded waits; the corrected run is the accepted
  evidence. Process supervision remains simulated in this suite.
- R6 actual application HTTP: 9 checks, with no skips in the final local run.
  These cover authentication, disabled/startup refusal, holdout scope and rollback,
  receipt consumption, enqueue, idempotency, cancellation and envelope validation.
  Enabled Windows cases use a test-only policy loader; the positive case also
  substitutes a synthetic supported-source identity and synthetic receipt/result
  evidence. This is HTTP evidence, not enrollment production or private-source parity.
- E2 authority: 4 real PostgreSQL checks cover current binding mutations, owner
  and deployment locks, schema DDL exclusion and propagation of SQL failure.
  The completion authority uses persisted SQL evidence; ordinary execution
  authority still inspects artifacts. Ticket tests pass 5 checks, including
  rejection of asynchronous lifetime guards.
- The existing PROFILE V2 diagnostic suite passes 43 checks after the main E2
  integration. Its unmarked jobs retain provisional cancellation semantics.

## Engine identity

W4 adds a literal runtime manifest to ingestion, foundation and PF-2 engine hashes.
It covers worker and API relative imports, explicitly reviewed shared dependencies,
Python subprocess imports and the enrollment schema resource. Four focused checks
verify dependency closure, missing/changed resource refusal and preservation of the
original legacy and evaluator file selections and same-host byte identities.

Including PF-2 integration and enrollment SQL deliberately extends the earlier W4
scope. The evaluator's identity remains separate. Release hashes must be measured
from the actual host checkout; LF/CRLF differences can change byte hashes.

## Open acceptance

E2 implements a private completion attempt, SQL-only authority in SERIALIZABLE
transactions, measured settlement and receipt publication, publication rollback
on a late veto, and coherent readback after a lost commit response. Source review
identified release-eligibility and outcome-classification gaps; the implementation
was corrected. A further correction preserves measured proof when retrying a
settled job whose cancellation acknowledgment failed.

The component runtime suite passes 10 checks. A separate fault suite passes 16,
covering rollback after four publication writes, ambiguous commit readback,
unresolved launch/operation quarantine, time vetoes, duplicate completion and
readback waiting for an outstanding transaction. The awaited-authority deadline
case reaches both the deadline and runtime budget; it does not isolate those
two guards.

Independent review found an absolute-clock addition rounding defect near the
maximum safe integer. Runtime accounting now subtracts the start time before
adding elapsed time to used time, checks the result and persists that exact
value. Three pure regressions pass after reproducing the original failure.
The bounded source review found no further concrete blocker after the fix.

The first E4 local producer check passes: real BACKFILL of 10,000 synthetic bars,
real PROFILE construction after runtime release, real enrollment authority and
receipt publication, then PF-2 admission/resolution with the strictest sibling
boundary. OS telemetry and source/deployment evidence are synthetic; no receipt
or PROFILE success row is inserted as a shortcut. Extension through both product
workers and the final PF-2 replay envelope is being verified separately.

The first current full Node run hit its 300-second harness limit and exposed an
older capacity test expecting the later plan gate instead of the new earlier
enrollment gate. The fixture now tests both refusals explicitly. That timed-out
run is not full-suite acceptance; the corrected run remains separate evidence.

Native Linux execution and staging activation follow local acceptance and the
[prepared staging packet](PF2_STAGING_ACCEPTANCE_PACKET_2026-10-01.md). None of
these local checks prove live trading, expanded capacity, full evaluator parity
or physical I/O enforcement on another host.

## Owner-requested stop checkpoint

The owner requested no additional work and a saved checkpoint. No new test or
implementation task is admitted after that instruction. The isolated local
PostgreSQL cluster was stopped successfully; no remote runtime was changed.

The extended E4 test passes through the real BACKFILL and PROFILE workers,
measured enrollment publication and PF-2 worker/replay to the final envelope:
1/1 in 80.3 seconds. It checks ten sequential replay chunks, strict sibling
holdout, unchanged receipt, cleared process bindings and development-only flags.
The existing Python shim substitutes synthetic source enrollment; physical OS
supervision remains simulated. These limits remain part of the evidence.

Final regression is incomplete and is not accepted:

- Full Node: 760 passed, 2 failed, 3 skipped in 463.1 seconds. The two failures
  are the executable-closure subtest and its parent suite. A focused follow-up
  after a partial test correction still has 49 passes and 2 failures; do not
  mark that correction accepted.
- Current PostgreSQL reruns pass enrollment runtime 10, authority 4, foundation
  15, recovery 48, research foundation 22 with one private-baseline Python parity
  skip, and PROFILE 5.
- I/O runtime: 53 passed, 2 failed. I/O ledger: 9 passed, 1 failed. Those failures
  encounter PROFILE_V2_TERMINAL_REQUIRED before the older expected pause/release
  behavior. Diagnose and preserve independent scheduler and SQL guard coverage
  before accepting any test correction.
- The remaining final preflight, worker, retention and migration batch was not
  run after the failing gate. Earlier passes remain historical evidence.

The staging packet is a draft. Its owner-only unmarked V2 diagnostic enqueue
helper was being prepared when work stopped. Final helper implementation,
independent verification, release/CI and native Linux W7/R7 remain outstanding.
No commit, push, deployment or staging activation occurred.

## Git checkpoint authorization

After the stop checkpoint, the owner explicitly requested commit and push of the
saved work. This is a WIP checkpoint, not release acceptance. Known regression
failures and the incomplete, untested diagnostic enqueue helper are preserved.
Implementation and runtime work remain stopped; Linux and staging gates remain
open. No additional tests were run for this Git-only continuation.
