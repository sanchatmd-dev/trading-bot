# Robot trade UI update

- Default UI language: English. EN/TH selection is saved on this device; changing it preserves form inputs.
- Successful saves display a localized, non-blocking confirmation (Saved / บันทึกแล้ว).
- Rejected signals show the original rejection reason and a separate editable note (2,000 characters maximum). Only the owner or an administrator can edit it. Notes are audited and never replace execution errors.
- Forgot Password shows safe administrator-assisted guidance only. It does not expose server paths or recovery commands, send email, or promise an email reset link. SMTP recovery is not configured.
- On mobile, the primary navigation is collapsed behind an accessible Menu button so every destination remains reachable without horizontal scrolling.
- Default maximum risk per trade is 100 percent of equity. This is a ceiling, not an order-size target; stop-loss, available Spot equity, and order/daily notional limits still apply.
- Existing profiles are not silently overwritten by migration. Back up the database, then use the explicit operator command if requested: `DB_PATH=/absolute/database node scripts/set-max-risk.mjs user@email 100`.
- Binance Global maps TradingView USD quote aliases to USDT before queueing, risk checks and position lookup: BTCUSD, BTC/USD, BINANCE:BTCUSD and BTCUSDT resolve to BTCUSDT. No USD/USDT exchange-rate conversion is performed. The configured Binance Global equity remains USDT.
- Binance TH/InnovestX/Settrade retain their existing THB policies. MT5 symbols are not rewritten; unsupported adapters remain locked.
- Database schema 4 adds `review_note`. Back up before upgrading; an older schema-3 application cannot open the upgraded database.
- Branding changes do not rename server directories, existing license keys, sessions or webhook URLs.
- All execution remains Paper-only. No real-money trading is enabled by this release.

## Operator-only password recovery

Run the existing recovery helper from the active release over an authenticated operator session. Keep deployment paths and commands out of the public UI:

```sh
cd <current-release>
set -a; . <shared-environment-file>; set +a
read -r -p "Account email: " RESET_EMAIL
export RESET_EMAIL
./scripts/reset-password.sh
```

The helper prompts for the replacement password and never displays the previous password. Do not place credentials in shell history, tickets, chat, screenshots or documentation.
