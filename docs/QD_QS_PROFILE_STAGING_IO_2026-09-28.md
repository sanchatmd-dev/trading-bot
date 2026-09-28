# PROFILE staging recovery and I/O enforcement

The owner authorized this operational follow-up on 2026-09-28 after local
browser and PROFILE acceptance. It covers a new isolated staging namespace,
physical worker recovery and the prerequisite for I/O enforcement. It does not
authorize changing an existing production release or expanding research capacity.

## Read-only preflight

A fresh baseline used three warm-up probes followed by 30 samples. All eight
existing services and their HTTP checks were healthy. Observed p95 latency was
5.35 ms for the production API, 4.86 ms for Web, 5.53 ms for the existing staging
API, 5.23 ms for staging Web and 1.15 ms for the database. Queue depth and oldest
age were zero; maximum load1 was zero, minimum available memory was 6,680.9 MiB,
and minimum free disk was 91.85 GiB. These observations permit preparation of the
bounded drill; they are not measurements under its load.

The service user's manager delegates CPU, memory and PIDs, but not I/O. No
ancestor disables controllers explicitly. SSH has no noninteractive sudo rights,
so system-manager changes require an administrator-run command. A command that
merely accepts bandwidth properties does not establish kernel enforcement.

## Bounded drill contract

Use a manifest-verified immutable copy of the reviewed working tree, a new test
database, a protected artifact root and a new worker unit. Preserve all existing
services and evidence. Use at most 1,000 actual Spot 1m bars, including 500
ATR seed bars, with verified exchange provenance. Reuse an existing artifact only
if its page provenance and slice lineage remain valid; otherwise use one bounded
exchange fetch. Synthetic bars cannot claim the exchange BACKFILL source identity.
No optimizer campaign or holdout evaluation is part of this test.
The existing admission limit remains 10,000 bars including warm-up.

Bound the worker to 50% of one CPU, 512 MiB memory and 16 tasks. Storage budgets
are 512 MiB disk and 128 MiB temporary data, with a 10 GiB free-space floor.
Use one job at a time and a finite 15-minute operational deadline. Monitor the
existing Trading/Web/DB health against the thresholds in the
[prior staging contract](QD_QS_RECOVERY_STAGING_2026-09-28.md).

The proposed deterministic failure point is after immutable dataset/sidecar
publication but before fenced completion. A private, immutable test prelude may
hold that point so the watcher can kill the exact new worker PID. Record the
instrumentation separately from product source. Recovery must prove physical
process absence, retain the original deadline and contract, reject the old lease,
and reproduce the clean baseline result with a new attempt. This failure point
does not certify every possible crash during a filesystem write.

## I/O prerequisite and rollback

Prepare one owned runtime drop-in to add I/O to the service user's existing
delegated controller list, then reload configuration and inspect actual state.
Preserve all previously delegated controllers and
record prior accounting settings and exact runtime snippets. No service restart,
manager re-execution or reboot belongs to this change. Restoration must affect
only settings and files created by this operation; broad unit reversion is not
allowed. Reload configuration after restoring the exact prior runtime files.

Static review corrected rollback reporting and failed readback handling. Restoration
compares the kernel controller hierarchy with its saved baseline and reports any
residual difference, without forcibly disabling controllers used by descendants.
Required status reads fail closed. Restoration can retry if the owned drop-in was
already removed before a failed reload. Four local mocked scenarios passed: normal
apply/restore, failed reload, missing controller and refusal to remove a changed
drop-in. Bash syntax passed. These checks do not prove Linux enforcement.

