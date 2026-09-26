"""Serial offline fully-filled Paper projection under a frozen Node policy.

This profile does not model pending orders, unknown broker outcomes, intrabar
fills, owner authentication or concurrent Bots. Those runtime proofs are APP-3A/B.
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from robot_quant.analytics import PRECISION_CONTEXT, amount
from robot_quant.bridge_replay import (
    BridgeBar,
    BridgeReplay,
    PaperModel,
    execution_price,
    round_order,
)
from robot_quant.risk_evaluator import (
    DailyStats,
    PositionState,
    RiskContext,
    RiskPolicy,
    TargetAllocationState,
    evaluate_risk,
)


def node_policy(raw: dict) -> RiskPolicy:
    names = {
        "killSwitch": "kill_switch",
        "maxSignalAgeSeconds": "max_signal_age_seconds",
        "maxTradesPerDay": "max_trades_per_day",
        "maxDailyLossR": "max_daily_loss_r",
        "pauseAfterLossStreak": "pause_after_loss_streak",
        "blockHighVolatility": "block_high_volatility",
        "maxVolatilityPercent": "max_volatility_percent",
        "blockDuringNews": "block_during_news",
        "allowedSymbols": "allowed_symbols",
        "sideMode": "side_mode",
        "maxOpenPositions": "max_open_positions",
        "onePositionPerSymbol": "one_position_per_symbol",
        "capPercentEquitySize": "cap_percent_equity_size",
        "maxRiskPercent": "max_risk_percent",
        "maxOrderNotional": "max_order_notional",
        "maxDailyNotional": "max_daily_notional",
    }
    missing = set(names) - set(raw)
    if missing:
        raise ValueError("INCOMPLETE_NODE_POLICY:" + ",".join(sorted(missing)))
    result = {names[k]: v for k, v in raw.items() if k in names}
    for field in [
        "max_daily_loss_r",
        "max_risk_percent",
        "max_order_notional",
        "max_daily_notional",
    ]:
        result[field] = Decimal(str(result[field]))
    result["allowed_symbols"] = tuple(result["allowed_symbols"])
    return RiskPolicy(**result)


@dataclass
class Allocation:
    quantity: Decimal
    entry_price: Decimal  # fee-inclusive, matches the Node ledger lot


def paper_replay(
    bars: list[tuple[BridgeBar, bool, bool]],
    *,
    deployment_id: str,
    multiplier: Decimal,
    rr: Decimal,
    model: PaperModel,
    policy: dict,
    equity: Decimal,
    cash: Decimal,
    broker: str,
    symbol: str,
    start_time: int | None = None,
) -> dict:
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        risk_policy = node_policy(policy)
        replay = BridgeReplay(deployment_id, multiplier, rr, model)
        starting_cash = cash
        positions: dict[str, Allocation] = {}
        daily: dict[str, DailyStats] = {}
        quantity = cost = initial_risk = pnl = Decimal(0)
        loss_streak = 0
        events, decisions, fills = [], [], []
        for bar, buy, native_exit in bars:
            for intent in replay.step(bar, buy, native_exit):
                event = asdict(intent)
                event["sl"] = str(intent.sl) if intent.sl is not None else None
                event["tp"] = str(intent.tp) if intent.tp is not None else None
                events.append(event)
                if start_time is not None and bar.time < start_time:
                    continue  # warm Pine state, but do not start the Bot ledger early
                target = positions.get(intent.entry_ref)
                reason = (
                    "TARGET_NOT_OPEN" if intent.event_type == "EXIT" and target is None else None
                )
                day = datetime.fromtimestamp(bar.time / 1000, UTC).date().isoformat()
                stats = daily.get(day, DailyStats())
                signal = {
                    "broker": broker,
                    "symbol": symbol,
                    "timeframe": "1",
                    "event": "BUY" if intent.event_type == "BUY" else "SELL",
                    "side": "BUY" if intent.event_type == "BUY" else "SELL",
                    "reduceOnly": intent.event_type == "EXIT",
                    "leverage": 1,
                    "timestamp": bar.time,
                    "referencePrice": str(execution_price(bar.close, intent.event_type, model)),
                    "volatilityPercent": float((bar.high - bar.low) / bar.close * 100),
                }
                if intent.event_type == "BUY":
                    signal.update(
                        stopLoss=str(intent.sl),
                        takeProfit=str(intent.tp),
                        riskMode="PERCENT_EQUITY",
                        riskValue=str(model.risk_percent),
                    )
                else:
                    signal["targetTradeId"] = intent.entry_ref
                context = RiskContext(
                    policy=risk_policy,
                    daily=DailyStats(stats.trades, stats.notional, stats.realized_r, loss_streak),
                    position=PositionState(quantity),
                    target_allocation=TargetAllocationState(target.quantity) if target else None,
                    now=bar.time,
                    equity=Decimal(amount(equity + cash - starting_cash + cost)),
                    balance=cash,
                    cash_available=Decimal(amount(cash / (1 + model.fee_bps / 10000)))
                    if intent.event_type == "BUY"
                    else cash,
                    committed_notional=cost,
                    open_positions=int(quantity > 0),
                )
                result = evaluate_risk(signal, context) if reason is None else None
                if result is not None and not result.ok:
                    reason = result.reason
                if reason is None:
                    try:
                        order, fee = round_order(result.order, model)
                    except ValueError as error:
                        reason = str(error)
                if reason:
                    decisions.append(
                        {
                            **event,
                            "outcome": "REJECTED",
                            "reason": reason,
                            "quantity": "0",
                            "fee": "0",
                        }
                    )
                    continue
                q, price, notional = (
                    Decimal(order["quantity"]),
                    Decimal(order["price"]),
                    Decimal(order["notional"]),
                )
                realized_r = Decimal(0)
                if intent.event_type == "BUY":
                    cash -= notional + fee
                    cost += notional + fee
                    quantity += q
                    initial_risk = Decimal(amount(initial_risk + q * abs(price - intent.sl)))
                    positions[intent.entry_ref] = Allocation(
                        q, Decimal(amount((notional + fee) / q))
                    )
                else:
                    removed = q * target.entry_price
                    profit = notional - removed - fee
                    cash += notional - fee
                    cost -= removed
                    quantity -= q
                    pnl = Decimal(amount(pnl + profit))
                    realized_r = profit / initial_risk if initial_risk > 0 else Decimal(0)
                    del positions[intent.entry_ref]
                    if quantity == 0:
                        loss_streak = loss_streak + 1 if pnl < 0 else 0
                        initial_risk = pnl = Decimal(0)
                if cash < 0 or quantity < 0 or cost < 0:
                    raise ValueError("NEGATIVE_SPOT_LEDGER")
                daily[day] = DailyStats(
                    stats.trades + 1,
                    Decimal(amount(stats.notional + notional)),
                    Decimal(amount(stats.realized_r + Decimal(amount(realized_r)))),
                    loss_streak,
                )
                fill = {
                    **event,
                    "outcome": "FILLED",
                    "sizing_outcome": "CAPPED" if order.get("sizingAdjustment") else "ACCEPTED",
                    "sizing_adjustment": order.get("sizingAdjustment"),
                    "quantity": amount(q),
                    "price": str(price),
                    "notional": amount(notional),
                    "fee": amount(fee),
                    "cash": amount(cash),
                    "cost": amount(cost),
                    "realized_r": amount(realized_r),
                }
                fills.append(fill)
                decisions.append(fill)
        return {
            "events": events,
            "decisions": decisions,
            "fills": fills,
            "final_cash": amount(cash),
            "position_quantity": amount(quantity),
            "position_cost": amount(cost),
            "open_allocations": len(positions),
        }
