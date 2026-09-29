"""Bounded JSON continuation of the narrow SPT Custom/V1 Paper calculation.

No raw prefix, fills history or holdout bars are retained in continuation state.
State hashes detect accidental corruption; the scheduler owns authoritative state.
"""
import hashlib
import json
import math
import os
import sys
import time
from collections import Counter
from dataclasses import asdict
from decimal import Decimal, InvalidOperation, localcontext

from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.paper_state import PaperState, finite_decimal
from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, SptCustomEvaluator

IPC_LIMIT = 8 * 1024 * 1024
STATE_LIMIT = 1024 * 1024
STATE_VERSION = "research-chunk-v1"


def prepare_io_telemetry():
    """Prime genuine byte counters inside the evaluator unit before reading IPC."""
    names = ("QUANT_IO_READY_FILE", "QUANT_IO_READY_DEVICE", "QUANT_IO_READY_RBPS", "QUANT_IO_READY_WBPS")
    values = [os.environ.get(name) for name in names]
    if not any(values):
        return
    if not all(values):
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    filename, device, rbps, wbps = values
    if not filename.startswith("/") or not device.replace(":", "").isdigit() or device.count(":") != 1:
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    if not rbps.isdecimal() or not wbps.isdecimal() or int(rbps) < 1024 or int(wbps) < 1024:
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    root = os.path.dirname(filename)
    if not os.path.basename(filename).startswith(".pending-"):
        raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
    storage_device = os.stat(root).st_dev
    actual = os.path.realpath(f"/sys/dev/block/{os.major(storage_device)}:{os.minor(storage_device)}")
    approved = os.path.realpath(f"/sys/dev/block/{device}")
    if not os.path.exists(actual) or not os.path.exists(approved) or not (actual == approved or actual.startswith(approved + "/")):
        raise ValueError("QUANT_IO_STORAGE_DEVICE_MISMATCH")
    groups = [line[3:] for line in open("/proc/self/cgroup", encoding="ascii").read().splitlines() if line.startswith("0::")]
    if len(groups) != 1 or ".." in groups[0] or not groups[0].startswith("/"):
        raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
    location = os.path.join("/sys/fs/cgroup", groups[0].lstrip("/"))
    identity = os.stat(location).st_ino

    def fields(name):
        lines = [line.split() for line in open(os.path.join(location, name), encoding="ascii") if line.split() and line.split()[0] == device]
        if len(lines) != 1:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        result = {}
        for token in lines[0][1:]:
            key, separator, value = token.partition("=")
            if not separator or key in result:
                raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
            result[key] = value
        return result

    def limits():
        if os.stat(location).st_ino != identity:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        maximum = fields("io.max")
        if maximum.get("rbps") != rbps or maximum.get("wbps") != wbps:
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")

    deadline = time.monotonic() + 2
    limits()
    descriptor = os.open(filename, os.O_CREAT | os.O_EXCL | os.O_WRONLY | os.O_NOFOLLOW, 0o600)
    try:
        block = b"Q" * 4096
        if os.write(descriptor, block) != len(block):
            raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    while time.monotonic() < deadline:
        limits()
        try:
            counters = fields("io.stat")
        except ValueError:
            counters = {}
        if counters.get("rbytes", "").isdecimal() and counters.get("wbytes", "").isdecimal() and time.monotonic() < deadline:
            return
        time.sleep(0.025)
    raise ValueError("QUANT_IO_TELEMETRY_UNAVAILABLE")


def canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False).encode()


def digest(value):
    return hashlib.sha256(canonical(value)).hexdigest()


def export_evaluator(evaluator):
    # Preserve the exact binary float across Python and JavaScript JSON codecs.
    # JSON numbers lose distinctions such as 100.0/100 and -0.0/0 in Node.
    def freeze(value):
        if isinstance(value, float):
            return str(value)
        if isinstance(value, (list, tuple)):
            return [freeze(v) for v in value]
        return value
    return {k: freeze(v) for k, v in vars(evaluator).items() if k != "inputs"}


def state_float(value):
    if not isinstance(value, str):
        raise ValueError("INVALID_EVALUATOR_STATE")
    restored = float(value)
    if not math.isfinite(restored) or str(restored) != value:
        raise ValueError("INVALID_EVALUATOR_STATE")
    return restored


