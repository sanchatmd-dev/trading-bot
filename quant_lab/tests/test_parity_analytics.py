"""Golden parity tests comparing Python analytics against Node.js test vectors."""

from decimal import Decimal

import pytest

from robot_quant.analytics import (
    D,
    fifo_analytics,
    summarize_closed_positions,
)
from robot_quant.fixtures import (
    fixture_partial_exit_weighted,
    make_fill,
)


def test_fifo_partial_exit_weighted_parity():
    """Matches Node test: partial exits with weighted entry, fees and holding time."""
    rows = fixture_partial_exit_weighted()
    realizations, closed, _ = fifo_analytics(rows, fee_bps=10)

    assert len(closed) == 0  # Flat-to-flat not completed yet
    assert len(realizations) == 1

    r = realizations[0]
    assert D(r.quantity) == Decimal("2")
    assert D(r.entry_price) == Decimal("105")
    assert D(r.gross_pnl) == Decimal("50")
    assert D(r.fees) == Decimal("0.47")
    assert D(r.net_pnl) == Decimal("49.53")
    assert r.holding_ms == 3500


def test_round_trips_flat_to_flat_and_partial_losses_parity():
    """Matches Node test: round trips count only flat-to-flat; partial losses visible."""
    rows = [
        make_fill(101, "b1", "BUY", "1", "100", 1000),
        make_fill(102, "b2", "BUY", "1", "110", 2000),
        make_fill(103, "s1", "SELL", "0.5", "90", 3000),
    ]
    realizations, closed, _ = fifo_analytics(rows)
    metrics = summarize_closed_positions(closed, starting_equity="1000", realizations=realizations)

    assert metrics.total_trades == 0
    assert D(metrics.net_profit) == Decimal("-5")
    assert D(metrics.max_drawdown) == Decimal("-5")

    # Now close the rest of the position
    rows.append(make_fill(104, "s2", "SELL", "1.5", "120", 4000))
    realizations, closed, _ = fifo_analytics(rows)
    summary = summarize_closed_positions(closed, starting_equity="1000", realizations=realizations)

    assert summary.total_trades == 1
    assert summary.wins == 1
    assert D(summary.net_profit) == Decimal("15")
    assert D(summary.max_drawdown) == Decimal("-5")
    assert D(closed[0].quantity) == Decimal("2")
    assert D(closed[0].entry_price) == Decimal("105")


def test_fifo_rejects_unmatched_sells_and_isolates_users():
    """Matches Node test: FIFO rejects unmatched sells and isolates symbols across users."""
    with pytest.raises(ValueError, match="exceeds recorded FIFO inventory"):
        fifo_analytics([make_fill(1, "s", "SELL", "1", "100", 1000)])

    # Separate users must not share inventory
    user_a_buy = make_fill(1, "a", "BUY", "1", "100", 1000)
    user_a_buy["user_id"] = "user_a"
    user_b_sell = make_fill(2, "b", "SELL", "1", "100", 2000)
    user_b_sell["user_id"] = "user_b"

    with pytest.raises(ValueError, match="exceeds recorded FIFO inventory"):
        fifo_analytics([user_a_buy, user_b_sell])


def test_analytics_metrics_zero_safe_and_parity():
    """Matches Node test: analytics metrics are zero-safe and compute MDD, streaks, and R:R."""
    empty = summarize_closed_positions([], starting_equity=0)
    assert empty.total_trades == 0
    assert empty.win_rate == 0.0
    assert empty.profit_factor is None
    assert empty.max_drawdown_percent is None

    # Test summarize_closed_positions with explicit mock events
    from robot_quant.analytics import RealizationEvent

    events = [
        RealizationEvent(
            trade_id="t1",
            cycle_id="c1",
            broker="binance-global",
            currency="USDT",
            symbol="BTCUSDT",
            quantity="1",
            entry_price="100",
            exit_price="200",
            entry_at=1,
            exit_at=1,
            holding_ms=1000,
            gross_pnl="101",
            fees="1",
            net_pnl="100",
            return_percent=100.0,
        ),
        RealizationEvent(
            trade_id="t2",
            cycle_id="c2",
            broker="binance-global",
            currency="USDT",
            symbol="BTCUSDT",
            quantity="1",
            entry_price="100",
            exit_price="60",
            entry_at=2,
            exit_at=2,
            holding_ms=1000,
            gross_pnl="-38",
            fees="2",
            net_pnl="-40",
            return_percent=-40.0,
        ),
        RealizationEvent(
            trade_id="t3",
            cycle_id="c3",
            broker="binance-global",
            currency="USDT",
            symbol="BTCUSDT",
            quantity="1",
            entry_price="100",
            exit_price="20",
            entry_at=3,
            exit_at=3,
            holding_ms=1000,
            gross_pnl="-77",
            fees="3",
            net_pnl="-80",
            return_percent=-80.0,
        ),
        RealizationEvent(
            trade_id="t4",
            cycle_id="c4",
            broker="binance-global",
            currency="USDT",
            symbol="BTCUSDT",
            quantity="1",
            entry_price="100",
            exit_price="150",
            entry_at=4,
            exit_at=4,
            holding_ms=1000,
            gross_pnl="54",
            fees="4",
            net_pnl="50",
            return_percent=50.0,
        ),
    ]

    out = summarize_closed_positions(events, starting_equity=1000)
    assert D(out.net_profit) == Decimal("30")
    assert out.profit_factor == 1.25
    assert D(out.max_drawdown) == Decimal("-120")
    assert round(out.max_drawdown_percent, 8) == -10.90909091
    assert out.max_consecutive_losses == 2
    assert out.avg_win_loss_ratio == 1.25
    assert D(out.fee_impact) == Decimal("10")
