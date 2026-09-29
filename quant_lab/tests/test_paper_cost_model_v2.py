"""Literal economic fixtures for isolated cost-v2 finalization."""

import copy
from decimal import ROUND_UP, DefaultContext, Inexact, localcontext

import pytest

from robot_quant.paper_cost_model import finalize_bridge_order

MODEL = {
    "version": "paper-close-cost-v2", "price_tick": 0.01, "quantity_step": 0.01,
    "fee_bps": 10, "slippage_bps": 1,
}
ORDER = {
    "side": "BUY", "quantity": "10", "price": "100", "notional": "1000",
    "stopLoss": "99", "takeProfit": "102", "riskMode": "PERCENT_EQUITY", "riskValue": "1",
}
CONTEXT = {
    "policy": {"maxRiskPercent": 1},
    "account": {"bookEquity": "1000", "cash": "1000"},
    "signal": {"side": "BUY", "riskMode": "PERCENT_EQUITY", "riskValue": "1"},
    "exposure": {"reservedNotional": "0", "reservedFees": "0", "committedNotional": "0"},
}


def finalize(*, order=None, model=None, **overrides):
    context = copy.deepcopy(CONTEXT)
    context.update(overrides)
    return finalize_bridge_order(copy.deepcopy(order or ORDER), copy.deepcopy(model or MODEL), **context)


def test_percent_equity_buy_literal_and_no_mutation():
    before = copy.deepcopy(ORDER)
    result = finalize()
    assert result["order"]["quantity"] == "8.27"
    assert result["order"]["notional"] == "827"
    assert result["fee"] == "0.827"
    assert result["costs"]["cashDebit"] == "827.827"
    assert result["costs"]["estimatedStopExitPrice"] == "98.99"
    assert result["costs"]["estimatedLossAtStop"] == "9.9983473"
    assert result["costs"]["estimatedStopExitFee"] == "0.8186473"
    assert result["order"]["reserved_fee_bps"] == "10"
    assert result["order"]["sizingAdjustment"]["requestedQuantity"] == "10"
    assert ORDER == before


@pytest.mark.parametrize("changes,code", [
    ({"signal": {"riskMode": "QUANTITY", "quantity": "10"}}, "COST_INCLUSIVE_RISK_EXCEEDED"),
    ({"exposure": {"feeReservationUnknown": True}}, "PENDING_FEE_RESERVATION_UNKNOWN"),
    ({"account": {"bookEquity": "1000", "cash": "0"}}, "NO_COST_INCLUSIVE_BUDGET"),
    ({"policy": {"maxRiskPercent": 0}}, "NO_COST_INCLUSIVE_BUDGET"),
])
def test_rejection_codes(changes, code):
    with pytest.raises(ValueError, match=f"^{code}$"):
        finalize(**changes)


def test_cash_and_exposure_reservations():
    cash = finalize(
        policy={"maxRiskPercent": 100}, signal={"riskMode": "PERCENT_EQUITY", "riskValue": 100},
        account={"bookEquity": "10000", "cash": "500"},
        exposure={"reservedNotional": "100", "reservedFees": "2", "committedNotional": "100"},
    )
    assert cash["order"]["quantity"] == "3.97"
    assert cash["costs"]["cashDebit"] == "397.397"
    exposure = finalize(
        policy={"maxRiskPercent": 100}, signal={"riskMode": "PERCENT_EQUITY", "riskValue": 100},
        exposure={"reservedNotional": "0", "reservedFees": "2", "committedNotional": "900"},
    )
    assert exposure["order"]["quantity"] == "0.97"


def test_zero_cost_and_sell_fee_path():
    zero = finalize(model={**MODEL, "fee_bps": 0, "slippage_bps": 0})
    assert zero["order"]["quantity"] == "10"
    assert zero["costs"]["estimatedLossAtStop"] == "10"
    sell = finalize(order={**ORDER, "side": "SELL", "reduceOnly": True}, exposure={"feeReservationUnknown": True})
    assert sell["fee"] == "1"
    assert "costs" not in sell


def test_step_and_stop_rejections():
    with pytest.raises(ValueError, match="^BELOW_QUANTITY_STEP$"):
        finalize(model={**MODEL, "quantity_step": 11})
    with pytest.raises(ValueError, match="^INVALID_MODELED_STOP_PRICE$"):
        finalize(order={**ORDER, "stopLoss": ".01"}, model={**MODEL, "slippage_bps": 1000})


def test_insignificant_quantity_zeros_do_not_change_exact_scale():
    result = finalize(order={**ORDER, "quantity": "10.0000000000000000000"})
    assert result["order"]["quantity"] == "8.27"
    assert result["order"]["sizingAdjustment"]["requestedQuantity"] == "10"


def test_ambient_decimal_context_does_not_change_result():
    expected = finalize()
    with localcontext() as ambient:
        ambient.prec = 7
        ambient.rounding = ROUND_UP
        ambient.traps[Inexact] = True
        assert finalize() == expected


def test_mutated_default_decimal_context_does_not_change_result():
    expected = finalize()
    original = DefaultContext.copy()
    try:
        DefaultContext.traps[Inexact] = True
        DefaultContext.prec = 7
        DefaultContext.rounding = ROUND_UP
        assert finalize() == expected
    finally:
        DefaultContext.traps = original.traps
        DefaultContext.prec = original.prec
        DefaultContext.rounding = original.rounding


def test_null_optional_reservations_and_provenance_use_defaults():
    result = finalize(
        order={**ORDER, "sizingAdjustment": {"requestedQuantity": None}},
        exposure={"reservedNotional": None, "reservedFees": None, "committedNotional": None},
    )
    assert result["order"]["quantity"] == "8.27"
    assert result["order"]["sizingAdjustment"]["requestedQuantity"] == "10"
