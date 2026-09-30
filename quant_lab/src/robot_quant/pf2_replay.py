"""PF-2 stateful historical Paper replay chunks (slice S1, development only).

Scope: `paper-close-v1` only, SPT Custom evaluator signals only, at most 10,000
closed 1m bars including warm-up, FRESH initial account only. Diagnostic output:
`evaluator_admission` is always false, no holdout bar is read, no order is
executed, no guard is reset and no setting is applied. A cost-model V2 job is
rejected fail-closed (PF2_UNSUPPORTED_EXECUTION_MODEL); this module never
imports `paper_cost_model`. It is not routed through `research_chunk`.

One `SptCustomEvaluator` and one `PaperState` carry the whole run. State crosses
chunk edges as canonical JSON (`evaluate_pf2_chunk` checkpoint) with no reset of
cash, loss streak, daily statistics, guards or counters, so a restarted run equals
an uninterrupted run. The checkpoint `integrity` field is plain SHA-256: it detects
accidental corruption and unsigned edits only, it is NOT authentication (anyone
holding a checkpoint can re-sign it). The caller (S4/scheduler) must keep checkpoints
in trusted server storage; authenticated state is a later runtime slice. Bars before `dataset.first_time + warmup_bars * 60000` warm
signal and Bridge state only; they never touch the Paper ledger.

Request (`pf2-replay-chunk-v1`), all shared JSON ASCII, decimals as strings:
  {version, contract, rows, checkpoint}
  contract (`pf2-replay-job-v1`) = {version, plan_hash(sha256 hex), deployment_id,
    signal{mode:"EVALUATOR", profile:"SPT_CUSTOM", source, snapshot},
    bridge{atr_multiplier, rr}, model{price_tick, quantity_step, fee_bps,
    slippage_bps, risk_percent, version:"paper-close-v1"}, policy{16 Node keys},
    capital{cash, equity}, initial_state{kind:"FRESH", loss_streak},
    broker:"binance-global", symbol:"BTCUSDT",
    dataset{first_time, total_bars, warmup_bars, development_end_time,
            holdout_start_time},
    limits{max_bars, max_state_bytes, max_output_bytes, max_samples}}
  rows = consecutive closed bars, `time` = close time in ms, decimals as strings:
    [{time, open, high, low, close, volume, atr14|null[, price_tick, quantity_step]}]
  checkpoint = null | previous response checkpoint.
Response: {checkpoint, result}; `result` is null until the final chunk.
  checkpoint = {version, identity{plan_hash, contract_digest}, next_bar, last_time,
    evaluator, paper, counters, guards, samples, integrity}
  result (`pf2-replay-result-v1`) = {version, plan_hash, execution_model_version,
    window, counters, derived, guards, account, samples, admission, limitations}

Development boundary: rows must satisfy `time <= development_end_time <=
holdout_start_time`. Row `time` is a CLOSE time. A closed bar stamped exactly at the
holdout start covers only the minute before it, so it is development data; the raw
dataset rule `metadata.end_time <= development.end_time` applies to raw metadata
(derived closed metadata carries end_time = raw end + 1 minute, an exclusive index
bound; never compare that derived value with the development end).

Counters (all in checkpoint and result, invariants enforced on every chunk edge):
  signals{buy, native_exit, buy_evaluated, native_exit_evaluated}: evaluator flags.
  intents{buy, exit_sl, exit_tp, exit_native}: Bridge intents in the evaluation
    window; warmup_intents{buy, exit} before it. derived.suppressed_buy = signals.buy - all BUY intents (warm-up
    bars INCLUDED); derived.suppressed_buy_evaluated covers the evaluation window only.
  orders{accepted, sizing_adjusted, rejected, rejected_by_reason}: one per evaluation
    intent. accepted = filled with no sizing adjustment; sizing_adjusted = filled with
    ledger sizing_outcome CAPPED. In V1 that INCLUDES plain quantity-step rounding
    (bridge_replay.py round_order sets the adjustment whenever the quantity rounds
    down), so nearly every BUY is sizing_adjusted. It is NOT a risk-budget or cash
    cap indicator; result `limitations` says so.
  fills{buy, exit, exit_by_reason}: fills == accepted + sizing_adjusted.
  episodes{closed, losing}: quantity > 0 to 0 transitions and those that raised the
    loss streak. StreamingMetrics counts per exit fill and is not reused.
Guards are classified from state (kill switch, trades per day, daily loss, loss
streak); reject-reason strings are only cross-checked. Kill switch and loss streak
are persistent pauses (no entry can occur, so the streak cannot clear). Trades per
day and daily loss are day-scoped: they end at the next UTC midnight, and a daily
loss pause also ends earlier if a later exit of another open allocation realizes
enough profit. No ETA field is ever emitted.

Errors are single codes without input echo (`PF2Error.code`): PF2_REQUEST_INVALID,
PF2_UNSUPPORTED_EXECUTION_MODEL, PF2_UNSUPPORTED_SIGNAL_MODE,
PF2_INITIAL_STATE_UNSUPPORTED, PF2_HOLDOUT_BOUNDARY_VIOLATION, PF2_ROW_CONTINUITY,
PF2_ROW_INVALID, PF2_CHECKPOINT_INVALID, PF2_LIMIT_EXCEEDED, PF2_CANCELLED,
PF2_DEADLINE_EXCEEDED, PF2_EVALUATOR_UNAVAILABLE, PF2_EVALUATION_FAILED.
"""

import json
import math
import os
import re
import sys
import time
from copy import deepcopy
from dataclasses import asdict, dataclass, is_dataclass
from datetime import UTC, datetime
from decimal import Decimal

from robot_quant.bridge_replay import BridgeBar, PaperModel
from robot_quant.paper_state import PaperState
from robot_quant.research_chunk import (
    IPC_LIMIT,
    STATE_LIMIT,
    canonical,
    digest,
    export_evaluator,
    import_evaluator,
    prepare_io_telemetry,
)
from robot_quant.spt_custom_evaluator import CustomOptimizationPlan, SptCustomEvaluator

