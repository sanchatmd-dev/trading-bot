"""PF-2 S1 stateful replay core: restart, Node parity, counters, guards and limits.

Isolated synthetic fixtures only. Scripted signal sources exercise exact Bridge and
Paper paths; the real SPT Custom evaluator runs on a synthetic price series. The
Node oracle (scripts/quant-bridge-reference.mjs) is executed read-only.
"""

import ast
import copy
import io
import json
import math
import os
import subprocess
import sys
import traceback
from decimal import Decimal
from pathlib import Path

import pytest

from robot_quant import pf2_replay, research_chunk
from robot_quant.bridge_replay import PaperModel
from robot_quant.paper_state import PaperState
from robot_quant.ql2a import compare_replays, reference
from robot_quant.spt_custom_evaluator import (
    CustomOptimizationPlan,
    CustomSignalInputs,
    SptCustomEvaluator,
)
from robot_quant.spt_evaluator import SignalBar

MINUTE = 60000
DAY = 86_400_000
MIDNIGHT = 20833 * DAY  # An arbitrary UTC midnight.
NOON = MIDNIGHT - 12 * 60 * MINUTE
PLAN_HASH = "a" * 64
GUARD_REASONS = pf2_replay.GUARD_REASONS


# --- builders ---------------------------------------------------------------------


def policy(**changes):
    result = dict(killSwitch=False, maxSignalAgeSeconds=120, maxTradesPerDay=10000,
        maxDailyLossR=10000, pauseAfterLossStreak=10000, blockHighVolatility=False,
        maxVolatilityPercent=100, blockDuringNews=False, allowedSymbols=["BTCUSDT"],
        sideMode="BOTH", maxOpenPositions=5, onePositionPerSymbol=False,
        capPercentEquitySize=True, maxRiskPercent=100, maxOrderNotional=10000,
        maxDailyNotional=10000000)
    return {**result, **changes}


def make_contract(first, total, *, warmup=0, slippage="0", multiplier="1", rr="1",
                  holdout_gap=10, plan_hash=PLAN_HASH, **policy_changes):
    dev_end = first + (total - 1) * MINUTE
    return {
        "version": "pf2-replay-job-v1",
        "plan_hash": plan_hash,
        "deployment_id": "fixture",
        "signal": {"mode": "EVALUATOR", "profile": "SPT_CUSTOM", "source": "fixture", "snapshot": {}},
        "bridge": {"atr_multiplier": multiplier, "rr": rr},
        "model": {"price_tick": "0.01", "quantity_step": "0.00001", "fee_bps": "10",
                  "slippage_bps": slippage, "risk_percent": "1", "version": "paper-close-v1"},
        "policy": policy(**policy_changes),
        "capital": {"cash": "1000", "equity": "1000"},
        "initial_state": {"kind": "FRESH", "loss_streak": 0},
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "dataset": {"first_time": first, "total_bars": total, "warmup_bars": warmup,
                    "development_end_time": dev_end,
                    "holdout_start_time": dev_end + holdout_gap * MINUTE},
        "limits": {"max_bars": 10000, "max_state_bytes": 1024 * 1024,
                   "max_output_bytes": 8 * 1024 * 1024, "max_samples": 50},
    }


def make_request(contract, rows, checkpoint=None):
    return {"version": pf2_replay.PF2_REPLAY_VERSION, "contract": contract, "rows": rows,
            "checkpoint": checkpoint}


def wire(value):
    return json.loads(json.dumps(value, allow_nan=False))


def resign(checkpoint):
    checkpoint["integrity"] = pf2_replay.digest(
        {k: v for k, v in checkpoint.items() if k != "integrity"})
    return checkpoint


def fails(code, request, **kwargs):
    with pytest.raises(pf2_replay.PF2Error) as raised:
        pf2_replay.evaluate_pf2_chunk(request, **kwargs)
    assert raised.value.code == code
    return raised.value


def run(contract, rows, size, *, trace=None):
    """Chunked run with JSON transport; returns (result, final checkpoint)."""
    checkpoint, response = None, None
    for start in range(0, len(rows), size):
        response = pf2_replay.evaluate_pf2_chunk(
            make_request(contract, rows[start:start + size], checkpoint), trace=trace)
        checkpoint = wire(response["checkpoint"])
        assert len(pf2_replay.canonical(checkpoint)) < pf2_replay.STATE_LIMIT
        assert (response["result"] is None) == (checkpoint["next_bar"] < len(rows))
    return wire(response["result"]), checkpoint


class ScriptedSource:
    """Test double for the signal-source seam (step / export_state / import_state)."""

    def __init__(self, buys, exits):
        self.buys, self.exits, self.index = set(buys), set(exits), -1

    def step(self, row):
        self.index += 1
        return SignalBar(self.index in self.buys, self.index in self.exits, 0.0, 0.0, None,
                         None, 1, False, False)

    def export_state(self):
        return {"index": self.index}

    def import_state(self, state, next_bar):
        if set(state) != {"index"} or state["index"] != next_bar - 1:
            raise ValueError("SCRIPT_STATE")
        self.index = state["index"]


@pytest.fixture
def scripted(monkeypatch):
    def install(buys, exits):
        monkeypatch.setattr(pf2_replay, "build_signal_source",
                            lambda signal: ScriptedSource(buys, exits))
    return install


@pytest.fixture
def real_spt(monkeypatch):
    inputs = CustomSignalInputs(ema_fast=5, ema_slow=17, atr_len=7, st_factor=1.2,
        zone_atr_mult=2.5, setup_expiry=8, cooldown=2, confirm_lookback=3)
    plan = CustomOptimizationPlan(inputs, {})
    # Only source/snapshot enrollment is isolated; SPT, Bridge, Risk and Paper are real.
    monkeypatch.setattr(CustomOptimizationPlan, "from_snapshot", lambda *_: plan)


def bar_rows(first, closes, atrs):
    return [dict(time=first + i * MINUTE, open=str(c), high=str(c + 1), low=str(c - 1),
                 close=str(c), volume="1", atr14=a) for i, (c, a) in enumerate(zip(closes, atrs, strict=True))]


# Hand-derived accounting scenario (12 bars, evaluation starts at bar 2, no slippage).
#  bar 0 warm-up BUY (Bridge entry only, no ledger); bar 2 BUY accepted; bar 3 BUY sizing-adjusted
#  (cash bound); bar 4 close 104 -> three TP intents (I2, I1 fill, warm-up entry has no
#  Paper target -> TARGET_NOT_OPEN), one flat transition after two buys; bar 5 BUY; bar 6
#  close 96 -> SL, losing episode; bar 7 atr14 None, bar 8 invalid levels, bar 9 BUY with
#  native EXIT flag: three suppressed BUY signals; bar 10 BUY; bar 11 native EXIT.
S3_CLOSES = [100, 100, 100, 100, 104, 100, 96, 100, 100, 100, 100, 100]
S3_ATRS = ["2", "2", "2", "2", "2", "2", "2", None, "500", "2", "2", "2"]
S3_BUYS = {0, 2, 3, 5, 7, 8, 9, 10}
S3_EXITS = {9, 11}
S3_WARMUP = 2


def s3_rows(first):
    return bar_rows(first, S3_CLOSES, S3_ATRS)


def real_rows(first, count, amplitude=4, period=2.1, atr="2.75"):
    rows, previous = [], 100.0
    for i in range(count):
        close = 100 + 12 * math.sin(i / 23) + amplitude * math.sin(i / period)
        rows.append(dict(time=first + i * MINUTE, open=str(previous),
            high=str(max(previous, close) + 1.2), low=str(min(previous, close) - 1.2),
            close=str(close), volume="1", atr14=atr))
        previous = close
    return rows


REAL_FIRST = MIDNIGHT - 300 * MINUTE  # Five hours before midnight: both UTC days trade.
REAL_BARS = 720
REAL_WARMUP = 10
GUARDED = dict(maxTradesPerDay=25, pauseAfterLossStreak=12, maxDailyLossR=6)


def real_contract(**policy_changes):
    return make_contract(REAL_FIRST, REAL_BARS, warmup=REAL_WARMUP, slippage="1",
                         rr="2", **policy_changes)


# --- 1. restart equality ----------------------------------------------------------


@pytest.mark.parametrize("changes", [{}, GUARDED], ids=["default", "guarded"])
@pytest.mark.parametrize("size", [1, 7, 109, 380, 719])
def test_01_restart_equals_uninterrupted(real_spt, changes, size):
    contract = real_contract(**changes)
    rows = real_rows(REAL_FIRST, REAL_BARS)
    expected_trace = []
    expected, expected_state = run(contract, rows, len(rows), trace=expected_trace)
    trace = []
    result, state = run(contract, rows, size, trace=trace)
    assert result == expected
    assert state == expected_state
    assert trace == expected_trace
    counters = result["counters"]
    assert counters["fills"]["buy"] > 5 and counters["episodes"]["losing"] > 0
    assert len(expected_state["paper"]["daily"]) == 2  # Both UTC days carried continuously.
    if changes:
        # Guards under restart: pause facts and rejections are part of the equality above.
        assert counters["orders"]["rejected"] > 0
        assert result["guards"]["pause"]["periods"]


# --- 2. Node oracle parity --------------------------------------------------------


def node_request(contract, rows, flags):
    job = contract
    dataset = job["dataset"]
    model = job["model"]
    return {
        "operation": "replay",
        "deployment_id": job["deployment_id"],
        "multiplier": job["bridge"]["atr_multiplier"],
        "rr": job["bridge"]["rr"],
        "policy": job["policy"],
        "equity": job["capital"]["equity"],
        "cash": job["capital"]["cash"],
        "broker": job["broker"],
        "symbol": job["symbol"],
        "start_time": dataset["first_time"] + dataset["warmup_bars"] * MINUTE,
        "model": model,
        "bars": [
            {"time": row["time"], "open": row["open"], "high": row["high"], "low": row["low"],
             "close": row["close"], "volume": row["volume"], "atr14": row["atr14"],
             "buy": buy, "native_exit": native}
            for row, (buy, native) in zip(rows, flags, strict=True)
        ],
    }


def python_side(trace, result):
    return {
        "events": [e for step in trace for e in step["events"]],
        "decisions": [d for step in trace for d in step["decisions"]],
        "final_cash": result["account"]["cash"],
        "position_quantity": result["account"]["position_quantity"],
        "position_cost": result["account"]["position_cost"],
        "open_allocations": result["account"]["open_allocations"],
    }


PERSISTENT = {"KILL_SWITCH", "LOSS_STREAK"}


