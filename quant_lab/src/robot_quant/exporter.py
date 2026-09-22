"""Pine Script exporter and deployment packaging engine.

Generates validated deployment bundles under quant_lab/exports/{export_id}/:
- inputs.json: Optimized parameters, deltas, and research provenance hashes.
- strategy.pine: Pine Script v6 template matching user's selected alert source.
- strategy.json: Machine-readable strategy and execution assumptions.
- risk-profile.json: Frozen risk settings snapshot.
- setup.md: Comprehensive bilingual (EN/TH) TradingView configuration guide.
- validation.html: Validation gates evidence and risk disclosures.

Also provides safe input-only preset patching for existing indicators (e.g. SPT pro V4),
preserving 100% of the indicator's mathematical calculations.
"""

import difflib
import json
import re
from pathlib import Path
from typing import Any

from robot_quant.contracts import (
    AlertSource,
    ExportMetadata,
    OptimizationRun,
    RiskProfile,
)
from robot_quant.optimizer import CandidateEvaluation


def apply_input_preset(pine_source: str, new_inputs: dict[str, Any]) -> str:
    """Update only defval parameters in input() declarations, leaving logic unchanged."""
    # Pattern to match input declarations across multiple lines
    pattern = re.compile(
        r"(?m)^(?P<prefix>[ \t]*(?:(?:var|varip)[ \t]+)?(?:(?:int|float|string|bool|color)[ \t]+)?)(?P<var>[a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=[ \t]*(?P<decl>input(?:\.[a-zA-Z_]+)?)[ \t]*\([ \t]*(?:defval[ \t]*=[ \t]*)?(?P<val>[^,\)]+)(?P<rest>.*?\))",
        re.DOTALL
    )

    def replacer(match):
        var_name = match.group("var")
        if var_name in new_inputs:
            val = new_inputs[var_name]
            if isinstance(val, bool):
                new_val = "true" if val else "false"
            else:
                new_val = str(val)
            
            prefix = match.group("prefix")
            decl = match.group("decl")
            rest = match.group("rest")
            
            has_defval_kw = "defval" in match.group(0)[match.start("decl") - match.start(0) : match.start("val") - match.start(0)]
            defval_prefix = "defval = " if has_defval_kw else ""
            
            return f"{prefix}{var_name} = {decl}({defval_prefix}{new_val}{rest}"
        return match.group(0)

    return pattern.sub(replacer, pine_source)


def generate_input_diff(original_source: str, updated_source: str) -> str:
    """Generate a clean unified diff between original and updated Pine scripts."""
    diff = difflib.unified_diff(
        original_source.splitlines(),
        updated_source.splitlines(),
        fromfile="original.pine",
        tofile="optimized.pine",
        lineterm="",
    )
    return "\n".join(diff)


