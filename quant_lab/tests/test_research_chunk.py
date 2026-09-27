"""True SPT state, Paper reference and JSON restart parity on offline fixtures."""
import copy
import json
import math
import subprocess
from dataclasses import asdict
from decimal import Decimal

import pytest

from robot_quant import research_chunk, research_engine
from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.paper_state import PaperState
from robot_quant.ql3a import mark_period
from robot_quant.spt_custom_evaluator import (
    CATALOG,
    CustomOptimizationPlan,
    CustomSignalInputs,
    SptCustomEvaluator,
)


def policy(**changes):
    result = dict(killSwitch=False, maxSignalAgeSeconds=120, maxTradesPerDay=10000,
        maxDailyLossR=10000, pauseAfterLossStreak=10000, blockHighVolatility=False,
        maxVolatilityPercent=100, blockDuringNews=False, allowedSymbols=["BTCUSDT"],
        sideMode="BOTH", maxOpenPositions=5, onePositionPerSymbol=False,
        capPercentEquitySize=True, maxRiskPercent=100, maxOrderNotional=10000,
        maxDailyNotional=10000000)
    return {**result, **changes}


def fixture():
    # Start before midnight so all continuations include a UTC day boundary.
    first_time = 1799970600000
    rows = []
    previous = 100.0
    for i in range(720):
        close = 100 + 12 * math.sin(i / 23) + 2 * math.sin(i / 3)
        rows.append(dict(time=first_time + i * 60000, open=str(previous),
            high=str(max(previous, close) + 1.2), low=str(min(previous, close) - 1.2),
            close=str(close), volume="1", atr14="2.75"))
        previous = close
    inputs = CustomSignalInputs(ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2,
        zone_atr_mult=2.5, setup_expiry=8, cooldown=2, confirm_lookback=3)
    selected = list(CATALOG)[:8]
    baseline = {name: getattr(inputs, CATALOG[name][0]) for name in selected}
    baseline.update(atr_multiplier=1.0, rr=1.0)
    domains = {name: [value] for name, value in baseline.items()}
    for name in selected:
        value = baseline[name]
        domains[name].append(value + (1 if isinstance(value, int) else .1))
    contract = dict(version="ql3a-research-job-v1", scope="SPT_CUSTOM_ENGINEERING_ONLY",
        source="fixture", snapshot={"policy": policy(), "market": {"broker": "binance-global", "symbol": "BTCUSDT"}},
        engine_hash="a" * 64, baseline_snapshot_hash="b" * 64,
        input_lock={"baseline": baseline, "domains": domains},
        split={"warmup": 10, "train_end": 380, "validation_end": 720, "test_end": 800},
        dataset={"sha256": "c" * 64, "first_time": first_time},
        model={"price_tick": .01, "quantity_step": .00001, "fee_bps": 10, "slippage_bps": 1, "risk_percent": 1, "version": "paper-close-v1"},
        capital={"cash": 1000, "equity": 1000}, deployment_id="fixture")
    return contract, rows, inputs, selected


@pytest.fixture
def actual_calculation(monkeypatch):
    contract, rows, inputs, selected = fixture()
    plan = CustomOptimizationPlan(inputs, {name: (contract["input_lock"]["domains"][name][0], contract["input_lock"]["domains"][name][-1], 1 if isinstance(contract["input_lock"]["baseline"][name], int) else .1) for name in selected})
    # Only isolate source/snapshot enrollment. SPT, Bridge, Risk, ledger and metrics are real.
    monkeypatch.setattr(CustomOptimizationPlan, "from_snapshot", lambda *_: plan)
    return contract, rows, inputs, selected


def run_chunks(contract, rows, parameters, size, kind="CANDIDATE"):
    state = None
    trace = []
    for start in range(0, len(rows), size):
        response = research_chunk.evaluate_chunk(dict(contract=contract, parameters=parameters,
            kind=kind, rows=rows[start:start + size], checkpoint=state), trace=trace)
        state = json.loads(json.dumps(response["checkpoint"], allow_nan=False))
        assert state["next_bar"] == min(start + size, len(rows))
        assert len(research_chunk.canonical(state)) < research_chunk.STATE_LIMIT
    return response["result"], trace, state


