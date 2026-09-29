# QD/QS runtime launch and cancellation checkpoint — 2026-09-29

## Scope

This checkpoint connects the optional PostgreSQL I/O ledger, foundation scheduler
and a Linux diagnostic launcher. It covers a child that starts with its input
held, resource-limit readback and cancellation. It does not run the PROFILE
evaluator, complete a PROFILE result or enable public V2 admission.

The launcher accepts only a fixed diagnostic payload. Payload release requires
a persisted ACTIVE I/O operation and the verified cgroup identity. This
checkpoint deliberately provides no runtime binding path, so payload release
remains denied until real initial counters and their identity are integrated.

## Implementation

- Reservation and immutable launch intent commit together before bootstrap.
- A unique start claim commits before spawning. An uncertain acknowledgement
  cannot reset the claim or retry the same unit identity.
- Scheduler locks and lease/deadline checks fence spawn and payload release.
  The final check and synchronous process action have no intervening await.
- An additive SQL trigger blocks active-slot release and lease replacement
  while launch or accounting remains unresolved. It also protects scheduler
  instances that do not supply the optional application callback.
- Stop proof requires observed registration, launcher closure, exclusion of
  pending starts and a stopped unit/process tree. An uncertain start without
  an owned handle remains quarantined; restart alone does not prove exclusion.
- When final counters are unavailable, cancellation charges the full operation
  allowance and permanently quarantines further compute on that ledger. Only
  trusted physical stop permits the scheduler to release the slot. This is
  `CRASHED` accounting, never measured final usage or `SETTLED`.

The standalone runtime SQL must be installed offline in an explicitly selected
database alongside the foundation and ledger schemas. It is not an automatic
production migration. Existing V1 execution is unchanged.

## Local evidence

Four isolated PostgreSQL runtime checks passed in 2.92 seconds:

1. Atomic reservation/intent, unique start, denial of unbound payload release,
   and cancellation with full allowance charged and no PROFILE result.
2. Alternate scheduler instances cannot bypass unresolved accounting through
   pause, stop acknowledgement or lease replacement.
3. Cancellation before a start claim proves no launch; a committed STARTING
   claim without its owned handle remains unresolved.
4. A rollback after spawn stops the owned handle and preserves the start claim;
   only its trusted stop proof closes cancellation.

The focused existing V1 scheduler check passed 1/1. These checks are separate
from the previous ledger 10/10 and Python finalizer evidence; their counts are
not a new combined regression-suite claim. Independent architecture review found
no blocker within the held-bootstrap/cancel diagnostic scope. It was source
review, not proof of Linux execution or complete cumulative I/O enforcement.

## Staging evidence

A single bounded retained-cgroup probe did not establish post-exit counters:
`ACTIVE_EXITED_GROUP_MISSING`. The expected active/exited state with a retained
cgroup was not observed within six seconds. The probe unit was stopped and its
private scratch file removed. Subsequent health checks found the original eight
service PIDs unchanged, both Paper health endpoints healthy, nine prior job
pairs unchanged, no active slot or pending systemd jobs, and the genuine
retention evidence intact. This failed probe is preserved as a limitation.

The separate runtime cancellation packet has 23 allowlisted source files and
five reviewed scripts. Its manifest SHA256 is
`d45af7e32a7f6dd8d99b126bc7cefd53f1e4915481b3cc6b198e0bc3a6ee48c4`.
Remote source and script hashes matched. Fresh health passed at 10:10:44 UTC;
isolated setup passed at 10:12:04 UTC with zero jobs, ledgers and launch intents,
and the SQL release guard enabled. Only the three optional foundation/ledger/
runtime schemas were installed in the new database.

One held-child cancellation case passed. It used a synthetic valid V2 PROFILE
contract solely as a protocol fixture, with no dataset access, result admission
or production configuration change. Job ID:
`9544aca8-1f0c-4935-8be5-dcb7a8c7e481`.

| Observation | Evidence |
| --- | --- |
| Child ready | 10:12:26.466 UTC; CPU quota 50,000/100,000, memory 536,870,912 bytes, tasks 16; launcher verified the approved per-device I/O limits |
| Cancellation completed | 10:12:26.874 UTC; foundation `CANCELLED`, launch `STOP_PROVEN`, result and checkpoint null |
| Conservative accounting | Ledger `CRASHED`; full reservation charged: 524,288 read bytes and 524,288 write bytes; these are not measured final counters |
| Repetition and stale authority | Repeat cancellation and stale start denied; ledger revision remained unchanged |
| Independent monitor | `SUCCEEDED` at 10:12:33.836 UTC; no emergency stop |
| Delayed readback | 10:13:32.438 UTC; no active slot/queue, child/driver/monitor inactive with PID 0 and empty cgroups, no pending systemd jobs |
| Existing state | Original eight service PIDs and both Paper health endpoints unchanged; nine historical job pairs and genuine retention evidence retained matching hashes |

Job marker to completion took 601 ms; ready marker to completion took 408 ms.
These intervals include protocol work and are not isolated cancellation latency
benchmarks. Five baseline and five impact samples passed health checks. DB p95
was 78.469 ms before and 1.099 ms during the case; maximum sampled production and
staging health-request durations were 215.653 ms and 100.891 ms. The short sample
does not establish sustained-load headroom or a performance improvement.

The diagnostic child had a native 30-second cap; the monitor bounded its case
window to 60 seconds. Driver and monitor also had CPU/memory/task and approved
per-device bandwidth controls. Their control-plane I/O is not included in the
child ledger's cumulative accounting. The isolated database and private logs
are preserved. No test operation remains active. The local PostgreSQL cluster
started for the focused checks was stopped; its data files remain.

## Remaining gates

Next work is trusted initial counter binding before payload release, actual
PROFILE/evaluator integration, post-stop accounting or a reviewed alternative,
main/control-plane and all-device coverage, calibrated stop-tail allowances and
the remaining timeout/pressure/crash/recovery matrix. Neither bandwidth limits
nor this diagnostic establish a cumulative byte cap.

QD-1/QS-1 remain open. Public capacity remains 10K bars including warm-up. Spot
Paper, BINANCE:BTCUSDT 1m and independent validation/holdout rules are unchanged.
There is no new research campaign, Best Inputs application, production rollout
or Live activation. Git checkpoint and deployment remain separate decisions.
