"""Tests for chronological dataset splitting and walk-forward validation."""

import pytest

from robot_quant.market_data import generate_synthetic_ohlcv
from robot_quant.validation import (
    chronological_split,
    walk_forward_windows,
)


def test_chronological_split_boundaries_and_leakage():
    candles = generate_synthetic_ohlcv(bars_count=300, seed=42)
    split = chronological_split(candles, train_ratio=0.6, val_ratio=0.2, test_ratio=0.2)

    # Invariants:
    # 1. Non-empty partitions
    assert len(split.train_candles) > 0
    assert len(split.val_candles) > 0
    assert len(split.test_candles) > 0
    assert len(split.train_candles) + len(split.val_candles) + len(split.test_candles) == 300

    # 2. Strict chronological boundaries: train_end < val_end < test_end
    assert split.train_end < split.validation_end < split.test_end

    # 3. No timestamp overlap (data leakage check)
    max_train_ts = max((c.timestamp for c in split.train_candles))
    min_val_ts = min((c.timestamp for c in split.val_candles))
    max_val_ts = max((c.timestamp for c in split.val_candles))
    min_test_ts = min((c.timestamp for c in split.test_candles))

    assert max_train_ts < min_val_ts
    assert max_val_ts < min_test_ts


def test_chronological_split_invalid_ratios():
    candles = generate_synthetic_ohlcv(bars_count=100, seed=42)
    with pytest.raises(ValueError, match="must sum to 1.0"):
        chronological_split(candles, train_ratio=0.5, val_ratio=0.2, test_ratio=0.2)


def test_walk_forward_windows_generation():
    candles = generate_synthetic_ohlcv(bars_count=500, seed=77)
    windows = list(walk_forward_windows(candles, n_splits=3))

    assert len(windows) >= 2
    for w in windows:
        assert w.train_end < w.validation_end < w.test_end
        assert len(w.train_candles) > 0
        assert len(w.val_candles) > 0
        assert len(w.test_candles) > 0