def import_evaluator(evaluator, state, next_bar):
    expected = set(vars(evaluator)) - {"inputs"}
    if set(state) != expected or type(state["index"]) is not int or state["index"] != next_bar - 1:
        raise ValueError("INVALID_EVALUATOR_STATE")
    ints = {"index", "direction", "long_expiry", "exit_expiry", "trade_start"}
    bools = {"long_active", "exit_active"}
    lists = {"tr_seed", "highs", "lows", "previous"}
    for name, value in state.items():
        if name in ints:
            if value is None and name == "trade_start":
                continue
            if type(value) is not int:
                raise ValueError("INVALID_EVALUATOR_STATE")
        elif name in bools:
            if type(value) is not bool:
                raise ValueError("INVALID_EVALUATOR_STATE")
        elif name in lists:
            if value is None and name == "previous":
                continue
            if not isinstance(value, list):
                raise ValueError("INVALID_EVALUATOR_STATE")
            for v in value:
                state_float(v)
        elif value is not None:
            state_float(value)
    p = evaluator.inputs
    if state["direction"] not in (-1, 1) or len(state["tr_seed"]) != min(next_bar, p.atr_len) or len(state["highs"]) != min(next_bar, p.confirm_lookback) or len(state["lows"]) != min(next_bar, p.confirm_lookback):
        raise ValueError("INVALID_EVALUATOR_STATE")
    if next_bar and (state["previous"] is None or len(state["previous"]) != 5 or state["fast"] is None or state["slow"] is None):
        raise ValueError("INVALID_EVALUATOR_STATE")
    if (next_bar >= p.atr_len) != (state["atr"] is not None):
        raise ValueError("INVALID_EVALUATOR_STATE")
    if state["trade_start"] is not None and not 0 <= state["trade_start"] < next_bar:
        raise ValueError("INVALID_EVALUATOR_STATE")
    for name, value in state.items():
        if name == "previous" and value is not None:
            value = tuple(state_float(v) for v in value)
        elif name in ("tr_seed", "highs", "lows"):
            value = [state_float(v) for v in value]
        elif name not in ints | bools and value is not None:
            value = state_float(value)
        setattr(evaluator, name, value)


