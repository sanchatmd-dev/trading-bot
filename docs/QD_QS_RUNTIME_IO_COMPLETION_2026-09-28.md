# Actual worker I/O gate and calibration completion follow-up

## Scope and current outcome

The owner requested actual main-worker/evaluator I/O verification and correction
of the prior 11-second-late monitor completion. Bots remain intentionally stopped
until a future deployment. This follow-up does not authorize resuming them,
expanding capacity, opening the original holdout or starting an optimizer campaign.

The earlier [scratch and physical recovery evidence](QD_QS_PROFILE_STAGING_IO_2026-09-28.md)
remains valid only within its recorded scope. Scratch throttling is not application
startup acceptance.

## Actual main-worker negative test

A fresh three-warm/30-sample baseline passed: production API p95 5.43 ms,
database p95 1.39 ms, queue depth/age zero. The existing isolated PROFILE worker
received one owned temporary override with read/write limits of 524,288 bytes/second,
CPU 50%, RAM 512 MiB, 16 tasks and a 120-second wall bound. Its existing immutable
release and empty job queue were retained.

The actual main entry point exited with `QUANT_IO_TELEMETRY_UNAVAILABLE` from
`readCurrentCgroupIo`, before any job claim. Its short-lived cgroup was not captured
in that first attempt, so the exact missing field was initially unconfirmed.
The evaluator was not launched. No counter priming or gate relaxation occurred.
The temporary override was hash-verified and removed; original settings and all
eight original service PIDs were preserved. All three retained engineering jobs
kept their prior terminal states and attempt counts. This is a negative startup
test, not successful main-worker I/O acceptance.

A second, explicitly bounded diagnostic start used a private synchronous
`uncaughtExceptionMonitor` observer. It preserved the original exception and exit
behavior, performed no counter priming and captured the actual main cgroup at
failure. `io.max` matched the approved read/write limits exactly, while `io.stat`
contained only the device identity, with no `rbytes` or `wbytes` fields. This
confirms missing startup byte counters as the failure condition for that attempt.
The evaluator was not started, and no job was claimed.

After diagnostic cleanup at 14:51:55 UTC, the owned override was removed and the
isolated unit was inactive with its original settings. All eight original service
PIDs and the manager PID were unchanged, production/staging health passed with
zero queued signals, and no evaluator or manager job remained active. The retained
raw/clean/crash engineering jobs stayed successful with attempts 1/1/2 respectively.

## Local completion correction

The completion protocol now reserves cleanup time within the monitor's original
deadline and publishes a result automatically after work and physical-stop proof.
The operator-only driver accepts a reviewed adapter, claims the run exclusively
before importing it, and publishes atomically without replacing prior evidence.
An existing completion or start claim prevents repeated work for that run.

The monitor helper validates run identity, exact window, completion time, status
and cleanup proof. It rejects delayed receipt, stale runs and failed work instead
of treating file existence as success. System commands, HTTP/database probes and
sampling have explicit bounds within the remaining deadline. The adapter must
honor its abort signal; an independent host process-tree wall limit is still
required. Failed cleanup or late completion remains failed evidence.

Focused local checks passed 15/15, including real CLI subprocesses for successful
work, failed work, preserving old evidence and refusing a duplicate run. The
private monitor helper passed syntax validation. The subsequent staging result
below verifies the corrected protocol on a new bounded run; the prior
monitor-completion failure is not retrospectively converted to a pass.

## Bounded telemetry readiness implementation

The main worker now verifies the database/storage ownership binding before
preparing telemetry. It verifies the configured cgroup limits and the storage
device, reserves one 4 KiB pending file through the existing storage budget,
writes and fsyncs that file in its own cgroup, then requires genuine kernel byte
counters. Missing counters are never interpreted as zero. Cleanup checks the
owned file identity and releases its reservation; cleanup failure rejects startup.

The evaluator receives a separate reservation and prepares telemetry inside its
own systemd unit before reading the research payload. The parent supervisor
withholds the payload until strict cgroup readback succeeds and keeps the
reservation until physical termination is confirmed. This adds no trading logic,
new source parameters or recommendation eligibility.

