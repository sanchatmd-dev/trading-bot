"""Deterministic synthetic market data generation and storage.

Provides reproducible OHLCV datasets covering 1-3 years without requiring
network access or external market feeds. All generated datasets satisfy strict
price invariants (high >= max(open, close), low <= min(open, close), low > 0)
and produce cryptographic SHA-256 digests for auditability.
"""

import hashlib
import math
import random
from dataclasses import dataclass
from decimal import ROUND_HALF_EVEN, Decimal
from typing import Any

import duckdb
import pandas as pd
import pyarrow as pa
import pyarrow.parquet as pq


@dataclass(frozen=True)
class Candle:
    timestamp: int
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal

    def to_dict(self) -> dict[str, Any]:
        return {
            "timestamp": self.timestamp,
            "open": str(self.open),
            "high": str(self.high),
            "low": str(self.low),
            "close": str(self.close),
            "volume": str(self.volume),
        }


def format_decimal(val: float | Decimal, decimals: int = 4) -> Decimal:
    d = Decimal(str(val)) if isinstance(val, float) else val
    quantum = Decimal(10) ** -decimals
    return d.quantize(quantum, rounding=ROUND_HALF_EVEN)


def generate_synthetic_ohlcv(
    symbol: str = "BTCUSDT",
    start_time: int = 1704067200000,  # 2024-01-01 00:00:00 UTC
    bars_count: int = 8760,  # 1 year of 1-hour bars
    interval_ms: int = 3600000,  # 1 hour
    initial_price: Decimal = Decimal("40000.00"),
    seed: int = 42,
    price_decimals: int = 2,
    volatility: float = 0.008,
) -> list[Candle]:
    """Generate deterministic synthetic OHLCV candles.

    Uses a deterministic regime-switching random walk with sine-wave market
    cycles to generate realistic trends, mean-reversions, and volatility clusters.
    """
    rng = random.Random(seed)
    candles: list[Candle] = []

    current_price = float(initial_price)
    current_time = start_time

    for i in range(bars_count):
        # Cyclical wave component to create macro trends for EMA testing
        macro_cycle = 0.0015 * math.sin(2 * math.pi * i / 500)
        regime_drift = 0.0005 * math.cos(2 * math.pi * i / 120)

        # Intrabar random shock
        shock = rng.gauss(0.0, volatility)
        pct_change = macro_cycle + regime_drift + shock

        bar_open = current_price
        bar_close = max(1.0, bar_open * (1.0 + pct_change))

        # Intrabar excursions for high and low
        high_pct = abs(rng.gauss(0.003, 0.002))
        low_pct = abs(rng.gauss(0.003, 0.002))

        bar_high = max(bar_open, bar_close) * (1.0 + high_pct)
        bar_low = min(bar_open, bar_close) * (1.0 - low_pct)
        bar_low = max(0.01, bar_low)

        # Volume proportional to price movement and volatility
        vol_base = rng.uniform(10.0, 50.0)
        vol_mult = 1.0 + 10.0 * abs(pct_change)
        volume = vol_base * vol_mult

        c_open = format_decimal(bar_open, price_decimals)
        c_close = format_decimal(bar_close, price_decimals)
        c_high = format_decimal(bar_high, price_decimals)
        c_low = format_decimal(bar_low, price_decimals)
        c_vol = format_decimal(volume, 4)

        # Ensure strict invariant after decimal rounding
        if c_high < max(c_open, c_close):
            c_high = max(c_open, c_close)
        if c_low > min(c_open, c_close):
            c_low = min(c_open, c_close)
        if c_low <= Decimal("0"):
            c_low = Decimal("0.01")

        candles.append(
            Candle(
                timestamp=current_time,
                open=c_open,
                high=c_high,
                low=c_low,
                close=c_close,
                volume=c_vol,
            )
        )

        current_price = float(c_close)
        current_time += interval_ms

    return candles


def candles_to_dataframe(candles: list[Candle]) -> pd.DataFrame:
    """Convert candles to Pandas DataFrame with string and numeric columns."""
    records = []
    for c in candles:
        records.append(
            {
                "timestamp": c.timestamp,
                "open": float(c.open),
                "high": float(c.high),
                "low": float(c.low),
                "close": float(c.close),
                "volume": float(c.volume),
                "open_dec": str(c.open),
                "high_dec": str(c.high),
                "low_dec": str(c.low),
                "close_dec": str(c.close),
                "volume_dec": str(c.volume),
            }
        )
    df = pd.DataFrame(records)
    df["datetime"] = pd.to_datetime(df["timestamp"], unit="ms", utc=True)
    df.set_index("datetime", inplace=True)
    return df


def compute_candles_sha256(candles: list[Candle]) -> str:
    """Compute deterministic cryptographic SHA-256 of candle dataset."""
    hasher = hashlib.sha256()
    for c in candles:
        row_str = f"{c.timestamp}:{c.open}:{c.high}:{c.low}:{c.close}:{c.volume}\n"
        hasher.update(row_str.encode("utf-8"))
    return hasher.hexdigest()


def save_candles_to_parquet(candles: list[Candle], filepath: str) -> str:
    """Save candles to Parquet file and return SHA-256 digest."""
    df = candles_to_dataframe(candles).reset_index()
    # Convert timestamp and float columns to pyarrow table
    table = pa.Table.from_pandas(df)
    pq.write_table(table, filepath)
    return compute_candles_sha256(candles)


def load_candles_from_parquet(filepath: str) -> list[Candle]:
    """Load candles from Parquet file."""
    table = pq.read_table(filepath)
    df = table.to_pandas()
    candles: list[Candle] = []
    for _, row in df.iterrows():
        candles.append(
            Candle(
                timestamp=int(row["timestamp"]),
                open=Decimal(str(row["open_dec"])),
                high=Decimal(str(row["high_dec"])),
                low=Decimal(str(row["low_dec"])),
                close=Decimal(str(row["close_dec"])),
                volume=Decimal(str(row["volume_dec"])),
            )
        )
    return candles


def query_candles_with_duckdb(candles: list[Candle], sql: str) -> list[dict[str, Any]]:
    """Execute analytical SQL query against candle dataset in DuckDB."""
    df = candles_to_dataframe(candles).reset_index()
    conn = duckdb.connect(":memory:")
    conn.register("ohlcv", df)
    res = conn.execute(sql).fetchdf()
    conn.close()
    return res.to_dict(orient="records")
