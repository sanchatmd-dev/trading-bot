"""Experimental closed-bar SPT Spot EXIT v1; not registered for runtime research.

Forked from the frozen Custom evaluator to preserve historical reproducibility.
Only the native EXIT rule changes. Existing signal registration still resets
shared cooldown/setup state, so subsequent BUY timing may differ. Callers must
bind the private Pine artifact and the 58 effective Custom inputs before use.
"""

import math
from typing import Any

from robot_quant.spt_custom_evaluator import CustomEvaluatedBar, CustomSignalInputs
from robot_quant.spt_evaluator import SignalBar, SptEvaluator

PROFILE = "spt-spot-exit-v1-draft"


class SptSpotExitV1Evaluator(SptEvaluator):
    def __init__(self, inputs: CustomSignalInputs):
        super().__init__()
        self.inputs = inputs
        self.exit_invalidation = False

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
        confirm_long = _legacy_confirm_exit = False
        if prev is not None:
            po, ph, pl, pc, _ = prev
            confirm_long = (
                (close > self.fast and pc <= previous_fast)
                or close > max(self.highs)
                or (close > open_ and pc < po and close >= po and open_ <= pc)
                or (close > open_ and close > ph)
            )
            _legacy_confirm_exit = (
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
        _legacy_exit_risk = (
            self.atr is not None
            and self.exit_zone is not None
            and (self.exit_zone + self.atr * p.sl_atr_buffer) - close > self.atr * p.min_risk_atr
        )
        raw_buy = bool(cooldown and self.long_active and long_bias and confirm_long and long_risk)
        # Only completed bars may be supplied. Match Pine's confirmed rising edge.
        invalidation = self.st is not None and self.direction > 0 and close < self.fast
        raw_exit = invalidation and not self.exit_invalidation
        self.exit_invalidation = invalidation
        buy, native_exit = raw_buy and not raw_exit, raw_exit
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


def evaluate_bars(rows: list[dict[str, Any]], inputs: CustomSignalInputs) -> list[CustomEvaluatedBar]:
    """Cold-start each variant; Bridge ATR(14) stays independent of source ATR."""
    evaluator = SptSpotExitV1Evaluator(inputs)
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
