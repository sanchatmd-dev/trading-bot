"""F09 S3a: HOLDOUT trace driver. Real SPT, Bridge, Risk and ledger on an offline fixture."""
import io
import json
import math
import os
import subprocess
import sys
import threading
from decimal import Decimal
from pathlib import Path

import pytest

from robot_quant import research_engine, trace_reproduction
from robot_quant.spt_custom_evaluator import CATALOG, CustomOptimizationPlan, CustomSignalInputs

SRC = Path(trace_reproduction.__file__).resolve().parents[1]
FIRST_TIME = 1799970600000
OHLCV = {"open", "high", "low", "close", "volume", "atr14", "rows", "dataset"}


def policy():
    return dict(killSwitch=False, maxSignalAgeSeconds=120, maxTradesPerDay=10000,
        maxDailyLossR=10000, pauseAfterLossStreak=10000, blockHighVolatility=False,
        maxVolatilityPercent=100, blockDuringNews=False, allowedSymbols=["BTCUSDT"],
        sideMode="BOTH", maxOpenPositions=5, onePositionPerSymbol=False,
        capPercentEquitySize=True, maxRiskPercent=100, maxOrderNotional=10000,
        maxDailyNotional=10000000)


def build(test_end=800):
    rows, previous = [], 100.0
    for i in range(test_end):
        close = 100 + 12 * math.sin(i / 23) + 2 * math.sin(i / 3)
        rows.append(dict(time=FIRST_TIME + i * 60000, open=str(previous),
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
        domains[name].append(baseline[name] + (1 if isinstance(baseline[name], int) else .1))
    contract = dict(version="ql3a-research-job-v1", scope="SPT_CUSTOM_ENGINEERING_ONLY",
        source="fixture", snapshot={"policy": policy(), "market": {"broker": "binance-global", "symbol": "BTCUSDT"}},
        input_lock={"baseline": baseline, "domains": domains},
        split={"warmup": 10, "train_end": 250, "validation_end": 500, "test_end": test_end},
        dataset={"bars": rows},
        model={"price_tick": .01, "quantity_step": .00001, "fee_bps": 10, "slippage_bps": 1, "risk_percent": 1, "version": "paper-close-v1"},
        capital={"cash": 1000, "equity": 1000}, deployment_id="fixture")
    plan = CustomOptimizationPlan(inputs, {name: (domains[name][0], domains[name][-1], 1 if isinstance(baseline[name], int) else .1) for name in selected})
    return contract, baseline, plan


@pytest.fixture
def golden(monkeypatch):
    contract, parameters, plan = build(800)
    # Only isolate source/snapshot enrollment. SPT, Bridge, Risk, ledger and metrics are real.
    monkeypatch.setattr(CustomOptimizationPlan, "from_snapshot", lambda *_: plan)
    return contract, parameters


@pytest.fixture
def open_entry(monkeypatch):
    contract, parameters, plan = build(712)  # 12 BUY and 11 EXIT fills: the last entry stays open
    monkeypatch.setattr(CustomOptimizationPlan, "from_snapshot", lambda *_: plan)
    return contract, parameters


def engine_bytes(contract, parameters):
    result = research_engine.evaluate({"contract": contract, "parameters": parameters, "kind": "HOLDOUT"})
    return json.dumps(result, sort_keys=True).encode()


def run_main(monkeypatch, capsys, raw: bytes):
    monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(raw)))
    try:
        trace_reproduction.main()
        status = 0
    except SystemExit as exit_:
        status = exit_.code
    captured = capsys.readouterr()
    return status, captured.out, captured.err


def strip_partition(rows):
    return [{k: v for k, v in row.items() if k != "partition"} for row in rows]


@pytest.mark.parametrize("fixture_name", ["golden", "open_entry"])
def test_a1_result_equals_engine_holdout_bytes_and_every_partition_has_a_closed_trade(request, monkeypatch, capsys, fixture_name):
    contract, parameters = request.getfixturevalue(fixture_name)
    reply = trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    expected = engine_bytes(contract, parameters)
    assert json.dumps(reply["result"], sort_keys=True).encode() == expected
    assert reply["result"]["kind"] == "HOLDOUT" and "test" in reply["result"]
    for name in ("train", "validation", "test"):
        assert reply["result"][name]["closed_trades"] >= 1
    # Same bytes through the stdio entry point (compact separators, like research_engine.main).
    status, out, err = run_main(monkeypatch, capsys, json.dumps({"contract": contract, "parameters": parameters}).encode())
    assert (status, err) == (0, "")
    parsed = json.loads(out)
    assert json.dumps(parsed["result"], sort_keys=True).encode() == expected
    assert out == json.dumps(reply, allow_nan=False, separators=(",", ":")) + "\n"


