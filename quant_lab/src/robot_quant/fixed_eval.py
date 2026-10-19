"""Pure fixed-input evaluator: one frozen window, zero search (QR-4 5.4, RO-8).

Runs the existing Bridge/Paper engine once on already selected inputs and reports
what the QR-3 valuation (5.1) and the QR-3 sample gate (6.3) need: mark-to-close
metrics, full fills, modeled slippage, exposure, flat-to-flat episodes beside
closed allocations, and rejected intents. It adds no engine code. It reuses
``evaluate_bars``, ``paper_replay`` and ``mark_period`` unchanged, reads no file,
clock, network or database, and never searches: a domain, dimension, bound, budget
or seed field anywhere in the request is refused with
``QR4_EVALUATION_SEARCH_REFUSED``. That refusal walks every nested key, including
every key of every ``rows`` item (the row keys are also validated exactly), and
``contract.policy`` must carry exactly the node policy names, no more and no fewer.

Frozen ATR: every row carries ``atr14``, the frozen market ATR(14). Bars are built
exactly as ``research_engine`` builds them (``Decimal(str(row[key]))`` for open, high,
low, close, volume and the frozen ``atr14``). The cold-started float ATR of
``bridge_bars`` is never used. A missing or null ``atr14`` is refused with
``QR4_EVALUATION_INPUT_INVALID:rows.atr14``.

Capital: ``initial_cash`` is the ledger cash and the mark-to-close start. ``initial_equity`` is
the book equity the engine sizes against (cap by equity, daily loss); it is passed as
``equity`` to ``paper_replay`` exactly as ``research_engine`` passes ``capital.equity``, and
echoed in the output. Both are decimal strings above zero.

Capacity: at most 10000 rows (``rows.capacity``) and ``warmup >= 1``.

Time convention: engine ``time`` is the closed-bar time (bar open + 60000 ms).
Every ``bar_time_ms`` in the output is the bar OPEN time (engine time - 60000),
the key the QR-3 valuation grid uses. ``side`` is BUY or SELL (engine EXIT).

Slippage: ``slippage_cost_incl_tick`` per fill is ``|fill price - bar close| x
quantity`` at 18 places half-even. It includes the tick rounding of the fill price,
so it can exceed the pure basis-point slippage.

Episode: one flat-to-flat span (position quantity above zero to zero) inside the
window. ``closed_allocations`` counts EXIT fills in the window and is reported next
to episodes; overlapping allocations make the two differ. An open position at the
window end is marked at the last close, never liquidated, and is not a completed
episode.

Rejected: ``total`` counts every REJECTED decision. ``orphan_exits`` are EXIT intents
refused with ``TARGET_NOT_OPEN`` because their entry never reached the ledger: either
the BUY was a warm-up intent (``warmup_entry``) or the BUY was itself refused
(``refused_entry``). They are artifacts of the Bridge arrays, not extra decisions.
``intents_total`` is ``total`` without them. ``by_event_type_and_reason`` lists every
rejection, orphans included, so its counts sum to ``total``.

Precision: ``metrics`` come from ``mark_period`` at 80 digits (``metrics_precision``).
They are not string-comparable with prec-28 parent metrics; compare as decimals.

Closure: this module is outside every engine hash closure (LEGACY, FOUNDATION,
INGESTION, PF2 engine, PF2 evaluator); the output says so in
``evaluator_closure: "NOT_IN_ENGINE_CLOSURE"``. ``engine_hash`` is only echoed from the
contract. A result of this module must not reach a run row until a versioned
evaluation closure exists (FE-2 requirement).

Driver: ``python fixed_eval.py`` reads one JSON request from stdin and writes one JSON
object to stdout. It exits 0 with ``{"result": ...}`` and exits 1 with ``{"error": <code>}``
(as ``research_engine`` does). The code is a short upper-case token; no message, path or
traceback leaves the process.

Mode id, lineage and hashes are not decided here: ``parent_run_id``, ``selection_id``,
``engine_hash`` and ``dataset_sha256`` are echoed from the contract unchanged. Each of these
echo keys must be a str or null; any other value (number, bool, list, dict) is refused with
``QR4_EVALUATION_INPUT_INVALID:contract.<key>``.
"""

import json
import re
import sys
from decimal import Decimal, localcontext

from robot_quant.analytics import PRECISION_CONTEXT, amount
from robot_quant.bridge_paper import paper_replay
from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.ql3a import mark_period
from robot_quant.spt_custom_evaluator import CATALOG, CustomSignalInputs, evaluate_bars

