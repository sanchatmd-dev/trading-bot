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
   Use Both Long & Short to receive both SPT BUY and SELL signals. In Spot,
   SELL is mapped to a reduce-only close, never a Short entry. Long only
   disables the indicator's SELL signals and leaves tracked TP/SL exits.
4. In group 11 select the broker, risk % and unique deployment ID (1–12 letters
   or digits). Enable "Send SELL as reduce-only (server checks holdings)";
   version 1.3.0 defaults it on, but saved settings may retain the old off value.
   Server risk limits remain authoritative.
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

### No trigger: inspect Robot Bridge 1.3.0

The bottom-left status table reports this chart instance only, with UTC times.
It shows the last historical and realtime BUY/SELL, last realtime closed bar, last bridge
decision and number of executed alert() calls since chart load. Reloading or
editing inputs resets these counters. An alert runs in its own saved instance;
chart counters do not prove server-side alert execution or webhook delivery.

- Historical signals only: wait for a new confirmed live signal after alert creation.
- Route OFF: enable notifications and select Robot Trade (Spot).
- BUY/SELL skipped: read the explicit reason rather than changing strategy inputs.
- alert() called but no Alert Log event: compare the saved alert's version
  (1.3.0), symbol, timeframe and inputs with the chart. The chart cannot inspect
  whether that alert is active. Create a matching alert when necessary.
- Alert Log has a delivery error: inspect that event's JSON and HTTP error.

The table does not send test orders, replay old BUYs or change SPT signal logic.

### Order behavior

- BUY sends Percent Equity risk, stop, chosen target, reference price, timeframe,
  bar-close timestamp and a deterministic event ID. URL authenticates the bot;
  no API key or webhook secret is embedded in Pine.
- Only confirmed real-time bars emit orders; historical bars emit nothing.
- Repeated BUY signals are sent by default; the server applies its risk and
  balance limits. Disable "Send repeated BUY signals" to restrict the bridge
  to one emitted long. Pine cannot detect whether that first BUY was accepted.
- A bar with an exit sends only the exit, even if BUY also appears. The chart
  shows an orange skipped-BUY reason for exit priority, manual news blocking,
  repeated BUY disabled, or invalid rounded SL/TP/ATR. These diagnostics appear
  on confirmed real-time bars only; historical BUY markers do not send alerts.
- TP/SL emit a single full-close event. No partial TP1–TP5 orders.
- SELL forwarding defaults on and no longer requires a remembered realtime BUY.
  The server checks actual holdings: if none exist, it records a rejected order
  (No Spot position available to sell). Alert delivery and order acceptance are
  separate outcomes. SELL never opens a short. Disable the Send SELL option if
  only tracked TP/SL exits are wanted. Manual news blocking affects BUY only.
- If SELL coincides with a tracked TP/SL, send one TP/SL exit, not a second SELL.
  The last-decision row reports that SELL was covered by the protective event.
- Targeted Exits (Phase R-1): Protective exits (TP/SL) carry `target_trade_id`
  targeting the specific entry lot. The VPS closes ONLY that lot's remaining
  quantity in `ledger_position_allocations`, leaving subsequent scale-in lots
  open with their own independent SL and TP levels.
- General SELL forwarding (reduce-only portfolio exit) closes all open allocations
  via FIFO when no specific target is supplied.
- Unknown/already-closed targets fail closed: if a target allocation is not found
  or is already closed, the server strictly rejects the exit order without falling
  back to closing unrelated open lots.
- The original BE line is visual only; it does not move the bridge stop.
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
normalizer for BUY/SELL/TP/SL, plus the actual BUY and exit-selector expressions.
SELL payloads also run through the PostgreSQL risk engine: full inventory close,
empty-inventory rejection, and pending-reservation rejection.
It does not emulate Pine or verify TradingView
compilation, alert delivery or broker execution. No production orders are sent.