PF2_REPLAY_VERSION = "pf2-replay-chunk-v1"
PF2_JOB_VERSION = "pf2-replay-job-v1"
PF2_RESULT_VERSION = "pf2-replay-result-v1"
V1_MODEL_VERSION = "paper-close-v1"

MINUTE_MS = 60000
DAY_MS = 86_400_000
MAX_BARS = 10_000  # Includes warm-up; the 50K ceiling is a separate, unproven gate.
MAX_SAMPLES = 200
MAX_REASON_KEYS = 32
MAX_PAUSE_PERIODS = 256
MAX_DAILY_DAYS = 9  # PaperState.import_state limit; the documented 50K blocker.
MAX_LOSS_STREAK = 1_000_000
MAX_TIME_MS = 253_402_300_799_999  # End of year 9999: the datetime range PaperState uses.
CANCEL_CHECK_BARS = 256

GUARD_KINDS = ("KILL_SWITCH", "MAX_TRADES_PER_DAY", "MAX_DAILY_LOSS", "LOSS_STREAK")
PERSISTENT_KINDS = frozenset({"KILL_SWITCH", "LOSS_STREAK"})
GUARD_REASONS = {
    "KILL_SWITCH": "Kill switch is active: entries paused",
    "MAX_TRADES_PER_DAY": "Maximum trades per day reached",
    "MAX_DAILY_LOSS": "Maximum daily loss reached",
    "LOSS_STREAK": "Trading paused after loss streak",
}
EXIT_REASONS = ("SL", "TP", "NATIVE")

_SIGNAL_KEYS = ("buy", "native_exit", "buy_evaluated", "native_exit_evaluated")
_INTENT_KEYS = ("buy", "exit_sl", "exit_tp", "exit_native")
_WARMUP_KEYS = ("buy", "exit")
_ORDER_KEYS = ("accepted", "sizing_adjusted", "rejected", "rejected_by_reason")
_FILL_KEYS = ("buy", "exit", "exit_by_reason")
_EPISODE_KEYS = ("closed", "losing")
_COUNTER_KEYS = ("signals", "intents", "warmup_intents", "orders", "fills", "episodes")

_CONTRACT_KEYS = (
    "version", "plan_hash", "deployment_id", "signal", "bridge", "model", "policy",
    "capital", "initial_state", "broker", "symbol", "dataset", "limits",
)
_SIGNAL_SPEC_KEYS = ("mode", "profile", "source", "snapshot")
_MODEL_KEYS = (
    "price_tick", "quantity_step", "fee_bps", "slippage_bps", "risk_percent", "version",
)
_POLICY_KEYS = (
    "killSwitch", "maxSignalAgeSeconds", "maxTradesPerDay", "maxDailyLossR",
    "pauseAfterLossStreak", "blockHighVolatility", "maxVolatilityPercent",
    "blockDuringNews", "allowedSymbols", "sideMode", "maxOpenPositions",
    "onePositionPerSymbol", "capPercentEquitySize", "maxRiskPercent",
    "maxOrderNotional", "maxDailyNotional",
)
_POLICY_BOOLS = (
    "killSwitch", "blockHighVolatility", "blockDuringNews", "onePositionPerSymbol",
    "capPercentEquitySize",
)
_POLICY_INTS = (
    "maxSignalAgeSeconds", "maxTradesPerDay", "pauseAfterLossStreak", "maxOpenPositions",
)
_POLICY_NUMBERS = ("maxDailyLossR", "maxRiskPercent", "maxOrderNotional", "maxDailyNotional")
_DATASET_KEYS = (
    "first_time", "total_bars", "warmup_bars", "development_end_time", "holdout_start_time",
)
_LIMIT_KEYS = ("max_bars", "max_state_bytes", "max_output_bytes", "max_samples")
_ROW_KEYS = frozenset(("time", "open", "high", "low", "close", "volume", "atr14"))
_ROW_OPTIONAL = frozenset(("price_tick", "quantity_step"))
_CHECKPOINT_KEYS = frozenset((
    "version", "identity", "next_bar", "last_time", "evaluator", "paper", "counters",
    "guards", "samples", "integrity",
))

_DECIMAL = re.compile(r"[0-9]+(?:\.[0-9]+)?")
_HEX64 = re.compile(r"[0-9a-f]{64}")
_IDENTIFIER = re.compile(r"[A-Za-z0-9_.-]{1,64}")
_monotonic = time.monotonic  # Indirection so tests can drive the deadline clock.


class PF2Error(ValueError):
    """Single fail-closed code. Never echoes source, contract, rows or state."""

    def __init__(self, code):
        super().__init__(code)
        self.code = code


# --- small validators -------------------------------------------------------------


def _bad(code="PF2_REQUEST_INVALID"):
    raise PF2Error(code) from None  # Never chain the original error (may carry content).


def _exact(value, keys, code="PF2_REQUEST_INVALID"):
    if not isinstance(value, dict) or set(value) != set(keys):
        _bad(code)
    return value


def _is_int(value, minimum=None, maximum=None):
    if type(value) is not int:
        return False
    return (minimum is None or value >= minimum) and (maximum is None or value <= maximum)


def _decimal(text, code="PF2_REQUEST_INVALID", *, positive=False):
    if not isinstance(text, str) or len(text) > 64 or _DECIMAL.fullmatch(text) is None:
        _bad(code)
    value = Decimal(text)
    if positive and value <= 0:
        _bad(code)
    return value


def _fixed(value):
    return format(value, "f")


def _utc_day(milliseconds):
    # Same expression and key as PaperState so guard days match ledger days.
    return datetime.fromtimestamp(milliseconds / 1000, UTC).date().isoformat()


