"""HOLDOUT trace driver for the F09 trace reproduction (builder slice S3a).

Runs the unchanged QL-3A ``research_engine.evaluate`` once with kind HOLDOUT and
captures its single Paper replay, so the trace rows come from the same path that
produced the train, validation and test metrics. The driver never mirrors the
engine body: a wrapper replaces ``research_engine.paper_replay`` for one call and
restores it in ``finally``. It reads no stored result, compares nothing with a
stored digest and writes nothing; the Node module judges and renders.

Interface (docs/design/f09-trace-repro/JUDGEMENT.md, section 6.1):
  stdin  one JSON object ``{"contract": ..., "parameters": ...}`` (8 MiB cap)
  stdout one JSON object ``{"result", "trades", "decisions", "equity"}``, or on
         failure exit 1 and ``{"error": CODE}`` only (no message, path or traceback)
"""

import json
import math
import sys
import threading
from contextlib import contextmanager
from decimal import Decimal, localcontext

from robot_quant import research_engine
from robot_quant.analytics import PRECISION_CONTEXT, amount

REQUEST_LIMIT = 8 * 1024 * 1024
KIND = "HOLDOUT"
PARTITIONS = ("train", "validation", "test")
REQUEST_KEYS = frozenset({"contract", "parameters"})
CODE_DIVERGED = "TRACE_REPRODUCTION_DIVERGED"
CODE_TOO_LARGE = "RESEARCH_REQUEST_TOO_LARGE"
CODE_FAILED = "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"
ERROR_CODES = frozenset({CODE_DIVERGED, CODE_TOO_LARGE, CODE_FAILED})
# The capture swaps a module attribute, so one capture runs at a time per process.
CAPTURE_LOCK = threading.Lock()


class TraceRefusal(Exception):
    """One coded refusal. The code is the only thing that leaves the process."""

    def __init__(self, code: str):
        super().__init__(code)
        self.code = code


def diverged() -> TraceRefusal:
    return TraceRefusal(CODE_DIVERGED)


@contextmanager
def capture_paper_replay():
    """Replace ``research_engine.paper_replay`` for one evaluation and always restore it."""
    original = research_engine.paper_replay
    replays: list[dict] = []

    def capturing(*args, **kwargs):
        replay = original(*args, **kwargs)
        replays.append(replay)
        return replay

    research_engine.paper_replay = capturing
    try:
        yield replays
    finally:
        research_engine.paper_replay = original


def partition_edges(contract: dict) -> tuple[int, int, int]:
    """First bar time of warm-up end, train end and validation end (the engine checked the split)."""
    split, rows = contract["split"], contract["dataset"]["bars"]
    return tuple(rows[split[name]]["time"] for name in ("warmup", "train_end", "validation_end"))


def partition_of(time: int, edges: tuple[int, int, int]) -> str:
    """Label a bar time. Nothing can exist before the warm-up end (``start_time`` in paper_replay)."""
    if time < edges[0]:
        raise diverged()
    if time < edges[1]:
        return "train"
    if time < edges[2]:
        return "validation"
    return "test"