def _generate_pine_alert_calls(
    template_id: str,
    params: dict[str, str],
    broker: str,
    symbol: str,
) -> str:
    """Generate Pine Script v6 using alert() function calls."""
    ema_fast = params.get("ema_fast", "9")
    ema_slow = params.get("ema_slow", "21")
    atr_period = params.get("atr_period", "14")
    atr_mult = params.get("atr_multiplier", "2.0")

    return f"""//@version=6
indicator("Robot Trade - {template_id} (Alert Calls)", overlay=true)

// ==========================================
// 1. OPTIMIZED INPUTS (Quant Lab QL-4)
// ==========================================
int   emaFast   = input.int({ema_fast}, "Fast EMA Period", minval=1)
int   emaSlow   = input.int({ema_slow}, "Slow EMA Period", minval=1)
int   atrPeriod = input.int({atr_period}, "ATR Period", minval=1)
float atrMult   = input.float({atr_mult}, "Stop Loss ATR Multiplier", minval=0.5, step=0.1)

// Execution settings
string rtBroker = input.string("{broker}", "Broker Account")
string rtSymbol = input.string("{symbol}", "Symbol")
string rtStrategyId = input.string("", "Strategy ID (Auto-filled by deployment)")
string rtDeploymentId = input.string("", "Deployment ID (Auto-filled by deployment)")
float  rtRiskVal = input.float({params.get("requested_risk_percent", "100.0")}, "Risk Value (% Equity)")

// ==========================================
// 2. INDICATOR LOGIC
// ==========================================
float fastMa = ta.ema(close, emaFast)
float slowMa = ta.ema(close, emaSlow)
float atrVal = ta.atr(atrPeriod)

plot(fastMa, "Fast EMA", color=color.blue, linewidth=2)
plot(slowMa, "Slow EMA", color=color.orange, linewidth=2)

bool bullCross = ta.crossover(fastMa, slowMa)
bool bearCross = ta.crossunder(fastMa, slowMa)

// ==========================================
// 3. MULTI-ENTRY TRACKING & TARGETED EXITS
// ==========================================
var string[] rtEntryIds = array.new_string(0)
var float[]  rtEntryStops = array.new_float(0)
var int[]    rtEntryBars = array.new_int(0)

f_rtPayload(string event, string tradeId, string targetTradeId, float slPrice) =>
    string payload = '{{"trade_id":"' + tradeId + '","broker":"' + rtBroker + '","symbol":"' + rtSymbol + '","event":"' + event + '","entry_price":' + str.tostring(event == "SL" ? slPrice : close, "#.##")
    if rtStrategyId != ""
        payload += ',"strategy_id":"' + rtStrategyId + '"'
    if rtDeploymentId != ""
        payload += ',"deployment_id":"' + rtDeploymentId + '"'
    if targetTradeId != ""
        payload += ',"target_trade_id":"' + targetTradeId + '"'
    if event == "BUY"
        payload += ',"risk_mode":"PERCENT_EQUITY","risk_value":' + str.tostring(rtRiskVal)
    if not na(slPrice) and slPrice > 0
        payload += ',"stop_loss":' + str.tostring(slPrice, "#.##")
    payload += ',"timestamp":' + str.tostring(time) + '}}'
    payload

// BUY Entry
if barstate.isconfirmed and bullCross
    if array.size(rtEntryIds) < 10
        string entryId = "ENTRY-" + str.tostring(time)
        float stopLevel = close - (atrVal * atrMult)
        array.push(rtEntryIds, entryId)
        array.push(rtEntryStops, stopLevel)
        array.push(rtEntryBars, bar_index)
        alert(f_rtPayload("BUY", entryId, "", stopLevel), alert.freq_once_per_bar_close)

// SELL Exit (Crossover)
if barstate.isconfirmed and bearCross
    if array.size(rtEntryIds) > 0
        int idx = array.size(rtEntryIds) - 1
        while idx >= 0
            string eId = array.get(rtEntryIds, idx)
            alert(f_rtPayload("SELL", "SELL-" + eId, eId, na), alert.freq_once_per_bar_close)
            array.remove(rtEntryIds, idx)
            array.remove(rtEntryStops, idx)
            array.remove(rtEntryBars, idx)
            idx -= 1

// Intrabar Stop Loss Evaluation
if array.size(rtEntryIds) > 0
    int idx = array.size(rtEntryIds) - 1
    while idx >= 0
        string eId = array.get(rtEntryIds, idx)
        float eStop = array.get(rtEntryStops, idx)
        int eBar = array.get(rtEntryBars, idx)

        if bar_index > eBar
            if low <= eStop
                alert(f_rtPayload("SL", "SL-" + eId, eId, eStop), alert.freq_once_per_bar)
                array.remove(rtEntryIds, idx)
                array.remove(rtEntryStops, idx)
                array.remove(rtEntryBars, idx)
        idx -= 1
"""


