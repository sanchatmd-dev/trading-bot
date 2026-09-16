# Robot trade — Project Context

## Purpose

Robot trade is a personal, multi-user TradingView webhook receiver and Spot-trading control plane. It is deployed on a VPS and currently runs in **Paper-only** mode: no real broker orders can be submitted by this release.

## Production

- Public URL: https://www.robottrade.io
- VPS host: 187.53.141.5
- Application user: mikey
- Current release: e56be94
- Service: astra-trade.service (user service)
- Application: /home/mikey/apps/astra-trade/current
- Shared state: /home/mikey/apps/astra-trade/shared
- Database: /home/mikey/apps/astra-trade/shared/data/astra-v2.db
- Reverse proxy: Nginx with HTTPS
- Bot-profile release verified after immutable symlink deployment: service active, health OK (PAPER_ONLY), schema v8, SQLite integrity OK, bot assets served, and unauthenticated bot API denied.
- Pre-migration final backup: shared/backups/pre-bots-final-20260916T184434Z.db. Migration was rehearsed against a backup before production activation.

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
- Percent Equity sizing is capped automatically at the lowest safe value among risk-derived size, free configured equity, free configured cash balance, max order notional and remaining daily notional budget.
- Explicit quantity and fixed-notional requests are still rejected if they exceed risk/equity constraints.
- Every numeric Risk Manager limit has an editable Default and Max Value. Default supplies the calculator's suggested setting; Max Value is the enforced ceiling.
- Each broker has Total Equity and Balance. Balance is available Spot buying cash, cannot exceed Total Equity, and falls back to Total Equity for older profiles.
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
- Current test suite: 55 tests.
- Back up SQLite before production release changes using scripts/backup.mjs.
- Deploy each release as a new immutable directory, switch the current symlink only after tests pass, then restart the user service.
- Database schema version is 8. Migration 8 adds bot ownership, slot indexes and labels to users. Existing IDs, history and webhook secrets remain attached to Main Bot slot 1. An older application cannot open a newer schema.
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

## Known rejection causes and handling

- **Order exceeds available configured Spot equity**: automatic Percent Equity sizing now caps the order. Explicit oversized quantity remains rejected.
- **Order exceeds available configured Spot balance**: increase the configured Balance only when cash is actually available, or reduce the order. Percent Equity sizing caps automatically.
- **No Spot position available to sell**: the prior entry did not fill or no Paper position exists; exit orders are not converted into entries.
- **Symbol is not allowed**: add the symbol in Risk Manager only when intentionally approved.
- **Risk percent exceeds policy**: lower risk_value or explicitly review the configured ceiling.

## Repository

- Remote: https://github.com/sanchatmd-dev/trading-bot.git
- Main branch: main
