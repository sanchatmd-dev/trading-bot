"""Golden parity tests comparing Python risk evaluation against Node.js risk engine."""

import dataclasses
from decimal import Decimal

from robot_quant.risk_evaluator import (
    DailyStats,
    PositionState,
    RiskContext,
    RiskPolicy,
    evaluate_risk,
)


def sample_context(**overrides):
    policy = RiskPolicy(
        kill_switch=False,
        max_signal_age_seconds=120,
        max_trades_per_day=10,
        max_daily_loss_r=Decimal("5"),
        pause_after_loss_streak=3,
        block_high_volatility=True,
        max_volatility_percent=5.0,
        block_during_news=True,
        max_open_positions=5,
        one_position_per_symbol=False,
        max_risk_percent=Decimal("100"),
        max_order_notional=Decimal("10000"),
        max_daily_notional=Decimal("100000"),
    )
    ctx_data = dict(
        policy=policy,
        daily=DailyStats(),
        position=PositionState(),
        now=1700000000000,
        equity=Decimal("10000"),
        balance=Decimal("10000"),
        licensed=True,
    )
    ctx_data.update(overrides)
    return RiskContext(**ctx_data)


def test_risk_percent_equity_sizing_and_capping():
    ctx = sample_context()
    signal = {
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "entry": "60000",
        "sl": "59000",
        "tp": "62000",
        "riskMode": "PERCENT_EQUITY",
        "riskValue": "1.0",  # 1% of 10000 equity = 100 risk. distance = 1000 -> quantity = 0.1
        "timestamp": 1700000000000,
        "volatilityPercent": 2.0,
        "newsRisk": False,
    }

    res = evaluate_risk(signal, ctx)
    assert res.ok
    assert Decimal(res.order["quantity"]) == Decimal("0.1")
    assert Decimal(res.order["notional"]) == Decimal("6000")


def test_stale_signal_rejection():
    ctx = sample_context(now=1700000200000)  # 200s later (max is 120s)
    signal = {
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "entry": "60000",
        "sl": "59000",
        "timestamp": 1700000000000,
        "riskMode": "PERCENT_EQUITY",
        "riskValue": "1.0",
    }
    res = evaluate_risk(signal, ctx)
    assert not res.ok
    assert res.reason == "Signal is stale"


def test_guards_volatility_and_news():
    ctx = sample_context()
    # Volatility over threshold
    res_vol = evaluate_risk(
        {
            "broker": "binance-global",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "entry": "60000",
            "sl": "59000",
            "timestamp": 1700000000000,
            "volatilityPercent": 6.5,  # Max is 5.0
            "newsRisk": False,
            "riskMode": "PERCENT_EQUITY",
            "riskValue": "1.0",
        },
        ctx,
    )
    assert not res_vol.ok
    assert res_vol.reason == "High volatility block is active"

    # News active
    res_news = evaluate_risk(
        {
            "broker": "binance-global",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "entry": "60000",
            "sl": "59000",
            "timestamp": 1700000000000,
            "volatilityPercent": 2.0,
            "newsRisk": True,
            "riskMode": "PERCENT_EQUITY",
            "riskValue": "1.0",
        },
        ctx,
    )
    assert not res_news.ok
    assert res_news.reason == "News trading block is active"


def news_buy(**extra):
    return {
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "side": "BUY",
        "entry": "60000",
        "sl": "59000",
        "timestamp": 1700000000000,
        "volatilityPercent": 2.0,
        "riskMode": "PERCENT_EQUITY",
        "riskValue": "1.0",
        **extra,
    }


def test_news_block_rejects_only_an_active_window_for_a_new_entry():
    ctx = sample_context()
    active = evaluate_risk(news_buy(newsRisk=True), ctx)
    assert not active.ok
    assert active.reason == "News trading block is active"
    # The snake_case alias of the Node signal field means the same.
    assert evaluate_risk(news_buy(news_risk=True), ctx).reason == "News trading block is active"
    # No window, or no news data at all, never rejects: missing data is not a news block.
    assert evaluate_risk(news_buy(newsRisk=False), ctx).ok
    for value in (None, 1, 0, "true", "false", [], {}):
        result = evaluate_risk(news_buy(newsRisk=value), ctx)
        assert result.ok, value
        assert result.reason is None
    absent = evaluate_risk(news_buy(), ctx)
    assert absent.ok
    assert absent.reason != "Missing news risk data"
    assert evaluate_risk(news_buy(news_risk=1), ctx).ok


def test_news_block_never_blocks_an_exit_and_a_bot_with_the_switch_off_ignores_it():
    held = PositionState(quantity=Decimal("1.0"))
    exit_signal = {
        "broker": "binance-global",
        "symbol": "BTCUSDT",
        "side": "SELL",
        "entry": "61000",
        "quantity": "1.0",
        "reduceOnly": True,
        "timestamp": 1700000000000,
        "volatilityPercent": 2.0,
    }
    for value in (True, False, None):
        assert evaluate_risk({**exit_signal, "newsRisk": value}, sample_context(position=held)).ok
    off = dataclasses.replace(sample_context().policy, block_during_news=False)
    assert evaluate_risk(news_buy(newsRisk=True), sample_context(policy=off)).ok


def test_stop_loss_validation():
    ctx = sample_context()
    # Stop loss above or equal to entry for BUY
    res = evaluate_risk(
        {
            "broker": "binance-global",
            "symbol": "BTCUSDT",
            "side": "BUY",
            "entry": "60000",
            "sl": "60500",  # Invalid
            "timestamp": 1700000000000,
            "volatilityPercent": 2.0,
            "newsRisk": False,
            "riskMode": "PERCENT_EQUITY",
            "riskValue": "1.0",
        },
        ctx,
    )
    assert not res.ok
    assert res.reason == "BUY stop loss must be below entry"


def test_spot_sell_must_be_reduce_only():
    ctx = sample_context(position=PositionState(quantity=Decimal("1.0")))
    res = evaluate_risk(
        {
            "broker": "binance-global",
            "symbol": "BTCUSDT",
            "side": "SELL",
            "entry": "61000",
            "quantity": "1.0",
            "reduceOnly": False,  # Must be reduce_only!
            "timestamp": 1700000000000,
            "volatilityPercent": 2.0,
            "newsRisk": False,
        },
        ctx,
    )
    assert not res.ok
    assert res.reason == "Spot SELL must be reduce_only"
