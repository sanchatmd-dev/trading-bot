# Robot trade UI update

- Default UI language: English. EN/TH selection is saved on this device; changing it preserves form inputs.
- Successful saves display a localized, non-blocking confirmation (Saved / บันทึกแล้ว).
- Rejected signals show the original rejection reason and a separate editable note (2,000 characters maximum). Only the owner or an administrator can edit it. Notes are audited and never replace execution errors.
- Forgot Password opens instructions for the existing administrator-assisted VPS reset. It does not send email or promise an email reset link. SMTP recovery is not configured.
- Default maximum risk per trade is 100 percent of equity. This is a ceiling, not an order-size target; stop-loss, available Spot equity, and order/daily notional limits still apply.
- Existing profiles are not silently overwritten by migration. Back up the database, then use the explicit operator command if requested: `DB_PATH=/absolute/database node scripts/set-max-risk.mjs user@email 100`.
- Binance Global maps TradingView USD quote aliases to USDT before queueing, risk checks and position lookup: BTCUSD, BTC/USD, BINANCE:BTCUSD and BTCUSDT resolve to BTCUSDT. No USD/USDT exchange-rate conversion is performed. The configured Binance Global equity remains USDT.
- Binance TH/InnovestX/Settrade retain their existing THB policies. MT5 symbols are not rewritten; unsupported adapters remain locked.
- Database schema 4 adds `review_note`. Back up before upgrading; an older schema-3 application cannot open the upgraded database.
- Branding changes do not rename server directories, existing license keys, sessions or webhook URLs.
- All execution remains Paper-only. No real-money trading is enabled by this release.