def test_a2_one_replay_captured_and_decisions_equal_a_direct_call(golden, monkeypatch):
    contract, parameters = golden
    calls = []
    original = research_engine.paper_replay

    def spy(bars, **kwargs):
        calls.append((bars, kwargs))
        return original(bars, **kwargs)

    monkeypatch.setattr(research_engine, "paper_replay", spy)
    reply = trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert len(calls) == 1
    bars, kwargs = calls[0]
    direct = original(bars, **kwargs)
    assert strip_partition(reply["decisions"]) == direct["decisions"]
    assert reply["result"]["decision_count"] == len(direct["decisions"])
    assert reply["result"]["fills"] == len(direct["fills"]) == len(reply["equity"])
    assert research_engine.paper_replay is spy  # the spy, not the capture wrapper, is restored


@pytest.mark.parametrize("calls", [0, 2])
def test_a2_replay_count_other_than_one_is_diverged(golden, monkeypatch, calls):
    contract, parameters = golden

    def engine(request):
        for _ in range(calls):
            research_engine.paper_replay([], deployment_id="x")
        return {}

    monkeypatch.setattr(research_engine, "evaluate", engine)
    if calls == 2:
        monkeypatch.setattr(research_engine, "paper_replay", lambda *a, **k: {"fills": [], "decisions": []})
    with pytest.raises(trace_reproduction.TraceRefusal) as caught:
        trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert caught.value.code == "TRACE_REPRODUCTION_DIVERGED"


def test_a2_diverged_code_reaches_stdout_only(golden, monkeypatch, capsys):
    contract, parameters = golden
    monkeypatch.setattr(research_engine, "evaluate", lambda request: {})
    status, out, err = run_main(monkeypatch, capsys, json.dumps({"contract": contract, "parameters": parameters}).encode())
    assert (status, json.loads(out), err) == (1, {"error": "TRACE_REPRODUCTION_DIVERGED"}, "")


def test_a3_original_paper_replay_restored_after_success_and_after_exception(golden, monkeypatch):
    contract, parameters = golden
    original = research_engine.paper_replay
    trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert research_engine.paper_replay is original
    with pytest.raises(ValueError):  # engine refusal: dimension outside the locked grid
        trace_reproduction.reproduce({"contract": contract, "parameters": {**parameters, "rr": 99}})
    assert research_engine.paper_replay is original

    def boom(request):
        research_engine.paper_replay([], deployment_id="x")
        raise RuntimeError("boom")

    stub = lambda *a, **k: {"fills": [], "decisions": []}  # noqa: E731
    monkeypatch.setattr(research_engine, "evaluate", boom)
    monkeypatch.setattr(research_engine, "paper_replay", stub)
    with pytest.raises(RuntimeError):
        trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert research_engine.paper_replay is stub


def partition_by_time(contract, time):
    rows, split = contract["dataset"]["bars"], contract["split"]
    for name, end in (("train", "train_end"), ("validation", "validation_end"), ("test", "test_end")):
        if time < rows[split[end]]["time"] if end != "test_end" else True:
            return name
    raise AssertionError


def test_a4_trade_rows_open_entry_net_formula_and_partition_counts(open_entry, monkeypatch):
    contract, parameters = open_entry
    captured = []
    original = research_engine.paper_replay

    def spy(bars, **kwargs):
        captured.append(original(bars, **kwargs))
        return captured[-1]

    monkeypatch.setattr(research_engine, "paper_replay", spy)
    reply = trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    fills = captured[0]["fills"]
    buys = [f for f in fills if f["event_type"] == "BUY"]
    exits = [f for f in fills if f["event_type"] == "EXIT"]
    assert len(buys) == len(exits) + 1  # one entry still open at test_end
    assert len(reply["trades"]) == len(exits)
    assert buys[-1]["entry_ref"] not in {t["entry_ref"] for t in reply["trades"]}
    assert [t["exit_time"] for t in reply["trades"]] == [f["time"] for f in exits]
    by_ref = {f["entry_ref"]: f for f in buys}
    for trade, fill in zip(reply["trades"], exits, strict=True):
        entry = by_ref[fill["entry_ref"]]
        cost = Decimal(entry["notional"]) + Decimal(entry["fee"])
        expected = Decimal(fill["notional"]) - Decimal(fill["fee"]) - cost * Decimal(fill["quantity"]) / Decimal(entry["quantity"])
        assert Decimal(trade["net"]) == expected
        assert trade["partition"] == partition_by_time(contract, trade["exit_time"])  # EXIT bar decides
        assert (trade["entry_price"], trade["quantity"], trade["exit_reason"]) == (entry["price"], entry["quantity"], fill["reason"])
    for name in ("train", "validation", "test"):
        assert sum(t["partition"] == name for t in reply["trades"]) == reply["result"][name]["closed_trades"]
    # Equity: one row per fill, cash after the fill plus held quantity at the fill price.
    held = Decimal(0)
    for row, fill in zip(reply["equity"], fills, strict=True):
        held += Decimal(fill["quantity"]) * (1 if fill["event_type"] == "BUY" else -1)
        assert Decimal(row["position_quantity"]) == held
        assert Decimal(row["equity_at_fill"]) == Decimal(fill["cash"]) + held * Decimal(fill["price"])
        assert (row["time"], row["event_type"], row["cash"]) == (fill["time"], fill["event_type"], fill["cash"])


