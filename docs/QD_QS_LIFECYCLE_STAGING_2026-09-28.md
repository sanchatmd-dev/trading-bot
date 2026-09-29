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

## Cancellation cleanup follow-up — 2026-09-29

Read-only diagnosis reproduced exit code 5 by stopping the exact persisted child
from the failed run after systemd had removed its transient unit. The manager
reported `LoadState=not-found`, `ActiveState=inactive`, zero main PID and an empty
control-group path; the stop command reported that the unit was not loaded. The
private staging adapter awaited that command using a rejecting subprocess helper,
so it exited before verifying the physical stopped state. This reproduces the
cleanup failure mechanism; the original log retained only code 5, not the exact
failing command. Production supervisor code was not changed by this diagnosis.

The correction must verify stopped launchers, exact owned unit identity, successful
manager readback, no pending start job and no populated cgroup. A nonzero stop exit
alone cannot become success. Permission failures, unreadable telemetry and unknown
state must fail closed. The previous failed run remains immutable evidence.

The corrected private helper passed syntax checks locally and on staging. Focused
classifier checks accepted a stopped unit and an exactly identified absent unit,
while rejecting a live unit, unrelated exit code 5 and permission failure. One
new job reused the same immutable baseline contracts with a new identity and
60-second deadline; the old baseline and failed-cancel records were preserved.

The new supervised cancellation passed. A live child was observed after a durable
checkpoint at index 2,000. The cancellation transaction recorded research
`CANCELLED`, foundation `STOPPING` and one retained slot. The child was physically
empty and foundation reached `CANCELLED` with zero active slots in 1.474 seconds,
within the declared 15-second bound. A later readback showed unchanged checkpoint
cursor/hash, zero completed steps, no final result and the original deadline.

Automatic completion returned `SUCCEEDED` with `cleanup_confirmed=true` before
the job and monitoring deadlines. Cleanup explicitly captured exit code 5 and
the exact missing-unit message, followed by successful manager readback showing
the unit absent, zero PID, no cgroup and no pending job. All test units had zero
PIDs; storage reservations and pending files were empty. The original eight
service PIDs were unchanged, both health endpoints returned HTTP 200 `PAPER_ONLY`
and the signal queue was empty. This closes the scoped live-child cancellation
case, not forged late-output injection, HTTP enqueue or the remaining fault cases.
The fix is confined to the staging harness; production runtime was unchanged.

The monitor accepted `DRIVER_DONE` 8.406 seconds after ready, with 30 baseline and
10 impact samples. Impact database/API/Web p95 was 1.06/4.67/5.86 ms, with zero
cgroup gaps/errors and an empty signal queue. Main/evaluator read/write limits
remained 524,288 bytes/second on the verified device. These short observations do
not establish additional sustained-load or capacity acceptance.

## Timeout preparation checkpoint — 2026-09-29

The owner requested the remaining timeout, health-pressure, crash/recovery and
readiness cleanup cases sequentially. Local source review found separate child
and scheduler clocks: the child timeout is the lesser of 30 seconds and the
remaining job deadline. Suspending a child in the existing 60-second fixture
would therefore exercise evaluator timeout first, not necessarily scheduler
deadline expiry. At a shorter deadline, the supervisor and scheduler can race,
producing different terminal diagnostics. Expected outcomes must be declared
before execution and attributed to the path actually observed.

A proposal to trigger quarantine with an external scheduler claim was not
approved as proof of normal main-worker deadline behavior. No new helper, VPS
connection, job or fault injection ran during this preparation. Work stopped at
the account usage reserve. The last verified server state is the cancellation
cleanup readback above; it was not refreshed during this local review. All four
remaining cases stay pending. Resume by refreshing usage and health, then define
a bounded deadline test that preserves the original deadline and clearly records
which component initiates stopping.

## Child-timeout attempt — 2026-09-29

One isolated attempt reused the frozen fixture with a new 60-second job deadline.
The harness found a live evaluator after durable cursor 2,000, but its bounded
probe did not observe the completed 4 KiB readiness file. It stopped with
`READINESS_NOT_OBSERVED` before sending SIGSTOP. This attempt proves neither
evaluator timeout nor scheduler deadline expiry; both acceptance paths remain open.

