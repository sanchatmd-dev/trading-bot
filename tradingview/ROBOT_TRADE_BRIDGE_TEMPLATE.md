# Robot Trade Bridge V1.4+ (Phase R-1: Multi-Entry & Targeted Exits)

Canonical, plug-and-play Pine Script bridge extension.
You can append this snippet directly to the bottom of **any** Pine Script v5 or v6 indicator (including **ETRP**, **Open Close Cross Strategy**, etc.) without modifying the original indicator code.

---

## What's New in V1.4+ (Phase R-1)

1. **User-Configurable ATR Multiplier Stop Loss (`rtAtrMult`)**: Allows setting custom stop loss distance as a multiple of ATR (e.g. 1.5, 2.0, 3.0).
2. **Risk:Reward Take Profit (`rtRR`)**: Sets Take Profit automatically as a multiple of the Stop Loss distance.
3. **Multi-Entry Tracking (Scale-in Isolation)**: When repeated BUYs are enabled (`rtRepeatBuy = true`), each entry lot (P1, P2, etc.) is tracked in its own array slot with its individual SL and TP levels.
4. **Targeted Exits (`target_trade_id`)**: When an individual entry touches its SL or TP, the bridge emits an exit containing `target_trade_id` targeting that specific entry. The VPS closes only that lot and keeps remaining lots open.
5. **Entry/SL/TP Visuals (`rtShowVisuals`)**: Automatically renders dynamic Entry, Stop Loss, and Take Profit lines directly on your TradingView chart.

---

## Canonical Bridge Code Snippet

Paste the following block at the very end of your Pine Script file:

