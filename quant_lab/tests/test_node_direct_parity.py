import json
import os
import subprocess
from decimal import Decimal

from robot_quant.risk_evaluator import (
    RiskContext,
    RiskPolicy,
    evaluate_risk,
)


def eval_node(signal, context_dict):
    js_code = """
import { evaluateRisk } from './src/postgres/risk.js';

const signal = JSON.parse(process.argv[1]);
const contextRaw = JSON.parse(process.argv[2]);

const context = {
    policy: contextRaw.policy,
    daily: contextRaw.daily,
    position: contextRaw.position,
    now: contextRaw.now,
    equity: contextRaw.equity,
    balance: contextRaw.balance,
    cashAvailable: contextRaw.cashAvailable,
    committedNotional: contextRaw.committedNotional,
    reservedNotional: contextRaw.reservedNotional,
    reservedTrades: contextRaw.reservedTrades,
    openPositions: contextRaw.openPositions,
    licensed: contextRaw.licensed,
    globalKill: contextRaw.globalKill,
    hasPendingOrder: contextRaw.hasPendingOrder,
    targetAllocation: contextRaw.targetAllocation,
};

const res = evaluateRisk(signal, context);
console.log(JSON.stringify(res));
"""
    repo_root = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
    cmd = ["node", "--input-type=module", "-e", js_code, json.dumps(signal), json.dumps(context_dict)]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=True, cwd=repo_root)
    return json.loads(proc.stdout)

def test_node_direct_parity():
    signal = {
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "referencePrice": "60000",
        "stopLoss": "59000",
        "takeProfit": "62000",
        "riskMode": "PERCENT_EQUITY",
        "riskValue": "1.0",
        "timestamp": 1700000000000,
        "volatilityPercent": 2.0,
        "newsRisk": False,
        "leverage": 1,
    }

    context_dict = {
        "policy": {
            "killSwitch": False,
            "maxSignalAgeSeconds": 120,
            "maxTradesPerDay": 10,
            "maxDailyLossR": "5",
            "pauseAfterLossStreak": 3,
            "blockHighVolatility": True,
            "maxVolatilityPercent": 5.0,
            "blockDuringNews": True,
            "maxOpenPositions": 5,
            "onePositionPerSymbol": False,
            "maxRiskPercent": "100",
            "maxOrderNotional": "10000",
            "maxDailyNotional": "100000",
            "capPercentEquitySize": True,
        },
        "daily": {"trades": 0, "notional": "0", "realized_r": "0", "loss_streak": 0},
        "position": {"quantity": "0"},
        "now": 1700000000000,
        "equity": "10000",
        "balance": "10000",
        "licensed": True,
    }

    python_context = RiskContext(
        policy=RiskPolicy(
            kill_switch=False,
            max_signal_age_seconds=120,
            max_trades_per_day=10,
            max_daily_loss_r=Decimal("5"),
            pause_after_loss_streak=3,
            block_high_volatility=True,
            max_volatility_percent=5.0,
            block_during_news=True,
            max_open_positions=5,
            one_position_per_symbol=False,
            max_risk_percent=Decimal("100"),
            max_order_notional=Decimal("10000"),
            max_daily_notional=Decimal("100000"),
            cap_percent_equity_size=True,
        ),
        now=1700000000000,
        equity=Decimal("10000"),
        balance=Decimal("10000"),
        licensed=True,
    )

    node_res = eval_node(signal, context_dict)
    py_res = evaluate_risk(signal, python_context)
    
    print("Node result:", node_res)
    print("Py result:", py_res)
    
    assert node_res["ok"] == py_res.ok
    assert Decimal(node_res["order"]["quantity"]) == Decimal(py_res.order["quantity"])
    assert Decimal(node_res["order"]["notional"]) == Decimal(py_res.order["notional"])
    
    print("SUCCESS: Parity between Python and Node matched exactly.")

if __name__ == "__main__":
    test_node_direct_parity()