def build_trace(fills: list[dict], decisions: list[dict], edges: tuple[int, int, int]) -> dict:
    """Trade, decision and equity rows from one replay. Decimals stay strings computed here."""
    trades: list[dict] = []
    equity: list[dict] = []
    entries: dict[str, dict] = {}
    position = Decimal(0)
    for fill in fills:
        partition = partition_of(fill["time"], edges)
        quantity = Decimal(fill["quantity"])
        entry = None
        if fill["event_type"] == "EXIT":
            entry = entries.pop(fill["entry_ref"], None)
            if entry is None:
                raise diverged()
            entry_quantity = Decimal(entry["quantity"])
            if quantity != entry_quantity:  # a partial or oversize exit has no single-trade row
                raise diverged()
            entry_cost = Decimal(entry["notional"]) + Decimal(entry["fee"])
            # Same expression and ambient precision as ql3a.mark_period, so net equals its trade net.
            net = Decimal(fill["notional"]) - Decimal(fill["fee"]) - entry_cost * quantity / entry_quantity
            trades.append({
                "entry_ref": fill["entry_ref"], "partition": partition,
                "entry_time": entry["time"], "entry_price": entry["price"],
                "quantity": entry["quantity"], "entry_fee": entry["fee"],
                "exit_time": fill["time"], "exit_price": fill["price"],
                "exit_fee": fill["fee"], "exit_reason": fill["reason"],
                "net": format(net, "f"), "realized_r": fill["realized_r"],
            })
        else:
            entries[fill["entry_ref"]] = fill
        with localcontext() as ctx:
            ctx.prec = PRECISION_CONTEXT
            position += quantity if entry is None else -quantity
            held = amount(position)
            marked = amount(Decimal(fill["cash"]) + position * Decimal(fill["price"]))
        equity.append({
            "time": fill["time"], "partition": partition, "event_type": fill["event_type"],
            "cash": fill["cash"], "position_quantity": held, "equity_at_fill": marked,
        })
    # An entry still open at the end has no trade row (it is left in ``entries``).
    return {
        "trades": trades,
        "decisions": [{**d, "partition": partition_of(d["time"], edges)} for d in decisions],
        "equity": equity,
        "open_entries": len(entries),
        "final_position": position,
    }


def cross_check(result: dict, replay: dict, trace: dict) -> None:
    """Exact equality, no tolerance. Any difference means the rows are not this result's path."""
    if result["decision_count"] != len(replay["decisions"]) or result["fills"] != len(replay["fills"]):
        raise diverged()
    for name in PARTITIONS:
        if sum(t["partition"] == name for t in trace["trades"]) != result[name]["closed_trades"]:
            raise diverged()
        # Same summation order and ambient precision as ql3a.mark_period (exit order).
        profit = loss = Decimal(0)
        for trade in trace["trades"]:
            if trade["partition"] != name:
                continue
            net = Decimal(trade["net"])
            if net > 0:
                profit += net
            elif net < 0:
                loss -= net
        if str(profit) != result[name]["gross_profit"] or str(loss) != result[name]["gross_loss"]:
            raise diverged()
    if trace["open_entries"] != replay["open_allocations"]:
        raise diverged()
    if trace["final_position"] != Decimal(replay["position_quantity"]):
        raise diverged()


def reproduce(request: dict) -> dict:
    """One call per process is recommended; capture is serialized by CAPTURE_LOCK."""
    if not isinstance(request, dict) or set(request) != REQUEST_KEYS:
        raise ValueError("INVALID_TRACE_REQUEST")
    contract, parameters = request["contract"], request["parameters"]
    with CAPTURE_LOCK:  # held install wrapper -> evaluate -> restore
        with capture_paper_replay() as replays:
            result = research_engine.evaluate({"contract": contract, "parameters": parameters, "kind": KIND})
    if len(replays) != 1:
        raise diverged()
    replay = replays[0]
    trace = build_trace(replay["fills"], replay["decisions"], partition_edges(contract))
    cross_check(result, replay, trace)
    return {"result": result, "trades": trace["trades"], "decisions": trace["decisions"], "equity": trace["equity"]}


def refuse_constant(_name: str):
    raise ValueError("NON_FINITE_NUMBER")


def finite_float(text: str) -> float:
    value = float(text)
    if not math.isfinite(value):
        raise ValueError("NON_FINITE_NUMBER")
    return value


def decode(raw: bytes) -> dict:
    return json.loads(raw, parse_constant=refuse_constant, parse_float=finite_float)


def main() -> None:
    # Bound IPC independently of the Node caller, as research_engine.main does.
    raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
    try:
        if len(raw) > REQUEST_LIMIT:
            raise TraceRefusal(CODE_TOO_LARGE)
        reply = json.dumps(reproduce(decode(raw)), allow_nan=False, separators=(",", ":"))
    except TraceRefusal as refusal:
        code = refusal.code
    except Exception:  # fail closed: no message, path or traceback may leave
        code = CODE_FAILED
    else:
        print(reply)
        return
    print(json.dumps({"error": code}))
    raise SystemExit(1)


if __name__ == "__main__":
    main()
