# QD/QS terminal handshake staging checkpoint

## Accepted scope

One isolated engineering job exercised the actual scheduler, main worker and
Python evaluator with the optional `quant-io-terminal-v1` protocol. The release
used a frozen 120-file base and five reviewed overlays. It excluded unrelated
local V2 capacity, enrollment, health-recovery and I/O-ledger changes.

- Job: `6ac2edbb-423e-4868-9d33-294b2fa99c78`.
- Engine: `6295e57d35f1ecd8c61d5b26bdab516f40a527fe41e46d19f7af78528b32cf4b`.
- Automatic completion: 2026-09-29 08:55:14.394 UTC; `SUCCEEDED` and
  `cleanup_confirmed=true`, 9.982 seconds after the issued marker.
- Research result: `NO_VALID_CANDIDATE`; foundation result: `SUCCEEDED`.
- One attempt, one evaluation, one candidate result and checkpoint cursor 3,876.
  Covered dimensions were zero and holdout was not evaluated, as required by
  this engineering fixture. This is not a qualifying optimization run.
- The original three-second I/O readiness gate, 30-second evaluator timeout and
  immutable 60-second job deadline remained unchanged.
- Main/evaluator limits remained CPU 50%, memory 512 MiB, 16 tasks and read/write
  bandwidth of 524,288 bytes/second. Bandwidth limits are not cumulative byte caps.

The protocol keeps the evaluator alive after it emits its result, allowing final
I/O readback before ACK and process exit. The successful result traversed four
chunks. There is no separate per-child ACK or final-counter event log; protocol
completion is supported by the reviewed code path and successful completion,
not a standalone ACK trace. This run does not independently establish the cause
of the earlier monitor-stage `ENOENT` failure.

## Setup failure and correction

The first setup stopped with `EACCES` while writing the first overlay into a
copied read-only file. No job or unit had been created. Inspection verified
distinct copied inodes, single-link regular files and unchanged parent bytes.
A reviewed, single-use continuation temporarily granted owner-write only to the
four copied overlay files and one copied module directory. It restored their
read-only modes, synced the files/directory, verified all original 120 entries
and the new engine, then created the new isolated runtime configuration. The
failed setup remains recorded; it was not treated as a research failure or
silently retried.

## Cleanup and observed impact

Delayed readback at 08:57:59.477 UTC confirmed nine terminal job pairs, zero
active jobs/execution slots/trading queue, stable result/checkpoint/deadline and
unchanged prior eight jobs. All owned main, driver and monitor units were
inactive with PID zero; no owned child group or pending unit job remained.
The original eight services, their process identities, health, configuration,
storage and separate genuine 24-hour retention pair were unchanged.

The monitor recorded 30 baseline and 11 impact samples. All HTTP/service checks
were healthy; queue depth and age remained zero. Observed p95 times were DB
2.292 ms, API 7.647 ms, web 9.384 ms, staging API 11.843 ms and staging web
12.050 ms. Evaluator nonidle time was 5.413 seconds, CPU time 2.767 seconds and
maximum observed memory 68.268 MB, with no sampled cgroup gaps/errors. This short
window does not calibrate larger workloads or establish sustained capacity.

## Remaining gates

QD-1/QS-1 remain open. Scheduler deadline, controlled pressure, current-control
crash/recovery, actual-supervisor readiness cleanup, durable cumulative I/O,
trusted enrollment, expanded state parity and remaining heavy-path admission
still need their own evidence. Genuine retention cleanup remains due no earlier
than 2026-09-30 13:53:52 Asia/Bangkok.

There was no public enqueue acceptance, holdout access, new research campaign,
Bot restart, production deployment or capacity increase. The private evidence
packet retains ready/done markers, setup inspection, database snapshots,
cleanup, health samples and delayed readback; machine locations and credentials
are intentionally excluded from this tracked record.
