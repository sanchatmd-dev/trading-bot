"""Parameter-aware SPT Spot Custom signal evaluator, pending TradingView parity.

This is a source-specific research candidate. It does not certify a changed
input snapshot, arbitrary Pine, or a customer Quant capability by itself.
"""

import hashlib
import math
from dataclasses import dataclass
from decimal import Decimal
from typing import Any

from robot_quant.bridge_replay import BridgeBar
from robot_quant.spt_evaluator import REQUIRED_SETTINGS, SOURCE_HASH, SignalBar, SptEvaluator

# All ten numeric inputs that can affect this narrow Spot/Custom signal profile.
# A user may select at most eight distinct names. Every unselected value stays fixed.
CATALOG = {
    "emaFastInput": ("ema_fast", int, 1, 500),
    "emaSlowInput": ("ema_slow", int, 1, 1000),
    "atrLenInput": ("atr_len", int, 1, 500),
    "stFactorInput": ("st_factor", float, 0.1, 100.0),
    "zoneAtrMultInput": ("zone_atr_mult", float, 0.1, 100.0),
    "setupExpiryInput": ("setup_expiry", int, 1, 100),
    "cooldownInput": ("cooldown", int, 0, 100),
    "confirmLookback": ("confirm_lookback", int, 2, 50),
    "slAtrBufferInput": ("sl_atr_buffer", float, 0.0, 100.0),
    "minRiskATRInput": ("min_risk_atr", float, 0.05, 100.0),
}


@dataclass(frozen=True)
class CustomSignalInputs:
    ema_fast: int = 50
    ema_slow: int = 200
    atr_len: int = 14
    st_factor: float = 3.2
    zone_atr_mult: float = 1.15
    setup_expiry: int = 48
    cooldown: int = 8
    confirm_lookback: int = 5
    sl_atr_buffer: float = 0.60
    min_risk_atr: float = 0.50

    def __post_init__(self):
        for name, (field, kind, minimum, maximum) in CATALOG.items():
            value = getattr(self, field)
            if isinstance(value, bool) or not isinstance(value, (int, float)) or (kind is int and not isinstance(value, int)):
                raise ValueError("INVALID_CUSTOM_INPUT_TYPE:" + name)
            if not minimum <= value <= maximum or (isinstance(value, float) and not math.isfinite(value)):
                raise ValueError("UNSUPPORTED_CUSTOM_INPUT_BOUND:" + name)
        if self.ema_fast >= self.ema_slow:
            raise ValueError("EMA_FAST_MUST_BE_BELOW_SLOW")

    @classmethod
    def from_source_values(cls, values: dict) -> "CustomSignalInputs":
        if set(values) != set(CATALOG):
            raise ValueError("INCOMPLETE_CUSTOM_SIGNAL_INPUTS")
        return cls(**{field: values[name] for name, (field, _, _, _) in CATALOG.items()})

    def candidate(self, selected: list[str], changes: dict[str, int | float]) -> "CustomSignalInputs":
        """Change only the owner's distinct, selected source slots."""
        if len(selected) > 8 or len(set(selected)) != len(selected) or not set(selected) <= set(CATALOG):
            raise ValueError("INVALID_SELECTED_CUSTOM_SLOTS")
        if not set(changes) <= set(selected):
            raise ValueError("CANDIDATE_CHANGES_FIXED_INPUT")
        values = {name: getattr(self, field) for name, (field, _, _, _) in CATALOG.items()}
        values.update(changes)
        return self.from_source_values(values)


