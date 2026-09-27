# QL-3A — SPT signal and loss-sequence review

Date: 2026-09-27. Status: **review complete; source revision and next experiment not approved by this record**.

Subsequent owner-authorized work is recorded in the
[Spot EXIT v1 development follow-up](QL_3A_SPOT_EXIT_V1_2026-09-27.md).
It preserves this review and its negative baseline; no runtime source activation
or new optimization follows the development result.

## Scope and method

This review explains the existing baseline of historical research run
`10d7ccc1-7ab5-4bff-8f95-d32f0bcd95a8`. Replaying its persisted request reproduced
the stored baseline result exactly. The diagnostic received warm-up, train and
validation bars only; holdout bars were excluded. It observed the existing
evaluator without changing signal decisions and paired fills by entry reference.
No new parameter search, source change, policy change or deployment occurred.

The [machine-readable review](evidence/QL_3A_SPT_LOSS_REVIEW_2026-09-27.json)
records source/contract hashes, each allocation, signal gates and cost attribution.
The private source and full per-bar trace remain outside version control.
These are historical simulated fills, not natural TradingView-to-Paper trades.

## Loss sequence

The reported **nine closed trades are nine allocations across three flat-to-flat
position episodes**, with five, three and one allocations respectively. Every
allocation closed through a native EXIT; none closed through Bridge SL or TP.
All three episodes lost money after execution costs.

All timestamps below are UTC. Amounts are USDT, rounded to six decimal places.

| Episode | First entry | Final exit | Minutes | Allocations | Raw price PnL | Fees | Slippage + tick rounding | Net PnL |
| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 1 | Sep 22 15:13 | Sep 22 20:07 | 294 | 5 | -2.626129 | 1.995090 | 0.199573 | -4.820792 |
| 2 | Sep 23 00:31 | Sep 23 06:08 | 337 | 3 | +0.383635 | 1.987774 | 0.198930 | -1.803069 |
| 3 | Sep 23 20:00 | Sep 23 21:03 | 63 | 1 | -1.305000 | 0.759357 | 0.076005 | -2.140362 |
| Total | | | | 9 | -3.547494 | 4.742220 | 0.474508 | -8.764223 |

Raw price PnL uses bar-close prices before adverse execution adjustments.
Net PnL includes both entry and exit fees. Its exact total is
**-8.7642227794 USDT**, matching the persisted train equity change.
Price movement was negative overall; costs added another 5.2167287794 USDT.
Episode 2 had a small positive raw price result but a negative net result.
Two allocations had positive raw price PnL; no allocation had positive net PnL.

The replay increments the loss streak when aggregate quantity returns to zero,
not once per allocation (`bridge_paper.py`). Thus the three losing episodes
legitimately reached the locked threshold of three. The first subsequent BUY
rejection occurred on Sep 23 at 22:43 UTC. The guard state carried into validation.
Its 18 BUY intents were rejected by that guard, as recorded in the
[baseline diagnostic](evidence/QL_3A_BASELINE_VALIDATION_DIAGNOSTIC_2026-09-27.json).
This explains this baseline's zero validation trades without assuming every
candidate has identical rejection timing.

## What the signals show

The evaluator generated 56 native BUY bars and 75 native EXIT bars in train,
and 18 BUY bars and 14 EXIT bars in validation. Signal-bar counts differ from
allocation-level Bridge intents and accepted fills. A native EXIT can target
multiple allocations; Bridge lifecycle intents can reference entries that Paper
rejected. The presence of an indicator SELL therefore does not establish a fill.

Current Spot mapping closes Long and never opens Short. However, the mapped
SELL still uses the original bearish entry conditions: bearish SuperTrend,
`close < fast EMA < slow EMA`, a remembered sell-zone setup, bearish confirmation,
shared entry/exit cooldown and hypothetical short-side risk-distance validation.
Changing the execution side alone did not turn this into a dedicated Long exit.

Observed exit-gate evidence:

- Episodes 1, 2 and 3 first reached the full bearish exit bias 15, 13 and 7
  minutes before their eventual native close. Their allocation traces contain
  13, 12 and 7 bars respectively with that bias but no active exit setup.
- Between the first bearish SuperTrend observation after entry and eventual
  close, elapsed times ranged from 60 to 272 minutes. These are first-observation
  intervals, not continuously bearish periods. They do not prove an earlier
  exit would have improved results.
- Cooldown and short-side risk checks are architectural exit dependencies, but
  neither was observed blocking a bar with both exit bias and active setup in
  these nine allocation traces. Removing them alone is not an evidenced remedy.
- Intrabar favorable/adverse excursions are descriptive. They do not establish
  a causal, executable alternative exit or a realizable profit target.

The evidence supports reviewing the bearish setup requirement and trend
confirmation delay. It does not establish profitability of an alternative.
The already accepted baseline parity/repaint evidence remains scoped to the
unchanged source and tested settings.

## Proposed work before another research run

1. **Specify a versioned Spot exit revision for owner review.** Separate the
   rule for reducing an existing Long from the rule for entering a hypothetical
   Short. Use closed-bar information, preserve reduce-only execution, and define
   behavior when BUY/EXIT coincide. State explicitly whether exits depend on
   trend invalidation, setup, confirmation or cooldown. A trend-invalidation
   exit is a research hypothesis, not a validated improvement. Keep existing
   source and evaluator versions reproducible.
2. **Review repeated entries and costs.** Report both closed allocations and
   independent position episodes. Repeated BUYs currently stack exposure and
   consume available cash. Do not silently change pyramiding, capital, quantity
   steps or risk guards. Retain the cost model; assess results after both fees
   and slippage. Nine allocations must not be presented as nine independent
   market opportunities.
3. **Check effective parameter dimensions.** Confirmation Lookback 3/5/7 had
   identical signal vectors in the prior axis dataset with mode Any. This is
   dataset-specific, not proof the input is universally inactive. Audit its
   usefulness before proposing any replacement or revised bounds; retain the
   approved eight-slot lock until reviewed.
4. **Declare validation before searching.** Existing train/validation results
   have now informed design and are exploratory evidence. Freeze the next
   source, policy, cost assumptions, sampling window, budget, seed, trade-count
   rules and episode-coverage assessment before evaluating new candidates.
   Preserve the unopened holdout; do not use it to choose exit rules. Use fresh
   out-of-sample evidence for final claims and retain all negative results.
5. **Minimize repeated collection.** Use existing historical development data
   for causal diagnostics first. Once an owner-approved behavioral revision is
   fixed, align its evaluator and establish its required parity/repaint evidence.
   Do not restart live collection for each exploratory parameter setting or
   reuse old evidence as certification of changed source behavior. Candidate
   parity, chronological coverage, sensitivity, cost stress and final holdout
   gates remain required. A larger bar count alone does not ensure enough trades.

No new run is defined or started by this review. The existing result remains
`NO_VALID_CANDIDATE`; QL-3A recommendation acceptance and QL-4B remain gated.
Next decision is the precise owner-reviewed Spot exit specification, followed
by a declared experiment. Guard resets or repeated searches until success are
not a substitute for this work.
