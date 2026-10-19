"""Fixed-input evaluator: hand-derived ledger values on scripted bars.

Scripted ``(BridgeBar, buy, native_exit)`` bars drive the real Paper engine, so the
expected numbers below are worked by hand from the engine rules, not copied from a
run. Shared setup: cash 10000, tick 0.01, quantity step 0.001, fee 10 bps,
slippage 10 bps, risk 1 percent. A BUY at close 100 with ATR 1, multiplier 2 and
rr 1.5 gives:
  fill price  100 x 1.001 = 100.10 (already on the tick)
  stop        100 - 2 = 98.00, target 100 + 3 = 103.00
  raw size    10000 x 1 percent / (100.10 - 98.00) = 100 / 2.10 = 47.6190476..., step 47.619
  notional    47.619 x 100.10 = 4766.6619, fee 0.1 percent = 4.7666619
  slippage    |100.10 - 100.00| x 47.619 = 4.7619
"""

import copy
import io
import json
import math
import subprocess
import sys
from decimal import Decimal, localcontext
from pathlib import Path
from types import SimpleNamespace

import pytest

from robot_quant import fixed_eval, research_engine
from robot_quant.bridge_paper import node_policy, paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.fixed_eval import evaluate_fixed, evaluate_fixed_bars
from robot_quant.ql3a import mark_period
from robot_quant.spt_custom_evaluator import CustomSignalInputs, bridge_bars, evaluate_bars

MINUTE = 60000
T0 = 1_800_000_000_000  # Open time of bar 0; engine time of bar i is T0 + (i + 1) * MINUTE.


def open_ms(index):
    return T0 + index * MINUTE


POLICY = dict(
    killSwitch=False,
    maxSignalAgeSeconds=120,
    maxTradesPerDay=100,
    maxDailyLossR=10000,
    pauseAfterLossStreak=10000,
    blockHighVolatility=False,
    maxVolatilityPercent=100,
    blockDuringNews=False,
    allowedSymbols=["BTCUSDT"],
    sideMode="BOTH",
    maxOpenPositions=2,
    onePositionPerSymbol=False,
    capPercentEquitySize=True,
    maxRiskPercent=100,
    maxOrderNotional=10000,
    maxDailyNotional=10000000,
)
MODEL = dict(
    price_tick="0.01", quantity_step="0.001", fee_bps="10", slippage_bps="10", risk_percent="1"
)
CONTRACT = dict(
    model=MODEL,
    policy=POLICY,
    initial_cash="10000",
    initial_equity="10000",
    broker="binance-global",
    symbol="BTCUSDT",
    deployment_id="fe1",
    engine_hash="e" * 64,
    dataset_sha256="d" * 64,
    parent_run_id="run-parent",
    selection_id="sel-1",
)
BRIDGE = dict(atr_multiplier="2", rr="1.5")
SPLIT_A = dict(warmup=1, end=4)


def bar(index, close, high=None, low=None, buy=False):
    close = Decimal(close)
    high = Decimal(high) if high is not None else close + Decimal("0.5")
    low = Decimal(low) if low is not None else close - Decimal("0.5")
    item = BridgeBar(open_ms(index) + MINUTE, close, high, low, close, Decimal(1), Decimal(1))
    return (item, buy, False)


def scenario_open_at_end():
    # Bar 0 warm-up. Bar 1 BUY at 100. Bars 2 and 3 stay inside the 98..103 band.
    return [bar(0, "100"), bar(1, "100", buy=True), bar(2, "101"), bar(3, "102", "102.5", "101.5")]


def scenario_overlap():
    # Two BUYs (bars 1 and 2) both stopped out on bar 3: low 97 <= stop 98.
    return [
        bar(0, "100"),
        bar(1, "100", buy=True),
        bar(2, "100", buy=True),
        bar(3, "97.5", "98.4", "97"),
    ]


def run(bars, kind="EVALUATION", split=SPLIT_A, contract=CONTRACT, bridge=BRIDGE):
    return evaluate_fixed_bars(copy.deepcopy(contract), bridge, bars, kind, split)


