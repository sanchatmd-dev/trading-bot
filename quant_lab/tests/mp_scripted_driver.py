"""Test-only driver: run the combined evaluator once and print its ledger as canonical JSON.

The Node tests (oracle comparison) spawn this file; it is not part of the product job and is not
in any engine closure. One JSON object on stdin, one JSON line on stdout, exit status 0.
A failure prints ``{"error":"<UPPER_CASE_CODE>"}`` and exits with status 1.

A signal vector is ``{"buy": [...], "native_exit": [...]}``, one strict boolean per bar and member
(the list of ``[buy, exit]`` pairs is accepted on input). Mode 1, a scripted case (the object shape of ``test/fixtures/mp-combined/scripted-cases-v1.json``
cases; keys such as ``id`` or ``expected`` are ignored)::

    {"bars": [...], "members": [{"ordinal", "deployment_id", "signals": {"buy": [bool, ...], "native_exit": [bool, ...]}}],
     "pair": {"atr_multiplier", "rr"}, "model": {...}, "policy": {...}, "capital": {"equity", "cash"},
     "broker", "symbol", "start_time": null | int, "same_bar_order"}

Mode 2, a fixture run over the committed 6,000 bars with the real SPT Custom evaluator::

    {"fixture_run": {"members": [{"name": "M1", "deployment_id": "fixture-m1-1"}, ...],
                     "pair": {"atr_multiplier": "2", "rr": "1.5"}, "factor": 1}}

``name`` is a member of the fixture manifest (M1, M2, M2_ZERO; M3 is M1). ``factor`` 2 is the STRESS
model (fee and slippage doubled). The output of mode 2 also carries the exact oracle input under
``input``, with the model already scaled.

Output: ``{"ledger": {...}, "diagnostics": {...}, "ledger_sha256": "...", "input": {...}}``; the
``input`` key is present in mode 2 only.
"""

import hashlib
import json
import sys
from decimal import Decimal
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "src"))

from robot_quant.bridge_replay import BridgeBar, PaperModel  # noqa: E402
from robot_quant.mp_combined_paper import (  # noqa: E402
    BridgePair,
    MemberSignals,
    combined_paper_replay,
)
from robot_quant.ql3a import canonical  # noqa: E402
from robot_quant.spt_custom_evaluator import CustomSignalInputs, evaluate_bars  # noqa: E402

FIXTURES = HERE.parents[2] / "test" / "fixtures" / "mp-combined"
SCRIPTED_KEYS = ("bars", "members", "pair", "model", "policy", "capital", "broker", "symbol", "start_time", "same_bar_order")


def _pairs(signals):
    """{buy: [...], native_exit: [...]} (the output shape) or a list of (buy, exit) pairs."""
    if isinstance(signals, dict):
        return tuple(zip(signals["buy"], signals["native_exit"], strict=True))
    return tuple(tuple(s) for s in signals)


def _bars(rows):
    return [
        BridgeBar(r["time"], *(Decimal(r[k]) for k in ("open", "high", "low", "close", "volume")), Decimal(r["atr14"]))
        for r in rows
    ]


def _model(raw):
    return PaperModel(
        price_tick=Decimal(raw["price_tick"]), quantity_step=Decimal(raw["quantity_step"]),
        fee_bps=Decimal(raw["fee_bps"]), slippage_bps=Decimal(raw["slippage_bps"]),
        risk_percent=Decimal(raw["risk_percent"]), version=raw["version"],
    )


def run(spec: dict) -> dict:
    result = combined_paper_replay(
        [
            MemberSignals(m["ordinal"], m["deployment_id"], _pairs(m["signals"])) for m in spec["members"]
        ],
        _bars(spec["bars"]),
        BridgePair(Decimal(spec["pair"]["atr_multiplier"]), Decimal(spec["pair"]["rr"])),
        model=_model(spec["model"]), policy=spec["policy"],
        equity=Decimal(spec["capital"]["equity"]), cash=Decimal(spec["capital"]["cash"]),
        broker=spec["broker"], symbol=spec["symbol"], start_time=spec["start_time"],
        same_bar_order=spec["same_bar_order"],
    )
    result["ledger_sha256"] = hashlib.sha256(canonical(result["ledger"])).hexdigest()
    return result


def fixture_spec(request: dict) -> dict:
    manifest = json.loads((FIXTURES / "manifest.json").read_text())
    rows = json.loads((FIXTURES / "bars-v1.json").read_text())["bars"]
    members = []
    for index, member in enumerate(request["members"]):
        name = "M1" if member["name"] == "M3" else member["name"]
        inputs = CustomSignalInputs.from_source_values(manifest["members"][name]["inputs"])
        evaluated = evaluate_bars(rows, inputs)
        signals = {"buy": [e.buy for e in evaluated], "native_exit": [e.native_exit for e in evaluated]}
        members.append({"ordinal": index + 1, "deployment_id": member["deployment_id"], "signals": signals})
    factor = request.get("factor", 1)
    model = {
        **manifest["model"], "fee_bps": str(Decimal(manifest["model"]["fee_bps"]) * factor),
        "slippage_bps": str(Decimal(manifest["model"]["slippage_bps"]) * factor),
    }
    return {
        "bars": rows, "members": members, "pair": request["pair"], "model": model,
        "policy": manifest["policy"], "capital": manifest["capital"],
        "broker": manifest["market"]["broker"], "symbol": manifest["market"]["symbol"],
        "start_time": rows[manifest["split"]["warmup"]]["time"], "same_bar_order": manifest["same_bar_order"],
    }


def main() -> None:
    try:
        request = json.loads(sys.stdin.read())
        if "fixture_run" in request:
            spec = fixture_spec(request["fixture_run"])
            result = run(spec)
            result["input"] = {k: spec[k] for k in SCRIPTED_KEYS}
        else:
            result = run(request)
        sys.stdout.write(json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False) + "\n")
    except ValueError as error:
        code = str(error.args[0]) if error.args and str(error.args[0]).isupper() else "EVALUATION_FAILED"
        sys.stdout.write(json.dumps({"error": code}) + "\n")
        raise SystemExit(1) from None
    except Exception:
        sys.stdout.write('{"error":"EVALUATION_FAILED"}\n')
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
