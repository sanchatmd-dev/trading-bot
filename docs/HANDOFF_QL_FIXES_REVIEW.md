# Handoff — QL fixes readiness review

Date: 2026-09-22  
Recipient: Antigravity / next implementing agent  
Project: Robot Trade  
Repository: `C:/Users/USER/Documents/Codex/2026-09-13/create-an-image-of/work/astra-vps-trade-bot-v2`

## Decision

**Do not mark QL-4 accepted yet.** Changes address some earlier findings, but the
claim of full statistical and architectural parity in `docs/handoff_ql_fixes.md`
is not supported by the current code or verification results.

Isolated APP-3 preparation can continue. This does not authorize deployment,
production database changes, or Live trading. Preserve Spot Paper-only mode.

## Review scope and working state

- Reviewed the fixes handoff and local changes against the earlier audit
  `docs/HANDOFF_AUDIT_QL1_QL4_826daf2.md`.
- Fixes are uncommitted changes to `backtest.py`, `exporter.py`, `optimizer.py`,
  `records.py`, `reporting.py`, `risk_evaluator.py`, and `src/postgres/ledger.js`.
  Preserve these changes; do not reset or overwrite them wholesale.
- This was a focused readiness review, not a complete re-certification of all
  twelve original findings. Findings not repeated below are not implicitly closed.
- No production service or database was touched. No commit or push was performed.

## Fresh verification

| Check | Result |
| --- | --- |
| `npm test` | 111 passed, 0 failed |
| `uv run --project quant_lab --no-sync pytest quant_lab/tests -q` | 62 passed, 1 failed |
| `uv run --project quant_lab --no-sync ruff check quant_lab` | Failed: one F401 unused import |

Python failure: `quant_lab/tests/test_reporting.py:75`,
`test_tearsheet_edge_case_zero_trades` expects Sharpe `0.0`, but implementation
returns `None`. Undefined Sharpe may legitimately be represented by `None`;
agree the contract, update the test, and verify HTML renders N/A correctly rather
than reverting the mathematics just to make the test green.

Ruff failure: unused `StrategySignal` import in
`quant_lab/src/robot_quant/backtest.py:30`.

## Blocking findings still visible

### 1. Export still substitutes risk and market settings — P1

Evidence: `quant_lab/src/robot_quant/exporter.py:99` and `:207` still generate
`rtRiskVal = input.float(100.0, ...)`. Export generation also hard-codes
`binance-global`, `BTCUSDT`, and metadata timeframe `1h`.

Removing risk percentage fields from `risk-profile.json` does not make the output
match the researched risk profile.

Acceptance: pass the actual frozen risk/market/timeframe configuration into export,
verify its hash, and serialize the same values into Pine and the bundle. Test
non-default risk, non-BTC symbols, multiple intervals and supported broker scopes.

### 2. Backtest balance is stored but not used — P1

Evidence: `BacktestConfig.balance` and profile assignment were added, but
`quant_lab/src/robot_quant/backtest.py:103` still initializes cash from
`self.config.initial_capital`. The new balance field is not consumed by the engine.

Acceptance: define funding/book-equity semantics explicitly and match the Node
contract. Test different initial capital and available balance, including low
cash, fees and open inventory. Do not blindly substitute one field without
checking how historical funding and book equity should interact.

### 3. Quote-sized exits bypass the new target cap — P1

Evidence: `quant_lab/src/robot_quant/risk_evaluator.py:221` onward caps a provided
quantity to the target allocation, but `quote_quantity` is converted to quantity
later at `:248–249`, after that cap. The previous final aggregate cap was removed.

Acceptance: normalize all exit sizing forms before final target/aggregate bounds
checks. Compare Python directly against the current Node evaluator for quantity,
quote quantity, close-remaining, missing/closed targets and oversized requests.
Include both target trade ID and position ID contracts where supported.

### 4. Order-fill SELL is still untargeted — P1

Evidence: `quant_lab/src/robot_quant/exporter.py:250` generates
`strategy.close_all()` with an empty target in its SELL payload. A symbol-wide
server exit can therefore include inventory not owned by that exported entry.

Acceptance: preserve entry/deployment ownership through every exit path. Verify
BUY1 → P1, BUY2 → P2, exit P1 leaves P2 unchanged. Cover crossover SELL as well as
TP/SL, and both alert sources. No silent fallback to symbol-wide close-all for
independently managed entries.

### 5. Full acceptance evidence remains outstanding

The Roadmap explicitly leaves TradingView/VPS Paper forward acceptance pending.
This review did not verify actual PostgreSQL execution, migration/restore,
TradingView compilation, or forward webhook delivery from generated Pine.

Acceptance: produce evidence for those gates before claiming QL-4 complete.
Before any authorized production migration, take the prescribed PostgreSQL backup
and rehearse an isolated restore/migration. Follow immutable releases plus symlink
deployment only after tests/rehearsal pass and deployment is authorized.

## Improvements observed, but not full acceptance

- Backtest now queues previous-bar BUY/SELL before current-bar SL/TP.
- Export rejects candidates with `passed_all_gates == False`.
- Spurious TP logic was removed and bearish crossover handling added.
- Python boolean preset values now emit lowercase Pine booleans.
- Optimizer no longer uses test return as the winner tie-breaker, and stops
  collecting valid candidates at the search budget.
- Ledger target lookup aggregates remaining quantities across matching lots;
  entry lot price now includes fees. Real PostgreSQL and partial-fill accounting
  regression evidence is still required.

Do not equate these code changes with complete cross-engine equivalence.

## Additional follow-up from the original audit

- Pine still serializes `time`; recheck timestamp freshness against receiver age
  limits for the actual alert timing. Do not confuse this with a timezone issue.
- Strategy/deployment IDs are optional empty Pine inputs, not demonstrably bound
  to the exported deployment automatically.
- Optimizer still uses `val_max_drawdown or -100.0`, treating valid zero drawdown
  as missing. Use explicit `None` handling and cover this in ranking tests.
- Multiline regex is not an AST parser. Test strings, escaped literals, nested
  calls, named arguments, comments and missing inputs; fail explicitly when an
  intended preset cannot be applied safely.
- Recheck all remaining original findings, including migration/backfill policy,
  initial-risk accounting, strategy warm-up/ATR/execution parity and provenance.

## Recommended next work order

1. Add regression tests for the four concrete correctness blockers above; fix
   their contracts and implementations without expanding production scope.
2. Resolve the reporting expectation and lint error, then rerun complete suites.
3. Reconcile every original finding with code evidence and a passing regression
   test, or explicitly leave it open with rationale.
4. Run isolated PostgreSQL lifecycle/migration tests, Pine compilation and
   controlled Paper acceptance with event IDs and reconciled balances/positions.
5. Update `handoff_ql_fixes.md`, Context, Roadmap and README to distinguish
   implemented, locally tested and forward-accepted states.
6. Commit/push and deploy only when separately requested or authorized.

## Important testing clarification

`docs/audit_ql_repro.py` was written to assert the old defects. An exception or
assertion failure after a fix does **not** prove all defects are fixed; the script
may terminate before subsequent probes run. Convert each probe into independent
positive regression tests for the desired behavior and run them all.

## Completion criteria

QL-4 may be proposed for acceptance only when all blocking findings are closed,
Node/Python/lint checks pass, execution parity has direct fixture evidence, and
the required PostgreSQL/Pine/Paper gates are documented. Passing existing unit
tests alone is insufficient. APP-4 paid Paper readiness and APP-5 Live have their
own gates and must not be inferred from this handoff.
