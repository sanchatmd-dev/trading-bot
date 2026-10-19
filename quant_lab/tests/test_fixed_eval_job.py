"""FE-2a: the supervised job wrapper around the fixed-input evaluator.

The evaluator maths is covered by ``test_fixed_eval.py``. These tests cover the wrapper only:
request framing, the success frame, the error frame, the terminal ACK, size limits and the
identity fields that ``fixed-eval-closure-v1`` pins.
"""

import copy
import io
import json
import math
import subprocess
import sys
from pathlib import Path

import pytest

from robot_quant import fixed_eval, fixed_eval_job
from robot_quant.fixed_eval import evaluate_fixed

MINUTE = 60000
T0 = 1_800_000_000_000
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
POLICY = dict(
    killSwitch=False,
    maxSignalAgeSeconds=120,
    maxTradesPerDay=1000,
    maxDailyLossR=10000,
    pauseAfterLossStreak=10000,
    blockHighVolatility=False,
    maxVolatilityPercent=100,
    blockDuringNews=False,
    allowedSymbols=["BTCUSDT"],
    sideMode="BOTH",
    maxOpenPositions=1,
    onePositionPerSymbol=False,
    capPercentEquitySize=True,
    maxRiskPercent=100,
    maxOrderNotional=10000,
    maxDailyNotional=100000000,
)
MODEL = dict(
    price_tick="0.01", quantity_step="0.001", fee_bps="10", slippage_bps="10", risk_percent="1"
)
ENGINE = "e" * 64
DATASET = "d" * 64
ACK = b"QUANT_IO_TERMINAL_ACK_V1\n"


def rows(count):
    price, out, state, atr = 30000.0, [], 12345, 40.0
    for index in range(count):
        state = (state * 1103515245 + 12345) % 2**31
        close = max(1000.0, price + 40 * math.sin(index / 90) + (state / 2**31 - 0.5) * 60)
        high, low = max(price, close) + 5, min(price, close) - 5
        atr = max(high - low, abs(high - price), abs(low - price)) / 14 + 13 / 14 * atr
        out.append(
            dict(
                time=T0 + (index + 1) * MINUTE,
                open=f"{price:.2f}",
                high=f"{high:.2f}",
                low=f"{low:.2f}",
                close=f"{close:.2f}",
                volume="1",
                atr14=f"{atr * 1.7:.6f}",
            )
        )
        price = close
    return out


def request(count=120, **contract_changes):
    contract = dict(
        model=MODEL,
        policy=POLICY,
        initial_cash="10000",
        initial_equity="10000",
        broker="binance-global",
        symbol="BTCUSDT",
        deployment_id="fe2a",
        engine_hash=ENGINE,
        dataset_sha256=DATASET,
        parent_run_id="run-parent",
        selection_id=None,
        rows=rows(count),
    )
    contract.update(contract_changes)
    return dict(
        contract=contract,
        parameters=dict(inputs=dict(INPUTS), atr_multiplier="2", rr="1.5"),
        kind="EVALUATION",
        split=dict(warmup=40, end=count),
    )


def encoded(value):
    return json.dumps(value).encode()


class Out(io.BytesIO):
    flushed = False

    def flush(self):
        self.flushed = True
        super().flush()


class Std:
    """A text stream stand-in that exposes only ``buffer`` (the wrapper never uses text mode)."""

    def __init__(self, buffer):
        self.buffer = buffer


class AckInput(io.BytesIO):
    """Request line, then ACK bytes; asserts the frame was flushed before the ACK is read."""

    def __init__(self, line, out, tail):
        super().__init__(line + tail)
        self.out = out
        self.line = len(line)
        self.checked = False

    def readline(self, size=-1):
        if self.tell() >= self.line:
            self.checked = True
            assert self.out.flushed
            assert self.out.getvalue().endswith(b"\n")
        return super().readline(size)


@pytest.fixture
def stream(monkeypatch):
    monkeypatch.setattr(fixed_eval_job, "prepare_io_telemetry", lambda: None)
    monkeypatch.delenv("QUANT_IO_TERMINAL_PROTOCOL", raising=False)
    return monkeypatch


def terminal(monkeypatch):
    monkeypatch.setenv("QUANT_IO_TERMINAL_PROTOCOL", "quant-io-terminal-v1")
    for name in fixed_eval_job.READINESS:
        monkeypatch.setenv(name, "present")


def drive(monkeypatch, stdin, out=None):
    out = out if out is not None else Out()
    monkeypatch.setattr(sys, "stdin", Std(stdin))
    monkeypatch.setattr(sys, "stdout", Std(out))
    code = 0
    try:
        fixed_eval_job.main()
    except SystemExit as exit_:
        code = exit_.code
    return code, out.getvalue()


