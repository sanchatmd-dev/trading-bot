"""Pure order finalization for the paper-close-cost-v2 execution model.

Inputs are already risk-admitted bridge orders and frozen account context. This
module does not perform risk admission, ledger updates, or historical replay.
"""

from __future__ import annotations

import json
import sys
from decimal import (
    ROUND_FLOOR,
    ROUND_HALF_EVEN,
    Context,
    Decimal,
    DivisionByZero,
    InvalidOperation,
    Overflow,
    localcontext,
)

VERSION = "paper-close-cost-v2"
_CENT_SCALE = Decimal("1e-18")
_ASSUMPTION = (
    "Conditional stop-close estimate with fees, adverse slippage and tick rounding. "
    "Gaps can exceed this loss; ledger R retains price-distance semantics."
)


def _decimal(value: object) -> Decimal:
    result = Decimal(str(value))
    if not result.is_finite() or abs(result) >= Decimal("1e20"):
        raise ValueError("Decimal outside supported range")
    return result


def _plain(value: Decimal, *, rounded: bool = False) -> str:
    if rounded:
        value = value.quantize(_CENT_SCALE, rounding=ROUND_HALF_EVEN)
    value = value.normalize()
    if not rounded and value.as_tuple().exponent < -18:
        raise ValueError("Maximum decimal scale is 18")
    if value == 0:
        return "0"
    return format(value.normalize(), "f")


def _optional_decimal(source: dict, key: str) -> Decimal:
    value = source.get(key)
    return _decimal(0 if value is None else value)


def _round_order(order: dict, model: dict) -> dict:
    requested = _decimal(order["quantity"])
    step = _decimal(model["quantity_step"])
    quantity = (requested / step).to_integral_value(rounding=ROUND_FLOOR) * step
    if quantity <= 0:
        raise ValueError("BELOW_QUANTITY_STEP")
    notional = _plain(quantity * _decimal(order["price"]), rounded=True)
    fee = _plain(_decimal(notional) * _decimal(model["fee_bps"]) / 10000, rounded=True)
    result_order = {**order, "quantity": _plain(quantity), "notional": notional}
    if quantity < requested:
        previous = order.get("sizingAdjustment") or {}
        result_order["sizingAdjustment"] = {
            **previous,
            "requestedQuantity": previous.get("requestedQuantity") if previous.get("requestedQuantity") is not None else _plain(requested),
            "quantity": _plain(quantity),
            "reason": "Capped/rounded to verified venue quantity step",
        }
    return {"order": result_order, "fee": fee}


