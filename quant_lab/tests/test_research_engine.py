from dataclasses import replace
from types import SimpleNamespace

import pytest

from robot_quant import research_engine
from robot_quant.spt_custom_evaluator import CustomSignalInputs


def contract():
    rows = [dict(time=1800000000000 + i * 60000, open="100", high="101", low="99", close="100", volume="1", atr14="7") for i in range(50)]
    return dict(version="ql3a-research-job-v1", scope="SPT_CUSTOM_ENGINEERING_ONLY", source="synthetic", snapshot={"policy": {}, "market": {"broker": "binance-global", "symbol": "BTCUSDT"}}, input_lock={"baseline": {"atrLenInput": 14, "atr_multiplier": 60, "rr": 1.5}, "domains": {"atrLenInput": [12, 14, 16], "atr_multiplier": [40, 60, 80], "rr": [1, 1.5, 2]}}, split={"warmup": 14, "train_end": 30, "validation_end": 40, "test_end": 50}, dataset={"bars": rows}, model={"price_tick": .01, "quantity_step": .001, "fee_bps": 10, "slippage_bps": 1, "risk_percent": 1, "version": "paper-close-v1"}, capital={"cash": 1000, "equity": 1000}, deployment_id="synthetic")


def request_for(frozen, parameters, kind):
    calculation = {**frozen, "dataset": {"bars": frozen["dataset"]["bars"] if kind == "HOLDOUT" else frozen["dataset"]["bars"][:40]}}
    return {"contract": calculation, "parameters": parameters, "kind": kind}


@pytest.fixture
def calculations(monkeypatch):
    # Isolate IPC/split/model behavior; source identity acceptance is tested separately.
    plan = SimpleNamespace(domains={"atrLenInput": (12, 16, 2)}, candidate=lambda changes: replace(CustomSignalInputs(), atr_len=changes.get("atrLenInput", 14)))
    monkeypatch.setattr(research_engine.CustomOptimizationPlan, "from_snapshot", lambda *_: plan)
    calls = []

    def replay(bars, **kwargs):
        calls.append((bars, kwargs))
        return {"fills": [], "decisions": []}

    monkeypatch.setattr(research_engine, "paper_replay", replay)
    return calls


def test_candidates_hide_holdout_and_source_atr_never_changes_bridge_atr(calculations):
    frozen = contract()
    for length in [12, 16]:
        result = research_engine.evaluate(request_for(frozen, {"atrLenInput": length, "atr_multiplier": 60, "rr": 1.5}, "CANDIDATE"))
        assert "test" not in result
        assert result["owner_recommendation_ready"] is False
        assert len(calculations[-1][0]) == 40
        assert all(bar.atr14 == 7 for bar, _, _ in calculations[-1][0])
    assert frozen["dataset"]["bars"][40]["time"] > calculations[-1][0][-1][0].time


def test_holdout_and_doubled_cost_stress(calculations):
    frozen = contract()
    request = request_for(frozen, frozen["input_lock"]["baseline"], "HOLDOUT")
    assert "test" in research_engine.evaluate(request)
    assert len(calculations[-1][0]) == 50
    request = request_for(frozen, frozen["input_lock"]["baseline"], "STRESS")
    assert "test" not in research_engine.evaluate(request)
    assert calculations[-1][1]["model"].fee_bps == 20
    assert calculations[-1][1]["model"].slippage_bps == 2


def test_locked_dimensions_and_grid_fail_closed(calculations):
    frozen = contract()
    for parameters in [{"atrLenInput": 15, "atr_multiplier": 60, "rr": 1.5}, {"atrLenInput": 14, "atr_multiplier": 60, "rr": 1.5, "fixed": 1}, {"atrLenInput": True, "atr_multiplier": 60, "rr": 1.5}]:
        with pytest.raises(ValueError):
            research_engine.evaluate(request_for(frozen, parameters, "CANDIDATE"))
