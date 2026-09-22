"""Reference strategy implementation: synthetic-ema-v1.

Calculates technical indicators (EMA Fast, EMA Slow, ATR), generates bar-close
signals, enforces warm-up periods, and determines next-opportunity execution
with conservative same-bar Stop Loss resolution.
"""

from dataclasses import dataclass
from decimal import Decimal
from typing import Any, Literal

import pandas as pd

from robot_quant.market_data import Candle, candles_to_dataframe


@dataclass(frozen=True)
class StrategySignal:
    bar_index: int
    timestamp: int
    event: Literal["BUY", "SELL", "SL"]
    price: Decimal
    stop_loss: Decimal | None = None
    take_profit: Decimal | None = None
    comment: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "bar_index": self.bar_index,
            "timestamp": self.timestamp,
            "event": self.event,
            "price": str(self.price),
            "stop_loss": str(self.stop_loss) if self.stop_loss is not None else None,
            "take_profit": str(self.take_profit) if self.take_profit is not None else None,
            "comment": self.comment,
        }


def calculate_ema(series: pd.Series, period: int) -> pd.Series:
    """Calculate Exponential Moving Average using standard ewm."""
    return series.ewm(span=period, adjust=False).mean()


def calculate_atr(high: pd.Series, low: pd.Series, close: pd.Series, period: int) -> pd.Series:
    """Calculate Average True Range (Wilder's ATR)."""
    prev_close = close.shift(1)
    tr1 = high - low
    tr2 = (high - prev_close).abs()
    tr3 = (low - prev_close).abs()
    tr = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1)
    # Wilder's smoothing corresponds to alpha = 1 / period or span = 2*period - 1
    atr = tr.ewm(alpha=1.0 / period, adjust=False).mean()
    return atr


@dataclass(frozen=True)
class SyntheticEmaParameters:
    ema_fast: int = 10
    ema_slow: int = 30
    atr_period: int = 14
    atr_multiplier: Decimal = Decimal("2.0")

    def __post_init__(self):
        if self.ema_fast >= self.ema_slow:
            raise ValueError(
                f"ema_fast ({self.ema_fast}) must be strictly less than ema_slow ({self.ema_slow})"
            )
        if self.ema_fast < 1 or self.ema_slow < 1 or self.atr_period < 1:
            raise ValueError("Indicator periods must be positive integers")
        if self.atr_multiplier <= Decimal("0"):
            raise ValueError("atr_multiplier must be positive")


class SyntheticEmaStrategy:
    """Reference implementation of the synthetic-ema-v1 template.

    Rules:
    1. Fast EMA crosses above Slow EMA at bar close -> BUY signal for next bar open.
    2. Fast EMA crosses below Slow EMA at bar close -> SELL signal for next bar open.
    3. Trailing/Fixed ATR Stop Loss: entry_price - atr_multiplier * ATR.
       If intrabar Low <= Stop Loss during holding -> SL exit triggered immediately.
    4. Conservative ambiguity: If both Stop Loss and crossover exit occur in same bar,
       Stop Loss takes strict precedence.
    5. Warm-up: First max(ema_slow, atr_period) bars produce no signals.
    """

    def __init__(self, params: SyntheticEmaParameters | None = None):
        self.params = params or SyntheticEmaParameters()

    def generate_indicators(self, df: pd.DataFrame) -> pd.DataFrame:
        """Calculate indicator series on the provided OHLCV dataframe."""
        res = df.copy()
        res["ema_fast"] = calculate_ema(res["close"], self.params.ema_fast)
        res["ema_slow"] = calculate_ema(res["close"], self.params.ema_slow)
        res["atr"] = calculate_atr(res["high"], res["low"], res["close"], self.params.atr_period)
        return res

    def evaluate_signals(self, candles: list[Candle]) -> list[StrategySignal]:
        """Evaluate signals bar-by-bar to ensure strictly causal, non-lookahead generation."""
        if not candles:
            return []

        df = candles_to_dataframe(candles)
        ind_df = self.generate_indicators(df)

        warmup_period = max(self.params.ema_slow, self.params.atr_period)
        signals: list[StrategySignal] = []

        in_position = False
        current_sl: Decimal = Decimal("0")

        n_bars = len(candles)
        ema_fast_vals = ind_df["ema_fast"].to_numpy()
        ema_slow_vals = ind_df["ema_slow"].to_numpy()
        atr_vals = ind_df["atr"].to_numpy()

        for i in range(1, n_bars):
            c = candles[i]

            # 1. Intrabar Stop Loss check for open position
            if in_position:
                # Conservative check: Did bar low breach the Stop Loss?
                if c.low <= current_sl:
                    # Intrabar gap down check: If open gapped below SL, fill at open;
                    # otherwise fill at SL
                    sl_fill = min(current_sl, c.open)
                    signals.append(
                        StrategySignal(
                            bar_index=i,
                            timestamp=c.timestamp,
                            event="SL",
                            price=sl_fill,
                            comment=f"Stop loss triggered at {sl_fill}",
                        )
                    )
                    in_position = False
                    # Bar closed after SL hit; cannot open new position on same bar close
                    continue

            # 2. Warmup check
            if i < warmup_period:
                continue

            # 3. Bar-close crossover check on bar i
            curr_fast = ema_fast_vals[i]
            curr_slow = ema_slow_vals[i]
            prev_fast = ema_fast_vals[i - 1]
            prev_slow = ema_slow_vals[i - 1]

            bullish_cross = (curr_fast > curr_slow) and (prev_fast <= prev_slow)
            bearish_cross = (curr_fast < curr_slow) and (prev_fast >= prev_slow)

            if bullish_cross and not in_position:
                # Compute ATR-based stop loss at bar-close
                bar_atr = Decimal(str(round(atr_vals[i], 4)))
                sl_dist = bar_atr * self.params.atr_multiplier
                calculated_sl = max(Decimal("0.01"), c.close - sl_dist)

                signals.append(
                    StrategySignal(
                        bar_index=i,
                        timestamp=c.timestamp,
                        event="BUY",
                        price=c.close,
                        stop_loss=calculated_sl,
                        comment=(
                            f"Bullish EMA crossover: fast={curr_fast:.2f} > slow={curr_slow:.2f}"
                        ),
                    )
                )
                in_position = True
                current_sl = calculated_sl

            elif bearish_cross and in_position:
                signals.append(
                    StrategySignal(
                        bar_index=i,
                        timestamp=c.timestamp,
                        event="SELL",
                        price=c.close,
                        comment=(
                            f"Bearish EMA crossunder: fast={curr_fast:.2f} < slow={curr_slow:.2f}"
                        ),
                    )
                )
                in_position = False

        return signals
