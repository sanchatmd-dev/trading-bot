"""Hash-bound SPT Spot v4 signal evaluator candidate; no arbitrary Pine eval.

The narrow profile uses fixed Daily/Swing settings, chart timeframe 1m, HTF,
RSI, session, BOS and sweep disabled, and Zone + ATR source stops. Other
settings fail closed. Drawings/dashboard do not feed signals; setup state and
the visual signal registration's tradeStartBar do, and are retained below.
"""

import hashlib
import math
from dataclasses import dataclass

SOURCE_HASH = "0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a"
PROFILE = "spt-spot-v4-daily-1m-htf-off-candidate-v1"
REQUIRED_SETTINGS = {
    "preset": "Daily/Swing",
    "tradeDirectionectionection": "Long + Exit",
    "useSlowFilter": True,
    "useMTF": False,
    "useRSIFilter": False,
    "requireBOS": False,
    "requireSweep": False,
    "slMode": "Zone + ATR",
    "useSession": False,
    "confirmMode": "Any",
    "confirmLookback": 5,
    "notifyEnabled": False,
}


@dataclass(frozen=True)
class SignalBar:
    buy: bool
    native_exit: bool
    ema_fast: float
    ema_slow: float
    atr: float | None
    supertrend: float | None
    direction: int
    long_setup: bool
    exit_setup: bool


def verify_profile(source: bytes, snapshot: dict) -> dict:
    if hashlib.sha256(source).hexdigest() != SOURCE_HASH or snapshot["source_hash"] != SOURCE_HASH:
        raise ValueError("UNSUPPORTED_SOURCE_HASH")
    if (
        snapshot["market"]["timeframe"] != "1"
        or snapshot["market"]["broker"] != "binance-global"
        or snapshot["market"]["symbol"] != "BTCUSDT"
    ):
        raise ValueError("UNSUPPORTED_EVALUATOR_MARKET")
    inputs = snapshot["selection"]["fixed_inputs"]
    if snapshot["selection"]["bindings"] or len(inputs) != 58:
        raise ValueError("UNSUPPORTED_EVALUATOR_INPUT_BINDINGS")
    values = {i["pine_variable"]: i["effective_value"] for i in inputs}
    if len(values) != len(inputs):
        raise ValueError("DUPLICATE_INPUT_IDENTITY")
    for name, expected in REQUIRED_SETTINGS.items():
        if type(values.get(name)) is not type(expected) or values[name] != expected:
            raise ValueError("UNSUPPORTED_EFFECTIVE_INPUT:" + name)
    if snapshot["selection"]["signals"] != {
        "buy": "buySignal",
        "exit": "sellSignal",
        "timing": "bar_close",
    }:
        raise ValueError("UNSUPPORTED_SIGNAL_MAPPING")
    return values


class SptEvaluator:
    """Causal cold-start replay. Initialization provenance is audited separately."""

    def __init__(self):
        self.index = -1
        self.fast = self.slow = None
        self.atr = None
        self.tr_seed: list[float] = []
        self.lower = self.upper = self.st = None
        self.direction = 1
        self.previous: tuple[float, float, float, float, float] | None = None
        self.highs: list[float] = []
        self.lows: list[float] = []
        self.long_active = self.exit_active = False
        self.long_expiry = self.exit_expiry = -1
        self.long_zone = self.exit_zone = None
        self.trade_start: int | None = None

    def step(self, open_: float, high: float, low: float, close: float) -> SignalBar:
        if (
            any(not math.isfinite(v) for v in [open_, high, low, close])
            or not 0 < low <= min(open_, close) <= max(open_, close) <= high
        ):
            raise ValueError("INVALID_OHLC")
        self.index += 1
        i, prev = self.index, self.previous
        previous_fast = self.fast
        self.fast = close if self.fast is None else (2 / 51) * close + (1 - 2 / 51) * self.fast
        self.slow = close if self.slow is None else (2 / 201) * close + (1 - 2 / 201) * self.slow
        tr = (
            high - low if prev is None else max(high - low, abs(high - prev[3]), abs(low - prev[3]))
        )
        previous_atr = self.atr
        if self.atr is None:
            self.tr_seed.append(tr)
            if len(self.tr_seed) == 14:
                self.atr = sum(self.tr_seed) / 14
        else:
            self.atr = (1 / 14) * tr + (1 - 1 / 14) * self.atr
        if self.atr is not None:
            lower, upper = (high + low) / 2 - 3.2 * self.atr, (high + low) / 2 + 3.2 * self.atr
            prev_lower, prev_upper = self.lower or 0.0, self.upper or 0.0
            lower = (
                lower
                if lower > prev_lower or (prev is not None and prev[3] < prev_lower)
                else prev_lower
            )
            upper = (
                upper
                if upper < prev_upper or (prev is not None and prev[3] > prev_upper)
                else prev_upper
            )
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
            buy_low, buy_high = self.st, self.st + self.atr * 1.15
            sell_low, sell_high = self.st - self.atr * 1.15, self.st
            if long_bias and low <= buy_high and high >= buy_low:
                self.long_active, self.exit_active = True, False
                self.long_expiry, self.long_zone = i + 48, buy_low
            if exit_bias and low <= sell_high and high >= sell_low:
                self.exit_active, self.long_active = True, False
                self.exit_expiry, self.exit_zone = i + 48, sell_high
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
        cooldown = self.trade_start is None or i - self.trade_start > 8
        long_risk = (
            self.atr is not None
            and self.long_zone is not None
            and close - (self.long_zone - self.atr * 0.60) > self.atr * 0.50
        )
        exit_risk = (
            self.atr is not None
            and self.exit_zone is not None
            and (self.exit_zone + self.atr * 0.60) - close > self.atr * 0.50
        )
        raw_buy = bool(cooldown and self.long_active and long_bias and confirm_long and long_risk)
        raw_exit = bool(cooldown and self.exit_active and exit_bias and confirm_exit and exit_risk)
        buy, native_exit = raw_buy and not raw_exit, raw_exit and not raw_buy
        if buy or native_exit:
            self.trade_start = i
            self.long_active = self.exit_active = False
        self.highs.append(high)
        self.highs = self.highs[-5:]
        self.lows.append(low)
        self.lows = self.lows[-5:]
        self.previous = open_, high, low, close, self.fast
        return SignalBar(
            buy,
            native_exit,
            self.fast,
            self.slow,
            self.atr,
            self.st,
            self.direction,
            self.long_active,
            self.exit_active,
        )
