"""Tests for deterministic market data generation and storage."""

import tempfile
from decimal import Decimal
from pathlib import Path

from robot_quant.market_data import (
    candles_to_dataframe,
    compute_candles_sha256,
    generate_synthetic_ohlcv,
    load_candles_from_parquet,
    query_candles_with_duckdb,
    save_candles_to_parquet,
)


def test_generate_synthetic_ohlcv_determinism():
    c1 = generate_synthetic_ohlcv(bars_count=100, seed=123)
    c2 = generate_synthetic_ohlcv(bars_count=100, seed=123)
    c3 = generate_synthetic_ohlcv(bars_count=100, seed=999)

    assert len(c1) == 100
    assert compute_candles_sha256(c1) == compute_candles_sha256(c2)
    assert compute_candles_sha256(c1) != compute_candles_sha256(c3)


def test_generate_synthetic_ohlcv_invariants():
    candles = generate_synthetic_ohlcv(bars_count=500, seed=42)

    for c in candles:
        assert isinstance(c.open, Decimal)
        assert isinstance(c.high, Decimal)
        assert isinstance(c.low, Decimal)
        assert isinstance(c.close, Decimal)
        assert isinstance(c.volume, Decimal)

        # Invariants: high >= max(open, close), low <= min(open, close), low > 0, volume > 0
        assert c.high >= max(c.open, c.close)
        assert c.low <= min(c.open, c.close)
        assert c.low > Decimal("0")
        assert c.volume > Decimal("0")


def test_candles_to_dataframe_and_duckdb():
    candles = generate_synthetic_ohlcv(bars_count=50, seed=42)
    df = candles_to_dataframe(candles)

    assert len(df) == 50
    assert "close" in df.columns
    assert "open_dec" in df.columns

    # Test DuckDB query
    sql = "SELECT COUNT(*) as cnt, AVG(close) as avg_c FROM ohlcv"
    rows = query_candles_with_duckdb(candles, sql)
    assert len(rows) == 1
    assert rows[0]["cnt"] == 50
    assert rows[0]["avg_c"] > 0


def test_parquet_roundtrip():
    candles = generate_synthetic_ohlcv(bars_count=60, seed=77)
    digest_before = compute_candles_sha256(candles)

    with tempfile.TemporaryDirectory() as tmpdir:
        pq_path = str(Path(tmpdir) / "test.parquet")
        saved_digest = save_candles_to_parquet(candles, pq_path)
        assert saved_digest == digest_before

        loaded = load_candles_from_parquet(pq_path)
        assert len(loaded) == 60
        digest_after = compute_candles_sha256(loaded)
        assert digest_after == digest_before
        assert loaded[0].open == candles[0].open
        assert loaded[0].close == candles[0].close