def validate_custom_snapshot(source: bytes, snapshot: dict) -> tuple[CustomSignalInputs, list[str]]:
    """Bind selected slots 1:1; never infer eligibility from raw Pine defaults."""
    if hashlib.sha256(source).hexdigest() != SOURCE_HASH or snapshot.get("source_hash") != SOURCE_HASH:
        raise ValueError("UNSUPPORTED_SOURCE_HASH")
    market = snapshot.get("market", {})
    if any(market.get(key) != value for key, value in {
        "broker": "binance-global", "symbol": "BTCUSDT", "timeframe": "1"
    }.items()):
        raise ValueError("UNSUPPORTED_CUSTOM_MARKET")
    selection = snapshot["selection"]
    bindings, fixed = selection["bindings"], selection["fixed_inputs"]
    if len(bindings) > 8 or len(bindings) + len(fixed) != 58:
        raise ValueError("UNSUPPORTED_CUSTOM_SLOT_COUNT")
    inputs = fixed + bindings
    ids = [row["input_id"] for row in inputs]
    names = [row["pine_variable"] for row in inputs]
    if len(set(ids)) != 58 or len(set(names)) != 58:
        raise ValueError("DUPLICATE_CUSTOM_INPUT_IDENTITY")
    membership = next((row for row in snapshot.get("membership", []) if row.get("source_hash") == SOURCE_HASH), None)
    if membership is None:
        raise ValueError("MISSING_SOURCE_MEMBERSHIP")
    source_inputs = membership["analysis"]["inputs"]
    review = membership["analysis"].get("effective_input_review")
    if (
        not review
        or review.get("source_hash") != SOURCE_HASH
        or review.get("effective_inputs_hash") != membership["analysis"].get("effective_inputs_hash")
        or review.get("input_count") != 58
        or not review.get("reviewed_by")
        or not isinstance(review.get("reviewed_at"), int)
    ):
        raise ValueError("CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED")
    source_identity = {(row["input_id"], row["pine_variable"]) for row in source_inputs}
    if len(source_identity) != 58 or {(row["input_id"], row["pine_variable"]) for row in inputs} != source_identity:
        raise ValueError("SOURCE_INPUT_IDENTITY_MISMATCH")
    source_by_id = {row["input_id"]: row for row in source_inputs}
    for row in inputs:
        reviewed_value = source_by_id[row["input_id"]]["effective_value"]
        if type(row["effective_value"]) is not type(reviewed_value) or row["effective_value"] != reviewed_value:
            raise ValueError("CUSTOM_EFFECTIVE_INPUT_CHANGED")
    selected = []
    for binding in bindings:
        name = binding["pine_variable"]
        if name not in CATALOG or binding.get("origin") != "source":
            raise ValueError("UNSUPPORTED_CUSTOM_BINDING:" + name)
        if binding.get("slot") not in range(3, 11) or not binding.get("search_domain"):
            raise ValueError("INVALID_CUSTOM_SLOT_DOMAIN")
        selected.append(name)
    if len(set(selected)) != len(selected) or len({row["slot"] for row in bindings}) != len(bindings):
        raise ValueError("DUPLICATE_CUSTOM_BINDING")
    values = {row["pine_variable"]: row["effective_value"] for row in inputs}
    expected = {**REQUIRED_SETTINGS, "preset": "Custom"}
    del expected["confirmLookback"]  # This is a selectable signal dimension.
    for name, value in expected.items():
        if type(values.get(name)) is not type(value) or values[name] != value:
            raise ValueError("UNSUPPORTED_CUSTOM_SETTING:" + name)
    if selection["signals"] != {"buy": "buySignal", "exit": "sellSignal", "timing": "bar_close"}:
        raise ValueError("UNSUPPORTED_SIGNAL_MAPPING")
    custom = CustomSignalInputs.from_source_values({name: values[name] for name in CATALOG})
    for binding in bindings:
        value, domain = binding["effective_value"], binding["search_domain"]
        _, kind, supported_min, supported_max = CATALOG[binding["pine_variable"]]
        if any(isinstance(domain[key], bool) or not isinstance(domain[key], (int, float)) or not -1e12 <= domain[key] <= 1e12 or (isinstance(domain[key], float) and not math.isfinite(domain[key])) for key in ("min", "max", "step")):
            raise ValueError("INVALID_CUSTOM_SEARCH_DOMAIN")
        if kind is int and any(not isinstance(domain[key], int) for key in ("min", "max", "step")):
            raise ValueError("INVALID_CUSTOM_SEARCH_DOMAIN")
        declared = source_by_id[binding["input_id"]]["declared_domain"]
        if (
            not supported_min <= domain["min"] <= value <= domain["max"] <= supported_max
            or domain["step"] <= 0
            or (declared["min"] is not None and domain["min"] < declared["min"])
            or (declared["max"] is not None and domain["max"] > declared["max"])
        ):
            raise ValueError("INVALID_CUSTOM_SEARCH_DOMAIN")
    return custom, selected


