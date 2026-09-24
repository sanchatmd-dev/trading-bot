# SPT Spot compatibility audit — APP-3A

Status: reviewed source and isolated capture only; **whole indicator is not yet Spot-clean or execution-ready**. Baseline is the owner-supplied Pine v6 indicator with SHA-256 `2f353c49721c8daf24e366409eaf6eac49f945da955a0df8bd52862f2e7e3277`. The similarly named legacy file under `tradingview/` has a different hash and is **not** this audit's baseline. Do not replace the source of the active TradingView capture alert during parity collection.

## Findings

| Area | Source evidence | Spot assessment |
| --- | --- | --- |
| Market data | `request.security(syminfo.tickerid, ...)` at lines 715–743; no hard-coded futures ticker or external contract feed in the signal path. | The signals use the chart's instrument. The observed alert chart is BINANCE:BTCUSDT Spot 1m. A ticker-only runtime guard could accept a different venue with the same ticker; new `bridge-exit-v2` artifacts require exact `BINANCE:BTCUSDT` ticker ID for `binance-global`. Existing v1 alerts retain their frozen weaker guard and remain capture-only. |
| BUY signal | `allowLong`, confirmed long setup and long-risk preview feed `rawBuySignal`/`buySignal` at lines 839–1003. | Valid as a candidate funded Spot BUY on the verified Spot chart. SPT's preview SL/RR and optional simulated position are separate from Bridge ATR multiplier 2.0 / RR 1.5 and Bot Risk Manager allocation. |
| Opposite signal | `allowShort`, bearish setup, short SL preview and `validShortRisk` feed `sellSignal` at lines 845–1003. | This is a **short-entry condition**, not an inventory-aware Spot sell. Owner-approved Bridge mapping uses it only as an EXIT intent for existing longs. Keep source direction `Both Long & Short`; `Long only` disables this exit signal. A bearish move can occur without `sellSignal`, and an unheld sellSignal has no Spot order. |
| Signal memory | `newShortSetup` clears `longSetupActive` at lines 859–864. The short visual branch updates `tradeStartBar` at lines 1358–1367; `cooldownOK` reads that variable at lines 970–975. | Short-oriented state can change later BUY eligibility even though the Bridge never opens a short. Removing or disabling short branches is therefore a signal change and requires a separate approved source revision plus fresh parity evidence. |
| Simulated dashboard | `btOpenShort` sets `btPos=-1` at lines 1123–1155; short SL/TP, reverse and win-rate paths run at lines 1053–1175. The source has no explicit fee/slippage/funding model here. | The default mixed long/short dashboard is **not Spot Bot or Quant Lab performance**. Its R and win-rate metrics must not enter Quant optimization or the Email Report. A Spot adaptation must remove/relabel these calculations or provide a separately defined long-only simulation with Spot costs. |
| Visual trade | `sellSignal` creates `Short active`, downward TP levels and short SL at lines 1358–1415. Later TP/SL checks branch on direction at lines 1426–1515. | Chart labels and short TP/SL are misleading for Spot execution. A reviewed Spot revision should show `EXIT long` only when a long is represented, without creating a synthetic short visual position. Since this branch affects cooldown, the revision needs measured BUY/EXIT deltas. |
| Native notifications | `f_eventSide("SELL")` returns `SHORT` at lines 1548–1560; `f_sendNotify` calls `alert()` when `notifyEnabled` at lines 1707–1727. | Keep `Enable notifications=false` in every Bridge/trace alert snapshot. Native `Any alert()` payloads are not Bridge v1 messages. The existing staging configuration has this input off; any change needs a new isolation check. |
| Leverage/contract economics | No executable leverage, margin, liquidation, funding, contract quantity or borrowing logic was found in the submitted source's signal/notification path. | No direct Futures execution call was found. This absence does not make the short simulation Spot compatible or establish Quant evaluator support. |

## Decision and next revision

The current APP-3A artifact may continue **capture-only evidence collection** on the verified Spot chart. The Bridge restricts execution semantics to funded long BUY and targeted reduce-only EXIT; actual Spot fills, quantities and costs remain server-owned. Do **not** mark the whole SPT indicator Spot-adapted, Webhook ready or Quant supported from this source audit.

For a Spot-clean indicator revision, preserve the bearish detection calculation as an explicit exit candidate; replace short-entry wording, visual position and dashboard paths with long-only Spot semantics; define whether a bearish signal while flat still starts cooldown; and freeze Bot/Quant cost and position rules separately from SPT preview metrics. Show the complete line-level source diff and expected behavior changes to the owner before registering that new immutable source hash. Compile and compare its signals against its own frozen baseline; do not transfer parity evidence from the unchanged source automatically.

