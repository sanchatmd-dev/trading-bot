# QL-2A — accepted actual-source baseline

Status: **engineering baseline accepted for the reviewed fixed profile**, 2026-09-26. All recorded QL-2A baseline gates pass, including 130 snapshot-bound repaint comparisons. QL-3A engineering may start for this profile. SPT remains DRAFT/capture-only and its runtime Quant capability remains UNSUPPORTED. This record does not authorize production deployment or customer optimization.

## Implemented scope

- A source-hash-bound Python candidate reproduces approved SPT Spot v4 Daily/Swing signals on standard BINANCE:BTCUSDT 1-minute bars. It carries EMA, ATR, Supertrend, setup expiry/zone memory and signal cooldown state continuously through warm-up.
- The narrow profile disables HTF, RSI, session, BOS and sweep filters, uses Zone + ATR source stops and has no selected dynamic slots. Effective lengths are EMA 50/200, ATR 14 and Supertrend factor 3.2; Bridge ATR/RR are 2.0/1.5. Other source hashes, markets, mappings and effective signal settings fail closed.
- Separate `bridge-exit-v2` replay retains hypothetical Pine entries even when Paper rejects BUY. Protection starts next closed bar; descending array order, SL before TP before native exit, and no BUY on an exit-intent bar match the Bridge. Missing targets reject without closing another allocation or opening a short.
- Serial Paper projection uses the complete frozen Node policy, funded Spot cash, adverse close-price fills, quantity steps, fees, entry cost basis, aggregate risk and daily limits. An empty Bot ledger starts at the measurement boundary while source/Bridge prefix state continues.
- An offline Node reference invokes production Bridge, risk and rounding functions. Python targeted EXIT cap/guard order and nonfinite volatility handling were aligned with Node. No broker, database, AI or activation operation runs in the reference.

The accepted evaluator covers only the reviewed fixed profile. It is not an arbitrary Pine interpreter or customer API capability. Synthetic EMA remains a demo. Research bounds and parameter search belong to QL-3A.

## Observed baseline

The current dedicated trace CSV has 5,185 closed bars; its final realtime row is excluded. Bar-open seconds become closed-bar UTC milliseconds. The first six rows provide a captured state checkpoint and its previous five candles. A further 1,000 warm-up bars (five times the largest effective lookback, 200) precede 4,179 measured bars. State is never reset at the measurement boundary.

| Measurement | Result |
| --- | --- |
| Compared bars | 4,179 |
| Native BUY / EXIT candidates | 47 / 65 |
| Native changed bars / timestamp shifts | 0 / 0 |
| Independent Binance Spot OHLCV unmatched / mismatched | 0 / 0 across all 5,185 bars, including checkpoint/warm-up |
| Frozen collector rows compared / mismatched | 2,842 / 0 |
| Python / Node measured decisions | 92 |
| Identity, reason, level, accept/reject, target, quantity, price and fee differences | 0 |
| Maximum per-fill cash / final cash difference | 0 / 0 |
| Fills / rejections / remaining allocations | 6 / 86 / 0 |
| Filled sizing outcomes | 3 CAPPED / 3 ACCEPTED |
| Final cash in this projection | 990.402124535600000000 USDT |
| Source state changed bars / shadow Supertrend mismatches | 0 / 0 |
| Maximum numeric state difference | 5.238689482212067e-10; roundoff budget 1e-7 |
| Recorded native observations / later-history comparisons / changed | 130 / 130 / 0; required minimum 100 |

There are 42 prefix intents without prefix Paper fills. Rejections: 43 `TARGET_NOT_OPEN`, 41 `Maximum daily loss reached`, 2 `Trading paused after loss streak`. Native EXIT candidates include flat-state signals; they are not 65 executed SELL fills. Loss guards remain unchanged during research. The earlier cold-start CSV baseline (4,524 measured bars, 65 BUY/79 EXIT) remains an exploratory check; the reviewed state trace is the current baseline.

Node receives independent Pine native flags and ATR from the state CSV, rather than Python-generated flags/ATR. Entry levels, reason/identity, sizing cap/rounding metadata and the cash ledger then compare against Python. Numeric state roundoff is reported separately; it does not relax the zero-tick Bridge or zero-step quantity requirements.

The recorded `paper-close-v1` model uses 10 bps fee, 1 bp adverse slippage, 1% requested risk, 0.01 price tick and 0.00001 quantity step, matching APP-3A's separate hosted canary. This is not an optimized recommendation.

[Sanitized evidence](evidence/QL_2A_BASELINE_2026-09-26.json) records source/artifact/snapshot, dataset and implementation hashes. Pine, raw market data, input snapshots and full replay remain private outside Git.

