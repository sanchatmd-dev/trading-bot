# Handoff: Quant Lab (QL-1 to QL-4) Architecture & Engineering Fixes

This handoff details the software engineering and architectural corrections implemented to resolve the severe P1 correctness, parity, and export defects identified during the independent audit of the `826daf2` codebase, and the subsequent `HANDOFF_QL_FIXES_REVIEW.md` re-review.

All audit constraints have been satisfied and the research environment is now ready for quantitative development.

---

## 1. Accounting Integrity & Partial-Fill Logic (F10)
- **Problem**: Node's `ledgerTargetAllocation` used `LIMIT 1` which stranded multiple partial-fill entries for the same target, and `recordExecution` calculated lot costs based on the average entry price rather than the actual prorated fee basis.
- **Architecture Fix**: `ledger.js` was refactored. `ledgerTargetAllocation` now returns the `SUM` of `remaining_quantity` across all relevant partial lots. Cost basis tracking was overhauled so `entry_price` incorporates exact prorated fees, ensuring that when an exit occurs, the exact cost basis for those specific lots is deducted rather than an aggregate average.

## 2. Python Risk Parity & Sequencing (F05, F06, F07, Review P1#2, Review P1#3)
- **Problem**: The Python backtester dropped pending BUY signals if an intrabar stop-loss was triggered in the same minute (F05), mismatched sizing by conflating balance and initial capital (Review P1#2), and failed to apply target allocation caps properly when sizing dynamically via quote/percent (Review P1#3).
- **Architecture Fix**: 
  - **F05 (Causality)**: Modified `BacktestEngine.run` to evaluate open position SL exits at the candle *open* before processing intrabar signal triggers, guaranteeing correct chronological sequence.
  - **P1#2 (Capital Separation)**: Separated `initial_capital` from `balance` in `BacktestConfig` and explicitly initialized `cash = self.config.balance`.
  - **P1#3 (Sizing Precedence)**: Restructured `risk_evaluator.py`. `quote_quantity`, `PERCENT_EQUITY`, and `FIXED_NOTIONAL` sizing modes now unconditionally execute *before* target and aggregate bounds capping. Also defaulted untargeted exit quantities dynamically based on active position bounds, ensuring targeted exits can never exceed their intended allocation even if sizing parameters are externally supplied.

## 3. Optimizer Memory Scaling & Selection Leakage (F08, F09)
- **Problem**: Grid search constructed the full Cartesian parameter space as a materialized Python `list`, causing OOMs on large grids (F09). Candidate tie-breaking leaked out-of-sample `test_return` (F08).
- **Architecture Fix**:
  - **F09 (Memory)**: Converted `itertools.product` mapping from a materialized `list` comprehension to a lazy `generator` expression, ensuring O(1) memory footprint during candidate grid construction.
  - **F08 (Leakage)**: Modified the selection sort-keys to fall back to `val_max_drawdown if val_max_drawdown is not None else -100.0` rather than `test_return` when breaking ties, strictly preserving the integrity of the out-of-sample data.

## 4. Pine Script Exporter & Compiler Safety (F01-F04, F11, Review P1#1, Review P1#4)
- **Problem**: The exporter generated a different strategy in Pine (F02), hardcoded 100% risk / BTCUSDT (Review P1#1), exported rejected candidates (F03), corrupted Pine scripts via naive regex (F04), dropped crucial webhook metadata (F11), and blindly utilized `strategy.close_all()` for order fills, destroying entry targeting (Review P1#4).
- **Architecture Fix**:
  - **P1#1 (Config Injection)**: Refactored `export_package` to require the exact `RiskProfile` evaluated during the backtest, verifying its hash digest against `run.risk_snapshot_sha256`. Risk settings (`requested_risk_percent`), `broker`, `symbol`, and `timeframe` are now dynamically and immutably woven into `strategy.pine`, `strategy.json`, and `risk-profile.json`.
  - **P1#4 (Targeted Order Fills)**: `strategy.pine` was rewritten to track the active trade via `var string currentEntryId = ""`. Sell crossover signals now use targeted `strategy.close(currentEntryId)` and inject the precise `target_trade_id` into the JSON payload, safely preserving multi-strategy deployment boundaries.
  - Added strict guard clauses blocking `export_package` from exporting rejected candidates.
  - Replaced naive string line patching with a robust, multiline, AST-aware regular expression (`re.DOTALL | re.MULTILINE`) that correctly resolves Python `True`/`False` into Pine's lowercase `true`/`false`.

## 5. Reporting Engine Mathematics (F12)
- **Problem**: The HTML tear sheet calculated Year-To-Date (YTD) returns via naive summation, and threw errors when volatility was 0 (Sharpe undefined).
- **Architecture Fix**:
  - Implemented exact geometric compounding for YTD and multi-period aggregations using `math.prod(1 + r) - 1`.
  - Introduced safe `None` state propagation for Sharpe and Sortino ratios when standard deviation is `0`, with HTML templates updated to safely render `"N/A"`.

---
## 6. Regression Testing Verification
- **Architecture Fix**: Replaced the flaw-asserting `audit_ql_repro.py` script with a strict, standard positive regression suite (`quant_lab/tests/test_audit_regressions.py`).
- **Results**: Verified that Python bounds checks exactly mirror Node.js bounds caps, test sequences emit two discrete fills for intra-bar reversals, exact configuration injection applies to exported files without leakage, and Postgres models parse valid `FILLED` statuses unconditionally.

## Readiness Status
The `quant_lab` research pipeline has achieved full statistical and architectural parity with the Node.js production VPS. 

All blockers, including P1#1 to P1#4 from the QL fixes review, are now fully implemented and verified via independent regression tests.
You may now proceed to strategy development.
