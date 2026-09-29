# QD/QS frozen terminal readback and PF-2 S1 replay core — 2026-09-29

## Scope

Two local slices were accepted on branch `codex/app3a-market-wait-checkpoint`.
Neither slice is deployed, and neither grants public V2 admission, production
rollout or Live. The scope stays Spot/Paper only, BINANCE:BTCUSDT Spot 1m, with
the production ceiling of 10K bars including warm-up and independent holdout
gates unchanged.

- FTR-1, commit `292a4b3`: frozen terminal readback, so a diagnostic child can
  settle measured final I/O instead of the conservative unknown-final charge.
- PF-2 S1, commit `cda2857`: a development-only Python stateful replay core.

Both build on the earlier [PROFILE runtime checkpoint](QD_QS_PROFILE_BINDING_CHECKPOINT_2026-09-29.md)
and the [PF-2 contract checkpoint](PF_2_CONTRACT_CHECKPOINT_2026-09-29.md).

## FTR-1 frozen terminal readback

Before stopping an owned diagnostic child, the launcher freezes its unit with
`systemctl --user freeze`. It then requires a quiescence window W in which the
unit's memory `file_dirty` and `file_writeback` counters are both zero. It
re-checks the bound identity: unit, InvocationID, MainPID with start ticks,
cgroup inode and device. The frozen `io.stat` sample is committed as an
observation before the kill. After the child exits, the launcher accepts only a
REMOVED cgroup or a retained cgroup with equal counters.

The runtime settles the ledger and marks the launch `STOP_PROVEN` in one
transaction, still gated by `authorizeTerminal`. Any failed gate keeps the
existing unknown-final charge, which is unchanged. The runtime now requires the
ledger to share its database object.

PROFILE stays provisional with `evaluator_admission=false`. The job still ends
`CANCELLED` with a null SQL result; there is no `SUCCEEDED` or `SETTLED` job
wiring. The freeze and quiescence window add at least W (about 2.5 seconds) to
each PROFILE run. When the unit has 5 seconds or less of runtime left, the
launcher skips the freeze path and falls back to the unknown-final charge.

### Evidence

Linux mechanism proof, not a proof of the code: job `ftr1-proof-8f99f404` on
staging used two transient units on kernel 6.8 with systemd 255.

- Freeze took about 10 ms. Frozen counters stayed stable across a 2.5-second
  window, and identity stayed stable.
- The fsync unit recorded exactly 65,536 write bytes with dirty and writeback at
  zero.
- The buffered unit showed `file_dirty` of 65,536, so the fallback is the correct
  outcome there.
- The cgroup was removed right after stop. systemd `IOWriteBytes` and the
  journal are unavailable after exit, so the frozen sample is the only source.
- Cleanup and delayed health were unchanged. The 23 old failed transient units
  were left untouched by owner decision.
- Limits: one run per case, 64 KiB, and throttle backlog at freeze was not
  tested.

Local checks:

- I/O tests 48/48 and the full Node suite 466 pass, 1 pre-existing skip, 0 fail.
- Isolated PostgreSQL 16: `quant-io-runtime` 37/37 across three runs,
  `quant-profile-runtime-v2` 13/13, `quant-io-ledger` 10/10, and the related
  foundation regression suites with 0 failures.
- Independent tester review found the product logic correct. A test timing bug
  and the missing database-sharing guard were fixed afterwards.

### Open gates

- `terminate()` has not run on real Linux. The integration case is the next
  owner-approved operations step.
- All-device coverage, a positive physical read, cumulative caps and overshoot
  calibration, public V2 admission and the writeback tail after exit remain open.
- `io-terminal.js` is in the source-hash lists of `src/postgres/quant-data.js`
  and `src/quant-research.js`, so this commit rotates the ingestion and research
  engine hashes. Re-check hash-bound evidence before any deploy.

## PF-2 S1 Python stateful replay core

`quant_lab/src/robot_quant/pf2_replay.py` provides `evaluate_pf2_chunk`. It is
development-only and supports the V1 `paper-close-v1` execution model. V2 is
refused. It accepts a FRESH initial state only, and at most 10,000 bars including
warm-up. Only causal closed bars are used. A bar that closes exactly at the
holdout start is allowed because it covers the prior minute; any later close is
refused.

The core runs the continuous SPT evaluator with a PaperState and a canonical
checkpoint; restart equality is tested. Counters cover signals, intents,
accepted, `sizing_adjusted` and rejected orders, fills, and closed and losing
episodes. `sizing_adjusted` includes quantity-step rounding, so it is not a
budget-cap indicator. Guard pauses are derived from state. A daily-loss pause
can lift on the same day, and no ETA field is produced.

The checkpoint integrity hash is not authentication. The future driver must keep
checkpoints in trusted storage.

### Evidence

- 51/51 new tests, the full `quant_lab` suite with 182 passes, and Ruff clean.
- Node oracle parity on 9 scripted cases, 1 daily-loss lift case and 2 real-SPT
  cases. Episodes, streak and guard periods are derived from Node output only.
- Independent audit: ACCEPT after fixes.

This is not full Risk Manager or position parity. V2 cost-inclusive parity is
still required and must not reuse V1 parity as evidence.

### Remaining PF-2 work

- S3: trusted resolver, which needs the hash preimage schemas decided first.
- S4: Node driver and result envelope.
- Optional S2 CSV mode, engine-hash list integration, runtime admission, V2
  parity and the planned 50K maximum.

## Scope and status

Both slices are committed as `292a4b3` and `cda2857` on top of `8ce2c67` and are
pushed with this checkpoint. Commit, push, deployment and acceptance
are separate facts; nothing here is deployed. No production rollout and no Live.
The readiness retention cleanup is still pending real age expiry at 2026-09-30
13:53:52 Asia/Bangkok.

## Effort and usage

The root moved from Codex to Claude (Opus 5.5) at about 13:55 UTC on 2026-09-29.
The work above ran about 14:10 to 15:45 UTC with up to three concurrent children.
Account usage on the 5-hour window went from 4% to 27% used. Per-model cost and
exact engineering hours are not measured, and no speedup is claimed from agent
count.
