"""Read-only research record models and dataset manifest contracts.

These models enforce the NUMERIC(38,18) string contract, strictly forbid extra fields
(guaranteeing credentials and secrets cannot leak into research datasets), and support
Schema 12 position allocation tracking.
"""

from decimal import Decimal
from typing import Annotated, Literal

from pydantic import Field

from robot_quant.contracts import (
    Contract,
    Exact,
    Hash,
    Identifier,
    Nonnegative,
    Positive,
    Scope,
)

BrokerLiteral = Literal["binance-global", "binance-th", "innovestx", "settrade"]
ExecutionModeLiteral = Literal["PAPER", "LIVE", "LEGACY"]
EventLiteral = Literal["BUY", "SELL", "TP", "SL"]
SideLiteral = Literal["BUY", "SELL"]
SignalStatusLiteral = Literal[
    "QUEUED", "PROCESSING", "PROCESSED", "REJECTED", "CANCELLED", "CANCELED", "UNKNOWN",
    "NEW", "SUBMITTED", "PARTIALLY_FILLED", "FILLED", "EXPIRED"
]


class SignalRecord(Contract):
    """Read-only representation of a verified signal."""

    id: Annotated[int, Field(ge=1)]
    trade_id: Identifier
    user_id: Identifier
    received_at: Annotated[int, Field(ge=0)]
    signal_time: Annotated[int, Field(ge=0)]
    broker: BrokerLiteral
    symbol: Identifier
    event: EventLiteral
    side: SideLiteral
    entry_price: Positive | None = None
    stop_loss: Positive | None = None
    take_profit: Positive | None = None
    status: SignalStatusLiteral
    applied_quantity: Nonnegative = Decimal("0")
    applied_quote: Nonnegative = Decimal("0")
    execution_mode: ExecutionModeLiteral = "PAPER"
    account_id: Identifier = "paper"
    client_order_id: str | None = None
    review_note: str = ""


class FillRecord(Contract):
    """Read-only representation of an executed fill."""

    signal_id: Annotated[int, Field(ge=1)]
    cumulative_quantity: Positive
    delta_quantity: Positive
    price: Positive
    fee_quote: Nonnegative = Decimal("0")
    realized_r: Exact = Decimal("0")
    received_at: Annotated[int, Field(ge=0)]
    quote_amount: Positive | None = None
    legacy_float: Literal[0, 1] = 0


class CashJournalRecord(Contract):
    """Read-only representation of a cash journal delta."""

    signal_id: Annotated[int, Field(ge=1)]
    cumulative_quantity: Positive
    user_id: Identifier
    broker: BrokerLiteral
    cash_delta: Exact
    at: Annotated[int, Field(ge=0)]


class FundingRecord(Contract):
    """Read-only representation of capital funding."""

    id: Annotated[int, Field(ge=1)]
    user_id: Identifier
    broker: BrokerLiteral
    at: Annotated[int, Field(ge=0)]
    equity_delta: Exact
    cash_delta: Exact
    kind: Literal["CONFIGURATION", "LEGACY_BASELINE"]


class AnalyticsSettingsRecord(Contract):
    """Read-only fee and analytics configuration."""

    user_id: Identifier
    broker: BrokerLiteral
    fee_bps: Nonnegative = Decimal("0")
    updated_at: Annotated[int, Field(ge=0)]


class PositionAllocationRecord(Contract):
    """Schema 12 per-entry lot allocation record."""

    position_id: Identifier
    user_id: Identifier
    account_id: Identifier
    execution_mode: ExecutionModeLiteral = "PAPER"
    broker: BrokerLiteral
    symbol: Identifier
    entry_signal_id: Annotated[int, Field(ge=1)]
    entry_trade_id: Identifier
    status: Literal["OPEN", "CLOSED"] = "OPEN"
    filled_quantity: Positive
    remaining_quantity: Nonnegative
    reserved_quantity: Nonnegative = Decimal("0")
    entry_price: Positive
    stop_loss: Positive | None = None
    take_profit: Positive | None = None
    opened_at: Annotated[int, Field(ge=0)]
    closed_at: Annotated[int, Field(ge=0)] | None = None
    updated_at: Annotated[int, Field(ge=0)]


class DatasetManifest(Contract):
    """Dataset cryptographic manifest for verifiable research pipelines."""

    dataset_id: Identifier
    schema_version: Literal[12] = 12
    source: Literal["POSTGRESQL_REPLICA", "ISOLATED_SNAPSHOT", "SYNTHETIC_FIXTURE"]
    scope: Scope
    created_at: Annotated[int, Field(ge=0)]
    cutoff_at: Annotated[int, Field(ge=0)]
    signals_count: Annotated[int, Field(ge=0)]
    fills_count: Annotated[int, Field(ge=0)]
    cash_journal_count: Annotated[int, Field(ge=0)]
    funding_count: Annotated[int, Field(ge=0)]
    allocations_count: Annotated[int, Field(ge=0)] = 0
    sha256: Hash