def test_a4_partition_boundaries_belong_to_the_later_partition():
    edges = (100, 200, 300)
    label = trace_reproduction.partition_of
    assert [label(t, edges) for t in (100, 199, 200, 299, 300, 10**9)] == ["train", "train", "validation", "validation", "test", "test"]
    with pytest.raises(trace_reproduction.TraceRefusal):
        label(99, edges)


def test_a4_hand_made_trade_row_is_exact_in_every_key():
    buy = {"event_type": "BUY", "time": 150, "entry_ref": "a", "quantity": "2", "price": "10", "notional": "20", "fee": "1", "cash": "979", "reason": None, "realized_r": "0"}
    out = {"event_type": "EXIT", "time": 160, "entry_ref": "a", "quantity": "2", "price": "12", "notional": "24", "fee": "0.5", "cash": "1002.5", "reason": "TP", "realized_r": "0.5"}
    [trade] = trace_reproduction.build_trace([buy, out], [], (100, 200, 300))["trades"]
    assert trade == {
        "entry_ref": "a", "partition": "train", "entry_time": 150, "entry_price": "10",
        "quantity": "2", "entry_fee": "1", "exit_time": 160, "exit_price": "12",
        "exit_fee": "0.5", "exit_reason": "TP", "net": "2.5", "realized_r": "0.5",
    }


def test_a4_golden_first_trade_row_is_exact_in_every_key(golden, monkeypatch):
    contract, parameters = golden
    captured = []
    original = research_engine.paper_replay

    def spy(bars, **kwargs):
        captured.append(original(bars, **kwargs))
        return captured[-1]

    monkeypatch.setattr(research_engine, "paper_replay", spy)
    reply = trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    fills = captured[0]["fills"]
    out = next(f for f in fills if f["event_type"] == "EXIT")
    buy = next(f for f in fills if f["event_type"] == "BUY" and f["entry_ref"] == out["entry_ref"])
    assert (buy["fee"], out["price"], out["realized_r"]) != (out["fee"], buy["price"], buy["realized_r"])
    net = Decimal(out["notional"]) - Decimal(out["fee"]) - (Decimal(buy["notional"]) + Decimal(buy["fee"])) * Decimal(out["quantity"]) / Decimal(buy["quantity"])
    first = reply["trades"][0]
    assert first == {
        "entry_ref": out["entry_ref"], "partition": "train", "entry_time": buy["time"], "entry_price": buy["price"],
        "quantity": buy["quantity"], "entry_fee": buy["fee"], "exit_time": out["time"], "exit_price": out["price"],
        "exit_fee": out["fee"], "exit_reason": out["reason"], "net": format(net, "f"), "realized_r": out["realized_r"],
    }


def test_a4_trade_partition_follows_exit_bar_not_entry_bar():
    def fill(event_type, time, ref, cash, quantity="1", price="10"):
        return {"event_type": event_type, "time": time, "entry_ref": ref, "quantity": quantity, "price": price,
                "notional": "10", "fee": "0.1", "cash": cash, "reason": None if event_type == "BUY" else "TP", "realized_r": "0"}

    edges = (100, 200, 300)
    fills = [fill("BUY", 150, "a", "89.9"), fill("EXIT", 250, "a", "99.8"), fill("BUY", 299, "b", "89.7"),
             fill("EXIT", 300, "b", "99.6"), fill("BUY", 350, "c", "89.5")]
    trace = trace_reproduction.build_trace(fills, [], edges)
    assert [(t["entry_ref"], t["partition"]) for t in trace["trades"]] == [("a", "validation"), ("b", "test")]
    assert [r["partition"] for r in trace["equity"]] == ["train", "validation", "validation", "test", "test"]
    with pytest.raises(trace_reproduction.TraceRefusal):  # nothing may precede the warm-up end
        trace_reproduction.build_trace([fill("BUY", 99, "z", "1")], [], edges)
    with pytest.raises(trace_reproduction.TraceRefusal):  # EXIT without a captured entry
        trace_reproduction.build_trace([fill("EXIT", 150, "ghost", "1")], [], edges)


