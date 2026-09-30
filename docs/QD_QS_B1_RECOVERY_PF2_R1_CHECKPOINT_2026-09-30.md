# QD/QS B1 recovery and PF-2 R1 plan builder checkpoint — 2026-09-30

## Scope

Local code slices, pushed on branch `codex/app3a-market-wait-checkpoint`:

- `4b7d174` (CI): the Quant Lab job now runs the PF-2 resolver and driver tests
  with real Python on Linux and Windows; a would-be skip fails in that job.
- `e8e1920` (fix): offline recovery after a parent crash mid-terminal (QS-1 B1).
- `bce4015` (fix): recovery reports every unit it masked, and the recovery command
  prints a JSON report and exits with status 2 when rows stay blocked.
- `516b624` (feature): PF-2 R1, a pure plan builder, record derivation and
  result-envelope validator.

Two read-only reviews shaped this work: a scheduler review of a long STOPPING
terminal and a PF-2 runtime admission contract. Nothing is deployed. Scope stays
Spot/Paper only, BINANCE:BTCUSDT Spot 1m, the 10K-bar ceiling including warm-up,
independent holdout gates, no production rollout and no Live.

## QS-1 B1: recovery after a crash mid-terminal

Before this change, offline recovery skipped V2 PROFILE rows that still held I/O
state, and its release update hit the I/O release guard. A parent crash during a
terminal therefore wedged the whole foundation queue and deferred the unknown-final
charge indefinitely. The gap predates the writeback drain; a drained terminal of
about 50 s makes it more likely.

Recovery now handles these rows under the offline guard. It kills, stops and masks
the bound launch unit and requires the manager to report the unit gone, its cgroup
empty, no pending job and an empty worker inventory. Then, in one transaction per
row, it records the ledger crash with the unknown-final charge, acknowledges the
crash stop, marks the launch STOP_PROVEN and cancels the job. A row that had already
settled stays settled. Rows fail independently with an exact code, and a re-run is
idempotent and never charges twice. The follow-up lists every masked unit and makes
the recovery command print `{recovered, maskedUnits, blocked}` (codes and ids only)
and exit with status 2 on blocked rows. Behavior change: a masked unit that is still
live is now killed and stopped instead of aborting the whole run.

Evidence: 45 recovery tests on isolated PostgreSQL, covering a crash at every launch
stage, after the frozen commit and after the settle commit, per-row isolation,
manager refusals, a state change between planning and the row transaction and an
idempotent re-run; related PostgreSQL suites and 6 command tests also pass. An
independent tester and auditor accepted after fix rounds. The root replaced a
module-entry check in the recovery command that would have made it do nothing when
started through the release symlink.

Not proved: real systemd behavior (SIGKILL of a frozen cgroup, runtime masking of a
transient unit, unit state after collection) and the command's exit status on
Linux; these belong to an owner-approved Linux packet. The recovery module is in the
ingestion and foundation engine-hash lists, so both hashes rotate. Recovery now also
imports ledger and runtime modules that are not in those lists; adding them is
scheduled before product wiring.

## Scheduler review of a long STOPPING terminal

With the opt-in drain (up to 45 s) and the proposed FTR-1c barrier, a PROFILE
terminal can hold its unit frozen and its launch in STOPPING for about 50 s. Leases,
heartbeats, claims and charges stay safe: STOPPING holds no lease, terminal writes
are token-fenced, and nothing is charged twice or lost. The global scheduler slot is
held for the whole terminal. Before the drain can be wired into product code:

- B1, the recovery wedge, is fixed by this checkpoint.
- B2: no API reaches the drain abort. Worker SIGTERM and owner stop need an abort
  path, and the worker stop timeout and a deploy gate must cover the terminal.
- B3: at the 60 s cap the tail after the terminal deadline can overlap the systemd
  runtime limit. The FTR-1c proposal now includes a 5 s tail margin with the cap
  raised to 70 s, a bounded commit transaction and SIGKILL as the kill signal for
  drained units.
- B4: the terminal parameters must come from the job's hashed capacity policy, not
  from the caller or the environment.

FTR-1c itself remains proposed and awaits owner approval.

## PF-2 runtime admission contract and R1

A read-only contract splits the next PF-2 step into seven slices: R1 plan builder,
R2 schema and migration, R3 service with production adapters and a holdout registry,
R4 runner protocol through the I/O controls, R5 worker, scheduler and recovery
wiring, R6 API routes, and R7 an owner-authorized staging packet. It found that no
durable PROFILE v2 enrollment exists yet, so no PF-2 staging run can happen until
trusted PROFILE enrollment exists.

R1 (`516b624`) adds `src/quant-research/preflight-plan.js`. It builds the plan on
the server from the enrolled PROFILE v2 job, the deployment, the source revision,
the holdout boundary and the executable hashes, derives the record hashes the
resolver expects, and validates a stored result envelope with the plan bound, the
budget pinned and the policy-independent result invariants re-checked. It reads no
database, network, clock or environment and is not wired to any runtime. Its 28
tests, including a real S4 run through the validator, and the existing resolver,
driver and contract suites pass (114 with the project interpreter). An independent
auditor accepted after one hardening round.

Owner decisions pending, with recommendations in the contract:

- OD-1: no PF-2 staging run until trusted PROFILE v2 enrollment exists.
- OD-2: one owner-registered, write-once holdout boundary per bot that never
  exposes the QL-3A holdout.
- OD-3: a READY deployment with a fresh snapshot at enqueue and at every authorize.
- OD-4: migration, deploy and first run as one owner-authorized operations packet
  after draining the queue, because engine hashes rotate.
- OD-5: API only for now; PF-3 owns the report UI.

R2 and R3 wait for OD-2 and OD-3.

## Evidence summary

The root reran the checks at about 01:52 UTC: the recovery and runtime PostgreSQL
suites 82/82, the four preflight suites 114/114 with no skips, and the full Node
suite 607 tests, 606 pass, 1 pre-existing skip, 0 fail. CI passed all nine checks
for `4b7d174`, including the Quant Lab jobs that now run the real-Python tests, and
for `e8e1920`, including the PostgreSQL job with the new recovery tests.

## Effort and usage

Measured wall-clock: read-only reviews about 23:48-00:06 UTC; wave F (B1 and R1
build, verification and fix rounds) about 00:14-01:17 UTC; wave G (R1 hardening
and B1 follow-up) about 01:18-01:50 UTC, then root checks until about 01:55 UTC.
The shared 5-hour usage window went from 1% to 8% used over the reviews, 8% to 23%
over wave F and 23% to 29% over wave G and the root checks; the weekly all-models
counter went from 16% to 19%. Shared counters do not attribute cost to an agent or
step. The agents ran under the owner-approved temporary elevated tier. No
engineering hours are booked and no speedup is claimed.

## Scope and status

Commit and acceptance are separate facts: the four commits are pushed and were
accepted by independent reviewers. CI for `bce4015`, which also covers `516b624`,
was still running when this record was written. Nothing is deployed.
