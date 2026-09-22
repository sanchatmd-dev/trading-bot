from decimal import Decimal

import pytest
from pydantic import ValidationError

from robot_quant.contracts import (
    Capability,
    Decision,
    ExportMetadata,
    OptimizationRun,
    ParameterBounds,
    PositionIntent,
    RiskProfile,
    Scope,
    StrategyDefinition,
    validate_candidate,
)


def scope(**changes):
    return Scope(
        owner_id="owner",
        bot_id="bot",
        account_id="paper",
        broker="binance-global",
        currency="USDT",
        **changes,
    )


def risk(**changes):
    values = dict(
        risk_profile_id="risk",
        version=1,
        scope=scope(),
        effective_at=1,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET",
        initial_capital="1000",
        balance="900",
        max_risk_percent="100",
        requested_risk_percent="0.5",
        max_order_notional="100",
        max_daily_notional="1000",
    )
    return RiskProfile(**(values | changes))


def bounds(**changes):
    values = dict(name="ema_fast", unit="bars", minimum="5", maximum="15", default="10", step="1")
    return ParameterBounds(**(values | changes))


def strategy(**changes):
    values = dict(
        strategy_id="fixture",
        version=1,
        template_id="synthetic-ema-v1",
        source_sha256="a" * 64,
        alert_source="alert_calls",
        parameters=(bounds(),),
    )
    return StrategyDefinition(**(values | changes))


def test_exact_immutable_snapshot_roundtrip():
    profile = risk(balance="0.123456789012345678")
    restored = RiskProfile.model_validate_json(profile.model_dump_json())
    assert restored.balance == Decimal("0.123456789012345678")
    assert restored.digest() == profile.digest()
    with pytest.raises(ValidationError):
        profile.max_risk_percent = Decimal("101")


@pytest.mark.parametrize(
    "change",
    [
        {"max_risk_percent": "101"},
        {"requested_risk_percent": "101"},
        {"balance": 0.1},
        {"balance": "NaN"},
        {"balance": "1e-19"},
        {"schema_version": 2},
        {"balance": "1001"},
        {"initial_capital": "1e20"},
        {"disable_guards": True},
    ],
)
def test_invalid_risk_rejected(change):
    with pytest.raises(ValidationError):
        risk(**change)


@pytest.mark.parametrize(
    "change",
    [
        {"minimum": "20"},
        {"default": "16"},
        {"step": "3"},
        {"step": "0"},
        {"unit": "percent"},
        {"name": "max_risk_percent"},
        {"locked": True},
        {"minimum": "5.5"},
        {"schema_version": 99},
    ],
)
def test_invalid_search_rejected(change):
    with pytest.raises(ValidationError):
        bounds(**change)


def test_templates_and_cross_field_constraints():
    with pytest.raises(ValidationError):
        strategy(parameters=(bounds(), bounds(name="ema_slow")))
    with pytest.raises(ValidationError):
        strategy(parameters=(bounds(), bounds()))
    with pytest.raises(ValidationError):
        strategy(template_id="unknown")
    with pytest.raises(ValidationError):
        strategy(template_id="spt-pro-v4-transport-v1")
    with pytest.raises(ValidationError):
        strategy(template_id="spt-pro-v4-transport-v1", parameters=(), alert_source="order_fills")


def test_exit_requires_target_and_scope():
    values = dict(
        scope=scope(), deployment_id="deployment", trade_id="exit", event="SL", reduce_only=True
    )
    with pytest.raises(ValidationError):
        PositionIntent(**values)
    intent = PositionIntent(**values, position_id="p1")
    assert intent.quantity is None  # Close remaining, resolved only by future scoped runtime.
    with pytest.raises(ValidationError):
        PositionIntent(**(values | {"reduce_only": False}), position_id="p1")
    with pytest.raises(ValidationError):
        Scope(**(scope().model_dump() | {"currency": "THB"}))


def test_run_and_export_provenance():
    values = dict(
        run_id="run",
        dataset_sha256="b" * 64,
        dependency_lock_sha256="c" * 64,
        risk_snapshot_sha256=risk().digest(),
        strategy=strategy(),
        seed=0,
        search_budget=10,
        objective="net_return",
        train_end=1,
        validation_end=2,
        test_end=3,
    )
    run = OptimizationRun(**values)
    assert ExportMetadata(export_id="export", run=run, alert_source="alert_calls").state == "DRAFT"
    with pytest.raises(ValidationError):
        OptimizationRun(**(values | {"validation_end": 1}))
    with pytest.raises(ValidationError):
        ExportMetadata(export_id="export", run=run, alert_source="order_fills")
    with pytest.raises(ValidationError):
        ExportMetadata(export_id="export", run=run, alert_source="alert_calls", state="VALIDATED")


def test_decision_cannot_reject_with_inventory():
    with pytest.raises(ValidationError):
        Decision(
            intent_sha256="a" * 64,
            risk_snapshot_sha256="b" * 64,
            outcome="REJECT",
            reason="unknown target",
            effective_quantity="1",
        )


def test_schema_available_for_every_contract():
    for model in (
        Scope,
        RiskProfile,
        ParameterBounds,
        StrategyDefinition,
        OptimizationRun,
        ExportMetadata,
        PositionIntent,
        Decision,
    ):
        assert model.model_json_schema()["additionalProperties"] is False


def test_candidate_cannot_mutate_hard_limits_or_unselected_inputs():
    definition = strategy(parameters=(bounds(optimizable=False),))
    validate_candidate(definition, {"ema_fast": "10"})
    for candidate in ({"ema_fast": "11"}, {"max_risk_percent": "101"}, {}):
        with pytest.raises(ValueError):
            validate_candidate(definition, candidate)
    with pytest.raises(ValidationError):
        Capability(template_id="spt-pro-v4-transport-v1", export_validation="VALIDATED")


def test_full_numeric_precision_does_not_round_or_raise_decimal_context_errors():
    value = "99999999999999999999.999999999999999999"
    profile = risk(initial_capital=value, balance=value)
    assert str(profile.balance) == value
    precise = bounds(
        name="atr_multiplier",
        unit="multiplier",
        minimum="0.000000000000000001",
        maximum=value,
        default="1",
        step="0.000000000000000001",
    )
    validate_candidate(strategy(parameters=(precise,)), {"atr_multiplier": value})
