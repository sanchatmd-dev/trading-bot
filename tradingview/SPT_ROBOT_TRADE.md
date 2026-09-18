# SPT pro V4 → Robot Trade (Spot Paper)

Use `spt_pro_v4_robot_trade.pine`. The original Desktop file is untouched.
Original indicator formulas, inputs, visuals and backtest logic are preserved.
Only an additional notification option, a legacy-alert suppression guard and
an isolated execution bridge were added. This is not Quant Lab optimization.

## Setup

1. Use a dedicated, empty Paper bot in Robot Trade. Copy its current webhook
   URL from Account & License. Treat that URL as a secret; do not publish it.
2. Paste the entire Pine file into TradingView Pine Editor, save and add it to
   a standard candlestick chart. Use the broker's matching spot market/currency.
3. Enable Notifications. Set Additional Notification to **Robot Trade (Spot)**.
   Use Long only, or Both Long & Short if using the optional opposite SELL exit.
4. In group 11 select the broker, risk % and unique deployment ID (1–12 letters
   or digits). Server risk limits remain authoritative.
5. Select the full-exit target with the existing Backtest Target setting
   (TP1–TP5, default TP3). Conservative mode gives SL priority when both
   SL and target are touched in the same candle; Optimistic gives TP priority.
6. Create an alert with **Any alert() function call** and paste the bot's URL
   into Webhook URL. Do not use the old individual BUY/SELL/TP alertconditions:
   those still emit the original human-readable messages.
7. Verify a real-time Paper BUY and its eventual exit in Trade Log before use.
   This change has not been compiled in TradingView or end-to-end tested there.

TradingView alerts snapshot script/settings. After changes, delete the old
alert and recreate it, only after the bot is flat. Disable duplicate alerts.
See [TradingView alerts documentation](https://www.tradingview.com/pine-script-docs/concepts/alerts/).

## Execution contract and limits

- BUY sends Percent Equity risk, stop, chosen target, reference price, timeframe,
  bar-close timestamp and a deterministic event ID. URL authenticates the bot;
  no API key or webhook secret is embedded in Pine.
- Only confirmed real-time bars emit orders; historical bars emit nothing.
- One active emitted long per alert. Additional BUY signals while active are
  ignored. This is an explicit bridge policy, not a change to SPT signal logic.
- TP/SL emit a single full-close event. No partial TP1–TP5 orders.
- Optional opposite SELL closes the long; default off. Never opens a short.
- Exits omit quantity and therefore close ALL holdings for that bot/symbol.
  Do not mix indicators/manual entries in the same bot/symbol.
- The bridge freezes entry SL/target until exit even if indicator drawings change.
  The original BE line is visual only; it does not move the bridge stop.
- Exit execution uses bar-close price, not the touched SL/TP price. This is
  close-bar notification, NOT an exchange-hosted protective stop. Alert outage,
  stale rejection and gaps can prevent or delay exits.
- Pine tracks emitted alerts, not accepted orders. If an order is rejected,
  missing, or manually closed, stop the alert and reconcile the bot before
  restarting from flat. Recreating an alert loses its tracked position.
- Existing notifyOnSignal/TP/SL switches control legacy notifications, not this
  bridge. Enable notifications is the master switch for both.
- Volatility is ATR / close × 100; news flag is manual, not a news feed.
  Changing it requires recreating the alert; use server-side pause/kill controls
  for immediate intervention.
- USD → USDT remains the server's Binance Global symbol alias only. It is not
  FX conversion. THB brokers must use THB price data. Adapters being selectable
  does not mean live trading is implemented or enabled.
- Use separate deployment IDs per alert. Do not change ID to retry an order
  without checking Trade Log; that would bypass duplicate protection.

## Verification

`node --test --test-isolation=none test/spt-bridge.test.js` verifies unchanged original-source hash
and evaluates the actual payload string expressions against the PostgreSQL
normalizer for BUY/SELL/TP/SL. It does not emulate Pine or verify TradingView
compilation, alert delivery or broker execution. No production orders are sent.
