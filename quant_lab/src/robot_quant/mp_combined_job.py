"""One supervised step of the combined multi-Pine evaluator (F11, RD-MP-28).

``python -m robot_quant.mp_combined_job`` reads ONE ``mp-combined-request-v1`` object from stdin
until EOF, runs ONE step and writes ONE ``mp-combined-step-v1`` object (canonical JSON and a line
feed) to stdout. Candidate, sensitivity and stress steps carry rows ``0..validation_end``; a
HOLDOUT step carries rows ``0..test_end`` and runs alone, so holdout rows never reach a selection
process. Node binds every hash: the job echoes ``run`` and checks nothing against a database.

Per member the job receives the source text and the member's deployment snapshot. A member
snapshot's ``membership`` lists every connected member, but ``validate_custom_snapshot`` picks the
row by source hash only and Option A members share one source hash. So the job first replaces
``snapshot.membership`` by the member's own row (matched by ``pine_import_id`` and
``source_version``) and then runs the unchanged source gate. A non-empty ``selection.bindings`` is
``MP_SOURCE_SLOTS_FORBIDDEN``: a multi member has no search slot.

Failure: ``{"error": "<UPPER_CASE_CODE>"}`` and exit status 1. No message, path or traceback leaves
the process. A refused market bar (``INVALID_MARKET_BAR``, ``INVALID_ATR``, ``INVALID_OHLC``) and a refused
execution model are ``MP_INPUT_INVALID``. ``policy`` is closed to exactly the sixteen ``node_policy`` keys.

Funnel windows, which differ on purpose (the oracle comparison maps to both):

* ``diagnostics.members[]`` and ``diagnostics.bot`` count over ALL rows given to the step, warm-up
  rows included: rows ``0..validation_end`` in a candidate, sensitivity or stress step and rows
  ``0..test_end`` in a holdout step (test rows only in HOLDOUT).
* ``member_signals[]`` counts native signals over ``warmup..validation_end`` only (segments
  ``train`` and ``validation``, plus ``test`` in HOLDOUT). Its ``native_buy`` and ``native_exit``
  are always train plus validation, in every step kind, and ``signals_hash`` covers rows
  ``0..validation_end``.

The funnel key names are those listed in the ``mp_combined_paper`` module docstring.
"""

import hashlib
import json
import re
import sys
from collections import Counter
from decimal import Decimal, InvalidOperation

from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.mp_combined_paper import (
    POLICY_KEYS,
    BridgePair,
    MemberSignals,
    combined_paper_replay,
)
from robot_quant.ql3a import canonical, mark_period
from robot_quant.spt_custom_evaluator import evaluate_bars, validate_custom_snapshot

REQUEST_VERSION = "mp-combined-request-v1"
RESPONSE_VERSION = "mp-combined-step-v1"
EVALUATOR = "mp-combined-paper-v1"
CLOSURE = "mp-combined-closure-v1"
REQUEST_LIMIT = 8 * 1024 * 1024
RESPONSE_LIMIT = 2 * 1024 * 1024
MAX_ROWS = 10000
STEP_KINDS = ("CANDIDATE", "SENSITIVITY", "STRESS", "HOLDOUT")

INPUT_INVALID = "MP_INPUT_INVALID"
SOURCE_SLOTS_FORBIDDEN = "MP_SOURCE_SLOTS_FORBIDDEN"
DUPLICATE_LOGIC = "MP_MEMBER_DUPLICATE_LOGIC"
OUTPUT_TOO_LARGE = "EVALUATION_OUTPUT_TOO_LARGE"
FAILED = "EVALUATION_FAILED"

_REQUEST_KEYS = {
    "version", "evaluator", "closure", "run", "market", "model", "policy", "capital", "split",
    "first_time", "same_bar_order", "members", "rows", "step",
}
_RUN_KEYS = {"run_id", "contract_hash", "engine_hash", "set_hash"}
_MARKET = {"broker": "binance-global", "symbol": "BTCUSDT", "timeframe": "1"}
_MODEL_KEYS = {"version", "price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent"}
_CAPITAL_KEYS = {"equity", "cash"}
_SPLIT_KEYS = ("warmup", "train_end", "validation_end", "test_end")
_MEMBER_KEYS = {
    "ordinal", "deployment_id", "pine_import_id", "source_version", "source_hash",
    "effective_inputs_hash", "source", "snapshot",
}
_ROW_KEYS = {"time", "open", "high", "low", "close", "volume", "atr14"}
_STEP_KEYS = {"kind", "pair"}
_PAIR_KEYS = {"atr_multiplier", "rr"}
_HEX64 = re.compile(r"[0-9a-f]{64}")
_DECIMAL = re.compile(r"[0-9]{1,30}(\.[0-9]{1,30})?")
_CODE = re.compile(r"[A-Z][A-Z0-9_]{1,63}")

