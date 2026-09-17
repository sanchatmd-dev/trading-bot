# Robot trade — Project Context

## Purpose

Robot trade is a personal, multi-user TradingView webhook receiver and Spot-trading control plane. It is deployed on a VPS and currently runs in **Paper-only** mode: no real broker orders can be submitted by this release.

## Production

- Public URL: https://www.robottrade.io
- VPS host: 187.53.141.5
- Application user: mikey
- Current release: b441476 (Phase 1, schema 10)
- Service: astra-trade.service (user service)
- Application: /home/mikey/apps/astra-trade/current
- Shared state: /home/mikey/apps/astra-trade/shared
- Database: /home/mikey/apps/astra-trade/shared/data/astra-v2.db
- Reverse proxy: Nginx with HTTPS
- Bot-profile release verified after immutable symlink deployment: service active, health OK (PAPER_ONLY), schema v8, SQLite integrity OK, bot assets served, and unauthenticated bot API denied.
- Pre-migration final backup: shared/backups/pre-bots-final-20260916T184434Z.db. Migration was rehearsed against a backup before production activation.
- Phase 0 deployed on 2026-09-17 using an immutable release and symlink swap. Production schema v9, integrity/foreign keys OK, 58 Paper fills matched 58 cash journal entries, and public assets/authentication boundary checks passed.
- Phase 0 final backup: shared/backups/pre-phase0-final-20260917T014852Z.db. Rehearsal preserved all IDs/secrets and row counts; no negative reconstructed cash, unresolved Paper orders, or FIFO analytics errors were found.
- UI hardening release 3feeb07 was deployed immutably on 2026-09-17 after 74/74 VPS tests. Backup: shared/backups/pre-ui-3feeb07-20260917T023024Z.db. Production remained schema v9/PAPER_ONLY; 59 Paper fills matched 59 cash journal entries and authentication checks passed.

Do not store passwords, webhook URLs, API keys, tokens, or private key material in this file.

## Architecture

1. **Signal layer**: TradingView indicator sends a Universal Webhook payload with trade_id, broker, symbol, event, sizing data, SL/TP, timestamp, volatility and news fields.
2. **Bot core**: Node.js validates the signal, authenticates its per-user webhook secret, applies risk controls, persists it in SQLite and processes the Paper order.
3. **Execution adapters**: Binance Global, Binance TH, InnovestX, MT5, Settrade and a future HTTP adapter use a common registry. Live execution is locked.

## Product rules

- Spot only; Spot SELL orders must be reduce_only.
- Paper-only is enforced in configuration and server code.
- Binance Global normalizes crypto USD aliases to USDT before risk and position checks: BTCUSD, BTC/USD and BINANCE:BTCUSD become BTCUSDT.
- This is a symbol alias, not a currency conversion. Binance Global equity is USDT. Thai account policies remain THB.
- Duplicate trade_id values are rejected per user.
- Repeated BUY entries for the same symbol are allowed by default. Each entry requires a unique trade_id, is checked independently, and contributes to trade, notional, equity, balance and pending-order limits. Spot holdings remain aggregated per broker account and symbol, so scale-in does not consume another unique-symbol position slot.
- Stale signals are rejected according to the user profile.
- Existing rejected signals are historical records and are never resent automatically.

## Default / owner risk settings

- Max risk per trade: 100%
- Max order notional: 10,000 USDT
- Max daily notional: 100,000 USDT
- Percent Equity sizing is capped automatically at the lowest safe value among risk-derived size, available book equity, journaled cash minus reservations, max order notional and remaining daily notional budget.
- Explicit quantity and fixed-notional requests are still rejected if they exceed risk/equity constraints.
- Every numeric Risk Manager limit has an editable Default and Max Value. Default supplies the calculator's suggested setting; Max Value is the enforced ceiling.
- Each broker has configured Total Equity and Balance funding. Changes append capital deltas without resetting PnL. Current Paper cash and book equity are displayed separately and drive execution risk checks; book equity is not mark-to-market.
- The Risk Manager includes a real-time, non-executing preview that uses the same server-side risk engine as webhook orders. It shows risk amount, quantity, notional, available balance, open/remaining position slots and how many positions of the previewed size fit. A preview is point-in-time guidance; another concurrent signal can still consume capacity before execution.