```pinescript
// =========================================================================
// ⬇️⬇️⬇️ ROBOT TRADE BRIDGE V1.4+ (PHASE R-1) ⬇️⬇️⬇️
// =========================================================================
groupRobot = "11. Robot Trade - Spot Paper"
rtNotifyEnabled = input.bool(true, "Enable Robot Notifications", group = groupRobot)
rtBuild = input.string("1.4.0", "Robot Bridge version", options = ["1.4.0"], group = groupRobot)
rtTag = input.string("bot1", "Unique alert deployment ID (1-12 letters/digits)", group = groupRobot)
rtBroker = input.string("Binance Global", "Broker", options = ["Binance Global", "Binance TH", "InnovestX", "Settrade"], group = groupRobot)
rtRisk = input.float(0.5, "Risk per BUY (% equity; server limits still apply)", minval = 0.01, maxval = 100, step = 0.1, group = groupRobot)
rtAtrMult = input.float(2.0, "Stop Loss ATR Multiplier (e.g. 1.5, 2, 3)", minval = 0.1, step = 0.5, group = groupRobot)
rtRR = input.float(1.5, "Take Profit Risk:Reward", minval = 0.1, group = groupRobot)
rtShowVisuals = input.bool(true, "Show Entry, SL, TP Lines", group = groupRobot)
rtExitOnSell = input.bool(true, "Send SELL as reduce-only (server checks holdings)", group = groupRobot)
rtNews = input.bool(false, "Manually block BUY for news (not a news feed)", group = groupRobot)
rtRepeatBuy = input.bool(true, "Send repeated BUY signals (server risk limits apply)", group = groupRobot)
rtShowSkipped = input.bool(true, "Show skipped BUY/SELL reason on chart", group = groupRobot)
rtShowStatus = input.bool(true, "Show Robot Bridge status (chart instance only)", group = groupRobot)

rtEnabled = rtNotifyEnabled

if barstate.isfirst and rtEnabled
    if str.length(rtTag) < 1 or str.length(rtTag) > 12 or str.match(rtTag, "^[A-Za-z0-9]+$") != rtTag
        runtime.error("Robot Trade: deployment ID must be 1-12 letters/digits.")
    if not chart.is_standard
        runtime.error("Robot Trade: use standard candles, not synthetic charts.")

f_jsonEscape_rt(string s) =>
    string _s = s
    _s := str.replace_all(_s, "\\", "\\\\")
    _s := str.replace_all(_s, "\"", "\\\"")
    _s := str.replace_all(_s, "\n", "\\n")
    _s

f_rtPayload(string ev, float px, float stop, float target, float vol, int stamp, string targetTradeId = "") =>
    string suffix = targetTradeId != "" ? ("-" + targetTradeId) : ""
    string id = "RT-" + rtTag + "-" + syminfo.ticker + "-" + timeframe.period + "-" + str.tostring(stamp) + "-" + ev + suffix
    string riskPart = ev == "BUY" ? ',"risk_mode":"PERCENT_EQUITY","risk_value":"' + str.tostring(rtRisk, "0.########") + '","stop_loss":"' + str.tostring(stop, format.mintick) + '","take_profit":"' + str.tostring(target, format.mintick) + '"' : ',"risk_mode":"QUANTITY"'
    string targetPart = targetTradeId != "" ? ',"target_trade_id":"' + f_jsonEscape_rt(targetTradeId) + '"' : ''
    string payload = '{"trade_id":"' + f_jsonEscape_rt(id) + '","broker":"' + f_jsonEscape_rt(rtBroker) + '","symbol":"' + f_jsonEscape_rt(syminfo.ticker) + '","timeframe":"' + f_jsonEscape_rt(timeframe.period) + '","event":"' + ev + '","side":"' + (ev == "BUY" ? "BUY" : "SELL") + '","account_type":"Spot","order_type":"MARKET","timestamp":' + str.tostring(stamp) + ',"reference_price":"' + str.tostring(px, format.mintick) + '","reduce_only":' + (ev == "BUY" ? "false" : "true") + ',"leverage":1,"volatility_percent":' + str.tostring(vol, "0.########") + ',"news_risk":' + (rtNews ? "true" : "false") + riskPart + targetPart + '}'
    payload

// Multi-entry tracking parallel arrays (Bounded to max 10 entries)
var string[] rtEntryIds = array.new_string()
var float[] rtEntryStops = array.new_float()
var float[] rtEntryTargets = array.new_float()
var int[] rtEntryBars = array.new_int()
var int rtAlertCalls = 0
var string rtLastDecision = "Waiting for a realtime BUY or SELL"

// Visual lines
var line rtLineEntry = na
var line rtLineSL = na
var line rtLineTP = na
var label rtLblEntry = na
var label rtLblSL = na
var label rtLblTP = na

// 💡 CHANGE THESE TWO VARIABLES TO MATCH YOUR INDICATOR'S BUY/SELL SIGNAL VARIABLES:
rtBuySignal = buySignal    // e.g. bearishTrendReversalPoint in ETRP, or longCond in OCC
rtSellSignal = sellSignal  // e.g. bullishTrendReversalPoint in ETRP, or shortCond in OCC

float rtCurrentAtr = ta.atr(14)

f_rtCanBuy(bool signalBuy, bool trackingLong, bool repeatBuy, bool news, bool exitSent) =>
    signalBuy and (not trackingLong or repeatBuy) and not news and not exitSent

f_rtExitEvent(string protectiveExit, bool signalSell, bool sendSell) =>
    protectiveExit != "" ? protectiveExit : signalSell and sendSell ? "SELL" : ""

if rtEnabled and barstate.isrealtime and barstate.isconfirmed
    float rtPrice = math.round_to_mintick(close)
    float rtVol = na(rtCurrentAtr) or close <= 0 ? 0.0 : 100.0 * rtCurrentAtr / close
    string rtEvent = ""

    // 1. Check protective exits for tracked entries (FIFO order)
    if array.size(rtEntryIds) > 0
        for i = array.size(rtEntryIds) - 1 to 0
            int entryBar = array.get(rtEntryBars, i)
            if bar_index > entryBar
                float entryStop = array.get(rtEntryStops, i)
                float entryTarget = array.get(rtEntryTargets, i)
                bool stopHit = low <= entryStop
                bool targetHit = high >= entryTarget
                if stopHit or targetHit
                    string ev = stopHit ? "SL" : "TP"
                    string targetId = array.get(rtEntryIds, i)
                    alert(f_rtPayload(ev, rtPrice, na, na, rtVol, time_close, targetId), alert.freq_once_per_bar_close)
                    rtAlertCalls += 1
                    rtEvent := ev
                    rtLastDecision := ev + ": alert() called; check Alert Log"
                    array.remove(rtEntryIds, i)
                    array.remove(rtEntryStops, i)
                    array.remove(rtEntryTargets, i)
                    array.remove(rtEntryBars, i)

    // 2. Check strategy SELL signal (portfolio close)
    rtEvent := f_rtExitEvent(rtEvent, rtSellSignal, rtExitOnSell)
    if rtEvent != ""
        if rtEvent == "SELL"
            alert(f_rtPayload("SELL", rtPrice, na, na, rtVol, time_close, ""), alert.freq_once_per_bar_close)
            rtAlertCalls += 1
            rtLastDecision := "SELL: alert() called; check Alert Log"
            array.clear(rtEntryIds)
            array.clear(rtEntryStops)
            array.clear(rtEntryTargets)
            array.clear(rtEntryBars)
        else if rtSellSignal and rtExitOnSell
            rtLastDecision := "SELL covered by " + rtEvent + ": one exit alert() called"
    else if rtSellSignal and not rtExitOnSell
        rtLastDecision := "SELL skipped: Send SELL disabled"

    // 3. Check BUY entry
    bool trackingLong = array.size(rtEntryIds) > 0
    string rtSkip = ""
    if rtBuySignal
        rtSkip := rtEvent != "" ? "Exit takes priority this bar" : rtNews ? "Manual news block enabled" : trackingLong and not rtRepeatBuy ? "Repeated BUY disabled" : array.size(rtEntryIds) >= 10 ? "Max 10 open entries reached" : ""
    
    if f_rtCanBuy(rtBuySignal, trackingLong, rtRepeatBuy, rtNews, rtEvent != "") and array.size(rtEntryIds) < 10
        float slDistance = rtCurrentAtr * rtAtrMult
        float nextStop = math.round_to_mintick(close - slDistance)
        float nextTarget = math.round_to_mintick(close + (slDistance * rtRR))

        if rtPrice > 0 and not na(nextStop) and nextStop > 0 and nextTarget > rtPrice and not na(rtCurrentAtr)
            string buyId = "RT-" + rtTag + "-" + syminfo.ticker + "-" + timeframe.period + "-" + str.tostring(time_close) + "-BUY"
            array.push(rtEntryIds, buyId)
            array.push(rtEntryStops, nextStop)
            array.push(rtEntryTargets, nextTarget)
            array.push(rtEntryBars, bar_index)
            alert(f_rtPayload("BUY", rtPrice, nextStop, nextTarget, rtVol, time_close, ""), alert.freq_once_per_bar_close)
            rtAlertCalls += 1
            rtLastDecision := "BUY: alert() called; check Alert Log"

            if rtShowVisuals
                if not na(rtLineEntry)
                    line.delete(rtLineEntry)
                    line.delete(rtLineSL)
                    line.delete(rtLineTP)
                    label.delete(rtLblEntry)
                    label.delete(rtLblSL)
                    label.delete(rtLblTP)
                rtLineEntry := line.new(bar_index, rtPrice, bar_index + 15, rtPrice, color=color.blue, width=2)
                rtLineSL := line.new(bar_index, nextStop, bar_index + 15, nextStop, color=color.red, width=2)
                rtLineTP := line.new(bar_index, nextTarget, bar_index + 15, nextTarget, color=color.green, width=2)
                rtLblEntry := label.new(bar_index + 15, rtPrice, "Entry: " + str.tostring(rtPrice, format.mintick), color=color.blue, textcolor=color.white, style=label.style_label_left)
                rtLblSL := label.new(bar_index + 15, nextStop, "SL: " + str.tostring(nextStop, format.mintick), color=color.red, textcolor=color.white, style=label.style_label_left)
                rtLblTP := label.new(bar_index + 15, nextTarget, "TP: " + str.tostring(nextTarget, format.mintick), color=color.green, textcolor=color.white, style=label.style_label_left)
        else
            rtSkip := "Invalid rounded SL/TP or ATR unavailable"

    if rtBuySignal and rtSkip != ""
        rtLastDecision := "BUY skipped: " + rtSkip
        if rtShowSkipped
            label.new(bar_index, low, "Robot BUY skipped: " + rtSkip, style = label.style_label_up, color = color.orange, textcolor = color.black, size = size.small)

// Update visual lines length on latest bar
if barstate.islast and array.size(rtEntryIds) > 0 and rtShowVisuals
    if not na(rtLineEntry)
        line.set_x2(rtLineEntry, bar_index + 15)
        line.set_x2(rtLineSL, bar_index + 15)
        line.set_x2(rtLineTP, bar_index + 15)
        label.set_x(rtLblEntry, bar_index + 15)
        label.set_x(rtLblSL, bar_index + 15)
        label.set_x(rtLblTP, bar_index + 15)
// =========================================================================
// ⬆️⬆️⬆️ END ROBOT TRADE BRIDGE ⬆️⬆️⬆️
// =========================================================================
```
