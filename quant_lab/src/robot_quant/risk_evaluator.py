"""Pure Python risk evaluator matching src/postgres/risk.js.

Evaluates signals deterministically against account policies, daily exposure,
capital availability, volatility/news guards, and sizing rules.
"""

from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Any

from robot_quant.analytics import PRECISION_CONTEXT, D, amount, down


@dataclass(frozen=True)
class RiskPolicy:
    kill_switch: bool = False
    max_signal_age_seconds: int = 120
    max_trades_per_day: int = 50
    max_daily_loss_r: Decimal = Decimal("5")
    pause_after_loss_streak: int = 3
    block_high_volatility: bool = False
    max_volatility_percent: float = 5.0
    block_during_news: bool = False
    allowed_symbols: tuple[str, ...] = ()
    side_mode: str = "BOTH"  # BOTH, BUY_ONLY, SELL_ONLY
    max_open_positions: int = 5
    one_position_per_symbol: bool = False
    cap_percent_equity_size: bool = True
    max_risk_percent: Decimal = Decimal("100")
    max_order_notional: Decimal = Decimal("10000")
    max_daily_notional: Decimal = Decimal("100000")


@dataclass(frozen=True)
class DailyStats:
    trades: int = 0
    notional: Decimal = Decimal(0)
    realized_r: Decimal = Decimal(0)
    loss_streak: int = 0


@dataclass(frozen=True)
class PositionState:
    quantity: Decimal = Decimal(0)


@dataclass(frozen=True)
class TargetAllocationState:
    remaining_quantity: Decimal

@dataclass(frozen=True)
class RiskContext:
    policy: RiskPolicy
    daily: DailyStats = DailyStats()
    position: PositionState = PositionState()
    target_allocation: TargetAllocationState | None = None
    now: int = 0
    equity: Decimal = Decimal(1000)
    balance: Decimal | None = None
    cash_available: Decimal | None = None
    committed_notional: Decimal = Decimal(0)
    reserved_notional: Decimal = Decimal(0)
    reserved_trades: int = 0
    open_positions: int = 0
    licensed: bool = True
    global_kill: bool = False
    has_pending_order: bool = False


@dataclass(frozen=True)
class RiskEvaluationResult:
    ok: bool
    reason: str | None = None
    order: dict[str, Any] | None = None


def normalize_symbol(symbol: str, broker: str) -> str:
    """Normalize symbols and USD aliases according to broker rules."""
    s = symbol.replace("/", "").replace(":", "")
    if broker == "binance-global":
        if s.startswith("BINANCE"):
            s = s[7:]
        if s.endswith("USD") and not s.endswith("USDT"):
            s = s + "T"
    return s