# Codes of the unchanged one-Pine source gate that may leave the process (suffix after ':' is dropped).
_GATE_CODES = frozenset({
    "UNSUPPORTED_SOURCE_HASH", "UNSUPPORTED_CUSTOM_MARKET", "UNSUPPORTED_CUSTOM_SLOT_COUNT",
    "DUPLICATE_CUSTOM_INPUT_IDENTITY", "MISSING_SOURCE_MEMBERSHIP",
    "CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED", "SOURCE_INPUT_IDENTITY_MISMATCH",
    "CUSTOM_EFFECTIVE_INPUT_CHANGED", "UNSUPPORTED_CUSTOM_BINDING", "INVALID_CUSTOM_SLOT_DOMAIN",
    "DUPLICATE_CUSTOM_BINDING", "UNSUPPORTED_CUSTOM_SETTING", "UNSUPPORTED_SIGNAL_MAPPING",
    "INVALID_CUSTOM_SEARCH_DOMAIN",
})
_LIBRARY_CODES = frozenset({
    INPUT_INVALID, SOURCE_SLOTS_FORBIDDEN, DUPLICATE_LOGIC, OUTPUT_TOO_LARGE,
    "MP_EVENT_ORDER_UNDEFINED", "MP_CROSS_SOURCE_TARGET",
})
# Refusals of the bar and model constructors (Bridge bar, SPT bar check, Paper model): the request
# numbers are wrong, not the process.
_INPUT_CODES = frozenset({
    "INVALID_EXECUTION_MODEL", "UNSUPPORTED_EXECUTION_MODEL",
    "INVALID_MARKET_BAR", "INVALID_ATR", "INVALID_OHLC",
})


def _invalid() -> ValueError:
    return ValueError(INPUT_INVALID)


def _exact(value, keys, *, allow_extra=False):
    if not isinstance(value, dict) or (not allow_extra and set(value) != set(keys)):
        raise _invalid()
    if allow_extra and not set(keys) <= set(value):
        raise _invalid()
    return value


def _int(value, low=0, high=2**53 - 1):
    if type(value) is not int or not low <= value <= high:
        raise _invalid()
    return value


def _text(value):
    if type(value) is not str or not value or len(value) > 200:
        raise _invalid()
    return value


def _decimal(value, *, positive=False):
    if type(value) is not str or _DECIMAL.fullmatch(value) is None:
        raise _invalid()
    result = Decimal(value)
    if positive and result <= 0:
        raise _invalid()
    return result


def project_membership(snapshot: dict, member: dict) -> dict:
    """Return ``snapshot`` with ``membership`` reduced to the member's own row (RD-MP-28).

    The row is matched by ``pine_import_id`` and ``source_version``; zero or two matching rows is
    ``MP_INPUT_INVALID``. The row's source hash and effective-input hash must equal the member's.
    The input snapshot is not modified.
    """
    rows = snapshot.get("membership") if isinstance(snapshot, dict) else None
    if not isinstance(rows, list):
        raise _invalid()
    own = [
        row for row in rows
        if isinstance(row, dict)
        and row.get("pine_import_id") == member["pine_import_id"]
        and row.get("source_version") == member["source_version"]
    ]
    if len(own) != 1:
        raise _invalid()
    analysis = own[0].get("analysis")
    if (
        own[0].get("source_hash") != member["source_hash"]
        or not isinstance(analysis, dict)
        or analysis.get("effective_inputs_hash") != member["effective_inputs_hash"]
    ):
        raise _invalid()
    return {**snapshot, "membership": [own[0]]}


def check_no_slots(member: dict) -> None:
    """A multi member has no search slot: any ``selection.bindings`` row is ``MP_SOURCE_SLOTS_FORBIDDEN``."""
    try:
        bindings = member["snapshot"]["selection"]["bindings"]
    except (KeyError, TypeError):
        raise _invalid() from None
    if not isinstance(bindings, list):
        raise _invalid()
    if bindings:
        raise ValueError(SOURCE_SLOTS_FORBIDDEN)


def member_inputs(member: dict):
    """The member's frozen SPT inputs through the unchanged source gate (after the projection)."""
    check_no_slots(member)
    snapshot = member["snapshot"]
    projected = project_membership(snapshot, member)
    try:
        inputs, selected = validate_custom_snapshot(member["source"].encode(), projected)
    except (KeyError, TypeError, AttributeError):
        raise _invalid() from None
    if selected:
        raise ValueError(SOURCE_SLOTS_FORBIDDEN)
    return inputs