def node_derived(contract, node):
    """PF-2-only facts recomputed from Node oracle output, never from Python state."""
    data, rules = contract["dataset"], contract["policy"]
    start = data["first_time"] + data["warmup_bars"] * MINUTE
    intents = dict.fromkeys(("buy", "exit_sl", "exit_tp", "exit_native"), 0)
    warmup = {"buy": 0, "exit": 0}
    for event in node["events"]:
        if event["time"] < start:
            warmup["buy" if event["event_type"] == "BUY" else "exit"] += 1
        else:
            intents["buy" if event["event_type"] == "BUY" else "exit_" + event["reason"].lower()] += 1
    by_time = {}
    for decision in node["decisions"]:
        by_time.setdefault(decision["time"], []).append(decision)
    orders = {"accepted": 0, "sizing_adjusted": 0, "rejected": 0, "rejected_by_reason": {}}
    fills = {"buy": 0, "exit": 0, "exit_by_reason": {}}
    quantity, cash_before, closed, losing = Decimal(0), None, 0, 0
    streak = contract["initial_state"]["loss_streak"]
    trades, realized, open_now, periods = {}, {}, {}, []
    limit = -abs(Decimal(str(rules["maxDailyLossR"])))
    for index in range(data["total_bars"]):
        now = data["first_time"] + index * MINUTE
        if now < start:
            continue
        day = now // DAY
        for kind, begun in list(open_now.items()):  # Day pauses end at the next midnight.
            if kind not in PERSISTENT and now >= (begun // DAY + 1) * DAY:
                periods.append((kind, begun, (begun // DAY + 1) * DAY))
                del open_now[kind]
        for decision in by_time.get(now, []):
            if decision["outcome"] == "REJECTED":
                orders["rejected"] += 1
                reasons = orders["rejected_by_reason"]
                reasons[decision["reason"]] = reasons.get(decision["reason"], 0) + 1
                continue
            orders["sizing_adjusted" if decision["sizing_outcome"] == "CAPPED" else "accepted"] += 1
            trades[day] = trades.get(day, 0) + 1
            realized[day] = realized.get(day, Decimal(0)) + Decimal(decision["realized_r"])
            size = Decimal(decision["quantity"])
            if decision["event_type"] == "BUY":
                if quantity == 0:
                    cash_before = (Decimal(decision["cash"]) + Decimal(decision["notional"])
                                   + Decimal(decision["fee"]))
                quantity += size
                fills["buy"] += 1
                continue
            quantity -= size
            fills["exit"] += 1
            fills["exit_by_reason"][decision["reason"]] = fills["exit_by_reason"].get(decision["reason"], 0) + 1
            if quantity == 0:  # Flat: one closed episode; its cash result decides the streak.
                closed += 1
                lost = Decimal(decision["cash"]) - cash_before < 0
                losing += int(lost)
                streak = streak + 1 if lost else 0
        active = []
        if rules["killSwitch"]:
            active.append("KILL_SWITCH")
        if trades.get(day, 0) >= rules["maxTradesPerDay"]:
            active.append("MAX_TRADES_PER_DAY")
        if realized.get(day, Decimal(0)) <= limit:
            active.append("MAX_DAILY_LOSS")
        if streak >= rules["pauseAfterLossStreak"]:
            active.append("LOSS_STREAK")
        for kind in list(open_now):
            if kind not in PERSISTENT and kind not in active:
                periods.append((kind, open_now.pop(kind), now))
        for kind in active:
            open_now.setdefault(kind, now)
    periods += [(kind, begun, None) for kind, begun in open_now.items()]
    return {"intents": intents, "warmup": warmup, "orders": orders, "fills": fills,
            "episodes": {"closed": closed, "losing": losing}, "streak": streak,
            "periods": sorted((kind, begun, end, kind in PERSISTENT) for kind, begun, end in periods)}


def assert_node_derived_facts(contract, node, result):
    derived = node_derived(contract, node)
    counters = result["counters"]
    assert derived["intents"] == counters["intents"]
    assert derived["warmup"] == counters["warmup_intents"]
    assert derived["orders"] == counters["orders"]
    assert derived["fills"] == counters["fills"]
    assert derived["episodes"] == counters["episodes"]
    assert derived["streak"] == result["guards"]["loss_streak_final"]
    reported = sorted((p["kind"], p["start_time"], p["end_time"], p["persistent"])
                      for p in result["guards"]["pause"]["periods"])
    assert reported == derived["periods"]


def assert_node_parity(contract, rows):
    trace = []
    result, _ = run(contract, rows, 5, trace=trace)
    flags = [(step["signal"]["buy"], step["signal"]["native_exit"]) for step in trace]
    node = reference(node_request(contract, rows, flags))
    python = python_side(trace, result)
    model = PaperModel(**{k: Decimal(v) for k, v in contract["model"].items() if k != "version"})
    summary = compare_replays(python, node, model)
    assert summary["matched"], summary
    assert not any(summary["differences"].values())
    assert len(python["events"]) == len(node["events"]) > 0
    for left, right in zip(python["decisions"], node["decisions"], strict=True):
        assert (left["outcome"], left["reason"], left["entry_ref"], left["event_type"], left["time"]) == (
            right["outcome"], right["reason"], right["entry_ref"], right["event_type"], right["time"])
        for field in ("quantity", "fee") + (("price", "notional", "cash", "cost", "realized_r")
                if left["outcome"] == "FILLED" else ()):
            assert Decimal(left[field]) == Decimal(right[field]), field
    assert Decimal(python["final_cash"]) == Decimal(node["final_cash"])
    assert Decimal(python["position_cost"]) == Decimal(node["position_cost"])
    assert Decimal(python["position_quantity"]) == Decimal(node["position_quantity"])
    assert_node_derived_facts(contract, node, result)  # Episodes, streak, guards, tallies.
    return result


NODE_CASES = [
    ("plain", NOON, {}),
    ("killSwitch", NOON, {"killSwitch": True}),
    ("maxTradesPerDay", NOON, {"maxTradesPerDay": 6}),
    ("maxDailyLossR", NOON, {"maxDailyLossR": 0.01}),
    ("pauseAfterLossStreak", NOON, {"pauseAfterLossStreak": 1}),
    ("midnight_plain", MIDNIGHT - 10 * MINUTE, {}),
    ("midnight_maxTradesPerDay", MIDNIGHT - 10 * MINUTE, {"maxTradesPerDay": 6}),
    ("midnight_maxDailyLossR", MIDNIGHT - 10 * MINUTE, {"maxDailyLossR": 0.01}),
    ("midnight_pauseAfterLossStreak", MIDNIGHT - 10 * MINUTE, {"pauseAfterLossStreak": 1}),
]


NATIVE_FILLS = {"plain", "midnight_plain", "midnight_maxTradesPerDay", "midnight_maxDailyLossR"}


@pytest.mark.parametrize(("name", "first", "changes"), NODE_CASES, ids=[c[0] for c in NODE_CASES])
def test_02_node_oracle_parity_sl_tp_native_guards_and_midnight(scripted, name, first, changes):
    scripted(S3_BUYS, S3_EXITS)
    contract = make_contract(first, len(S3_CLOSES), warmup=S3_WARMUP, **changes)
    result = assert_node_parity(contract, s3_rows(first))
    fills = result["counters"]["fills"]
    if "killSwitch" in changes:
        assert fills == {"buy": 0, "exit": 0, "exit_by_reason": {}}
    else:  # SL and TP always; NATIVE only when the bar-10 BUY was not paused away.
        assert fills["buy"] >= 3 and fills["exit_by_reason"]["SL"] == 1
        assert fills["exit_by_reason"]["TP"] == 2
        assert fills["exit_by_reason"].get("NATIVE", 0) == (1 if name in NATIVE_FILLS else 0)


@pytest.mark.parametrize("changes", [{}, GUARDED], ids=["default", "guarded"])
def test_02_node_oracle_parity_real_spt_signals(real_spt, changes):
    contract = real_contract(**changes)
    result = assert_node_parity(contract, real_rows(REAL_FIRST, REAL_BARS))
    assert result["counters"]["fills"]["buy"] > 5 and result["counters"]["signals"]["buy"] > 20


# --- 3. counters ------------------------------------------------------------------


def recount(trace, warmup_start):
    """Independent recount from raw Bridge/Paper output; shares no code with the module."""
    seen = {"buy": 0, "native": 0, "intent_buy": 0, "warm_buy": 0, "warm_exit": 0,
            "exits": {}, "accepted": 0, "adjusted": 0, "rejected": {}, "fill_buy": 0,
            "fill_exit": 0, "exit_fills": {}}
    for step in trace:
        seen["buy"] += step["signal"]["buy"]
        seen["native"] += step["signal"]["native_exit"]
        for event in step["events"]:
            evaluated = event["time"] >= warmup_start
            if event["event_type"] == "BUY":
                seen["intent_buy" if evaluated else "warm_buy"] += 1
            elif evaluated:
                seen["exits"][event["reason"]] = seen["exits"].get(event["reason"], 0) + 1
            else:
                seen["warm_exit"] += 1
        for decision in step["decisions"]:
            if decision["outcome"] == "REJECTED":
                seen["rejected"][decision["reason"]] = seen["rejected"].get(decision["reason"], 0) + 1
                continue
            seen["adjusted" if decision["sizing_outcome"] == "CAPPED" else "accepted"] += 1
            if decision["event_type"] == "BUY":
                seen["fill_buy"] += 1
            else:
                seen["fill_exit"] += 1
                seen["exit_fills"][decision["reason"]] = seen["exit_fills"].get(decision["reason"], 0) + 1
    return seen


def check_invariants(result):
    counters = result["counters"]
    intents = sum(counters["intents"].values())
    orders = counters["orders"]
    assert orders["accepted"] + orders["sizing_adjusted"] + orders["rejected"] == intents
    assert counters["fills"]["buy"] + counters["fills"]["exit"] == orders["accepted"] + orders["sizing_adjusted"]
    assert sum(orders["rejected_by_reason"].values()) == orders["rejected"]
    assert sum(counters["fills"]["exit_by_reason"].values()) == counters["fills"]["exit"]
    assert counters["episodes"]["closed"] <= counters["fills"]["exit"]
    assert counters["episodes"]["losing"] <= counters["episodes"]["closed"]
    derived = result["derived"]
    assert derived["suppressed_buy"] >= 0
    assert derived["intents_evaluated"] == intents
    assert derived["non_losing_episodes"] == counters["episodes"]["closed"] - counters["episodes"]["losing"]


def test_03_counters_are_distinct_and_hold_invariants(scripted):
    scripted(S3_BUYS, S3_EXITS)
    first = NOON
    contract = make_contract(first, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    trace = []
    result, state = run(contract, s3_rows(first), 12, trace=trace)
    counters = result["counters"]
    assert counters["signals"] == {"buy": 8, "buy_evaluated": 7, "native_exit": 2,
                                   "native_exit_evaluated": 2}
    assert counters["intents"] == {"buy": 4, "exit_sl": 1, "exit_tp": 3, "exit_native": 1}
    assert counters["warmup_intents"] == {"buy": 1, "exit": 0}
    assert result["derived"]["suppressed_buy"] == 3  # atr14 None, invalid levels, exit bar.
    # Whole-run figure includes warm-up bars; the evaluation-only variant does not.
    assert result["derived"]["suppressed_buy_evaluated"] == 7 - 4 == 3
    assert counters["orders"] == {
        "accepted": 4, "sizing_adjusted": 2, "rejected": 3,
        "rejected_by_reason": {"TARGET_NOT_OPEN": 2, "Maximum trades per day reached": 1}}
    assert counters["fills"] == {"buy": 3, "exit": 3, "exit_by_reason": {"SL": 1, "TP": 2}}
    # Two buys then two exits are ONE closed episode; the SL round trip is the losing one.
    assert counters["episodes"] == {"closed": 2, "losing": 1}
    assert result["derived"]["non_losing_episodes"] == 1
    check_invariants(result)
    seen = recount(trace, first + S3_WARMUP * MINUTE)
    assert seen["intent_buy"] == counters["intents"]["buy"] and seen["warm_buy"] == 1
    assert seen["accepted"] == counters["orders"]["accepted"]
    assert seen["adjusted"] == counters["orders"]["sizing_adjusted"]
    assert seen["rejected"] == counters["orders"]["rejected_by_reason"]
    assert seen["exit_fills"] == counters["fills"]["exit_by_reason"]
    assert seen["exits"] == {"TP": 3, "SL": 1, "NATIVE": 1}
    assert (seen["buy"], seen["native"]) == (8, 2)
    # Chunking never changes any counter.
    for size in (1, 3, 5):
        assert run(contract, s3_rows(first), size)[0] == result


def test_03_counter_invariants_on_real_spt_run(real_spt):
    contract = real_contract(**GUARDED)
    trace = []
    result, state = run(contract, real_rows(REAL_FIRST, REAL_BARS), 97, trace=trace)
    check_invariants(result)
    assert not contains_float(state) and not contains_float(result)
    pf2_replay.canonical(state).decode("ascii")
    seen = recount(trace, REAL_FIRST + REAL_WARMUP * MINUTE)
    counters = result["counters"]
    assert (seen["buy"], seen["native"]) == (counters["signals"]["buy"], counters["signals"]["native_exit"])
    assert seen["accepted"] == counters["orders"]["accepted"]
    assert seen["adjusted"] == counters["orders"]["sizing_adjusted"]
    assert seen["rejected"] == counters["orders"]["rejected_by_reason"]
    assert seen["fill_buy"] == counters["fills"]["buy"] and seen["fill_exit"] == counters["fills"]["exit"]
    assert seen["exit_fills"] == counters["fills"]["exit_by_reason"]
    assert result["derived"]["suppressed_buy"] == counters["signals"]["buy"] - seen["intent_buy"] - seen["warm_buy"]
    assert result["derived"]["suppressed_buy_evaluated"] == counters["signals"]["buy_evaluated"] - seen["intent_buy"]
    assert counters["orders"]["rejected"] > 0 and counters["episodes"]["losing"] > 0


# --- 4. warm-up -------------------------------------------------------------------


def test_04_warmup_intents_are_counted_with_zero_ledger_effect(scripted):
    warmup_buys = {0, 1}
    scripted(warmup_buys, set())
    first = NOON
    rows = bar_rows(first, [100, 100, 104, 104, 104], ["2"] * 5)
    contract = make_contract(first, 5, warmup=2)
    head = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[:2]))
    state = wire(head["checkpoint"])
    counters = state["counters"]
    assert counters["warmup_intents"] == {"buy": 2, "exit": 0}
    assert counters["intents"] == {"buy": 0, "exit_sl": 0, "exit_tp": 0, "exit_native": 0}
    assert counters["orders"]["accepted"] == counters["orders"]["sizing_adjusted"] == 0
    assert counters["signals"]["buy"] == 2 and counters["signals"]["buy_evaluated"] == 0
    paper = state["paper"]
    assert (paper["cash"], paper["quantity"], paper["cost"]) == ("1000", "0", "0")
    assert paper["positions"] == {} and paper["daily"] == {} and paper["loss_streak"] == 0
    assert len(paper["entries"]) == 2  # Pine array state is warm; the Bot ledger is not.
    assert head["result"] is None and state["guards"]["open"] == {}
    tail = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[2:], state))
    result = wire(tail["result"])
    # Warm-up entries hit TP at bar 2: exit intents fire but no Paper target exists.
    assert result["counters"]["intents"]["exit_tp"] == 2
    assert result["counters"]["orders"]["rejected_by_reason"] == {"TARGET_NOT_OPEN": 2}
    assert result["counters"]["fills"]["buy"] == result["counters"]["fills"]["exit"] == 0
    assert result["account"]["cash"] == "1000" and result["account"]["open_allocations"] == 0
    assert result["counters"]["episodes"] == {"closed": 0, "losing": 0}
    assert result["counters"]["warmup_intents"] == {"buy": 2, "exit": 0}
    # Same script with no warm-up window fills the very BUYs that warm-up kept off the ledger.
    scripted(warmup_buys, set())
    cold = run(make_contract(first, 5, warmup=0), rows, 5)[0]
    assert cold["counters"]["warmup_intents"] == {"buy": 0, "exit": 0}
    assert cold["counters"]["fills"]["buy"] == 2 and cold["counters"]["fills"]["exit"] == 2
    assert cold["counters"]["episodes"]["closed"] == 1


# --- 5. holdout boundary ----------------------------------------------------------


def boundary_setup(scripted_installer, *, gap):
    scripted_installer(set(), set())
    first = NOON
    rows = bar_rows(first, [100] * 8, ["2"] * 8)
    contract = make_contract(first, 5, warmup=0, holdout_gap=gap)
    return first, rows, contract


def test_05_holdout_boundary_and_off_by_one(scripted):
    first, rows, contract = boundary_setup(scripted, gap=0)  # dev end == holdout start.
    dataset = contract["dataset"]
    last_dev = first + 4 * MINUTE
    assert dataset["development_end_time"] == dataset["holdout_start_time"] == last_dev
    # A closed bar stamped exactly at the holdout start covers [start - 1m, start): allowed.
    accepted = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[:5]))
    result = wire(accepted["result"])
    assert result["window"]["last_time"] == dataset["holdout_start_time"]
    assert result["admission"] == {"development_only": True, "evaluator_admission": False,
        "holdout_accessed": False, "orders_executed": False, "execution_model_parity": "V1_ONLY"}
    # The next closed bar opens AT the holdout start: never touched, whatever the chunk holds.
    for sixth in (rows[5], {**rows[5], "close": "not-a-number"}, {"time": last_dev + MINUTE}):
        request = make_request(contract, rows[:4] + [sixth])
        fails("PF2_HOLDOUT_BOUNDARY_VIOLATION", request)
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION", make_request(contract, rows[3:7]))
    # Raw dataset space: bar open time = closed time - 1m. Last raw open time below the
    # holdout start is fine; a raw bar opening at the start is not (closed time start + 1m).
    raw_open_times = [row["time"] - MINUTE for row in rows]
    assert raw_open_times[4] == dataset["holdout_start_time"] - MINUTE
    assert raw_open_times[5] == dataset["holdout_start_time"]
    # Derived closed metadata carries end_time = raw end + 1 minute (data-profile-v2.js:30),
    # an exclusive index bound; using it as a row time would reach past development.
    derived_end_index_bound = last_dev + MINUTE
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION",
          make_request(contract, [*rows[:4], {**rows[4], "time": derived_end_index_bound}]))


