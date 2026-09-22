"""Tests for QL-4B Pine Script exporter and deployment packaging engine."""

import json
from pathlib import Path

import pytest

from robot_quant.contracts import (
    OptimizationRun,
    ParameterBounds,
    StrategyDefinition,
)
from robot_quant.exporter import (
    apply_input_preset,
    export_package,
    generate_input_diff,
)
from robot_quant.optimizer import CandidateEvaluation


def _sample_run(alert_source: str = "alert_calls") -> OptimizationRun:
    strategy_def = StrategyDefinition(
        strategy_id="strat-test",
        version=1,
        template_id="synthetic-ema-v1",
        source_sha256="a" * 64,
        alert_source=alert_source,
        parameters=(
            ParameterBounds(
                name="ema_fast", unit="bars", minimum="5", maximum="15", step="1", default="9"
            ),
            ParameterBounds(
                name="ema_slow", unit="bars", minimum="20", maximum="30", step="1", default="21"
            ),
            ParameterBounds(
                name="atr_period", unit="bars", minimum="10", maximum="20", step="1", default="14"
            ),
            ParameterBounds(
                name="atr_multiplier",
                unit="multiplier",
                minimum="1.0",
                maximum="3.0",
                step="0.5",
                default="2.0",
            ),
        ),
    )
    return OptimizationRun(
        run_id="run-opt-101",
        dataset_sha256="d" * 64,
        dependency_lock_sha256="b" * 64,
        risk_snapshot_sha256="c" * 64,
        strategy=strategy_def,
        seed=42,
        search_budget=10,
        objective="net_return",
        train_end=50,
        validation_end=75,
        test_end=100,
    )


def test_export_package_alert_calls(tmp_path):
    """Verify export package generation with alert_calls source."""
    run = _sample_run(alert_source="alert_calls")
    candidate = CandidateEvaluation(
        params={"ema_fast": "12", "ema_slow": "26", "atr_period": "14", "atr_multiplier": "2.5"},
        in_sample_return=15.0,
        val_return=12.5,
        test_return=10.2,
        val_profit_factor=1.85,
        val_max_drawdown=4.2,
        sensitivity_score=11.0,
        stress_return=7.5,
        passed_sensitivity=True,
        passed_stress=True,
        passed_all_gates=True,
        status="ACCEPTED",
    )

    out_dir = tmp_path / "export_calls"
    meta = export_package(run, candidate, "alert_calls", out_dir)

    assert meta.alert_source == "alert_calls"
    assert meta.export_id == "export_run-opt-101_alert_calls"

    # Check 6 artifacts
    inputs_file = out_dir / "inputs.json"
    pine_file = out_dir / "strategy.pine"
    strat_file = out_dir / "strategy.json"
    risk_file = out_dir / "risk-profile.json"
    setup_file = out_dir / "setup.md"
    val_file = out_dir / "validation.html"

    assert inputs_file.exists()
    assert pine_file.exists()
    assert strat_file.exists()
    assert risk_file.exists()
    assert setup_file.exists()
    assert val_file.exists()

    # Verify inputs.json contents
    inputs_data = json.loads(inputs_file.read_text(encoding="utf-8"))
    assert inputs_data["optimized_inputs"]["ema_fast"] == "12"
    assert inputs_data["original_inputs"]["ema_fast"] == "9"
    assert inputs_data["run_id"] == "run-opt-101"

    # Verify strategy.pine (alert_calls mode)
    pine_code = pine_file.read_text(encoding="utf-8")
    assert "//@version=6" in pine_code
    assert "indicator(" in pine_code
    assert "alert(" in pine_code
    assert "alert.freq_once_per_bar_close" in pine_code
    assert "rtEntryIds" in pine_code
    assert "target_trade_id" in pine_code

    # Verify setup.md (bilingual instructions)
    setup_text = setup_file.read_text(encoding="utf-8")
    assert "alert() function calls only" in setup_text
    assert "คู่มือการตั้งค่า" in setup_text
    assert "TradingView Setup Guide" in setup_text


def test_export_package_order_fills(tmp_path):
    """Verify export package generation with order_fills source."""
    run = _sample_run(alert_source="order_fills")
    candidate = CandidateEvaluation(
        params={"ema_fast": "11", "ema_slow": "25", "atr_period": "14", "atr_multiplier": "2.0"},
        passed_all_gates=True,
    )

    out_dir = tmp_path / "export_fills"
    meta = export_package(run, candidate, "order_fills", out_dir)

    assert meta.alert_source == "order_fills"

    pine_code = (out_dir / "strategy.pine").read_text(encoding="utf-8")
    assert "strategy(" in pine_code
    assert "strategy.entry(" in pine_code
    assert "strategy.exit(" in pine_code
    assert "alert_message=" in pine_code

    setup_text = (out_dir / "setup.md").read_text(encoding="utf-8")
    assert "Order fills only" in setup_text
    assert "{{strategy.order.alert_message}}" in setup_text


def test_export_source_mismatch_raises(tmp_path):
    """Verify ValueError when export alert_source does not match strategy definition."""
    run = _sample_run(alert_source="alert_calls")
    candidate = CandidateEvaluation(params={"ema_fast": "12", "ema_slow": "26"})

    with pytest.raises(ValueError, match="must match evaluated strategy"):
        export_package(run, candidate, "order_fills", tmp_path / "mismatch")


def test_apply_input_preset_and_diff():
    """Verify that apply_input_preset modifies only input defaults and preserves formulas."""
    original = """//@version=6
indicator("Test Indicator", overlay=true)

int emaFast = input.int(9, "Fast EMA", minval=1)
int emaSlow = input.int(21, "Slow EMA", minval=1)
float atrMult = input.float(2.0, "ATR Multiplier", step=0.1)

// Calculations
float ma1 = ta.ema(close, emaFast)
float ma2 = ta.ema(close, emaSlow)
plot(ma1)
plot(ma2)
"""
    updated = apply_input_preset(original, {"emaFast": 14, "atrMult": 2.8})
    assert 'int emaFast = input.int(14, "Fast EMA", minval=1)' in updated
    assert 'float atrMult = input.float(2.8, "ATR Multiplier", step=0.1)' in updated
    assert 'int emaSlow = input.int(21, "Slow EMA", minval=1)' in updated
    assert "float ma1 = ta.ema(close, emaFast)" in updated

    diff = generate_input_diff(original, updated)
    assert "-int emaFast = input.int(9, " in diff
    assert "+int emaFast = input.int(14, " in diff
    assert "-float atrMult = input.float(2.0, " in diff
    changed = [
        line_text
        for line_text in diff.splitlines()
        if line_text.startswith(("+", "-")) and not line_text.startswith(("+++", "---"))
    ]
    assert not any("ta.ema" in line_text for line_text in changed)  # Indicator math untouched!


def test_apply_input_preset_on_spt_indicator():
    """Verify input preset on real SPT indicator preserves logic."""
    spt_path = Path(__file__).resolve().parents[2] / "tradingview" / "spt_pro_v4_robot_trade.pine"
    if spt_path.exists():
        content = spt_path.read_text(encoding="utf-8")
        updated = apply_input_preset(content, {"rtRisk": 1.5, "rtNews": True})
        assert "rtRisk = input.float(1.5," in updated
        assert "rtNews = input.bool(True," in updated or "rtNews = input.bool(true," in updated
        diff = generate_input_diff(content, updated)
        changed = [
            line_text
            for line_text in diff.splitlines()
            if line_text.startswith(("+", "-")) and not line_text.startswith(("+++", "---"))
        ]
        assert not any("supertrend(" in line_text for line_text in changed)
