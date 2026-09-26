"""Private QL-2A baseline audit CLI. Never registers readiness or optimizes.

Inputs are owner/operator-held snapshots and TradingView chart exports. Raw
source/data/reports must stay outside Git. The source-specific candidate has a
fixed, fail-closed effective profile; output evidence describes its exact limits.
"""

import argparse
import csv
import hashlib
import io
import json
import subprocess
from collections import Counter
from dataclasses import asdict
from decimal import Decimal
from pathlib import Path

from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.spt_checkpoint import STATE_FIELDS, restore_checkpoint
from robot_quant.spt_evaluator import PROFILE, SptEvaluator, verify_profile
from robot_quant.spt_repaint import repaint_comparison


def market_alignment(rows: list[dict], market: dict, warmup: int) -> dict:
    if (
        market.get("symbol") != "BINANCE:BTCUSDT"
        or market.get("venue") != "BINANCE_SPOT"
        or market.get("interval_ms") != 60000
    ):
        raise ValueError("INDEPENDENT_MARKET_IDENTITY_MISMATCH")
    independent = {}
    for row in market["bars"]:
        if row["time"] in independent or row["time"] > market["retrieved_at"]:
            raise ValueError("INVALID_INDEPENDENT_BAR_TIMESTAMP")
        BridgeBar(
            row["time"],
            *(Decimal(row[k]) for k in ["open", "high", "low", "close", "volume"]),
            None,
        )
        independent[row["time"]] = row
    missing = mismatched = frozen_mismatched = 0
    for row in rows:
        bar = independent.get(row["time"])
        if bar is None:
            missing += 1
        elif any(
            Decimal(row[k]) != Decimal(bar[k]) for k in ["open", "high", "low", "close", "volume"]
        ):
            mismatched += 1
    for row in market.get("frozen", []):
        bar = row["bar"]
        encoded = json.dumps(
            bar, sort_keys=True, separators=(",", ":"), ensure_ascii=False
        ).encode()
        if hashlib.sha256(encoded).hexdigest() != row["content_hash"]:
            raise ValueError("FROZEN_MARKET_HASH_MISMATCH")
        oracle = independent.get(bar["time"])
        if oracle is None or any(
            Decimal(bar[k]) != Decimal(oracle[k])
            for k in ["open", "high", "low", "close", "volume"]
        ):
            frozen_mismatched += 1
    return {
        "compared_bars": len(rows),
        "measured_bars": len(rows[warmup:]),
        "unmatched": missing,
        "ohlcv_mismatched": mismatched,
        "frozen_rows_compared": len(market.get("frozen", [])),
        "frozen_ohlcv_mismatched": frozen_mismatched,
        "matched": missing == mismatched == frozen_mismatched == 0,
        "market_retrieved_at": market["retrieved_at"],
        "source": market.get("source"),
        "limitation": "Historical REST retrieval validates final OHLCV, not their availability at an earlier point-in-time.",
    }


def reference(request: dict) -> dict:
    root = Path(__file__).resolve().parents[3]
    completed = subprocess.run(
        ["node", str(root / "scripts/quant-bridge-reference.mjs")],
        input=json.dumps(request),
        text=True,
        capture_output=True,
        check=True,
        cwd=root,
        timeout=60,
    )
    return json.loads(completed.stdout)