@pytest.mark.parametrize("size", [1, 6, 7, 11, 109, 380, 719])
def test_real_spt_json_restart_equals_uninterrupted_reference(actual_calculation, size):
    contract, rows, _, _ = actual_calculation
    parameters = contract["input_lock"]["baseline"]
    expected = research_engine.evaluate(dict(contract={**contract, "dataset": {"bars": rows}}, parameters=parameters, kind="CANDIDATE"))
    result, trace, state = run_chunks(contract, rows, parameters, size)
    assert result == expected
    assert result["fills"] > 0
    assert sum(t["signal"]["buy"] for t in trace) > 0
    assert sum(t["signal"]["native_exit"] for t in trace) > 0
    uninterrupted, direct_trace, direct_state = run_chunks(contract, rows, parameters, len(rows))
    assert trace == direct_trace
    assert state == direct_state
    assert uninterrupted == result


@pytest.mark.parametrize("axis", range(8))
@pytest.mark.parametrize("kind", ["CANDIDATE", "STRESS"])
def test_eight_real_inputs_and_frozen_bridge_atr(actual_calculation, axis, kind):
    contract, rows, inputs, selected = actual_calculation
    parameters = dict(contract["input_lock"]["baseline"])
    name = selected[axis]
    parameters[name] = contract["input_lock"]["domains"][name][-1]
    result, trace, state = run_chunks(contract, rows, parameters, 37, kind)
    expected = research_engine.evaluate(dict(contract={**contract, "dataset": {"bars": rows}}, parameters=parameters, kind=kind))
    assert result == expected
    evaluator = SptCustomEvaluator(inputs.candidate(selected, {k: parameters[k] for k in selected}))
    assert [t["signal"] for t in trace] == [asdict(evaluator.step(*(float(r[k]) for k in ("open", "high", "low", "close")))) for r in rows]
    assert state["evaluator"]["index"] == len(rows) - 1
    assert "rows" not in state and "bars" not in state


@pytest.mark.parametrize("changes", [{}, {"killSwitch": True}, {"maxTradesPerDay": 2}, {"maxDailyLossR": .01}, {"pauseAfterLossStreak": 1}])
def test_paper_bridge_sl_tp_native_rejection_guards_and_midnight(changes):
    first = 1800057540000  # 23:59 UTC.
    prices = [100, 101, 106, 100, 94, 100, 100, 100, 100, 94, 100, 106]
    bars = [(BridgeBar(first + i * 60000, Decimal(p), Decimal(p + 1), Decimal(p - 1), Decimal(p), Decimal(1), Decimal(2)), i in (0, 3, 5, 8, 10), i == 7) for i, p in enumerate(prices)]
    common = dict(deployment_id="fixture", multiplier=Decimal(1), rr=Decimal(1), model=PaperModel(), policy=policy(**changes), equity=Decimal(1000), cash=Decimal(1000), broker="binance-global", symbol="BTCUSDT")
    reference = paper_replay(bars, **common)
    state = PaperState(**common)
    actual = {"events": [], "decisions": [], "fills": []}
    metrics = research_chunk.StreamingMetrics(Decimal(1000), {"warmup": 1, "train_end": 6, "validation_end": 12, "test_end": 13})
    for i, (bar, buy, exit_) in enumerate(bars):
        step = state.step(bar, buy, exit_)
        metrics.step(i, bar, step["fills"])
        for key in actual:
            actual[key].extend(step[key])
        exported = json.loads(json.dumps(state.export_state()))
        state = PaperState(**common)
        state.import_state(exported)
        saved_metrics = json.loads(json.dumps(metrics.export_state()))
        metrics = research_chunk.StreamingMetrics(Decimal(1000), {"warmup": 1, "train_end": 6, "validation_end": 12, "test_end": 13})
        metrics.import_state(saved_metrics, i + 1)
    for key in actual:
        assert actual[key] == reference[key]
    assert metrics.result("train") == mark_period(bars, reference["fills"], 1, 6, Decimal(1000))
    assert metrics.result("validation") == mark_period(bars, reference["fills"], 6, 12, Decimal(1000))
    if not changes:
        assert {f["reason"] for f in actual["fills"] if f["event_type"] == "EXIT"} >= {"SL", "TP", "NATIVE"}


