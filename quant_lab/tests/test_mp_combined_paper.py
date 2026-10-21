"""Combined multi-Pine evaluator (RD-MP-24 to RD-MP-27, T-P1 to T-P5, F3 to F9, F13, F16, F24, F29).

Library level only: no database, no source bytes, no network. Signals come from the real SPT
Custom evaluator (``evaluate_bars``) with frozen inputs, or from the scripted vectors of
``scripted-cases-v1.json`` (Option B, mechanics only, ``fixture_source`` ``scripted-signals-v1``).
"""

import hashlib
import inspect
import json
import re
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import fields
from decimal import Decimal
from pathlib import Path

import pytest

from robot_quant import mp_combined_paper as mp
from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, BridgeIntent, BridgeReplay, PaperModel
from robot_quant.mp_combined_paper import (
    LEDGER_KEYS,
    SAME_BAR_ORDER,
    BridgePair,
    MemberSignals,
    combined_paper_replay,
)
from robot_quant.ql3a import canonical, mark_period
from robot_quant.spt_custom_evaluator import CustomSignalInputs, evaluate_bars

ROOT = Path(__file__).resolve().parents[2]
FIXTURES = ROOT / "test" / "fixtures" / "mp-combined"
SRC = ROOT / "quant_lab" / "src"


def sha(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


# --------------------------------------------------------------------------------- fixtures


@pytest.fixture(scope="module")
def manifest():
    return json.loads((FIXTURES / "manifest.json").read_text())


@pytest.fixture(scope="module")
def rows():
    return json.loads((FIXTURES / "bars-v1.json").read_text())["bars"]


@pytest.fixture(scope="module")
def bars(rows):
    return [bar_of(row) for row in rows]


@pytest.fixture(scope="module")
def signals(manifest, rows):
    return {
        name: tuple((e.buy, e.native_exit) for e in evaluate_bars(rows, inputs_of(manifest, name)))
        for name in ("M1", "M2", "M2_ZERO")
    }


@pytest.fixture(scope="module")
def scripted():
    return json.loads((FIXTURES / "scripted-cases-v1.json").read_text())


def bar_of(row):
    return BridgeBar(
        row["time"], *(Decimal(row[k]) for k in ("open", "high", "low", "close", "volume")),
        Decimal(row["atr14"]),
    )


def inputs_of(manifest, name):
    return CustomSignalInputs.from_source_values(manifest["members"][name]["inputs"])


def model_of(raw, factor=1):
    return PaperModel(
        price_tick=Decimal(raw["price_tick"]), quantity_step=Decimal(raw["quantity_step"]),
        fee_bps=Decimal(raw["fee_bps"]) * factor, slippage_bps=Decimal(raw["slippage_bps"]) * factor,
        risk_percent=Decimal(raw["risk_percent"]), version=raw["version"],
    )


def pair_of(raw):
    return BridgePair(Decimal(raw["atr_multiplier"]), Decimal(raw["rr"]))


def fixture_run(manifest, bars, rows, members, *, pair=None, model=None, policy=None):
    """members: list of (deployment_id, signals). Ordinals follow list position."""
    return combined_paper_replay(
        [MemberSignals(i + 1, dep, sig) for i, (dep, sig) in enumerate(members)],
        bars, pair_of(pair or manifest["pair"]),
        model=model or model_of(manifest["model"]), policy=policy or manifest["policy"],
        equity=Decimal(manifest["capital"]["equity"]), cash=Decimal(manifest["capital"]["cash"]),
        broker=manifest["market"]["broker"], symbol=manifest["market"]["symbol"],
        start_time=rows[manifest["split"]["warmup"]]["time"], same_bar_order=SAME_BAR_ORDER,
    )


def reference_run(manifest, bars, rows, deployment_id, sig, *, pair=None, model=None, policy=None):
    p = pair_of(pair or manifest["pair"])
    return paper_replay(
        [(bar, buy, exit_) for bar, (buy, exit_) in zip(bars, sig, strict=True)],
        deployment_id=deployment_id, multiplier=p.atr_multiplier, rr=p.rr,
        model=model or model_of(manifest["model"]), policy=policy or manifest["policy"],
        equity=Decimal(manifest["capital"]["equity"]), cash=Decimal(manifest["capital"]["cash"]),
        broker=manifest["market"]["broker"], symbol=manifest["market"]["symbol"],
        start_time=rows[manifest["split"]["warmup"]]["time"],
    )


def pairs_of(signals):
    """Scripted vectors are {buy: [...], native_exit: [...]}; (buy, exit) pairs are accepted too."""
    if isinstance(signals, dict):
        return tuple(zip(signals["buy"], signals["native_exit"], strict=True))
    return tuple(tuple(s) for s in signals)


def case_inputs(case):
    bars = [bar_of(row) for row in case["bars"]]
    members = [
        MemberSignals(m["ordinal"], m["deployment_id"], pairs_of(m["signals"]))
        for m in case["members"]
    ]
    return bars, members


def run_case(case, *, members=None, replay_factory=None):
    bars, own = case_inputs(case)
    kwargs = dict(
        model=model_of(case["model"]), policy=case["policy"], equity=Decimal(case["capital"]["equity"]),
        cash=Decimal(case["capital"]["cash"]), broker=case["broker"], symbol=case["symbol"],
        start_time=None, same_bar_order=case["same_bar_order"],
    )
    if replay_factory is not None:
        return mp._run(members or own, bars, pair_of(case["pair"]), replay_factory=replay_factory, **kwargs)
    return combined_paper_replay(members or own, bars, pair_of(case["pair"]), **kwargs)


def member_diag(result, deployment_id):
    (entry,) = [m for m in result["diagnostics"]["members"] if m["deployment_id"] == deployment_id]
    return entry


def by_id(scripted, case_id):
    return next(c for c in scripted["cases"] if c["id"] == case_id)


def outline(result):
    """Decisions as (bar index, deployment, event, outcome, detail) with the bar index from `time`."""
    return [
        (d["entry_ref"].rsplit(":", 2)[0], d["event_type"], d["outcome"],
         d["reason"] if d["outcome"] == "REJECTED" else d["sizing_outcome"])
        for d in result["ledger"]["decisions"]
    ]


# ---------------------------------------------------------------- T-P1 one-member equivalence


@pytest.mark.parametrize("name", ["M1", "M2"])
@pytest.mark.parametrize("pair", [("2", "1.5"), ("1", "1"), ("3", "2.5")])
def test_t_p1_one_member_is_byte_equal_to_paper_replay_on_fixture_bars(manifest, rows, bars, signals, name, pair):
    raw_pair = {"atr_multiplier": pair[0], "rr": pair[1]}
    combined = fixture_run(manifest, bars, rows, [("dep", signals[name])], pair=raw_pair)
    reference = reference_run(manifest, bars, rows, "dep", signals[name], pair=raw_pair)
    assert tuple(combined["ledger"]) == tuple(reference) == LEDGER_KEYS
    assert canonical(combined["ledger"]) == canonical(reference)
    assert sha(combined["ledger"]) == sha(reference)
    assert len(reference["fills"]) >= 6  # a real series, not an empty ledger
    triples = [(bar, False, False) for bar in bars]
    split = manifest["split"]
    cash = Decimal(manifest["capital"]["cash"])
    for low, high in (("warmup", "train_end"), ("train_end", "validation_end"), ("validation_end", "test_end")):
        assert mark_period(triples, combined["ledger"]["fills"], split[low], split[high], cash) == mark_period(
            triples, reference["fills"], split[low], split[high], cash
        )


def test_t_p1_stress_model_is_byte_equal(manifest, rows, bars, signals):
    stress = model_of(manifest["model"], factor=2)
    for name in ("M1", "M2"):
        combined = fixture_run(manifest, bars, rows, [("dep", signals[name])], model=stress)
        reference = reference_run(manifest, bars, rows, "dep", signals[name], model=stress)
        assert canonical(combined["ledger"]) == canonical(reference)
    normal = fixture_run(manifest, bars, rows, [("dep", signals["M1"])])
    assert canonical(normal["ledger"]) != canonical(combined["ledger"])  # the STRESS model changes the money


def scripted_series(copies=3):
    """The 12-bar series of the one-Pine ledger tests, repeated; it crosses a UTC midnight."""
    first = 1800057540000
    prices = [100, 101, 106, 100, 94, 100, 100, 100, 100, 94, 100, 106] * copies
    bars = [
        BridgeBar(first + i * 60000, Decimal(p), Decimal(p + 1), Decimal(p - 1), Decimal(p), Decimal(1), Decimal(2))
        for i, p in enumerate(prices)
    ]
    buys = {i + 12 * k for k in range(copies) for i in (0, 3, 5, 8, 10)}
    exits = {7 + 12 * k for k in range(copies)}
    return bars, tuple((i in buys, i in exits) for i in range(len(bars)))


def base_policy(**changes):
    result = dict(
        killSwitch=False, maxSignalAgeSeconds=120, maxTradesPerDay=10000, maxDailyLossR=10000,
        pauseAfterLossStreak=10000, blockHighVolatility=False, maxVolatilityPercent=100,
        blockDuringNews=False, allowedSymbols=["BTCUSDT"], sideMode="BOTH", maxOpenPositions=5,
        onePositionPerSymbol=False, capPercentEquitySize=True, maxRiskPercent=100,
        maxOrderNotional=10000, maxDailyNotional=10000000,
    )
    return {**result, **changes}


SCRIPTED_VARIANTS = {
    "plain": dict(policy={}, risk="1", cash="1000", start=0),
    "cap-cash": dict(policy={}, risk="60", cash="1000", start=0),
    "daily-limit": dict(policy={"maxTradesPerDay": 3}, risk="1", cash="1000", start=0),
    "loss-streak": dict(policy={"pauseAfterLossStreak": 1}, risk="1", cash="1000", start=0),
    "daily-loss": dict(policy={"maxDailyLossR": 0.01}, risk="1", cash="1000", start=0),
    "kill-switch": dict(policy={"killSwitch": True}, risk="1", cash="1000", start=0),
    "orphan-exit": dict(policy={}, risk="1", cash="1000", start=4),
}


def scripted_pair(variant):
    bars, sig = scripted_series()
    spec = SCRIPTED_VARIANTS[variant]
    common = dict(
        model=PaperModel(risk_percent=Decimal(spec["risk"])), policy=base_policy(**spec["policy"]),
        equity=Decimal(1000), cash=Decimal(spec["cash"]), broker="binance-global", symbol="BTCUSDT",
        start_time=bars[spec["start"]].time if spec["start"] else None,
    )
    combined = combined_paper_replay(
        [MemberSignals(1, "dep", sig)], bars, BridgePair(Decimal(1), Decimal(1)),
        same_bar_order=SAME_BAR_ORDER, **common,
    )
    reference = paper_replay(
        [(bar, buy, exit_) for bar, (buy, exit_) in zip(bars, sig, strict=True)],
        deployment_id="dep", multiplier=Decimal(1), rr=Decimal(1), **common,
    )
    return combined, reference


@pytest.mark.parametrize("variant", sorted(SCRIPTED_VARIANTS))
def test_t_p1_scripted_series_is_byte_equal(variant):
    combined, reference = scripted_pair(variant)
    assert canonical(combined["ledger"]) == canonical(reference)


def test_t_p1_scripted_series_cover_caps_rejections_pause_daily_limit_and_orphan_exit():
    reasons, sizing = Counter(), Counter()
    for variant in SCRIPTED_VARIANTS:
        combined, _ = scripted_pair(variant)
        for decision in combined["ledger"]["decisions"]:
            if decision["outcome"] == "REJECTED":
                reasons[decision["reason"]] += 1
            else:
                sizing[decision["sizing_outcome"]] += 1
    assert set(reasons) >= {
        "Maximum trades per day reached", "Trading paused after loss streak",
        "Maximum daily loss reached", "Kill switch is active: entries paused", "TARGET_NOT_OPEN",
    }
    assert sizing["CAPPED"] > 0 and sizing["ACCEPTED"] > 0
    orphan, _ = scripted_pair("orphan-exit")
    assert any(
        d["event_type"] == "EXIT" and d["reason"] == "TARGET_NOT_OPEN" and d["time"] > orphan["ledger"]["events"][0]["time"]
        for d in orphan["ledger"]["decisions"]
    )


def test_t_p1_has_no_member_count_branch():
    source = Path(mp.__file__).read_text()
    assert not re.search(r"len\(\s*(self\.)?(members|ordered)\s*\)\s*(==|!=)\s*\d", source)
    assert not hasattr(mp, "combined_replay_single") and not hasattr(mp, "one_pine_view")


# ----------------------------------------------------------------------------- order and mutation


def two_member_case(scripted):
    case = by_id(scripted, "F3")
    return case, case_inputs(case)[1]


def test_members_are_processed_in_ascending_ordinal_whatever_the_list_order(scripted):
    case, members = two_member_case(scripted)
    ascending = run_case(case, members=members)
    reversed_list = run_case(case, members=list(reversed(members)))
    assert canonical(ascending["ledger"]) == canonical(reversed_list["ledger"])
    assert canonical(ascending["diagnostics"]) == canonical(reversed_list["diagnostics"])
    # ordinal 1 wins the cash, ordinal 2 is the one refused
    assert outline(ascending) == [
        ("mp-1", "BUY", "FILLED", "CAPPED"), ("mp-2", "BUY", "REJECTED", "BELOW_QUANTITY_STEP"),
    ]


def test_removing_the_ordinal_sort_keeps_t_p1_but_fails_the_two_member_order_test(
    scripted, manifest, rows, bars, signals, monkeypatch
):
    case, members = two_member_case(scripted)
    expected = canonical(run_case(case, members=list(reversed(members)))["ledger"])
    monkeypatch.setattr(mp, "_by_ordinal", lambda items: list(items))  # the mutation
    # T-P1 (one member) is unchanged by the mutation ...
    combined = fixture_run(manifest, bars, rows, [("dep", signals["M1"])])
    reference = reference_run(manifest, bars, rows, "dep", signals["M1"])
    assert canonical(combined["ledger"]) == canonical(reference)
    # ... and the two-member order test now fails: member 2 processed first takes the cash.
    mutated = run_case(case, members=list(reversed(members)))
    assert canonical(mutated["ledger"]) != expected
    assert outline(mutated)[0][0] == "mp-2"


# -------------------------------------------------------------------- T-P2 scripted Option B cases


def test_scripted_cases_file_is_the_pinned_one(scripted, manifest):
    raw = (FIXTURES / "scripted-cases-v1.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["scripted_cases"]["sha256"]
    assert [c["id"] for c in scripted["cases"]] == manifest["scripted_cases"]["ids"]
    assert scripted["version"] == "scripted-signals-v1" and scripted["fixture"] is True
    assert all(c["fixture"] is True and c["fixture_source"] == "scripted-signals-v1" for c in scripted["cases"])


@pytest.mark.parametrize("case_id", ["F3", "F4", "F6", "F7", "F8", "F8-streak", "F13"])
def test_scripted_case_matches_its_recorded_expectation(scripted, case_id):
    case = by_id(scripted, case_id)
    result = run_case(case)
    recorded = case["expected"]
    ledger = result["ledger"]
    start = case["bars"][0]["time"]
    assert [
        [(d["time"] - start) // 60000, d["entry_ref"].rsplit(":", 2)[0], d["event_type"], d["outcome"],
         d["reason"] if d["outcome"] == "REJECTED" else d["sizing_outcome"]]
        for d in ledger["decisions"]
    ] == recorded["decisions"]
    assert ledger["final_cash"] == recorded["final_cash"]
    assert ledger["open_allocations"] == recorded["open_allocations"]
    assert sha(ledger) == recorded["ledger_sha256"]
    assert result["diagnostics"]["cross_source_target"] == recorded["cross_source_target"] == 0
    assert result["diagnostics"]["duplicate_intents"] == recorded["duplicate_intents"] == 0


def test_f3_cash_contention_ordinal_one_fills_ordinal_two_is_a_policy_skip(scripted):
    result = run_case(by_id(scripted, "F3"))
    assert outline(result) == [("mp-1", "BUY", "FILLED", "CAPPED"), ("mp-2", "BUY", "REJECTED", "BELOW_QUANTITY_STEP")]
    assert member_diag(result, "mp-1")["capped"] == 1
    assert member_diag(result, "mp-2")["rejected"] == {"BELOW_QUANTITY_STEP": 1}
    assert result["diagnostics"]["cross_source_target"] == 0
    assert result["ledger"]["open_allocations"] == 1  # a rejected BUY creates no allocation


def test_f4_exit_first_frees_the_cash_the_buy_needs(scripted):
    case = by_id(scripted, "F4")
    result = run_case(case)
    assert outline(result) == [
        ("mp-2", "BUY", "FILLED", "CAPPED"), ("mp-2", "EXIT", "FILLED", "ACCEPTED"), ("mp-1", "BUY", "FILLED", "CAPPED"),
    ]
    # control: without the EXIT the same BUY on the same bar is refused for lack of cash
    quiet = {"buy": case["members"][1]["signals"]["buy"], "native_exit": [False] * len(case["bars"])}
    control = {**case, "members": [case["members"][0], {**case["members"][1], "signals": quiet}]}
    assert outline(run_case(control))[-1] == ("mp-1", "BUY", "REJECTED", "BELOW_QUANTITY_STEP")


def test_f6_exit_bar_suppresses_only_the_exiting_member_buy(scripted):
    result = run_case(by_id(scripted, "F6"))
    assert outline(result) == [
        ("mp-1", "BUY", "FILLED", "CAPPED"), ("mp-1", "EXIT", "FILLED", "ACCEPTED"), ("mp-2", "BUY", "FILLED", "CAPPED"),
    ]
    assert member_diag(result, "mp-1")["suppressed_buys"] == 1 and member_diag(result, "mp-2")["suppressed_buys"] == 0
    assert member_diag(result, "mp-1")["native_buy"] == 2 and member_diag(result, "mp-1")["intents_buy"] == 1


def test_f7_shared_daily_limit_refuses_member_two_buy_but_accepts_its_exit(scripted):
    result = run_case(by_id(scripted, "F7"))
    rows = outline(result)
    assert ("mp-2", "BUY", "REJECTED", "Maximum trades per day reached") in rows
    assert ("mp-2", "EXIT", "FILLED", "ACCEPTED") in rows
    assert rows.count(("mp-1", "BUY", "FILLED", "CAPPED")) == 2  # member 1 reached the Bot limit with member 2
    assert ("mp-2", "EXIT", "REJECTED", "TARGET_NOT_OPEN") in rows  # the refused BUY stays in Pine's array


def test_f8_combined_loss_stops_entries_of_every_member_and_exits_continue(scripted):
    result = run_case(by_id(scripted, "F8"))
    rows = outline(result)
    assert ("mp-2", "EXIT", "FILLED", "ACCEPTED") in rows
    assert rows.count(("mp-1", "BUY", "REJECTED", "Maximum daily loss reached")) == 1
    assert rows.count(("mp-2", "BUY", "REJECTED", "Maximum daily loss reached")) == 1
    assert rows[-1] == ("mp-1", "EXIT", "FILLED", "ACCEPTED")  # member 1 still exits after the guard tripped
    assert result["ledger"]["open_allocations"] == 0
    fills_exit = [f for f in result["ledger"]["fills"] if f["event_type"] == "EXIT"]
    assert fills_exit[0]["reason"] == "SL" and Decimal(fills_exit[0]["realized_r"]) < Decimal("-0.3")


def test_f8_loss_streak_at_bot_flat_pauses_entries_of_every_member(scripted):
    result = run_case(by_id(scripted, "F8-streak"))
    rows = outline(result)
    assert rows[:2] == [("mp-1", "BUY", "FILLED", "CAPPED"), ("mp-1", "EXIT", "FILLED", "ACCEPTED")]
    assert rows[2:] == [
        ("mp-1", "BUY", "REJECTED", "Trading paused after loss streak"),
        ("mp-2", "BUY", "REJECTED", "Trading paused after loss streak"),
    ]


def test_f13_three_members_settle_in_order_one_two_three(scripted):
    result = run_case(by_id(scripted, "F13"))
    buys = [d for d in result["ledger"]["decisions"] if d["event_type"] == "BUY"]
    assert [d["entry_ref"].rsplit(":", 2)[0] for d in buys] == ["mp-1", "mp-2", "mp-3"]
    assert [Decimal(d["quantity"]) for d in buys] == sorted((Decimal(d["quantity"]) for d in buys), reverse=True)
    exits = [d for d in result["ledger"]["decisions"] if d["event_type"] == "EXIT"]
    assert [d["entry_ref"].rsplit(":", 2)[0] for d in exits] == ["mp-1", "mp-2", "mp-3"]
    assert [(m["ordinal"], m["deployment_id"]) for m in result["diagnostics"]["members"]] == [(1, "mp-1"), (2, "mp-2"), (3, "mp-3")]


def test_streak_moves_only_when_the_bot_is_flat_known_behaviour_r14(scripted):
    """A member's losing exit does not count while another member still holds a position (RD-MP-34)."""
    case = json.loads(json.dumps(by_id(scripted, "F8")))
    case["policy"] = {**case["policy"], "maxDailyLossR": 10000, "pauseAfterLossStreak": 1}
    rows = outline(run_case(case))
    assert ("mp-2", "EXIT", "FILLED", "ACCEPTED") in rows  # member 2 lost at its SL on bar 2 ...
    assert ("mp-1", "BUY", "FILLED", "CAPPED") in rows[3:]  # ... and the Bot is not paused: member 1 still holds
    assert not any(r[3] == "REJECTED" and r[4] == "Trading paused after loss streak" for r in rows)


# ------------------------------------------------------------------- F5 and F9 with forged producers


class ForgedReplay:
    """A producer that emits scripted intents by bar index instead of running Pine's arrays."""

    def __init__(self, deployment_id, script):
        self.deployment_id, self.script, self.calls = deployment_id, script, 0

    def step(self, bar, buy, native_exit):
        intents = self.script.get(self.calls, [])
        self.calls += 1
        return [i(bar) if callable(i) else i for i in intents]


def forging_factory(forged_id, script):
    def make(deployment_id, multiplier, rr, model):
        if deployment_id == forged_id:
            return ForgedReplay(deployment_id, script)
        return BridgeReplay(deployment_id, multiplier, rr, model)

    return make


def flat_case(scripted, bars=6, members_signals=None):
    base = by_id(scripted, "F6")
    case = json.loads(json.dumps(base))
    case["bars"] = case["bars"][:bars] if bars <= len(case["bars"]) else case["bars"]
    if members_signals is not None:
        for member, sig in zip(case["members"], members_signals, strict=True):
            member["signals"] = sig
    return case


def buy_intent(deployment_id, bar_time, sl="98", tp="102"):
    return BridgeIntent("BUY", bar_time, f"{deployment_id}:{bar_time}:0", 0, sl=Decimal(sl), tp=Decimal(tp))


def test_f5_foreign_target_is_refused_before_the_ledger_and_member_two_allocation_is_unchanged(scripted):
    case = flat_case(scripted)
    bars, members = case_inputs(case)
    m2_buy_time = bars[1].time
    script = {2: [lambda bar: BridgeIntent("EXIT", bar.time, f"mp-2:{m2_buy_time}:0", 0, "NATIVE")]}
    factory = forging_factory("mp-1", script)
    state = mp._CombinedPaperState(
        members=members, pair=pair_of(case["pair"]), model=model_of(case["model"]), policy=case["policy"],
        equity=Decimal(case["capital"]["equity"]), cash=Decimal(case["capital"]["cash"]),
        broker="binance-global", symbol="BTCUSDT", replay_factory=factory,
    )
    # member 2 buys on bar 1 (a real Pine replay), member 1 forges an EXIT of that entry on bar 2
    for index, bar in enumerate(bars[:2]):
        state.step(bar, (False, index == 1), (False, False))
    assert f"mp-2:{m2_buy_time}:0" in state.positions
    before = (dict(state.positions), state.cash, state.quantity, state.cost)
    with pytest.raises(ValueError, match="^MP_CROSS_SOURCE_TARGET$"):
        state.step(bars[2], (False, False), (False, False))
    assert (dict(state.positions), state.cash, state.quantity, state.cost) == before
    short = [MemberSignals(m.ordinal, m.deployment_id, m.signals[:3]) for m in members]
    with pytest.raises(ValueError, match="^MP_CROSS_SOURCE_TARGET$"):
        mp._run(
            short, bars[:3], pair_of(case["pair"]), model=model_of(case["model"]), policy=case["policy"],
            equity=Decimal(case["capital"]["equity"]), cash=Decimal(case["capital"]["cash"]),
            broker="binance-global", symbol="BTCUSDT", start_time=None, same_bar_order=SAME_BAR_ORDER,
            replay_factory=factory,
        )


def test_f5_own_prefix_exit_of_an_unknown_entry_is_target_not_open_and_member_two_keeps_its_allocation(scripted):
    case = flat_case(scripted)
    bars, members = case_inputs(case)
    script = {2: [lambda bar: BridgeIntent("EXIT", bar.time, f"mp-1:{bar.time - 60000}:0", 0, "NATIVE")]}
    result = run_case(case, members=[members[0], MemberSignals(2, "mp-2", tuple((i == 1, False) for i in range(len(bars))))],
                      replay_factory=forging_factory("mp-1", script))
    assert ("mp-1", "EXIT", "REJECTED", "TARGET_NOT_OPEN") in outline(result)
    assert result["ledger"]["open_allocations"] == 1  # member 2's entry is untouched
    assert result["diagnostics"]["cross_source_target"] == 0


def test_f9_duplicate_intent_is_dropped_with_zero_extra_effects_and_counted(scripted):
    case = flat_case(scripted)
    bars, members = case_inputs(case)
    plain = {1: [lambda bar: buy_intent("mp-1", bar.time)]}
    repeated = {1: [lambda bar: buy_intent("mp-1", bar.time)], 2: [lambda bar: buy_intent("mp-1", bars[1].time)],
                3: [lambda bar: buy_intent("mp-1", bars[1].time), lambda bar: buy_intent("mp-1", bars[1].time)]}
    quiet = [members[0], MemberSignals(2, "mp-2", tuple((False, False) for _ in bars))]
    clean = run_case(case, members=quiet, replay_factory=forging_factory("mp-1", plain))
    dirty = run_case(case, members=quiet, replay_factory=forging_factory("mp-1", repeated))
    assert dirty["diagnostics"]["duplicate_intents"] == 3 and clean["diagnostics"]["duplicate_intents"] == 0
    assert canonical(dirty["ledger"]) == canonical(clean["ledger"])  # 0 extra effects
    assert len(dirty["ledger"]["fills"]) == 1


def test_f9_same_shaped_event_of_member_two_is_distinct(scripted):
    case = flat_case(scripted)
    bars, members = case_inputs(case)
    quiet = [members[0], MemberSignals(2, "mp-2", tuple((False, False) for _ in bars))]

    def factory(deployment_id, multiplier, rr, model):  # both members emit the same shaped BUY on bar 1
        return ForgedReplay(deployment_id, {1: [lambda bar, own=deployment_id: buy_intent(own, bar.time)]})

    result = run_case(case, members=quiet, replay_factory=factory)
    assert result["diagnostics"]["duplicate_intents"] == 0
    assert [(d["entry_ref"].rsplit(":", 2)[0], d["event_type"]) for d in result["ledger"]["fills"]] == [
        ("mp-1", "BUY"), ("mp-2", "BUY"),
    ]


# ------------------------------------------------------------------ F24, F29 and fixture-level runs


def test_f24_member_one_intents_do_not_depend_on_member_two_inputs(manifest, rows, bars, signals):
    other = tuple((e.buy, e.native_exit) for e in evaluate_bars(rows, CustomSignalInputs(ema_fast=20, ema_slow=100)))
    first = fixture_run(manifest, bars, rows, [("fixture-a", signals["M1"]), ("fixture-b", signals["M2"])])
    second = fixture_run(manifest, bars, rows, [("fixture-a", signals["M1"]), ("fixture-b", other)])
    mine = lambda result: [e for e in result["ledger"]["events"] if e["entry_ref"].startswith("fixture-a:")]  # noqa: E731
    assert mine(first) == mine(second) and len(mine(first)) > 20
    assert member_diag(first, "fixture-a")["native_buy"] == member_diag(second, "fixture-a")["native_buy"]
    assert member_diag(first, "fixture-b") != member_diag(second, "fixture-b")


def test_f29_zero_signal_member_reports_no_native_signal_and_no_intent(manifest, rows, bars, signals):
    result = fixture_run(manifest, bars, rows, [("fixture-a", signals["M1"]), ("fixture-z", signals["M2_ZERO"])])
    zero = member_diag(result, "fixture-z")
    assert zero["native_buy"] == 0 and zero["native_exit"] == 0 and zero["intents_buy"] == 0
    assert sum(zero["rejected"].values()) == 0 and zero["accepted"] == zero["capped"] == 0
    assert member_diag(result, "fixture-a")["native_buy"] > 0


def test_funnel_counts_of_members_sum_to_the_bot_counts(manifest, rows, bars, signals):
    result = fixture_run(manifest, bars, rows, [("m-1", signals["M1"]), ("m-2", signals["M2"]), ("m-3", signals["M1"])])
    diagnostics, ledger = result["diagnostics"], result["ledger"]
    members, bot = diagnostics["members"], diagnostics["bot"]
    assert isinstance(members, list)
    assert [(m["ordinal"], m["deployment_id"]) for m in members] == [(1, "m-1"), (2, "m-2"), (3, "m-3")]
    for key in bot:
        if isinstance(bot[key], dict):
            total = Counter()
            for member in members:
                total.update(member[key])
            assert dict(total) == bot[key], key
        else:
            assert sum(member[key] for member in members) == bot[key], key
    assert bot["intents_buy"] + bot["intents_exit"] == len(ledger["events"])
    assert bot["accepted"] + bot["capped"] + sum(bot["exit_fills"].values()) == len(ledger["fills"])
    assert bot["accepted"] + bot["capped"] + sum(bot["exit_fills"].values()) + sum(bot["rejected"].values()) == len(ledger["decisions"])
    assert bot["pre_start_intents"] == sum(1 for e in ledger["events"] if e["time"] < rows[1250]["time"]) > 0
    assert len(ledger["events"]) > len(ledger["decisions"])  # pre-start intents stay in `events` only
    assert diagnostics["cross_source_target"] == 0 and diagnostics["duplicate_intents"] == 0  # T-P4
    assert diagnostics["same_bar_order"] == SAME_BAR_ORDER and diagnostics["version"] == mp.DIAGNOSTICS_VERSION
    # every fill and decision carries a member tag derivable from its entry_ref, ledger records are never widened
    assert {mp.member_of_entry_ref(d["entry_ref"]) for d in ledger["decisions"]} <= {m["deployment_id"] for m in members}
    one_pine = reference_run(manifest, bars, rows, "m-1", signals["M1"])
    assert set(ledger["events"][0]) == set(one_pine["events"][0])
    assert set(ledger["decisions"][0]) == set(one_pine["decisions"][0])


def test_same_bar_order_inside_a_bar_is_exits_by_ordinal_then_buys_by_ordinal(manifest, rows, bars, signals):
    result = fixture_run(manifest, bars, rows, [("m-1", signals["M1"]), ("m-2", signals["M2"]), ("m-3", signals["M1"])])
    last_time, kinds = None, []
    for event in result["ledger"]["events"] + [{"time": None, "event_type": "EXIT", "entry_ref": "m-0:0:0"}]:
        if event["time"] != last_time:
            exits = [(e, i) for e, i in kinds if e == "EXIT"]
            first_buy = next((n for n, (e, _) in enumerate(kinds) if e == "BUY"), len(kinds))
            assert all(e == "EXIT" for e, _ in kinds[:first_buy]) and len(exits) == first_buy
            for kind in ("EXIT", "BUY"):
                ordinals = [i for e, i in kinds if e == kind]
                assert ordinals == sorted(ordinals)
            last_time, kinds = event["time"], []
        kinds.append((event["event_type"], int(event["entry_ref"].split("-")[1].split(":")[0])))
    assert any(len({e["entry_ref"].split(":")[0] for e in result["ledger"]["events"] if e["time"] == t}) > 1
               for t in {e["time"] for e in result["ledger"]["events"]})  # the fixture really has same-bar contention


# ------------------------------------------------------------------------------ T-P3 signature


def test_t_p3_one_shared_pair_and_no_member_pair(manifest, rows, bars, signals):
    parameters = list(inspect.signature(combined_paper_replay).parameters)
    assert parameters == [
        "members", "bars", "shared_pair", "model", "policy", "equity", "cash", "broker", "symbol",
        "start_time", "same_bar_order",
    ]
    assert [f.name for f in fields(MemberSignals)] == ["ordinal", "deployment_id", "signals"]
    assert [f.name for f in fields(BridgePair)] == ["atr_multiplier", "rr"]
    with pytest.raises(TypeError):
        MemberSignals(1, "dep", (), rr=Decimal(1))
    with pytest.raises(TypeError):
        MemberSignals(1, "dep", (), atr_multiplier=Decimal(1))
    state = mp._CombinedPaperState(
        members=[MemberSignals(1, "a", ()), MemberSignals(2, "b", ()), MemberSignals(3, "c", ())],
        pair=pair_of(manifest["pair"]), model=model_of(manifest["model"]), policy=manifest["policy"],
        equity=Decimal(1), cash=Decimal(1), broker="binance-global", symbol="BTCUSDT",
    )
    replays = state.replay.replays
    assert len(replays) == 3
    assert {(r.multiplier, r.rr) for r in replays} == {(Decimal("2"), Decimal("1.5"))}
    for bad in (None, ("2", "1.5"), {"atr_multiplier": Decimal(2), "rr": Decimal(1)}, [pair_of(manifest["pair"])] * 2):
        with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
            fixture_run_with_pair(manifest, bars, rows, signals, bad)


def fixture_run_with_pair(manifest, bars, rows, signals, pair):
    return combined_paper_replay(
        [MemberSignals(1, "a", signals["M1"])], bars, pair, model=model_of(manifest["model"]),
        policy=manifest["policy"], equity=Decimal(1), cash=Decimal(1), broker="binance-global",
        symbol="BTCUSDT", start_time=None, same_bar_order=SAME_BAR_ORDER,
    )


@pytest.mark.parametrize("bad", [
    dict(atr_multiplier=Decimal(0), rr=Decimal(1)), dict(atr_multiplier=Decimal(1), rr=Decimal(-1)),
    dict(atr_multiplier=1, rr=Decimal(1)), dict(atr_multiplier=Decimal("NaN"), rr=Decimal(1)),
])
def test_bridge_pair_refuses_non_decimal_and_non_positive_values(bad):
    with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
        BridgePair(**bad)


# --------------------------------------------------------------------------- input validation


def good_args(scripted):
    case = by_id(scripted, "F6")
    bars, members = case_inputs(case)
    kwargs = dict(
        model=model_of(case["model"]), policy=case["policy"], equity=Decimal(1000), cash=Decimal(1000),
        broker="binance-global", symbol="BTCUSDT", start_time=None, same_bar_order=SAME_BAR_ORDER,
    )
    return members, bars, pair_of(case["pair"]), kwargs


def test_unsupported_same_bar_order_is_refused_with_its_code(scripted):
    members, bars, pair, kwargs = good_args(scripted)
    for value in (None, "", "arrival-v1", "exit-first-ordinal-v2", 1):
        with pytest.raises(ValueError, match="^MP_EVENT_ORDER_UNDEFINED$"):
            combined_paper_replay(members, bars, pair, **{**kwargs, "same_bar_order": value})
    missing = {k: v for k, v in kwargs.items() if k != "same_bar_order"}
    with pytest.raises(TypeError):
        combined_paper_replay(members, bars, pair, **missing)


def test_member_set_shape_is_refused_with_mp_input_invalid(scripted):
    members, bars, pair, kwargs = good_args(scripted)
    first, second = members
    n = len(bars)
    extra = MemberSignals(3, "mp-3", first.signals)
    bad_sets = [
        [], [first, first], [first, MemberSignals(2, "mp-1", second.signals)],
        [first, MemberSignals(3, "mp-3", second.signals)], [MemberSignals(2, "mp-2", first.signals)],
        [first, second, extra, MemberSignals(4, "mp-4", first.signals)],
        [first, MemberSignals(2, "mp-2", second.signals[:-1])], "members", None,
        [first, ("mp-2", second.signals)],
    ]
    assert n > 1
    for bad in bad_sets:
        with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
            combined_paper_replay(bad, bars, pair, **kwargs)
    for bad_signals in ([(True, 1)], [(1, False)], [(True,)], [[True, False, False]], "xx", None):
        with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
            MemberSignals(1, "dep", bad_signals)
    for ordinal, name in ((0, "d"), (True, "d"), (1, ""), (1, 5)):
        with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
            MemberSignals(ordinal, name, ())
    with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
        combined_paper_replay(members, [(bars[0], True, False)] * n, pair, **kwargs)
    with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
        combined_paper_replay(members, bars, pair, **{**kwargs, "model": "paper-close-v1"})


def test_the_ledger_state_of_the_merged_replay_cannot_be_exported():
    state = mp._CombinedPaperState(
        members=[MemberSignals(1, "a", ())], pair=BridgePair(Decimal(1), Decimal(1)), model=PaperModel(),
        policy=base_policy(), equity=Decimal(1), cash=Decimal(1), broker="binance-global", symbol="BTCUSDT",
    )
    for call in (state.export_state, lambda: state.import_state({})):
        with pytest.raises(ValueError, match="^MP_STATE_EXPORT_UNSUPPORTED$"):
            call()


# ------------------------------------------------------------------------- T-P4 and T-P5 runs


def test_t_p4_cross_source_target_is_zero_over_every_fixture_run(manifest, rows, bars, signals):
    for members in (
        [("a", signals["M1"]), ("b", signals["M2"])],
        [("a", signals["M1"]), ("b", signals["M2"]), ("c", signals["M1"])],
        [("a", signals["M2"]), ("b", signals["M1"])],
    ):
        for pair in (manifest["pair"], {"atr_multiplier": "1", "rr": "1"}, {"atr_multiplier": "3", "rr": "2.5"}):
            diagnostics = fixture_run(manifest, bars, rows, members, pair=pair)["diagnostics"]
            assert diagnostics["cross_source_target"] == 0 and diagnostics["duplicate_intents"] == 0


def test_t_p5_same_inputs_give_identical_output_and_hashes(manifest, rows, bars, signals):
    members = [("a", signals["M1"]), ("b", signals["M2"]), ("c", signals["M1"])]
    first = fixture_run(manifest, bars, rows, members)
    second = fixture_run(manifest, bars, rows, members)
    assert canonical(first) == canonical(second)
    assert sha(first["ledger"]) == sha(second["ledger"])


def test_t_p5_hash_is_stable_under_different_hash_seeds(manifest, rows, bars, signals):
    program = (
        "import json,sys,hashlib\n"
        "from decimal import Decimal\n"
        "from robot_quant.bridge_replay import BridgeBar, PaperModel\n"
        "from robot_quant.mp_combined_paper import *\n"
        "from robot_quant.ql3a import canonical\n"
        "from robot_quant.spt_custom_evaluator import CustomSignalInputs, evaluate_bars\n"
        "m=json.load(open(sys.argv[1]));rows=json.load(open(sys.argv[2]))['bars'][:2600]\n"
        "bars=[BridgeBar(r['time'],*(Decimal(r[k]) for k in('open','high','low','close','volume')),Decimal(r['atr14'])) for r in rows]\n"
        "sig=lambda v:tuple((e.buy,e.native_exit) for e in evaluate_bars(rows,CustomSignalInputs.from_source_values(v)))\n"
        "ms=[MemberSignals(1,'a',sig(m['members']['M1']['inputs'])),MemberSignals(2,'b',sig(m['members']['M2']['inputs']))]\n"
        "mo=m['model']\n"
        "r=combined_paper_replay(ms,bars,BridgePair(Decimal(m['pair']['atr_multiplier']),Decimal(m['pair']['rr'])),model=PaperModel(Decimal(mo['price_tick']),Decimal(mo['quantity_step']),Decimal(mo['fee_bps']),Decimal(mo['slippage_bps']),Decimal(mo['risk_percent'])),policy=m['policy'],equity=Decimal(m['capital']['equity']),cash=Decimal(m['capital']['cash']),broker='binance-global',symbol='BTCUSDT',start_time=rows[1250]['time'],same_bar_order='exit-first-ordinal-v1')\n"
        "print(hashlib.sha256(canonical(r)).hexdigest(), len(r['ledger']['fills']))\n"
    )
    seen = set()
    for seed in ("0", "1", "4242"):
        done = subprocess.run(
            [sys.executable, "-I", "-c", program, str(FIXTURES / "manifest.json"), str(FIXTURES / "bars-v1.json")],
            env={"PYTHONHASHSEED": seed, "PYTHONPATH": str(SRC), "PATH": ""}, capture_output=True, text=True, check=True,
        )
        seen.add(done.stdout.strip())
    assert len(seen) == 1 and int(seen.pop().split()[1]) > 0


# ------------------------------------------------------------------------ fixture data pins


def test_bars_file_matches_the_pinned_sha256_and_shape(manifest, rows):
    raw = (FIXTURES / "bars-v1.json").read_bytes()
    assert hashlib.sha256(raw).hexdigest() == manifest["bars"]["sha256"]
    head = json.loads(raw)
    assert head["fixture"] is True and head["symbol"] == "BTCUSDT" and head["venue"] == "binance-global"
    assert head["provenance"]["profile"] == "closed-ohlcv-atr14-v1" and head["provenance"]["fixture"] is True
    assert len(rows) == manifest["bars"]["bar_count"] == 6000
    assert rows[0]["time"] == manifest["bars"]["first_time"] and rows[-1]["time"] == manifest["bars"]["last_time"]
    assert all(b["time"] - a["time"] == 60000 for a, b in zip(rows, rows[1:], strict=False))
    assert all(set(r) == {"time", "open", "high", "low", "close", "volume", "atr14"} for r in rows)
    assert all(bar_of(r).atr14 is not None for r in rows)


def test_split_and_warmup_follow_the_run_contract_formulas(manifest):
    split, floors = manifest["split"], manifest["warmup_floor"]
    assert floors["combined"] == max(floors["M1"], floors["M2"]) == 1250
    count = 6000 - split["warmup"]
    assert split == {
        "warmup": 1250, "train_end": 1250 + count * 6 // 10, "validation_end": 1250 + count * 8 // 10, "test_end": 6000,
    }
    assert (split["train_end"] - split["warmup"], split["validation_end"] - split["train_end"], split["test_end"] - split["validation_end"]) == (2850, 950, 950)
    for name in ("M1", "M2"):
        assert split["warmup"] >= max(1006, 5 * manifest["members"][name]["inputs"]["emaSlowInput"])


def test_pinned_native_counts_hold_and_meet_the_signal_floor(manifest, rows, signals):
    segments = {"warmup": (0, 1250), "train": (1250, 4100), "validation": (4100, 5050), "test": (5050, 6000)}
    for name in ("M1", "M2", "M2_ZERO"):
        counted = {
            seg: {"buy": sum(s[0] for s in signals[name][a:b]), "exit": sum(s[1] for s in signals[name][a:b])}
            for seg, (a, b) in segments.items()
        }
        assert counted == manifest["native_counts"][name]
    floor = manifest["signal_floor"]["minimum"]
    assert floor == 15
    for name in ("M1", "M2"):
        for seg in ("train", "validation", "test"):
            assert manifest["native_counts"][name][seg]["buy"] >= floor, (name, seg)
    assert all(v == {"buy": 0, "exit": 0} for v in manifest["native_counts"]["M2_ZERO"].values())
    assert signals["M1"] != signals["M2"]


def test_member_inputs_are_complete_distinct_and_m3_equals_m1(manifest):
    members = manifest["members"]
    assert members["M1"]["inputs"] != members["M2"]["inputs"]
    assert members["M3"] == {"role": members["M3"]["role"], "equal_to": "M1"}
    assert inputs_of(manifest, "M1") == CustomSignalInputs()
    assert (inputs_of(manifest, "M2").ema_fast, inputs_of(manifest, "M2").ema_slow) == (34, 250)
    assert set(members["M1"]["inputs"]) == set(members["M2"]["inputs"]) == set(members["M2_ZERO"]["inputs"])


def test_pinned_library_runs_reproduce(manifest, rows, bars, signals):
    for pinned in manifest["library_runs"]:
        members = [(dep, signals[name]) for dep, name in zip(pinned["deployment_ids"], pinned["members"], strict=True)]
        ledger = fixture_run(manifest, bars, rows, members, pair=pinned["pair"])["ledger"]
        assert sha(ledger) == pinned["ledger_sha256"]
        assert (len(ledger["events"]), len(ledger["decisions"]), len(ledger["fills"])) == (
            pinned["events"], pinned["decisions"], pinned["fills"])
        assert ledger["final_cash"] == pinned["final_cash"] and ledger["open_allocations"] == pinned["open_allocations"]
    assert [p["members"] for p in manifest["library_runs"]][1] == ["M1", "M2", "M1"]  # M3 (F15) equals M1


@pytest.fixture(scope="module")
def manifest_v2():
    return json.loads((FIXTURES / "manifest-v2.json").read_text())


@pytest.fixture(scope="module")
def rows_v2():
    return json.loads((FIXTURES / "bars-v2.json").read_text())["bars"]


def test_pinned_bars_v2_measured_run_reproduces(manifest, manifest_v2, rows_v2):
    """F1: M1+M2 at the manifest-v2 pair, replayed over bars-v2 as a HOLDOUT step does, give the measured block of manifest-v2.json."""
    measured = manifest_v2["measured"]
    assert hashlib.sha256((FIXTURES / "bars-v2.json").read_bytes()).hexdigest() == manifest_v2["bars"]["sha256"]
    assert (len(rows_v2), rows_v2[0]["time"], rows_v2[-1]["time"]) == (
        manifest_v2["bars"]["bar_count"], manifest_v2["bars"]["first_time"], manifest_v2["bars"]["last_time"])
    split = measured["split"]
    assert split == manifest["split"]
    bars = [bar_of(row) for row in rows_v2]
    vectors = {
        name: tuple((e.buy, e.native_exit) for e in evaluate_bars(rows_v2, inputs_of(manifest, name)))
        for name in measured["members"]
    }
    members = [(dep, vectors[name]) for dep, name in zip(measured["deployment_ids"], measured["members"], strict=True)]
    ledger = fixture_run(manifest, bars, rows_v2, members, pair=measured["pair"])["ledger"]
    assert (len(ledger["fills"]), len(ledger["decisions"]), len(ledger["events"])) == (
        measured["fills"], measured["decisions"], measured["events"])
    assert ledger["final_cash"] == measured["final_cash"] and ledger["open_allocations"] == measured["open_allocations"]
    assert sha(ledger) == measured["ledger_sha256"]
    cash = Decimal(manifest["capital"]["cash"])
    marked = [(bar, False, False) for bar in bars]
    periods = {
        "train": (split["warmup"], split["train_end"]),
        "validation": (split["train_end"], split["validation_end"]),
        "test": (split["validation_end"], split["test_end"]),
    }
    for name, (low, high) in periods.items():
        got = mark_period(marked, ledger["fills"], low, high, cash)
        assert got["closed_trades"] == measured[name]["closed_trades"], name
        for key in ("net_return_percent", "max_drawdown_percent"):
            assert Decimal(str(got[key])) == Decimal(measured[name][key]), (name, key)


@pytest.mark.skipif(shutil.which("node") is None, reason="node is not on PATH (generator check not run)")
def test_generator_rebuilds_the_committed_bars_byte_for_byte():
    done = subprocess.run(
        ["node", "scripts/build-mp-fixture-bars.mjs", "--check"], cwd=ROOT, capture_output=True, text=True,
    )
    assert done.returncode == 0, done.stderr
    assert done.stdout.strip() == "ok " + json.loads((FIXTURES / "manifest.json").read_text())["bars"]["sha256"]


# ------------------------------------------------------------------ test-only driver for Node tests

DRIVER = Path(__file__).resolve().parent / "mp_scripted_driver.py"


def drive(payload):
    return subprocess.run(
        [sys.executable, "-I", str(DRIVER)], input=json.dumps(payload), capture_output=True, text=True,
        env={"PATH": ""},
    )


@pytest.mark.parametrize("case_id", ["F3", "F4", "F6", "F7", "F8", "F8-streak", "F13"])
def test_driver_runs_a_scripted_case_to_the_recorded_ledger_hash(scripted, case_id):
    case = by_id(scripted, case_id)
    done = drive(case)
    assert done.returncode == 0 and done.stderr == ""
    out = json.loads(done.stdout)
    # the pair form of a vector is accepted and gives the same ledger
    paired = {**case, "members": [{**m, "signals": [list(p) for p in pairs_of(m["signals"])]} for m in case["members"]]}
    assert json.loads(drive(paired).stdout)["ledger_sha256"] == out["ledger_sha256"]
    assert out["ledger_sha256"] == case["expected"]["ledger_sha256"] == sha(out["ledger"])
    assert set(out) == {"ledger", "diagnostics", "ledger_sha256"} and tuple(out["ledger"]) == tuple(sorted(LEDGER_KEYS))


def test_driver_fixture_run_matches_the_pinned_library_runs_and_returns_the_oracle_input(manifest):
    for pinned in manifest["library_runs"]:
        members = [{"name": name, "deployment_id": dep} for name, dep in zip(pinned["members"], pinned["deployment_ids"], strict=True)]
        done = drive({"fixture_run": {"members": members, "pair": pinned["pair"]}})
        assert done.returncode == 0, done.stdout
        out = json.loads(done.stdout)
        assert out["ledger_sha256"] == pinned["ledger_sha256"]
        assert set(out["input"]) >= {"bars", "members", "pair", "model", "policy", "capital", "start_time", "same_bar_order"}
        assert [m["deployment_id"] for m in out["input"]["members"]] == pinned["deployment_ids"]
        vector = out["input"]["members"][0]["signals"]
        assert set(vector) == {"buy", "native_exit"} and len(vector["buy"]) == len(vector["native_exit"]) == 6000
        assert all(type(v) is bool for v in vector["buy"] + vector["native_exit"])
        assert len(out["input"]["bars"]) == 6000
    stress = drive({"fixture_run": {"members": [{"name": "M1", "deployment_id": "d"}], "pair": manifest["pair"], "factor": 2}})
    assert json.loads(stress.stdout)["input"]["model"]["fee_bps"] == "20"


def test_driver_failure_prints_only_a_code():
    done = drive({"bars": [], "members": [], "pair": {"atr_multiplier": "1", "rr": "1"}, "model": {}, "policy": {},
                  "capital": {}, "broker": "b", "symbol": "s", "start_time": None, "same_bar_order": "x"})
    assert done.returncode == 1 and done.stderr == ""
    assert json.loads(done.stdout) == {"error": "EVALUATION_FAILED"}
    assert drive("not a request").stdout.strip() == '{"error":"EVALUATION_FAILED"}'


# ================================================================ S1 fix round: gaps G1 to G12, B1, D8
#
# Tiny hand-built series: flat bars (open = close = 100, range 99.5 to 100.5) dated in 2026, one ATR per
# bar. With the pair (1, 1) a BUY at close 100 and ATR 2 has SL 98 and TP 102; every expected count below
# was counted by hand from the signal vectors and the bar table, never from the code under test.

TINY_FIRST = 1767312000000  # Fri 2026-01-02T00:00:00Z, the same time as the fixture's row 0


def tiny_bars(atrs, *, lows=None, highs=None, closes=None):
    """One flat bar per entry of `atrs` (None = no ATR yet); `lows`, `highs` and `closes` override by index.

    The Paper model fills at the bar close, so a win or a loss needs a close away from 100.
    """
    result = []
    for index, atr in enumerate(atrs):
        close = Decimal(str((closes or {}).get(index, "100")))
        low = min(Decimal(str((lows or {}).get(index, "99.5"))), close)
        high = max(Decimal(str((highs or {}).get(index, "100.5"))), close)
        result.append(BridgeBar(
            TINY_FIRST + index * 60000, Decimal(100), high, low, close, Decimal(1),
            None if atr is None else Decimal(str(atr)),
        ))
    return result


def vector(n, buys=(), exits=()):
    return tuple((i in buys, i in exits) for i in range(n))


def tiny_run(bars, vectors, *, pair=("1", "1"), policy=None, risk="0.1", equity="1000000", cash=None,
             start_time=None, replay_factory=None):
    members = [MemberSignals(i + 1, f"t-{i + 1}", v) for i, v in enumerate(vectors)]
    kwargs = dict(
        model=PaperModel(risk_percent=Decimal(risk)),
        policy=base_policy(**{"maxOrderNotional": 1000000000, **(policy or {})}),
        equity=Decimal(equity), cash=Decimal(cash or equity), broker="binance-global", symbol="BTCUSDT",
        start_time=start_time, same_bar_order=SAME_BAR_ORDER,
    )
    shared = BridgePair(Decimal(pair[0]), Decimal(pair[1]))
    if replay_factory is not None:
        return mp._run(members, bars, shared, replay_factory=replay_factory, **kwargs)
    return combined_paper_replay(members, bars, shared, **kwargs)


def tiny_outline(result):
    return [
        (int((d["time"] - TINY_FIRST) // 60000), d["entry_ref"].rsplit(":", 2)[0], d["event_type"],
         d["reason"] if d["outcome"] == "REJECTED" else "FILLED")
        for d in result["ledger"]["decisions"]
    ]


# ----------------------------------------------------------------------------------- B1: dates


def test_b1_fixture_bars_lie_in_the_past_of_the_real_clock(rows, manifest):
    import time

    now_ms = int(time.time() * 1000)
    assert rows[-1]["time"] < now_ms and TINY_FIRST < now_ms
    assert manifest["bars"]["first_time"] == rows[0]["time"] == 1767312000000  # Fri 2026-01-02T00:00:00Z
    assert manifest["bars"]["last_time"] == rows[-1]["time"] == 1767312000000 + 5999 * 60000


# -------------------------------------------------------- G1: suppressed_buys against skipped_buys


def test_g1_suppressed_buy_is_an_exit_bar_buy_and_skipped_buy_is_a_missing_or_invalid_level():
    # bars:        0     1  2  3  4  5
    atrs =        [None, 2, 2, 2, 2, 200]  # bar 0 has no ATR yet; ATR 200 on bar 5 puts SL below zero
    bars = tiny_bars(atrs, lows={3: 97})  # bar 3 low 97 <= SL 98 of the entry member 2 opened on bar 1
    first = vector(6, buys={0, 2, 3, 5}, exits={2})
    second = vector(6, buys={1, 3})
    result = tiny_run(bars, [first, second])
    one, two = member_diag(result, "t-1"), member_diag(result, "t-2")
    # member 1 by hand: bar 0 buy no ATR -> skipped; bar 2 buy + native exit with nothing open -> suppressed;
    # bar 3 buy -> a real BUY intent; bar 5 buy with ATR 200 (SL = 100 - 200 < 0) -> Pine's invalid-level skip
    assert (one["native_buy"], one["native_exit"], one["intents_buy"], one["intents_exit"]) == (4, 1, 1, 0)
    assert (one["suppressed_buys"], one["skipped_buys"]) == (1, 2)
    # member 2 by hand: bar 1 buy -> BUY intent; bar 3 buy while its entry stops out (EXIT intent, no native exit)
    assert (two["native_buy"], two["native_exit"], two["intents_buy"], two["intents_exit"]) == (2, 0, 1, 1)
    assert (two["suppressed_buys"], two["skipped_buys"]) == (1, 0)
    bot = result["diagnostics"]["bot"]
    assert (bot["suppressed_buys"], bot["skipped_buys"], bot["native_buy"], bot["native_exit"]) == (2, 2, 6, 1)
    # a native exit on a flat bar is a suppression even though the Bridge emitted no EXIT intent
    assert [e["event_type"] for e in result["ledger"]["events"] if e["time"] == bars[2].time] == []


# ------------------------------------------------------- G2: a BUY with a foreign prefix is refused


def test_g2_buy_intent_with_a_foreign_prefix_raises_and_leaves_the_ledger_untouched(scripted):
    case = flat_case(scripted)
    bars, members = case_inputs(case)
    foreign_buy = {1: [lambda bar: buy_intent("mp-2", bar.time)]}  # produced by member 1, owned by member 2
    factory = forging_factory("mp-1", foreign_buy)
    state = mp._CombinedPaperState(
        members=members, pair=pair_of(case["pair"]), model=model_of(case["model"]), policy=case["policy"],
        equity=Decimal(case["capital"]["equity"]), cash=Decimal(case["capital"]["cash"]),
        broker="binance-global", symbol="BTCUSDT", replay_factory=factory,
    )
    state.step(bars[0], (False, False), (False, False))
    before = (dict(state.positions), state.cash, state.quantity, state.cost)
    with pytest.raises(ValueError, match="^MP_CROSS_SOURCE_TARGET$"):
        state.step(bars[1], (False, False), (False, False))
    assert (dict(state.positions), state.cash, state.quantity, state.cost) == before == ({}, state.cash, 0, 0)
    quiet = [MemberSignals(m.ordinal, m.deployment_id, tuple((False, False) for _ in bars)) for m in members]
    with pytest.raises(ValueError, match="^MP_CROSS_SOURCE_TARGET$"):
        run_case(case, members=quiet, replay_factory=factory)


# ------------------------------------------------------- G3: an event exactly on the start bar


def test_g3_pre_start_intents_are_strictly_before_the_start_bar():
    bars = tiny_bars([2] * 6)
    sig = vector(6, buys={1, 2, 3})
    result = tiny_run(bars, [sig, vector(6)], start_time=bars[2].time)
    one = member_diag(result, "t-1")
    # by hand: the BUY of bar 1 is before the start bar (1 pre-start intent); the BUY ON bar 2 and the BUY of
    # bar 3 are not. Three intents, two decisions: only the bar 1 intent never reaches the ledger.
    assert (one["intents_buy"], one["pre_start_intents"]) == (3, 1)
    assert len(result["ledger"]["events"]) == 3 and len(result["ledger"]["decisions"]) == 2
    assert [row[0] for row in tiny_outline(result)] == [2, 3]  # the event on the start bar is decided
    assert result["diagnostics"]["bot"]["pre_start_intents"] == 1
    # a start bar after the last event counts all three; no start time counts none
    late = tiny_run(bars, [sig, vector(6)], start_time=bars[4].time)
    assert member_diag(late, "t-1")["pre_start_intents"] == 3 and late["ledger"]["decisions"] == []
    assert member_diag(tiny_run(bars, [sig, vector(6)]), "t-1")["pre_start_intents"] == 0


# --------------------------------------------------------------- G10 to G12: Bot-level guards


def two_member_streak(pair, atrs, first, second, **ranges):
    bars = tiny_bars(atrs, **ranges)
    n = len(bars)
    return tiny_run(
        bars, [vector(n, buys=first), vector(n, buys=second)], pair=pair, policy={"pauseAfterLossStreak": 1},
    )


def exit_signs(result):
    return [(f["entry_ref"].rsplit(":", 2)[0], Decimal(f["realized_r"]) > 0) for f in result["ledger"]["fills"]
            if f["event_type"] == "EXIT"]


def flat_cash(result):
    """Cash after the last EXIT fill (the Bot is flat there in the two G10 series)."""
    last = [f for f in result["ledger"]["fills"] if f["event_type"] == "EXIT"][-1]
    assert Decimal(last["cost"]) == 0
    return Decimal(last["cash"])


def test_g10_loss_streak_follows_the_bot_pnl_when_flat_not_the_last_exit_profit():
    # A: member 1 wins on bar 2, member 2 loses less on bar 3 (the LAST exit is a loss); the Bot ends flat with a
    # positive total pnl, so the streak stays 0 and member 1 may buy again on bar 4.
    # bar 0: member 1 buys (ATR 2: SL 98, TP 106). bar 1: member 2 buys (ATR 10: SL 90, TP 130).
    # bar 2 closes 107: member 1 takes profit (about 3,400 gained). bar 3 closes 89, low 88.5: member 2 stops out
    # (about 1,100 lost), so the Bot total is positive.
    won_then_lost = two_member_streak(
        ("1", "3"), [2, 10, 2, 2, 2], first={0, 4}, second={1}, closes={2: 107, 3: 89}, lows={3: 88.5},
        highs={2: 107.5},
    )
    assert exit_signs(won_then_lost) == [("t-1", True), ("t-2", False)]
    assert flat_cash(won_then_lost) > Decimal(1000000)  # the Bot total is a gain although the last exit lost
    assert tiny_outline(won_then_lost)[-1] == (4, "t-1", "BUY", "FILLED")
    # B: member 1 loses on bar 2, member 2 wins on bar 3 (the LAST exit is a win); the Bot's total is negative
    # (equal risk, both costs), so the streak is 1 and the buy on bar 4 is refused although the last exit won.
    # bar 0: member 1 buys (ATR 2: SL 98, TP 102). bar 1: member 2 buys (ATR 4: SL 96, TP 104). bar 2 closes 97.5,
    # low 97: member 1 stops out, about 1,250 lost. bar 3 closes 104.5: member 2 wins about 1,125: Bot total negative.
    lost_then_won = two_member_streak(
        ("1", "1"), [2, 4, 2, 2, 2], first={0, 4}, second={1}, closes={2: 97.5, 3: 104.5}, lows={2: 97},
        highs={3: 104.5},
    )
    assert exit_signs(lost_then_won) == [("t-1", False), ("t-2", True)]
    assert flat_cash(lost_then_won) < Decimal(1000000)  # the Bot total is a loss although the last exit won
    assert tiny_outline(lost_then_won)[-1] == (4, "t-1", "BUY", "Trading paused after loss streak")


def test_g11_daily_loss_guard_trips_exactly_at_minus_max_daily_loss_r():
    bars = tiny_bars([2, 2, 2, 2], lows={1: 97}, closes={1: 97})
    sigs = [vector(4, buys={0}), vector(4, buys={2})]  # member 1 buys, stops out on bar 1; member 2 asks on bar 2

    def run(limit):
        return tiny_run(bars, sigs, policy={"maxDailyLossR": limit})

    open_run = run(10000)
    (stop,) = [f for f in open_run["ledger"]["fills"] if f["event_type"] == "EXIT"]
    loss_r = Decimal(stop["realized_r"])
    assert stop["reason"] == "SL" and loss_r < 0
    assert tiny_outline(open_run)[-1] == (2, "t-2", "BUY", "FILLED")
    exact = run(str(-loss_r))  # the limit EQUALS the realized R of the day: the guard trips at equality
    assert tiny_outline(exact)[-1] == (2, "t-2", "BUY", "Maximum daily loss reached")
    above = run(str(-loss_r + Decimal("0.000000000000000001")))  # one unit above the loss: still open
    assert tiny_outline(above)[-1] == (2, "t-2", "BUY", "FILLED")


def test_g12_max_open_positions_is_one_bot_position_so_two_members_may_hold_together():
    bars = tiny_bars([2] * 4)
    sigs = [vector(4, buys={1}), vector(4, buys={1, 2})]
    result = tiny_run(bars, sigs, policy={"maxOpenPositions": 1})
    assert tiny_outline(result) == [
        (1, "t-1", "BUY", "FILLED"), (1, "t-2", "BUY", "FILLED"),
        (2, "t-2", "BUY", "FILLED"),
    ]
    assert result["ledger"]["open_allocations"] == 3
    # control: the cap is live, a flat Bot with maxOpenPositions 0 refuses the first entry of either member
    flat = tiny_run(bars, sigs, policy={"maxOpenPositions": 0})
    assert {row[3] for row in tiny_outline(flat)} == {"Maximum open positions reached"}
    assert flat["ledger"]["open_allocations"] == 0


# ------------------------------------------------------------------------- D8: closed policy


def test_d8_policy_is_closed_to_exactly_the_sixteen_node_policy_keys(scripted):
    members, bars, pair, kwargs = good_args(scripted)
    assert len(mp.POLICY_KEYS) == 16 and set(base_policy()) == set(mp.POLICY_KEYS)
    combined_paper_replay(members, bars, pair, **kwargs)  # the good policy runs
    extra = {**kwargs["policy"], "maxFooBar": 1}
    missing = {k: v for k, v in kwargs["policy"].items() if k != "killSwitch"}
    for bad in (extra, missing, {}, [], None, "policy", list(kwargs["policy"])):
        with pytest.raises(ValueError, match="^MP_INPUT_INVALID$"):
            combined_paper_replay(members, bars, pair, **{**kwargs, "policy": bad})