def _check_request(request: object) -> dict:
    request = _exact(request, _REQUEST_KEYS)
    if request["version"] != REQUEST_VERSION or request["evaluator"] != EVALUATOR or request["closure"] != CLOSURE:
        raise _invalid()
    run = _exact(request["run"], _RUN_KEYS)
    for key in ("run_id", "contract_hash", "engine_hash", "set_hash"):
        _text(run[key])
    if request["market"] != _MARKET:
        raise _invalid()
    model = _exact(request["model"], _MODEL_KEYS)
    _text(model["version"])
    for key in ("price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent"):
        _decimal(model[key])
    _exact(request["policy"], POLICY_KEYS)
    capital = _exact(request["capital"], _CAPITAL_KEYS)
    for key in _CAPITAL_KEYS:
        _decimal(capital[key], positive=True)
    split = _exact(request["split"], _SPLIT_KEYS)
    values = [_int(split[key], 1, MAX_ROWS) for key in _SPLIT_KEYS]
    if values != sorted(set(values)):
        raise _invalid()
    _int(request["first_time"], 1)
    if request["first_time"] % 60000 != 0:
        raise _invalid()
    members = request["members"]
    if not isinstance(members, list) or not 2 <= len(members) <= 3:
        raise _invalid()
    for index, member in enumerate(members):
        _exact(member, _MEMBER_KEYS)
        if _int(member["ordinal"], 1, 3) != index + 1:
            raise _invalid()
        for key in ("deployment_id", "pine_import_id"):
            _text(member[key])
        _int(member["source_version"], 1)
        for key in ("source_hash", "effective_inputs_hash"):
            if type(member[key]) is not str or _HEX64.fullmatch(member[key]) is None:
                raise _invalid()
        if type(member["source"]) is not str or not isinstance(member["snapshot"], dict):
            raise _invalid()
    if len({m["deployment_id"] for m in members}) != len(members):
        raise _invalid()
    if len({m["pine_import_id"] for m in members}) != len(members):
        raise _invalid()
    if [m["pine_import_id"] for m in members] != sorted(m["pine_import_id"] for m in members):
        raise _invalid()
    for i, a in enumerate(members):
        for b in members[i + 1:]:
            if a["source_hash"] == b["source_hash"] and a["effective_inputs_hash"] == b["effective_inputs_hash"]:
                raise ValueError(DUPLICATE_LOGIC)
    step = _exact(request["step"], _STEP_KEYS)
    if step["kind"] not in STEP_KINDS:
        raise _invalid()
    pair = _exact(step["pair"], _PAIR_KEYS)
    for key in _PAIR_KEYS:
        _decimal(pair[key], positive=True)
    holdout = step["kind"] == "HOLDOUT"
    expected = split["test_end"] if holdout else split["validation_end"]
    rows = request["rows"]
    if not isinstance(rows, list) or len(rows) != expected:
        raise _invalid()
    if split["warmup"] >= split["train_end"]:
        raise _invalid()
    for index, row in enumerate(rows):
        _exact(row, _ROW_KEYS)
        if row["time"] != request["first_time"] + index * 60000 or type(row["time"]) is not int:
            raise _invalid()
        for key in ("open", "high", "low", "close", "volume", "atr14"):
            _decimal(row[key])
    return request


def _model(raw: dict, kind: str) -> PaperModel:
    factor = 2 if kind == "STRESS" else 1
    try:
        return PaperModel(
            price_tick=Decimal(raw["price_tick"]), quantity_step=Decimal(raw["quantity_step"]),
            fee_bps=Decimal(raw["fee_bps"]) * factor, slippage_bps=Decimal(raw["slippage_bps"]) * factor,
            risk_percent=Decimal(raw["risk_percent"]), version=raw["version"],
        )
    except (ValueError, InvalidOperation):
        raise _invalid() from None


