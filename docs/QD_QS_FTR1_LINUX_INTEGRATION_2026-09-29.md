# QD/QS FTR-1 Linux integration case — 2026-09-29

## Scope

One supervised Linux staging case ran the real FTR-1 `terminate()` path on the
actual PROFILE child. Its purpose was to test frozen terminal readback (see the
[FTR-1 and PF-2 S1 checkpoint](QD_QS_FTR1_PF2_S1_CHECKPOINT_2026-09-29.md))
end to end and, if every gate passed, to settle measured final I/O instead of the
conservative unknown-final charge.

The case ended in the safe fallback. The unit froze, but the first frozen read
failed the writeback gate, so the runtime kept the unknown-final charge.
Measured settlement on Linux is not proven, and the integration goal is not met.
The result changes no production behavior. The scope stays Spot/Paper only,
BINANCE:BTCUSDT Spot 1m, the 10K-bar ceiling including warm-up and independent
holdout gates. There is no Live and no public V2 admission.

This follows the [PROFILE runtime case](QD_QS_PROFILE_BINDING_CHECKPOINT_2026-09-29.md),
which used the same fixed worker and the same synthetic shape.

## Case and packet

The case suffix was `dda8f44a`. Code was at commit `3f191ef`. The packet
manifest SHA-256 was
`0a413178a644c237a98476addf7e3d43164a51c8b5a797f3b2e6c9e9f6c4d8b8`. The packet
held 37 files: 29 source files identical to their `3f191ef` blobs, 7 scripts
and the manifest itself. Relative to the prior PROFILE packet, only the five FTR-1
files differed.

An independent pre-run audit returned GO-WITH-FIXES. It found no blocking defect.
The three fixes were applied locally without changing the manifest.

The case used 600 synthetic Spot 1m bars: 500 warm-up bars and 100 derived bars.
It ran in an isolated new database and staging directory, with one launch and no
retry.

## Result

- Launch at 16:51:00 UTC. The terminal path ran from 16:51:09.985 to
  16:51:10.203 (218 ms). The driver was done at 16:51:10.291 and the monitor was
  done at 16:51:12.875.
- Outcome: FALLBACK-SAFE, with no flagged anomaly.
- The unit froze, but the first frozen read failed the writeback gate with
  `WRITEBACK_PENDING`: the memory `file_dirty` or `file_writeback` counter was
  nonzero. No frozen sample was committed.
- The runtime kept the existing unknown-final path. The proof was
  `UNKNOWN_FINAL_CHARGED` and the ledger was `CRASHED`. The charge was 2 MiB read
  and 2 MiB write, which is the allowance.
- The last observed counters were read 0 and write 36,864 bytes. These are not
  measured final counters.
- The launch was `STOP_PROVEN` and the job was `CANCELLED`. The SQL result and
  checkpoint are null and `evaluator_admission=false`. The `authorizeTerminal`
  sequence was `crash`, then `acknowledgeCrashStop`.
- The PROFILE result hash equals the hash recorded for the prior PROFILE case.
- No thaw was issued. The stop used SIGKILL.

The source of the dirty pages, metadata or file data, is unproven. The gate
throws before it records the value, so this case cannot tell the two apart.

## Safety and cleanup

- The prior PROFILE database and artifact hashes, the earlier diagnostic
  evidence, and the retention file and reservation were unchanged before, after
  and at the 10-minute recheck (17:01:34 UTC).
- The original eight service processes were unchanged with no restarts. Paper
  health was ok. Production and staging trading queues were both 0/0.
- The 23 old failed transient units were unchanged. No emergency stop was needed.
  No job or unit remains.
- Database p95 was 1.34 ms at baseline and 1.02 ms during the case. This small
  sample is not a capacity benchmark.
- The new database, case directory and artifacts are retained by owner decision.
  Raw logs are not reproduced here.

## Operational note

The Claude Code permission classifier blocked the agent from creating the new
database. The owner ran setup and launch personally. All other steps were
agent-run and read-only, apart from the packet upload.

## What this proves and what remains open

Proved in scope: the real `terminate()` path ran against the actual PROFILE child
on Linux. The freeze worked, the writeback gate rejected the first frozen read,
and the runtime fell back to the unknown-final charge with the expected
`STOP_PROVEN` / `CANCELLED` / `CRASHED` state and no result or checkpoint. The
fallback design behaved as intended.

Not proved:

- Measured final I/O settlement on real Linux. No frozen sample was committed, so
  the settle branch has not run there.
- Whether the dirty or writeback pages were metadata or file data.
- The positive physical read, all-device coverage, cumulative byte caps and
  overshoot calibration, the writeback tail after exit, public V2 admission and
  production rollout.

## Next action

1. Design and implement handling of pending writeback before the frozen read, and
   record the `memory.stat` dirty and writeback values on fallback. An auditor
   design is in progress. This is local engineering.
2. Run a new owner-approved Linux case with new names, after fresh health and
   usage checks.
3. Keep the remaining QD-1/QS-1 gates open, including trusted PROFILE enrollment.

The FTR-1 commit rotated the ingestion and research engine source hashes. Re-check
hash-bound evidence before any deploy.

## Scope and status

This record is a documentation checkpoint. Nothing was deployed or changed in
production by this case. Commit, push, deployment and acceptance are separate
facts, and FTR-1 remains a local slice with a fallback-only Linux result. The
readiness retention cleanup is still pending real age expiry at 2026-09-30
13:53:52 Asia/Bangkok.

## Effort and usage

Preflight began at about 16:29 UTC and the last recheck ran at 17:01 UTC. The
5-hour usage window went from 39% to 44% used across preparation, audit and run.
Shared usage counters do not attribute cost to a model, an agent or a step. No
engineering hours are booked and no speedup is claimed.
