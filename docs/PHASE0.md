# Phase 0: Paper accounting and recovery

Release 50062f5 uses schema v9 and was deployed on 2026-09-17. Live trading remains disabled. Future production activations require a migration rehearsal and review of the resulting balances.

## Money semantics

- Risk inputs `equities` and `balances` now mean cumulative configured Paper funding. Saving an unchanged value does not deposit money again. Changing either value appends the delta; it does not erase PnL.
- `paper_funding` records capital adjustments. `paper_cash_journal` records BUY debits, SELL credits and actual recorded fees, once per cumulative fill. `paper_snapshots` records cash and book equity after funding/fills.
- Cash = configured cash funding + net cash movements. Book equity = configured total funding + net cash movements + remaining position cost. The difference between configured total funding and configured cash is non-tradable capital, not an invented position.
- Book equity is cost-based, not mark-to-market equity. Unrealized price changes are not available in this release. Analytics custom fee settings remain hypothetical and do not change executable cash.
- Risk checks use current book equity and current cash minus pending reservations. Position cost is not subtracted from cash twice. Withdrawals cannot consume positions or pending reservations.
- SQLite REAL and JavaScript numbers are still used. A decimal-money migration remains part of Phase 2, before Live execution.

## Existing database policy

Schema v8 did not record funding-change history. Migration preserves the current configured capital as a dated `LEGACY_BASELINE` and replays only known Paper fills into the cash journal. It does not modify the original fills, risk settings, IDs or secrets. No historical deposit dates are fabricated.

This is a deterministic reconstruction, not proof of what earlier user edits meant. Historical withdrawals, manual resets, or simulated overspending can produce negative cash. Do not clamp it to zero or silently credit the account. Review the rehearsal results and explicitly adjust Paper capital if appropriate. Percentages for periods with unknown legacy funding are unavailable.

## Recovery

- An interrupted Paper order with no recorded fill/cash effect is requeued and revalidated, including staleness, user status and risk policy.
- An interrupted Paper order with consistent partial fills is canceled for its remaining quantity; already-booked cash and inventory are preserved. A fully booked intent becomes FILLED without replay.
- Inconsistent fill/cash records remain UNKNOWN and block the affected Paper account for operator review.
- LIVE/LEGACY outcomes are never automatically replayed. Execution mode scopes uncertainty checks, so a LIVE recovery issue cannot contaminate the separate Paper ledger.

## Analytics definitions

- A trade is one flat-to-flat cycle per Bot, broker and symbol. Scaling in or selling partially does not create extra completed trades.
- Win rate, profit factor, expectancy and streaks use completed cycles, assigned to their final close date. A completed cycle can span the selected period boundary.
- Net profit, fee impact, realized drawdown and the curve use FIFO-matched realized exits within the selected period, including exits from cycles still open. `closedNetProfit` distinguishes completed-cycle profit from period-realized profit.
- Drawdown excludes unrealized prices and funding flows. It must not be described as full portfolio drawdown.
- Opening capital uses timestamped funding and prior realized PnL, not today's editable risk value. Percentages are suppressed when capital changes during the measurement interval or legacy history cannot support a baseline. Amounts remain available.

## Rehearsal and release gate

Run against a stopped application or a consistent source backup. The helper always takes a verified snapshot and migrates only that new file:

```sh
node scripts/rehearse-phase0.mjs /path/to/astra-v2.db /new-directory/phase0-rehearsal.db
```

Review negative cash and UNKNOWN counts. Inspect representative Main/Sub-Bot balances and closed trades in an isolated instance with SMTP disabled. Run `npm test`, browser QA on desktop/mobile EN/TH, and confirm a buy/loss/rebuy cycle rejects overspending. Do not submit test signals to production.

Before activation, stop the service and run `scripts/backup.mjs` for a final pre-v9 snapshot. Preserve the encryption key separately. Deploy to a new immutable directory, swap the symlink, restart and verify schema, health, journals, balances and authentication. Rollback requires the matching v8 database and application; restoring a snapshot loses activity after that snapshot, so do not automatically roll back after accepting new signals.

## Deployment verification — 2026-09-17

- Release: 50062f5, activated by immutable directory and symlink swap after the user's deploy request.
- Tests: 73/73 locally and on VPS; database-copy migration and balance guards passed before activation.
- Final verified backup: `shared/backups/pre-phase0-final-20260917T014852Z.db`.
- Production: schema 9, integrity and foreign keys OK, 58 Paper fills matched 58 cash journal entries. Service active; health reported PAPER_ONLY with zero queued jobs. Updated static assets returned 200; unauthenticated account, bots and analytics APIs returned 401.
- Rehearsal found no negative cash, unresolved Paper orders or FIFO analytics errors. No test orders were submitted to production.
- Rendered browser QA was completed at 1440×900 desktop and 390×844 mobile. Login, password entry, EN/TH switching and Forgot Password were exercised without submitting signals. The follow-up fixes replace the overflowing mobile navigation with a collapsible menu and remove operator paths/commands from the unauthenticated recovery dialog.
