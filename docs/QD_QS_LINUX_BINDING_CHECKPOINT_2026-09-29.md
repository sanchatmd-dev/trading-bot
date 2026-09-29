# QD/QS Linux binding checkpoint — 2026-09-29

## Scope

This checkpoint records one supervised Linux diagnostic case for binding a job to trusted I/O identity and counters before payload release. It does not establish cumulative enforcement, PROFILE integration, all-device coverage, or public V2 admission.

The case used manifest SHA-256 `7bd809747bd4888c04af0e66cd814468e4638bff0c6571af09fe000043cebe5f`, with 25 allowlisted sources and six scripts. It used job `c4319cd3-8172-4bbb-9c34-967371a56def` and operation `bind-protocol-4d9a71c2`.

## Observed binding and release

At 12:23:43.110 UTC, the Linux sampler recorded device `8:0`, device inode `156`, cgroup inode `299187`, invocation ID, PID and process start ticks. Kernel counters were read `0` and write `4096` bytes. The bound ledger committed revision 2 as `ACTIVE` with `CGROUP_BIRTH`, zero birth baseline, and the observed write counter before payload release.

The exact accepted payload receipt was recorded at 12:23:43.393 UTC. This supports one positive write-counter binding and release case. It does not establish a positive physical read; the read counter remained zero.

## Cancellation and cleanup

Cancellation completed at 12:23:43.616 UTC. The job became `CANCELLED`; the launcher recorded `STOP_PROVEN`; the ledger became `CRASHED`. The final counter remained unknown. Accounting conservatively charged 2 MiB read and 2 MiB write. These are charged amounts, not measured final counters. Result and checkpoint were null. Repeated cancellation and stale start were denied, and scratch and reservation state were clean.

The monitor passed at 12:23:50.579 UTC. Delayed readback at 12:24:28 showed no active child or driver and no active operation. Postflight at 12:24:55–56 found eight original process IDs, health checks, queues, prior cancellation state, and retention hash unchanged. The evidence does not establish an all-device physical bound or a cumulative cap.

## Local and independent review

Local checks passed: PostgreSQL 16/16, launcher 5/5, and Python 6/6. The Python probe used the standard library. Earlier corrections addressed code cleanup, registration and inode binding, probe implementation, and harness launch/stop flocking with a 15-second deadline. Astra independently reviewed source and the staging scripts before execution and found no blocker within this scoped case. The reviewer did not rerun checks.

## Limits and next gate

No test, counter read, or final-accounting claim extends beyond this case. Physical positive read, measured final counters, cumulative-cap enforcement, all-device coverage, and PROFILE integration remain unproved. PROFILE engineering continues under a separate gate; it is the next root-owned gate, not an outcome of this diagnostic.

Project scope remains public 10K bars including warm-up, Spot/Paper, `BINANCE:BTCUSDT` Spot 1m, and independent holdout gates. This was an isolated staging run; no production rollout, expanded capacity, or Live activation occurred. Timed engineering effort is unknown.

## Evidence references

Private raw evidence stays in ignored `.qa-local/linux-binding-evidence-v2/logs/`; this document records only the reviewed facts needed for the checkpoint. The initial local binding boundary is documented in [QD/QS initial I/O binding checkpoint](QD_QS_INITIAL_IO_BINDING_CHECKPOINT_2026-09-29.md). Neither document supersedes the Roadmap gates.