def _generate_pine_order_fills(
    template_id: str,
    params: dict[str, str],
    broker: str,
    symbol: str,
) -> str:
    """Generate Pine Script v6 strategy using strategy.order.alert_message."""
    ema_fast = params.get("ema_fast", "9")
    ema_slow = params.get("ema_slow", "21")
    atr_period = params.get("atr_period", "14")
    atr_mult = params.get("atr_multiplier", "2.0")

    return f"""//@version=6
strategy("Robot Trade - {template_id} (Order Fills)", overlay=true, margin_long=100, margin_short=100)

// NOTE: Strategy Tester order fills are simulated by TradingView's emulator.
// They are not VPS broker order confirmations.

// ==========================================
// 1. OPTIMIZED INPUTS (Quant Lab QL-4)
// ==========================================
int   emaFast   = input.int({ema_fast}, "Fast EMA Period", minval=1)
int   emaSlow   = input.int({ema_slow}, "Slow EMA Period", minval=1)
int   atrPeriod = input.int({atr_period}, "ATR Period", minval=1)
float atrMult   = input.float({atr_mult}, "Stop Loss ATR Multiplier", minval=0.5, step=0.1)

// Execution settings
string rtBroker = input.string("{broker}", "Broker Account")
string rtSymbol = input.string("{symbol}", "Symbol")
string rtStrategyId = input.string("", "Strategy ID (Auto-filled by deployment)")
string rtDeploymentId = input.string("", "Deployment ID (Auto-filled by deployment)")
float  rtRiskVal = input.float({params.get("requested_risk_percent", "100.0")}, "Risk Value (% Equity)")

// ==========================================
// 2. INDICATOR LOGIC
// ==========================================
float fastMa = ta.ema(close, emaFast)
float slowMa = ta.ema(close, emaSlow)
float atrVal = ta.atr(atrPeriod)

plot(fastMa, "Fast EMA", color=color.blue, linewidth=2)
plot(slowMa, "Slow EMA", color=color.orange, linewidth=2)

bool bullCross = ta.crossover(fastMa, slowMa)
bool bearCross = ta.crossunder(fastMa, slowMa)

// ==========================================
// 3. STRATEGY ORDERS & ORDER-FILL MESSAGES
// ==========================================
f_fillPayload(string event, string tradeId, string targetId, float slPrice) =>
    string payload = '{{"trade_id":"' + tradeId + '","broker":"' + rtBroker + '","symbol":"' + rtSymbol + '","event":"' + event + '","entry_price":' + str.tostring(event == "SL" ? slPrice : close, "#.##")
    if rtStrategyId != ""
        payload += ',"strategy_id":"' + rtStrategyId + '"'
    if rtDeploymentId != ""
        payload += ',"deployment_id":"' + rtDeploymentId + '"'
    if targetId != ""
        payload += ',"target_trade_id":"' + targetId + '"'
    if event == "BUY"
        payload += ',"risk_mode":"PERCENT_EQUITY","risk_value":' + str.tostring(rtRiskVal)
    if not na(slPrice) and slPrice > 0
        payload += ',"stop_loss":' + str.tostring(slPrice, "#.##")
    payload += ',"timestamp":' + str.tostring(time) + '}}'
    payload

var string currentEntryId = ""

if bullCross
    currentEntryId := "ORD-" + str.tostring(time)
    float stopLevel = close - (atrVal * atrMult)
    string buyMsg = f_fillPayload("BUY", currentEntryId, "", stopLevel)
    strategy.entry(currentEntryId, strategy.long, alert_message=buyMsg)
    
    string slMsg = f_fillPayload("SL", "SL-" + currentEntryId, currentEntryId, stopLevel)
    strategy.exit("Exit-" + currentEntryId, from_entry=currentEntryId, stop=stopLevel, alert_message=slMsg)

if bearCross and currentEntryId != ""
    strategy.close(currentEntryId, alert_message=f_fillPayload("SELL", "SELL-" + str.tostring(time), currentEntryId, na))
    currentEntryId := ""
"""


