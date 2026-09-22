"""Deterministic synthetic fixture generator for Quant Lab research and testing.

Produces realistic trading events, fills, allocations, and journal records
without requiring any live database connection or network access.
"""

from decimal import Decimal
from typing import Any

from robot_quant.records import (
    PositionAllocationRecord,
)


def make_fill(
    signal_id: int,
    trade_id: str,
    side: str,
    quantity: str,
    price: str,
    received_at: int,
    symbol: str = "BTCUSDT",
    broker: str = "binance-global",
    fee_quote: str = "0",
    quote_amount: str | None = None,
    legacy_float: int = 0,
) -> dict[str, Any]:
    """Helper to create raw fill dictionary for analytics."""
    qty_d = Decimal(quantity)
    prc_d = Decimal(price)
    quote = quote_amount if quote_amount is not None else str(qty_d * prc_d)
    return {
        "signal_id": signal_id,
        "trade_id": trade_id,
        "side": side,
        "quantity": quantity,
        "price": price,
        "quote_amount": quote,
        "received_at": received_at,
        "symbol": symbol,
        "broker": broker,
        "cumulative_quantity": quantity,
        "fee_quote": fee_quote,
        "legacy_float": legacy_float,
    }


def fixture_single_cycle() -> list[dict[str, Any]]:
    """Standard 1:1 round-trip buy then sell."""
    return [
        make_fill(101, "b1", "BUY", "1", "100", 1000),
        make_fill(102, "s1", "SELL", "1", "110", 2000),
    ]


def fixture_partial_exit_weighted() -> list[dict[str, Any]]:
    """BUY 1@100, BUY 2@110, SELL 2@130 (matches Node analytics test vector)."""
    return [
        make_fill(101, "b1", "BUY", "1", "100", 1000),
        make_fill(102, "b2", "BUY", "2", "110", 2000),
        make_fill(103, "s1", "SELL", "2", "130", 5000),
    ]


def fixture_scale_in_flat_to_flat() -> list[dict[str, Any]]:
    """BUY 1@100, BUY 1@110, SELL 0.5@90, SELL 1.5@120 (matches Node analytics test vector)."""
    return [
        make_fill(101, "b1", "BUY", "1", "100", 1000),
        make_fill(102, "b2", "BUY", "1", "110", 2000),
        make_fill(103, "s1", "SELL", "0.5", "90", 3000),
        make_fill(104, "s2", "SELL", "1.5", "120", 4000),
    ]


def fixture_targeted_allocations() -> list[PositionAllocationRecord]:
    """Schema 12 position allocations demonstrating independent lot tracking."""
    return [
        PositionAllocationRecord(
            position_id="pos_btc_001",
            user_id="user_alpha",
            account_id="paper",
            execution_mode="PAPER",
            broker="binance-global",
            symbol="BTCUSDT",
            entry_signal_id=101,
            entry_trade_id="b1",
            status="OPEN",
            filled_quantity=Decimal("1.5"),
            remaining_quantity=Decimal("1.5"),
            reserved_quantity=Decimal("0"),
            entry_price=Decimal("60000"),
            stop_loss=Decimal("58000"),
            take_profit=Decimal("64000"),
            opened_at=1700000000000,
            updated_at=1700000000000,
        ),
        PositionAllocationRecord(
            position_id="pos_btc_002",
            user_id="user_alpha",
            account_id="paper",
            execution_mode="PAPER",
            broker="binance-global",
            symbol="BTCUSDT",
            entry_signal_id=102,
            entry_trade_id="b2",
            status="OPEN",
            filled_quantity=Decimal("2.0"),
            remaining_quantity=Decimal("2.0"),
            reserved_quantity=Decimal("0"),
            entry_price=Decimal("61000"),
            stop_loss=Decimal("59000"),
            take_profit=Decimal("65000"),
            opened_at=1700001000000,
            updated_at=1700001000000,
        ),
    ]