Other safeguards include max trades per day, maximum daily loss, maximum open positions, an optional repeated-symbol entry block, loss-streak pause, volatility and news blocks, allowed-symbols list, side mode, kill switch and reduce-only enforcement.

## UI

- Product name: **Robot trade**
- English is the default UI language; users can switch to Thai.
- A successful save shows Saved / บันทึกแล้ว.
- Recent Signals display their received timestamp.
- Trade Log shows an EN/TH explanation and original reason for REJECTED rows. A user or administrator can append a reviewed note to rejected rows.
- The UI is tested to avoid horizontal page overflow at normal desktop and mobile viewports.

## Webhook security

- Webhook secrets are hash-verified on receipt.
- Current webhook URLs are encrypted with AES-256-GCM, bound to the owning user and available only through that authenticated user's session.
- Legacy hash-only webhook URLs are recovered on the next successful webhook request, or when their owner supplies the existing URL for verification. They are not rotated automatically.
- Webhook URLs, passwords and broker credentials are secret data. Never log or commit them.

## Operations

- Run tests: npm test
- Current test suite: 88 tests, passed locally and on the VPS before deploying release b441476.
- Back up SQLite before production release changes using scripts/backup.mjs.
- Deploy each release as a new immutable directory, switch the current symlink only after tests pass, then restart the user service.
- Production database schema is 10, with account security, Paper funding, cash journals and book-value snapshots. Existing IDs, history and webhook secrets are preserved. An older application cannot open a newer schema.
- All database changes require a verified backup and integrity check.

## Bot profiles

- Each main account owns up to five bot profiles: the existing main ID in slot 1 and four child IDs in slots 2–5.
- Child rows in `users` have `parent_user_id`, `bot_slot_index` and `label`. Existing `user_id` foreign keys and composite primary keys identify the canonical bot ID; no historical order ownership is rewritten.
- Bot profiles have independent risk profiles, configured Paper equity/balance, positions, fills, daily limits, loss streaks, credentials, analytics fees and encrypted webhook secrets. Newly created bots start with zero configured funds.
- Only main accounts can log in. Sessions and licenses belong to the main account. Suspension of the main account blocks all child webhooks and queued execution. Email notifications go to the owner.
- `/api/bots` lists or creates profiles; `PATCH /api/bots/:id` renames a profile. Scoped routes use `bot_id`. `bot_id=all` is a read-only overview/trade-log scope within the authenticated owner's five profiles.
- These are independent application Paper profiles, not exchange subaccounts. The global administrator kill switch still pauses entries across all bots.

## Analytics behavior

- Paper fills are matched into closed positions with round-trip FIFO per user, broker and symbol.
- Summary metrics include win/loss, win rate, net profit, profit factor, drawdown, expectancy, realized average win/loss ratio, streaks, average holding time and fee impact.
- Users can add a custom fee in basis points per broker. It changes analytics only; it does not mutate historical fills.
- Analytics APIs and UI support daily, weekly, monthly, annual and custom UTC date ranges, plus asset filters.
- Currency is selected by broker and never combined: Binance Global is USDT; Binance TH, InnovestX and Settrade are THB.
- Normal users can read only their own analytics. Administrators may select a user explicitly.

## Phase 0 (deployed)

- Risk now uses Paper cash and cost-based book equity from journaled fills. Realized losses reduce buying power; realized gains increase it. Pending reservations are deducted once.
- Equity/Balance inputs represent cumulative funding. Changing them appends a funding delta and never resets PnL; unchanged saves are idempotent. The UI separately shows current ledger cash and book equity.
- Migration reconstructs Paper cash from the current configured baseline and existing fills. Legacy funding dates are unknown; historical percentages are suppressed instead of fabricated. Negative reconstructed balances require operator review, not an automatic credit.
- Restart revalidates unfilled Paper jobs, preserves/cancels partially filled remainders, and quarantines inconsistent ledgers. LIVE/LEGACY orders are not replayed.
- Analytics counts completed flat-to-flat cycles. Period PnL and realized drawdown include partial exits; unrealized price changes are excluded. Historical funding records replace today's editable capital as the percentage basis.
- See docs/PHASE0.md and scripts/rehearse-phase0.mjs. Production migration rehearsal and backend smoke checks passed. Rendered browser QA was completed at 1440×900 desktop and 390×844 mobile; login, password entry, EN/TH, mobile navigation and public recovery guidance were verified without sending production signals.

## Phase 1 (deployed)