Readiness polls are bounded at two seconds in main/child and three seconds in
the parent admission path. An independent process limit remains necessary because
filesystem calls can block. Audit found a late-read acceptance race; all three
paths now recheck the deadline before success, including immediately before the
parent sends the payload. A slow-read fixture reproduced the defect and passed
after correction. The final focused I/O suite passed 8/8; prior focused supervisor
checks passed 3/3, Python syntax and diff checks passed. These local checks do not
certify Linux runtime behavior.

## Staging attempts and retained failures

The first staging monitor attempt failed before workload startup because a
private helper referenced the wrong operation filename. The corrected attempt
proved actual main startup with its matching journal PID and strict I/O readback:
configured read/write limits were 524,288 bytes/second, and kernel counters were
`rbytes=0`, `wbytes=8192`. The logical bootstrap write was 4096 bytes; physical
counters include bootstrap and filesystem activity, not solely research work.

That attempt then failed a private evaluator-checkpoint verifier. The helper
assumed JavaScript and Python canonical JSON produced identical hashes; a
read-only comparison on the retained payload disproved that assumption. Unicode
escaping is one difference, but disabling it alone did not make the hashes equal.
The raw evaluator response and observer samples were not saved before rejection,
so they cannot be reconstructed as accepted evidence. The failed completion and
successful cleanup remain recorded. All original service PIDs were preserved,
and no temporary pending files or reservations remained.

## Successful bounded staging verification

The final run used the same immutable 120-file runtime release and retained
1,000-row engineering fixture. Its private verifier used the frozen evaluator's
Python digest and passed both correct-fixture and altered-integrity checks.
The adapter saved the evaluator response and observer samples before validation,
in an exclusive directory for the new run. Earlier failures were preserved.

The actual main entry point completed startup with matching journal evidence and
strict cgroup readback. The real `robot_quant.research_chunk` evaluator then ran
through the production supervisor after the main stopped. Both cgroups enforced
the configured read/write ceilings of 524,288 bytes/second. Eleven evaluator
observations retained actual counters and stable cgroup identity. Main/evaluator
physical writes were 8192/4096 bytes respectively, including the logical 4096-byte
bootstrap in each process; these values are not research-only I/O measurements.

The evaluator returned `next_bar=1000`, the expected last timestamp, matching
Python request/checkpoint hashes and no final recommendation result. The driver
published `SUCCEEDED` with `cleanup_confirmed=true` at 15:48:58.999 UTC. The monitor
accepted `DRIVER_DONE` within its original window, with 30 baseline and 36 impact
samples, healthy HTTP/services, zero queued signals and no observed cgroup gaps.
Completion took 35.250 seconds from the ready marker, leaving 264.750 seconds
before the deadline. Impact API/Web p95 was 5.00/4.63 ms, staging API/Web
5.39/5.14 ms and database 1.05 ms. Available memory stayed above 6565 MiB.

Final cleanup at 15:50:36 UTC confirmed all four test units inactive with no main
PID, the owned override removed, no running research, and zero pending files or
storage reservations. The eight original services and manager retained their PIDs;
production/staging health stayed `PAPER_ONLY`. The three prior engineering jobs
retained their successful states and attempt counts 1/1/2. Runtime administrator
I/O delegation remains applied and is not reboot-persistent.

This proves actual main startup, real evaluator execution through the supervisor,
and timely automatic completion for this bounded sequence. It does not prove a
new main-managed database research job, sustained-load performance, crash-safe
bootstrap cleanup or larger capacity. Retained engineering contracts were not
rewritten; the payload was an explicitly identified derivative, not a new research
campaign or holdout evaluation.

## Remaining acceptance

Integrate the scoped evidence into the QD-1/QS-1 acceptance matrix before phase
closure. Full phases remain open; runtime delegation is not reboot-persistent,
all-device coverage and cumulative-byte caps are unproved, and production release
and 10K/1m admission are unchanged. Bots remain stopped until a future deployment.

The owner authorized a temporary reduction of the usage reserve for this bounded
implementation and staging verification. The standing project reserve remains
unchanged for other work.