@pytest.mark.parametrize("field", ["train", "validation", "test"])
def test_a4_partition_count_cross_check_fails_closed(golden, monkeypatch, field):
    contract, parameters = golden
    real = research_engine.mark_period

    def skewed(bars, fills, start, end, cash):
        out = real(bars, fills, start, end, cash)
        if end == contract["split"][{"train": "train_end", "validation": "validation_end", "test": "test_end"}[field]]:
            out = {**out, "closed_trades": out["closed_trades"] + 1}
        return out

    monkeypatch.setattr(research_engine, "mark_period", skewed)
    with pytest.raises(trace_reproduction.TraceRefusal) as caught:
        trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert caught.value.code == "TRACE_REPRODUCTION_DIVERGED"


def cross_inputs():
    zero = {"closed_trades": 0, "gross_profit": "0", "gross_loss": "0"}
    result = {"decision_count": 2, "fills": 1, **{name: dict(zero) for name in trace_reproduction.PARTITIONS}}
    replay = {"decisions": [{}, {}], "fills": [{}], "open_allocations": 0, "position_quantity": "0"}
    trace = {"trades": [], "open_entries": 0, "final_position": Decimal(0)}
    return result, replay, trace


def test_a4_decision_and_fill_count_cross_check_fails_closed():
    result, replay, trace = cross_inputs()
    trace_reproduction.cross_check(result, replay, trace)
    for bad in ({**result, "decision_count": 3}, {**result, "fills": 2}):
        with pytest.raises(trace_reproduction.TraceRefusal):
            trace_reproduction.cross_check(bad, replay, trace)


def test_n3_gross_open_entry_and_final_position_cross_checks_fail_closed():
    result, replay, trace = cross_inputs()
    trade = {"partition": "test", "net": "1.5"}
    loss = {"partition": "test", "net": "-0.5"}
    good = {**trace, "trades": [trade, loss]}
    result["test"] = {"closed_trades": 2, "gross_profit": "1.5", "gross_loss": "0.5"}
    trace_reproduction.cross_check(result, replay, good)
    bads = [
        (replace_in(result, "test", gross_profit="1.6"), replay, good),
        (replace_in(result, "test", gross_loss="0.4"), replay, good),
        (result, {**replay, "open_allocations": 1}, good),
        (result, {**replay, "position_quantity": "1"}, good),
        (result, replay, {**good, "open_entries": 1}),
        (result, replay, {**good, "final_position": Decimal(1)}),
    ]
    for args in bads:
        with pytest.raises(trace_reproduction.TraceRefusal):
            trace_reproduction.cross_check(*args)


def replace_in(result, name, **changes):
    return {**result, name: {**result[name], **changes}}


def fill_row(event_type, ref, quantity):
    return {"event_type": event_type, "time": 150, "entry_ref": ref, "quantity": quantity, "price": "10",
            "notional": "10", "fee": "0.1", "cash": "1", "reason": None, "realized_r": "0"}


def test_n2_exit_quantity_must_equal_entry_quantity():
    edges = (100, 200, 300)
    trace_reproduction.build_trace([fill_row("BUY", "a", "2"), fill_row("EXIT", "a", "2")], [], edges)
    for quantity in ("1", "3"):
        with pytest.raises(trace_reproduction.TraceRefusal) as caught:
            trace_reproduction.build_trace([fill_row("BUY", "a", "2"), fill_row("EXIT", "a", quantity)], [], edges)
        assert caught.value.code == "TRACE_REPRODUCTION_DIVERGED"


def test_n3_end_to_end_forged_replay_fields_are_diverged(golden, monkeypatch):
    contract, parameters = golden
    original = research_engine.paper_replay
    for field, value in (("open_allocations", 7), ("position_quantity", "123")):
        monkeypatch.setattr(research_engine, "paper_replay", lambda *a, _f=field, _v=value, **k: {**original(*a, **k), _f: _v})
        with pytest.raises(trace_reproduction.TraceRefusal) as caught:
            trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
        assert caught.value.code == "TRACE_REPRODUCTION_DIVERGED"


def test_n3_forged_gross_profit_in_result_is_diverged(golden, monkeypatch):
    contract, parameters = golden
    real = research_engine.mark_period
    monkeypatch.setattr(research_engine, "mark_period", lambda *a: {**real(*a), "gross_loss": "999"})
    with pytest.raises(trace_reproduction.TraceRefusal):
        trace_reproduction.reproduce({"contract": contract, "parameters": parameters})