def test_success_frame_carries_the_unchanged_evaluator_result(stream):
    req = request()
    code, raw = drive(stream, io.BytesIO(encoded(req)))
    frame = json.loads(raw)
    assert code == 0
    assert raw.endswith(b"\n") and raw.count(b"\n") == 1
    assert set(frame) == {"checkpoint", "result"}
    assert frame["checkpoint"] is None
    expected = json.loads(json.dumps(evaluate_fixed(**copy.deepcopy(req))))
    assert frame["result"] == expected
    assert frame["result"]["evaluator_closure"] == "fixed-eval-closure-v1"
    assert frame["result"]["engine_hash"] == ENGINE
    assert frame["result"]["dataset_sha256"] == DATASET
    assert frame["result"]["parent_run_id"] == "run-parent"
    assert frame["result"]["selection_id"] is None


def test_stress_kind_runs_and_the_frame_is_canonical_and_repeatable(stream):
    req = request()
    req["kind"] = "EVALUATION_STRESS"
    first = drive(stream, io.BytesIO(encoded(req)))
    second = drive(stream, io.BytesIO(encoded(req)))
    assert first == second and first[0] == 0
    frame = json.loads(first[1])
    assert frame["result"]["kind"] == "EVALUATION_STRESS"
    assert (
        first[1]
        == json.dumps(frame, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()
        + b"\n"
    )


def test_terminal_frame_is_flushed_before_the_exact_ack(stream):
    terminal(stream)
    out = Out()
    line = encoded(request()) + b"\n"
    stdin = AckInput(line, out, ACK)
    code, raw = drive(stream, stdin, out)
    assert code == 0 and stdin.checked
    assert json.loads(raw)["checkpoint"] is None


@pytest.mark.parametrize("tail", [b"", b"WRONG\n", b"X" * 65 + b"\n", ACK + b"X"])
def test_terminal_refuses_missing_wrong_or_long_ack_and_keeps_the_sent_frame(stream, tail):
    terminal(stream)
    out = Out()
    line = encoded(request()) + b"\n"
    code, raw = drive(stream, AckInput(line, out, tail), out)
    assert code == 1
    assert raw.count(b"\n") == 1 and "result" in json.loads(raw)  # no error frame after the frame


@pytest.mark.parametrize("protocol", ["unknown", "quant-io-terminal-v1"])
def test_terminal_refuses_unknown_protocol_or_partial_readiness(stream, protocol):
    stream.setenv("QUANT_IO_TERMINAL_PROTOCOL", protocol)
    for name in fixed_eval_job.READINESS:
        stream.delenv(name, raising=False)
    code, raw = drive(stream, io.BytesIO(encoded(request()) + b"\n"))
    assert code == 1
    assert json.loads(raw) == {"error": "QUANT_IO_READINESS_CONFIGURATION_REQUIRED"}


def test_telemetry_is_primed_before_the_request_is_read(stream):
    terminal(stream)
    order = []
    stream.setattr(fixed_eval_job, "prepare_io_telemetry", lambda: order.append("prepare"))

    class Watch(AckInput):
        def readline(self, size=-1):
            order.append("read")
            return super().readline(size)

    out = Out()
    drive(stream, Watch(encoded(request()) + b"\n", out, ACK), out)
    assert order[:2] == ["prepare", "read"]


def test_telemetry_failure_is_an_error_frame_and_no_request_is_read(stream):
    terminal(stream)

    def refuse():
        raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")

    stream.setattr(fixed_eval_job, "prepare_io_telemetry", refuse)
    code, raw = drive(stream, io.BytesIO(b"never read\n"))
    assert code == 1 and json.loads(raw) == {"error": "QUANT_IO_TELEMETRY_UNAVAILABLE"}


@pytest.mark.parametrize(
    "mutate,expected",
    [
        (lambda r: r["contract"].update(seed=1), "QR4_EVALUATION_SEARCH_REFUSED"),
        (lambda r: r["parameters"].update(budget=3), "QR4_EVALUATION_SEARCH_REFUSED"),
        (lambda r: r["contract"]["rows"][0].update(slot=1), "QR4_EVALUATION_SEARCH_REFUSED"),
        (
            lambda r: r["contract"].pop("engine_hash"),
            "QR4_EVALUATION_INPUT_INVALID:contract.engine_hash",
        ),
        (
            lambda r: r["contract"].update(engine_hash=None),
            "QR4_EVALUATION_INPUT_INVALID:contract.engine_hash",
        ),
        (
            lambda r: r["contract"].update(engine_hash="E" * 64),
            "QR4_EVALUATION_INPUT_INVALID:contract.engine_hash",
        ),
        (
            lambda r: r["contract"].update(engine_hash="e" * 63),
            "QR4_EVALUATION_INPUT_INVALID:contract.engine_hash",
        ),
        (
            lambda r: r["contract"].pop("dataset_sha256"),
            "QR4_EVALUATION_INPUT_INVALID:contract.dataset_sha256",
        ),
        (
            lambda r: r["contract"].update(dataset_sha256=7),
            "QR4_EVALUATION_INPUT_INVALID:contract.dataset_sha256",
        ),
        (lambda r: r.update(kind="EVALUATE"), "QR4_EVALUATION_INPUT_INVALID:kind"),
        (lambda r: r.update(extra=1), "QR4_EVALUATION_INPUT_INVALID:request"),
        (lambda r: r.pop("split"), "QR4_EVALUATION_INPUT_INVALID:request"),
        (lambda r: r.update(contract=[]), "QR4_EVALUATION_INPUT_INVALID:contract"),
        (lambda r: r["split"].update(end=9999), "QR4_EVALUATION_INPUT_INVALID:split"),
    ],
)
def test_refusals_are_error_frames_with_exit_one(stream, mutate, expected):
    req = request()
    mutate(req)
    code, raw = drive(stream, io.BytesIO(encoded(req)))
    assert code == 1
    assert json.loads(raw) == {"error": expected}
    assert raw.endswith(b"\n")


def test_search_refusal_wins_over_a_missing_identity(stream):
    req = request()
    req["contract"].pop("engine_hash")
    req["contract"]["domain"] = [1]
    assert json.loads(drive(stream, io.BytesIO(encoded(req)))[1]) == {
        "error": "QR4_EVALUATION_SEARCH_REFUSED"
    }


@pytest.mark.parametrize(
    "raw",
    [b"", b"{", b"[]", b"null", b'{"contract": NaN}', b'{"contract": Infinity}', b"\xff\xfe"],
)
def test_malformed_requests_are_request_json_or_shape_errors(stream, raw):
    code, out = drive(stream, io.BytesIO(raw))
    assert code == 1
    error = json.loads(out)["error"]
    assert error.startswith("QR4_EVALUATION_INPUT_INVALID:")


def test_deeply_nested_request_is_refused_cleanly(stream):
    code, out = drive(stream, io.BytesIO(b"[" * 200000))
    assert code == 1
    assert json.loads(out) == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}