Automatic completion reported `FAILED` / `WORK_FAILED`, with
`cleanup_confirmed=true`. Cleanup left research `FAILED` with
`RESEARCH_INTERRUPTED`, foundation `CANCELLED` and zero active slots. Cursor/hash,
steps, result and deadline remained unchanged. Final readback at 18:25:32 UTC on
2026-09-28 found all test processes stopped, no pending jobs, populated child
cgroups or storage reservations, and all eight original service PIDs unchanged.
Both health endpoints returned 200 and `PAPER_ONLY`; the signal queue was empty.

The monitor collected 30 baseline and eight impact samples. Impact database/API/
Web p95 was 1.44/7.13/6.63 ms, with zero cgroup gaps or errors. These observations
do not close a fault or capacity gate. Preserve the failed attempt; diagnose the
readiness observation before admitting another bounded attempt. Pressure,
crash/recovery and readiness crash cleanup did not run in this wave.

Read-only diagnosis found about 0.63 seconds between child start and probe failure,
while the product I/O gate permits up to three seconds. Python imports precede
the readiness write. Premature private-probe expiry is the best-supported cause;
missing per-poll file observations prevent a definitive conclusion. The proposed
next correction is a wall-clock probe capped at 2.5 seconds with compact file-size
and PID evidence, retaining all identity, payload-read and stop-margin checks.
This correction is not implemented or accepted. Work stopped at the normal
20-point usage reserve; no further fault case ran.

## Child-timeout readiness rerun — 2026-09-29

A second isolated child-timeout attempt used the corrected bounded readiness probe. The probe observed the exact 4,096-byte file after about 1.055 seconds. At that point, `/proc/PID/io` `rchar` showed no observed increase; a later read returned `EACCES` at about 1.27 seconds. The source of `EACCES` remains unconfirmed. The harness failed closed and sent no `SIGSTOP`. Therefore, this run did not inject or accept evaluator-timeout behavior.

Automatic completion reported `FAILED` / `WORK_FAILED`, with `cleanup_confirmed=true`. Research ended `FAILED` / `DATASET_CANCELLED`; foundation ended `CANCELLED`; active slot was zero. Cursor advanced naturally from 2,000 to 3,000 before cleanup, with zero steps and no result. This was not a late write after a fault because no fault was injected. The original deadline and contract hashes remained unchanged.

Final readback at 18:38:37 UTC on 2026-09-28 found original services healthy, all eight original service PIDs unchanged, no pending jobs, populated cgroups or storage reservations, and HTTP 200 `PAPER_ONLY` health. These are historical observations, not current runtime health. Preserve the earlier `READINESS_NOT_OBSERVED` failure. Evaluator timeout remains pending; scheduler deadline, health-pressure stop, crash/resume and readiness crash cleanup also remain pending. Root is considering a separate after-readiness timeout design; it has not been executed or accepted.
## After-readiness evaluator timeout — 2026-09-29

One new isolated attempt passed the scoped timeout gate. The harness confirmed
the exact 4 KiB readiness file, preserved a pre-signal snapshot at cursor 2,000,
sent SIGSTOP to the owned evaluator and verified the same PID in state `T`.
Research ended `FAILED` / `EVALUATION_TIMED_OUT`; foundation ended `CANCELLED` and
the active slot count returned to zero. The original 60-second deadline,
checkpoint hash, cursor, zero steps and null result remained unchanged.

Physical stop was observed 111 ms after the estimated systemd timeout point,
within the 15-second bound. This is not a precise measurement from the JavaScript
timer firing. Automatic completion was `SUCCEEDED`, with cleanup confirmed at
18:48:49.658 UTC on 2026-09-28. Delayed readback at 18:50:40 UTC found all six jobs
terminal, all test units stopped, no pending jobs, populated child cgroups or
storage reservations, and original service PIDs and Paper health unchanged.

