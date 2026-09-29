# PF-2 S3 trusted resolver checkpoint — 2026-09-30

## Scope

PF-2 S3 is a local, development-only code slice, pushed as commit `5006feb`
(`feat(quant): add development-only PF-2 trusted resolver`) on branch
`codex/app3a-market-wait-checkpoint`. It follows the
[S1 stateful replay core](QD_QS_FTR1_PF2_S1_CHECKPOINT_2026-09-29.md) (`cda2857`) and
the [PF-2 contract](PF_2_CONTRACT_CHECKPOINT_2026-09-29.md). New files:
`src/quant-research/preflight-resolver.js`, `test/preflight-resolver.test.js` and
`test/helpers/pf2-fixture.js`.

Nothing is deployed. The resolver is not wired to any runtime or engine-hash list.
All nine CI checks passed for the pushed commit. Scope stays Spot/Paper only, BINANCE:BTCUSDT Spot 1m,
the 10K-bar ceiling including warm-up, independent holdout gates, no production
rollout and no Live.

## What the slice does

The resolver takes a Historical Preflight request and resolves it against trusted
sources into an immutable, hash-bound input for the S1 replay core. Two root
rulings shape it: a FRESH initial state requires `loss_streak` 0, and trusted
sources receive a resolver-owned abort signal rather than the caller signal.
Detailed behavior is in the source and tests, not repeated here.

## Evidence

Local evidence only.

- 47 resolver tests pass, including a check against the S1 Python request
  validator. That check skips when the quant Python runtime is unavailable.
- The root reran `npm test` at about 21:15 UTC: 539 tests, 538 pass, 1 pre-existing
  skip, 0 fail.
- An independent tester accepted every round.
- An independent auditor (Opus 5.5 xhigh) found four blocking-medium defects across
  rounds, all fixed:
  - F1: errors thrown by a hostile trusted source could pass through.
  - F9: the outer catch re-read the caller signal.
  - F11: the scope-end abort was unguarded.
  - F16: a regression from the F13 fix let a source fake a configuration error
    code.
- The auditor also found several low items (abort race, zero-streak rule, test
  marker, shared signal, thenable pinning), all fixed. The fourth re-check accepted
  the result.

## Not proved

- The slice is development-only and not wired to any runtime or engine-hash list.
- Production adapters are not written: authorization, records, enrollment lookup,
  provenance and the holdout registry.
- The test source is synthetic because the real SPT source is private, so the
  Python evaluator is not exercised end to end.
- Integrity hashes are not authentication. Executable identity covers local files
  only. Binding uses the enrolled deployment snapshot.
- Full Risk Manager or position parity, V2 evaluator parity and runtime admission
  remain open.

## FTR-1c design decision (proposed, awaiting owner approval)

FTR-1c is not implemented. It answers the blocked FTR-1b-INT case: the host ext4
journal commit interval is 30 s, above that case's 5 s design gate. A three-agent
design panel produced two designs and a judge ruled between them.

Chosen design A: after the freeze, the parent fsyncs the StorageBudget root
directory once as a journal commit barrier, then drains with a bound computed from
host writeback settings and reads `memory.stat` before `io.stat`. The computed bound
is 45,000 ms on this host, equal to the code maximum, so there is zero margin. No
ledger, digest or SQL change.

The judge estimated, without measurement, 80-90% pass odds per Linux run and about
+20 s typical, up to +45 s, per drained PROFILE run. A passive drain without the
barrier would need caps of at least 75 s drain and 85 s timeout. Design B, a
surcharge, stays a contingency and would change the ledger and digest.

Owner approval is needed for the barrier, the time cost, and the local slice plus a
new Linux packet. If approved, the prepared FTR-1b-INT packet (suffix `669fbd47`)
would be retired unrun. Linux behavior remains unproven.

## Next action

1. S4 Node driver and result envelope: done as `9a340af`; see the
   [S4 record](PF2_S4_REPLAY_DRIVER_CHECKPOINT_2026-09-30.md).
2. Owner decision on FTR-1c.
3. Production adapters, runtime admission and engine-hash integration, then PF-3
   and PF-4. V2 historical admission stays denied until full evaluator parity.

The readiness retention cleanup still waits for real age expiry at 2026-09-30
13:53:52 Asia/Bangkok.

## Effort and usage

The owner-approved temporary elevated tier runs from 2026-09-29 17:40 UTC to
2026-09-30 03:40 UTC (coder Sonnet 5.5 xhigh, tester Sonnet 5.5 high, auditor Opus
5.5 xhigh). Measured wall-clock and shared 5-hour usage, all models:

- Wave B, 19:03-20:02 UTC: 9% to 27% used (S3 build, first fix round and the
  FTR-1c design panel).
- Wave C, about 20:07-20:59 UTC: 27% to 40% (S3 fix rounds, S4 contract draft and
  review).
- Wave D1, about 21:02-21:17 UTC: 40% to 42% (final S3 fix and re-check).

Shared counters do not attribute cost to an agent or step. No engineering hours
are booked and no speedup is claimed.

## Scope and status

Commit and acceptance are separate facts: `5006feb` is pushed, was accepted by the
independent tester and auditor, and passed all nine CI checks. Nothing is deployed.