VERSION = "fixed-eval-v1"
EVALUATOR_CLOSURE = "NOT_IN_ENGINE_CLOSURE"
MINUTE_MS = 60000
MAX_ROWS = 10000
MAX_REQUEST_BYTES = 8 * 1024 * 1024
KINDS = {"EVALUATION": Decimal(1), "EVALUATION_STRESS": Decimal(2)}
SEARCH_REFUSED = "QR4_EVALUATION_SEARCH_REFUSED"
INPUT_INVALID = "QR4_EVALUATION_INPUT_INVALID"
FAILED = "QR4_EVALUATION_FAILED"

# Any key that carries a search dimension, bound, domain, budget or seed, at any depth.
_SEARCH_FRAGMENTS = (
    "domain",
    "budget",
    "seed",
    "search",
    "evaluations",
    "slot",
    "dimension",
    "bound",
)
_MODEL_KEYS = ["price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent"]
# The exact names bridge_paper.node_policy requires; nothing else is allowed in the policy.
_POLICY_KEYS = [
    "killSwitch",
    "maxSignalAgeSeconds",
    "maxTradesPerDay",
    "maxDailyLossR",
    "pauseAfterLossStreak",
    "blockHighVolatility",
    "maxVolatilityPercent",
    "blockDuringNews",
    "allowedSymbols",
    "sideMode",
    "maxOpenPositions",
    "onePositionPerSymbol",
    "capPercentEquitySize",
    "maxRiskPercent",
    "maxOrderNotional",
    "maxDailyNotional",
]
_POLICY_FLAGS = (
    "killSwitch",
    "blockHighVolatility",
    "blockDuringNews",
    "onePositionPerSymbol",
    "capPercentEquitySize",
)
_POLICY_DECIMALS = ("maxDailyLossR", "maxRiskPercent", "maxOrderNotional", "maxDailyNotional")
_CONTRACT_REQUIRED = [
    "model",
    "policy",
    "initial_cash",
    "initial_equity",
    "broker",
    "symbol",
    "deployment_id",
]
_CONTRACT_STRINGS = ("deployment_id", "broker", "symbol")
MAX_TIME_MS = 253402300799000  # 9999-12-31T23:59:59Z, the last instant datetime can hold.
_CONTRACT_ECHO = ["engine_hash", "dataset_sha256", "parent_run_id", "selection_id"]
_ROW_NUMBERS = ("open", "high", "low", "close", "volume")
_ROW_KEYS = frozenset(("time", *_ROW_NUMBERS, "atr14"))
_REQUEST_KEYS = ["contract", "parameters", "kind", "split"]
_ERROR_CODE = re.compile(r"[A-Z][A-Z0-9_]*(:[A-Za-z0-9_.,]+)?")


def _plain(value: object) -> str:
    """18 places half-even as a plain decimal string (no exponent form)."""
    return format(Decimal(amount(value)), "f")


def _invalid(detail: str) -> ValueError:
    return ValueError(f"{INPUT_INVALID}:{detail}")


def _refuse_search(value: object) -> None:
    """Walk every nested key, rows included; refuse a search field before reading anything.

    Iterative, so a deeply nested value cannot exhaust the recursion limit.
    """
    pending = [value]
    while pending:
        node = pending.pop()
        if isinstance(node, dict):
            for key, child in node.items():
                text = str(key).lower()
                if any(part in text for part in _SEARCH_FRAGMENTS):
                    raise ValueError(SEARCH_REFUSED)
                pending.append(child)
        elif isinstance(node, (list, tuple)):
            pending.extend(node)


def _decimal(value: object, name: str) -> Decimal:
    if not isinstance(value, str):
        raise _invalid(name)
    try:
        result = Decimal(value)
    except ArithmeticError:
        raise _invalid(name) from None
    if not result.is_finite():
        raise _invalid(name)
    return result


def _exact_keys(value: object, required: list[str], optional: list[str], name: str) -> dict:
    if not isinstance(value, dict):
        raise _invalid(name)
    keys = set(value)
    if not set(required) <= keys or not keys <= set(required) | set(optional):
        raise _invalid(name)
    return value


def _split(split: object, bar_count: int) -> tuple[int, int]:
    split = _exact_keys(split, ["warmup", "end"], [], "split")
    warmup, end = split["warmup"], split["end"]
    for value in (warmup, end):
        if isinstance(value, bool) or not isinstance(value, int):
            raise _invalid("split")
    if not 1 <= warmup < end <= bar_count:
        raise _invalid("split")
    return warmup, end