The monitor collected 30 baseline and 38 impact samples. Impact database/API/Web
p95 was 1.14/6.16/6.02 ms; health and services remained healthy, the signal queue
was empty, and no cgroup errors or gaps were reported. Natural `STOPPING` with
slot one was not sampled, so this run does not independently prove intermediate
slot retention. It proves a live-child timeout after readiness, not interruption
during payload computation. Scheduler deadline, health pressure and both crash
cases remain separate open gates. The two setup failures remain immutable.

## Pressure startup checkpoint — 2026-09-29

The completed private pressure harness passed local syntax/proxy checks and
remote syntax/hash verification. Isolated environment, policy and main/proxy
units were created; the original runtime and unit hashes remained unchanged.
One launch failed at proxy startup with `Result=signal`, exit `6/ABRT`, before
monitor, driver, job intent or fault flag creation. This is setup failure and
provides no pressure-stop acceptance.

The journal recorded no decisive cause. Observed memory peak was 17.9 MiB under
the 64 MiB cap; the eight-task limit is a possible cause, but task peak and crash
detail were unavailable. Do not attribute the abort to memory or task limits
without further evidence. No retry or configuration relaxation occurred.

The launch trap stopped the new units. Final readback at 05:21:19 UTC on
2026-09-29 found main inactive, proxy failed with PID zero, driver/monitor absent,
no pending jobs or child cgroups, and clean storage. All six prior jobs remained
terminal, execution occupancy was zero, original service PIDs and both Paper
health endpoints were unchanged, and the signal queue was empty. The failed
operation remains preserved. Resume with a bounded proxy-startup diagnosis after
fresh usage and health checks.

## Wrapped Node task-limit diagnosis — 2026-09-29

Two bounded shell-wrapped Node startup probes isolated the task-limit behavior.
With `TasksMax=8`, Node aborted with status 134 before `FS_READY`; the cgroup
reached `pids.peak=8` and `pids.events:max` rose from 0 to 1. OOM and kill
counters remained zero. With `TasksMax=16`, the same `fs.stat` probe emitted
`FS_READY` and exited 0; `pids.peak=12`, `pids.events:max` stayed 0, and OOM
counters remained zero. Both exact units were stopped with PID 0; the limit-8
unit retained its failed state and the limit-16 unit was inactive.

This proves task-cap exhaustion for the wrapped probe at limit 8 and successful
wrapped startup at limit 16. The original direct proxy `SIGABRT` is consistent
with task exhaustion, but its cause remains unproven because no direct proxy
cgroup counter was captured. A trailing CRLF shell parse error occurred after
both unit stops and made the SSH command exit 1; it does not invalidate the
recorded unit counters or outcomes. Final health at 05:54:35 UTC on 2026-09-29
found the six prior jobs terminal, slot and queue at zero, original eight PIDs
and both Paper endpoints healthy, storage clear, and both diagnostic units at
PID 0. The actual-proxy smoke remains pending. No proxy cap change or pressure
retry is authorized by this diagnosis; health evidence is historical.

## Actual proxy smoke — 2026-09-29

A separately authorized transient smoke used the unchanged proxy source with
`TasksMax=16`, `MemoryMax=64M`, `CPUQuota=10%`, a 20-second runtime cap and core
dumps disabled. The proxy owned the expected loopback listener and cgroup. Both
original and forwarded health returned HTTP 200 with `ok:true` and `PAPER_ONLY`.
Observed task peak was 11, with no task-limit event; memory peak was 18.17 MiB,
with no OOM event. Exact stop returned inactive/PID zero and closed the listener.

Final readback at 06:00:15 UTC found six prior jobs terminal, slot and queue zero,
storage clear, and the original eight service PIDs and Paper health unchanged.
No Quant job or health fault was created. This establishes proxy startup and
forwarding at the tested cap, not pressure-stop acceptance. The failed original
operation remains immutable. A separately named rerun must preserve its files,
use the frozen release and retain all main/evaluator limits.

## Pressure rerun after proxy smoke — 2026-09-29

One new operation used separate units, environment, policy, markers and logs.
The frozen release, dataset and main/evaluator limits were unchanged. Reviewed
helper hashes and syntax matched; original runtime, unit and failed-operation
hashes remained unchanged. Main I/O limits and counters passed readback.