def test_open_position_at_end_is_marked_not_liquidated():
    out = run(scenario_open_at_end())
    assert [(f["side"], f["bar_time_ms"]) for f in out["fills"]] == [("BUY", open_ms(1))]
    fill = out["fills"][0]
    assert (fill["quantity"], fill["price"], fill["fee"]) == (
        "47.619000000000000000",
        "100.100000000000000000",
        "4.766661900000000000",
    )
    assert fill["notional"] == "4766.661900000000000000"
    assert fill["slippage_cost_incl_tick"] == "4.761900000000000000"
    assert out["slippage_cost_incl_tick_total"] == "4.761900000000000000"
    assert out["fees_total"] == "4.766661900000000000"
    # Cash 10000 - 4766.6619 - 4.7666619 = 5228.5714381. Mark at 102: 47.619 x 102 = 4857.138.
    assert Decimal(out["metrics"]["end_equity"]) == Decimal("10085.7094381")
    assert Decimal(out["metrics"]["net_return_percent"]) == Decimal("0.857094381")
    # Lowest equity is the entry bar close 100: 5228.5714381 + 4761.9 = 9990.4714381.
    assert Decimal(out["metrics"]["max_drawdown_percent"]) == Decimal("0.095285619")
    assert out["metrics"]["bars"] == 3
    assert out["open_position"]["quantity"] == "47.619000000000000000"
    assert out["open_position"]["allocations"] == 1
    assert out["open_position"]["mark_close"] == "102"
    assert out["open_position"]["open_episode"] == {
        "open_bar_time_ms": open_ms(1),
        "allocations": 1,
    }
    assert out["episodes"] == {"completed_count": 0, "completed": []}
    assert out["closed_allocations"] == 0
    assert out["exposure"] == {"bars_in_market": 3, "bars": 3, "fraction": "1.000000000000000000"}
    assert out["rejected"] == {
        "total": 0,
        "intents_total": 0,
        "orphan_exits": {"warmup_entry": 0, "refused_entry": 0},
        "by_event_type_and_reason": [],
    }
    assert out["evaluator_closure"] == "NOT_IN_ENGINE_CLOSURE"
    assert out["metrics_precision"] == 80


def test_two_fills_on_one_bar_keep_engine_sequence():
    out = run(scenario_overlap())
    bar3 = [f for f in out["fills"] if f["bar_time_ms"] == open_ms(3)]
    assert [f["side"] for f in bar3] == ["SELL", "SELL"]
    # The engine walks entries newest first: the bar 2 allocation exits as sequence 0.
    assert [f["sequence"] for f in bar3] == [0, 1]
    assert [f["entry_ref"] for f in bar3] == [
        "fe1:%d:0" % (open_ms(2) + MINUTE),
        "fe1:%d:0" % (open_ms(1) + MINUTE),
    ]
    # Exit price 97.5 x 0.999 = 97.4025 rounds down to 97.40. 47.619 x 97.40 = 4638.0906, fee 4.6380906.
    assert {f["price"] for f in bar3} == {"97.400000000000000000"}
    assert {f["notional"] for f in bar3} == {"4638.090600000000000000"}
    # Both BUYs size identically: book equity stays 10000, cap budgets stay above 47.619 units.
    buys = [f for f in out["fills"] if f["side"] == "BUY"]
    assert [f["quantity"] for f in buys] == ["47.619000000000000000"] * 2
    # Fees 2 x 4.7666619 + 2 x 4.6380906 = 18.809505. Slippage 4 x 4.7619 = 19.0476.
    assert Decimal(out["fees_total"]) == Decimal("18.809505")
    assert Decimal(out["slippage_cost_incl_tick_total"]) == Decimal("19.0476")
    assert [Decimal(f["slippage_cost_incl_tick"]) for f in out["fills"]] == [Decimal("4.7619")] * 4
    # Cash 10000 - 2 x 4771.4285619 + 2 x 4633.4525094 = 9724.047895, flat.
    assert Decimal(out["metrics"]["end_equity"]) == Decimal("9724.047895")
    assert Decimal(out["metrics"]["net_return_percent"]) == Decimal("-2.75952105")
    assert Decimal(out["metrics"]["max_drawdown_percent"]) == Decimal("2.75952105")
    assert out["open_position"]["quantity"] == "0.000000000000000000"
    assert out["open_position"]["open_episode"] is None


def test_overlapping_allocations_make_episodes_differ_from_closed_allocations():
    out = run(scenario_overlap())
    assert out["closed_allocations"] == 2
    assert out["metrics"]["closed_trades"] == 2
    assert out["episodes"]["completed_count"] == 1
    assert out["episodes"]["completed"] == [
        {"open_bar_time_ms": open_ms(1), "allocations": 2, "close_bar_time_ms": open_ms(3)}
    ]
    # Position is in market after bars 1, 2 only; bar 3 ends flat.
    assert out["exposure"] == {"bars_in_market": 2, "bars": 3, "fraction": "0.666666666666666667"}


def test_warmup_never_touches_the_ledger():
    # BUY flag on a warm-up bar. The signal state sees it, the ledger does not.
    bars = [bar(0, "100", buy=True), bar(1, "97.5", "98.4", "97"), bar(2, "98"), bar(3, "98")]
    out = run(bars, split=dict(warmup=1, end=4))
    assert out["fills"] == []
    assert out["metrics"]["start_equity"] == "10000"
    assert out["metrics"]["end_equity"] == "10000"
    assert out["metrics"]["closed_trades"] == 0
    assert out["fees_total"] == "0.000000000000000000"
    assert out["exposure"]["bars_in_market"] == 0
    # The warm-up intent stays in the Bridge arrays; its SL exit on bar 1 has no ledger target.
    assert out["rejected"] == {
        "total": 1,
        "intents_total": 0,
        "orphan_exits": {"warmup_entry": 1, "refused_entry": 0},
        "by_event_type_and_reason": [
            {"event_type": "EXIT", "reason": "TARGET_NOT_OPEN", "count": 1}
        ],
    }