def test_05_holdout_boundary_rejects_whole_chunk_before_any_state_work(scripted, monkeypatch):
    first, rows, contract = boundary_setup(scripted, gap=3)
    head = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[:2]))
    checkpoint = wire(head["checkpoint"])
    untouched = copy.deepcopy(checkpoint)
    built = []
    monkeypatch.setattr(pf2_replay, "build_signal_source",
                        lambda signal: built.append(signal) or ScriptedSource(set(), set()))
    late = [*rows[2:4], {**rows[4], "time": contract["dataset"]["development_end_time"] + MINUTE}]
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION", make_request(contract, late, checkpoint))
    assert built == [] and checkpoint == untouched  # No evaluator built, no state touched.
    # development_end < holdout_start: a bar between them is still beyond development.
    holdout_start = contract["dataset"]["holdout_start_time"]
    between = contract["dataset"]["development_end_time"] + MINUTE
    assert between <= holdout_start
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION",
          make_request(contract, [*rows[2:4], {**rows[4], "time": between}], checkpoint))
    # The prior checkpoint is still valid and completes the run.
    done = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[2:5], checkpoint))
    assert done["result"] is not None


def test_05_contract_boundary_rejections(scripted):
    scripted(set(), set())
    first = NOON
    rows = bar_rows(first, [100] * 5, ["2"] * 5)
    good = make_contract(first, 5)
    dev_end = good["dataset"]["development_end_time"]
    bad = copy.deepcopy(good)
    bad["dataset"]["development_end_time"] = dev_end + MINUTE  # dev end after holdout start.
    bad["dataset"]["holdout_start_time"] = dev_end
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION", make_request(bad, rows))
    short = copy.deepcopy(good)
    short["dataset"]["development_end_time"] = dev_end - MINUTE  # Declared bars pass dev end.
    fails("PF2_HOLDOUT_BOUNDARY_VIOLATION", make_request(short, rows))
    unaligned = copy.deepcopy(good)
    unaligned["dataset"]["holdout_start_time"] += 1
    fails("PF2_REQUEST_INVALID", make_request(unaligned, rows))


# --- 6. pause facts ---------------------------------------------------------------


def paused_run(first, **changes):
    contract = make_contract(first, 12, warmup=S3_WARMUP, **changes)
    trace = []
    result, _ = run(contract, s3_rows(first), 4, trace=trace)
    return result, trace