The first evaluator failed with `QUANT_IO_GATE_FAILED` before the adapter caught
the required live child at cursor 2,000. Its durable cursor stayed zero, checkpoint
was null, steps were empty and no result was published. No SIGSTOP or health fault
was injected; neither STOPPING nor PAUSED was sampled for pressure acceptance.
Child start at 06:10:16 UTC and client-request SIGKILL at 06:10:19 are consistent
with the three-second startup gate, but the generic catch did not preserve the
inner assertion. The exact cause remains unproven.

Automatic completion at 06:10:21 UTC reported `FAILED` / `WORK_FAILED` with cleanup
confirmed. Delayed readback at 06:13:04 found research `FAILED`, foundation
`CANCELLED`, the original deadline and contract hashes intact, no active execution
slot, no owned process, pending job, cgroup or storage reservation, and the listener
closed. Original eight service PIDs and both Paper health endpoints were unchanged;
the trading queue was empty. The monitor recorded 30 baseline and nine impact
samples; impact database/API/Web p95 was 3.08/6.74/7.42 ms with healthy original
services. These short observations do not establish sustained capacity.

Preserve this failed run and the earlier startup failure. The next action is to
isolate the missing I/O failure detail while keeping the gate and resource limits.
Do not treat another uninstrumented retry as a diagnosis or a passing fault case.

## Local I/O diagnostics checkpoint — 2026-09-29

Source review confirmed that several I/O failures and premature stdout shared the
same public code while their inner details were discarded. A local patch adds
private `error.ioDiagnostic` metadata: first-failure phase, sanitized cause and
filesystem marker, elapsed time, unit registration, last accepted inode/counters,
early-stdout flag and a capped stderr byte count. It records no raw stdout, stderr,
payload, environment or paths and adds no automatic logging or public response.

The first-failure snapshot is captured before physical stop and cleanup. Review
also identified missing immediate capture for output overflow and nonzero process
exit; both paths were corrected. Public failure codes, stop/cleanup precedence,
the three-second gate, physical limits and the prior typed-readiness correction
remain intact.

The combined command `node --test test/quant-io-diagnostics.test.js
test/quant-io-controls.test.js test/quant-storage-budget.test.js
test/integration/process-supervisor.test.mjs` passed 24/24 in 16.240 seconds after
the corrections. New tests cover low-level sanitized causes and synchronous
injected callbacks; existing process tests use the explicit local Windows mode.
They do not exercise the actual Linux/systemd I/O gate. The patch is local only;
one separately reviewed, immutable staging diagnostic package must collect the
missing failure detail before any new pressure acceptance attempt.

## Acceptance matrix

| Case | Required evidence | Current status |
| --- | --- | --- |
| Worker-managed baseline | Real claim, evaluator chunks, durable result, one charged evaluation, no holdout, physical cleanup and released global slot | Passed in isolated staging |
| Active cancellation | Cancel a live child after durable progress; retain the slot until physical stop and verify no later cursor, step or result publication | Passed on 2026-09-29 in isolated staging: 1.474-second stop, automatic cleanup confirmed; original failed attempt retained |
| Evaluator timeout | Observe the child timeout path, preserve the original job deadline and verify terminal state with no surviving child | Passed after readiness: confirmed SIGSTOP, `EVALUATION_TIMED_OUT`, unchanged snapshot/deadline and automatic cleanup; intermediate STOPPING was not sampled |
| Scheduler deadline | Observe normal worker/scheduler deadline expiry separately from the evaluator timer, with no surviving child or deadline extension | Pending |
| Health-pressure stop | Controlled isolated health failure; measured stop latency without stressing production | Pending; proxy smoke passed, but subsequent evaluator I/O startup failure prevented fault injection; cleanup verified |
| Crash/resume | Kill the main after a durable checkpoint; guarded recovery, new lease, stale-token rejection and result matching baseline | Pending |
| Readiness crash cleanup | Account for interrupted pending files/reservations and recover through existing ownership/retention guards | Pending |

Run cases sequentially, refreshing resource and account budgets at checkpoints.
No full QD-1/QS-1 phase closure follows from setup or from an individual case.
