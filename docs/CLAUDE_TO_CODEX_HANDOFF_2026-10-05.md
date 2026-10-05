# Claude to Codex — project handoff, 2026-10-05

## Read order and authority

At about 04:00 UTC (11:00 Bangkok) on 2026-10-05 the owner asked Claude to hand
the whole project and the latest work to Codex. Claude root stops. Codex becomes
the sole root. The previous handoff was Codex to Claude at `1fab165` on
2026-10-03 ([Codex to Claude](CODEX_TO_CLAUDE_HANDOFF_2026-10-03.md)); the
[earlier Claude to Codex handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-03.md) and the
[delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md) stay valid as history.

Read in this order. CLAUDE.md is Claude-only; Codex reads AGENTS.md and the
Caveman skill. Then read the private handoff in the ignored local directory
(`.qa-local/claude-to-codex-handoff-2026-10-05.md`) first, then this file, README,
Context, the top sections of the Roadmap, Time Management, and the newest entries
of `.qa-local/claude-root-current.md`. Host facts, release-tool namespaces and pins,
and identifiers live only in the private notes. This summary is not a live-state
certificate: re-verify Git, file ownership, usage and authorized runtime before any
dispatch.

Codex uses its own model column in AGENTS.md. Claude children are frozen and must
not be resumed. Fable roles are Claude-only. No Claude workflow, agent or cron runs.

Existing authority is unchanged: Spot/Paper only, no Live, no production change, no
automatic apply, no guard reset, no automatic optimizer or data-range loop. Closed
GOs are never replayed.

## Git baseline

Branch `codex/app3a-market-wait-checkpoint`; HEAD equals upstream. Claude added 18
commits after `1fab165` (`1005961` to `f4ce608`) plus the commit that carries this
handoff.

CI: `2919f9b`, `40253be` and `277b07b` passed 9/9 including PostgreSQL; `56bbedc`
quant jobs were green on Windows and Ubuntu; docs-only commits passed the gate and
scope checks. `0f110ff` failed one Windows test on a test-only line-ending
assertion, fixed in `2919f9b`.

Three owner files stay untracked and must never be staged:
`docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png` and
`scripts/build-spt-exit-diagnostic.mjs`.

## Staging state

The API runs `2919f9b`. The next API layer must sort after `s04` (use `s05`); the
rollback target would be `f22f3d0`. The trading worker (last verified on `f2bd332`)
and the research worker (`3309d07`, foundation idle, admission closed) were not
changed by these API-only releases. The keyless market proxy is on by default
(`MARKET_PUBLIC_PROXY=0` disables it), with no API key and no trading path.

Last runtime facts. At the 19:06 UTC delayed check on 2026-10-04: events, pending
and signals 65; entries 5; allocations 5; deployment READY; bot ACTIVE; research
jobs 0. Read-only API check on 2026-10-05, 03:35 to 03:50 UTC: QL-P2 deployment
`b45d9f9d` READY; one open allocation from BUY 126 (0.01166 BTC at 85,440.56,
16:50 UTC on 2026-10-04) with no EXIT yet; the old QL-3A allocation of 0.01181 BTC
stays OPEN and the QL-3A alert stays stopped until it is resolved without a forced
close.

## Releases by Claude

All four were API-only. Each used a release tool adapted from the previous accepted
tool by exact substitutions, an independent three-lens audit (ACCEPT_NARROW), root
acceptance, and one pre-armed operations session per step with separate root
approvals.

| Release | Commit | Live (UTC) | Evidence |
| --- | --- | --- | --- |
| Create Bot UI | `256251b` | 2026-10-03 18:56 | [evidence](evidence/P2_UI_RELEASE_256251B_2026-10-03.json) |
| Quant History | `02af486` | 2026-10-04 09:06 | [evidence](evidence/P2_HISTORY_RELEASE_02AF486_2026-10-04.json) |
| Chart v2 | `f22f3d0` | 2026-10-04 15:41 | [evidence](evidence/P2_CHART_RELEASE_F22F3D0_2026-10-04.json) |
| Chart v3 indicators | `2919f9b` | 2026-10-04 18:55:29 (ACTIVATE_PASS); delayed POSTCHECK_PASS 19:06:03 | [evidence](evidence/P2_CHART_INDICATORS_RELEASE_2919F9B_2026-10-04.json) |

