"""Tests for read-only research records and manifest security invariants."""

from decimal import Decimal

import pytest
from pydantic import ValidationError

from robot_quant.contracts import Scope
from robot_quant.records import (
    CashJournalRecord,
    FillRecord,
    FundingRecord,
    PositionAllocationRecord,
    SignalRecord,
)
from robot_quant.storage import create_manifest, verify_manifest


def sample_scope():
    return Scope(
        owner_id="owner_1",
        bot_id="bot_1",
        account_id="paper",
        broker="binance-global",
        currency="USDT",
    )


def test_signal_record_valid_and_immutable():
    signal = SignalRecord(
        id=1,
        trade_id="trade_101",
        user_id="user_1",
        received_at=1700000000000,
        signal_time=1700000000000,
        broker="binance-global",
        symbol="BTCUSDT",
        event="BUY",
        side="BUY",
        entry_price=Decimal("60000.5"),
        stop_loss=Decimal("59000"),
        status="PROCESSED",
        applied_quantity=Decimal("0.5"),
    )
    assert signal.trade_id == "trade_101"
    assert signal.entry_price == Decimal("60000.5")
    # Verify immutability
    with pytest.raises(ValidationError):
        signal.status = "CANCELLED"


def test_signal_record_strictly_rejects_credentials_and_secrets():
    # Attempting to inject secrets into research datasets MUST fail validation
    with pytest.raises(ValidationError) as exc_info:
        SignalRecord(
            id=1,
            trade_id="trade_101",
            user_id="user_1",
            received_at=1700000000000,
            signal_time=1700000000000,
            broker="binance-global",
            symbol="BTCUSDT",
            event="BUY",
            side="BUY",
            status="PROCESSED",
            webhook_secret="secret_value",  # Forbidden!
        )
    assert "extra_forbidden" in str(exc_info.value)

    with pytest.raises(ValidationError):
        SignalRecord(
            id=1,
            trade_id="trade_101",
            user_id="user_1",
            received_at=1700000000000,
            signal_time=1700000000000,
            broker="binance-global",
            symbol="BTCUSDT",
            event="BUY",
            side="BUY",
            status="PROCESSED",
            password_hash="leaked_hash",  # Forbidden!
        )


def test_fill_record_rejects_binary_floats():
    with pytest.raises(ValidationError):
        FillRecord(
            signal_id=1,
            cumulative_quantity=1.23,  # Binary float forbidden!
            delta_quantity=Decimal("1.23"),
            price=Decimal("50000"),
            received_at=1700000000000,
        )


def test_position_allocation_schema12():
    alloc = PositionAllocationRecord(
        position_id="pos_lot_01",
        user_id="user_1",
        account_id="paper",
        broker="binance-global",
        symbol="BTCUSDT",
        entry_signal_id=10,
        entry_trade_id="trade_entry_1",
        status="OPEN",
        filled_quantity=Decimal("1.5"),
        remaining_quantity=Decimal("1.5"),
        entry_price=Decimal("62000"),
        opened_at=1700000000000,
        updated_at=1700000000000,
    )
    assert alloc.position_id == "pos_lot_01"
    assert alloc.remaining_quantity == Decimal("1.5")


def test_manifest_creation_and_tamper_detection():
    scope = sample_scope()
    signals = [
        SignalRecord(
            id=1,
            trade_id="t1",
            user_id="owner_1",
            received_at=1000,
            signal_time=1000,
            broker="binance-global",
            symbol="BTCUSDT",
            event="BUY",
            side="BUY",
            status="PROCESSED",
        )
    ]
    fills = [
        FillRecord(
            signal_id=1,
            cumulative_quantity=Decimal("1"),
            delta_quantity=Decimal("1"),
            price=Decimal("100"),
            received_at=1000,
        )
    ]
    cash = [
        CashJournalRecord(
            signal_id=1,
            cumulative_quantity=Decimal("1"),
            user_id="owner_1",
            broker="binance-global",
            cash_delta=Decimal("-100"),
            at=1000,
        )
    ]
    funding = [
        FundingRecord(
            id=1,
            user_id="owner_1",
            broker="binance-global",
            at=500,
            equity_delta=Decimal("1000"),
            cash_delta=Decimal("1000"),
            kind="CONFIGURATION",
        )
    ]

    manifest = create_manifest(
        dataset_id="ds_test_01",
        scope=scope,
        signals=signals,
        fills=fills,
        cash_journal=cash,
        funding=funding,
        created_at=2000,
        cutoff_at=2000,
    )

    assert manifest.schema_version == 12
    assert manifest.signals_count == 1
    assert verify_manifest(manifest, signals, fills, cash, funding)

    # Tampering with fill price must fail manifest verification
    tampered_fills = [
        FillRecord(
            signal_id=1,
            cumulative_quantity=Decimal("1"),
            delta_quantity=Decimal("1"),
            price=Decimal("105"),  # Tampered
            received_at=1000,
        )
    ]
    assert not verify_manifest(manifest, signals, tampered_fills, cash, funding)
