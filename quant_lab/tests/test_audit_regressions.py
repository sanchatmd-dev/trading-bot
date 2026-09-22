import json
from decimal import Decimal
from pathlib import Path
from tempfile import TemporaryDirectory

import pytest

from robot_quant.backtest import BacktestConfig, BacktestEngine
from robot_quant.contracts import OptimizationRun, RiskProfile, Scope, StrategyDefinition
from robot_quant.exporter import apply_input_preset, export_package
from robot_quant.market_data import Candle
from robot_quant.optimizer import CandidateEvaluation
from robot_quant.records import SignalRecord
from robot_quant.strategy import StrategySignal


def test_export_package_rejects_failed_candidates():
    run = OptimizationRun(
        run_id="audit", dataset_sha256="a" * 64, dependency_lock_sha256="b" * 64,
        risk_snapshot_sha256="c" * 64,
        strategy=StrategyDefinition(strategy_id="audit", version=1,
            template_id="synthetic-ema-v1", source_sha256="d" * 64,
            alert_source="alert_calls", parameters=()),
        seed=1, search_budget=1, objective="net_return",
        train_end=1, validation_end=2, test_end=3,
    )
    scope = Scope(owner_id="owner", bot_id="bot", account_id="paper", broker="binance-global", currency="USDT")
    profile = RiskProfile(
        risk_profile_id="risk", version=1, scope=scope, effective_at=0,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET", initial_capital="1000",
        balance="100", max_risk_percent="100", requested_risk_percent="100",
        max_order_notional="1000", max_daily_notional="1000"
    )
    # Mock the digest to match the run
    run = run.model_copy(update={"risk_snapshot_sha256": profile.digest()})

    with TemporaryDirectory(prefix="robot-audit-") as temporary:
        target = Path(temporary)
        rejected = CandidateEvaluation(params={"ema_fast": "-5"}, passed_all_gates=False, status="REJECTED_BOUNDS")
        with pytest.raises(ValueError, match="Cannot export rejected candidate"):
            export_package(run, rejected, "alert_calls", target, risk_profile=profile, symbol="BTCUSDT")


def test_export_package_injects_risk_profile_and_metadata():
    scope = Scope(owner_id="owner", bot_id="bot", account_id="paper", broker="binance-global", currency="USDT")
    profile = RiskProfile(
        risk_profile_id="risk", version=1, scope=scope, effective_at=0,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET", initial_capital="1000",
        balance="100", max_risk_percent="100", requested_risk_percent="15.5",  # Non-default risk
        max_order_notional="1000", max_daily_notional="1000"
    )
    run = OptimizationRun(
        run_id="audit", dataset_sha256="a" * 64, dependency_lock_sha256="b" * 64,
        risk_snapshot_sha256=profile.digest(),
        strategy=StrategyDefinition(strategy_id="audit", version=1,
            template_id="synthetic-ema-v1", source_sha256="d" * 64,
            alert_source="alert_calls", parameters=()),
        seed=1, search_budget=1, objective="net_return",
        train_end=1, validation_end=2, test_end=3,
    )

    with TemporaryDirectory(prefix="robot-audit-") as temporary:
        target = Path(temporary)
        accepted = CandidateEvaluation(params={"ema_fast": "9"}, passed_all_gates=True, status="ACCEPTED")
        export_package(run, accepted, "alert_calls", target, risk_profile=profile, symbol="ETHUSDT", timeframe="4h")
        
        pine = (target / "strategy.pine").read_text(encoding="utf-8")
        risk = json.loads((target / "risk-profile.json").read_text(encoding="utf-8"))
        strat = json.loads((target / "strategy.json").read_text(encoding="utf-8"))

        assert risk["requested_risk_percent"] == "15.5"
        assert strat["symbol"] == "ETHUSDT"
        assert strat["timeframe"] == "4h"
        
        assert 'input.float(15.5, "Risk Value (% Equity)")' in pine
        assert 'input.string("ETHUSDT", "Symbol")' in pine
        assert 'strategy_id' in pine
        assert 'deployment_id' in pine


def test_apply_input_preset_booleans():
    patched = apply_input_preset('x = input.bool(false, "Flag")\n', {"x": True})
    assert "input.bool(true," in patched  # Pine uses lowercase booleans
    
    source = 'x = input.int(\n  9, "Period")\n'
    patched_multi = apply_input_preset(source, {"x": 12})
    assert "input.int(12," in patched_multi


def test_research_record_accepts_filled():
    # Should not raise ValidationError
    record = SignalRecord(
        id=1, trade_id="audit", user_id="bot", received_at=1, signal_time=1,
        broker="binance-global", symbol="BTCUSDT", event="BUY", side="BUY",
        status="FILLED"
    )
    assert record.status == "FILLED"


def test_backtest_cash_initializes_from_balance():
    scope = Scope(owner_id="owner", bot_id="bot", account_id="paper", broker="binance-global", currency="USDT")
    profile = RiskProfile(
        risk_profile_id="risk", version=1, scope=scope, effective_at=0,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET", initial_capital="1000",
        balance="150", max_risk_percent="100", requested_risk_percent="1",
        max_order_notional="1000", max_daily_notional="1000"
    )
    config = BacktestConfig.from_risk_profile(profile)
    assert config.initial_capital == Decimal("1000")
    assert config.balance == Decimal("150")
    
    # We can inject a dummy run to check if cash is 150
    engine = BacktestEngine(config)
    class DummyStrategy:
        def evaluate_signals(self, _): return []
    dummy_candles = [Candle(1700000000000, Decimal("100"), Decimal("110"), Decimal("90"), Decimal("100"), Decimal("1"))]
    res = engine.run(dummy_candles, DummyStrategy())
    # The final cash should equal the starting balance if no trades occurred
    assert res.final_cash == Decimal("150")


def test_intrabar_sl_suppresses_pending_entry():
    candles = [
        Candle(1700000000000 + i * 60000, Decimal("100"), Decimal("110"), Decimal("90"), Decimal("100"), Decimal("1")) 
        for i in range(3)
    ]
    class Sequence:
        def evaluate_signals(self, _):
            return [
                StrategySignal(0, candles[0].timestamp, "BUY", Decimal("100"), stop_loss=Decimal("95")),
                StrategySignal(1, candles[1].timestamp, "SL", Decimal("95"))
            ]
    result = BacktestEngine(BacktestConfig()).run(candles, Sequence())
    # Should process the trade because backtest was patched to prioritize exit over entry correctly?
    # Actually wait. If the SL triggers on the SAME bar as a pending BUY. Let's see if 1 fill or 0 fills.
    # Previous defect was that the pending BUY was dropped entirely (zero fills).
    # We want it to fill the BUY, then immediately hit the SL.
    assert len(result.signals) == 2
    assert result.signals[0].side == "BUY"
    assert result.signals[1].side == "SELL"


def test_quote_sized_exit_bounds():
    from robot_quant.risk_evaluator import (
        PositionState,
        RiskContext,
        RiskPolicy,
        TargetAllocationState,
        evaluate_risk,
    )
    signal = dict(broker="binance-global", symbol="BTCUSDT", side="SELL", event="TP",
                  reduceOnly=True, leverage=1, timestamp=1700000000000,
                  referencePrice="100", targetTradeId="P1", riskMode="QUANTITY", quantity="5")
    python_result = evaluate_risk(signal, RiskContext(policy=RiskPolicy(),
        position=PositionState(Decimal("3")), target_allocation=TargetAllocationState(Decimal("1")), now=1700000000000))
    assert Decimal(python_result.order["quantity"]) == Decimal("1")
    assert "sizingAdjustment" in python_result.order