def assert_no_eta(value):
    if isinstance(value, dict):
        for key, child in value.items():
            assert key.lower() not in {"eta", "collection_eta", "estimated_time", "estimate"}
            assert not key.lower().endswith("_eta") and not key.lower().startswith("eta_")
            assert_no_eta(child)
    elif isinstance(value, list):
        for child in value:
            assert_no_eta(child)


def guard_reason_agrees_with_state(trace):
    """State-derived pre-bar guard kinds vs the risk evaluator reason strings."""
    for step in trace:
        for decision in step["decisions"]:
            if decision["event_type"] != "BUY":
                continue
            if step["guards"]:
                assert decision["outcome"] == "REJECTED"
                assert decision["reason"] == GUARD_REASONS[step["guards"][0]]
            else:
                assert decision["reason"] not in GUARD_REASONS.values()


def test_06_persistent_and_day_scoped_pauses_are_state_derived(scripted):
    scripted(S3_BUYS, S3_EXITS)
    start = NOON + S3_WARMUP * MINUTE
    # Kill switch: persistent from evaluation start, no entry ever, no clearing.
    result, trace = paused_run(NOON, killSwitch=True)
    pause = result["guards"]["pause"]
    assert pause["persistent"] is True and result["guards"]["kill_switch"] is True
    assert pause["periods"] == [{"kind": "KILL_SWITCH", "start_time": start, "end_time": None,
                                 "persistent": True}]
    assert result["counters"]["fills"]["buy"] == 0
    guard_reason_agrees_with_state(trace)
    assert_no_eta(result)
    # Loss streak 1: persistent from the losing SL bar (bar 6), open-ended, across midnight.
    for first in (NOON, MIDNIGHT - 10 * MINUTE):
        result, trace = paused_run(first, pauseAfterLossStreak=1)
        pause = result["guards"]["pause"]
        assert result["guards"]["loss_streak_final"] == 1
        assert pause["persistent"] is True and pause["active_kinds"] == ["LOSS_STREAK"]
        assert pause["periods"] == [{"kind": "LOSS_STREAK", "start_time": first + 6 * MINUTE,
                                     "end_time": None, "persistent": True}]
        assert result["counters"]["orders"]["rejected_by_reason"][GUARD_REASONS["LOSS_STREAK"]] == 1
        guard_reason_agrees_with_state(trace)
        assert_no_eta(result)
    # Trades per day and daily loss: not persistent, end at the next UTC midnight.
    for changes, kind in (({"maxTradesPerDay": 6}, "MAX_TRADES_PER_DAY"),
                          ({"maxDailyLossR": 0.01}, "MAX_DAILY_LOSS")):
        first = MIDNIGHT - 10 * MINUTE
        result, trace = paused_run(first, **changes)
        closed = result["guards"]["pause"]["periods"][0]
        assert closed == {"kind": kind, "start_time": first + 6 * MINUTE, "end_time": MIDNIGHT,
                          "persistent": False}
        assert result["guards"]["pause"]["persistent"] is False
        # Midnight cleared it: the bar-10 BUY (00:00, next UTC day) filled.
        assert result["counters"]["fills"]["buy"] == 4
        assert GUARD_REASONS[kind] not in result["counters"]["orders"]["rejected_by_reason"]
        guard_reason_agrees_with_state(trace)
        assert_no_eta(result)
        # Same policy inside one UTC day: still paused at replay end, flagged non-persistent.
        result, trace = paused_run(NOON, **changes)
        pause = result["guards"]["pause"]
        assert pause["active_kinds"] == [kind] and pause["persistent"] is False
        assert pause["periods"] == [{"kind": kind, "start_time": NOON + 6 * MINUTE,
                                     "end_time": None, "persistent": False}]
        assert result["counters"]["orders"]["rejected_by_reason"][GUARD_REASONS[kind]] == 1
        guard_reason_agrees_with_state(trace)


def test_06_guard_classification_never_reads_reason_text(scripted, monkeypatch):
    scripted(S3_BUYS, S3_EXITS)
    result, _ = paused_run(NOON, maxTradesPerDay=6)
    # Break the reason table: the cross-check must trip, classification stays state-based.
    monkeypatch.setattr(pf2_replay, "GUARD_REASONS",
                        {**GUARD_REASONS, "MAX_TRADES_PER_DAY": "changed text"})
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    fails("PF2_EVALUATION_FAILED", make_request(contract, s3_rows(NOON)))
    assert result["guards"]["pause"]["active_kinds"] == ["MAX_TRADES_PER_DAY"]


def test_06_pause_period_list_is_bounded_and_restart_safe(scripted, monkeypatch):
    scripted(set(), set())
    monkeypatch.setattr(pf2_replay, "MAX_PAUSE_PERIODS", 3)  # Production cap is 256.
    total = 6 * 24 * 60 + 100  # Seven UTC days from midnight.
    # maxTradesPerDay=0 raises the day-scoped guard on every day, ending at each midnight.
    contract = make_contract(MIDNIGHT, total, warmup=0, maxTradesPerDay=0)
    rows = bar_rows(MIDNIGHT, [100] * total, ["2"] * total)
    result, state = run(contract, rows, 3000)
    pause = result["guards"]["pause"]
    assert pause["truncated"] is True and pause["dropped_periods"] == 3
    assert state["guards"]["dropped"] == 3 and len(state["guards"]["closed"]) == 3
    kept = [p["start_time"] for p in pause["periods"][:3]]
    assert kept == [MIDNIGHT + n * DAY for n in range(3)]  # First periods kept, in order.
    assert pause["periods"][3] == {"kind": "MAX_TRADES_PER_DAY", "start_time": MIDNIGHT + 6 * DAY,
                                   "end_time": None, "persistent": False}
    assert run(contract, rows, total)[0] == result


def test_06_daily_loss_pause_lifts_when_a_later_exit_realizes_profit(scripted):
    # Two open allocations: the SL exit trips the daily-loss guard (bar 4), the second
    # allocation's TP exit realizes profit and lifts it inside the same UTC day (bar 5).
    scripted({2, 3, 6}, set())
    closes = [100, 100, 100, 100, 96, 125, 100, 100]
    atrs = ["2", "2", "2", "20", "2", "2", "2", "2"]
    rows = bar_rows(NOON, closes, atrs)
    contract = make_contract(NOON, 8, warmup=2, maxDailyLossR=0.5)
    result = assert_node_parity(contract, rows)
    trace = []
    result, _ = run(contract, rows, 3, trace=trace)
    lifted = {"kind": "MAX_DAILY_LOSS", "start_time": NOON + 4 * MINUTE,
              "end_time": NOON + 5 * MINUTE, "persistent": False}
    assert result["guards"]["pause"]["periods"] == [lifted]
    assert result["guards"]["pause"]["active_kinds"] == []
    assert result["counters"]["fills"]["exit_by_reason"] == {"SL": 1, "TP": 1}
    assert result["counters"]["episodes"] == {"closed": 1, "losing": 1}
    # Guard state at bar 6: lifted, so the BUY is not rejected by the daily-loss guard.
    at_six = next(step for step in trace if step["index"] == 6)
    assert at_six["guards"] == [] and at_six["decisions"][0]["outcome"] == "FILLED"
    assert next(step for step in trace if step["index"] == 4)["guards"] == []
    guard_reason_agrees_with_state(trace)


# --- 7. cost model V2 denied ------------------------------------------------------


def test_07_cost_model_v2_denied_and_never_imported(scripted):
    scripted(set(), set())
    rows = bar_rows(NOON, [100] * 3, ["2"] * 3)
    for model in (
        {**make_contract(NOON, 3)["model"], "version": "paper-close-cost-v2"},
        {"version": "paper-close-cost-v2", "price_tick": "0.01", "quantity_step": "0.00001",
         "fee_bps": "10", "slippage_bps": "1", "risk_percent": "1", "spread_bps": "2"},
        {**make_contract(NOON, 3)["model"], "version": "paper-close-v3"},
    ):
        contract = make_contract(NOON, 3)
        contract["model"] = model
        fails("PF2_UNSUPPORTED_EXECUTION_MODEL", make_request(contract, rows))
    # Static and transitive guards: no import of the isolated V2 finalizer.
    source = Path(pf2_replay.__file__).read_text(encoding="utf-8")
    imported = {n.module for n in ast.walk(ast.parse(source)) if isinstance(n, ast.ImportFrom)}
    imported |= {a.name for n in ast.walk(ast.parse(source)) if isinstance(n, ast.Import) for a in n.names}
    assert not any("paper_cost_model" in name for name in imported if name)
    probe = subprocess.run([sys.executable, "-c",
        "import sys, robot_quant.pf2_replay; sys.exit(int('robot_quant.paper_cost_model' in sys.modules))"],
        capture_output=True, timeout=120)
    assert probe.returncode == 0, probe.stderr.decode()


def test_07_csv_signal_mode_and_other_profiles_denied(scripted):
    scripted(set(), set())
    rows = bar_rows(NOON, [100] * 3, ["2"] * 3)
    for signal in ({"mode": "BOUND_SIGNAL_CSV", "profile": "SPT_CUSTOM", "artifact_sha256": "b" * 64},
                   {"mode": "EVALUATOR", "profile": "SPT_V4", "source": "x", "snapshot": {}},
                   {"mode": "OTHER"}):
        contract = make_contract(NOON, 3)
        contract["signal"] = signal
        fails("PF2_UNSUPPORTED_SIGNAL_MODE", make_request(contract, rows))


# --- 8. cancel and deadline -------------------------------------------------------


def test_08_cancel_and_deadline_are_atomic_and_resumable(scripted, monkeypatch):
    scripted(S3_BUYS, S3_EXITS)
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    rows = s3_rows(NOON)
    expected, expected_state = run(contract, rows, 12)
    head = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[:4]))
    checkpoint = wire(head["checkpoint"])
    untouched = copy.deepcopy(checkpoint)
    trace = []
    # Cancelled before the first bar, and again mid-chunk (cancel poll every 2 bars).
    fails("PF2_CANCELLED", make_request(contract, rows[4:], checkpoint),
          should_stop=lambda: True, trace=trace)
    monkeypatch.setattr(pf2_replay, "CANCEL_CHECK_BARS", 2)
    polls = []

    def stop_on_third_poll():
        polls.append(1)
        return len(polls) >= 3

    fails("PF2_CANCELLED", make_request(contract, rows[4:], checkpoint),
          should_stop=stop_on_third_poll, trace=trace)
    assert len(polls) == 3  # Polled between bars, not just at chunk edges.
    assert trace == [] and checkpoint == untouched  # No partial trace, checkpoint intact.
    # Deadline: fake clock advances one unit per read.
    ticks = iter(range(100))
    monkeypatch.setattr(pf2_replay, "_monotonic", lambda: next(ticks))
    fails("PF2_DEADLINE_EXCEEDED", make_request(contract, rows[4:], checkpoint),
          deadline_monotonic=2, trace=trace)
    monkeypatch.setattr(pf2_replay, "_monotonic", lambda: 10.0)
    fails("PF2_DEADLINE_EXCEEDED", make_request(contract, rows[4:], checkpoint),
          deadline_monotonic=10.0)
    assert trace == [] and checkpoint == untouched
    # Cancel outranks deadline; a future deadline and quiet poll do not interfere.
    fails("PF2_CANCELLED", make_request(contract, rows[4:], checkpoint),
          should_stop=lambda: True, deadline_monotonic=1.0)
    resumed = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[4:], checkpoint),
        should_stop=lambda: False, deadline_monotonic=11.0)
    assert wire(resumed["result"]) == expected and wire(resumed["checkpoint"]) == expected_state
    for bad in ("soon", True):
        fails("PF2_REQUEST_INVALID", make_request(contract, rows[4:], checkpoint),
              deadline_monotonic=bad)
    fails("PF2_REQUEST_INVALID", make_request(contract, rows[4:], checkpoint), should_stop=1)