- Agreed Phase 1 scope is security: MFA, sessions, password recovery, RBAC and secret rotation. Scaling/Postgres belongs to a later phase.
- Schema 10 adds TOTP/recovery-code state, short-lived login/reset challenges, encrypted recovery mail and persistent attempt limits. It revokes legacy sessions while preserving existing trading/ownership data and secrets.
- Browser login now uses HttpOnly same-site cookies, exact Origin checks and CSRF headers. ADMIN/SUPPORT require MFA for privileged controls; sensitive operations require recent identity confirmation. Password, MFA, status and role changes revoke authentication state.
- UI includes MFA enrollment/login/recovery codes, identity confirmation and SMTP-backed password recovery with EN/TH labels. USER/SUPPORT/ADMIN have explicit grants; cross-owner bot access remains denied.
- Versioned tenant-bound encryption supports offline key rotation with a verified backup and transaction rollback. `scripts/rehearse-phase1.mjs` checks schema-9 migration on a copy without modifying the source.
- Deployment requires `PUBLIC_ORIGIN=https://www.robottrade.io`, the unchanged existing master key, administrator enrollment and backup/rehearsal. See docs/PHASE1.md for activation and rollback steps.
- Before deployment, the owner manually started an isolated local QA server after the execution policy refused agent startup. The policy was not weakened. Phase 1 rendered Chrome QA covered Desktop 1440×900 and Mobile 390×844, EN/TH, MFA recovery-code login, session reload and mobile navigation. A mobile Bot toolbar wrapping issue was fixed. Screenshots are outside the repository; physical devices and Safari were not tested.
- Local validation on 2026-09-18: 88/88 tests passed (74 existing plus 14 Phase 1/API/DOM tests), 47 JavaScript modules passed syntax checks, and `git diff --check` passed. Automated tests are separate from the rendered-browser and production checks recorded here.
- SMTP follow-up on 2026-09-18 (Asia/Bangkok): Gmail accepted one plain-text test message sent from the VPS using the existing EmailNotifier and protected environment configuration. The owner confirmed inbox receipt. A missing closing angle bracket in SMTP_FROM was corrected after a restricted-permission configuration backup. No production password reset or trade was triggered, and the service was not restarted. Recovery-token handling is covered by isolated automated tests, not a completed production password reset. The earlier absence of SMTP configuration is resolved.
- Deployment completed on 2026-09-18 (Asia/Bangkok): immutable release b441476, schema 10, 88/88 VPS tests and syntax checks passed. Two verified-copy rehearsals passed before migration; all 18 pre-existing non-session tables were unchanged, including 513 signals, 151 fills/cash-journal entries and three webhook secrets. The 21 old sessions were intentionally revoked. PUBLIC_ORIGIN now matches https://www.robottrade.io; master key and webhook URLs were not rotated.
- Final backup: /home/mikey/apps/astra-trade/shared/backups/pre-phase1-b441476-20260917T182451Z.db (matching protected environment backup: same path plus .env). Health, integrity/FKs, public assets, authentication/Origin boundaries and mobile recovery UI passed after activation. The service remains Paper-only. See docs/PHASE1.md for the deployment record and rollback restrictions.
- Read-only acceptance review on 2026-09-18 confirmed release b441476, schema 10, integrity OK, no foreign-key errors, an active service, an empty queue and no service errors in the preceding 30 minutes. Administrator MFA was enrolled for 1/1 accounts and an unexpired MFA-verified session existed. No completed production password recovery was recorded. Owner confirmation of recovery-code safekeeping and a full isolated system-restore drill remain pending. Phase 2 development may start in isolation; this is not approval for Live trading or commercial launch.

## Known rejection causes and handling

- **Order exceeds available configured Spot equity**: automatic Percent Equity sizing now caps the order. Explicit oversized quantity remains rejected.
- **Order exceeds available configured Spot balance**: increase the configured Balance only when cash is actually available, or reduce the order. Percent Equity sizing caps automatically.
- **No Spot position available to sell**: the prior entry did not fill or no Paper position exists; exit orders are not converted into entries.
- **Symbol is not allowed**: add the symbol in Risk Manager only when intentionally approved.
- **Risk percent exceeds policy**: lower risk_value or explicitly review the configured ceiling.

## Repository

- Remote: https://github.com/sanchatmd-dev/trading-bot.git
- Main branch: main