def test_rejected_intents_are_counted_by_event_type_and_reason():
    # One position per symbol: the bar 2 BUY is refused, yet its intent stays in the Bridge arrays.
    # On bar 3 both stops hit; the refused allocation has no ledger target, so its EXIT is refused too.
    contract = {**CONTRACT, "policy": {**POLICY, "onePositionPerSymbol": True}}
    out = run(scenario_overlap(), contract=contract)
    assert out["rejected"] == {
        "total": 2,
        "intents_total": 1,
        "orphan_exits": {"warmup_entry": 0, "refused_entry": 1},
        "by_event_type_and_reason": [
            {
                "event_type": "BUY",
                "reason": "Position or pending order already exists for symbol",
                "count": 1,
            },
            {"event_type": "EXIT", "reason": "TARGET_NOT_OPEN", "count": 1},
        ],
    }
    assert [f["side"] for f in out["fills"]] == ["BUY", "SELL"]
    assert out["closed_allocations"] == 1 and out["episodes"]["completed_count"] == 1


@pytest.mark.parametrize(
    "mutate",
    [
        lambda c, p, s: c.update(budget={"max_evaluations": 5}),
        lambda c, p, s: c.update(seed=7),
        lambda c, p, s: c.update(search=1),  # "search" alone is enough
        lambda c, p, s: c.update(bridge_domains={"atr_multiplier": {"min": "1"}}),
        lambda c, p, s: p.update(search_domain={"min": 1, "max": 5, "step": 1}),
        lambda c, p, s: p["inputs"].update(parameter_slots=["emaFastInput"]),
        lambda c, p, s: s.update(domain="x"),
        lambda c, p, s: c["policy"].update(nested={"deep": {"Seed": 1}}),
        lambda c, p, s: c["policy"].update(dimensions=["atr_multiplier"]),
        lambda c, p, s: p.update(atr_multiplier_bounds={"min": "1", "max": "5"}),
        lambda c, p, s: c.update(bounds=[1, 5]),
        lambda c, p, s: c["rows"][3].update(seed=1),  # rows are walked too (F6)
        lambda c, p, s: c["rows"][3].update(Search_Slot=1),
    ],
)
def test_search_fields_are_refused(mutate):
    contract, parameters, split = copy.deepcopy(CONTRACT), full_parameters(), copy.deepcopy(SPLIT_A)
    contract["rows"] = synthetic_rows(60)
    mutate(contract, parameters, split)
    with pytest.raises(ValueError) as error:
        evaluate_fixed(contract, parameters, "EVALUATION", split)
    assert error.value.args[0] == "QR4_EVALUATION_SEARCH_REFUSED"
    if parameters["inputs"] == INPUTS:  # the prepared-bars entry point takes no SPT inputs
        extra = {k: v for k, v in parameters.items() if k not in ("inputs", "atr_multiplier", "rr")}
        with pytest.raises(ValueError) as bars_error:
            evaluate_fixed_bars(
                contract, {**BRIDGE, **extra}, scenario_open_at_end(), "EVALUATION", split
            )
        assert bars_error.value.args[0] == "QR4_EVALUATION_SEARCH_REFUSED"


def test_stress_doubles_fee_and_slippage_only():
    base = run(scenario_open_at_end())
    stress = run(scenario_open_at_end(), kind="EVALUATION_STRESS")
    assert base["model"]["fee_bps"] == "10" and base["model"]["slippage_bps"] == "10"
    assert stress["model"]["fee_bps"] == "20" and stress["model"]["slippage_bps"] == "20"
    assert stress["model"]["price_tick"] == "0.01" and stress["model"]["risk_percent"] == "1"
    assert stress["cost_stress"] == {"fee_multiplier": "2", "slippage_multiplier": "2"}
    assert base["cost_stress"] == {"fee_multiplier": "1", "slippage_multiplier": "1"}
    fill = stress["fills"][0]
    # Price 100 x 1.002 = 100.20. Size 100 / 2.20 = 45.4545..., step 45.454. Notional 45.454 x 100.2 = 4554.4908.
    assert (fill["price"], fill["quantity"]) == ("100.200000000000000000", "45.454000000000000000")
    assert fill["notional"] == "4554.490800000000000000"
    assert Decimal(stress["fees_total"]) == Decimal("9.1089816")  # 20 bps of 4554.4908
    assert Decimal(stress["slippage_cost_incl_tick_total"]) == Decimal("9.0908")  # 0.20 x 45.454
    # Cash 10000 - 4554.4908 - 9.1089816 = 5436.4002184. Mark at 102: 45.454 x 102 = 4636.308.
    assert Decimal(stress["metrics"]["end_equity"]) == Decimal("10072.7082184")
    assert Decimal(stress["metrics"]["net_return_percent"]) == Decimal("0.727082184")
    # Lowest equity at the entry close 100: 5436.4002184 + 4545.4 = 9981.8002184.
    assert Decimal(stress["metrics"]["max_drawdown_percent"]) == Decimal("0.181997816")
    # The contract is not mutated and the stress run costs more than the plain run per unit.
    assert Decimal(stress["metrics"]["net_return_percent"]) < Decimal(
        base["metrics"]["net_return_percent"]
    )
    assert CONTRACT["model"] == MODEL