@dataclass(frozen=True)
class CustomOptimizationPlan:
    baseline: CustomSignalInputs
    domains: dict[str, tuple[int | float, int | float, int | float]]

    @classmethod
    def from_snapshot(cls, source: bytes, snapshot: dict) -> "CustomOptimizationPlan":
        baseline, selected = validate_custom_snapshot(source, snapshot)
        domains = {
            row["pine_variable"]: tuple(row["search_domain"][key] for key in ("min", "max", "step"))
            for row in snapshot["selection"]["bindings"]
            if row["pine_variable"] in selected
        }
        return cls(baseline, domains)

    def candidate(self, changes: dict[str, int | float]) -> CustomSignalInputs:
        result = self.baseline.candidate(list(self.domains), changes)
        for name, value in changes.items():
            low, high, step = self.domains[name]
            if value < low or value > high or (Decimal(str(value)) - Decimal(str(low))) % Decimal(str(step)) != 0:
                raise ValueError("CANDIDATE_OUTSIDE_SEARCH_GRID:" + name)
        return result


@dataclass(frozen=True)
class CustomEvaluatedBar:
    time: int
    buy: bool
    native_exit: bool
    source_atr: float | None
    bridge_atr14: float | None


def evaluate_bars(rows: list[dict[str, Any]], inputs: CustomSignalInputs) -> list[CustomEvaluatedBar]:
    """Cold-start each variant; Bridge ATR(14) stays independent of source ATR."""
    evaluator = SptCustomEvaluator(inputs)
    result: list[CustomEvaluatedBar] = []
    bridge_atr = None
    bridge_seed: list[float] = []
    previous_close = None
    for row in rows:
        open_, high, low, close = (float(row[key]) for key in ("open", "high", "low", "close"))
        signal = evaluator.step(open_, high, low, close)
        tr = high - low if previous_close is None else max(high - low, abs(high - previous_close), abs(low - previous_close))
        if bridge_atr is None:
            bridge_seed.append(tr)
            if len(bridge_seed) == 14:
                bridge_atr = sum(bridge_seed) / 14
        else:
            bridge_atr = tr / 14 + (1 - 1 / 14) * bridge_atr
        result.append(CustomEvaluatedBar(row["time"], signal.buy, signal.native_exit, signal.atr, bridge_atr))
        previous_close = close
    return result


def bridge_bars(rows: list[dict[str, Any]], evaluated: list[CustomEvaluatedBar]) -> list[tuple[BridgeBar, bool, bool]]:
    """Feed a varied source signal and the independent ATR(14) into Paper replay."""
    if len(rows) != len(evaluated):
        raise ValueError("CUSTOM_EVALUATION_LENGTH_MISMATCH")
    result = []
    for row, signal in zip(rows, evaluated, strict=True):
        if row["time"] != signal.time:
            raise ValueError("CUSTOM_EVALUATION_TIME_MISMATCH")
        bar = BridgeBar(
            signal.time,
            *(Decimal(str(row[key])) for key in ("open", "high", "low", "close", "volume")),
            Decimal(str(signal.bridge_atr14)) if signal.bridge_atr14 is not None else None,
        )
        result.append((bar, signal.buy, signal.native_exit))
    return result