def finalize_bridge_order(
    order: dict,
    model: dict,
    *,
    policy: dict,
    account: dict,
    signal: dict | None = None,
    exposure: dict | None = None,
) -> dict:
    """Match Node finalizeBridgeOrder on validated V2 bridge inputs.

    Raises ValueError with the production rejection code for rejected orders.
    Callers must supply previously validated model, order and account fields.
    """
    if model.get("version") != VERSION:
        raise ValueError("UNSUPPORTED_EXECUTION_MODEL")
    signal = order if signal is None else signal
    exposure = {} if exposure is None else exposure
    with localcontext(Context(
        prec=80, rounding=ROUND_HALF_EVEN, Emin=-999999, Emax=999999,
        capitals=1, clamp=0, traps=[InvalidOperation, DivisionByZero, Overflow],
    )):
        finalized = _round_order(order, model)

        def stamp(result: dict) -> dict:
            if _decimal(result["order"]["notional"]) <= 0:
                raise ValueError("BELOW_NOTIONAL_PRECISION")
            return {
                **result,
                "order": {
                    **result["order"],
                    "execution_model_version": VERSION,
                    "reserved_fee_bps": _plain(_decimal(model["fee_bps"])),
                },
            }

        if order["side"] != "BUY":
            return stamp(finalized)
        if exposure.get("feeReservationUnknown"):
            raise ValueError("PENDING_FEE_RESERVATION_UNKNOWN")
        price = _decimal(order["price"])
        stop = _decimal(order["stopLoss"])
        fee_rate = _decimal(model["fee_bps"]) / 10000
        if stop <= 0 or stop >= price:
            raise ValueError("INVALID_ENTRY_LEVELS")
        # Node executionPrice receives Number(stop); preserve its binary64 boundary.
        stop_number = _decimal(str(float(stop)))
        tick = _decimal(model["price_tick"])
        stop_price = (
            (stop_number * (1 - _decimal(model["slippage_bps"]) / 10000) / tick)
            .to_integral_value(rounding=ROUND_FLOOR) * tick
        )
        stop_price = _decimal(_plain(stop_price))
        if stop_price <= 0:
            raise ValueError("INVALID_MODELED_STOP_PRICE")
        unit_loss = price - stop_price + (price + stop_price) * fee_rate
        percentage = (
            signal.get("riskMode") == "PERCENT_EQUITY"
            and "quantity" not in signal
            and "quoteQuantity" not in signal
        )
        risk_percent = min(_decimal(signal["riskValue"]), _decimal(policy["maxRiskPercent"])) if percentage else _decimal(policy["maxRiskPercent"])
        risk_budget = _decimal(account["bookEquity"]) * risk_percent / 100
        reserved_fees = _optional_decimal(exposure, "reservedFees")
        cash_budget = _decimal(account["cash"]) - _optional_decimal(exposure, "reservedNotional") - reserved_fees
        exposure_budget = _decimal(account["bookEquity"]) - _optional_decimal(exposure, "committedNotional") - reserved_fees
        if risk_budget <= 0 or cash_budget <= 0 or exposure_budget <= 0:
            raise ValueError("NO_COST_INCLUSIVE_BUDGET")

        def metrics(result: dict) -> dict:
            stop_notional = _plain(_decimal(result["order"]["quantity"]) * stop_price, rounded=True)
            stop_fee = _plain(_decimal(stop_notional) * fee_rate, rounded=True)
            cash_debit = _plain(_decimal(result["order"]["notional"]) + _decimal(result["fee"]), rounded=True)
            return {
                "cashDebit": cash_debit,
                "estimatedLossAtStop": _plain(_decimal(cash_debit) - _decimal(stop_notional) + _decimal(stop_fee), rounded=True),
                "estimatedStopExitPrice": _plain(stop_price),
                "estimatedStopExitFee": stop_fee,
                "entryFee": result["fee"],
                "riskBudget": _plain(risk_budget, rounded=True),
                "riskLimitIncludesCosts": True,
                "rAccounting": "PRICE_DISTANCE_V1",
                "assumption": _ASSUMPTION,
            }

        def violation(costs: dict) -> str | None:
            if _decimal(costs["estimatedLossAtStop"]) > risk_budget:
                return "COST_INCLUSIVE_RISK_EXCEEDED"
            if _decimal(costs["cashDebit"]) > cash_budget:
                return "COST_INCLUSIVE_CASH_EXCEEDED"
            if _decimal(costs["cashDebit"]) > exposure_budget:
                return "COST_INCLUSIVE_EXPOSURE_EXCEEDED"
            return None

        if percentage:
            max_quantity = min(
                _decimal(finalized["order"]["quantity"]),
                risk_budget / unit_loss,
                cash_budget / (price * (1 + fee_rate)),
                exposure_budget / (price * (1 + fee_rate)),
            )
            quantity = (max_quantity / _decimal(model["quantity_step"])).to_integral_value(rounding=ROUND_FLOOR) * _decimal(model["quantity_step"])
            if quantity <= 0:
                raise ValueError("BELOW_QUANTITY_STEP")
            finalized = _round_order({**order, "quantity": _plain(quantity)}, model)
            if violation(metrics(finalized)):
                low, high, best = 0, int(quantity / _decimal(model["quantity_step"])), None
                for _ in range(256):
                    if high < low:
                        break
                    middle = (low + high) // 2
                    if middle == 0:
                        low = 1
                        continue
                    candidate = _round_order({**order, "quantity": _plain(middle * _decimal(model["quantity_step"]))}, model)
                    if violation(metrics(candidate)):
                        high = middle - 1
                    else:
                        best, low = candidate, middle + 1
                if best is None:
                    raise ValueError("BELOW_QUANTITY_STEP")
                finalized = best
            if _decimal(finalized["order"]["quantity"]) < _decimal(order["quantity"]):
                previous = order.get("sizingAdjustment") or {}
                finalized["order"]["sizingAdjustment"] = {
                    **previous,
                    "requestedQuantity": previous.get("requestedQuantity") if previous.get("requestedQuantity") is not None else _plain(_decimal(order["quantity"])),
                    "quantity": finalized["order"]["quantity"],
                    "reason": "Capped to cost-inclusive stop risk, available cash and exposure, then rounded to the quantity step",
                }
        costs = metrics(finalized)
        reason = violation(costs)
        if reason:
            raise ValueError(reason)
        return {**stamp(finalized), "costs": costs}


if __name__ == "__main__":
    vectors = json.load(sys.stdin)
    output = []
    for vector in vectors:
        try:
            output.append({"result": finalize_bridge_order(**vector)})
        except ValueError as error:
            output.append({"error": str(error)})
    json.dump(output, sys.stdout, separators=(",", ":"))