def _next_midnight(milliseconds):
    return (milliseconds // DAY_MS + 1) * DAY_MS


# --- contract ---------------------------------------------------------------------


@dataclass(frozen=True)
class Job:
    plan_hash: str
    deployment_id: str
    signal: dict
    multiplier: Decimal
    rr: Decimal
    model: PaperModel
    policy: dict
    cash: Decimal
    equity: Decimal
    broker: str
    symbol: str
    initial_loss_streak: int
    first_time: int
    total_bars: int
    warmup_bars: int
    development_end_time: int
    holdout_start_time: int
    max_state_bytes: int
    max_output_bytes: int
    max_samples: int
    identity: dict

    @property
    def evaluation_start(self):
        return self.first_time + self.warmup_bars * MINUTE_MS


def _check_policy(policy):
    _exact(policy, _POLICY_KEYS)
    if any(type(policy[name]) is not bool for name in _POLICY_BOOLS):
        _bad()
    if any(not _is_int(policy[name], 0, 10**9) for name in _POLICY_INTS):
        _bad()
    for name in _POLICY_NUMBERS:
        value = policy[name]
        if isinstance(value, bool) or not isinstance(value, (int, float, str)):
            _bad()
        try:
            number = Decimal(str(value))
        except ArithmeticError:
            _bad()
        if not number.is_finite() or number < 0:
            _bad()
    volatility = policy["maxVolatilityPercent"]  # Compared as a float by the evaluator.
    if isinstance(volatility, bool) or not isinstance(volatility, (int, float)):
        _bad()
    if isinstance(volatility, float) and not math.isfinite(volatility):
        _bad()  # 1e999 parses to inf in JSON (parse_constant does not see it).
    if volatility < 0 or volatility > 10**12:
        _bad()
    symbols = policy["allowedSymbols"]
    if not isinstance(symbols, list) or any(
        not isinstance(s, str) or not s.isascii() for s in symbols
    ):
        _bad()
    if policy["sideMode"] not in ("BOTH", "BUY_ONLY", "SELL_ONLY"):
        _bad()


def _check_signal(signal):
    if not isinstance(signal, dict):
        _bad()
    if signal.get("mode") != "EVALUATOR":
        # BOUND_SIGNAL_CSV is a separate, later slice; deny rather than approximate.
        _bad("PF2_UNSUPPORTED_SIGNAL_MODE")
    _exact(signal, _SIGNAL_SPEC_KEYS)
    if signal["profile"] != "SPT_CUSTOM":
        _bad("PF2_UNSUPPORTED_SIGNAL_MODE")
    if not isinstance(signal["source"], str) or not isinstance(signal["snapshot"], dict):
        _bad()


def _check_model(model):
    if not isinstance(model, dict):
        _bad()
    if model.get("version") != V1_MODEL_VERSION:
        _bad("PF2_UNSUPPORTED_EXECUTION_MODEL")  # Includes paper-close-cost-v2.
    _exact(model, _MODEL_KEYS)
    fields = {
        "price_tick": _decimal(model["price_tick"], positive=True),
        "quantity_step": _decimal(model["quantity_step"], positive=True),
        "fee_bps": _decimal(model["fee_bps"]),
        "slippage_bps": _decimal(model["slippage_bps"]),
        "risk_percent": _decimal(model["risk_percent"], positive=True),
    }
    try:
        return PaperModel(**fields, version=V1_MODEL_VERSION)
    except ValueError:
        _bad()


def _check_initial_state(initial):
    if not isinstance(initial, dict) or "kind" not in initial:
        _bad()
    if initial["kind"] != "FRESH" or not set(initial) <= {"kind", "loss_streak"}:
        _bad("PF2_INITIAL_STATE_UNSUPPORTED")  # Open positions or daily carry: not V1.
    if set(initial) != {"kind", "loss_streak"} or not _is_int(
        initial["loss_streak"], 0, MAX_LOSS_STREAK
    ):
        _bad()
    return initial["loss_streak"]


def _check_dataset_and_limits(dataset, limits):
    _exact(dataset, _DATASET_KEYS)
    _exact(limits, _LIMIT_KEYS)
    if any(not _is_int(dataset[name], 0) for name in _DATASET_KEYS):
        _bad()
    first, total, warmup = dataset["first_time"], dataset["total_bars"], dataset["warmup_bars"]
    dev_end, holdout = dataset["development_end_time"], dataset["holdout_start_time"]
    if (
        total < 1
        or first <= 0
        or warmup >= total
        or any(value % MINUTE_MS or value > MAX_TIME_MS for value in (first, dev_end, holdout))
    ):
        _bad()
    if any(not _is_int(limits[name], 1) for name in _LIMIT_KEYS[:3]) or not _is_int(
        limits["max_samples"], 0
    ):
        _bad()
    if (
        total > MAX_BARS
        or limits["max_bars"] > MAX_BARS
        or limits["max_state_bytes"] > STATE_LIMIT
        or limits["max_output_bytes"] > IPC_LIMIT
        or limits["max_samples"] > MAX_SAMPLES
        or total > limits["max_bars"]
    ):
        _bad("PF2_LIMIT_EXCEEDED")
    if limits["max_state_bytes"] < 4096 or limits["max_output_bytes"] < 1024:
        _bad()
    # Development must precede holdout; the whole declared run must stay inside it.
    if dev_end > holdout or first + (total - 1) * MINUTE_MS > dev_end:
        _bad("PF2_HOLDOUT_BOUNDARY_VIOLATION")


def _parse_contract(contract):
    _exact(contract, _CONTRACT_KEYS)
    if contract["version"] != PF2_JOB_VERSION:
        _bad()
    plan_hash = contract["plan_hash"]
    if not isinstance(plan_hash, str) or _HEX64.fullmatch(plan_hash) is None:
        _bad()
    deployment_id = contract["deployment_id"]
    if not isinstance(deployment_id, str) or _IDENTIFIER.fullmatch(deployment_id) is None:
        _bad()
    _check_signal(contract["signal"])
    model = _check_model(contract["model"])
    if contract["broker"] != "binance-global" or contract["symbol"] != "BTCUSDT":
        _bad()
    initial_loss_streak = _check_initial_state(contract["initial_state"])
    _check_policy(contract["policy"])
    bridge = _exact(contract["bridge"], ("atr_multiplier", "rr"))
    capital = _exact(contract["capital"], ("cash", "equity"))
    _check_dataset_and_limits(contract["dataset"], contract["limits"])
    dataset, limits = contract["dataset"], contract["limits"]
    return Job(
        plan_hash=plan_hash,
        deployment_id=deployment_id,
        signal=contract["signal"],
        multiplier=_decimal(bridge["atr_multiplier"], positive=True),
        rr=_decimal(bridge["rr"], positive=True),
        model=model,
        policy=contract["policy"],
        cash=_decimal(capital["cash"], positive=True),
        equity=_decimal(capital["equity"], positive=True),
        broker=contract["broker"],
        symbol=contract["symbol"],
        initial_loss_streak=initial_loss_streak,
        first_time=dataset["first_time"],
        total_bars=dataset["total_bars"],
        warmup_bars=dataset["warmup_bars"],
        development_end_time=dataset["development_end_time"],
        holdout_start_time=dataset["holdout_start_time"],
        max_state_bytes=limits["max_state_bytes"],
        max_output_bytes=limits["max_output_bytes"],
        max_samples=limits["max_samples"],
        identity={"plan_hash": plan_hash, "contract_digest": digest(contract)},
    )


# --- rows -------------------------------------------------------------------------


def _check_boundary(rows, job):
    # Whole chunk, before any parsing or state work: never touch a bar past development.
    for row in rows:
        if isinstance(row, dict) and type(row.get("time")) is int:
            if row["time"] > job.development_end_time:
                _bad("PF2_HOLDOUT_BOUNDARY_VIOLATION")


def _parse_rows(rows, next_bar, job):
    if not isinstance(rows, list):
        _bad()
    if not rows or next_bar + len(rows) > job.total_bars:
        _bad("PF2_ROW_CONTINUITY")
    parsed = []
    for offset, row in enumerate(rows):
        if not isinstance(row, dict):
            _bad()
        keys = set(row)
        if not _ROW_KEYS <= keys or not keys <= _ROW_KEYS | _ROW_OPTIONAL:
            _bad()
        if type(row["time"]) is not int:
            _bad()
        if row["time"] != job.first_time + (next_bar + offset) * MINUTE_MS:
            _bad("PF2_ROW_CONTINUITY")
        values = [
            _decimal(row[name], "PF2_ROW_INVALID")
            for name in ("open", "high", "low", "close", "volume")
        ]
        atr = None if row["atr14"] is None else _decimal(row["atr14"], "PF2_ROW_INVALID")
        for name, expected in (
            ("price_tick", job.model.price_tick),
            ("quantity_step", job.model.quantity_step),
        ):
            if name in row and _decimal(row[name], "PF2_ROW_INVALID") != expected:
                _bad("PF2_ROW_INVALID")
        try:
            parsed.append((row, BridgeBar(row["time"], *values, atr)))
        except ValueError:
            _bad("PF2_ROW_INVALID")
    return parsed


# --- signal source seam -----------------------------------------------------------


class EvaluatorSource:
    """Signal-source protocol: step(row) -> object with `.buy` / `.native_exit`,
    export_state() -> JSON, import_state(state, next_bar). Only closed OHLC of the
    supplied bar reaches the evaluator; ATR for Bridge levels comes from the row."""

    def __init__(self, evaluator):
        self.evaluator = evaluator

    def step(self, row):
        return self.evaluator.step(*(float(row[name]) for name in ("open", "high", "low", "close")))

    def export_state(self):
        return export_evaluator(self.evaluator)

    def import_state(self, state, next_bar):
        import_evaluator(self.evaluator, state, next_bar)


def build_signal_source(signal):
    """Baseline SPT Custom inputs only (no candidate changes, one evaluation)."""
    plan = CustomOptimizationPlan.from_snapshot(signal["source"].encode(), signal["snapshot"])
    return EvaluatorSource(SptCustomEvaluator(plan.baseline))


def _make_source(job):
    try:
        return build_signal_source(job.signal)
    except PF2Error:
        raise
    except Exception:
        _bad("PF2_EVALUATOR_UNAVAILABLE")


def _signal_view(signal):
    if is_dataclass(signal):
        return asdict(signal)
    return {"buy": signal.buy, "native_exit": signal.native_exit}


# --- guards and pause periods -----------------------------------------------------


def _guard_kinds(paper, day):
    """Guards that reject an entry now, from state only, in evaluator precedence."""
    policy = paper.risk_policy
    stats = paper.daily.get(day)
    trades = stats.trades if stats else 0
    realized = stats.realized_r if stats else Decimal(0)
    kinds = []
    if policy.kill_switch:
        kinds.append("KILL_SWITCH")
    if trades >= policy.max_trades_per_day:
        kinds.append("MAX_TRADES_PER_DAY")
    if realized <= -abs(policy.max_daily_loss_r):
        kinds.append("MAX_DAILY_LOSS")
    if paper.loss_streak >= policy.pause_after_loss_streak:
        kinds.append("LOSS_STREAK")
    return kinds


class Guards:
    """Open and closed pause periods. Persistent kinds never close."""

    def __init__(self, state=None):
        state = state or {"open": {}, "closed": [], "dropped": 0}
        self.open = dict(state["open"])
        self.closed = [dict(period) for period in state["closed"]]
        self.dropped = state["dropped"]

    def export(self):
        return {
            "open": {kind: self.open[kind] for kind in GUARD_KINDS if kind in self.open},
            "closed": [dict(period) for period in self.closed],
            "dropped": self.dropped,
        }

    def _close(self, kind, end):
        start = self.open.pop(kind)
        if len(self.closed) < MAX_PAUSE_PERIODS:
            self.closed.append(
                {"kind": kind, "start_time": start, "end_time": end, "persistent": False}
            )
        else:
            self.dropped += 1

    def close_expired(self, now):
        for kind in GUARD_KINDS:
            if kind in self.open and kind not in PERSISTENT_KINDS:
                end = _next_midnight(self.open[kind])
                if now >= end:
                    self._close(kind, end)

    def start(self, kinds, now):
        for kind in kinds:
            self.open.setdefault(kind, now)

    def before_bar(self, paper, now):
        """Close expired day pauses; return the guards this bar's entry will see."""
        self.close_expired(now)
        return _guard_kinds(paper, _utc_day(now))

    def after_bar(self, paper, now):
        """Fills of this bar can trip a guard, or lift a daily-loss pause (a later exit
        of another open allocation may realize profit); persistent kinds never lift."""
        active = _guard_kinds(paper, _utc_day(now))
        for kind in GUARD_KINDS:
            if kind in self.open and kind not in PERSISTENT_KINDS and kind not in active:
                self._close(kind, now)
        self.start(active, now)

    def report(self):
        periods = [dict(period) for period in self.closed]
        for kind in GUARD_KINDS:
            if kind in self.open:
                periods.append(
                    {
                        "kind": kind,
                        "start_time": self.open[kind],
                        "end_time": None,
                        "persistent": kind in PERSISTENT_KINDS,
                    }
                )
        return {
            "persistent": any(kind in PERSISTENT_KINDS for kind in self.open),
            "active_kinds": [kind for kind in GUARD_KINDS if kind in self.open],
            "periods": periods,
            "truncated": self.dropped > 0,
            "dropped_periods": self.dropped,
        }

    def validate(self, job, paper, next_bar, last_time):
        if not _is_int(self.dropped, 0):
            raise ValueError("GUARDS")
        for kind, start in self.open.items():
            if kind not in GUARD_KINDS or not _is_int(start, job.evaluation_start, last_time):
                raise ValueError("GUARDS")
            if kind not in PERSISTENT_KINDS and _next_midnight(start) <= last_time:
                raise ValueError("GUARDS")  # Expired periods close before the next bar.
        if len(self.closed) > MAX_PAUSE_PERIODS or (
            self.dropped and len(self.closed) != MAX_PAUSE_PERIODS
        ):
            raise ValueError("GUARDS")
        for period in self.closed:
            if set(period) != {"kind", "start_time", "end_time", "persistent"}:
                raise ValueError("GUARDS")
            kind, start, end = period["kind"], period["start_time"], period["end_time"]
            if (
                kind not in GUARD_KINDS
                or kind in PERSISTENT_KINDS
                or period["persistent"] is not False
                or not _is_int(start, job.evaluation_start, last_time)
                or not _is_int(end, start + 1, min(_next_midnight(start), last_time))
            ):
                raise ValueError("GUARDS")
        # Open pauses are state facts: they equal the guards the state raises right now.
        evaluated = next_bar > job.warmup_bars
        active = _guard_kinds(paper, _utc_day(last_time)) if evaluated else []
        if set(self.open) != set(active):
            raise ValueError("GUARDS")


# --- counters and samples ---------------------------------------------------------


def _fresh_counters():
    return {
        "signals": dict.fromkeys(_SIGNAL_KEYS, 0),
        "intents": dict.fromkeys(_INTENT_KEYS, 0),
        "warmup_intents": dict.fromkeys(_WARMUP_KEYS, 0),
        "orders": {"accepted": 0, "sizing_adjusted": 0, "rejected": 0, "rejected_by_reason": {}},
        "fills": {"buy": 0, "exit": 0, "exit_by_reason": {}},
        "episodes": {"closed": 0, "losing": 0},
    }


def _fresh_samples():
    return {"fills": [], "rejections": []}


def _reason_key(reason, mapping):
    key = reason if isinstance(reason, str) and reason.isascii() and reason.isprintable() else None
    if key is None or not 0 < len(key) <= 128:
        key = "OTHER"
    distinct = len(mapping) - (1 if "OTHER" in mapping else 0)
    if key not in mapping and distinct >= MAX_REASON_KEYS:
        key = "OTHER"
    return key


def _sample_fill(decision):
    return {
        "time": decision["time"],
        "event_type": decision["event_type"],
        "entry_ref": decision["entry_ref"],
        "reason": decision["reason"] if decision["event_type"] == "EXIT" else None,
        "sizing_outcome": decision["sizing_outcome"],
        "quantity": decision["quantity"],
        "price": decision["price"],
        "notional": decision["notional"],
        "fee": decision["fee"],
    }


def _record_bar(counters, samples, job, evaluated, signal, replay):
    tally = counters["signals"]
    tally["buy"] += int(signal.buy)
    tally["native_exit"] += int(signal.native_exit)
    if evaluated:
        tally["buy_evaluated"] += int(signal.buy)
        tally["native_exit_evaluated"] += int(signal.native_exit)
    for event in replay["events"]:
        if event["event_type"] == "BUY":
            counters["intents" if evaluated else "warmup_intents"]["buy"] += 1
        elif evaluated:
            counters["intents"]["exit_" + event["reason"].lower()] += 1
        else:
            counters["warmup_intents"]["exit"] += 1
    orders, fills = counters["orders"], counters["fills"]
    for decision in replay["decisions"]:
        if decision["outcome"] == "REJECTED":
            orders["rejected"] += 1
            key = _reason_key(decision["reason"], orders["rejected_by_reason"])
            orders["rejected_by_reason"][key] = orders["rejected_by_reason"].get(key, 0) + 1
            if len(samples["rejections"]) < job.max_samples:
                samples["rejections"].append(
                    {
                        "time": decision["time"],
                        "event_type": decision["event_type"],
                        "entry_ref": decision["entry_ref"],
                        "reason": key,
                    }
                )
            continue
        if decision["outcome"] != "FILLED":
            raise ValueError("UNKNOWN_DECISION_OUTCOME")
        orders["sizing_adjusted" if decision["sizing_outcome"] == "CAPPED" else "accepted"] += 1
        if decision["event_type"] == "BUY":
            fills["buy"] += 1
        else:
            fills["exit"] += 1
            by_reason = fills["exit_by_reason"]
            by_reason[decision["reason"]] = by_reason.get(decision["reason"], 0) + 1
        if len(samples["fills"]) < job.max_samples:
            samples["fills"].append(_sample_fill(decision))


def _check_guard_agreement(kinds, replay):
    """State-derived guards vs reject-reason strings (strings are only a cross-check)."""
    for decision in replay["decisions"]:
        if decision["event_type"] != "BUY":
            continue
        if kinds:
            expected = GUARD_REASONS[kinds[0]]
            if decision["outcome"] != "REJECTED" or decision["reason"] != expected:
                raise ValueError("GUARD_STATE_REASON_MISMATCH")
        elif decision["outcome"] == "REJECTED" and decision["reason"] in GUARD_REASONS.values():
            raise ValueError("GUARD_STATE_REASON_MISMATCH")


def _count_map(mapping, keys=None, *, positive=False):
    if not isinstance(mapping, dict):
        raise ValueError("COUNTERS")
    for key, value in mapping.items():
        if not isinstance(key, str) or not _is_int(value, 1 if positive else 0):
            raise ValueError("COUNTERS")
        if keys is not None and key not in keys:
            raise ValueError("COUNTERS")
    return sum(mapping.values())


def _check_progress(counters, samples, guards, job, paper, next_bar, last_time):
    """Cross-field invariants; used on checkpoint import and after every chunk."""
    if not isinstance(counters, dict) or set(counters) != set(_COUNTER_KEYS):
        raise ValueError("COUNTERS")
    layout = (
        ("signals", _SIGNAL_KEYS),
        ("intents", _INTENT_KEYS),
        ("warmup_intents", _WARMUP_KEYS),
        ("orders", _ORDER_KEYS),
        ("fills", _FILL_KEYS),
        ("episodes", _EPISODE_KEYS),
    )
    for name, keys in layout:
        group = counters[name]
        if not isinstance(group, dict) or set(group) != set(keys):
            raise ValueError("COUNTERS")
        if any(not _is_int(group[key], 0) for key in keys if not key.endswith("_reason")):
            raise ValueError("COUNTERS")
    signals, intents, warmup = counters["signals"], counters["intents"], counters["warmup_intents"]
    orders, fills, episodes = counters["orders"], counters["fills"], counters["episodes"]
    evaluated_bars = max(0, next_bar - job.warmup_bars)
    warmup_bars = min(next_bar, job.warmup_bars)
    if (
        signals["buy"] > next_bar
        or signals["native_exit"] > next_bar
        or signals["buy_evaluated"] > min(signals["buy"], evaluated_bars)
        or signals["native_exit_evaluated"] > min(signals["native_exit"], evaluated_bars)
        or signals["buy"] - signals["buy_evaluated"] > warmup_bars
    ):
        raise ValueError("COUNTERS")
    evaluated_intents = sum(intents.values())
    if (
        intents["buy"] + warmup["buy"] > signals["buy"]
        or intents["buy"] > signals["buy_evaluated"]
        or warmup["buy"] > signals["buy"] - signals["buy_evaluated"]
        or evaluated_intents > evaluated_bars * 1000
        or (warmup_bars == 0 and sum(warmup.values()) != 0)
        or (evaluated_bars == 0 and evaluated_intents != 0)
    ):
        raise ValueError("COUNTERS")
    rejected = _count_map(orders["rejected_by_reason"], positive=True)
    exits = _count_map(fills["exit_by_reason"], EXIT_REASONS, positive=True)
    if (
        len(orders["rejected_by_reason"]) > MAX_REASON_KEYS + 1
        or any(len(key) > 128 or not key.isascii() for key in orders["rejected_by_reason"])
        or rejected != orders["rejected"]
        or exits != fills["exit"]
        or orders["accepted"] + orders["sizing_adjusted"] + orders["rejected"] != evaluated_intents
        or fills["buy"] + fills["exit"] != orders["accepted"] + orders["sizing_adjusted"]
        or fills["buy"] > intents["buy"]
        or fills["exit"] > fills["buy"]
        or episodes["closed"] > fills["exit"]
        or episodes["losing"] > episodes["closed"]
    ):
        raise ValueError("COUNTERS")
    if len(paper.positions) != fills["buy"] - fills["exit"]:
        raise ValueError("COUNTERS")
    # The streak only rises by one per losing flat transition, from the carried value.
    if paper.loss_streak > job.initial_loss_streak + episodes["losing"] or (
        episodes["closed"] == 0 and paper.loss_streak != job.initial_loss_streak
    ):
        raise ValueError("COUNTERS")
    if paper.quantity == 0 and (paper.pnl != 0 or paper.initial_risk != 0):
        raise ValueError("COUNTERS")  # PaperState clears both at every flat transition.
    if sum(day.trades for day in paper.daily.values()) != fills["buy"] + fills["exit"]:
        raise ValueError("COUNTERS")
    if paper.replay.last_time != last_time:
        raise ValueError("COUNTERS")
    _check_samples(samples, job, fills, orders)
    guards.validate(job, paper, next_bar, last_time)


def _check_samples(samples, job, fills, orders):
    if not isinstance(samples, dict) or set(samples) != {"fills", "rejections"}:
        raise ValueError("SAMPLES")
    fill_keys = {
        "time", "event_type", "entry_ref", "reason", "sizing_outcome", "quantity", "price",
        "notional", "fee",
    }
    for name, keys, total in (
        ("fills", fill_keys, fills["buy"] + fills["exit"]),
        ("rejections", {"time", "event_type", "entry_ref", "reason"}, orders["rejected"]),
    ):
        entries = samples[name]
        if not isinstance(entries, list) or len(entries) != min(job.max_samples, total):
            raise ValueError("SAMPLES")
        if any(not isinstance(entry, dict) or set(entry) != keys for entry in entries):
            raise ValueError("SAMPLES")


# --- checkpoint -------------------------------------------------------------------


def _open_checkpoint(checkpoint, job):
    """Header, identity, integrity and cursor. Raises PF2_CHECKPOINT_INVALID."""
    try:
        if (
            not isinstance(checkpoint, dict)
            or set(checkpoint) != _CHECKPOINT_KEYS
            or len(canonical(checkpoint)) > min(STATE_LIMIT, job.max_state_bytes)
        ):
            _bad("PF2_CHECKPOINT_INVALID")
        payload = {key: value for key, value in checkpoint.items() if key != "integrity"}
        if (
            checkpoint["version"] != PF2_REPLAY_VERSION
            or checkpoint["identity"] != job.identity
            or checkpoint["integrity"] != digest(payload)
        ):
            _bad("PF2_CHECKPOINT_INVALID")
        next_bar = checkpoint["next_bar"]
        if (
            not _is_int(next_bar, 1, job.total_bars - 1)
            or checkpoint["last_time"] != job.first_time + (next_bar - 1) * MINUTE_MS
        ):
            _bad("PF2_CHECKPOINT_INVALID")
        return next_bar
    except PF2Error:
        raise
    except Exception:
        _bad("PF2_CHECKPOINT_INVALID")


def _restore(checkpoint, job, source, paper, next_bar):
    """Import state; returns (counters, guards, samples). Fails closed on any damage."""
    try:
        source.import_state(checkpoint["evaluator"], next_bar)
        paper.import_state(checkpoint["paper"])
        counters, samples = deepcopy(checkpoint["counters"]), deepcopy(checkpoint["samples"])
        guards = _load_guards(checkpoint["guards"])
        _check_progress(counters, samples, guards, job, paper, next_bar, checkpoint["last_time"])
        return counters, guards, samples
    except PF2Error:
        raise
    except Exception:
        _bad("PF2_CHECKPOINT_INVALID")


def _load_guards(state):
    if not isinstance(state, dict) or set(state) != {"open", "closed", "dropped"}:
        raise ValueError("GUARDS")
    if not isinstance(state["open"], dict) or not isinstance(state["closed"], list):
        raise ValueError("GUARDS")
    if any(not isinstance(period, dict) for period in state["closed"]):
        raise ValueError("GUARDS")
    return Guards(state)


# --- driver -----------------------------------------------------------------------


def _interrupted(should_stop, deadline_monotonic):
    if should_stop is not None and should_stop():
        _bad("PF2_CANCELLED")
    if deadline_monotonic is not None and _monotonic() >= deadline_monotonic:
        _bad("PF2_DEADLINE_EXCEEDED")


def _build_paper(job):
    try:
        paper = PaperState(
            deployment_id=job.deployment_id,
            multiplier=job.multiplier,
            rr=job.rr,
            model=job.model,
            policy=job.policy,
            equity=job.equity,
            cash=job.cash,
            broker=job.broker,
            symbol=job.symbol,
            start_time=job.evaluation_start,
        )
    except Exception:
        _bad()
    return paper


def _run_bars(parsed, next_bar, job, source, paper, counters, guards, samples, sink, hooks):
    should_stop, deadline_monotonic = hooks
    for offset, (row, bar) in enumerate(parsed):
        if offset % CANCEL_CHECK_BARS == 0:
            _interrupted(should_stop, deadline_monotonic)
        evaluated = bar.time >= job.evaluation_start
        kinds = guards.before_bar(paper, bar.time) if evaluated else []
        quantity_before, streak_before = paper.quantity, paper.loss_streak
        signal = source.step(row)
        replay = paper.step(bar, signal.buy, signal.native_exit)
        if evaluated:
            _check_guard_agreement(kinds, replay)
            if quantity_before > 0 and paper.quantity == 0:
                counters["episodes"]["closed"] += 1
                counters["episodes"]["losing"] += int(paper.loss_streak == streak_before + 1)
            guards.after_bar(paper, bar.time)
        elif len(replay["decisions"]) or paper.quantity != 0 or len(paper.daily):
            raise ValueError("WARMUP_TOUCHED_LEDGER")
        _record_bar(counters, samples, job, evaluated, signal, replay)
        if len(paper.daily) > MAX_DAILY_DAYS:
            _bad("PF2_LIMIT_EXCEEDED")  # PaperState cannot checkpoint more than 9 days.
        if sink is not None:
            sink.append(
                {
                    "index": next_bar + offset,
                    "time": bar.time,
                    "evaluated": evaluated,
                    "guards": kinds,
                    "signal": _signal_view(signal),
                    **replay,
                }
            )


def _result(job, next_bar, paper, counters, guards, samples):
    intents = counters["intents"]
    signals = counters["signals"]
    return {
        "version": PF2_RESULT_VERSION,
        "plan_hash": job.plan_hash,
        "execution_model_version": V1_MODEL_VERSION,
        "window": {
            "first_time": job.first_time,
            "evaluation_start_time": job.evaluation_start,
            "last_time": paper.replay.last_time,
            "development_end_time": job.development_end_time,
            "holdout_start_time": job.holdout_start_time,
            "bars_seen": next_bar,
            "warmup_bars": job.warmup_bars,
            "evaluated_bars": max(0, next_bar - job.warmup_bars),
        },
        "counters": deepcopy(counters),
        "derived": {
            "intents_evaluated": sum(intents.values()),
            "suppressed_buy": signals["buy"] - intents["buy"] - counters["warmup_intents"]["buy"],
            "suppressed_buy_evaluated": signals["buy_evaluated"] - intents["buy"],
            "non_losing_episodes": counters["episodes"]["closed"] - counters["episodes"]["losing"],
        },
        "guards": {
            "kill_switch": paper.risk_policy.kill_switch,
            "loss_streak_final": paper.loss_streak,
            "pause": guards.report(),
        },
        "account": {
            "cash": _fixed(paper.cash),
            "position_quantity": _fixed(paper.quantity),
            "position_cost": _fixed(paper.cost),
            "open_allocations": len(paper.positions),
        },
        "samples": deepcopy(samples),
        "admission": {
            "development_only": True,
            "evaluator_admission": False,
            "holdout_accessed": False,
            "orders_executed": False,
            "execution_model_parity": "V1_ONLY",
        },
        "limitations": [
            "V1_ONLY",
            "DEVELOPMENT_ONLY",
            "EVALUATOR_ADMISSION_FALSE",
            "DIAGNOSTIC_ONLY",
            "SIZING_ADJUSTED_INCLUDES_QUANTITY_STEP_ROUNDING",
        ],
    }


def _evaluate(request, should_stop, deadline_monotonic, trace):
    if should_stop is not None and not callable(should_stop):
        _bad()
    if deadline_monotonic is not None and (
        isinstance(deadline_monotonic, bool) or not isinstance(deadline_monotonic, (int, float))
    ):
        _bad()
    request = _exact(request, ("version", "contract", "rows", "checkpoint"))
    if request["version"] != PF2_REPLAY_VERSION:
        _bad()
    job = _parse_contract(request["contract"])
    rows, checkpoint = request["rows"], request["checkpoint"]
    if isinstance(rows, list):
        _check_boundary(rows, job)  # Before checkpoint or row work of any kind.
    next_bar = 0 if checkpoint is None else _open_checkpoint(checkpoint, job)
    parsed = _parse_rows(rows, next_bar, job)
    source = _make_source(job)
    paper = _build_paper(job)
    if checkpoint is None:
        paper.loss_streak = job.initial_loss_streak
        counters, guards, samples = _fresh_counters(), Guards(), _fresh_samples()
    else:
        counters, guards, samples = _restore(checkpoint, job, source, paper, next_bar)
    local_trace = [] if trace is not None else None
    try:
        _run_bars(
            parsed, next_bar, job, source, paper, counters, guards, samples, local_trace,
            (should_stop, deadline_monotonic),
        )
        next_bar += len(parsed)
        _check_progress(
            counters, samples, guards, job, paper, next_bar, paper.replay.last_time
        )
    except PF2Error:
        raise
    except Exception:
        _bad("PF2_EVALUATION_FAILED")
    state = {
        "version": PF2_REPLAY_VERSION,
        "identity": job.identity,
        "next_bar": next_bar,
        "last_time": paper.replay.last_time,
        "evaluator": source.export_state(),
        "paper": paper.export_state(),
        "counters": counters,
        "guards": guards.export(),
        "samples": samples,
    }
    state["integrity"] = digest(state)
    if len(canonical(state)) > min(STATE_LIMIT, job.max_state_bytes):
        _bad("PF2_LIMIT_EXCEEDED")
    result = None
    if next_bar == job.total_bars:
        result = _result(job, next_bar, paper, counters, guards, samples)
        if len(canonical(result)) > job.max_output_bytes:
            _bad("PF2_LIMIT_EXCEEDED")
    if trace is not None:
        trace.extend(local_trace)
    return {"checkpoint": state, "result": result}


def evaluate_pf2_chunk(request, *, should_stop=None, deadline_monotonic=None, trace=None):
    """Advance one chunk of consecutive closed bars; atomic (raise = no checkpoint).

    `should_stop()` and `deadline_monotonic` (absolute `time.monotonic()` value) are
    checked before the first bar and every CANCEL_CHECK_BARS bars. On PF2_CANCELLED or
    PF2_DEADLINE_EXCEEDED the previous checkpoint stays valid and nothing is emitted.
    `trace` is an in-process sink (never available through IPC), extended on success.
    """
    try:
        return _evaluate(request, should_stop, deadline_monotonic, trace)
    except PF2Error:
        raise
    except Exception:  # Any other failure: one code, no message, no chained cause.
        raise PF2Error("PF2_EVALUATION_FAILED") from None


def _no_duplicate_keys(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("DUPLICATE_KEY")
        result[key] = value
    return result


def _reject_constant(_name):
    raise ValueError("NON_FINITE_JSON")


def _emit_error(code):
    sys.stdout.buffer.write(canonical({"error": code}) + b"\n")
    sys.stdout.buffer.flush()
    raise SystemExit(1)


_TERMINAL_PROTOCOL = "quant-io-terminal-v1"
_TERMINAL_ACK = b"QUANT_IO_TERMINAL_ACK_V1\n"
_READINESS_NAMES = (
    "QUANT_IO_READY_FILE",
    "QUANT_IO_READY_DEVICE",
    "QUANT_IO_READY_RBPS",
    "QUANT_IO_READY_WBPS",
)


def _fail(code, sent):
    """One error line before the result line went out; nothing but exit 1 after it."""
    if sent:
        raise SystemExit(1) from None
    _emit_error(code)


def _read_protocol_request():
    """Prime the I/O telemetry, then read exactly one newline-terminated request line."""
    if not all(os.environ.get(name) for name in _READINESS_NAMES):
        _bad()
    prepare_io_telemetry()  # Import only: research_chunk owns the readiness proof.
    raw = sys.stdin.buffer.readline(IPC_LIMIT + 2)
    if len(raw) > IPC_LIMIT + 1:
        _bad("PF2_LIMIT_EXCEEDED")
    if not raw.endswith(b"\n") or len(raw) == 1:
        _bad()
    return raw


def _require_terminal_ack():
    """The parent writes the ACK line and closes stdin. Anything else is a failure."""
    if sys.stdin.buffer.readline(64) != _TERMINAL_ACK or sys.stdin.buffer.read(1) != b"":
        _bad()


def main():
    """Chunk entry point: one JSON request on stdin, one canonical JSON line on stdout.

    Without QUANT_IO_TERMINAL_PROTOCOL this is the local-runner path: read stdin to EOF,
    write the line, exit. With it (supervised runtime) the request is one newline-terminated
    line, the result line is written and flushed once, and the parent must then answer with
    exactly the ACK line and close stdin. No second stdout line follows the result line.
    """
    sent = False
    try:
        protocol = os.environ.get("QUANT_IO_TERMINAL_PROTOCOL")
        if protocol is None:
            raw = sys.stdin.buffer.read(IPC_LIMIT + 1)
            if len(raw) > IPC_LIMIT:
                _bad("PF2_LIMIT_EXCEEDED")
        else:
            if protocol != _TERMINAL_PROTOCOL:
                _bad()
            raw = _read_protocol_request()
        request = json.loads(
            raw, object_pairs_hook=_no_duplicate_keys, parse_constant=_reject_constant
        )
        encoded = canonical(evaluate_pf2_chunk(request))
        if len(encoded) > IPC_LIMIT:
            _bad("PF2_LIMIT_EXCEEDED")
        sent = protocol is not None  # Set before the first byte: no error line may follow it.
        sys.stdout.buffer.write(encoded + b"\n")
        sys.stdout.buffer.flush()
        if sent:
            _require_terminal_ack()
    except PF2Error as error:
        _fail(error.code, sent)
    except (ValueError, TypeError, KeyError, AttributeError, ArithmeticError, RecursionError):
        _fail("PF2_REQUEST_INVALID", sent)
    except Exception:  # Never leak a traceback that could carry request content.
        _fail("PF2_EVALUATION_FAILED", sent)


if __name__ == "__main__":
    main()
