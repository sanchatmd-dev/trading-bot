"""Tests for reference strategy implementation (synthetic-ema-v1)."""

from decimal import Decimal

import pytest

from robot_quant.market_data import generate_synthetic_ohlcv
from robot_quant.strategy import (
    SyntheticEmaParameters,
    SyntheticEmaStrategy,
)


def test_parameter_bounds_validation():
    # Valid
    p = SyntheticEmaParameters(
        ema_fast=10, ema_slow=30, atr_period=14, atr_multiplier=Decimal("2.0")
    )
    assert p.ema_fast == 10

    # Invalid: fast >= slow
    with pytest.raises(ValueError, match="must be strictly less than"):
        SyntheticEmaParameters(ema_fast=30, ema_slow=20)

    # Invalid: non-positive periods
    with pytest.raises(ValueError, match="positive integers"):
        SyntheticEmaParameters(ema_fast=0, ema_slow=30)

    # Invalid: non-positive multiplier
    with pytest.raises(ValueError, match="atr_multiplier must be positive"):
        SyntheticEmaParameters(ema_fast=10, ema_slow=30, atr_multiplier=Decimal("0"))


def test_strategy_signal_generation():
    candles = generate_synthetic_ohlcv(bars_count=500, seed=42)
    strategy = SyntheticEmaStrategy()
    signals = strategy.evaluate_signals(candles)

    # There should be signals generated
    assert len(signals) > 0

    # Invariants:
    # 1. Warm-up: First signal should occur after warmup_period (max(30, 14) = 30)
    assert signals[0].bar_index >= 30

    # 2. Sequence check: BUY should precede SELL/SL
    assert signals[0].event == "BUY"

    # 3. Position tracking: Every SELL/SL must close a prior BUY
    in_pos = False
    for s in signals:
        if s.event == "BUY":
            assert not in_pos, f"Double BUY at bar {s.bar_index}"
            assert s.stop_loss is not None
            assert s.stop_loss > Decimal("0")
            assert s.stop_loss < s.price
            in_pos = True
        else:
            assert in_pos, f"Orphan exit {s.event} at bar {s.bar_index}"
            in_pos = False


def test_baseline_signal_equivalence():
    """Identical parameters on identical candle data must yield identical signals."""
    candles = generate_synthetic_ohlcv(bars_count=300, seed=101)
    s1 = SyntheticEmaStrategy().evaluate_signals(candles)
    s2 = SyntheticEmaStrategy().evaluate_signals(candles)

    assert len(s1) == len(s2)
    for sig1, sig2 in zip(s1, s2, strict=True):
        assert sig1.bar_index == sig2.bar_index
        assert sig1.event == sig2.event
        assert sig1.price == sig2.price
        assert sig1.stop_loss == sig2.stop_loss