def _model(raw: object, factor: Decimal) -> tuple[PaperModel, dict]:
    raw = _exact_keys(raw, _MODEL_KEYS, ["version"], "model")
    values = {key: _decimal(raw[key], "model." + key) for key in _MODEL_KEYS}
    stressed = {
        **values,
        "fee_bps": values["fee_bps"] * factor,
        "slippage_bps": values["slippage_bps"] * factor,
    }
    model = PaperModel(**stressed, **({"version": raw["version"]} if "version" in raw else {}))
    echo = {key: str(stressed[key]) for key in _MODEL_KEYS}
    echo["version"] = model.version
    return model, echo


def _bridge(raw: object) -> tuple[Decimal, Decimal]:
    return _decimal(raw["atr_multiplier"], "atr_multiplier"), _decimal(raw["rr"], "rr")


def _run(
    contract: dict, bridge: tuple[Decimal, Decimal], bars: list, kind: str, split: object
) -> dict:
    if not isinstance(kind, str) or kind not in KINDS:
        raise _invalid("kind")
    factor = KINDS[kind]
    warmup, end = _split(split, len(bars))
    model, model_echo = _model(contract["model"], factor)
    cash = _decimal(contract["initial_cash"], "initial_cash")
    if cash <= 0:
        raise _invalid("initial_cash")
    equity = _decimal(contract["initial_equity"], "initial_equity")
    if equity <= 0:
        raise _invalid("initial_equity")
    window = bars[:end]  # Nothing after the window end may influence the run.
    start_time = window[warmup][0].time
    replay = paper_replay(
        window,
        deployment_id=contract["deployment_id"],
        multiplier=bridge[0],
        rr=bridge[1],
        model=model,
        policy=contract["policy"],
        equity=equity,
        cash=cash,
        broker=contract["broker"],
        symbol=contract["symbol"],
        start_time=start_time,
    )
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT  # mark_period divides; 80 digits match QR-3 exact fields.
        metrics = mark_period(window, replay["fills"], warmup, end, cash)
        return _report(
            contract, kind, factor, model_echo, bridge, window, warmup, end, replay, metrics
        )


def _rejected(replay: dict, start_time: int) -> dict:
    """Count refused intents; split out EXITs whose BUY never reached the ledger."""
    warmup_refs = {
        event["entry_ref"]
        for event in replay["events"]
        if event["event_type"] == "BUY" and event["time"] < start_time
    }
    refused = [d for d in replay["decisions"] if d["outcome"] == "REJECTED"]
    refused_refs = {d["entry_ref"] for d in refused if d["event_type"] == "BUY"}
    orphans = {"warmup_entry": 0, "refused_entry": 0}
    counts: dict[tuple[str, str], int] = {}
    for decision in refused:
        key = (decision["event_type"], decision["reason"])
        counts[key] = counts.get(key, 0) + 1
        if decision["event_type"] == "EXIT" and decision["reason"] == "TARGET_NOT_OPEN":
            if decision["entry_ref"] in warmup_refs:
                orphans["warmup_entry"] += 1
            elif decision["entry_ref"] in refused_refs:
                orphans["refused_entry"] += 1
    return {
        "total": len(refused),
        "intents_total": len(refused) - sum(orphans.values()),
        "orphan_exits": orphans,
        "by_event_type_and_reason": [
            {"event_type": event, "reason": reason, "count": count}
            for (event, reason), count in sorted(counts.items())
        ],
    }


