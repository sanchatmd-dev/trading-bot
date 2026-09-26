"""Offline, bounded QL-3A research for the accepted fixed SPT profile.

This command never registers a Quant capability, exports Best Inputs, sends mail,
or changes a Bot. The historical QL-2A audit is an explicit prerequisite.
"""

import argparse
import hashlib
import json
from collections import Counter
from decimal import Decimal
from pathlib import Path

from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.ql2a import chart_export
from robot_quant.spt_evaluator import PROFILE, verify_profile

GRID = {
    "atr_multiplier": ("1.0", "1.5", "2.0", "2.5", "3.0"),
    "rr": ("1.0", "1.5", "2.0", "2.5", "3.0"),
}
RULES = {
    "train_fraction": "0.60",
    "validation_fraction": "0.20",
    "test_fraction": "0.20",
    "minimum_closed_trades_train": 5,
    "minimum_closed_trades_validation": 5,
    "minimum_closed_trades_test": 5,
    "maximum_drawdown_percent": "20",
    "minimum_validation_return_percent": "0",
    "minimum_stressed_validation_return_percent": "0",
    "sensitivity_max_drop_percentage_points": "2",
    "stress_fee_multiplier": "2",
    "stress_slippage_multiplier": "2",
    "objective": "validation_net_return_percent",
    "selection": "highest_validation_return_then_lower_drawdown_then_lexical_pair",
}


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def canonical(value: object) -> bytes:
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def frozen_inputs(bundle_path: Path, csv_path: Path, baseline_path: Path) -> tuple[dict, dict, list]:
    bundle = json.loads(bundle_path.read_text(encoding="utf8"))
    report = json.loads(baseline_path.read_text(encoding="utf8"))
    snapshot = bundle["deployment"]["snapshot"]
    verify_profile(bundle["revision"]["source"].encode(), snapshot)
    if (
        report["phase"] != "QL-2A"
        or not report["candidate_acceptance_ready"]
        or report["blockers"]
        or not report["node_paper_comparison"]["matched"]
        or not report["market_alignment"]["matched"]
        or not report["repaint_comparison"]["matched"]
        or report["repaint_comparison"]["compared_to_later_history"] < 100
        or report["source_hash"] != snapshot["source_hash"]
        or report["snapshot_hash"] != bundle["deployment"]["snapshot_hash"]
        or report["profile"] != PROFILE
        or report["input_provenance"]["private_bundle_sha256"] != sha(bundle_path)
        or report["csv_sha256"] != sha(csv_path)
        or report["effective_dependency_coverage"]["selected_dynamic_slots"] != 0
    ):
        raise ValueError("QL2A_BASELINE_NOT_ACCEPTED_OR_INPUTS_CHANGED")
    root = Path(__file__).resolve().parents[3]
    for relative, digest in report["implementation_sha256"].items():
        if sha(root / relative) != digest:
            raise ValueError("QL2A_IMPLEMENTATION_CHANGED:" + relative)
    rows, csv_digest = chart_export(csv_path, buy_column=14, exit_column=15, state_trace=True)
    if csv_digest != report["csv_sha256"] or len(rows) != report["closed_bars"]:
        raise ValueError("QL2A_BASELINE_DATASET_CHANGED")
    measured = rows[report["warmup"] :]
    if (
        len(measured) != report["compared_bars"]
        or sum(row["buy"] for row in measured) != report["native_buy"]
        or sum(row["native_exit"] for row in measured) != report["native_exit"]
    ):
        raise ValueError("QL2A_BASELINE_SIGNALS_CHANGED")
    return bundle, report, rows