def test_lineage_and_hashes_are_echoed_unresolved():
    out = run(scenario_open_at_end())
    assert (out["engine_hash"], out["dataset_sha256"]) == ("e" * 64, "d" * 64)
    assert (out["parent_run_id"], out["selection_id"]) == ("run-parent", "sel-1")
    bare = {
        k: v
        for k, v in CONTRACT.items()
        if k not in ("engine_hash", "dataset_sha256", "parent_run_id", "selection_id")
    }
    out = run(scenario_open_at_end(), contract=bare)
    assert (
        out["engine_hash"],
        out["dataset_sha256"],
        out["parent_run_id"],
        out["selection_id"],
    ) == (None,) * 4
    assert json.loads(json.dumps(out)) == out


def test_window_end_hides_later_bars():
    bars = scenario_open_at_end()
    full = run(bars, split=dict(warmup=1, end=4))
    cut = run(bars, split=dict(warmup=1, end=3))
    assert cut["fills"] == full["fills"]
    assert cut["metrics"]["bars"] == 2
    assert cut["open_position"]["mark_close"] == "101"
    assert (
        Decimal(cut["metrics"]["end_equity"]) == Decimal("5228.5714381") + Decimal("47.619") * 101
    )


@pytest.mark.parametrize(
    "kind,split",
    [
        ("EVALUATION_X", SPLIT_A),
        ("evaluation", SPLIT_A),
        (None, SPLIT_A),
        ("EVALUATION", dict(warmup=4, end=4)),
        ("EVALUATION", dict(warmup=-1, end=4)),
        ("EVALUATION", dict(warmup=0, end=4)),
        ("EVALUATION", dict(warmup=1, end=5)),
        ("EVALUATION", dict(warmup=True, end=4)),
        ("EVALUATION", dict(warmup=1, end=4, extra=1)),
        ("EVALUATION", dict(warmup=1)),
    ],
)
def test_invalid_kind_or_split_is_refused(kind, split):
    with pytest.raises(ValueError) as error:
        run(scenario_open_at_end(), kind=kind, split=split)
    assert error.value.args[0].startswith("QR4_EVALUATION_INPUT_INVALID:")


def test_unknown_or_missing_contract_fields_are_refused():
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:contract"):
        run(scenario_open_at_end(), contract={**CONTRACT, "extra": 1})
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:contract"):
        run(scenario_open_at_end(), contract={k: v for k, v in CONTRACT.items() if k != "policy"})
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:bridge"):
        run(scenario_open_at_end(), bridge=dict(atr_multiplier="2"))
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:atr_multiplier"):
        run(scenario_open_at_end(), bridge=dict(atr_multiplier=2, rr="1.5"))


# --- evaluate_fixed on rows: real SPT signals, and the Python driver ---

INPUTS = dict(
    ema_fast=3,
    ema_slow=8,
    atr_len=14,
    st_factor=3.2,
    zone_atr_mult=1.15,
    setup_expiry=48,
    cooldown=0,
    confirm_lookback=5,
    sl_atr_buffer=0.6,
    min_risk_atr=0.5,
)


def full_parameters():
    return dict(inputs=dict(INPUTS), atr_multiplier="2", rr="1.5")


def synthetic_rows(count):
    """Gapless minute rows with a frozen ``atr14``.

    The frozen ATR is Wilder's ATR(14) seeded at 40 and scaled by 1.7, so it is
    deliberately unlike the cold-started ATR of ``bridge_bars`` the old code used.
    """
    price, rows, state, atr = 30000.0, [], 12345, 40.0
    for index in range(count):
        state = (state * 1103515245 + 12345) % 2**31
        noise = (state / 2**31 - 0.5) * 60
        close = max(1000.0, price + 40 * math.sin(index / 90) + noise)
        high = max(price, close) + 5
        low = min(price, close) - 5
        atr = max(high - low, abs(high - price), abs(low - price)) / 14 + 13 / 14 * atr
        rows.append(
            dict(
                time=open_ms(index) + MINUTE,
                open=f"{price:.2f}",
                high=f"{high:.2f}",
                low=f"{low:.2f}",
                close=f"{close:.2f}",
                volume="1",
                atr14=f"{atr * 1.7:.6f}",
            )
        )
        price = close
    return rows