def _hash(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()


def evaluate_request(request: object) -> dict:
    """Validate the frame and run one step. Pure: no file, clock, network or database."""
    request = _check_request(request)
    split, rows, step = request["split"], request["rows"], request["step"]
    kind = step["kind"]
    members = request["members"]
    # Source gate first: its refusals are about the member, not about the numbers.
    for member in members:
        check_no_slots(member)
    inputs = [member_inputs(member) for member in members]
    floor = max(max(1006, 5 * i.ema_slow) for i in inputs)
    if split["warmup"] < floor:
        raise _invalid()
    evaluated = [evaluate_bars(rows, i) for i in inputs]
    signals = [tuple((e.buy, e.native_exit) for e in series) for series in evaluated]
    bars = [
        BridgeBar(
            row["time"], *(Decimal(row[k]) for k in ("open", "high", "low", "close", "volume")),
            Decimal(row["atr14"]),
        )
        for row in rows
    ]  # Bridge ATR is the frozen market atr14, never the source ATR (as research_engine does).
    model = _model(request["model"], kind)
    cash = Decimal(request["capital"]["cash"])
    replay = combined_paper_replay(
        [MemberSignals(m["ordinal"], m["deployment_id"], s) for m, s in zip(members, signals, strict=True)],
        bars,
        BridgePair(Decimal(step["pair"]["atr_multiplier"]), Decimal(step["pair"]["rr"])),
        model=model, policy=request["policy"], equity=Decimal(request["capital"]["equity"]), cash=cash,
        broker=request["market"]["broker"], symbol=request["market"]["symbol"],
        start_time=rows[split["warmup"]]["time"], same_bar_order=request["same_bar_order"],
    )
    ledger, diagnostics = replay["ledger"], replay["diagnostics"]
    marked = [(bar, False, False) for bar in bars]
    result = {
        "version": RESPONSE_VERSION, "evaluator": EVALUATOR, "closure": CLOSURE, "run": request["run"],
        "kind": kind, "pair": dict(step["pair"]), "same_bar_order": request["same_bar_order"],
        "train": mark_period(marked, ledger["fills"], split["warmup"], split["train_end"], cash),
        "validation": mark_period(marked, ledger["fills"], split["train_end"], split["validation_end"], cash),
        "decision_count": len(ledger["decisions"]), "fills": len(ledger["fills"]),
        "rejections": dict(Counter(d["reason"] for d in ledger["decisions"] if d["outcome"] == "REJECTED")),
        "exit_fill_reasons": dict(Counter(f["reason"] for f in ledger["fills"] if f["event_type"] == "EXIT")),
        "diagnostics": diagnostics,
        "member_signals": [
            _member_signals(m, s, split, kind == "HOLDOUT") for m, s in zip(members, signals, strict=True)
        ],
        "ledger_hash": _hash(ledger),
        "owner_recommendation_ready": False,
    }
    if kind == "HOLDOUT":
        result["test"] = mark_period(marked, ledger["fills"], split["validation_end"], split["test_end"], cash)
        result["ledger"] = {"events": ledger["events"], "decisions": ledger["decisions"]}
    return result


def _member_signals(member: dict, signals: tuple, split: dict, holdout: bool) -> dict:
    def counts(low, high):
        window = signals[low:high]
        return {"buy": sum(s[0] for s in window), "exit": sum(s[1] for s in window)}

    segments = {
        "train": counts(split["warmup"], split["train_end"]),
        "validation": counts(split["train_end"], split["validation_end"]),
    }
    if holdout:
        segments["test"] = counts(split["validation_end"], split["test_end"])
    row = {
        "ordinal": member["ordinal"], "deployment_id": member["deployment_id"],
        # Rows 0..validation_end only, so the hash is the same in every step of one run (F24).
        "signals_hash": _hash([list(s) for s in signals[: split["validation_end"]]]),
        "native_buy": segments["train"]["buy"] + segments["validation"]["buy"],
        "native_exit": segments["train"]["exit"] + segments["validation"]["exit"],
        "segments": segments,
    }
    if holdout:
        row["signals"] = {"buy": [s[0] for s in signals], "native_exit": [s[1] for s in signals]}
    return row


def _error_code(error: BaseException) -> str:
    if isinstance(error, (KeyError, TypeError, AttributeError, InvalidOperation, RecursionError)):
        return INPUT_INVALID
    if isinstance(error, ValueError):
        code = str(error.args[0]).split(":", 1)[0] if error.args else ""
        if _CODE.fullmatch(code):
            if code in _LIBRARY_CODES or code in _GATE_CODES:
                return code
            if code in _INPUT_CODES:
                return INPUT_INVALID
    return FAILED


def _frame(result: dict) -> bytes:
    try:
        encoded = json.dumps(result, sort_keys=True, separators=(",", ":"), allow_nan=False).encode() + b"\n"
    except (TypeError, ValueError):
        raise ValueError(FAILED) from None
    if len(encoded) > RESPONSE_LIMIT:
        raise ValueError(OUTPUT_TOO_LARGE)
    return encoded


def _refuse_constant(_name):
    raise ValueError(INPUT_INVALID)


def main() -> None:
    try:
        raw = sys.stdin.buffer.read(REQUEST_LIMIT + 1)
        if len(raw) > REQUEST_LIMIT:
            raise _invalid()
        try:
            request = json.loads(raw, parse_constant=_refuse_constant)
        except (ValueError, RecursionError):
            raise _invalid() from None
        sys.stdout.buffer.write(_frame(evaluate_request(request)))
        sys.stdout.buffer.flush()
    except BaseException as error:  # only a code may leave, never a message or traceback
        sys.stdout.buffer.write(b'{"error":"' + _error_code(error).encode() + b'"}\n')
        sys.stdout.buffer.flush()
        raise SystemExit(1) from None


if __name__ == "__main__":
    main()