class StreamingMetrics:
    """Exact chronological mark_period arithmetic with bounded open-entry state."""

    def __init__(self, cash, split):
        self.cash = cash
        self.quantity = Decimal(0)
        self.entries = {}
        self.periods = {name: {"start": start, "end": end, "start_equity": None,
            "end_equity": None, "peak": None, "worst": Decimal(0),
            "wins": Decimal(0), "losses": Decimal(0), "closed": 0}
            for name, start, end in (("train", split["warmup"], split["train_end"]),
                                    ("validation", split["train_end"], split["validation_end"]),
                                    ("test", split["validation_end"], split["test_end"]))}

    def step(self, i, bar, fills):
        # The reference mark_period uses the default Decimal context, not Paper's 40 digits.
        with localcontext() as context:
            context.prec = 28
            for fill in fills:
                self.cash = Decimal(fill["cash"])
                q = Decimal(fill["quantity"])
                if fill["event_type"] == "BUY":
                    self.quantity += q
                    self.entries[fill["entry_ref"]] = (q, Decimal(fill["notional"]) + Decimal(fill["fee"]))
                else:
                    self.quantity -= q
                    entry_qty, entry_cost = self.entries.pop(fill["entry_ref"])
                    net = Decimal(fill["notional"]) - Decimal(fill["fee"]) - entry_cost * q / entry_qty
                    for p in self.periods.values():
                        if p["start"] <= i < p["end"]:
                            p["closed"] += 1
                            if net > 0:
                                p["wins"] += net
                            elif net < 0:
                                p["losses"] -= net
            equity = self.cash + self.quantity * bar.close
            for p in self.periods.values():
                if i == p["start"] - 1:
                    p["start_equity"] = equity
                if p["start"] <= i < p["end"]:
                    p["peak"] = max(p["peak"] if p["peak"] is not None else p["start_equity"], equity)
                    p["worst"] = max(p["worst"], (p["peak"] - equity) / p["peak"] * 100)
                    p["end_equity"] = equity

    def result(self, name):
        p = self.periods[name]
        if p["start_equity"] is None or p["start_equity"] <= 0 or p["end_equity"] is None:
            raise ValueError("INVALID_SPLIT_START_EQUITY")
        with localcontext() as context:
            context.prec = 28
            return {"bars": p["end"] - p["start"], "closed_trades": p["closed"],
                "start_equity": str(p["start_equity"]), "end_equity": str(p["end_equity"]),
                "net_return_percent": str((p["end_equity"] / p["start_equity"] - 1) * 100),
                "max_drawdown_percent": str(p["worst"]),
                "profit_factor": str(p["wins"] / p["losses"]) if p["losses"] > 0 else None,
                "gross_profit": str(p["wins"]), "gross_loss": str(p["losses"])}

    def export_state(self):
        return {"cash": str(self.cash), "quantity": str(self.quantity),
            "entries": {ref: [str(v) for v in pair] for ref, pair in self.entries.items()},
            "periods": {name: {k: str(v) if isinstance(v, Decimal) else v for k, v in p.items()}
                        for name, p in self.periods.items()}}

    def import_state(self, state, next_bar):
        if set(state) != {"cash", "quantity", "entries", "periods"} or set(state["periods"]) != set(self.periods) or len(state["entries"]) > 1000:
            raise ValueError("INVALID_METRICS_STATE")
        self.cash, self.quantity = finite_decimal(state["cash"]), finite_decimal(state["quantity"])
        self.entries = {}
        for ref, pair in state["entries"].items():
            if not isinstance(ref, str) or not isinstance(pair, list) or len(pair) != 2:
                raise ValueError("INVALID_METRICS_STATE")
            self.entries[ref] = tuple(finite_decimal(v) for v in pair)
            if min(self.entries[ref]) <= 0:
                raise ValueError("INVALID_METRICS_STATE")
        if self.quantity < 0 or sum((p[0] for p in self.entries.values()), Decimal(0)) != self.quantity:
            raise ValueError("INVALID_METRICS_STATE")
        for name, p in state["periods"].items():
            expected = self.periods[name]
            if set(p) != set(expected) or type(p["start"]) is not int or type(p["end"]) is not int or p["start"] != expected["start"] or p["end"] != expected["end"] or type(p["closed"]) is not int or not 0 <= p["closed"] <= next_bar * 1000:
                raise ValueError("INVALID_METRICS_STATE")
            self.periods[name] = {k: finite_decimal(v) if k not in ("start", "end", "closed") and v is not None else v for k, v in p.items()}
            restored = self.periods[name]
            if any(restored[k] is None or restored[k] < 0 for k in ("worst", "wins", "losses")):
                raise ValueError("INVALID_METRICS_STATE")
            if (restored["start_equity"] is not None) != (next_bar >= restored["start"]) or (restored["end_equity"] is not None) != (next_bar > restored["start"]) or (restored["peak"] is not None) != (next_bar > restored["start"]):
                raise ValueError("INVALID_METRICS_STATE")