def _generate_setup_guide_md(
    alert_source: AlertSource,
    strategy_id: str,
    symbol: str,
    broker: str,
) -> str:
    """Generate comprehensive bilingual (EN/TH) TradingView setup instructions."""
    if alert_source == "alert_calls":
        source_inst_en = """1. Add the exported `strategy.pine` to your TradingView chart.
2. Click the **Alert** icon (clock with plus) on TradingView.
3. In **Condition**, select the indicator name (`Robot Trade - ...`).
4. Select **alert() function calls only** (Do NOT choose Order fills).
5. In **Expiration**, choose Open-ended if available.
6. Under **Alert actions**, check **Webhook URL** and paste your private Webhook URL from Robot Trade.
7. Leave the **Message** box blank (the Pine Script supplies the exact formatted JSON)."""

        source_inst_th = """1. นำโค้ด `strategy.pine` ไปวางใน Pine Editor บน TradingView แล้วคลิก Add to chart
2. คลิกไอคอน **Create Alert** บน TradingView
3. ในช่อง **Condition** ให้เลือกชื่อ Indicator (`Robot Trade - ...`)
4. เลือก **alert() function calls only** (ห้ามเลือก Order fills)
5. ในหัวข้อ **Alert actions** ให้ติ๊ก **Webhook URL** แล้ววาง Webhook URL ส่วนตัวของคุณจากระบบ Robot Trade
6. ปล่อยช่อง **Message** ว่างไว้ (เพราะตัวสคริปต์จะจัดส่ง JSON ที่มีคำสั่ง TP/SL และ target_trade_id โดยอัตโนมัติ)"""
    else:
        source_inst_en = """1. Add the exported `strategy.pine` to your TradingView chart.
2. Click the **Alert** icon on TradingView.
3. In **Condition**, select the strategy name.
4. Select **Order fills only**.
5. Under **Alert actions**, check **Webhook URL** and paste your Webhook URL.
6. In the **Message** box, type exactly: `{{strategy.order.alert_message}}`.
7. IMPORTANT: Order-fill events are simulated TradingView fills, not broker execution confirmations. The VPS Risk Manager remains authoritative."""

        source_inst_th = """1. นำโค้ด `strategy.pine` ไปวางใน Pine Editor บน TradingView แล้วคลิก Add to chart
2. คลิกไอคอน **Create Alert** บน TradingView
3. ในช่อง **Condition** ให้เลือกชื่อ Strategy
4. เลือก **Order fills only**
5. ในหัวข้อ **Alert actions** ให้ติ๊ก **Webhook URL** แล้ววาง Webhook URL จาก Robot Trade
6. ในช่อง **Message** ให้พิมพ์: `{{strategy.order.alert_message}}`
7. ข้อควรระวัง: สัญญาณ Order Fills เป็นเพียงผลการจำลองใน TradingView Emulator เท่านั้น ไม่ใช่การยืนยันไม้เทรดจริงจากโบรเกอร์ ระบบควบคุมความเสี่ยงบน VPS จะเป็นผู้ตัดสินใจสุดท้ายเสมอ"""

    return f"""# Robot Trade — TradingView Setup Guide / คู่มือการตั้งค่า

Export Package: **{strategy_id}**  
Target Symbol: **{symbol}**  
Broker Account: **{broker}**  
Alert Source: **`{alert_source}`**  

---

## English Instructions

### Prerequisites
- Active TradingView subscription supporting Webhook alerts (Pro/Essential or higher).
- Your unique authenticated Webhook URL from Robot Trade (Settings → Webhooks).
- Never share your webhook URL or commit it into public repositories.

### TradingView Alert Configuration
{source_inst_en}

---

## คำแนะนำภาษาไทย (Thai Instructions)

### สิ่งที่ต้องเตรียม
- บัญชี TradingView ที่รองรับ Webhook Alert (แพ็กเกจ Essential / Plus / Premium)
- Webhook URL ส่วนตัวของคุณจากเมนูตั้งค่าใน Robot Trade
- ห้ามเปิดเผย Webhook URL ให้ผู้อื่นทราบ

### ขั้นตอนการสร้าง Alert บน TradingView
{source_inst_th}

---

## Verification & Safety Checklist / ตรวจสอบความปลอดภัย
- [ ] VPS Risk Manager is running in **Paper Mode** for initial forward testing.
- [ ] Symbol alias corresponds to spot trading pair (e.g. BTCUSDT).
- [ ] Target allocation isolation is enabled (Phase R-1 schema 12).
"""