def mark_period(bars: list, fills: list, start: int, end: int, cash: Decimal) -> dict:
    """Mark a chronological period from one continuous Bot path at every bar close."""
    fills_by_time: dict[int, list] = {}
    for fill in fills:
        fills_by_time.setdefault(fill["time"], []).append(fill)
    current_cash, quantity = cash, Decimal(0)
    start_equity = None
    peak = None
    worst = Decimal(0)
    wins = losses = Decimal(0)
    closed = 0
    entries: dict[str, tuple[Decimal, Decimal]] = {}
    for i, (bar, _, _) in enumerate(bars[:end]):
        for fill in fills_by_time.get(bar.time, []):
            current_cash = Decimal(fill["cash"])
            q = Decimal(fill["quantity"])
            if fill["event_type"] == "BUY":
                quantity += q
                entries[fill["entry_ref"]] = (q, Decimal(fill["notional"]) + Decimal(fill["fee"]))
            else:
                quantity -= q
                entry_qty, entry_cost = entries.pop(fill["entry_ref"])
                net = Decimal(fill["notional"]) - Decimal(fill["fee"]) - entry_cost * q / entry_qty
                if i >= start:
                    closed += 1
                    if net > 0:
                        wins += net
                    elif net < 0:
                        losses -= net
        equity = current_cash + quantity * bar.close
        if i == start - 1:
            start_equity = equity
        if i >= start:
            if start_equity is None:
                start_equity = cash
            peak = max(peak if peak is not None else start_equity, equity)
            worst = max(worst, (peak - equity) / peak * 100)
    if start_equity is None or start_equity <= 0:
        raise ValueError("INVALID_SPLIT_START_EQUITY")
    return {
        "bars": end - start,
        "closed_trades": closed,
        "start_equity": str(start_equity),
        "end_equity": str(equity),
        "net_return_percent": str((equity / start_equity - 1) * 100),
        "max_drawdown_percent": str(worst),
        "profit_factor": str(wins / losses) if losses > 0 else None,
        "gross_profit": str(wins),
        "gross_loss": str(losses),
    }


def run_replay(bars: list, common: dict, atr: str, rr: str, model: PaperModel) -> dict:
    return paper_replay(
        bars,
        **common,
        multiplier=Decimal(atr),
        rr=Decimal(rr),
        model=model,
    )


def activity(replay: dict, first_time: int, last_time: int) -> dict:
    decisions = [d for d in replay["decisions"] if first_time <= d["time"] <= last_time]
    return {
        "decisions": len(decisions),
        "fills": sum(d["outcome"] == "FILLED" for d in decisions),
        "rejections": dict(Counter(
            d["reason"] for d in decisions if d["outcome"] == "REJECTED"
        )),
    }