def evaluate_chunk(request, *, trace=None):
    """Advance only supplied rows; optional trace sink is unavailable through IPC."""
    if set(request) != {"contract", "parameters", "kind", "rows", "checkpoint"}:
        raise ValueError("INVALID_RESEARCH_CHUNK_REQUEST")
    contract, parameters, kind, rows, checkpoint = (request[k] for k in ("contract", "parameters", "kind", "rows", "checkpoint"))
    if contract["version"] != "ql3a-research-job-v1" or contract["scope"] != "SPT_CUSTOM_ENGINEERING_ONLY" or "bars" in contract["dataset"]:
        raise ValueError("UNSUPPORTED_RESEARCH_CONTRACT")
    if kind not in {"CANDIDATE", "SENSITIVITY", "STRESS", "HOLDOUT"}:
        raise ValueError("UNSUPPORTED_RESEARCH_STEP")
    for value in (contract["engine_hash"], contract["baseline_snapshot_hash"], contract["dataset"]["sha256"]):
        if not isinstance(value, str) or len(value) != 64 or any(c not in "0123456789abcdef" for c in value):
            raise ValueError("INVALID_RESEARCH_IDENTITY")
    split = contract["split"]
    if set(split) != {"warmup", "train_end", "validation_end", "test_end"} or any(type(v) is not int for v in split.values()) or not 0 < split["warmup"] < split["train_end"] < split["validation_end"] < split["test_end"] <= 10000:
        raise ValueError("INVALID_RESEARCH_SPLIT")
    end = split["test_end"] if kind == "HOLDOUT" else split["validation_end"]
    first_time = contract["dataset"]["first_time"]
    if type(first_time) is not int or first_time <= 0:
        raise ValueError("INVALID_RESEARCH_DATASET")
    plan = CustomOptimizationPlan.from_snapshot(contract["source"].encode(), contract["snapshot"])
    if set(parameters) != set(contract["input_lock"]["baseline"]):
        raise ValueError("RESEARCH_DIMENSION_MISMATCH")
    for name, value in parameters.items():
        if type(value) not in (int, float) or not math.isfinite(value) or value not in contract["input_lock"]["domains"][name]:
            raise ValueError("CANDIDATE_OUTSIDE_LOCKED_GRID")
    evaluator = SptCustomEvaluator(plan.candidate({k: v for k, v in parameters.items() if k in plan.domains}))
    raw = contract["model"]
    factor = 2 if kind == "STRESS" else 1
    model = PaperModel(**{k: Decimal(str(raw[k])) * (factor if k in ("fee_bps", "slippage_bps") else 1) for k in ("price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent")}, version=raw["version"])
    cash = Decimal(str(contract["capital"]["cash"]))
    equity = Decimal(str(contract["capital"]["equity"]))
    if not cash.is_finite() or not equity.is_finite() or cash <= 0 or equity <= 0:
        raise ValueError("INVALID_RESEARCH_CAPITAL")
    paper = PaperState(deployment_id=contract["deployment_id"], multiplier=Decimal(str(parameters["atr_multiplier"])), rr=Decimal(str(parameters["rr"])), model=model, policy=contract["snapshot"]["policy"], equity=equity, cash=cash, broker=contract["snapshot"]["market"]["broker"], symbol=contract["snapshot"]["market"]["symbol"], start_time=first_time + split["warmup"] * 60000)
    metrics = StreamingMetrics(cash, split)
    identity = digest({"contract": contract, "parameters": parameters, "kind": kind})
    next_bar = 0
    counters = {"decision_count": 0, "fills": 0, "rejections": {}, "exit_fill_reasons": {}}
    if checkpoint is not None:
        if len(canonical(checkpoint)) > STATE_LIMIT or set(checkpoint) != {"version", "identity", "next_bar", "last_time", "evaluator", "paper", "metrics", "counters", "integrity"}:
            raise ValueError("INVALID_RESEARCH_CHECKPOINT")
        payload = {k: v for k, v in checkpoint.items() if k != "integrity"}
        if checkpoint["version"] != STATE_VERSION or checkpoint["identity"] != identity or checkpoint["integrity"] != digest(payload):
            raise ValueError("RESEARCH_CHECKPOINT_IDENTITY_OR_INTEGRITY_MISMATCH")
        next_bar = checkpoint["next_bar"]
        if type(next_bar) is not int or not 0 < next_bar < end or checkpoint["last_time"] != first_time + (next_bar - 1) * 60000:
            raise ValueError("INVALID_RESEARCH_CHECKPOINT_CURSOR")
        import_evaluator(evaluator, checkpoint["evaluator"], next_bar)
        paper.import_state(checkpoint["paper"])
        if paper.replay.last_time != checkpoint["last_time"]:
            raise ValueError("INVALID_RESEARCH_CHECKPOINT_CURSOR")
        metrics.import_state(checkpoint["metrics"], next_bar)
        counters = json.loads(json.dumps(checkpoint["counters"]))
        if set(counters) != {"decision_count", "fills", "rejections", "exit_fill_reasons"} or any(type(counters[k]) is not int or counters[k] < 0 for k in ("decision_count", "fills")) or counters["fills"] > counters["decision_count"]:
            raise ValueError("INVALID_RESEARCH_COUNTERS")
        for name in ("rejections", "exit_fill_reasons"):
            if not isinstance(counters[name], dict) or any(not isinstance(k, str) or type(v) is not int or v < 0 for k, v in counters[name].items()):
                raise ValueError("INVALID_RESEARCH_COUNTERS")
        if counters["decision_count"] != counters["fills"] + sum(counters["rejections"].values()) or sum(counters["exit_fill_reasons"].values()) > counters["fills"] or not set(counters["exit_fill_reasons"]) <= {"SL", "TP", "NATIVE"}:
            raise ValueError("INVALID_RESEARCH_COUNTERS")
        if counters["decision_count"] > next_bar * 1001:
            raise ValueError("INVALID_RESEARCH_COUNTERS")
    if not isinstance(rows, list) or not rows or next_bar + len(rows) > end:
        raise ValueError("INVALID_RESEARCH_CHUNK_RANGE")
    for row in rows:
        required = {"time", "open", "high", "low", "close", "volume", "atr14"}
        if not required <= set(row) or not set(row) <= required | {"price_tick", "quantity_step"} or type(row["time"]) is not int or row["time"] != first_time + next_bar * 60000:
            raise ValueError("GAPPED_OR_REORDERED_RESEARCH_CHUNK")
        bar = BridgeBar(row["time"], *(Decimal(str(row[k])) for k in ("open", "high", "low", "close", "volume")), Decimal(str(row["atr14"])))
        signal = evaluator.step(*(float(row[k]) for k in ("open", "high", "low", "close")))
        replay = paper.step(bar, signal.buy, signal.native_exit)
        metrics.step(next_bar, bar, replay["fills"])
        counters["decision_count"] += len(replay["decisions"])
        counters["fills"] += len(replay["fills"])
        counters["rejections"] = dict(Counter(counters["rejections"]) + Counter(d["reason"] for d in replay["decisions"] if d["outcome"] == "REJECTED"))
        counters["exit_fill_reasons"] = dict(Counter(counters["exit_fill_reasons"]) + Counter(f["reason"] for f in replay["fills"] if f["event_type"] == "EXIT"))
        if trace is not None:
            trace.append({"signal": asdict(signal), **replay})
        next_bar += 1
    state = {"version": STATE_VERSION, "identity": identity, "next_bar": next_bar, "last_time": paper.replay.last_time, "evaluator": export_evaluator(evaluator), "paper": paper.export_state(), "metrics": metrics.export_state(), "counters": counters}
    state["integrity"] = digest(state)
    if len(canonical(state)) > STATE_LIMIT:
        raise ValueError("RESEARCH_STATE_TOO_LARGE")
    result = None
    if next_bar == end:
        result = {"parameters": parameters, "kind": kind, "train": metrics.result("train"), "validation": metrics.result("validation"), **counters, "owner_recommendation_ready": False}
        if kind == "HOLDOUT":
            result["test"] = metrics.result("test")
    return {"checkpoint": state, "result": result}