def _generate_validation_html(
    candidate: CandidateEvaluation,
    strategy_id: str,
    alert_source: AlertSource,
) -> str:
    """Generate validation gates evidence HTML page."""
    return f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Validation Results — {strategy_id}</title>
    <style>
        body {{ background: #131722; color: #d1d4dc; font-family: sans-serif; padding: 24px; }}
        .card {{ background: #1e222d; border: 1px solid #2a2e39; border-radius: 6px; padding: 20px; max-width: 800px; margin: 0 auto; }}
        h1 {{ color: #fff; font-size: 20px; margin-bottom: 16px; }}
        .badge {{ padding: 4px 8px; border-radius: 4px; font-weight: bold; font-size: 12px; }}
        .badge-pass {{ background: rgba(38,166,154,0.2); color: #26a69a; }}
        .badge-fail {{ background: rgba(239,83,80,0.2); color: #ef5350; }}
        .row {{ display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #2a2e39; }}
    </style>
</head>
<body>
    <div class="card">
        <h1>Research Validation Gates — {strategy_id}</h1>
        <div class="row">
            <span>Overall Status</span>
            <span class="badge {'badge-pass' if candidate.passed_all_gates else 'badge-fail'}">
                {'VALIDATED' if candidate.passed_all_gates else 'REJECTED: ' + candidate.rejection_reason}
            </span>
        </div>
        <div class="row"><span>Alert Source</span><strong>{alert_source}</strong></div>
        <div class="row"><span>Validation Set Return</span><strong>{candidate.val_return:+.2f}%</strong></div>
        <div class="row"><span>Out-of-Sample Test Return</span><strong>{candidate.test_return:+.2f}%</strong></div>
        <div class="row"><span>Sensitivity Score (Neighbor Stability)</span><strong>{candidate.sensitivity_score:+.2f}%</strong></div>
        <div class="row"><span>Cost Stress Return (2x Fees & Slippage)</span><strong>{candidate.stress_return:+.2f}%</strong></div>
        <div class="row"><span>Profit Factor</span><strong>{f'{candidate.val_profit_factor:.2f}' if candidate.val_profit_factor else 'N/A'}</strong></div>
        <div class="row"><span>Max Drawdown</span><strong>{f'{candidate.val_max_drawdown:.2f}%' if candidate.val_max_drawdown else 'N/A'}</strong></div>
    </div>
</body>
</html>
"""


def export_package(
    run: OptimizationRun,
    candidate: CandidateEvaluation,
    alert_source: AlertSource,
    output_dir: Path,
    risk_profile: RiskProfile,
    symbol: str,
    timeframe: str = "1h",
) -> ExportMetadata:
    """Generate complete deployment package under output_dir."""
    if alert_source != run.strategy.alert_source:
        raise ValueError(
            f"Export alert source ({alert_source}) must match evaluated strategy alert source ({run.strategy.alert_source})"
        )
        
    if risk_profile.digest() != run.risk_snapshot_sha256:
        raise ValueError("Provided risk profile hash does not match run.risk_snapshot_sha256")
        
    if not candidate.passed_all_gates:
        raise ValueError(f"Cannot export rejected candidate: {candidate.status} - {candidate.rejection_reason}")

    output_dir.mkdir(parents=True, exist_ok=True)
    strategy_def = run.strategy
    template_id = strategy_def.template_id

    # 1. inputs.json & input-change list
    orig_inputs = {p.name: str(p.default) for p in strategy_def.parameters}
    opt_inputs = {k: str(v) for k, v in candidate.params.items()}
    changes = []
    for k in orig_inputs:
        old_val = orig_inputs[k]
        new_val = opt_inputs.get(k, old_val)
        changes.append({
            "parameter": k,
            "original_value": old_val,
            "optimized_value": new_val,
            "changed": old_val != new_val,
        })

    inputs_payload = {
        "strategy_id": strategy_def.strategy_id,
        "template_id": template_id,
        "run_id": run.run_id,
        "alert_source": alert_source,
        "dataset_sha256": run.dataset_sha256,
        "risk_snapshot_sha256": run.risk_snapshot_sha256,
        "dependency_lock_sha256": run.dependency_lock_sha256,
        "original_inputs": orig_inputs,
        "optimized_inputs": opt_inputs,
        "input_changes": changes,
    }
    (output_dir / "inputs.json").write_text(json.dumps(inputs_payload, indent=2), encoding="utf-8")

    # 2. strategy.pine
    opt_inputs["broker"] = risk_profile.scope.broker
    opt_inputs["requested_risk_percent"] = str(risk_profile.requested_risk_percent)
    
    if alert_source == "alert_calls":
        pine_code = _generate_pine_alert_calls(template_id, opt_inputs, risk_profile.scope.broker, symbol)
    else:
        pine_code = _generate_pine_order_fills(template_id, opt_inputs, risk_profile.scope.broker, symbol)
    (output_dir / "strategy.pine").write_text(pine_code, encoding="utf-8")

    # 3. strategy.json
    strat_payload = {
        "strategy_id": strategy_def.strategy_id,
        "template_id": template_id,
        "alert_source": alert_source,
        "parameters": opt_inputs,
        "timeframe": timeframe,
        "symbol": symbol,
        "bar_close_execution": True,
        "same_bar_priority": "STOP_LOSS_FIRST",
    }
    (output_dir / "strategy.json").write_text(json.dumps(strat_payload, indent=2), encoding="utf-8")

    # 4. risk-profile.json
    risk_payload = {
        "risk_snapshot_sha256": run.risk_snapshot_sha256,
        "capital_basis": "COST_BASIS_NOT_MARK_TO_MARKET",
        "spot_long_only": True,
        "requested_risk_percent": str(risk_profile.requested_risk_percent),
        "max_risk_percent": str(risk_profile.max_risk_percent),

        "reduce_only_exits": True,
    }
    (output_dir / "risk-profile.json").write_text(json.dumps(risk_payload, indent=2), encoding="utf-8")

    # 5. setup.md
    setup_md = _generate_setup_guide_md(alert_source, strategy_def.strategy_id, "BTCUSDT", "binance-global")
    (output_dir / "setup.md").write_text(setup_md, encoding="utf-8")

    # 6. validation.html
    val_html = _generate_validation_html(candidate, strategy_def.strategy_id, alert_source)
    (output_dir / "validation.html").write_text(val_html, encoding="utf-8")

    export_id = f"export_{run.run_id}_{alert_source}"
    return ExportMetadata(
        export_id=export_id,
        run=run,
        alert_source=alert_source,
        state="DRAFT",
    )
