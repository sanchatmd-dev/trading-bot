"""One pure QL-3A calculation over a Node-frozen SPT Custom research contract.

Input/output use JSON on stdio. No network, DB, Pine execution or Bot mutations.
The PostgreSQL worker decides checkpoint, cancellation and holdout ordering.
"""
import json
import sys
from collections import Counter
from decimal import Decimal

from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.ql3a import mark_period
from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, evaluate_bars


def evaluate(request: dict) -> dict:
    if set(request) != {"contract", "parameters", "kind"}:
        raise ValueError("INVALID_RESEARCH_REQUEST")
    contract, parameters, kind = (request[k] for k in ("contract", "parameters", "kind"))
    if contract["version"] != "ql3a-research-job-v1" or contract["scope"] != "SPT_CUSTOM_ENGINEERING_ONLY":
        raise ValueError("UNSUPPORTED_RESEARCH_CONTRACT")
    if kind not in {"CANDIDATE", "SENSITIVITY", "STRESS", "HOLDOUT"}:
        raise ValueError("UNSUPPORTED_RESEARCH_STEP")
    snapshot = contract["snapshot"]
    plan = CustomOptimizationPlan.from_snapshot(contract["source"].encode(), snapshot)
    if set(parameters) != set(contract["input_lock"]["baseline"]):
        raise ValueError("RESEARCH_DIMENSION_MISMATCH")
    for name, value in parameters.items():
        if isinstance(value, bool) or not isinstance(value, (int, float)) or value not in contract["input_lock"]["domains"][name]:
            raise ValueError("CANDIDATE_OUTSIDE_LOCKED_GRID")
    source_inputs = plan.candidate({name: value for name, value in parameters.items() if name in plan.domains})
    split = contract["split"]
    dataset = contract["dataset"]["bars"]
    expected_length = split["test_end"] if kind == "HOLDOUT" else split["validation_end"]
    if not 0 < split["warmup"] < split["train_end"] < split["validation_end"] < split["test_end"] <= 10000 or len(dataset) != expected_length:
        raise ValueError("INVALID_RESEARCH_SPLIT")
    rows = dataset
    if any(b["time"] - a["time"] != 60000 for a, b in zip(rows, rows[1:])):
        raise ValueError("GAPPED_RESEARCH_DATASET")
    evaluated = evaluate_bars(rows, source_inputs)
    bars = [
        (BridgeBar(row["time"], *(Decimal(str(row[k])) for k in ("open", "high", "low", "close", "volume")), Decimal(str(row["atr14"]))), signal.buy, signal.native_exit)
        for row, signal in zip(rows, evaluated, strict=True)
    ]  # Independent, frozen market ATR(14) never changes with source ATR Length.
    raw_model = contract["model"]
    factor = 2 if kind == "STRESS" else 1
    model = PaperModel(
        price_tick=Decimal(str(raw_model["price_tick"])), quantity_step=Decimal(str(raw_model["quantity_step"])),
        fee_bps=Decimal(str(raw_model["fee_bps"])) * factor,
        slippage_bps=Decimal(str(raw_model["slippage_bps"])) * factor,
        risk_percent=Decimal(str(raw_model["risk_percent"])), version=raw_model["version"],
    )
    cash = Decimal(str(contract["capital"]["cash"]))
    replay = paper_replay(
        bars, deployment_id=contract["deployment_id"], multiplier=Decimal(str(parameters["atr_multiplier"])), rr=Decimal(str(parameters["rr"])),
        model=model, policy=snapshot["policy"], equity=Decimal(str(contract["capital"]["equity"])), cash=cash,
        broker=snapshot["market"]["broker"], symbol=snapshot["market"]["symbol"], start_time=rows[split["warmup"]]["time"],
    )
    result = {
        "parameters": parameters, "kind": kind,
        "train": mark_period(bars, replay["fills"], split["warmup"], split["train_end"], cash),
        "validation": mark_period(bars, replay["fills"], split["train_end"], split["validation_end"], cash),
        "decision_count": len(replay["decisions"]), "fills": len(replay["fills"]),
        "rejections": dict(Counter(d["reason"] for d in replay["decisions"] if d["outcome"] == "REJECTED")),
        "exit_fill_reasons": dict(Counter(f["reason"] for f in replay["fills"] if f["event_type"] == "EXIT")),
        "owner_recommendation_ready": False,
    }
    if kind == "HOLDOUT":
        result["test"] = mark_period(bars, replay["fills"], split["validation_end"], split["test_end"], cash)
    return result


def main() -> None:
    # Bound IPC independently of the HTTP request size.
    raw = sys.stdin.buffer.read(8 * 1024 * 1024 + 1)
    try:
        if len(raw) > 8 * 1024 * 1024:
            raise ValueError("RESEARCH_REQUEST_TOO_LARGE")
        result = evaluate(json.loads(raw))
        print(json.dumps(result, allow_nan=False, separators=(",", ":")))
    except (ValueError, TypeError, KeyError):
        print(json.dumps({"error": "RESEARCH_CONTRACT_OR_EVALUATION_FAILED"}))
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
