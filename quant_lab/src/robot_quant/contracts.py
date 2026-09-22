"""Versioned research contracts. These models do not authorize execution."""

import hashlib
from decimal import Decimal, InvalidOperation, localcontext
from typing import Annotated, Literal, Self

from pydantic import BaseModel, BeforeValidator, ConfigDict, Field, model_validator


def decimal_string(value: object) -> Decimal:
    if not isinstance(value, (str, Decimal)):
        raise ValueError("Decimal values must be strings, never binary floats")
    try:
        result = Decimal(value)
    except InvalidOperation as error:
        raise ValueError("Invalid decimal string") from error
    if not result.is_finite() or result.as_tuple().exponent < -18:
        raise ValueError("Expected finite decimal with at most 18 fractional digits")
    if result.copy_abs() >= Decimal("1e20"):
        raise ValueError("Value exceeds NUMERIC(38,18)")
    return result


def aligned(value: Decimal, minimum: Decimal, step: Decimal) -> bool:
    # NUMERIC(38,18) arithmetic must not inherit Python's default 28-digit context.
    with localcontext() as context:
        context.prec = 80
        return (value - minimum) % step == 0


Exact = Annotated[Decimal, BeforeValidator(decimal_string)]
Positive = Annotated[Exact, Field(gt=0)]
Nonnegative = Annotated[Exact, Field(ge=0)]
Identifier = Annotated[str, Field(min_length=1, max_length=80, pattern=r"^[A-Za-z0-9_.:-]+$")]
Hash = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
AlertSource = Literal["alert_calls", "order_fills"]


class Contract(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, validate_default=True)
    schema_version: Literal[1] = 1

    def digest(self) -> str:
        return hashlib.sha256(self.model_dump_json().encode()).hexdigest()


class Scope(Contract):
    owner_id: Identifier
    bot_id: Identifier
    account_id: Identifier
    broker: Literal["binance-global", "binance-th", "innovestx", "settrade"]
    currency: Literal["USDT", "THB"]
    execution_mode: Literal["PAPER"] = "PAPER"

    @model_validator(mode="after")
    def currency_matches(self) -> Self:
        if self.currency != ("USDT" if self.broker == "binance-global" else "THB"):
            raise ValueError("Currency must match broker; no cross-currency pooling")
        return self


class RiskProfile(Contract):
    risk_profile_id: Identifier
    version: Annotated[int, Field(strict=True, ge=1)]
    scope: Scope
    effective_at: Annotated[int, Field(strict=True, ge=0)]
    capital_basis: Literal["COST_BASIS_NOT_MARK_TO_MARKET"]
    initial_capital: Positive
    balance: Nonnegative
    max_risk_percent: Annotated[Positive, Field(le=100)]
    requested_risk_percent: Positive
    max_order_notional: Positive
    max_daily_notional: Positive

    @model_validator(mode="after")
    def limits(self) -> Self:
        if self.balance > self.initial_capital:
            raise ValueError("Balance exceeds capital")
        if self.requested_risk_percent > self.max_risk_percent:
            raise ValueError("Requested risk exceeds hard ceiling")
        return self


class ParameterBounds(Contract):
    name: Identifier
    unit: Literal["bars", "multiplier", "percent"]
    minimum: Positive
    maximum: Positive
    step: Positive
    default: Positive
    locked: bool = False
    optimizable: bool = True

    @model_validator(mode="after")
    def bounds(self) -> Self:
        if not self.minimum <= self.default <= self.maximum:
            raise ValueError("Default must be inside ordered bounds")
        if not aligned(self.maximum, self.minimum, self.step) or not aligned(
            self.default, self.minimum, self.step
        ):
            raise ValueError("Bounds and default must align to step")
        if self.locked and (self.optimizable or self.minimum != self.maximum):
            raise ValueError("Locked inputs cannot be searched or mutated")
        if self.unit not in ["bars", "multiplier", "percent"]:
            raise ValueError("Invalid unit for parameter")
        if self.unit == "bars" and any(
            value != value.to_integral_value()
            for value in (self.minimum, self.maximum, self.default, self.step)
        ):
            raise ValueError("Bar periods must be integers")
        return self


