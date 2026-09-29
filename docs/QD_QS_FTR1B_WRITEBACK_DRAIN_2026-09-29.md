# QD/QS FTR-1b writeback drain — 2026-09-29

## Scope

FTR-1b is a local code slice, pushed as commit `54a9fde`. It answers the fallback
of the [FTR-1 Linux integration case](QD_QS_FTR1_LINUX_INTEGRATION_2026-09-29.md)
(`dda8f44a`), where the first frozen read failed the writeback gate with
`WRITEBACK_PENDING` and the runtime kept the unknown-final charge.

The slice changes no product behavior: the drain is off by default and no product
code enables it. Only a staging driver will. Nothing is deployed. Scope stays
Spot/Paper only, BINANCE:BTCUSDT Spot 1m, the 10K-bar ceiling including warm-up,
independent holdout gates, no Live and no public V2 admission.

## Cause addressed

The integration case saw a nonzero `file_dirty` or `file_writeback` counter at the
first frozen read. The design review ranked child-owned dirty ext4 metadata, from
directories the PROFILE child creates, as the most likely source. This is kernel
knowledge and is not yet proven on the host. The earlier gate threw before it
recorded the values, so the case could not distinguish metadata from file data.

## What the commit does

- With `terminalDrainMs` set, the launcher keeps the unit frozen and polls
  `memory.stat` every 500 ms until `file_dirty` and `file_writeback` are both zero
  and at least 7.5 s have passed since the freeze was confirmed. The drain is
  bounded by the overall deadline, with a maximum drain of 45 s.
- The final stable read must be at least 2.5 s after the freeze.
- `stop()` aborts the drain and the quiescence wait promptly.
- Fallback results now carry an integer-only diagnostic: stage, dirty and
  writeback values, read counts and a series of at most 32 points. The diagnostic
  stays out of the digest, the ledger and SQL.
- The launcher rejects configurations whose timeout cannot hold the drain. The
  `timeoutMs` cap is 60 s.

## Compatibility

The drain is off by default. With it off, behavior at the current rate (window
2,500 ms) matches the previous commit and the readback digest is unchanged. At
fast rates (window 250 ms) the new freshness floor is intentionally stricter.

## Evidence

Local evidence only. All tests use a fake host and clock.

- An independent tester ran real isolated PostgreSQL suites: quant-io-runtime
  37/37, quant-profile-runtime-v2 13/13 and quant-io-ledger 10/10. Focused tests
  passed 73/73 and the full Node suite passed with 491 passes, one pre-existing
  skip and no failures. The previous commit's launcher and terminal tests, run
  unchanged against the new code, passed 31/31.
- An independent xhigh audit first found one blocking-medium defect: `stop()`
  during quiescence could wait up to 35 s with the drain on. A separate verifier
  confirmed it. After the fix the probe stopped in about 2 s and the re-check
  accepted all fixes. Remaining audit notes are informational, for example the
  pre-existing systemd thaw on stop and memory-stat flush timing.

## Not proved

- Linux behavior of the drain. The dirty-page source and whether a drain of 7.5 s
  up to 45 s clears it on the host are open.
- Measured final I/O settlement on real Linux, the positive physical read,
  all-device coverage, cumulative byte caps and overshoot calibration, the
  post-exit writeback tail, public V2 admission and production rollout.

## Next action

1. An owner-approved Linux case with new names (FTR-1b-INT). The owner runs setup
   and launch, because the agent permission classifier blocks those steps. A
   read-only host check on 2026-09-29 at 18:34 UTC found the staging filesystem is
   ext4 with a 30 s journal commit interval (data=ordered, dirty expiry 30 s,
   writeback wake-up 5 s). The case design requires a commit interval of at most
   5 s for its 7.5 s drain floor, so the prepared case is blocked until that
   design question is resolved. Changing the mount options would be a production
   configuration change and is not authorized.
2. Product wiring through a hashed policy, a scheduler review of a STOPPING slot
   held for about 50 s, and a PostgreSQL regression for the fallback diagnostic.
3. The remaining fault matrix and trusted PROFILE enrollment.

The FTR-1 commit rotated the ingestion and research engine source hashes; re-check
hash-bound evidence before any deploy.

## Effort and usage

The owner approved a temporary elevated agent tier from 2026-09-29 17:40 UTC to
2026-09-30 03:40 UTC (coder Sonnet 5.5 xhigh, tester Sonnet 5.5 high, auditor
Opus 5.5 xhigh, verifier Opus 5.5 high), dispatched through workflows with
explicit model and effort. The coder ran 17:34-17:50 UTC, first verification
17:54-18:06 UTC and the fix round 18:08-18:22 UTC. The 5-hour usage window went
from 48% to 59% used over this work; shared counters do not attribute cost to a
model, an agent or a step. No engineering hours are booked and no speedup is
claimed.

## Scope and status

Commit and acceptance are separate facts: the code commit `54a9fde` is pushed, and
this record is pushed with this checkpoint. Nothing is deployed and FTR-1b has no
Linux evidence. The readiness retention cleanup is still pending real age expiry
at 2026-09-30 13:53:52 Asia/Bangkok.
