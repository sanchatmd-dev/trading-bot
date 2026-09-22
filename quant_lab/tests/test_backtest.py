"""Tests for backtest simulation engine and accounting reconciliation."""

from decimal import Decimal

from robot_quant.analytics import D, amount
from robot_quant.backtest import BacktestConfig, run_backtest
from robot_quant.contracts import RiskProfile, Scope
from robot_quant.market_data import generate_synthetic_ohlcv


def test_backtest_spot_invariants_and_accounting():
    candles = generate_synthetic_ohlcv(bars_count=600, seed=42)
    config = BacktestConfig(
        initial_capital=Decimal("10000.00"),
        requested_risk_percent=Decimal("50.0"),  # 50% per position
        max_order_notional=Decimal("5000.00"),
        fee_bps=Decimal("10"),
        slippage_bps=Decimal("5"),
    )
    result = run_backtest(candles, config=config)

    # 1. Invariants: Cash and inventory never negative
    assert result.final_cash >= Decimal("0")
    for rec in result.equity_curve.to_dict(orient="records"):
        assert rec["cash"] >= 0
        assert rec["inventory"] >= 0
        assert rec["book_equity"] >= 0
        assert rec["mtm_equity"] >= 0

    # 2. Ledgers consistency
    assert len(result.signals) == len(result.fills)
    assert len(result.fills) == len(result.cash_journal)
    assert len(result.allocations) > 0

    # 3. Cash journal sum + initial capital equals final cash
    cash_delta_sum = sum((cj.cash_delta for cj in result.cash_journal), Decimal("0"))
    expected_cash = config.initial_capital + cash_delta_sum
    assert amount(result.final_cash) == amount(expected_cash)

    # 4. FIFO analytics reconciliation
    # Realized net PnL from analytics plus initial capital equals book equity
    expected_book_equity = config.initial_capital + D(result.metrics.net_profit)
    assert amount(result.final_book_equity) == amount(expected_book_equity)


def test_backtest_from_risk_profile():
    scope = Scope(
        owner_id="owner_1",
        bot_id="bot_1",
        account_id="paper",
        broker="binance-global",
        currency="USDT",
    )
    profile = RiskProfile(
        risk_profile_id="risk_1",
        version=1,
        scope=scope,
        effective_at=0,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET",
        initial_capital=Decimal("5000.00"),
        balance=Decimal("5000.00"),
        max_risk_percent=Decimal("100.0"),
        requested_risk_percent=Decimal("20.0"),
        max_order_notional=Decimal("1000.00"),
        max_daily_notional=Decimal("5000.00"),
    )
    config = BacktestConfig.from_risk_profile(profile)
    assert config.initial_capital == Decimal("5000.00")
    assert config.requested_risk_percent == Decimal("20.0")
    assert config.max_order_notional == Decimal("1000.00")

    candles = generate_synthetic_ohlcv(bars_count=300, seed=77)
    res = run_backtest(candles, config=config)
    assert res.final_cash > Decimal("0")


def test_backtest_zero_trade_scenario():
    """If no signals occur (e.g. short series during warm-up),
    cash and book equity remain intact."""
    candles = generate_synthetic_ohlcv(bars_count=20, seed=1)  # Warmup is 30 bars
    config = BacktestConfig(initial_capital=Decimal("10000.00"))
    result = run_backtest(candles, config=config)

    assert len(result.signals) == 0
    assert len(result.fills) == 0
    assert result.final_cash == Decimal("10000.00")
    assert result.final_book_equity == Decimal("10000.00")
    assert result.metrics.total_trades == 0