class StrategyDefinition(Contract):
    strategy_id: Identifier
    version: Annotated[int, Field(strict=True, ge=1)]
    template_id: Literal["synthetic-ema-v1", "spt-pro-v4-transport-v1"]
    source_sha256: Hash
    alert_source: AlertSource
    parameters: tuple[ParameterBounds, ...]

    @model_validator(mode="after")
    def compatible(self) -> Self:
        by_name = {p.name: p for p in self.parameters}
        if len(by_name) != len(self.parameters):
            raise ValueError("Duplicate parameter")
        if "ema_fast" in by_name and "ema_slow" in by_name:
            if by_name["ema_fast"].maximum >= by_name["ema_slow"].minimum:
                raise ValueError("Entire fast EMA range must precede slow EMA range")
        if self.template_id == "spt-pro-v4-transport-v1" and self.parameters:
            raise ValueError("SPT historical evaluator and effective input mapping are unverified")
        if self.template_id == "spt-pro-v4-transport-v1" and self.alert_source != "alert_calls":
            raise ValueError("SPT indicator has no validated order-fill wrapper")
        return self


class OptimizationRun(Contract):
    run_id: Identifier
    dataset_sha256: Hash
    dependency_lock_sha256: Hash
    risk_snapshot_sha256: Hash
    strategy: StrategyDefinition
    seed: Annotated[int, Field(strict=True, ge=0)]
    search_budget: Annotated[int, Field(strict=True, ge=1, le=100000)]
    objective: Literal["net_return", "max_drawdown", "profit_factor"]
    train_end: Annotated[int, Field(strict=True, ge=0)]
    validation_end: Annotated[int, Field(strict=True, ge=0)]
    test_end: Annotated[int, Field(strict=True, ge=0)]

    @model_validator(mode="after")
    def chronological(self) -> Self:
        if not self.train_end < self.validation_end < self.test_end:
            raise ValueError("Train/validation/test boundaries must increase")
        if self.strategy.template_id != "synthetic-ema-v1":
            raise ValueError("Template is not optimization supported")
        return self


class Capability(Contract):
    template_id: Literal["synthetic-ema-v1", "spt-pro-v4-transport-v1"]
    historical_parity: Literal["UNVERIFIED"] = "UNVERIFIED"
    optimization: Literal["UNVERIFIED"] = "UNVERIFIED"
    export_validation: Literal["UNVERIFIED"] = "UNVERIFIED"


def validate_candidate(strategy: StrategyDefinition, candidate: dict[str, str]) -> None:
    """Validate an input-only proposal against the complete frozen definition."""
    definitions = {parameter.name: parameter for parameter in strategy.parameters}
    if candidate.keys() != definitions.keys():
        raise ValueError("Candidate must contain exactly the defined indicator inputs")
    for name, raw in candidate.items():
        value = decimal_string(raw)
        bounds = definitions[name]
        if not bounds.minimum <= value <= bounds.maximum:
            raise ValueError("Candidate exceeds approved bounds")
        if not aligned(value, bounds.minimum, bounds.step):
            raise ValueError("Candidate does not align to step")
        if (bounds.locked or not bounds.optimizable) and value != bounds.default:
            raise ValueError("Candidate changes a locked or unselected input")


class ExportMetadata(Contract):
    export_id: Identifier
    run: OptimizationRun
    alert_source: AlertSource
    state: Literal["DRAFT"] = "DRAFT"

    @model_validator(mode="after")
    def matching_source(self) -> Self:
        if self.alert_source != self.run.strategy.alert_source:
            raise ValueError("Export alert source must match the evaluated strategy")
        return self


class PositionIntent(Contract):
    scope: Scope
    deployment_id: Identifier
    trade_id: Identifier
    position_id: Identifier
    event: Literal["BUY", "SELL", "TP", "SL"]
    reduce_only: bool
    quantity: Positive | None = None

    @model_validator(mode="after")
    def reduce_only_exit(self) -> Self:
        if self.reduce_only != (self.event != "BUY"):
            raise ValueError("Spot exits require reduce_only; BUY must not reduce")
        return self


class Decision(Contract):
    intent_sha256: Hash
    risk_snapshot_sha256: Hash
    outcome: Literal["REJECT", "ACCEPT", "CAP"]
    reason: Annotated[str, Field(min_length=1)]
    effective_quantity: Nonnegative

    @model_validator(mode="after")
    def quantity_matches(self) -> Self:
        if (self.effective_quantity == 0) != (self.outcome == "REJECT"):
            raise ValueError("Reject requires zero quantity; accept requires positive quantity")
        return self