class SptCustomEvaluator(SptEvaluator):
    def __init__(self, inputs: CustomSignalInputs):
        super().__init__()
        self.inputs = inputs

    def step(self, open_: float, high: float, low: float, close: float) -> SignalBar:
        if (
            any(not math.isfinite(v) for v in [open_, high, low, close])
            or not 0 < low <= min(open_, close) <= max(open_, close) <= high
        ):
            raise ValueError("INVALID_OHLC")
        p = self.inputs
        self.index += 1
        i, prev = self.index, self.previous
        previous_fast = self.fast
        self.fast = close if self.fast is None else (2 / (p.ema_fast + 1)) * close + (1 - 2 / (p.ema_fast + 1)) * self.fast
        self.slow = close if self.slow is None else (2 / (p.ema_slow + 1)) * close + (1 - 2 / (p.ema_slow + 1)) * self.slow
        tr = high - low if prev is None else max(high - low, abs(high - prev[3]), abs(low - prev[3]))
        previous_atr = self.atr
        if self.atr is None:
            self.tr_seed.append(tr)
            if len(self.tr_seed) == p.atr_len:
                self.atr = sum(self.tr_seed) / p.atr_len
        else:
            self.atr = (1 / p.atr_len) * tr + (1 - 1 / p.atr_len) * self.atr
        if self.atr is not None:
            lower, upper = (high + low) / 2 - p.st_factor * self.atr, (high + low) / 2 + p.st_factor * self.atr
            prev_lower, prev_upper = self.lower or 0.0, self.upper or 0.0
            lower = lower if lower > prev_lower or (prev is not None and prev[3] < prev_lower) else prev_lower
            upper = upper if upper < prev_upper or (prev is not None and prev[3] > prev_upper) else prev_upper
            if previous_atr is None:
                self.direction = 1
            elif self.st == prev_upper:
                self.direction = -1 if close > upper else 1
            else:
                self.direction = 1 if close < lower else -1
            self.lower, self.upper = lower, upper
            self.st = lower if self.direction == -1 else upper
        long_bias = self.st is not None and self.direction < 0 and close > self.fast > self.slow
        exit_bias = self.st is not None and self.direction > 0 and close < self.fast < self.slow
        if self.atr is not None:
            buy_low, buy_high = self.st, self.st + self.atr * p.zone_atr_mult
            sell_low, sell_high = self.st - self.atr * p.zone_atr_mult, self.st
            if long_bias and low <= buy_high and high >= buy_low:
                self.long_active, self.exit_active = True, False
                self.long_expiry, self.long_zone = i + p.setup_expiry, buy_low
            if exit_bias and low <= sell_high and high >= sell_low:
                self.exit_active, self.long_active = True, False
                self.exit_expiry, self.exit_zone = i + p.setup_expiry, sell_high
        if self.long_active and i > self.long_expiry:
            self.long_active = False
        if self.exit_active and i > self.exit_expiry:
            self.exit_active = False
        confirm_long = confirm_exit = False
        if prev is not None:
            po, ph, pl, pc, _ = prev
            confirm_long = (
                (close > self.fast and pc <= previous_fast)
                or close > max(self.highs)
                or (close > open_ and pc < po and close >= po and open_ <= pc)
                or (close > open_ and close > ph)
            )
            confirm_exit = (
                (close < self.fast and pc >= previous_fast)
                or close < min(self.lows)
                or (close < open_ and pc > po and close <= po and open_ >= pc)
                or (close < open_ and close < pl)
            )
        cooldown = self.trade_start is None or i - self.trade_start > p.cooldown
        long_risk = (
            self.atr is not None
            and self.long_zone is not None
            and close - (self.long_zone - self.atr * p.sl_atr_buffer) > self.atr * p.min_risk_atr
        )
        exit_risk = (
            self.atr is not None
            and self.exit_zone is not None
            and (self.exit_zone + self.atr * p.sl_atr_buffer) - close > self.atr * p.min_risk_atr
        )
        raw_buy = bool(cooldown and self.long_active and long_bias and confirm_long and long_risk)
        raw_exit = bool(cooldown and self.exit_active and exit_bias and confirm_exit and exit_risk)
        buy, native_exit = raw_buy and not raw_exit, raw_exit and not raw_buy
        if buy or native_exit:
            self.trade_start = i
            self.long_active = self.exit_active = False
        self.highs.append(high)
        self.highs = self.highs[-p.confirm_lookback:]
        self.lows.append(low)
        self.lows = self.lows[-p.confirm_lookback:]
        self.previous = open_, high, low, close, self.fast
        return SignalBar(
            buy, native_exit, self.fast, self.slow, self.atr, self.st,
            self.direction, self.long_active, self.exit_active
        )