Details are in the [P2 checkpoint](STAGING_P2_CHECKPOINT_2026-10-03.md#chart-v3-indicators-release-2919f9b-upload-extraction-and-activation)
and its earlier release sections.

## Chart and market data

Chart v2 is live: any allow-listed Binance Spot symbol, intervals 1m to 1w (default
1d), per-lot entry, stop and target lines. Chart v3 indicators are live: EMA 50/200
and ATR stop 2x14 on by default; RSI 14 and MACD 12/26/9 off; all toggleable and
visual aids only. The 1-minute TradingView comparison on 2026-10-05 matched EMA 50,
RSI 14, MACD and ATR 14 to four decimals; EMA 200 differed only by warm-up. The
daily comparison was not run. Phone width and the Thai view were checked locally
only. BTCUSDT 1h uses labelled Binance REST data because stored coverage is shorter
than the larger warm-up window. Owner scope remains real Binance Global data only
for OHLCV and Preflight, keyless public endpoints, no trading.

## The six steps

1. AI Bridge: unchanged from the 2026-10-03 handoff.
2. Ten inputs: not accepted. Local evidence S1 (`40253be`), S2 (`277b07b`), S3
   (`56bbedc`) and the live check S5 (`b45d9f9d` bindings equal the owner lock
   `9db0f772`). Open: S4 (deployment versus research selection coherence, a
   design decision); S6 (slot 10 `confirmLookback` changes signals only on gap
   bars; the owner chooses `minRiskATR` with a new lock and TradingView axis
   parity, or a documented exception); S7 (RR and multiplier replay on collected
   data; the owner confirms it is not a campaign).
3. Preflight: PF-3 and PF-4 live on staging, PF-2 off, D6 and R7 prerequisites
   unchanged.
4. TradingView signals with Paper: a natural same-entry EXIT is proved (BUY 66 to
   EXIT 85) plus later same-entry round trips. QL-P2 BUY rejections are explained
   as cash-capped sizing (1% equity risk, Paper cash about 1,000 USDT), not a
   defect.
5. Bounded optimization: `NO_VALID_CANDIDATE`, holdout unopened, no new campaign.
6. Research Library: live, no qualified winner.

## Owner decisions open

- Slot 10 (S6), S4 and S7 for Step 2.
- QL-P2 sizing or rejection label.
- The authenticated Create Bot journey (needs a form submit).
- Resolving the old QL-3A OPEN allocation without a forced close.
- An optional daily TradingView comparison.
- MD-1, pre-launch (MD-1e needs owner and legal review).

## Backlog

Unchanged: MD-1 estimate after proxy measurement (no proxy statistics endpoint
exists yet), B3, W7, D6, R7, Linux inventory and native closure, QD-1, QS-1, PF-2
historical runtime. See the [Roadmap](ROADMAP.md).

## Practical notes

- Staging UI is reachable only through the owner own port forwarding in Chrome,
  and it drops often. Never open tunnels.
- TradingView Desktop with remote debugging did not work for the owner; TradingView
  web in Chrome was used. Restore the owner layout after any temporary study.
- Host work only through one designated operations worker, serial, with a job ID,
  budget and stop plan.
- Release-tool private namespaces and pins are in the private handoff. GOs are
  closed and must never be replayed.

## Usage

Claude at about 03:53 UTC on 2026-10-05: 5-hour window 2%, weekly all-models 17%,
Fable 9%. Codex usage is separate and unknown to Claude; Codex reads its own before
dispatch and applies the AGENTS.md bands.