def rows_contract(count=600):
    return {**CONTRACT, "rows": synthetic_rows(count), "policy": {**POLICY, "maxOpenPositions": 1}}


def frozen_bars(rows, inputs=INPUTS):
    """Bars built the way research_engine builds them (frozen atr14)."""
    evaluated = evaluate_bars(rows, CustomSignalInputs(**inputs))
    return [
        (
            BridgeBar(
                row["time"],
                *(Decimal(str(row[k])) for k in ("open", "high", "low", "close", "volume")),
                Decimal(str(row["atr14"])),
            ),
            signal.buy,
            signal.native_exit,
        )
        for row, signal in zip(rows, evaluated, strict=True)
    ]


def paper_model():
    return PaperModel(
        *(
            Decimal(MODEL[k])
            for k in ("price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent")
        )
    )


def replay_of(bars, start):
    cash = Decimal("10000")
    return paper_replay(
        bars,
        deployment_id="fe1",
        multiplier=Decimal("2"),
        rr=Decimal("1.5"),
        model=paper_model(),
        policy=POLICY | {"maxOpenPositions": 1},
        equity=cash,
        cash=cash,
        broker="binance-global",
        symbol="BTCUSDT",
        start_time=bars[start][0].time,
    )


def engine_fields(fill):
    return {
        k: v for k, v in fill.items() if k not in ("bar_time_ms", "side", "slippage_cost_incl_tick")
    }


def test_rows_run_matches_manual_composition_of_existing_functions():
    contract = rows_contract()
    out = evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=200, end=600))
    bars = frozen_bars(contract["rows"])
    replay = replay_of(bars, 200)
    with localcontext() as ctx:
        ctx.prec = 80
        expected = mark_period(bars, replay["fills"], 200, 600, Decimal("10000"))
    assert replay["fills"], "scenario must trade"
    assert out["metrics"] == expected
    assert [engine_fields(f) for f in out["fills"]] == replay["fills"]
    assert out["closed_allocations"] == expected["closed_trades"]
    assert all(f["bar_time_ms"] == f["time"] - MINUTE for f in out["fills"])


# Cash 10000 never binds here (risk 0.1 percent) and the notional cap is loose, so the
# order size is set by book equity alone: equity 12500 sizes 25 percent larger than 10000.
EQUITY_MODEL = {**MODEL, "risk_percent": "0.1"}
WIDE_POLICY = POLICY | {"maxOpenPositions": 1, "maxOrderNotional": 10000000}


def test_frozen_atr14_run_equals_research_engine_holdout_path(monkeypatch):
    # The research HOLDOUT path replays every row; its "train" period is the same
    # [warmup, end) window as the fixed run when train_end equals the fixed end.
    rows, warmup, end = synthetic_rows(700), 200, 500
    lock = {"atr_multiplier": 2, "rr": 1.5}
    plan = SimpleNamespace(domains={}, candidate=lambda changes: CustomSignalInputs(**INPUTS))
    monkeypatch.setattr(research_engine.CustomOptimizationPlan, "from_snapshot", lambda *_: plan)
    captured = []
    real_replay = research_engine.paper_replay

    def spy(*args, **kwargs):
        captured.append(real_replay(*args, **kwargs))
        return captured[-1]

    monkeypatch.setattr(research_engine, "paper_replay", spy)
    research_contract = dict(
        version="ql3a-research-job-v1",
        scope="SPT_CUSTOM_ENGINEERING_ONLY",
        source="synthetic",
        snapshot={
            "policy": WIDE_POLICY,
            "market": {"broker": "binance-global", "symbol": "BTCUSDT"},
        },
        input_lock={"baseline": lock, "domains": {k: [v] for k, v in lock.items()}},
        split=dict(warmup=warmup, train_end=end, validation_end=end + 1, test_end=len(rows)),
        dataset={"bars": rows},
        model={**EQUITY_MODEL, "version": "paper-close-v1"},
        capital={"cash": "10000", "equity": "12500"},
        deployment_id="fe1",
    )
    with localcontext() as ctx:
        ctx.prec = 80  # research_engine runs mark_period in the ambient context
        research = research_engine.evaluate(
            dict(contract=research_contract, parameters=lock, kind="HOLDOUT")
        )
    contract = {
        **CONTRACT,
        "rows": rows,
        "model": EQUITY_MODEL,
        "policy": WIDE_POLICY,
        "initial_equity": "12500",
    }
    out = evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=warmup, end=end))
    assert out["initial_equity"] == "12500"
    window_end = rows[end - 1]["time"]
    expected_fills = [f for f in captured[0]["fills"] if f["time"] <= window_end]
    assert expected_fills, "scenario must trade"
    assert [engine_fields(f) for f in out["fills"]] == expected_fills
    assert out["metrics"] == research["train"]
    # Equity is not cash: a run that sizes on equity = cash differs.
    flat = evaluate_fixed(
        {**contract, "initial_equity": "10000"},
        full_parameters(),
        "EVALUATION",
        dict(warmup=warmup, end=end),
    )
    assert [f["quantity"] for f in flat["fills"]] != [f["quantity"] for f in out["fills"]]
    # The frozen ATR matters: the cold-started bridge_bars ATR gives other fills.
    cold = bridge_bars(rows, evaluate_bars(rows, CustomSignalInputs(**INPUTS)))
    cold_fills = [f for f in replay_of(cold, warmup)["fills"] if f["time"] <= window_end]
    assert [f["sl"] for f in cold_fills] != [f["sl"] for f in expected_fills]