# --- 9. checkpoint fail-closed ----------------------------------------------------


def s3_checkpoint(scripted):
    scripted(S3_BUYS, S3_EXITS)
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    rows = s3_rows(NOON)
    head = pf2_replay.evaluate_pf2_chunk(make_request(contract, rows[:8]))
    return contract, rows, wire(head["checkpoint"])


def test_09_checkpoint_tamper_identity_cursor_size_and_counters_fail_closed(scripted):
    contract, rows, checkpoint = s3_checkpoint(scripted)
    untouched = copy.deepcopy(checkpoint)
    tail = rows[8:]
    assert pf2_replay.evaluate_pf2_chunk(make_request(contract, tail, checkpoint))["result"]
    assert checkpoint == untouched
    # Rows must continue exactly where the checkpoint stopped.
    for chunk in (rows[9:], rows[7:], [], rows[8:] + rows[:1]):
        fails("PF2_ROW_CONTINUITY", make_request(contract, chunk, checkpoint))
    # Identity: any contract change or plan swap breaks the binding.
    swaps = (("plan_hash", "b" * 64), ("deployment_id", "other"),
             (("model", "fee_bps"), "11"), (("policy", "maxTradesPerDay"), 7),
             (("dataset", "warmup_bars"), 3), (("limits", "max_samples"), 49),
             (("bridge", "rr"), "2"), (("capital", "cash"), "999"),
             (("signal", "source"), "other-source"))
    for path, value in swaps:
        changed = copy.deepcopy(contract)
        if isinstance(path, tuple):
            changed[path[0]][path[1]] = value
        else:
            changed[path] = value
        fails("PF2_CHECKPOINT_INVALID", make_request(changed, tail, checkpoint))
    # Integrity: a modified body without re-hashing.
    for key, value in (("next_bar", 7), ("last_time", 1), ("version", "x")):
        damaged = copy.deepcopy(checkpoint)
        damaged[key] = value
        fails("PF2_CHECKPOINT_INVALID", make_request(contract, tail, damaged))
    # Bodies that are otherwise well-formed: only the hash can notice.
    quiet = copy.deepcopy(checkpoint)
    quiet["paper"]["cash"] = "999.5"
    fails("PF2_CHECKPOINT_INVALID", make_request(contract, tail, quiet))
    quiet = copy.deepcopy(checkpoint)
    quiet["samples"]["fills"][0]["price"] = "1"
    fails("PF2_CHECKPOINT_INVALID", make_request(contract, tail, quiet))
    resigned = resign(copy.deepcopy(quiet))  # Re-hashed, the same body is structurally fine.
    assert pf2_replay.evaluate_pf2_chunk(make_request(contract, tail, resigned))["result"]
    # Structure and cursor, integrity re-computed so only the semantic check can object.
    def tamper(change):
        damaged = copy.deepcopy(checkpoint)
        change(damaged)
        return resign(damaged)

    cases = [
        lambda d: d.update(version="pf2-replay-chunk-v0"),
        lambda d: d.update(extra=1),
        lambda d: d.pop("samples"),
        lambda d: d.update(next_bar=0),
        lambda d: d.update(next_bar=12),
        lambda d: d.update(next_bar=True),
        lambda d: d.update(next_bar="8"),
        lambda d: d.update(last_time=d["last_time"] + MINUTE),
        lambda d: d["identity"].update(contract_digest="0" * 64),
        lambda d: d["evaluator"].update(index=3),
        lambda d: d["paper"].update(cash="NaN"),
        lambda d: d["paper"].update(cash="-1"),
        lambda d: d["paper"]["positions"].update(bogus={"quantity": "1", "entry_price": "1"}),
        lambda d: d["paper"].update(loss_streak=5),
        lambda d: d["paper"].update(pnl="-99999"),  # Flat with a stale pnl / initial risk.
        lambda d: d["paper"].update(initial_risk="5"),
        lambda d: d["counters"]["fills"].update(buy=d["counters"]["fills"]["buy"] + 1),
        lambda d: d["counters"]["orders"].update(accepted=d["counters"]["orders"]["accepted"] + 1),
        lambda d: d["counters"]["orders"]["rejected_by_reason"].update(x=1),
        lambda d: d["counters"]["fills"]["exit_by_reason"].update(BOGUS=1),
        lambda d: d["counters"]["intents"].update(exit_sl=-1),
        lambda d: d["counters"]["intents"].update(buy=True),
        lambda d: d["counters"]["episodes"].update(losing=d["counters"]["episodes"]["closed"] + 1),
        lambda d: d["counters"]["signals"].update(buy=99),
        lambda d: d["counters"]["signals"].update(buy_evaluated=d["counters"]["signals"]["buy"] + 1),
        lambda d: d["counters"]["warmup_intents"].update(buy=9),
        lambda d: d["counters"].pop("episodes"),
        lambda d: d["counters"].update(extra={}),
        lambda d: d["samples"]["fills"].append({}),
        lambda d: d["samples"]["rejections"].pop(),
        lambda d: d["guards"]["open"].update(KILL_SWITCH=1799928120000),
        lambda d: d["guards"]["open"].update(MAX_TRADES_PER_DAY=1),
        lambda d: d["guards"]["open"].update(BOGUS=1799928120000),
        lambda d: d["guards"].update(open={}),
        lambda d: d["guards"].update(dropped=1),
        lambda d: d["guards"]["closed"].append({"kind": "LOSS_STREAK", "start_time": 1,
                                                "end_time": 2, "persistent": True}),
        lambda d: d.update(guards="none"),
    ]
    for index, change in enumerate(cases):
        with pytest.raises(pf2_replay.PF2Error) as raised:
            pf2_replay.evaluate_pf2_chunk(make_request(contract, tail, tamper(change)))
        assert raised.value.code == "PF2_CHECKPOINT_INVALID", index
    # A consistent cursor advance still fails: the evaluator state belongs to bar 8.
    advanced = tamper(lambda d: d.update(next_bar=9, last_time=d["last_time"] + MINUTE))
    fails("PF2_CHECKPOINT_INVALID", make_request(contract, rows[9:], advanced))
    for junk in ([], "checkpoint", 7, {}):
        fails("PF2_CHECKPOINT_INVALID", make_request(contract, tail, junk))
    # Oversize: bigger than the contract state limit, even if hash and shape are right.
    oversize = copy.deepcopy(checkpoint)
    oversize["padding"] = "x" * (pf2_replay.STATE_LIMIT + 1)
    fails("PF2_CHECKPOINT_INVALID", make_request(contract, tail, resign(oversize)))
    small = copy.deepcopy(contract)
    small["limits"]["max_state_bytes"] = 4096
    assert len(pf2_replay.canonical(checkpoint)) < 4096
    padded = copy.deepcopy(checkpoint)
    padded["samples"]["fills"] += [padded["samples"]["fills"][0]] * 20
    fails("PF2_CHECKPOINT_INVALID", make_request(small, tail, resign(padded)))
    assert checkpoint == untouched


# --- 10. bounds -------------------------------------------------------------------


