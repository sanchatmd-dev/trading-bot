# QL-3A historical research and Paper continuation

The owner requested the shortest path forward while preserving standards.
Verified historical Spot candles supplied the research dataset without waiting
for 2,000 newly collected live candles. Natural Paper execution remains a
separate observation stream. The bounded research job completed successfully as
a **negative research result**, `NO_VALID_CANDIDATE`; QL-3A recommendation
acceptance and QL-4B remain gated.

## Paper diagnosis

The [read-only diagnostic](evidence/QL_3A_PAPER_CONTINUATION_DIAGNOSTIC_2026-09-27.json)
found 0.2503601892 USDT cash and 997.3640240564 USDT position cost. The latest
rejected BUY could afford only 0.000002957834161724 BTC, below the verified venue
step of 0.00001 BTC. Rounding correctly produced zero. One step including fees
would cost 0.8464307852 USDT at that signal price. This is an expected cash/lot
constraint, not evidence of a broken queue or an undersized venue step.

The one open allocation had SL 83,626.98 and TP 85,454.52. Across the 418 stored
bars after its entry, the low was 84,281.84 and the high 84,654.02; neither level
was touched. No native EXIT webhook had arrived after this entry. Earlier
`TARGET_NOT_OPEN` events did not target this live allocation. No forced close,
funding change, risk reset, new account or policy change was made. Future missing
webhooks are not ruled out by this scoped diagnostic.

## Frozen research data

Before candidate performance evaluation, a time-based rule selected the largest
supported 10,000-bar window ending at **2026-09-27 07:30 UTC**. It contains 3,250
warm-up bars, 4,050 train bars, 1,350 validation bars and 1,350 holdout bars.
The measured warm-up exceeds the service's lower engineering minimum and follows
the accepted Custom axis convergence result.

The [backfill evidence](evidence/QL_3A_HISTORY_BACKFILL_2026-09-27.json) records
5,673 added historical bars and 4,327 preserved existing bars. Independent
Binance Spot REST OHLCV and tick/quantity metadata matched every overlapping bar.
The largest independently calculated ATR overlap difference was 5.8e-17,
below 1e-7. Existing frozen rows and hashes were retained. All 10,000 closed
bars are contiguous and hash-verified. The dedicated staging data operation
added no natural trades and did not restart the live collector or Paper worker.

This is an explicitly independent historical flat Paper simulation with the
existing configured capital and locked policy. Historical simulated fills are
never counted as natural TradingView-to-Paper executions. Live daily and loss
streak counters were neither consumed nor reset.

## One bounded job and result

Authenticated staging API submission created run
`10d7ccc1-7ab5-4bff-8f95-d32f0bcd95a8`. The original approved input lock,
eight source slots, Bridge ATR/RR domains, seed 20260927 and budget 100 were
preserved. Idempotency key `ql3a-custom-history-20260927-v1` prevents duplicate
submission. The deployed worker completed 100 candidates on its first attempt
in **102.787 seconds**, covering all ten selected dimensions.

Every candidate failed `INSUFFICIENT_VALIDATION_TRADES`. Train closed-trade
counts ranged from seven to sixteen; all validation counts were zero. No
candidate was selected. Sensitivity, cost stress and holdout evaluation were
correctly skipped because train/validation screening failed. No second search,
Best Inputs export or owner recommendation followed. See the
[persisted result](evidence/QL_3A_HISTORY_RESEARCH_RESULT_2026-09-27.json).

The baseline had nine closed train trades, all native exits, and train return
-0.87642227794%. A diagnostic reproduction matched its persisted result exactly
while excluding holdout candles. Its validation period contained **18 BUY
intents rejected by the loss-streak guard** and 18 unmatched EXIT intents.
Thus the baseline's zero validation trades are explained by the preserved risk
state, despite the presence of signals. The
[baseline diagnostic](evidence/QL_3A_BASELINE_VALIDATION_DIAGNOSTIC_2026-09-27.json)
does not assert that every candidate has identical rejection timing.

## Remaining work

The Custom 100-observation repaint gate and individual input-axis parity have
their own passing evidence. The historical research dataset and durable search
are now complete for this run; waiting for a fixed number of additional live
bars is not a remedy for its negative result. The
[SPT signal and loss-sequence review](QL_3A_SPT_SIGNAL_REVIEW_2026-09-27.md)
now reproduces the baseline exactly: nine allocations form three losing
position episodes, correctly triggering the loss-streak guard. Native EXIT
still depends on bearish entry-style setup conditions. Preserve this negative
result and agree on a precise source or operating-policy revision before
implementation. Any new research run must
have an explicitly declared dataset and validation plan; do not repeatedly
search or reset a guard until a favorable result appears.

QL-3A is still not accepted for recommendations. Exact-input candidate parity,
out-of-sample, sensitivity, cost-stress and customer capability gates remain
unfulfilled because no candidate qualified. Natural Paper collection may
continue on the existing account and active Alert under the unchanged policy.