## Initialization and chart provenance verified

The owner pasted the complete private state trace; it compiled with zero errors. Codex reviewed all 58 source inputs plus the two evidence Bridge fields, disabled original notifications and confirmed standard BINANCE:BTCUSDT 1m. The private chart review, source/artifact/snapshot hashes and unambiguous state/native CSV block are bound in the report. Restoring the captured checkpoint retains source setup/cooldown state and yields zero state/flag changes during the subsequent replay. The complete original chart prefix is still unknown; the explicit captured state replaces a guess at initialization.

Private `ql2a-spt-v4-state-trace.pine` preserves source bytes and appends native trace/state plots. Its manifest distinguishes this evidence artifact from the executable Bridge. With original notifications off it sends only `bridge-native-trace-v1`, never executable Bridge orders. Shadow bands agree with the original Supertrend across the closed trace dataset. A separate alert named **QL-2A SPT Spot v4 native state CAPTURE ONLY 1m** is active and reuses the previously authorized v4 capture URL/session. Native and executable Bridge event types remain distinct. Existing alerts were not replaced. TradingView still displays its generic repaint warning because the retained source contains request.security/pivots; the warning is recorded and is not waived as evidence of repaint safety.

## Acceptance passed: snapshot-bound repaint

The read-only capture export records 130 native closed-bar observations from 06:43 through 08:52 UTC on 2026-09-26, with zero rejected deliveries and zero execution events. A later TradingView history export at 08:56 UTC compares all 130 observations with zero changes and zero missing rows. Source, deployment, snapshot, trace artifact and chart review hashes match. Capture and source/deployment remain unchanged DRAFT/capture-only. The minimum 100-observation repaint gate passes for this exact profile and observation window.

The evidence compares recorded closed-bar native BUY/EXIT flags and close prices against later history; it does not guarantee all future configurations are repaint-free. Earlier traces from different revisions/snapshots were not used to satisfy this gate. Historical REST validates final OHLCV, not earlier availability. The separate later repaint CSV retains the already frozen baseline dataset.

For a one-minute live trace, the count is closed bars rather than new trades. The existing baseline and these comparisons satisfy the recorded gates without another 2,000-bar wait. QL-3A may now define research bounds, validation splits and parameter search for this profile, initially the independent Bridge ATR/RR pair. The reviewed fixed profile implements 100% of its active signal dependencies with zero unsupported active constructs: EMA/ATR/Supertrend, zones, setup expiry, cooldown, confirmation and source minimum-risk filtering. Retained HTF/RSI/session/BOS/sweep branches are disabled. This evidence supports zero selected dynamic slots only; changing settings or adding dimensions requires corresponding evaluator/bounds evidence. Runtime capability registration and owner use remain gated by later phases.

## Private reproduction

Use the locked Python 3.12 environment and installed Node dependencies. From repository root:

```powershell
.\quant_lab\.venv\Scripts\python.exe -m robot_quant.ql2a `
  --bundle .qa-local/ql2a-source-private.json `
  --csv '<private TradingView CSV path>' `
  --market .qa-local/ql2a-checkpoint-market-private.json `
  --trace-artifact .qa-local/ql2a-spt-v4-state-trace.pine `
  --trace-manifest .qa-local/ql2a-spt-v4-state-trace.pine.manifest.json `
  --chart-review .qa-local/ql2a-trace-chart-review.json `
  --native-capture .qa-local/ql2a-native-private.json `
  --repaint-csv '<later private TradingView CSV path>' `
  --output .qa-local/ql2a-baseline-private.json
```

Use the matching checkpoint market file and the frozen baseline CSV for this trace dataset. The repaint CSV is the separate later chart export. The bundle contains approved source, executable artifact and frozen deployment snapshot. Independent market records include Spot identity, closed timestamps, retrieval cutoff and frozen hashes. Invalid identity/hash/data fails closed. The CLI returns `BASELINE_CANDIDATE`, `optimization_supported=false` and `candidate_acceptance_ready=true` with an empty blocker list. The CLI does not register runtime readiness or optimize; this document records the engineering acceptance decision.

Candidate audit and Ruff checks ran. No automated test suite was added or run. Node comparison is an offline serial ledger projection using production calculation functions, not PostgreSQL transaction/concurrency/recovery/authentication acceptance. APP-3A hosted evidence remains separate.

Pine state behavior follows TradingView's [execution model](https://www.tradingview.com/pine-script-docs/language/execution-model/); Supertrend recurrence follows [TradingView's reference](https://www.tradingview.com/support/solutions/43000634738-supertrend/).
