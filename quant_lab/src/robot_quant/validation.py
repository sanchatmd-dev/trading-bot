"""Chronological dataset partitioning and walk-forward validation splitter.

Enforces strict chronological boundaries (train_end < validation_end < test_end)
matching the OptimizationRun contract, preventing future-data leakage and
providing rolling walk-forward windows for strategy cross-validation.
"""

from dataclasses import dataclass
from typing import Iterator

from robot_quant.market_data import Candle


@dataclass(frozen=True)
class ChronologicalDatasetSplit:
    train_candles: list[Candle]
    val_candles: list[Candle]
    test_candles: list[Candle]
    train_end: int
    validation_end: int
    test_end: int

    def __post_init__(self):
        if not (self.train_end < self.validation_end < self.test_end):
            raise ValueError(
                f"Chronological boundary violation: "
                f"{self.train_end} < {self.validation_end} < {self.test_end}"
            )


@dataclass(frozen=True)
class WalkForwardWindow:
    fold: int
    train_candles: list[Candle]
    val_candles: list[Candle]
    test_candles: list[Candle]
    train_end: int
    validation_end: int
    test_end: int


def chronological_split(
    candles: list[Candle],
    train_ratio: float = 0.6,
    val_ratio: float = 0.2,
    test_ratio: float = 0.2,
) -> ChronologicalDatasetSplit:
    """Split candle series into chronological train, validation, and test subsets."""
    if len(candles) < 30:
        raise ValueError("Insufficient candles for chronological split (minimum 30 bars)")
    if abs((train_ratio + val_ratio + test_ratio) - 1.0) > 1e-5:
        raise ValueError("Split ratios must sum to 1.0")

    n = len(candles)
    n_train = max(10, int(n * train_ratio))
    n_val = max(10, int(n * val_ratio))
    n_test = n - n_train - n_val

    if n_test < 10:
        raise ValueError("Dataset too small to allocate at least 10 bars per split partition")

    train_part = candles[:n_train]
    val_part = candles[n_train : n_train + n_val]
    test_part = candles[n_train + n_val :]

    train_end = train_part[-1].timestamp
    val_end = val_part[-1].timestamp
    test_end = test_part[-1].timestamp

    return ChronologicalDatasetSplit(
        train_candles=train_part,
        val_candles=val_part,
        test_candles=test_part,
        train_end=train_end,
        validation_end=val_end,
        test_end=test_end,
    )


def walk_forward_windows(
    candles: list[Candle],
    n_splits: int = 3,
    window_ratio: float = 0.6,
    val_ratio: float = 0.2,
    test_ratio: float = 0.2,
) -> Iterator[WalkForwardWindow]:
    """Generate rolling walk-forward evaluation windows.

    Each fold shifts the evaluation window forward in time, testing strategy
    stability across multiple consecutive market regimes.
    """
    if n_splits < 1:
        raise ValueError("n_splits must be at least 1")
    n = len(candles)
    if n < 100:
        raise ValueError("Walk-forward requires at least 100 bars")

    # Step size to roll the window forward
    step_size = max(10, n // (n_splits + 2))

    for fold in range(n_splits):
        start_idx = fold * step_size
        remaining = n - start_idx
        if remaining < 60:
            break

        fold_candles = candles[start_idx : start_idx + int(n * window_ratio)]
        if len(fold_candles) < 50:
            fold_candles = candles[start_idx:]

        try:
            split = chronological_split(
                fold_candles,
                train_ratio=0.5,
                val_ratio=0.25,
                test_ratio=0.25,
            )
            yield WalkForwardWindow(
                fold=fold + 1,
                train_candles=split.train_candles,
                val_candles=split.val_candles,
                test_candles=split.test_candles,
                train_end=split.train_end,
                validation_end=split.validation_end,
                test_end=split.test_end,
            )
        except ValueError:
            break
