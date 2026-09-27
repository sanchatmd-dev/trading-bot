# QL-3A — dedicated Spot EXIT v1 development revision

Date: 2026-09-27. Owner instruction: implement the proposed work following the
[signal review](QL_3A_SPT_SIGNAL_REVIEW_2026-09-27.md).
Status: **draft implemented; historical development preflight failed**.
No new optimization, live collection, staging rollout or production change.

## Exact signal specification

- Use only confirmed chart bars on standard BINANCE:BTCUSDT 1m, with the
  previously reviewed Custom profile and 58 effective input values.
- Invalidation condition: bearish source SuperTrend **and** close below Fast EMA.
- Emit native EXIT on the first confirmed bar entering that condition. Do not
  repeat while it remains true. Once it becomes false, a later true condition
  can emit a new EXIT. There is no new tunable input or confirmation length.
- EXIT does not wait for Slow EMA, a sell-zone setup, bearish entry confirmation,
  entry cooldown, entry session, RSI/BOS/sweep filters or hypothetical short risk.
- EXIT wins a simultaneous BUY/EXIT conflict. It can only request closing Long.
  A signal is independent of whether Paper accepted the corresponding BUY;
  Bridge/Paper remains authoritative for reduce-only position execution.
- BUY filters and repeated-entry policy remain unchanged. Existing signal
  registration still resets the shared cooldown and setup state after an EXIT.
  Consequently a changed EXIT time can change later BUY timing. This revision
  does **not** claim identical BUY vectors to the old source.
- Preserve independent Bridge ATR(14), ATR60/RR1.5 research baseline, capital,
  fees, slippage, exchange increments and all existing Risk Manager guards.
  Product defaults remain ATR2/RR1.5.

The old source, evaluator, registered profile and runtime allowlist are unchanged.
The separate `spt_spot_exit_v1.py` evaluator is an offline research draft; the
existing research API still rejects an unregistered revised source hash.

## Artifacts and frozen development plan

`scripts/build-spt-spot-exit-revision.mjs` requires the approved source hash,
restores all 58 reviewed effective input defaults, and changes the EXIT rule
and title in a private artifact. It adds evidence plots without an execution
Bridge, URL or token. Original notifications default to off.
The generated private artifact is `.qa-local/spt-spot-exit-v1-draft.pine`.
Its source/artifact hashes and effective-input hash are in the
[frozen development plan](evidence/QL_3A_SPOT_EXIT_V1_PLAN_2026-09-27.json).
TradingView compilation, parity and fresh repaint have **not** been claimed.

The plan was recorded before evaluating this revision. It permits exactly four
Paper replays: old/new rule at baseline costs, then old/new at doubled fees and
slippage. It uses the already explored 8,650 warm-up/train/validation bars from
the earlier run, excludes holdout and permits zero optimization candidates.
All input bounds remain unchanged. A separate min/max signal-effect audit
covers each of the eight approved source slots without ranking their returns.

`scripts/review-spt-spot-exit.py` binds the private baseline request and draft
evaluator to their frozen hashes, enforces exclusion of holdout and records all
four outcomes. It reproduces the old train/validation metrics within 1e-12.

## Development result

Amounts are USDT. These are continuous historical Paper simulations with the
same policy carried across train and validation, not new live fills.

| Rule and costs | Train closed allocations | Train completed position episodes | Train net PnL | Validation closed trades |
| --- | ---: | ---: | ---: | ---: |
| Old EXIT, baseline costs | 9 | 3 | -8.764223 | 0 |
| Spot EXIT v1, baseline costs | 8 | 3 | -5.185278 | 0 |
| Old EXIT, doubled costs | 9 | 3 | -13.927744 | 0 |
| Spot EXIT v1, doubled costs | 8 | 3 | -9.586459 | 0 |

All three position episodes lose under each comparison. The new rule improves
this historical net loss, but does not establish profitability, sufficient
validation coverage or a reason to reset the loss-streak guard.

For Spot EXIT v1 at baseline costs, raw price PnL is -0.7489697 USDT, fees are
4.0327842497 USDT and adverse execution adjustments are 0.4035244 USDT.
It still reaches the three-loss stop. Across the supplied simulation there are
44 BUY rejections from the loss-streak guard and six from the daily trade-count
limit. The account ends flat. More EXIT flags alone do not solve the sampling
or economics problem. Changes in accepted allocation sizes under doubled costs
are expected because sizing includes costs and exchange increments.

Signal counts change from old train 56 BUY/75 EXIT and validation 18 BUY/14 EXIT
to new train 45 BUY/114 EXIT and validation 15 BUY/49 EXIT. These are signal bars,
not filled trades. The result includes fees, execution adjustments, episodes,
drawdown, open allocations and rejection counts in
[machine-readable evidence](evidence/QL_3A_SPOT_EXIT_V1_RESULT_2026-09-27.json).

## Repeated entries and effective parameter review

Eight accepted allocations still form only three independent position episodes.
Repeated entries remain material to exposure and cash use. This revision isolates
the EXIT change, so it does not silently impose one-position-per-symbol,
replenish cash or change loss limits. A future entry/pyramiding revision must
be separately specified, rather than confounded with this comparison.

The 16 min/max comparisons show zero BUY/EXIT-vector differences for **Setup
Expiry 24/72** and **Confirmation Lookback 3/7** on this development window.
The remaining six dimensions change at least one signal vector. This is an
effective signal-diversity finding, not proof that either input is globally
inactive. The eight-slot owner lock is retained. Any narrower selection or
replacement requires a versioned lock before another search; silently calling
these eight independent effective dimensions would be misleading.

## Validation requirements and next decision

The proposed next research acceptance plan preserves the existing minimum five
closed allocations per partition and additionally requires five completed
flat-to-flat position episodes per partition. This additional episode check is
recorded for the future plan; current API screening and runtime policy have not
been modified. These are engineering minimums, not statistical proof of an edge.

Before a future optimization, freeze source, effective inputs, bounds, policy,
cost model, capital, chronological dataset boundaries/hash, budget and seed.
The explored window cannot be relabeled independent validation. Keep the old
holdout unopened. A new unseen evaluation window must be declared separately;
no such window has been consumed by this diagnostic.

A finalized revision requires at least 3,250 cold warm-up bars and 2,000 measured
parity bars, zero BUY/EXIT mismatches, state tolerance 1e-7, exact independent
Spot OHLCV agreement, and the scoped 100-consecutive-observation repaint check
with zero changed observations. Candidate-specific parity, sensitivity, doubled
costs, chronological trade coverage and untouched final holdout remain gates.

**Decision:** retain this negative result and draft. Do not ask the owner to
paste it or collect another live sample solely to rescue this result. Do not
activate it, replace the existing Paper Alert, reset guards, or start another
parameter search. The next design topic is entry frequency and transaction-cost
suitability, including a separately reviewed repeated-entry rule. This diagnostic
does not select a replacement rule or a more profitable timeframe.

QL-3A recommendation acceptance and QL-4B remain gated. Existing natural Paper
collection is unaffected. This development result is retained as a Git checkpoint;
runtime activation remains a separate action.