def cycle_signals(total, period=100):
    """BUY every `period` bars, native EXIT half a period later (flat price)."""
    return {i for i in range(0, total, period)}, {i + period // 2 for i in range(0, total, period)}


def test_10_samples_output_and_state_bounds(scripted):
    scripted(S3_BUYS, S3_EXITS)
    rows = s3_rows(NOON)
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    full, _ = run(contract, rows, 12)
    assert len(full["samples"]["fills"]) == 6 and len(full["samples"]["rejections"]) == 3
    for cap in (2, 0):
        capped = copy.deepcopy(contract)
        capped["limits"]["max_samples"] = cap
        result, state = run(capped, rows, 5)
        counters = result["counters"]
        assert len(result["samples"]["fills"]) == min(cap, counters["fills"]["buy"] + counters["fills"]["exit"])
        assert len(result["samples"]["rejections"]) == min(cap, counters["orders"]["rejected"])
        assert counters == full["counters"]  # Sampling never changes counting.
        assert state["samples"] == result["samples"]
    # First-N sampling: the retained fills are the earliest ones.
    assert full["samples"]["fills"][0]["time"] == NOON + 2 * MINUTE
    # Result byte limit: only the final chunk can exceed it; fail closed, no partial.
    tight = copy.deepcopy(contract)
    tight["limits"]["max_output_bytes"] = 1024
    assert len(pf2_replay.canonical(full)) > 1024
    head = pf2_replay.evaluate_pf2_chunk(make_request(tight, rows[:8]))
    assert head["result"] is None
    fails("PF2_LIMIT_EXCEEDED", make_request(tight, rows[8:], wire(head["checkpoint"])))
    # State byte limit on emitted checkpoints.
    scripted(*cycle_signals(2000))
    busy = make_contract(NOON, 2000, warmup=0)
    busy["limits"].update(max_state_bytes=4096, max_samples=200)
    busy_rows = bar_rows(NOON, [100] * 2000, ["2"] * 2000)
    fails("PF2_LIMIT_EXCEEDED", make_request(busy, busy_rows))
    # Limit values themselves are bounded.
    for name, value in (("max_bars", 10001), ("max_state_bytes", pf2_replay.STATE_LIMIT + 1),
                        ("max_output_bytes", pf2_replay.IPC_LIMIT + 1), ("max_samples", 201)):
        wide = copy.deepcopy(contract)
        wide["limits"][name] = value
        fails("PF2_LIMIT_EXCEEDED", make_request(wide, rows))


def test_10_ten_thousand_bar_ceiling_and_eight_utc_days(scripted):
    total = pf2_replay.MAX_BARS
    assert total == 10_000
    first = MIDNIGHT - MINUTE  # One minute before midnight: 10K bars touch 8 UTC days.
    scripted(*cycle_signals(total))
    contract = make_contract(first, total, warmup=0)
    rows = bar_rows(first, [100] * total, ["2"] * total)
    result, state = run(contract, rows, 2500)
    assert result["window"]["bars_seen"] == 10_000 and result["window"]["evaluated_bars"] == 10_000
    assert result["counters"]["fills"]["buy"] == 100 and result["counters"]["fills"]["exit"] == 100
    days = state["paper"]["daily"]
    assert len(days) == 8 <= pf2_replay.MAX_DAILY_DAYS - 1
    restored = PaperState(deployment_id="fixture", multiplier=Decimal(1), rr=Decimal(1),
        model=PaperModel(slippage_bps=Decimal(0)), policy=policy(), equity=Decimal(1000),
        cash=Decimal(1000), broker="binance-global", symbol="BTCUSDT")
    restored.import_state(state["paper"])  # Export/import still works at the ceiling.
    assert restored.export_state() == state["paper"]
    # One bar over: the contract is refused, whatever else it says.
    over = make_contract(first, total + 1, warmup=0)
    over["limits"]["max_bars"] = total + 1
    fails("PF2_LIMIT_EXCEEDED", make_request(over, rows))
    fails("PF2_LIMIT_EXCEEDED", make_request(make_contract(first, total + 1, warmup=0), rows))


def test_10_real_spt_ten_thousand_bars_restart_equal(real_spt):
    total = pf2_replay.MAX_BARS
    first = MIDNIGHT - MINUTE
    rows = real_rows(first, total)
    contract = make_contract(first, total, warmup=500, slippage="1", rr="2", **GUARDED)
    result, state = run(contract, rows, 2500)
    assert result["window"] == {"first_time": first, "evaluation_start_time": first + 500 * MINUTE,
        "last_time": first + (total - 1) * MINUTE, "development_end_time": first + (total - 1) * MINUTE,
        "holdout_start_time": first + (total + 9) * MINUTE, "bars_seen": total,
        "warmup_bars": 500, "evaluated_bars": total - 500}
    check_invariants(result)
    assert 7 <= len(state["paper"]["daily"]) <= pf2_replay.MAX_DAILY_DAYS
    assert run(contract, rows, total) == (result, state)


def test_10_more_than_nine_fill_days_fail_closed(scripted, monkeypatch):
    # 50K blocker: PaperState cannot checkpoint more than 9 daily rows. Lift the 10K
    # ceiling only in this test to reach ten fill days; the run must fail closed.
    monkeypatch.setattr(pf2_replay, "MAX_BARS", 20_000)
    total = 10 * 24 * 60 + 500
    scripted(*cycle_signals(total))
    contract = make_contract(MIDNIGHT, total, warmup=0)
    contract["limits"]["max_bars"] = 20_000
    rows = bar_rows(MIDNIGHT, [100] * total, ["2"] * total)
    fails("PF2_LIMIT_EXCEEDED", make_request(contract, rows))
    # And a checkpoint that already carries ten days is refused on import.
    _, _, checkpoint = s3_checkpoint(scripted)
    forged = copy.deepcopy(checkpoint)
    stats = next(iter(forged["paper"]["daily"].values()))
    forged["paper"]["daily"] = {f"2027-01-{day:02d}": stats for day in range(1, 11)}
    contract2 = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    scripted(S3_BUYS, S3_EXITS)
    fails("PF2_CHECKPOINT_INVALID", make_request(contract2, s3_rows(NOON)[8:], resign(forged)))


# --- 11. initial state ------------------------------------------------------------


def test_11_initial_state_fresh_only(scripted):
    scripted(S3_BUYS, S3_EXITS)
    rows = s3_rows(NOON)
    # FRESH with a carried loss streak: a persistent pause from evaluation start.
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, pauseAfterLossStreak=1)
    contract["initial_state"] = {"kind": "FRESH", "loss_streak": 1}
    result, _ = run(contract, rows, 5)
    pause = result["guards"]["pause"]
    assert pause["persistent"] is True and result["guards"]["loss_streak_final"] == 1
    assert pause["periods"] == [{"kind": "LOSS_STREAK", "start_time": NOON + S3_WARMUP * MINUTE,
                                 "end_time": None, "persistent": True}]
    assert result["counters"]["fills"]["buy"] == 0
    assert result["account"]["cash"] == "1000"
    guard = GUARD_REASONS["LOSS_STREAK"]
    assert result["counters"]["orders"]["rejected_by_reason"][guard] == result["counters"]["intents"]["buy"]
    # Streak below the threshold carries into the loss counter without pausing.
    relaxed = make_contract(NOON, 12, warmup=S3_WARMUP, pauseAfterLossStreak=3)
    relaxed["initial_state"] = {"kind": "FRESH", "loss_streak": 2}
    assert run(relaxed, rows, 12)[0]["guards"]["loss_streak_final"] >= 1
    # Open positions, daily carry or any other kind is not supported by this V1 slice.
    for initial in ({"kind": "CARRIED", "loss_streak": 0},
                    {"kind": "FRESH", "loss_streak": 0, "positions": {}},
                    {"kind": "FRESH", "loss_streak": 0, "daily": {}},
                    {"kind": "RESUME", "positions": {"x": {"quantity": "1", "entry_price": "1"}}}):
        changed = make_contract(NOON, 12, warmup=S3_WARMUP)
        changed["initial_state"] = initial
        fails("PF2_INITIAL_STATE_UNSUPPORTED", make_request(changed, rows))
    for initial in ({"kind": "FRESH"}, {"kind": "FRESH", "loss_streak": -1},
                    {"kind": "FRESH", "loss_streak": True}, {"loss_streak": 0}, "FRESH", None):
        changed = make_contract(NOON, 12, warmup=S3_WARMUP)
        changed["initial_state"] = initial
        fails("PF2_REQUEST_INVALID", make_request(changed, rows))


# --- extra: request, row and transport validation ---------------------------------


def test_12_request_and_row_validation_fail_closed(scripted):
    scripted(set(), set())
    first = NOON
    rows = bar_rows(first, [100] * 4, ["2"] * 4)
    contract = make_contract(first, 4)
    base = make_request(contract, rows)
    fails("PF2_REQUEST_INVALID", {**base, "version": "pf2-replay-chunk-v0"})
    fails("PF2_REQUEST_INVALID", {**base, "extra": 1})
    fails("PF2_REQUEST_INVALID", {k: v for k, v in base.items() if k != "rows"})
    for path, value in ((("bridge", "rr"), "0"), (("bridge", "rr"), 1.5), (("bridge", "rr"), "1e2"),
                        (("model", "fee_bps"), "-1"), (("model", "price_tick"), "0"),
                        (("capital", "cash"), "0"), (("capital", "equity"), "NaN"),
                        (("policy", "killSwitch"), "no"), (("policy", "sideMode"), "SIDEWAYS"),
                        (("policy", "maxTradesPerDay"), True), (("policy", "maxSignalAgeSeconds"), -1),
                        (("policy", "unknownKey"), 1), (("dataset", "total_bars"), 0),
                        (("dataset", "warmup_bars"), 4), (("dataset", "first_time"), NOON + 1),
                        (("dataset", "extra"), 1)):
        changed = copy.deepcopy(contract)
        changed[path[0]][path[1]] = value
        fails("PF2_REQUEST_INVALID", make_request(changed, rows))
    for name, value in (("broker", "other"), ("symbol", "ETHUSDT"), ("deployment_id", "bad:id"),
                        ("plan_hash", "A" * 64), ("plan_hash", "a" * 63), ("version", "pf2-replay-job-v0"),
                        ("extra", 1)):
        changed = copy.deepcopy(contract)
        changed[name] = value
        fails("PF2_REQUEST_INVALID", make_request(changed, rows))
    # Rows: gaps, duplicates, order, shape, decimals, venue tick, OHLC invariants.
    fails("PF2_ROW_CONTINUITY", make_request(contract, [rows[0], rows[2], rows[3]]))
    fails("PF2_ROW_CONTINUITY", make_request(contract, [rows[0], rows[0], rows[1]]))
    fails("PF2_ROW_CONTINUITY", make_request(contract, [rows[1], rows[0]]))
    fails("PF2_ROW_CONTINUITY", make_request(contract, [*rows, rows[0]]))
    fails("PF2_REQUEST_INVALID", make_request(contract, "rows"))
    fails("PF2_REQUEST_INVALID", make_request(contract, [[1, 2]]))
    fails("PF2_REQUEST_INVALID", make_request(contract, [{**rows[0], "extra": 1}]))
    fails("PF2_REQUEST_INVALID", make_request(contract, [{**rows[0], "time": "1"}]))
    for change in ({"close": 100}, {"close": "1e2"}, {"open": "NaN"}, {"volume": "-1"},
                   {"low": "101"}, {"high": "99"}, {"atr14": "-1"}, {"price_tick": "0.02"},
                   {"quantity_step": "0.1"}):
        fails("PF2_ROW_INVALID", make_request(contract, [{**rows[0], **change}, *rows[1:]]))
    tick = {**rows[0], "price_tick": "0.01", "quantity_step": "0.00001", "atr14": None}
    assert pf2_replay.evaluate_pf2_chunk(make_request(contract, [tick, *rows[1:]]))["result"]