def test_bars_after_the_window_end_never_change_the_result():
    contract = rows_contract(700)
    tail = synthetic_rows(700)
    for index in range(500, 700):  # a wild, different future
        tail[index] = {
            **tail[index],
            "open": "5000.00",
            "high": "60000.00",
            "low": "1500.00",
            "close": "59000.00",
            "atr14": "900.000000",
        }
    other = {**contract, "rows": tail}
    split = dict(warmup=200, end=500)
    first = evaluate_fixed(contract, full_parameters(), "EVALUATION", split)
    second = evaluate_fixed(other, full_parameters(), "EVALUATION", split)
    assert first["fills"]
    assert first == second
    cut = evaluate_fixed(
        {**contract, "rows": contract["rows"][:500]}, full_parameters(), "EVALUATION", split
    )
    assert first == cut


def test_rows_must_be_gapless_minute_closes():
    contract = rows_contract(60)
    del contract["rows"][30]
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:rows.gap"):
        evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))
    contract = rows_contract(60)
    contract["rows"][0]["time"] += 1
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:rows.time"):
        evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))


@pytest.mark.parametrize(
    "mutate,code",
    [
        (lambda row: row.pop("atr14"), "rows.atr14"),
        (lambda row: row.update(atr14=None), "rows.atr14"),
        (lambda row: row.update(atr14="nan"), "rows.atr14"),
        (lambda row: row.update(atr14=float("inf")), "rows.atr14"),
        (lambda row: row.update(atr14="-1"), "rows.atr14"),
        (lambda row: row.update(atr14=True), "rows.atr14"),
        (lambda row: row.update(atr14=["7"]), "rows.atr14"),
        (lambda row: row.update(close=None), "rows.close"),
        (lambda row: row.pop("volume"), "rows"),
        (lambda row: row.update(extra="x"), "rows"),
    ],
)
def test_every_row_needs_a_frozen_finite_atr14(mutate, code):
    contract = rows_contract(60)
    mutate(contract["rows"][17])
    with pytest.raises(ValueError) as error:
        evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:" + code


def test_rows_capacity_and_warmup_floor():
    split = dict(warmup=10, end=50)
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:rows.capacity"):
        evaluate_fixed(rows_contract(10001), full_parameters(), "EVALUATION", split)
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:rows.capacity"):
        evaluate_fixed_bars(CONTRACT, BRIDGE, [bar(0, "100")] * 10001, "EVALUATION", SPLIT_A)
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:split"):
        evaluate_fixed(rows_contract(60), full_parameters(), "EVALUATION", dict(warmup=0, end=50))
    full = rows_contract(10000)
    out = evaluate_fixed(full, full_parameters(), "EVALUATION", dict(warmup=9000, end=10000))
    assert out["split"] == {"warmup": 9000, "end": 10000, "evaluated_bars": 1000}


def test_policy_must_be_exactly_the_node_policy_names():
    assert set(POLICY) == set(fixed_eval._POLICY_KEYS)
    assert node_policy(POLICY) is not None
    for policy in ({**POLICY, "maxOpenPositionz": 1}, "BOTH"):
        with pytest.raises(ValueError) as error:
            run(scenario_open_at_end(), contract={**CONTRACT, "policy": policy})
        assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:policy"


@pytest.mark.parametrize("key", sorted(POLICY))
def test_policy_missing_any_key_is_refused(key):
    policy = {k: v for k, v in POLICY.items() if k != key}
    with pytest.raises(ValueError) as error:
        run(scenario_open_at_end(), contract={**CONTRACT, "policy": policy})
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:policy"