def chart_export(
    path: Path, *, buy_column: int, exit_column: int, state_trace: bool = False
) -> tuple[list[dict], str]:
    raw = path.read_bytes()
    table = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    if not table or table[0][:5] != ["time", "open", "high", "low", "close"]:
        raise ValueError("INVALID_CHART_EXPORT")
    header = table[0]
    if state_trace:
        if any(header.count(name) != 1 for name in STATE_FIELDS.values()):
            raise ValueError("UNAMBIGUOUS_STATE_TRACE_REQUIRED")
        anchor = header.index(STATE_FIELDS["fast"])
        buy_column, exit_column = anchor - 2, anchor - 1
        if header[buy_column:anchor] != ["Robot Native BUY flag", "Robot Native EXIT flag"]:
            raise ValueError("STATE_TRACE_NATIVE_COLUMNS_REQUIRED")
    elif header[buy_column] != "BUY Signal" or header[exit_column] != "Long EXIT Candidate":
        raise ValueError("UNEXPECTED_SIGNAL_COLUMNS")
    if header.count("Volume") != 1:
        raise ValueError("UNAMBIGUOUS_VOLUME_REQUIRED")
    volume_column = header.index("Volume")
    rows = []
    for cells in table[1:-1]:  # recorded export's final realtime bar excluded
        if (
            len(cells) != len(header)
            or cells[buy_column] not in ["0", "1"]
            or cells[exit_column] not in ["0", "1"]
        ):
            raise ValueError("MISSING_OR_INVALID_NATIVE_OBSERVATION")
        time = int(cells[0]) * 1000 + 60000
        if rows and time - rows[-1]["time"] != 60000:
            raise ValueError("CLOSED_BAR_GAP")
        row = {
            "time": time,
            "historical_exported_at": path.stat().st_mtime_ns // 1000000,
            "open": cells[1],
            "high": cells[2],
            "low": cells[3],
            "close": cells[4],
            "volume": cells[volume_column],
            "buy": cells[buy_column] == "1",
            "native_exit": cells[exit_column] == "1",
            "reference_ema_fast": cells[5],
            "reference_ema_slow": cells[6],
            "reference_supertrend": cells[7],
        }
        if state_trace:
            row["source_state"] = {
                key: float(cells[header.index(title)])
                if cells[header.index(title)] not in ["", "NaN", "na"]
                else None
                for key, title in STATE_FIELDS.items()
            }
            if row["source_state"]["shadow_mismatch"] != 0:
                raise ValueError("SHADOW_SUPERTREND_MISMATCH")
        # Independently check the basic candle invariants before evaluation.
        BridgeBar(
            time, *(Decimal(row[k]) for k in ["open", "high", "low", "close", "volume"]), None
        )
        rows.append(row)
    if not rows:
        raise ValueError("EMPTY_CLOSED_BAR_DATASET")
    return rows, hashlib.sha256(raw).hexdigest()


def compare_replays(python: dict, node: dict, model: PaperModel) -> dict:
    differences = {
        "event_count": abs(len(python["events"]) - len(node["events"])),
        "event_identity_or_reason": 0,
        "level_ticks": 0,
        "decision_count": abs(len(python["decisions"]) - len(node["decisions"])),
        "accept_reject": 0,
        "quantity_steps": 0,
        "price_ticks": 0,
        "fee": 0,
        "allocation_targets": 0,
        "sizing_outcome_or_reason": 0,
        "sizing_quantities": 0,
        "remaining_quantity": int(
            Decimal(python["position_quantity"]) != Decimal(node["position_quantity"])
        ),
        "open_allocation_count": abs(python["open_allocations"] - node["open_allocations"]),
    }
    for left, right in zip(python["events"], node["events"], strict=False):
        if any(
            left[k] != right[k] for k in ["event_type", "time", "entry_ref", "sequence", "reason"]
        ):
            differences["event_identity_or_reason"] += 1
        if left["event_type"] == "BUY":
            for field in ["sl", "tp"]:
                differences["level_ticks"] += int(Decimal(left[field]) != Decimal(right[field]))
    per_entry_cash_max = Decimal(0)
    for left, right in zip(python["decisions"], node["decisions"], strict=False):
        if left["outcome"] != right["outcome"] or left["reason"] != right["reason"]:
            differences["accept_reject"] += 1
        if left["entry_ref"] != right["entry_ref"]:
            differences["allocation_targets"] += 1
        if Decimal(left["quantity"]) != Decimal(right["quantity"]):
            differences["quantity_steps"] += 1
        if Decimal(left["fee"]) != Decimal(right["fee"]):
            differences["fee"] += 1
        if left["outcome"] == right["outcome"] == "FILLED":
            la, ra = left["sizing_adjustment"], right["sizing_adjustment"]
            if (
                left["sizing_outcome"] != right["sizing_outcome"]
                or bool(la) != bool(ra)
                or (la and ra and la["reason"] != ra["reason"])
            ):
                differences["sizing_outcome_or_reason"] += 1
            if la and ra:
                differences["sizing_quantities"] += sum(
                    Decimal(la[k]) != Decimal(ra[k]) for k in ["requestedQuantity", "quantity"]
                )
            differences["price_ticks"] += int(Decimal(left["price"]) != Decimal(right["price"]))
            per_entry_cash_max = max(
                per_entry_cash_max, abs(Decimal(left["cash"]) - Decimal(right["cash"]))
            )
    final_cash_delta = abs(Decimal(python["final_cash"]) - Decimal(node["final_cash"]))
    final_cost_delta = abs(Decimal(python["position_cost"]) - Decimal(node["position_cost"]))
    return {
        "differences": differences,
        "per_entry_cash_max_delta": str(per_entry_cash_max),
        "final_cash_delta": str(final_cash_delta),
        "final_position_cost_delta": str(final_cost_delta),
        "matched": not any(differences.values())
        and per_entry_cash_max <= Decimal("0.01")
        and final_cash_delta <= Decimal("0.01")
        and final_cost_delta <= Decimal("0.01"),
        "compared_decisions": len(python["decisions"]),
        "quantity_step": str(model.quantity_step),
        "price_tick": str(model.price_tick),
    }


