"""Tests for QL-4A HTML tear sheet reporting engine."""

from decimal import Decimal

import pandas as pd

from robot_quant.analytics import summarize_closed_positions
from robot_quant.backtest import BacktestConfig, BacktestResult, run_backtest
from robot_quant.market_data import generate_synthetic_ohlcv
from robot_quant.reporting import (
    calculate_tearsheet_metrics,
    generate_tear_sheet,
)
from robot_quant.strategy import SyntheticEmaParameters, SyntheticEmaStrategy


def test_tearsheet_generation_and_reconciliation(tmp_path):
    """Verify tear sheet generation, SVG chart embedding, and exact accounting reconciliation."""
    candles = generate_synthetic_ohlcv(bars_count=200, seed=42)
    params = SyntheticEmaParameters(
        ema_fast=9, ema_slow=21, atr_period=14, atr_multiplier=Decimal("2.0")
    )
    strategy = SyntheticEmaStrategy(params)
    cfg = BacktestConfig(initial_capital=Decimal("10000.00"), symbol="BTCUSDT")

    result = run_backtest(candles, strategy, cfg)
    output_file = tmp_path / "reports" / "tearsheet.html"

    path = generate_tear_sheet(result, output_file, title="Test Strategy Report")
    assert path.exists()

    content = path.read_text(encoding="utf-8")
    assert "<!DOCTYPE html>" in content
    assert "Test Strategy Report" in content
    assert "<svg" in content
    assert "Book Equity" in content
    assert "MTM Equity" in content
    assert "Cash Balance" in content
    assert "EXACT MATCH (80-digit precision)" in content
    assert "10,000.00 USDT" in content


def test_tearsheet_edge_case_zero_trades(tmp_path):
    """Verify tear sheet handles 0 trades without ZeroDivisionError or crash."""
    cfg = BacktestConfig(initial_capital=Decimal("5000.00"), symbol="ETHUSDT")
    metrics = summarize_closed_positions([], starting_equity=Decimal("5000.00"), currency="USDT")
    eq_df = pd.DataFrame(
        {
            "cash": [5000.0, 5000.0],
            "book_equity": [5000.0, 5000.0],
            "mtm_equity": [5000.0, 5000.0],
            "inventory_qty": [0.0, 0.0],
            "close_price": [100.0, 100.0],
        },
        index=[1, 2],
    )
    result = BacktestResult(
        config=cfg,
        signals=[],
        fills=[],
        cash_journal=[],
        allocations=[],
        metrics=metrics,
        trades_summary={},
        equity_curve=eq_df,
        final_cash=Decimal("5000.00"),
        final_book_equity=Decimal("5000.00"),
        final_mtm_equity=Decimal("5000.00"),
    )

    stats = calculate_tearsheet_metrics(result)
    assert stats["total_trades"] == 0
    assert stats["win_rate"] == 0.0
    assert stats["profit_factor"] is None
    assert stats["sharpe"] is None

    output_file = tmp_path / "zero_trades.html"
    path = generate_tear_sheet(result, output_file)
    assert path.exists()
    content = path.read_text(encoding="utf-8")
    assert "EXACT MATCH (80-digit precision)" in content
    assert "5,000.00 USDT" in content