def test_terminal_request_must_be_one_non_empty_line(stream):
    terminal(stream)
    for line in (b"\n", encoded(request())):
        code, raw = drive(stream, io.BytesIO(line))
        assert code == 1
        assert json.loads(raw) == {"error": "QR4_EVALUATION_INPUT_INVALID:request.json"}


def test_oversize_request_is_refused_in_both_transports(stream):
    stream.setattr(fixed_eval_job, "IPC_LIMIT", 64)
    code, raw = drive(stream, io.BytesIO(b"x" * 65))
    assert code == 1 and json.loads(raw) == {"error": "FIXED_EVAL_REQUEST_TOO_LARGE"}
    terminal(stream)
    code, raw = drive(stream, io.BytesIO(b"x" * 80 + b"\n"))
    assert code == 1 and json.loads(raw) == {"error": "FIXED_EVAL_REQUEST_TOO_LARGE"}


def test_oversize_response_is_an_error_frame_not_a_partial_frame(stream):
    stream.setattr(fixed_eval_job, "IPC_LIMIT", 20000)
    stream.setattr(fixed_eval, "evaluate_fixed", lambda *a: {"blob": "x" * 30000})
    code, raw = drive(stream, io.BytesIO(encoded(request())))
    assert code == 1
    assert json.loads(raw) == {"error": "FIXED_EVAL_RESPONSE_TOO_LARGE"}


def test_unexpected_exception_maps_to_the_generic_code(stream):
    def boom(*args, **kwargs):
        raise RuntimeError("/secret/path traceback text")

    stream.setattr(fixed_eval, "evaluate_fixed", boom)
    code, raw = drive(stream, io.BytesIO(encoded(request())))
    assert code == 1
    assert json.loads(raw) == {"error": "QR4_EVALUATION_FAILED"}
    assert b"secret" not in raw


def test_unencodable_result_maps_to_the_generic_code(stream):
    stream.setattr(fixed_eval, "evaluate_fixed", lambda *a: {"bad": float("nan")})
    code, raw = drive(stream, io.BytesIO(encoded(request())))
    assert code == 1 and json.loads(raw) == {"error": "QR4_EVALUATION_FAILED"}


def test_module_run_has_no_stderr_and_matches_in_process_result():
    path = Path(fixed_eval_job.__file__)
    req = request()
    child = subprocess.run(
        [sys.executable, "-m", "robot_quant.fixed_eval_job"],
        input=encoded(req),
        capture_output=True,
        timeout=120,
        env={"PYTHONPATH": str(path.parents[1]), "PATH": ""},
    )
    assert child.returncode == 0 and child.stderr == b""
    assert json.loads(child.stdout)["result"] == json.loads(
        json.dumps(evaluate_fixed(**copy.deepcopy(req)))
    )
    bad = request()
    bad["contract"]["seed"] = 1
    refused = subprocess.run(
        [sys.executable, "-m", "robot_quant.fixed_eval_job"],
        input=encoded(bad),
        capture_output=True,
        timeout=120,
        env={"PYTHONPATH": str(path.parents[1]), "PATH": ""},
    )
    assert refused.returncode == 1 and refused.stderr == b""
    assert json.loads(refused.stdout) == {"error": "QR4_EVALUATION_SEARCH_REFUSED"}


def test_wrapper_reuses_the_closure_constant_of_the_evaluator():
    assert fixed_eval.EVALUATOR_CLOSURE == "fixed-eval-closure-v1"