def test_resume_and_input_validation_fail_closed(actual_calculation):
    contract, rows, _, _ = actual_calculation
    parameters = contract["input_lock"]["baseline"]
    base = dict(contract=contract, parameters=parameters, kind="CANDIDATE", rows=rows[:8], checkpoint=None)
    state = research_chunk.evaluate_chunk(base)["checkpoint"]
    resume = {**base, "rows": rows[8:10], "checkpoint": state}
    untouched = copy.deepcopy(state)
    assert research_chunk.evaluate_chunk(resume)["checkpoint"]["next_bar"] == 10
    assert state == untouched
    for change in ({"rows": rows[9:11]}, {"rows": rows[7:9]}, {"rows": []},
                   {"kind": "STRESS"}, {"contract": {**contract, "engine_hash": "d" * 64}},
                   {"contract": {**contract, "baseline_snapshot_hash": "d" * 64}},
                   {"contract": {**contract, "dataset": {**contract["dataset"], "sha256": "d" * 64}}}):
        with pytest.raises(ValueError):
            research_chunk.evaluate_chunk({**resume, **change})
    damaged = copy.deepcopy(state)
    damaged["paper"]["cash"] = "NaN"
    damaged["integrity"] = research_chunk.digest({k: v for k, v in damaged.items() if k != "integrity"})
    with pytest.raises(ValueError):
        research_chunk.evaluate_chunk({**resume, "checkpoint": damaged})
    with pytest.raises(ValueError):
        research_chunk.evaluate_chunk({**base, "rows": rows + rows[:1]})


def node_roundtrip(value):
    result = subprocess.run(["node", "--input-type=module", "-e", "let input='';for await(const chunk of process.stdin)input+=chunk;process.stdout.write(JSON.stringify(JSON.parse(input)));"], input=json.dumps(value, allow_nan=False).encode(), capture_output=True)
    # Keep JavaScript syntax errors visible in the offline regression.
    assert result.returncode == 0, result.stderr.decode()
    return json.loads(result.stdout)


def test_node_json_checkpoint_roundtrip_preserves_integrity_and_exact_result(actual_calculation):
    contract, rows, _, _ = actual_calculation
    parameters = contract["input_lock"]["baseline"]
    expected, expected_trace, _ = run_chunks(contract, rows, parameters, len(rows))
    checkpoint = None
    trace = []
    for start in range(0, len(rows), 109):
        response = research_chunk.evaluate_chunk(dict(contract=contract, parameters=parameters,
            kind="CANDIDATE", rows=rows[start:start + 109], checkpoint=checkpoint), trace=trace)
        checkpoint = node_roundtrip(response["checkpoint"])
        assert checkpoint == response["checkpoint"]
        assert checkpoint["integrity"] == research_chunk.digest({k: v for k, v in checkpoint.items() if k != "integrity"})
    assert response["result"] == expected
    assert trace == expected_trace


def test_float_state_encoding_survives_node_integral_signed_zero_and_exponents():
    inputs = CustomSignalInputs()
    evaluator = SptCustomEvaluator(inputs)
    evaluator.step(100.0, 101.0, 99.0, 100.0)
    # These exact floating states exercise JSON representation differences.
    evaluator.fast = 100.0
    evaluator.slow = -0.0
    evaluator.highs = [1e-10]
    evaluator.lows = [1e20]
    frozen = research_chunk.export_evaluator(evaluator)
    assert frozen["fast"] == "100.0" and frozen["slow"] == "-0.0"
    restored = SptCustomEvaluator(inputs)
    transported = node_roundtrip(frozen)
    research_chunk.import_evaluator(restored, transported, 1)
    assert research_chunk.export_evaluator(restored) == frozen
    assert math.copysign(1, restored.slow) == -1
    for malformed in [100.0, "NaN", "Infinity", "100", " 100.0"]:
        bad = {**frozen, "fast": malformed}
        with pytest.raises(ValueError):
            research_chunk.import_evaluator(SptCustomEvaluator(inputs), bad, 1)