The exact Binance Spot ticker-ID check was added to future `bridge-exit-v2` generation. This changes the generated artifact version, not the frozen existing TradingView capture alert or its source hash. Other brokers need verified chart-ID mappings before claiming the same venue guard.

## Spot review draft (not registered)

`scripts/build-spt-spot-review.mjs` creates a private, reproducible draft from the exact owner baseline hash above. The current draft is `.qa-local/spt-spot-review-v3.pine`, SHA-256 `c743df4b5c1b8b14ad51317632df1cf3fd06d18346d7143f440dab92b4c6b799`. It has **not** replaced the active source, Bridge alert or Backend registration.

| Change | Expected signal effect |
| --- | --- |
| Rename default `Both Long & Short` to `Long + Exit`, retaining both allow flags and the original bearish setup/risk calculations. | Default BUY and bearish exit conditions remain enabled. |
| Replace simulated short opens, short SL/TP and short win-rate dashboard with an indicative long-only simulation. | No direct effect on the signal formulas. These new indicative metrics are not Quant or Bot results. |
| Replace the synthetic short visual position with an EXIT candidate. Preserve `tradeStartBar := bar_index` and setup clearing on `sellSignal`. | Preserve the original cooldown effect on later BUY bars. A bearish signal while flat remains an exit candidate; Bot must ignore it without a held long. |
| Rename the SELL alert side/labels to `EXIT_LONG` and remove short visual TP/SL branches. | No short execution intent is emitted by this draft's native notifications. |

Static source comparison: the 41-line block from `FINAL BUY / SELL SIGNALS` to `BACKTEST ENGINE INSIDE INDICATOR` is byte-identical after the intended `allowShort` → `allowExitSignal` rename. The only assignments to `tradeStartBar` remain the BUY and bearish signal branches. This establishes source-level preservation of those formulas, **not measured TradingView signal parity**. Compile the draft on the verified Binance Spot chart and compare closed-bar BUY/EXIT traces with the frozen baseline before registering or replacing any alert. Keep native `Enable notifications=false` in the review chart/alerts; the Bridge is the execution payload source.

### TradingView comparison, 2026-09-25

The owner placed the full 2,353-line draft in TradingView. It compiled and ran on `BINANCE:BTCUSDT` 1m; the private saved script is `SPT PRO Spot review APP-3A DRAFT`. Existing capture alerts were not changed. TradingView's chart-data CSV export contained the Spot draft, original indicator, and original native-trace indicator on the same chart with the displayed default signal inputs. The open final candle was excluded.

| Closed UTC bar window | Bars | Original BUY / Spot BUY | Original SELL / Spot EXIT candidate | Flag mismatches |
| --- | ---: | ---: | ---: | ---: |
| 2026-09-21 22:37–2026-09-24 18:11, 1m, no gaps | 4,055 | 56 / 56 | 0 / 0 | BUY 0, EXIT 0 |

The expanded export has SHA-256 `c49340c1f3db323e5fb5ae4e33a5ace5359c419c9c7c03299dac4dd11c1381af` and supersedes the 749-bar export. The native-trace BUY/EXIT plots and the second original indicator also matched these 4,055 closed bars. This supports BUY parity for this window. Because there was **no positive bearish exit signal**, it does not establish observed EXIT parity or the full APP-3A parity gate. The Spot draft remains review-only. Quant and Bot performance must still be measured separately from SPT's indicative dashboard.

### TradingView effective inputs and warning, 2026-09-25

The owner-private Spot draft on `BINANCE:BTCUSDT` 1m initially inherited the source default `Enable notifications=true`, unlike the active Bridge snapshot. Its chart input was changed to **false** and saved; the resulting 60 TradingView UI controls were compared in order with the active Bridge indicator's 62 controls. Every shared value matched except the intentional mode label/value mapping `Both Long & Short` → `Long + Exit`. The other two controls in the active Bridge are its independent `ATR Multiplier for SL=2.0` and `RR=1.5`; this review-only Spot source has no Bridge block yet. The 58 source input declarations themselves are retained in the draft. This comparison describes the **current chart instance**; loading the saved Pine on a new chart still requires setting `Enable notifications=false` because the source default remains true.

TradingView's alert composer for the Spot draft showed: “Caution! This alert may function differently than expected. This is due to calculations being based on an indicator or strategy that can get repainted.” The composer defaulted to `Any alert() function call` on the 1-minute chart. It was canceled without creating an alert. The warning is unresolved until point-in-time closed-bar signal observations are compared with later historical recomputation under the same effective input snapshot; the 4,055-bar historical CSV comparison alone does not establish repaint stability. An `Any alert()` draft with `Enable notifications=false` would also emit no native SPT alert payload by design.
