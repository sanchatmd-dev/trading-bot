"""Tests for constrained optimizer and risk simulation preview."""

from decimal import Decimal

from robot_quant.contracts import (
    ParameterBounds,
    RiskProfile,
    Scope,
    StrategyDefinition,
)
from robot_quant.market_data import generate_synthetic_ohlcv
from robot_quant.optimizer import ConstrainedOptimizer
from robot_quant.risk_preview import generate_risk_preview


def make_test_profile(balance="10000.00", requested_pct="20.0", max_order="2000.00"):
    scope = Scope(
        owner_id="research_user",
        bot_id="bot_opt_1",
        account_id="paper",
        broker="binance-global",
        currency="USDT",
    )
    return RiskProfile(
        risk_profile_id="risk_prof_1",
        version=1,
        scope=scope,
        effective_at=0,
        capital_basis="COST_BASIS_NOT_MARK_TO_MARKET",
        initial_capital=Decimal(balance),
        balance=Decimal(balance),
        max_risk_percent=Decimal("100.0"),
        requested_risk_percent=Decimal(requested_pct),
        max_order_notional=Decimal(max_order),
        max_daily_notional=Decimal("20000.00"),
    )


def make_test_strategy_def():
    return StrategyDefinition(
        strategy_id="strat_test_opt",
        version=1,
        template_id="synthetic-ema-v1",
        source_sha256="b" * 64,
        alert_source="alert_calls",
        parameters=(
            ParameterBounds(
                name="ema_fast",
                unit="bars",
                minimum=Decimal("8"),
                maximum=Decimal("12"),
                step=Decimal("2"),
                default=Decimal("10"),
                optimizable=True,
            ),
            ParameterBounds(
                name="ema_slow",
                unit="bars",
                minimum=Decimal("25"),
                maximum=Decimal("35"),
                step=Decimal("5"),
                default=Decimal("30"),
                optimizable=True,
            ),
            ParameterBounds(
                name="atr_period",
                unit="bars",
                minimum=Decimal("14"),
                maximum=Decimal("14"),
                step=Decimal("1"),
                default=Decimal("14"),
                locked=True,
                optimizable=False,
            ),
            ParameterBounds(
                name="atr_multiplier",
                unit="multiplier",
                minimum=Decimal("2.0"),
                maximum=Decimal("2.0"),
                step=Decimal("0.5"),
                default=Decimal("2.0"),
                locked=True,
                optimizable=False,
            ),
        ),
    )


def test_constrained_optimizer_pipeline():
    candles = generate_synthetic_ohlcv(bars_count=500, seed=42)
    strat_def = make_test_strategy_def()
    profile = make_test_profile()

    optimizer = ConstrainedOptimizer(
        strategy_def=strat_def,
        risk_profile=profile,
        candles=candles,
        objective="net_return",
        seed=101,
        search_budget=20,
    )

    report = optimizer.optimize()

    # 1. Verification of baseline evaluation
    assert report.baseline is not None
    assert report.baseline.params["ema_fast"] == "10"
    assert report.baseline.params["ema_slow"] == "30"

    # 2. OptimizationRun contract verification
    run = report.run_contract
    assert run.strategy.strategy_id == strat_def.strategy_id
    assert run.train_end < run.validation_end < run.test_end
    assert len(run.dataset_sha256) == 64
    assert len(run.risk_snapshot_sha256) == 64

    # 3. Candidates evaluated and rejection stats present
    assert report.total_evaluated > 0
    assert "rejected_bounds" in report.rejection_stats
    assert "rejected_baseline" in report.rejection_stats

    # 4. If a best candidate was found, it passed all validation gates
    if report.best_candidate is not None:
        assert report.best_candidate.passed_all_gates
        assert report.best_candidate.status == "ACCEPTED"
        assert report.best_candidate.passed_sensitivity
        assert report.best_candidate.passed_stress


def test_risk_simulation_preview():
    profile = make_test_profile(balance="10000.00", requested_pct="50.0", max_order="2000.00")
    ref_price = Decimal("50000.00")

    preview = generate_risk_preview(profile, reference_price=ref_price)

    # 50% of 10000 is 5000, but capped by max_order_notional (2000.00)
    assert preview.effective_order_notional == Decimal("2000.00")
    assert any("max_order_notional" in r for r in preview.active_limiting_rules)

    # Free capital must be balance - consumed
    assert preview.consumed_capital > Decimal("0")
    assert preview.free_capital == profile.balance - preview.consumed_capital

    # Position capacity: 10000 / ~2000 = 4 or 5
    assert preview.position_capacity >= 4

    # Daily capacity: 20000 max daily / 2000 = 10
    assert preview.daily_trades_capacity == 10

    # Serialization check
    d = preview.to_dict()
    assert d["available_balance"] == "10000.00"
    assert "disclaimer" in d