def audit(
    bundle: dict,
    rows: list[dict],
    csv_hash: str,
    warmup: int,
    market: dict | None = None,
    checkpoint: dict | None = None,
    capture: dict | None = None,
    repaint_rows: list[dict] | None = None,
) -> dict:
    deployment = bundle["deployment"]
    snapshot = deployment["snapshot"]
    verify_profile(bundle["revision"]["source"].encode(), snapshot)
    if reference({"operation": "hash", "value": snapshot})["hash"] != deployment["snapshot_hash"]:
        raise ValueError("SNAPSHOT_HASH_MISMATCH")
    if hashlib.sha256(bundle["artifact"].encode()).hexdigest() != snapshot["artifact_hash"]:
        raise ValueError("ARTIFACT_HASH_MISMATCH")
    if warmup < max(500, 5 * 200):
        raise ValueError("INSUFFICIENT_PROFILE_WARMUP")
    evaluator = restore_checkpoint(rows, checkpoint["index"]) if checkpoint else SptEvaluator()
    if checkpoint:
        warmup += checkpoint["index"] + 1
    evaluated = []
    flag_changes, first_changes = 0, []
    state_changes, state_error = 0, 0.0
    for i, row in enumerate(rows):
        if checkpoint and i <= checkpoint["index"]:
            continue
        signal = evaluator.step(*(float(row[k]) for k in ["open", "high", "low", "close"]))
        if checkpoint:
            observed = row["source_state"]
            state_error = max(
                state_error,
                *(
                    abs(getattr(evaluator, key) - observed[key])
                    for key in ["fast", "slow", "atr", "st", "upper", "lower"]
                ),
            )
            if (
                evaluator.direction != observed["direction"]
                or evaluator.long_active != bool(observed["long_active"])
                or evaluator.exit_active != bool(observed["exit_active"])
                or (
                    evaluator.long_active
                    and evaluator.long_expiry - i != observed["long_remaining"]
                )
                or (
                    evaluator.exit_active
                    and evaluator.exit_expiry - i != observed["exit_remaining"]
                )
                or (i - evaluator.trade_start if evaluator.trade_start is not None else None)
                != observed["cooldown_elapsed"]
            ):
                state_changes += 1
        bar = BridgeBar(
            row["time"],
            *(Decimal(row[k]) for k in ["open", "high", "low", "close", "volume"]),
            Decimal(str(signal.atr)) if signal.atr is not None else None,
        )
        evaluated.append((bar, signal.buy, signal.native_exit))
        if i >= warmup and (signal.buy != row["buy"] or signal.native_exit != row["native_exit"]):
            flag_changes += 1
            if len(first_changes) < 10:
                first_changes.append(
                    {
                        "time": row["time"],
                        "expected": [row["buy"], row["native_exit"]],
                        "actual": [signal.buy, signal.native_exit],
                    }
                )
    compared = rows[warmup:]
    model = PaperModel()
    capital = next(c for c in snapshot["capital"] if c["broker"] == snapshot["market"]["broker"])
    common = {
        "deployment_id": deployment["deployment_id"],
        "multiplier": Decimal(str(snapshot["selection"]["bridge"]["atr_multiplier"])),
        "rr": Decimal(str(snapshot["selection"]["bridge"]["rr"])),
        "model": model,
        "policy": snapshot["policy"],
        "equity": Decimal(capital["configuredEquity"]),
        "cash": Decimal(capital["configuredBalance"]),
        "broker": snapshot["market"]["broker"],
        "symbol": snapshot["market"]["symbol"],
        "start_time": rows[warmup]["time"] if len(rows) > warmup else rows[-1]["time"] + 60000,
    }
    python = paper_replay(evaluated, **common)
    node_request = {
        "operation": "replay",
        **{k: str(v) if isinstance(v, Decimal) else v for k, v in common.items() if k != "model"},
        "model": {k: str(v) if isinstance(v, Decimal) else v for k, v in asdict(model).items()},
        "bars": [
            {
                "time": b.time,
                **{k: str(getattr(b, k)) for k in ["open", "high", "low", "close", "volume"]},
                "atr14": str(b.atr14) if b.atr14 is not None else None,
                "buy": buy,
                "native_exit": exit_,
            }
            for b, buy, exit_ in evaluated
        ],
    }
    if checkpoint:
        # Give Node the independent Pine observations/ATR, not Python's outputs.
        observed_by_time = {r["time"]: r for r in rows}
        for b in node_request["bars"]:
            observed = observed_by_time[b["time"]]
            b.update(
                buy=observed["buy"],
                native_exit=observed["native_exit"],
                atr14=str(observed["source_state"]["atr"]),
            )
    node = reference(node_request)
    replay_comparison = compare_replays(python, node, model)
    buy_count, exit_count = sum(r["buy"] for r in compared), sum(r["native_exit"] for r in compared)
    blockers = []
    if len(compared) < 2000 or buy_count < 30 or exit_count < 30 or buy_count + exit_count < 100:
        blockers.append("INSUFFICIENT_NATIVE_SAMPLE")
    if flag_changes:
        blockers.append("NATIVE_SIGNAL_PARITY_FAILED")
    if checkpoint and (state_changes or state_error > 1e-7):
        blockers.append("SOURCE_STATE_REPLAY_FAILED")
    if not replay_comparison["matched"]:
        blockers.append("NODE_PAPER_PARITY_FAILED")
    # Historical exports alone cannot supply independent OHLCV or point-in-time
    # observations. These prerequisites stay explicit rather than becoming true
    # because a local calculation or a source hash matched.
    alignment = market_alignment(rows, market, warmup) if market else None
    if alignment is None:
        blockers.append("INDEPENDENT_OHLCV_ALIGNMENT_REQUIRED")
    elif not alignment["matched"]:
        blockers.append("INDEPENDENT_OHLCV_ALIGNMENT_FAILED")
    if not checkpoint:
        blockers.append("SOURCE_INITIALIZATION_PROVENANCE_REQUIRED")
    repaint = (
        repaint_comparison(
            repaint_rows if repaint_rows is not None else rows, capture, bundle, checkpoint
        )
        if capture and checkpoint
        else None
    )
    if repaint is None or not repaint["matched"]:
        blockers.append("SNAPSHOT_BOUND_REPAINT_EVIDENCE_REQUIRED")
    return {
        "phase": "QL-2A",
        "status": "BASELINE_CANDIDATE",
        "optimization_supported": False,
        "candidate_acceptance_ready": not blockers,
        "profile": PROFILE,
        "effective_dependency_coverage": {
            "scope": "Reviewed hash-bound fixed Daily/Swing Spot profile only; not a generic Pine construct analyzer",
            "active_dependency_coverage_percent": 100,
            "unsupported_active_constructs": 0,
            "selected_dynamic_slots": 0,
            "fixed_source_inputs": 58,
            "bridge_slots": 2,
            "active_dependencies": [
                "EMA50/200",
                "ATR14",
                "Supertrend3.2",
                "zone1.15ATR",
                "setup48bars",
                "cooldown8bars",
                "confirmationAny/lookback5",
                "ZoneATR stop buffer0.60/minRisk0.50",
                "Spot Long+Exit",
            ],
            "disabled_signal_filters": ["HTF", "RSI", "session", "BOS", "sweep"],
            "limitation": "Unsupported source/settings/bindings fail closed. Changed dimensions need evaluator/search-domain evidence before QL-3A optimization.",
        },
        "source_hash": snapshot["source_hash"],
        "artifact_hash": snapshot["artifact_hash"],
        "snapshot_hash": deployment["snapshot_hash"],
        "csv_sha256": csv_hash,
        "closed_bars": len(rows),
        "excluded_final_realtime_rows": 1,
        "warmup": warmup,
        "compared_bars": len(compared),
        "native_buy": buy_count,
        "native_exit": exit_count,
        "native_changed_bars": flag_changes,
        "first_native_mismatches": first_changes,
        "node_paper_comparison": replay_comparison,
        "market_alignment": alignment,
        "repaint_comparison": repaint,
        "paper_model": {
            k: str(v) if isinstance(v, Decimal) else v for k, v in asdict(model).items()
        },
        "paper_summary": {
            "prefix_intents": len(python["events"]) - len(python["decisions"]),
            "measured_decisions": len(python["decisions"]),
            "fills": len(python["fills"]),
            "rejected": len(python["decisions"]) - len(python["fills"]),
            "final_cash": python["final_cash"],
            "open_allocations": python["open_allocations"],
        },
        "initialization": {
            "method": "reviewed_Pine_state_checkpoint; replay continuously without warmup reset; begin empty Bot ledger at measurement boundary"
            if checkpoint
            else "cold_start_at_first_available_closed_bar; replay Pine prefix continuously without warmup reset; begin empty Bot ledger at measurement boundary",
            "largest_effective_lookback": 200,
            "first_bar": rows[0]["time"],
            "measurement_first_bar": compared[0]["time"] if compared else None,
            "original_chart_prefix_known": False,
            "checkpoint": checkpoint,
            "source_state_changed_bars": state_changes if checkpoint else None,
            "maximum_numeric_state_error": state_error if checkpoint else None,
            "numeric_state_roundoff_budget": 1e-7 if checkpoint else None,
        },
        "blockers": blockers,
        "limitations": [
            "Hash-specific candidate only; arbitrary Pine, enabled HTF/RSI/pivots/session and changed source selections are unsupported.",
            "Serial fully-filled Paper projection uses production Node risk and Bridge functions as an oracle; this does not exercise PostgreSQL transactions or authentication.",
            "Warmup keeps source/Bridge state but creates no Paper fills. Unaccepted prefix entries can yield TARGET_NOT_OPEN exits.",
            "Fees/slippage are explicit; quiet-market entries may be rejected when adverse BUY price exceeds TP.",
        ],
        "private_python_replay": python,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--csv", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--warmup", type=int, default=1000)
    parser.add_argument(
        "--market", type=Path, help="Independent Spot OHLCV plus read-only frozen-bar export"
    )
    parser.add_argument("--buy-column", type=int, default=14)
    parser.add_argument("--exit-column", type=int, default=15)
    parser.add_argument("--trace-artifact", type=Path)
    parser.add_argument("--trace-manifest", type=Path)
    parser.add_argument("--chart-review", type=Path)
    parser.add_argument("--native-capture", type=Path)
    parser.add_argument(
        "--repaint-csv",
        type=Path,
        help="Later chart export for repaint; preserves the frozen baseline dataset",
    )
    args = parser.parse_args()
    trace_paths = [args.trace_artifact, args.trace_manifest, args.chart_review]
    if any(trace_paths) and not all(trace_paths):
        parser.error("State replay requires trace artifact, manifest and chart review together")
    if args.native_capture and not all(trace_paths):
        parser.error("Native capture requires reviewed state trace provenance")
    if args.repaint_csv and not args.native_capture:
        parser.error("Later repaint history requires native capture")
    bundle = json.loads(args.bundle.read_text(encoding="utf8"))
    rows, digest = chart_export(
        args.csv,
        buy_column=args.buy_column,
        exit_column=args.exit_column,
        state_trace=all(trace_paths),
    )
    checkpoint = None
    if all(trace_paths):
        if len(rows) < 7:
            raise ValueError("INSUFFICIENT_CHECKPOINT_ROWS")
        manifest = json.loads(args.trace_manifest.read_text(encoding="utf8"))
        review = json.loads(args.chart_review.read_text(encoding="utf8"))
        deployment = bundle["deployment"]
        artifact = args.trace_artifact.read_bytes()
        if (
            manifest.get("schema_version") != "ql2a-state-trace-v1"
            or manifest.get("source_hash") != deployment["snapshot"]["source_hash"]
            or manifest.get("snapshot_hash") != deployment["snapshot_hash"]
            or manifest.get("execution_artifact_hash") != deployment["snapshot"]["artifact_hash"]
            or hashlib.sha256(artifact).hexdigest() != manifest.get("trace_artifact_hash")
            or not artifact.startswith(bundle["revision"]["source"].encode())
            or review.get("trace_artifact_hash") != manifest["trace_artifact_hash"]
            or review.get("snapshot_hash") != manifest["snapshot_hash"]
            or review.get("compilation_errors") != 0
            or review.get("chart") != "BINANCE:BTCUSDT"
            or review.get("timeframe") != "1"
            or review.get("chart_type") != "standard_candles"
            or review.get("fixed_inputs") != deployment["snapshot"]["selection"]["fixed_inputs"]
        ):
            raise ValueError("TRACE_ARTIFACT_OR_CHART_REVIEW_MISMATCH")
        checkpoint = {
            "index": 5,
            "bar_time": rows[5]["time"],
            "trace_artifact_hash": manifest["trace_artifact_hash"],
            "chart_review_sha256": hashlib.sha256(args.chart_review.read_bytes()).hexdigest(),
        }
    market = json.loads(args.market.read_text(encoding="utf8")) if args.market else None
    repaint_rows, repaint_digest = (
        chart_export(
            args.repaint_csv,
            buy_column=args.buy_column,
            exit_column=args.exit_column,
            state_trace=True,
        )
        if args.repaint_csv
        else (None, None)
    )
    report = audit(
        bundle,
        rows,
        digest,
        args.warmup,
        market,
        checkpoint,
        json.loads(args.native_capture.read_text(encoding="utf8")) if args.native_capture else None,
        repaint_rows,
    )
    report["input_provenance"] = {
        "private_bundle_sha256": hashlib.sha256(args.bundle.read_bytes()).hexdigest(),
        "independent_market_sha256": hashlib.sha256(args.market.read_bytes()).hexdigest()
        if args.market
        else None,
        "chart_export_source_binding_verified": checkpoint is not None,
        "native_capture_sha256": hashlib.sha256(args.native_capture.read_bytes()).hexdigest()
        if args.native_capture
        else None,
        "later_repaint_csv_sha256": repaint_digest,
        "note": "Dedicated trace hash plus operator chart input/compile review; CSV state/native columns select that trace unambiguously."
        if checkpoint
        else "CSV signal columns agree numerically, but the export alone does not certify the script hash or effective chart inputs. Bind a dedicated trace artifact and reviewed chart inputs before acceptance.",
    }
    report["paper_summary"]["rejection_reasons"] = dict(
        Counter(
            d["reason"]
            for d in report["private_python_replay"]["decisions"]
            if d["outcome"] == "REJECTED"
        )
    )
    report["paper_summary"]["filled_sizing_outcomes"] = dict(
        Counter(d["sizing_outcome"] for d in report["private_python_replay"]["fills"])
    )
    root = Path(__file__).resolve().parents[3]
    report["implementation_sha256"] = {
        str(p.relative_to(root)).replace("\\", "/"): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in [
            Path(__file__),
            Path(__file__).with_name("spt_evaluator.py"),
            Path(__file__).with_name("spt_checkpoint.py"),
            Path(__file__).with_name("spt_repaint.py"),
            Path(__file__).with_name("bridge_replay.py"),
            Path(__file__).with_name("bridge_paper.py"),
            Path(__file__).with_name("risk_evaluator.py"),
            root / "scripts/quant-bridge-reference.mjs",
            root / "src/postgres/risk.js",
            root / "src/postgres/ledger.js",
            root / "src/postgres/pine-bridge-execution.js",
            root / "src/pine-bridge/contract.js",
            root / "src/pine-bridge/source.js",
            root / "src/money.js",
            root / "quant_lab/uv.lock",
            root / "package-lock.json",
        ]
    }
    args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf8")
    print(json.dumps({k: v for k, v in report.items() if k != "private_python_replay"}, indent=2))


if __name__ == "__main__":
    main()