def research(bundle: dict, baseline: dict, rows: list, input_hashes: dict) -> dict:
    snapshot = bundle["deployment"]["snapshot"]
    capital = next(c for c in snapshot["capital"] if c["broker"] == snapshot["market"]["broker"])
    cash = Decimal(capital["configuredBalance"])
    model = PaperModel()
    bars = [
        (
            BridgeBar(
                row["time"],
                *(Decimal(row[k]) for k in ["open", "high", "low", "close", "volume"]),
                Decimal(str(row["source_state"]["atr"]))
                if row["source_state"]["atr"] is not None
                else None,
            ),
            row["buy"],
            row["native_exit"],
        )
        for row in rows
    ]
    warmup = baseline["warmup"]
    count = len(bars) - warmup
    train_end = warmup + count * 60 // 100
    val_end = warmup + count * 80 // 100
    if min(train_end - warmup, val_end - train_end, len(bars) - val_end) < 100:
        raise ValueError("INSUFFICIENT_CHRONOLOGICAL_PARTITIONS")
    common = {
        "deployment_id": bundle["deployment"]["deployment_id"],
        "policy": snapshot["policy"],
        "equity": Decimal(capital["configuredEquity"]),
        "cash": cash,
        "broker": snapshot["market"]["broker"],
        "symbol": snapshot["market"]["symbol"],
        "start_time": bars[warmup][0].time,
    }
    default = snapshot["selection"]["bridge"]
    default_pair = (str(default["atr_multiplier"]), str(default["rr"]))
    if default_pair != ("2", "1.5") and default_pair != ("2.0", "1.5"):
        raise ValueError("UNSUPPORTED_BASELINE_BRIDGE_VALUES")
    candidates = []
    by_pair = {}
    baseline_activity = None
    model_meta = baseline["paper_model"]
    if any(
        Decimal(str(getattr(model, key))) != Decimal(str(model_meta[key]))
        for key in ["price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent"]
    ) or model.version != model_meta["version"]:
        raise ValueError("PAPER_MODEL_CHANGED")
    for atr in GRID["atr_multiplier"]:
        for rr in GRID["rr"]:
            replay = run_replay(bars[:val_end], common, atr, rr, model)
            train = mark_period(bars[:val_end], replay["fills"], warmup, train_end, cash)
            validation = mark_period(bars[:val_end], replay["fills"], train_end, val_end, cash)
            candidate = {"atr_multiplier": atr, "rr": rr, "train": train, "validation": validation}
            candidates.append(candidate)
            by_pair[(atr, rr)] = candidate
            if (atr, rr) == ("2.0", "1.5"):
                baseline_activity = {
                    "train": activity(replay, bars[warmup][0].time, bars[train_end - 1][0].time),
                    "validation": activity(
                        replay, bars[train_end][0].time, bars[val_end - 1][0].time
                    ),
                }
    baseline_candidate = by_pair[("2.0", "1.5")]
    baseline_val_return = Decimal(baseline_candidate["validation"]["net_return_percent"])
    eligible = []
    for candidate in candidates:
        train, val = candidate["train"], candidate["validation"]
        reasons = []
        if train["closed_trades"] < RULES["minimum_closed_trades_train"]:
            reasons.append("INSUFFICIENT_TRAIN_TRADES")
        if val["closed_trades"] < RULES["minimum_closed_trades_validation"]:
            reasons.append("INSUFFICIENT_VALIDATION_TRADES")
        if Decimal(val["net_return_percent"]) < max(Decimal(0), baseline_val_return):
            reasons.append("VALIDATION_BELOW_BASELINE_OR_ZERO")
        if Decimal(val["max_drawdown_percent"]) > Decimal(RULES["maximum_drawdown_percent"]):
            reasons.append("VALIDATION_DRAWDOWN_EXCEEDED")
        candidate["screen_reasons"] = reasons
        if not reasons:
            eligible.append(candidate)
    eligible.sort(
        key=lambda c: (
            -Decimal(c["validation"]["net_return_percent"]),
            Decimal(c["validation"]["max_drawdown_percent"]),
            c["atr_multiplier"],
            c["rr"],
        )
    )
    selected = None
    for candidate in eligible:
        atr, rr = candidate["atr_multiplier"], candidate["rr"]
        ai, ri = GRID["atr_multiplier"].index(atr), GRID["rr"].index(rr)
        neighbors = [
            by_pair[(GRID["atr_multiplier"][j], rr)]
            for j in [ai - 1, ai + 1]
            if 0 <= j < len(GRID["atr_multiplier"])
        ] + [
            by_pair[(atr, GRID["rr"][j])]
            for j in [ri - 1, ri + 1]
            if 0 <= j < len(GRID["rr"])
        ]
        minimum_neighbor = min(Decimal(n["validation"]["net_return_percent"]) for n in neighbors)
        candidate["sensitivity"] = {
            "neighbor_count": len(neighbors),
            "minimum_neighbor_validation_return_percent": str(minimum_neighbor),
            "max_drop_percentage_points": RULES["sensitivity_max_drop_percentage_points"],
        }
        if minimum_neighbor < Decimal(candidate["validation"]["net_return_percent"]) - Decimal(RULES["sensitivity_max_drop_percentage_points"]):
            candidate["screen_reasons"].append("SENSITIVITY_ISOLATED_SPIKE")
            continue
        stressed = PaperModel(fee_bps=Decimal("20"), slippage_bps=Decimal("2"))
        stress_replay = run_replay(bars[:val_end], common, atr, rr, stressed)
        candidate["cost_stress_validation"] = mark_period(
            bars[:val_end], stress_replay["fills"], train_end, val_end, cash
        )
        if Decimal(candidate["cost_stress_validation"]["net_return_percent"]) < 0:
            candidate["screen_reasons"].append("COST_STRESS_NEGATIVE")
            continue
        selected = candidate
        break
    # Holdout is evaluated exactly once, only after train/validation selection.
    if selected is not None:
        replay = run_replay(bars, common, selected["atr_multiplier"], selected["rr"], model)
        selected["test"] = mark_period(bars, replay["fills"], val_end, len(bars), cash)
        test = selected["test"]
        if test["closed_trades"] < RULES["minimum_closed_trades_test"]:
            selected["screen_reasons"].append("INSUFFICIENT_TEST_TRADES")
        if Decimal(test["net_return_percent"]) < 0:
            selected["screen_reasons"].append("NEGATIVE_HOLDOUT_RETURN")
        if Decimal(test["max_drawdown_percent"]) > Decimal(RULES["maximum_drawdown_percent"]):
            selected["screen_reasons"].append("TEST_DRAWDOWN_EXCEEDED")
    result = {
        "phase": "QL-3A",
        "status": "RESEARCH_CANDIDATE" if selected and not selected["screen_reasons"] else "NO_VALID_CANDIDATE",
        "owner_recommendation_ready": False,
        "runtime_quant_supported": False,
        "profile": PROFILE,
        "scope": "one Pine, zero selected source inputs, independent Bridge ATR/RR only",
        "input_hashes": input_hashes,
        "snapshot_hash": baseline["snapshot_hash"],
        "source_hash": baseline["source_hash"],
        "paper_model": baseline["paper_model"],
        "rules": RULES,
        "domains": {key: list(values) for key, values in GRID.items()},
        "search_algorithm": "exhaustive_lexical_grid",
        "seed": 0,
        "search_budget": 25,
        "candidate_count": len(candidates),
        "dimension_coverage_percent": 100,
        "split": {
            "warmup_bars": warmup,
            "train": [bars[warmup][0].time, bars[train_end - 1][0].time],
            "validation": [bars[train_end][0].time, bars[val_end - 1][0].time],
            "test": [bars[val_end][0].time, bars[-1][0].time],
            "train_bars": train_end - warmup,
            "validation_bars": val_end - train_end,
            "test_bars": len(bars) - val_end,
            "holdout_evaluations": int(selected is not None),
        },
        "source_activity": {
            "train": {
                "native_buy": sum(buy for _, buy, _ in bars[warmup:train_end]),
                "native_exit": sum(exit_ for _, _, exit_ in bars[warmup:train_end]),
            },
            "validation": {
                "native_buy": sum(buy for _, buy, _ in bars[train_end:val_end]),
                "native_exit": sum(exit_ for _, _, exit_ in bars[train_end:val_end]),
            },
        },
        "baseline_pair": {"atr_multiplier": "2.0", "rr": "1.5"},
        "baseline_train": baseline_candidate["train"],
        "baseline_validation": baseline_candidate["validation"],
        "baseline_activity": baseline_activity,
        "candidate_closed_trade_ranges": {
            "train": [min(c["train"]["closed_trades"] for c in candidates), max(c["train"]["closed_trades"] for c in candidates)],
            "validation": [min(c["validation"]["closed_trades"] for c in candidates), max(c["validation"]["closed_trades"] for c in candidates)],
        },
        "candidate_rejection_counts": dict(Counter(reason for c in candidates for reason in c["screen_reasons"])),
        "selected": {key: value for key, value in selected.items() if key != "screen_reasons"}
        if selected and not selected["screen_reasons"]
        else None,
        "completion_reason": "SEARCH_COMPLETE" if selected and not selected["screen_reasons"] else "INSUFFICIENT_OR_FAILED_VALIDATION_EVIDENCE",
        "limitations": [
            "The baseline dataset is a short fixed market window; no future return is guaranteed.",
            "Candidate Bridge settings have not been compiled as new Pine or activated on a Bot.",
            "Offline serial Paper simulation does not replace runtime PostgreSQL and owner authorization gates.",
            "No source-input dimensions or multiple-Pine membership are supported by this run.",
        ],
        "candidates": candidates,
    }
    result["offline_run_id"] = hashlib.sha256(canonical({
        "phase": result["phase"],
        "inputs": input_hashes,
        "rules": RULES,
        "domains": result["domains"],
        "implementation": sha(Path(__file__)),
    })).hexdigest()
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    private_root = Path(__file__).resolve().parents[3] / ".qa-local"
    if not args.output.resolve().is_relative_to(private_root.resolve()):
        parser.error("Private research output must stay under .qa-local")
    if args.output.resolve() in {args.bundle.resolve(), args.csv.resolve(), args.baseline.resolve()}:
        parser.error("Output cannot replace a frozen input")
    bundle, baseline, rows = frozen_inputs(args.bundle, args.csv, args.baseline)
    hashes = {"bundle": sha(args.bundle), "baseline": sha(args.baseline), "chart_csv": sha(args.csv)}
    result = research(bundle, baseline, rows, hashes)
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    print(json.dumps({key: value for key, value in result.items() if key != "candidates"}, indent=2))


if __name__ == "__main__":
    main()