def test_n1_concurrent_reproduce_calls_are_serialized_and_identical(golden):
    contract, parameters = golden
    original = research_engine.paper_replay
    barrier, outputs, errors = threading.Barrier(2), [], []

    def work():
        try:
            barrier.wait()
            outputs.append(json.dumps(trace_reproduction.reproduce({"contract": contract, "parameters": parameters}), sort_keys=True))
        except BaseException as error:  # noqa: BLE001
            errors.append(error)

    threads = [threading.Thread(target=work) for _ in range(2)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == [] and len(outputs) == 2 and outputs[0] == outputs[1]
    assert research_engine.paper_replay is original


@pytest.mark.parametrize("mutate", [
    lambda c, p: {"contract": c, "parameters": p, "extra": 1},
    lambda c, p: {"contract": c, "parameters": p, "kind": "CANDIDATE"},
    lambda c, p: {"contract": c},
    lambda c, p: [c, p],
])
def test_a5_request_shape_refused_with_code_only(golden, monkeypatch, capsys, mutate):
    contract, parameters = golden
    status, out, err = run_main(monkeypatch, capsys, json.dumps(mutate(contract, parameters)).encode())
    assert (status, json.loads(out), err) == (1, {"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}, "")


@pytest.mark.parametrize("raw", [b'{"contract": NaN, "parameters": {}}', b'{"contract": Infinity, "parameters": {}}',
                                 b'{"contract": 1e999, "parameters": {}}', b'{"contract": {}, "parameters": ', b"\xff\xfe", b""])
def test_a5_non_finite_and_malformed_input_give_code_only(monkeypatch, capsys, raw):
    status, out, err = run_main(monkeypatch, capsys, raw)
    assert (status, err) == (1, "")
    assert json.loads(out) == {"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}
    assert "Traceback" not in out and str(SRC) not in out


def test_a5_oversize_request_and_engine_refusal_give_code_only(golden, monkeypatch, capsys):
    status, out, err = run_main(monkeypatch, capsys, b" " * (trace_reproduction.REQUEST_LIMIT + 1))
    assert (status, json.loads(out), err) == (1, {"error": "RESEARCH_REQUEST_TOO_LARGE"}, "")
    contract, parameters = golden
    status, out, err = run_main(monkeypatch, capsys, json.dumps({"contract": contract, "parameters": {**parameters, "rr": 99}}).encode())
    assert (status, json.loads(out), err) == (1, {"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}, "")


def test_t2_size_limit_boundary(golden, monkeypatch, capsys):
    limit = trace_reproduction.REQUEST_LIMIT
    status, out, err = run_main(monkeypatch, capsys, b" " * limit)
    assert (status, err) == (1, "")
    assert json.loads(out) == {"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}  # read in full, not too large
    status, out, err = run_main(monkeypatch, capsys, b" " * (limit + 1))
    assert (status, json.loads(out), err) == (1, {"error": "RESEARCH_REQUEST_TOO_LARGE"}, "")


def test_a5_real_process_refusals_leave_no_traceback_or_path():
    env = {**os.environ, "PYTHONPATH": str(SRC)}
    for raw in (b'{"contract": NaN, "parameters": {}}', b'{"contract": {"version": "x"}, "parameters": {}}'):
        done = subprocess.run([sys.executable, "-m", "robot_quant.trace_reproduction"], input=raw, capture_output=True, env=env, timeout=60, check=False)
        assert done.returncode == 1
        assert json.loads(done.stdout) == {"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}
        assert done.stderr == b""
        assert b"Traceback" not in done.stdout and str(SRC).encode() not in done.stdout


def walk(value):
    if isinstance(value, dict):
        for key, child in value.items():
            yield key
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def test_a6_reply_keys_exact_and_no_ohlcv(golden):
    contract, parameters = golden
    reply = trace_reproduction.reproduce({"contract": contract, "parameters": parameters})
    assert list(reply) == ["result", "trades", "decisions", "equity"]
    assert not OHLCV & set(walk(reply))
    assert reply["trades"] and reply["decisions"] and reply["equity"]
    assert {r["partition"] for rows in (reply["trades"], reply["decisions"], reply["equity"]) for r in rows} == {"train", "validation", "test"}
    assert {"time", "event_type", "cash", "position_quantity", "equity_at_fill"} <= set(reply["equity"][0])
    assert json.loads(json.dumps(reply, allow_nan=False)) == reply  # strict JSON, strings for decimals