Source review rejected the first `set-property Delegate=...` draft before use:
systemd 255 handles that property only while creating a transient unit, and its
controller-list setter adds to the mask. The active user manager therefore needs
a different, explicitly verified runtime configuration path. See the official
[systemd implementation](https://github.com/systemd/systemd/blob/v255/src/core/dbus-cgroup.c).

Systemd documents automatic controller propagation through the hierarchy and
runtime changes for supported resource settings. Actual controller availability
and limits must still be read back on this host. See the official
[systemd 255 resource-control reference](https://github.com/systemd/systemd/blob/v255/man/systemd.resource-control.xml)
and [runtime property reference](https://github.com/systemd/systemd/blob/v255/man/systemctl.xml).

After delegation, use a bounded scratch workload on the observed accounting
device. Read actual `io.max` and `io.stat`, including counter deltas and elapsed
throughput. Empty statistics remain unknown; do not flush global caches or infer
enforcement from `io.pressure`. Main-worker and evaluator readback require
separate evidence. Absolute bandwidth limits do not prove a cumulative byte cap
or coverage of every writable device.

## Execution status

The isolated release and database were created with base schema 14 and a 93,763-byte
base backup. One 1,000-bar exchange BACKFILL request was queued. The first monitor
exited with signal 6 before readiness; its eight-task ceiling is a suspected cause,
not a confirmed diagnosis. A second monitor reached application validation but
rejected its requested 600-second window: the calibration contract allows at most
300 seconds. This was a private helper configuration error, not a product-contract
change. All new application/monitor units were stopped before any Quant worker or
exchange fetch started. Failed logs and the queued request were retained.

The next bounded attempt corrects the helper to the existing 300-second limit and
requires fresh health plus a valid original job deadline. The corrected attempt
completed the raw BACKFILL and the physical PROFILE sequence below before its
monitor deadline. Impact and cleanup evidence are recorded separately from job
correctness.

### Physical PROFILE result

The immutable release manifest contains 372 files. Archive SHA256:
`804248781d43b1384ff392d92f2cedf156c3c730222932a0f63a611a2bfb6d86`.
BACKFILL `05e6bd3e-5bde-4b8f-a291-6b6b4c394184` completed 1,000 actual Spot
bars in one attempt. Baseline PROFILE `9cb73a0f-db82-41c2-8a88-36be2e06d408`
succeeded in attempt 1. Crash PROFILE `240d99b4-ce6f-494e-823c-657baf85722a`
was killed after durable publication while its result and checkpoint remained null.
Offline recovery moved it to PAUSED, then the real main worker completed attempt 2.
The original deadline and contract were unchanged. Both complete result hashes,
raw/derived/sidecar hashes and binding hashes match; `data_profile_verified=true`
and `evaluator_admission=false`. The old lease heartbeat was rejected with
`FOUNDATION_LEASE_LOST` after terminal completion; this check does not independently
prove rejection during an active replacement attempt.

The offline guard required runtime masking. Newly created persistent test unit
files took precedence over the runtime mask, so the operator temporarily relocated
only those owned files, verified masking, then restored them after recovery. Existing
service files were not changed. The failure point covers publication before result
binding, not arbitrary partial writes or every other scheduler path.

### Impact observations and completion failure

The physical recovery and result checks completed before the monitor deadline.
However, the driver wrote its done marker 11 seconds late. The monitor returned
`MONITOR_DEADLINE` and stopped the idle new Quant worker. This is a failed monitor
completion gate, not a passing supervised run. Preserve this attempt for review.
All 296 impact samples kept the original services and HTTP checks healthy:
production API p95 4.59 ms, database p95 1.04 ms, queue depth/age zero, maximum
load1 0.44, minimum available RAM 6,528 MiB and free disk 91.80 GiB. These observed
values do not override the failed completion gate. All three new application units
were inactive with main PID zero after cleanup.

### Administrator-run delegation

After the owner ran the reviewed apply command, readback at 14:02:27 UTC confirmed
I/O in the user manager's delegated controller list, accounting enabled, and
`io.stat` present at all three inspected ancestors. All eight existing services
remained active with the same main PIDs as the earlier baseline. This proves
controller delegation without restarting those services. It does not prove a
bandwidth limit on a research workload. The runtime drop-in remains applied;
it is temporary across reboot and has an owned restore command.

### I/O probe did not establish enforcement

One bounded scratch unit requested 524,288 bytes/second in each direction and
performed a 4 MiB direct write followed by a 4 MiB direct read. Observed durations
were 146 ms and 112 ms, which do not demonstrate the requested throttle. The unit
exited before external sampling captured its cgroup, so workload `io.max` and
counter deltas are unavailable. Subsequent hierarchy inspection found that the
user manager exposes I/O but does not enable it in its subtree; the application
slice has neither the controller nor `io.stat`. Ancestor readback was insufficient.
No actual main-worker or evaluator enforcement is accepted.

That hierarchy inspection occurred after the scratch unit exited. An idle slice
can legitimately omit a controller that no active child requests. Consequently,
the idle hierarchy alone does not prove the cause; limits must be inspected inside
an active unit requesting I/O control.

The systemd 255 source computes supported controllers during manager construction;
the configuration reload path does not repeat that setup. This supports a stale
user-manager controller mask as the working diagnosis, not a proven host repair.
See [manager setup/reload](https://github.com/systemd/systemd/blob/v255/src/core/manager.c)
and [cgroup controller setup](https://github.com/systemd/systemd/blob/v255/src/core/cgroup.c).
Refreshing the user manager by re-execution needs a separately reviewed operational
packet because the current packet explicitly excludes it and the manager supervises
existing trading services. Do not restart the user service, reboot, or write directly
to the controller tree as a shortcut. The next probe must capture its own cgroup
limits before any I/O and retain counter evidence before exiting.

### Safe checkpoint

After cleanup, all new application and scratch units were inactive with main PID
zero. No research transient remained active. All three engineering jobs were
terminal. Thirty post-cleanup samples measured production API p95 4.11 ms, database
p95 1.16 ms and zero queue depth/age. All eight original service PIDs were unchanged
and active. The new private database, backup, release, artifacts and logs remain
available for review. No product source changed during these operational probes.

The manager-refresh follow-up was statically reviewed, including exact scratch-file
ownership, no raw-device writes, unchanged service PID checks and no automatic
restart/retry. The owner subsequently authorized this plan and stated that all
Bots were intentionally stopped until a future deployment. This does not authorize
resuming Bots or deploying a release. Execution evidence is recorded below when
available. Git commit, push, production rollout and capacity expansion were not
performed.

### Owner-approved manager refresh

One `systemctl --user daemon-reexec` completed successfully after the owner approved
the reviewed extension. All eight original service PIDs and the manager PID were
unchanged, and production/staging health remained `ok`, Paper-only, with no queued
signals. The live executable inode was unreadable; the approved substitute checked
the manager's exact version against the installed package and verified the
root-owned executable against its package checksum. This limitation is retained.

An active scratch unit subsequently read its own `io.max` with both read and write
limits at 524,288 bytes/second on the observed device. Thus descendant controller
configuration is now evidenced while requested. The helper then rejected an invalid
`dd` flag before writing any data; the exclusively created scratch file was zero
bytes and removed. This attempt proves limit configuration only. Its log is retained;
the corrected helper uses the supported conversion option in one separately bounded
attempt. No second manager re-execution or service restart was performed.

### Successful bounded scratch proof and final state

The corrected attempt verified exact `io.max` limits before writing. A 4,194,304-byte
direct write took 7,970 ms; a direct read of the same size took 8,007 ms. The unit
completed successfully in 16.015 seconds under its 45-second bound. These timings
demonstrate approximately 0.5 MiB/second for this bounded workload, including normal
short-window variation; they do not establish a cumulative I/O budget.

Initial `io.stat` contained the device identity without counters, so its baseline
is unknown and an exact counter delta is not claimed. Final counters were
4,194,304 read bytes and 4,198,400 written bytes. The exact new scratch file was
removed and both failed/successful probe logs retained. At the final 14:28:06 UTC
check, all eight original services and the manager retained their original PIDs;
production and staging health were normal, Paper-only and queue depth zero.
The owner-stopped Bots were not resumed. The runtime delegation remains applied.

Accepted scope is scratch kernel limit configuration and measured throttling.
Actual main-worker/evaluator startup readback, persistent delegation across reboot,
all-device coverage, cumulative byte caps and the earlier monitor-completion gate
remain open. Empty counter data must still fail closed in the product. Next work
must exercise the real application gates under approved limits and repair the
driver's completion signaling before repeating supervised acceptance.