@pytest.mark.parametrize(
    "key,value",
    [
        ("maxTradesPerDay", None),
        ("maxTradesPerDay", True),
        ("maxTradesPerDay", [1]),
        ("maxTradesPerDay", {"a": 1}),
        ("maxSignalAgeSeconds", "120"),
        ("maxDailyLossR", None),
        ("maxDailyLossR", False),
        ("maxDailyLossR", ["5"]),
        ("maxOrderNotional", {"v": 1}),
        ("maxOrderNotional", "nan"),
        ("maxDailyNotional", float("inf")),
        ("maxOpenPositions", None),
        ("killSwitch", 0),
        ("killSwitch", None),
        ("capPercentEquitySize", "true"),
        ("allowedSymbols", 5),
        ("allowedSymbols", None),
        ("allowedSymbols", [5]),
        ("sideMode", None),
        ("sideMode", ["BOTH"]),
    ],
)
def test_policy_values_of_the_wrong_kind_are_refused(key, value):
    with pytest.raises(ValueError) as error:
        run(scenario_open_at_end(), contract={**CONTRACT, "policy": {**POLICY, key: value}})
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:policy." + key


@pytest.mark.parametrize("key", ["deployment_id", "broker", "symbol"])
@pytest.mark.parametrize("value", [None, 5, True, ["x"], {"a": 1}])
def test_contract_identity_strings_must_be_strings(key, value):
    with pytest.raises(ValueError) as error:
        run(scenario_open_at_end(), contract={**CONTRACT, key: value})
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:contract." + key


@pytest.mark.parametrize("value", ["0", "-1", "nan", 10000, None, "abc"])
def test_initial_equity_must_be_a_positive_decimal_string(value):
    with pytest.raises(ValueError) as error:
        run(scenario_open_at_end(), contract={**CONTRACT, "initial_equity": value})
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:initial_equity"


def test_initial_equity_is_required():
    missing = {k: v for k, v in CONTRACT.items() if k != "initial_equity"}
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:contract"):
        run(scenario_open_at_end(), contract=missing)


def test_initial_equity_sizes_the_book_and_is_echoed():
    base = run(scenario_open_at_end())
    big = run(scenario_open_at_end(), contract={**CONTRACT, "initial_equity": "12500"})
    assert base["initial_equity"] == "10000" and big["initial_equity"] == "12500"
    assert big["fills"][0]["quantity"] != base["fills"][0]["quantity"]


def test_inputs_must_be_the_full_fixed_set():
    parameters = full_parameters()
    del parameters["inputs"]["cooldown"]
    contract = rows_contract(60)
    with pytest.raises(ValueError, match="QR4_EVALUATION_INPUT_INVALID:inputs"):
        evaluate_fixed(contract, parameters, "EVALUATION", dict(warmup=10, end=50))


# --- the stdin/stdout driver ---


def drive(payload, code=None):
    """Run the driver; it exits 0 on a result and 1 on an error JSON."""
    path = Path(fixed_eval.__file__)
    child = subprocess.run(
        [sys.executable, str(path)],
        input=payload if isinstance(payload, bytes) else json.dumps(payload).encode(),
        capture_output=True,
        timeout=120,
        env={"PYTHONPATH": str(path.parents[1]), "PATH": ""},
    )
    output = json.loads(child.stdout)
    assert child.returncode == (1 if "error" in output else 0), child.stderr
    assert child.stderr == b""  # no traceback, no path
    return output


def driver_request():
    return dict(
        contract=rows_contract(120),
        parameters=full_parameters(),
        kind="EVALUATION",
        split=dict(warmup=40, end=120),
    )


def test_command_line_driver_reports_result_and_refusal():
    request = driver_request()
    assert drive(request)["result"] == json.loads(json.dumps(evaluate_fixed(**request)))
    request["contract"]["seed"] = 1
    assert drive(request) == {"error": "QR4_EVALUATION_SEARCH_REFUSED"}


def test_driver_refuses_missing_kind_without_traceback():
    request = driver_request()
    del request["kind"]
    assert drive(request) == {"error": "QR4_EVALUATION_INPUT_INVALID:request"}
    assert drive([1, 2]) == {"error": "QR4_EVALUATION_INPUT_INVALID:request"}


def test_driver_refuses_oversize_and_malformed_input():
    limit = fixed_eval.MAX_REQUEST_BYTES
    assert drive(b" " * (limit + 1)) == {"error": "QR4_EVALUATION_INPUT_INVALID:request.size"}
    assert drive(b"{") == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}
    assert drive(b"\xff\xfe") == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}
    assert drive(b"[" * 100000) == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}