def _report(
    contract: dict,
    kind: str,
    factor: Decimal,
    model_echo: dict,
    bridge: tuple[Decimal, Decimal],
    window: list,
    warmup: int,
    end: int,
    replay: dict,
    metrics: dict,
) -> dict:
    close_by_time = {bar.time: bar.close for bar, _, _ in window}
    fills, total_slippage, total_fee = [], Decimal(0), Decimal(0)
    fills_by_time: dict[int, list] = {}
    for fill in replay["fills"]:
        cost = Decimal(
            _plain(
                abs(Decimal(fill["price"]) - close_by_time[fill["time"]])
                * Decimal(fill["quantity"])
            )
        )
        total_slippage += cost
        total_fee += Decimal(fill["fee"])
        row = {
            **fill,
            "bar_time_ms": fill["time"] - MINUTE_MS,
            "side": "BUY" if fill["event_type"] == "BUY" else "SELL",
            "slippage_cost_incl_tick": _plain(cost),
        }
        fills.append(row)
        fills_by_time.setdefault(fill["time"], []).append(row)
    quantity, in_market = Decimal(0), 0
    episodes, open_since = [], None
    for index in range(warmup, end):
        bar = window[index][0]
        for fill in sorted(fills_by_time.get(bar.time, []), key=lambda f: f["sequence"]):
            before = quantity
            if fill["side"] == "BUY":
                quantity += Decimal(fill["quantity"])
                if before == 0:
                    open_since = {"open_bar_time_ms": fill["bar_time_ms"], "allocations": 0}
                open_since["allocations"] += 1
            else:
                quantity -= Decimal(fill["quantity"])
            if before > 0 and quantity == 0:
                episodes.append({**open_since, "close_bar_time_ms": fill["bar_time_ms"]})
                open_since = None
        in_market += quantity > 0
    bars_count = end - warmup
    last_close = window[end - 1][0].close
    return {
        "version": VERSION,
        "evaluator_closure": EVALUATOR_CLOSURE,
        "kind": kind,
        "cost_stress": {"fee_multiplier": str(factor), "slippage_multiplier": str(factor)},
        "model": model_echo,
        "bridge": {"atr_multiplier": str(bridge[0]), "rr": str(bridge[1])},
        "initial_equity": str(_decimal(contract["initial_equity"], "initial_equity")),
        "split": {"warmup": warmup, "end": end, "evaluated_bars": bars_count},
        "engine_hash": contract.get("engine_hash"),
        "dataset_sha256": contract.get("dataset_sha256"),
        "parent_run_id": contract.get("parent_run_id"),
        "selection_id": contract.get("selection_id"),
        "metrics_precision": PRECISION_CONTEXT,
        "metrics": metrics,
        "fills": fills,
        "fees_total": _plain(total_fee),
        "slippage_cost_incl_tick_total": _plain(total_slippage),
        "exposure": {
            "bars_in_market": in_market,
            "bars": bars_count,
            "fraction": _plain(Decimal(in_market) / bars_count),
        },
        "episodes": {"completed_count": len(episodes), "completed": episodes},
        "closed_allocations": metrics["closed_trades"],
        "open_position": {
            "quantity": _plain(replay["position_quantity"]),
            "allocations": replay["open_allocations"],
            "mark_close": str(last_close),
            "open_episode": open_since,
        },
        "rejected": _rejected(replay, window[warmup][0].time),
    }


def _policy_value(key: str, value: object) -> None:
    """Refuse a policy value of the wrong kind: no null, bool, list or dict where a number goes."""
    if key in _POLICY_FLAGS:
        valid = isinstance(value, bool)
    elif key == "allowedSymbols":
        valid = isinstance(value, list) and all(isinstance(item, str) for item in value)
    elif key == "sideMode":
        valid = isinstance(value, str)
    else:
        valid = not isinstance(value, bool) and isinstance(value, (int, float, str))
        if valid and isinstance(value, str):
            valid = key in _POLICY_DECIMALS
        if valid:
            try:
                valid = Decimal(str(value)).is_finite()
            except ArithmeticError:
                valid = False
    if not valid:
        raise _invalid("policy." + key)


def _contract(contract: object) -> dict:
    optional = ["rows"] + _CONTRACT_ECHO
    contract = _exact_keys(contract, _CONTRACT_REQUIRED, optional, "contract")
    for key in _CONTRACT_STRINGS:
        if not isinstance(contract[key], str):
            raise _invalid("contract." + key)
    for key in _CONTRACT_ECHO:
        if contract.get(key) is not None and not isinstance(contract[key], str):
            raise _invalid("contract." + key)
    policy = _exact_keys(contract["policy"], _POLICY_KEYS, [], "policy")
    for key in _POLICY_KEYS:
        _policy_value(key, policy[key])
    return contract


def evaluate_fixed_bars(contract: dict, bridge: dict, bars: list, kind: str, split: dict) -> dict:
    """Evaluate prepared ``(BridgeBar, buy, native_exit)`` bars on fixed Bridge values."""
    _refuse_search([contract, bridge, kind, split])
    contract = _contract(contract)
    bridge = _exact_keys(bridge, ["atr_multiplier", "rr"], [], "bridge")
    if len(bars) > MAX_ROWS:
        raise _invalid("rows.capacity")
    return _run(contract, _bridge(bridge), bars, kind, split)


def _row_number(value: object, name: str) -> Decimal:
    """Parse one row number the way research_engine does, refusing anything non-finite."""
    if isinstance(value, bool) or not isinstance(value, (int, float, str)):
        raise _invalid(name)
    try:
        result = Decimal(str(value))
    except ArithmeticError:
        raise _invalid(name) from None
    if not result.is_finite():
        raise _invalid(name)
    return result