def evaluate_risk(signal: dict[str, Any], context: RiskContext) -> RiskEvaluationResult:
    """Evaluate a signal against the policy context."""
    policy = context.policy
    daily = context.daily
    position = context.position
    now = context.now or int(signal.get("timestamp", 0))

    def reject(reason: str) -> RiskEvaluationResult:
        return RiskEvaluationResult(ok=False, reason=reason)

    broker = str(signal.get("broker", ""))
    is_spot = broker in ["binance-global", "binance-th", "innovestx", "settrade"]
    if not is_spot:
        return reject("Only Spot simulation is supported in this release")

    quote_currency = "USDT" if broker == "binance-global" else "THB"
    symbol = str(signal.get("symbol", ""))
    if broker.startswith("binance-") and not symbol.endswith(quote_currency):
        return reject(f"This account supports {quote_currency} quote currency only")

    reduce_only = bool(signal.get("reduceOnly", signal.get("reduce_only", False)))
    is_exit = is_spot and signal.get("side") == "SELL" and reduce_only

    if not is_exit and (context.global_kill or policy.kill_switch):
        return reject("Kill switch is active: entries paused")
    if not is_exit and not context.licensed:
        return reject("License is inactive or expired")

    timestamp = int(signal.get("timestamp", 0))
    if now - timestamp > policy.max_signal_age_seconds * 1000:
        return reject("Signal is stale")

    if not is_exit and daily.trades + context.reserved_trades >= policy.max_trades_per_day:
        return reject("Maximum trades per day reached")

    if not is_exit and daily.realized_r <= -abs(policy.max_daily_loss_r):
        return reject("Maximum daily loss reached")

    if not is_exit and daily.loss_streak >= policy.pause_after_loss_streak:
        return reject("Trading paused after loss streak")

    if not is_exit and policy.block_high_volatility:
        vol = signal.get("volatilityPercent", signal.get("volatility_percent"))
        if vol is None or not isinstance(vol, (int, float)):
            return reject("Missing volatility data")
        if float(vol) > policy.max_volatility_percent:
            return reject("High volatility block is active")

    if not is_exit and policy.block_during_news:
        news = signal.get("newsRisk", signal.get("news_risk"))
        if not isinstance(news, bool):
            return reject("Missing news risk data")
        if news:
            return reject("News trading block is active")

    if not is_exit and policy.allowed_symbols:
        normalized = [normalize_symbol(s, broker) for s in policy.allowed_symbols]
        if symbol not in normalized:
            return reject("Symbol is not allowed")

    side = signal.get("side")
    if policy.side_mode == "BUY_ONLY" and side != "BUY" and not is_exit:
        return reject("Only BUY is allowed")
    if policy.side_mode == "SELL_ONLY" and side != "SELL":
        return reject("Only SELL is allowed")

    opens_new_symbol = side == "BUY" and position.quantity <= 0 and not context.has_pending_order
    if opens_new_symbol and context.open_positions >= policy.max_open_positions:
        return reject("Maximum open positions reached")

    has_existing = position.quantity > 0 or context.has_pending_order
    if side == "BUY" and policy.one_position_per_symbol and has_existing:
        return reject("Position or pending order already exists for symbol")

    if is_exit and context.has_pending_order:
        return reject("Pending order already reserves this symbol")

    if is_spot and signal.get("leverage", 1) != 1:
        return reject("Spot leverage must equal 1")

    if is_spot and side == "SELL" and not is_exit:
        return reject("Spot SELL must be reduce_only")

    if is_spot and side == "SELL" and position.quantity <= 0:
        return reject("No Spot position available to sell")

    try:
        with localcontext() as ctx:
            ctx.prec = PRECISION_CONTEXT
            raw_price = (
                signal.get("limitPrice")
                or signal.get("entry")
                or signal.get("referencePrice", 0)
            )
            price = D(raw_price) if raw_price is not None else Decimal(0)
            if price <= 0:
                return reject("entry/reference_price is required for risk checks")

            stop_raw = signal.get("stopLoss", signal.get("sl"))
            stop = D(stop_raw) if stop_raw is not None else None

            tp_raw = signal.get("takeProfit", signal.get("tp"))
            tp = D(tp_raw) if tp_raw is not None else None

            if side == "BUY" and stop and stop >= price:
                return reject("BUY stop loss must be below entry")
            if side == "BUY" and tp and tp <= price:
                return reject("BUY take profit must be above entry")

            equity = D(context.equity)
            balance = D(context.balance) if context.balance is not None else equity
            committed = D(context.committed_notional)
            reserved = D(context.reserved_notional)
            free_cash = (
                D(context.cash_available)
                if context.cash_available is not None
                else (balance - committed)
            )

            quantity: Decimal | None = None
            raw_qty = signal.get("quantity")
            if raw_qty is not None:
                quantity = D(raw_qty)

            quote_quantity = signal.get("quoteQuantity", signal.get("quote_quantity"))
            risk_mode = signal.get("riskMode", signal.get("risk_mode"))
            risk_val = signal.get("riskValue", signal.get("risk_value"))

            sizing_adjustment = None

            if is_exit and not quantity and not quote_quantity:
                if context.target_allocation:
                    quantity = context.target_allocation.remaining_quantity
                else:
                    quantity = position.quantity

            if not quantity and quote_quantity:
                quantity = D(down(D(quote_quantity) / price))

            if not quantity and risk_mode == "QUANTITY":
                quantity = D(risk_val)

            if not quantity and risk_mode == "FIXED_NOTIONAL":
                quantity = D(down(D(risk_val) / price))

            if not quantity and risk_mode == "PERCENT_EQUITY":
                if not stop:
                    return reject("stop_loss is required for Percent equity")
                if D(risk_val) > policy.max_risk_percent:
                    return reject("Risk percent exceeds policy")
                distance = abs(price - stop)
                if distance == 0:
                    return reject("Stop loss must differ from entry")

                quantity = D(down((equity * D(risk_val)) / Decimal(100) / distance))
                if side == "BUY" and policy.cap_percent_equity_size:
                    available = min(
                        equity - committed,
                        free_cash,
                        policy.max_order_notional,
                        policy.max_daily_notional - daily.notional - reserved,
                    )
                    if available <= 0:
                        return reject("No remaining Spot sizing budget")
                    requested_quantity = amount(quantity)
                    quantity = min(quantity, D(down(available / price)))
                    if quantity < D(requested_quantity):
                        sizing_adjustment = {
                            "requestedQuantity": requested_quantity,
                            "quantity": amount(quantity),
                            "reason": "Capped to available equity and notional limits",
                        }

            if not quantity or quantity <= 0:
                return reject("Unable to calculate quantity")

            if is_exit:
                target_trade_id = signal.get("targetTradeId", signal.get("target_trade_id"))
                if context.target_allocation:
                    alloc_rem = context.target_allocation.remaining_quantity
                    if alloc_rem <= 0:
                        return reject("Target allocation not found or already closed")
                    
                    if quantity > alloc_rem:
                        sizing_adjustment = {
                            "requestedQuantity": amount(quantity),
                            "quantity": amount(alloc_rem),
                            "reason": "Capped to remaining target allocation quantity",
                        }
                        quantity = alloc_rem
                else:
                    if target_trade_id:
                        return reject("Target allocation not found or already closed")
                    if quantity > position.quantity:
                        sizing_adjustment = {
                            "requestedQuantity": amount(quantity),
                            "quantity": amount(position.quantity),
                            "reason": "Capped to remaining aggregate position quantity",
                        }
                        quantity = position.quantity

            notional = D(amount(quantity * price))
            if notional <= 0:
                return reject("Invalid notional")

            if not is_exit:
                if equity <= 0:
                    return reject("Positive account equity is required")
                if not stop:
                    return reject("stop_loss is required for all entry sizing modes")
                if quantity * abs(price - stop) > (equity * policy.max_risk_percent) / Decimal(100):
                    return reject("Calculated risk exceeds maximum risk percent")
                if notional + committed > equity:
                    return reject("Order exceeds available configured Spot equity")
                if notional > free_cash:
                    return reject("Order exceeds available configured Spot balance")
                if notional > policy.max_order_notional:
                    return reject("Maximum order notional exceeded")
                if notional + daily.notional + reserved > policy.max_daily_notional:
                    return reject("Maximum daily notional exceeded")

            order_out = {
                **signal,
                "quantity": amount(quantity),
                "price": amount(price),
                "notional": amount(notional),
            }
            if sizing_adjustment:
                order_out["sizingAdjustment"] = sizing_adjustment

            return RiskEvaluationResult(ok=True, order=order_out)

    except Exception as e:
        return reject(str(e))