def test_driver_exits_one_on_every_error_and_zero_on_success():
    request = driver_request()
    assert drive(request)["result"]["version"] == "fixed-eval-v1"
    request["contract"]["rows"][50]["high"] = "1"  # the engine's INVALID_OHLC is a plain code
    assert drive(request) == {"error": "INVALID_OHLC"}
    assert drive(b"{") == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}


@pytest.mark.parametrize("time", [10**20, 253402300800000, 0, -60000])
def test_out_of_range_row_times_are_refused_cleanly(time):
    request = driver_request()
    request["contract"]["rows"][0]["time"] = time
    assert drive(request) == {"error": "QR4_EVALUATION_INPUT_INVALID:rows.time"}
    contract = rows_contract(60)
    contract["rows"][0]["time"] = time
    with pytest.raises(ValueError) as error:
        evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:rows.time"


def test_driver_huge_gapless_times_return_rows_time_with_empty_stderr():
    request = driver_request()
    last = 253402300799000 // MINUTE * MINUTE
    count = len(request["contract"]["rows"])
    for index, row in enumerate(request["contract"]["rows"]):
        row["time"] = last - (count - 2 - index) * MINUTE  # the last row lands past the range
    assert drive(request) == {"error": "QR4_EVALUATION_INPUT_INVALID:rows.time"}


class _Stdin:
    def __init__(self, data):
        self.buffer = io.BytesIO(data)


def test_driver_backstop_maps_any_unexpected_exception_to_the_generic_code(monkeypatch, capsys):
    def boom(*_args):
        raise OSError("C:\\secret\\path")

    monkeypatch.setattr(fixed_eval, "evaluate_fixed", boom)
    monkeypatch.setattr(sys, "stdin", _Stdin(json.dumps(driver_request()).encode()))
    with pytest.raises(SystemExit) as exit_info:
        fixed_eval._main()
    assert exit_info.value.code == 1
    captured = capsys.readouterr()
    assert json.loads(captured.out) == {"error": "QR4_EVALUATION_FAILED"}
    assert captured.err == ""


ECHO_KEYS = ["engine_hash", "dataset_sha256", "parent_run_id", "selection_id"]


def drive_with_echo(key, literal):
    request = driver_request()
    request["contract"][key] = "@@"
    payload = json.dumps(request).encode().replace(b'"@@"', literal)
    return drive(payload)


@pytest.mark.parametrize("key", ECHO_KEYS)
@pytest.mark.parametrize(
    "literal", [b"1e400", b"-1e400", b"5", b"true", b"[1]", b'{"a":1}', b"[" * 995 + b"]" * 995]
)
def test_driver_echo_keys_must_be_str_or_null(key, literal):
    assert drive_with_echo(key, literal) == {
        "error": "QR4_EVALUATION_INPUT_INVALID:contract." + key
    }


@pytest.mark.parametrize("key", ECHO_KEYS)
@pytest.mark.parametrize("literal", [b"NaN", b"Infinity", b"-Infinity"])
def test_driver_refuses_json_constants_as_request_json(key, literal):
    assert drive_with_echo(key, literal) == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}


@pytest.mark.parametrize("key", ECHO_KEYS)
@pytest.mark.parametrize("value", [None, "abc"])
def test_echo_keys_accept_str_or_null(key, value):
    contract = {**rows_contract(60), key: value}
    result = evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))
    assert result[key] == value


@pytest.mark.parametrize("key", ECHO_KEYS)
@pytest.mark.parametrize("value", [float("nan"), float("inf"), 5, True, [1], {"a": 1}])
def test_echo_keys_of_other_kinds_are_refused_in_process(key, value):
    contract = {**rows_contract(60), key: value}
    with pytest.raises(ValueError) as error:
        evaluate_fixed(contract, full_parameters(), "EVALUATION", dict(warmup=10, end=50))
    assert error.value.args[0] == "QR4_EVALUATION_INPUT_INVALID:contract." + key


def test_driver_encode_failure_gives_generic_code_with_empty_stderr(monkeypatch, capsys):
    def boom(*_args, **_kwargs):
        raise ValueError("secret path")

    payload = json.dumps(driver_request()).encode()
    monkeypatch.setattr(fixed_eval.json, "dumps", boom)
    monkeypatch.setattr(sys, "stdin", _Stdin(payload))
    with pytest.raises(SystemExit) as exit_info:
        fixed_eval._main()
    assert exit_info.value.code == 1
    captured = capsys.readouterr()
    assert captured.out == '{"error":"QR4_EVALUATION_FAILED"}'
    assert captured.err == ""


def test_driver_accepts_gapless_rows_ending_at_the_last_allowed_time():
    request = driver_request()
    last = 253402300740000
    count = len(request["contract"]["rows"])
    for index, row in enumerate(request["contract"]["rows"]):
        row["time"] = last - (count - 1 - index) * MINUTE
    output = drive(request)
    assert output["result"]["version"] == "fixed-eval-v1"