def main():
    sent_result = False
    try:
        protocol = os.environ.get("QUANT_IO_TERMINAL_PROTOCOL")
        if protocol is not None:
            if protocol != "quant-io-terminal-v1" or not all(os.environ.get(name) for name in
                    ("QUANT_IO_READY_FILE", "QUANT_IO_READY_DEVICE", "QUANT_IO_READY_RBPS", "QUANT_IO_READY_WBPS")):
                raise ValueError("QUANT_IO_READINESS_CONFIGURATION_REQUIRED")
        prepare_io_telemetry()
        raw = sys.stdin.buffer.readline(IPC_LIMIT + 2) if protocol else sys.stdin.buffer.read(IPC_LIMIT + 1)
        if len(raw) > IPC_LIMIT + (1 if protocol else 0):
            raise ValueError("RESEARCH_REQUEST_TOO_LARGE")
        if protocol and (not raw.endswith(b"\n") or len(raw) == 1):
            raise ValueError("INVALID_RESEARCH_CHUNK_REQUEST")
        result = evaluate_chunk(json.loads(raw))
        encoded = canonical(result)
        if len(encoded) > IPC_LIMIT:
            raise ValueError("RESEARCH_RESPONSE_TOO_LARGE")
        sys.stdout.buffer.write(encoded + b"\n")
        if protocol:
            sys.stdout.buffer.flush()
            sent_result = True
            if sys.stdin.buffer.readline(64) != b"QUANT_IO_TERMINAL_ACK_V1\n" or sys.stdin.buffer.read(1) != b"":
                raise ValueError("QUANT_IO_TERMINAL_ACK_REQUIRED")
    except (ValueError, TypeError, KeyError, AttributeError, InvalidOperation, OverflowError, RecursionError):
        if not sent_result:
            print('{"error":"RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}')
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
