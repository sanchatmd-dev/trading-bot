# Handoff: QL-1 to QL-4 Hardening & Validation Complete

## 1. Regression Tests Added
- Fixed `test_quote_sized_exit_bounds` in `test_audit_regressions.py` to use `quoteQuantity="500"` correctly testing the quote sizing path.
- Fixed `test_intrabar_sl_suppresses_pending_entry` to directly assert on `result.fills`, `result.cash_journal`, and `result.allocations`, verifying exact quantity deltas, paid entry cash, received exit cash, and zero final inventory.
- Run `uv run --project quant_lab pytest quant_lab/tests/test_audit_regressions.py -v`. All tests passed (7/7).

## 2. Direct Node Parity Verified
- Created `quant_lab/tests/test_node_direct_parity.py` to execute a direct, cross-language parity test.
- This script uses Python's `subprocess` to spawn a Node.js process (`node --input-type=module -e ...`) which directly invokes the production `evaluateRisk` function from `src/postgres/risk.js`.
- It feeds the exact same signal and context to both Python's `evaluate_risk` and Node's `evaluateRisk`.
- **Outcome:** The generated quantity, price, and notional matched exactly byte-for-byte in both environments after resolving field normalizations (e.g., `referencePrice`, `stopLoss`, `takeProfit`, `leverage=1`).

## 3. Next Steps (Action Required on VPS)

As I cannot access your production PostgreSQL environment or `.env` file locally, the following steps must be performed on the VPS to achieve full acceptance:

### A. Isolated Migration Rehearsal (Schema 12)
You must perform an isolated migration rehearsal using your protected configuration before rolling out Schema 12 (Phase R-1) to production.
1. Run `node scripts/backup-postgres.mjs /tmp/backup.dump` (using your protected `.env`) to snapshot production.
2. Restore the dump to an isolated temporary database.
3. Apply `src/postgres/schema.sql` (Schema 12) against the isolated database.
4. Verify that data remains intact (no negative cash, all old positions retained).

### B. Pine/Paper Acceptance
1. Deploy the updated backend capabilities (Schema 12, targeted R-1 exits, universal risk evaluator).
2. Configure TradingView alerts using both `alert_calls` and `order_fills` export modes.
3. Observe Paper execution in the UI to confirm that multiple BUYs are tracked as independent entries (`P1`, `P2`), and that a TP/SL event for `P1` closes *only* `P1` while leaving `P2` intact.

All QL-1 to QL-4 implementation, review fixes, and local tests are now **100% complete and validated**.
You may proceed to deploy and test on the VPS.