def test_12_times_beyond_the_datetime_range_are_refused(scripted):
    scripted(set(), set())
    huge = (pf2_replay.MAX_TIME_MS // MINUTE + 1) * MINUTE
    contract = make_contract(huge, 3)
    fails("PF2_REQUEST_INVALID", make_request(contract, bar_rows(huge, [100] * 3, ["2"] * 3)))


def test_12_unenrolled_snapshot_makes_evaluator_unavailable():
    contract = make_contract(NOON, 3)
    contract["signal"]["snapshot"] = {"source_hash": "0" * 64}
    fails("PF2_EVALUATOR_UNAVAILABLE", make_request(contract, bar_rows(NOON, [100] * 3, ["2"] * 3)))


def contains_float(value):
    if isinstance(value, float):
        return True
    if isinstance(value, dict):
        return any(contains_float(child) for child in value.values())
    if isinstance(value, list):
        return any(contains_float(child) for child in value)
    return False


def test_13_shared_json_is_ascii_decimal_strings_without_eta_or_admission(scripted):
    scripted(S3_BUYS, S3_EXITS)
    result, state = run(make_contract(NOON, 12, warmup=S3_WARMUP, pauseAfterLossStreak=1),
                        s3_rows(NOON), 12)
    for document in (result, state):
        pf2_replay.canonical(document).decode("ascii")
        assert_no_eta(document)
        assert not contains_float(document)
    for value in result["account"].values():
        assert isinstance(value, (str, int))
    assert isinstance(result["account"]["cash"], str)
    for sample in result["samples"]["fills"]:
        assert all(isinstance(sample[k], str) for k in ("quantity", "price", "notional", "fee"))
    assert result["admission"]["evaluator_admission"] is False
    assert result["execution_model_version"] == "paper-close-v1"
    assert result["plan_hash"] == PLAN_HASH
    assert result["guards"]["pause"]["persistent"] is True
    assert "V1_ONLY" in result["limitations"]
    assert "SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING" in result["limitations"]
    assert set(result) == {"version", "plan_hash", "execution_model_version", "window", "counters",
                           "derived", "guards", "account", "samples", "admission", "limitations"}


class Streams:
    def __init__(self, data=b""):
        self.buffer = io.BytesIO(data)


def call_main(monkeypatch, payload):
    stdout = Streams()
    monkeypatch.setattr(sys, "stdin", Streams(payload))
    monkeypatch.setattr(sys, "stdout", stdout)
    try:
        pf2_replay.main()
        code = 0
    except SystemExit as exit_:
        code = exit_.code
    return code, stdout.buffer.getvalue()


def test_14_chunk_main_round_trip_without_io_handshake(scripted, monkeypatch):
    scripted(S3_BUYS, S3_EXITS)
    contract = make_contract(NOON, 12, warmup=S3_WARMUP)
    request = make_request(contract, s3_rows(NOON))
    code, out = call_main(monkeypatch, json.dumps(request).encode())
    assert code == 0 and out.endswith(b"\n")
    assert json.loads(out) == wire(pf2_replay.evaluate_pf2_chunk(request))
    assert out[:-1] == pf2_replay.canonical(json.loads(out))
    for payload, expected in (
        (b"not json", "PF2_REQUEST_INVALID"),
        (b'{"a":NaN}', "PF2_REQUEST_INVALID"),
        (b'{"a":1,"a":2}', "PF2_REQUEST_INVALID"),
        (b"[]", "PF2_REQUEST_INVALID"),
        (json.dumps({**request, "rows": rows_beyond(request)}).encode(), "PF2_HOLDOUT_BOUNDARY_VIOLATION"),
        (b" " * (pf2_replay.IPC_LIMIT + 1), "PF2_LIMIT_EXCEEDED"),
    ):
        code, out = call_main(monkeypatch, payload)
        assert code == 1 and json.loads(out) == {"error": expected}
    monkeypatch.delenv("QUANT_IO_TERMINAL_PROTOCOL", raising=False)


def rows_beyond(request):
    rows = copy.deepcopy(request["rows"])
    rows[-1]["time"] = request["contract"]["dataset"]["holdout_start_time"] + MINUTE
    return rows


def test_14_module_entry_point_runs_as_a_process_without_handshake(monkeypatch):
    monkeypatch.delenv("QUANT_IO_TERMINAL_PROTOCOL", raising=False)
    contract = make_contract(NOON, 3)
    contract["signal"]["snapshot"] = {"source_hash": "0" * 64}  # Real enrollment refuses it.
    request = make_request(contract, bar_rows(NOON, [100] * 3, ["2"] * 3))
    for payload, expected in ((b"not json", "PF2_REQUEST_INVALID"),
                              (json.dumps(request).encode(), "PF2_EVALUATOR_UNAVAILABLE")):
        done = subprocess.run([sys.executable, "-m", "robot_quant.pf2_replay"], input=payload,
                              capture_output=True, timeout=120)
        assert done.returncode == 1
        assert done.stdout == b'{"error":"' + expected.encode() + b'"}\n'


# --- audit fixes: sizing label, error hygiene, aliasing, non-finite policy, pins ---


def test_15_sizing_adjusted_is_quantity_step_rounding_not_a_budget_cap(scripted):
    scripted(S3_BUYS, S3_EXITS)
    trace = []
    result, _ = run(make_contract(NOON, 12, warmup=S3_WARMUP), s3_rows(NOON), 12, trace=trace)
    assert "capped" not in result["counters"]["orders"]
    fills = [d for step in trace for d in step["decisions"] if d["outcome"] == "FILLED"]
    adjusted = [d for d in fills if d["sizing_outcome"] == "CAPPED"]
    assert len(adjusted) == result["counters"]["orders"]["sizing_adjusted"] > 0
    # Bar 5 has ample cash and budget; only the venue quantity step rounds it down.
    bar_five = next(d for d in fills if d["time"] == NOON + 5 * MINUTE)
    assert bar_five["sizing_adjustment"]["reason"] == "Capped/rounded to verified venue quantity step"
    assert Decimal(bar_five["notional"]) < Decimal("600")  # far below cash and notional limits


def test_16_unexpected_errors_map_to_one_code_without_echo(scripted, monkeypatch):
    contract = make_contract(NOON, 3)
    request = make_request(contract, bar_rows(NOON, [100] * 3, ["2"] * 3))

    def leaked(error):
        text = "".join(traceback.format_exception(error))
        return "secret" in text or "secret" in str(error) or "secret" in repr(error.args)

    class Broken(ScriptedSource):
        def step(self, row):
            raise IndexError("secret-row-content")

    monkeypatch.setattr(pf2_replay, "build_signal_source", lambda signal: Broken(set(), set()))
    error = fails("PF2_EVALUATION_FAILED", request)
    assert not leaked(error) and error.__cause__ is None and error.__suppress_context__

    def broken_build(signal):
        raise IndexError("secret-build")

    monkeypatch.setattr(pf2_replay, "build_signal_source", broken_build)
    assert not leaked(fails("PF2_EVALUATOR_UNAVAILABLE", request))
    scripted(set(), set())

    def secret_stop():
        raise KeyError("secret-callback")

    assert not leaked(fails("PF2_EVALUATION_FAILED", request, should_stop=secret_stop))

    class BadSink:
        def extend(self, items):
            raise RuntimeError("secret-sink")

    # Failure outside every inner guard still ends as the same single code.
    assert not leaked(fails("PF2_EVALUATION_FAILED", request, trace=BadSink()))
    # A state importer that fails oddly is still a checkpoint problem, not a raw error.
    head = pf2_replay.evaluate_pf2_chunk(make_request(contract, request["rows"][:1]))
    state = wire(head["checkpoint"])

    class OddImport(ScriptedSource):
        def import_state(self, state, next_bar):
            raise LookupError("secret-state")

    monkeypatch.setattr(pf2_replay, "build_signal_source", lambda signal: OddImport(set(), set()))
    assert not leaked(fails("PF2_CHECKPOINT_INVALID", make_request(contract, request["rows"][1:], state)))


def test_17_result_never_aliases_checkpoint_state(scripted):
    scripted(S3_BUYS, S3_EXITS)
    contract = make_contract(NOON, 12, warmup=S3_WARMUP, maxTradesPerDay=6)
    response = pf2_replay.evaluate_pf2_chunk(make_request(contract, s3_rows(NOON)))
    result, state = response["result"], response["checkpoint"]
    assert result["counters"] == state["counters"] and result["samples"] == state["samples"]
    assert result["counters"] is not state["counters"] and result["samples"] is not state["samples"]
    assert result["counters"]["orders"] is not state["counters"]["orders"]
    frozen = copy.deepcopy(state)
    result["counters"]["fills"]["buy"] += 99
    result["samples"]["fills"].clear()
    assert state == frozen  # Editing the result cannot corrupt the resumable state.


def test_18_non_finite_and_absurd_policy_numbers_are_request_errors(scripted):
    scripted(set(), set())
    rows = bar_rows(NOON, [100] * 3, ["2"] * 3)
    for name, value in (("maxVolatilityPercent", float("inf")), ("maxVolatilityPercent", float("nan")),
                        ("maxVolatilityPercent", -1),
                        ("maxVolatilityPercent", 10**40), ("maxDailyLossR", float("inf")),
                        ("maxRiskPercent", float("nan")), ("maxOrderNotional", "abc"), ("maxDailyNotional", "Infinity")):
        contract = make_contract(NOON, 3)
        contract["policy"][name] = value
        fails("PF2_REQUEST_INVALID", make_request(contract, rows))
    # JSON 1e999 parses to inf without touching parse_constant; still a request error.
    payload = json.dumps(make_request(make_contract(NOON, 3), rows)).replace(
        '"maxVolatilityPercent": 100', '"maxVolatilityPercent": 1e999')
    assert "1e999" in payload
    assert json.loads(payload)["contract"]["policy"]["maxVolatilityPercent"] == float("inf")
    fails("PF2_REQUEST_INVALID", json.loads(payload))


def test_19_pins_for_helpers_imported_from_research_chunk():
    """A change to research_chunk canonical/digest/evaluator export would silently change
    PF-2 checkpoint format and identity; fail here first."""
    value = {"b": [1, "x", None, True], "a": {"z": "0.10", "y": 5, "n": "-0.0"}}
    assert pf2_replay.canonical is research_chunk.canonical
    assert pf2_replay.canonical(value) == b'{"a":{"n":"-0.0","y":5,"z":"0.10"},"b":[1,"x",null,true]}'
    assert pf2_replay.digest(value) == "0d1d5877d6e1358f46b198e7dd1e86587475238b267c78cbd2c8a1ebbd401666"
    assert pf2_replay.canonical({"t": "é"}) == b'{"t":"\\u00e9"}'  # Escaped: ASCII only.
    with pytest.raises(ValueError):
        pf2_replay.canonical({"x": float("nan")})
    assert (pf2_replay.IPC_LIMIT, pf2_replay.STATE_LIMIT) == (8 * 1024 * 1024, 1024 * 1024)
    evaluator = SptCustomEvaluator(CustomSignalInputs())
    keys = {"atr", "direction", "exit_active", "exit_expiry", "exit_zone", "fast", "highs", "index",
            "long_active", "long_expiry", "long_zone", "lower", "lows", "previous", "slow", "st",
            "tr_seed", "trade_start", "upper"}
    assert set(pf2_replay.export_evaluator(evaluator)) == keys
    evaluator.step(100.0, 101.0, 99.0, 100.0)
    frozen = pf2_replay.export_evaluator(evaluator)
    assert frozen["fast"] == "100.0"
    assert frozen["previous"] == ["100.0", "101.0", "99.0", "100.0", "100.0"]
    restored = SptCustomEvaluator(CustomSignalInputs())
    pf2_replay.import_evaluator(restored, frozen, 1)
    assert pf2_replay.export_evaluator(restored) == frozen


# --- terminal protocol (supervised runtime, slice R4) -----------------------------------

PROTOCOL = "quant-io-terminal-v1"
TERMINAL_ACK = b"QUANT_IO_TERMINAL_ACK_V1\n"
READINESS = {
    "QUANT_IO_READY_FILE": "/nonexistent-dir/.pending-fixture",
    "QUANT_IO_READY_DEVICE": "8:0",
    "QUANT_IO_READY_RBPS": "1048576",
    "QUANT_IO_READY_WBPS": "1048576",
}


class BrokenAfterRequest:
    """Stdin double: hands out the request line once, then fails like a broken pipe."""

    def __init__(self, line):
        self.buffer = self
        self.line, self.reads = line, 0

    def tell(self):
        return 0

    def readline(self, limit=-1):
        self.reads += 1
        if self.reads == 1:
            return self.line
        raise OSError("secret-pipe")

    def read(self, size=-1):
        raise OSError("secret-pipe")


def protocol_env(monkeypatch, protocol=PROTOCOL, **changes):
    if protocol is None:
        monkeypatch.delenv("QUANT_IO_TERMINAL_PROTOCOL", raising=False)
    else:
        monkeypatch.setenv("QUANT_IO_TERMINAL_PROTOCOL", protocol)
    for name, value in {**READINESS, **changes}.items():
        if value is None:
            monkeypatch.delenv(name, raising=False)
        else:
            monkeypatch.setenv(name, value)


def call_protocol(monkeypatch, payload, *, probe=None, stdin=None):
    """Runs main() with the readiness probe replaced; returns (code, stdout, stdin, probe calls)."""
    stdin = Streams(payload) if stdin is None else stdin
    stdout, calls = Streams(), []

    def prepare():
        calls.append(stdin.buffer.tell())  # Position of stdin when the probe ran.
        if probe is not None:
            probe()

    monkeypatch.setattr(pf2_replay, "prepare_io_telemetry", prepare)
    monkeypatch.setattr(sys, "stdin", stdin)
    monkeypatch.setattr(sys, "stdout", stdout)
    try:
        pf2_replay.main()
        code = 0
    except SystemExit as exit_:
        code = exit_.code
    return code, stdout.buffer.getvalue(), stdin, calls


def protocol_case(scripted):
    scripted(S3_BUYS, S3_EXITS)
    request = make_request(make_contract(NOON, 12, warmup=S3_WARMUP), s3_rows(NOON))
    line = json.dumps(request).encode() + b"\n"
    return request, line, pf2_replay.canonical(pf2_replay.evaluate_pf2_chunk(request)) + b"\n"


def error_line(code):
    return b'{"error":"' + code.encode() + b'"}\n'


def test_20_protocol_round_trip_probes_first_then_one_line_then_ack(scripted, monkeypatch):
    _, line, expected = protocol_case(scripted)
    protocol_env(monkeypatch)
    code, out, stdin, calls = call_protocol(monkeypatch, line + TERMINAL_ACK)
    assert code == 0
    assert out == expected and out.count(b"\n") == 1
    assert calls == [0]  # The readiness probe ran once, before any stdin byte was read.
    assert stdin.buffer.read() == b""  # Request line and ACK line were both consumed.


def test_20_without_protocol_env_behaviour_is_unchanged(scripted, monkeypatch):
    request, line, expected = protocol_case(scripted)
    protocol_env(monkeypatch, protocol=None)  # Readiness variables alone select nothing.

    def forbidden():
        raise AssertionError("readiness probe must not run without the protocol variable")

    monkeypatch.setattr(pf2_replay, "prepare_io_telemetry", forbidden)
    code, out = call_main(monkeypatch, json.dumps(request).encode())
    assert code == 0 and out == expected
    # The request is read to EOF, not as one line: the protocol's ACK is just trailing junk here.
    code, out = call_main(monkeypatch, line + TERMINAL_ACK)
    assert code == 1 and out == error_line("PF2_REQUEST_INVALID")


def test_20_bad_protocol_environment_is_a_request_error_before_probe_and_stdin(scripted, monkeypatch):
    _, line, _ = protocol_case(scripted)
    cases = [dict(protocol=p) for p in ("quant-io-terminal-v2", "", "QUANT-IO-TERMINAL-V1", "1")]
    cases += [{name: None} for name in READINESS]
    cases += [{name: ""} for name in READINESS]
    for changes in cases:
        protocol_env(monkeypatch, **changes)
        code, out, stdin, calls = call_protocol(monkeypatch, line + TERMINAL_ACK)
        assert code == 1, changes
        assert out == error_line("PF2_REQUEST_INVALID"), changes
        assert calls == [] and stdin.buffer.tell() == 0, changes


def test_20_probe_failure_is_one_code_line_without_echo_and_stdin_stays_unread(scripted, monkeypatch):
    _, line, _ = protocol_case(scripted)
    protocol_env(monkeypatch)
    for failure, expected in ((ValueError("secret-probe"), "PF2_REQUEST_INVALID"),
                              (OSError("secret-probe"), "PF2_EVALUATION_FAILED"),
                              (RuntimeError("secret-probe"), "PF2_EVALUATION_FAILED")):
        def probe(failure=failure):
            raise failure

        code, out, stdin, calls = call_protocol(monkeypatch, line + TERMINAL_ACK, probe=probe)
        assert code == 1 and out == error_line(expected)
        assert calls == [0] and stdin.buffer.tell() == 0
        assert b"secret" not in out


def test_20_request_line_must_be_one_bounded_newline_terminated_line(scripted, monkeypatch):
    request, line, _ = protocol_case(scripted)
    protocol_env(monkeypatch)
    limit = pf2_replay.IPC_LIMIT
    cases = (
        (line[:-1], "PF2_REQUEST_INVALID"),  # No terminator before EOF.
        (b"", "PF2_REQUEST_INVALID"),
        (b"\n" + TERMINAL_ACK, "PF2_REQUEST_INVALID"),  # Empty request line.
        (b"not json\n", "PF2_REQUEST_INVALID"),
        (b'{"a":1,"a":2}\n', "PF2_REQUEST_INVALID"),
        (b'{"a":NaN}\n', "PF2_REQUEST_INVALID"),
        (b" " * (limit + 1) + b"\n", "PF2_LIMIT_EXCEEDED"),
        (b" " * (limit + 2), "PF2_LIMIT_EXCEEDED"),
        (json.dumps({**request, "rows": rows_beyond(request)}).encode() + b"\n" + TERMINAL_ACK,
         "PF2_HOLDOUT_BOUNDARY_VIOLATION"),
    )
    for payload, expected in cases:
        code, out, stdin, calls = call_protocol(monkeypatch, payload)
        assert code == 1 and out == error_line(expected), expected
        assert calls == [0]
    # A failure before the result line leaves the ACK unread: no handshake for an error frame.
    code, out, stdin, _ = call_protocol(monkeypatch, b"not json\n" + TERMINAL_ACK)
    assert stdin.buffer.read() == TERMINAL_ACK


def test_20_ack_line_and_eof_are_required_and_no_second_line_follows_the_result(scripted, monkeypatch):
    _, line, expected = protocol_case(scripted)
    protocol_env(monkeypatch)
    cases = (
        b"",  # The parent closed stdin without an ACK.
        b"\n",
        TERMINAL_ACK[:-1],  # No line terminator.
        b"QUANT_IO_TERMINAL_ACK_V2\n",
        b"quant_io_terminal_ack_v1\n",
        b" " + TERMINAL_ACK,
        TERMINAL_ACK + b"x",  # Extra byte after the ACK.
        TERMINAL_ACK + TERMINAL_ACK,  # A second ACK line is extra input too.
        TERMINAL_ACK + b"\n",
        b"x" * 200 + b"\n",
    )
    for tail in cases:
        code, out, _, _ = call_protocol(monkeypatch, line + tail)
        assert code == 1, tail
        assert out == expected, tail  # Exactly the result line; no error line after it.


def test_20_failure_after_the_result_line_never_writes_a_second_line(scripted, monkeypatch):
    _, line, expected = protocol_case(scripted)
    protocol_env(monkeypatch)
    broken = BrokenAfterRequest(line)
    code, out, _, _ = call_protocol(monkeypatch, b"", stdin=broken)
    assert code == 1 and out == expected and broken.reads == 2
    assert b"secret" not in out

    class WriteFails:
        def __init__(self):
            self.buffer = self
            self.attempts = 0

        def write(self, data):
            self.attempts += 1
            raise OSError("secret-pipe")

        def flush(self):
            raise AssertionError("no flush after a failed write")

    failing = WriteFails()
    monkeypatch.setattr(pf2_replay, "prepare_io_telemetry", lambda: None)
    monkeypatch.setattr(sys, "stdin", Streams(line + TERMINAL_ACK))
    monkeypatch.setattr(sys, "stdout", failing)
    with pytest.raises(SystemExit) as raised:
        pf2_replay.main()
    assert raised.value.code == 1 and failing.attempts == 1  # One attempt, no error line after.


def test_20_module_entry_point_rejects_bad_protocol_environment_without_a_result():
    base = {key: value for key, value in os.environ.items() if not key.startswith("QUANT_IO_")}
    missing = {name: value for name, value in READINESS.items() if name != "QUANT_IO_READY_WBPS"}
    cases = (
        ({"QUANT_IO_TERMINAL_PROTOCOL": "quant-io-terminal-v2", **READINESS}, "PF2_REQUEST_INVALID"),
        ({"QUANT_IO_TERMINAL_PROTOCOL": PROTOCOL}, "PF2_REQUEST_INVALID"),
        ({"QUANT_IO_TERMINAL_PROTOCOL": PROTOCOL, **missing}, "PF2_REQUEST_INVALID"),
        # All four present and well formed, but the readiness directory does not exist: the real
        # probe fails before stdin is read, as one code line.
        ({"QUANT_IO_TERMINAL_PROTOCOL": PROTOCOL, **READINESS}, "PF2_EVALUATION_FAILED"),
    )
    for extra, expected in cases:
        done = subprocess.run([sys.executable, "-m", "robot_quant.pf2_replay"], input=b"",
                              env={**base, **extra}, capture_output=True, timeout=120)
        assert done.returncode == 1, extra
        assert done.stdout == error_line(expected), extra