def _checked_rows(rows: object) -> list:
    if not isinstance(rows, list) or not rows:
        raise _invalid("rows")
    if len(rows) > MAX_ROWS:
        raise _invalid("rows.capacity")
    previous = None
    for row in rows:
        if not isinstance(row, dict) or not (_ROW_KEYS - {"atr14"}) <= set(row):
            raise _invalid("rows")
        if row.get("atr14") is None:
            raise _invalid("rows.atr14")
        if set(row) != _ROW_KEYS:
            raise _invalid("rows")
        time = row["time"]
        if isinstance(time, bool) or not isinstance(time, int):
            raise _invalid("rows.time")
        if not 0 < time <= MAX_TIME_MS or time % MINUTE_MS != 0:
            raise _invalid("rows.time")
        if previous is not None and time - previous != MINUTE_MS:
            raise _invalid("rows.gap")
        previous = time
        for key in _ROW_NUMBERS:
            _row_number(row[key], "rows." + key)
        if _row_number(row["atr14"], "rows.atr14") < 0:
            raise _invalid("rows.atr14")
    return rows


def _frozen_bars(rows: list, evaluated: list) -> list:
    """Build bars exactly as research_engine does: frozen ``atr14``, never a cold-start ATR."""
    return [
        (
            BridgeBar(
                row["time"],
                *(Decimal(str(row[key])) for key in _ROW_NUMBERS),
                Decimal(str(row["atr14"])),
            ),
            signal.buy,
            signal.native_exit,
        )
        for row, signal in zip(rows, evaluated, strict=True)
    ]


def evaluate_fixed(contract: dict, parameters: dict, kind: str, split: dict) -> dict:
    """Evaluate fixed selected inputs on frozen ``contract["rows"]``; no search.

    ``parameters`` is ``{"inputs": <all ten SPT Custom fields>, "atr_multiplier": str,
    "rr": str}``. ``kind`` is EVALUATION or EVALUATION_STRESS. ``split`` is
    ``{"warmup": int, "end": int}`` as bar indexes into ``rows``: the first
    ``warmup`` bars (at least one) only warm the signal state, the window is
    ``[warmup, end)``. Each row is ``{time, open, high, low, close, volume, atr14}``.
    """
    _refuse_search([contract, parameters, kind, split])
    contract = _contract(contract)
    parameters = _exact_keys(parameters, ["inputs", "atr_multiplier", "rr"], [], "parameters")
    rows = _checked_rows(contract.get("rows"))
    raw_inputs = _exact_keys(
        parameters["inputs"], [field for field, *_ in CATALOG.values()], [], "inputs"
    )
    inputs = CustomSignalInputs(**raw_inputs)
    bars = _frozen_bars(rows, evaluate_bars(rows, inputs))
    return _run(contract, _bridge(parameters), bars, kind, split)


def _error_code(error: BaseException) -> str:
    """Only a short upper-case code leaves the driver: no message text, path or traceback."""
    text = error.args[0] if error.args and isinstance(error.args[0], str) else ""
    return text if len(text) <= 120 and _ERROR_CODE.fullmatch(text) else FAILED


def _refuse_constant(_name: str) -> None:
    """json.loads hook: NaN, Infinity and -Infinity are not valid request values."""
    raise ValueError(_name)


def _encode(output: dict) -> tuple[str, bool]:
    """Encode the whole output before anything is written; any failure is the generic code."""
    try:
        return json.dumps(output, separators=(",", ":"), allow_nan=False), "error" in output
    except Exception:
        return '{"error":"' + FAILED + '"}', True


def _main() -> None:
    raw = sys.stdin.buffer.read(MAX_REQUEST_BYTES + 1)
    try:
        if len(raw) > MAX_REQUEST_BYTES:
            raise _invalid("request.size")
        try:
            request = json.loads(raw, parse_constant=_refuse_constant)
        except (ValueError, RecursionError):
            raise _invalid("request.json") from None
        request = _exact_keys(request, _REQUEST_KEYS, [], "request")
        output = {
            "result": evaluate_fixed(
                request["contract"], request["parameters"], request["kind"], request["split"]
            )
        }
    except (ValueError, TypeError) as e:
        output = {"error": _error_code(e)}
    except Exception:  # Backstop: never a message or traceback, only the generic code.
        output = {"error": FAILED}
    text, failed = _encode(output)
    sys.stdout.write(text)
    sys.stdout.flush()
    if failed:
        sys.exit(1)


if __name__ == "__main__":
    _main()
