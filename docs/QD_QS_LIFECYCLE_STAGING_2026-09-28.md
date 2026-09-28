# QD/QS worker-managed lifecycle staging

## Scope

The owner requested one isolated staging set covering a database/scheduler job
through the actual main worker and evaluator, followed by stop/recovery checks
under the new I/O controls. This extends the earlier sequential main/evaluator
[readiness evidence](QD_QS_RUNTIME_IO_COMPLETION_2026-09-28.md).

The fixture reuses 4,533 historical bars and the reviewed SPT Custom source. One
baseline candidate runs only through validation index 3,876, with a maximum of
one evaluation. Ten parameter domains make dimension coverage incomplete after
one candidate, preventing sensitivity, stress and holdout evaluation. This is a
mechanical engineering fixture seeded directly in the isolated database, not an
HTTP enqueue acceptance test or a new optimization campaign. A correct
`NO_VALID_CANDIDATE` result is an acceptable lifecycle outcome.

Production and previous staging evidence remain unchanged. Bots remain stopped,
Spot/Paper-only and the 10K/1m capacity limit remain in force. No guard reset,
recommendation, production deployment or Git publication is part of this task.

## Operating bounds

Use a fresh database and empty, independently bound artifact namespace with the
previously verified immutable runtime. CPU is limited to 50% of one core, memory
512 MiB, tasks 16 and read/write bandwidth 524,288 bytes/second. Disk/temp budgets
are 512/128 MiB with at least 10 GiB filesystem free space. One heavy process may
run at a time; children retain the 30-second maximum and the baseline main unit
has a 120-second wall limit. The baseline job has an immutable 60-second deadline
starting at enqueue, after the monitor baseline is ready.

Monitor original service PIDs, HTTP, database latency, signal queue, CPU/load,
memory and disk. Stop only new test units on breach. Preserve evidence, require
physical process-stop proof before slot release and do not relax storage-retention
age rules to expedite a crash drill.

## Setup checkpoint

A new isolated database reached schema 14. The first backup helper missed the
connection URL's socket-host query and failed before any job or worker started.
The failed zero-byte backup was retained. A guarded resume verified empty
application tables and absence of foundation extensions, corrected host/port
resolution, wrote a new 93,747-byte backup and passed `pg_restore --list`.
FOUNDATION migration and storage binding then passed. The new worker unit was
installed inactive with the reviewed limits. Setup alone is not acceptance.

The first supervised seed attempt failed before a job was inserted or the main
started. Static review found eleven bound values for ten SQL placeholders after
a helper deadline edit. The transaction rolled back; the original helper did not
retain subprocess stderr, so the exact database error was not preserved. Its
intent and published fixture artifacts were retained. A guarded resume verified
the existing fixture hashes, corrected the binding count, and created a new job
and deadline without modifying the failed intent.

## Worker-managed baseline result

The corrected run passed through the actual database, scheduler, main worker and
evaluator. The research job returned `NO_VALID_CANDIDATE` with attempt 1 and exactly
one evaluation; the foundation job returned `SUCCEEDED`, with its worker/lease
cleared and no active job left. One candidate step reached index 3,876. The frozen
Python verifier confirmed checkpoint identity and integrity. The report recorded
ten selected dimensions, zero covered dimensions, no holdout evaluation and no
owner-ready recommendation, as required by the mechanical fixture.

Automatic completion succeeded with confirmed cleanup 11.4 seconds after the
ready marker. The monitor retained 30 baseline and 13 impact samples; impact
API/Web p95 was 8.05/8.68 ms and database p95 3.06 ms. Signal queue depth/age was
zero and HTTP/services remained healthy. Main/evaluator strict I/O readback matched
the configured limits; counters include readiness writes and are not an aggregate
workload-throughput measurement. Raw database/process evidence was saved before
acceptance checks. This closes the scoped worker-managed baseline, not the fault
cases or the full phases.

The subsequent read-only check confirmed all eight original service PIDs remained
active and unchanged, production and staging health endpoints returned HTTP 200
with `PAPER_ONLY`, and the production signal queue was empty. The new main,
monitor and driver were inactive with zero main PIDs; no owned evaluator units or
pending systemd jobs remained. The isolated database still had no active job.

## Active cancellation checkpoint

One additional job reused the exact baseline contracts with a new identity and
60-second deadline. Cancellation used the existing service method inside a database
transaction after a durable checkpoint at index 2,000 and a later child was observed
active. The transaction recorded research `CANCELLED`, foundation `STOPPING` and
one active slot. Foundation reached `CANCELLED` with no active slot and an empty
child unit after 1.429 seconds, below the declared 15-second bound. A delayed
readback found no added steps, changed cursor/checkpoint hash or final result.
This proves live-process cancellation after progress; it does not establish the
exact point within the child's payload execution or inject a forged late output.

The supervised attempt nevertheless failed automatic completion:
`STOP_UNCONFIRMED`, `cleanup_confirmed=false`, with adapter cleanup exit code 5.
This remains failed evidence. The database transition and measured stop latency
are partial passes, not a passing cancellation acceptance run. No retry or further
fault case was started in this checkpoint.

Final read-only verification found the main inactive, driver/monitor failed with
zero PIDs, the persisted transient child absent with zero PID, no pending jobs or
populated owned cgroups, and no storage reservations or pending files. The database
remained cancelled with unchanged cursor/hash, zero steps and no final result. All
eight original service PIDs were unchanged; production/staging health returned
HTTP 200 `PAPER_ONLY`, and the signal queue was empty. The nine impact samples had
API/Web p95 7.99/7.73 ms and database p95 2.57 ms, with no observed cgroup gaps/errors.
Safe final state does not retroactively pass automatic completion.

A later exact stop of the persisted transient unit returned exit code 5 because
the unit was no longer loaded. This is consistent with the cleanup failure, but
the adapter did not log its exact failing command, so root cause remains unproven.
Next action: review transient-unit cleanup handling and retain physical-stop proof
when a unit has already disappeared, then repeat the supervised cancellation gate
in a new, separately admitted attempt.

## Acceptance matrix

| Case | Required evidence | Current status |
| --- | --- | --- |
| Worker-managed baseline | Real claim, evaluator chunks, durable result, one charged evaluation, no holdout, physical cleanup and released global slot | Passed in isolated staging |
| Active cancellation | Cancel a running evaluator; reject late output and retain the slot until physical stop | Partial: state, slot retention, stop latency and unchanged delayed output passed; automatic cleanup completion failed and requires follow-up |
| Deadline/timeout | Preserve the original deadline and reach the correct terminal state with no surviving child | Pending |
| Health-pressure stop | Controlled isolated health failure; measured stop latency without stressing production | Pending |
| Crash/resume | Kill the main after a durable checkpoint; guarded recovery, new lease, stale-token rejection and result matching baseline | Pending |
| Readiness crash cleanup | Account for interrupted pending files/reservations and recover through existing ownership/retention guards | Pending |

Run cases sequentially, refreshing resource and account budgets at checkpoints.
No full QD-1/QS-1 phase closure follows from setup or from an individual case.
