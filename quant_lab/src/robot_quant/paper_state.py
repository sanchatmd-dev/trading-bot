"""Serial offline fully-filled Paper projection under a frozen Node policy.

This profile does not model pending orders, unknown broker outcomes, intrabar
fills, owner authentication or concurrent Bots. Those runtime proofs are APP-3A/B.
"""

from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from decimal import Decimal, localcontext

from robot_quant.analytics import PRECISION_CONTEXT, amount
from robot_quant.bridge_replay import (
    BridgeReplay,
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


class PaperState:
    """Incremental form of the unchanged serial Paper reference loop."""

    def __init__(self, *, deployment_id, multiplier, rr, model, policy, equity, cash,
                 broker, symbol, start_time=None):
        self.risk_policy = node_policy(policy)
        self.replay = BridgeReplay(deployment_id, multiplier, rr, model)
        self.model, self.equity, self.cash = model, equity, cash
        self.broker, self.symbol, self.start_time = broker, symbol, start_time
        self.starting_cash = cash
        self.positions = {}
        self.daily = {}
        self.quantity = self.cost = self.initial_risk = self.pnl = Decimal(0)
        self.loss_streak = 0

    def step(self, bar, buy, native_exit):
        with localcontext() as ctx:
            ctx.prec = PRECISION_CONTEXT
            events, decisions, fills = [], [], []
            for intent in self.replay.step(bar, buy, native_exit):
                event = asdict(intent)
                event["sl"] = str(intent.sl) if intent.sl is not None else None
                event["tp"] = str(intent.tp) if intent.tp is not None else None
                events.append(event)
                if self.start_time is not None and bar.time < self.start_time:
                    continue  # warm Pine state, but do not start the Bot ledger early
                target = self.positions.get(intent.entry_ref)
                reason = (
                    "TARGET_NOT_OPEN" if intent.event_type == "EXIT" and target is None else None
                )
                day = datetime.fromtimestamp(bar.time / 1000, UTC).date().isoformat()
                stats = self.daily.get(day, DailyStats())
                signal = {
                    "broker": self.broker,
                    "symbol": self.symbol,
                    "timeframe": "1",
                    "event": "BUY" if intent.event_type == "BUY" else "SELL",
                    "side": "BUY" if intent.event_type == "BUY" else "SELL",
                    "reduceOnly": intent.event_type == "EXIT",
                    "leverage": 1,
                    "timestamp": bar.time,
                    "referencePrice": str(execution_price(bar.close, intent.event_type, self.model)),
                    "volatilityPercent": float((bar.high - bar.low) / bar.close * 100),
                }
                if intent.event_type == "BUY":
                    signal.update(
                        stopLoss=str(intent.sl),
                        takeProfit=str(intent.tp),
                        riskMode="PERCENT_EQUITY",
                        riskValue=str(self.model.risk_percent),
                    )
                else:
                    signal["targetTradeId"] = intent.entry_ref
                context = RiskContext(
                    policy=self.risk_policy,
                    daily=DailyStats(stats.trades, stats.notional, stats.realized_r, self.loss_streak),
                    position=PositionState(self.quantity),
                    target_allocation=TargetAllocationState(target.quantity) if target else None,
                    now=bar.time,
                    equity=Decimal(amount(self.equity + self.cash - self.starting_cash + self.cost)),
                    balance=self.cash,
                    cash_available=Decimal(amount(self.cash / (1 + self.model.fee_bps / 10000)))
                    if intent.event_type == "BUY"
                    else self.cash,
                    committed_notional=self.cost,
                    open_positions=int(self.quantity > 0),
                )
                result = evaluate_risk(signal, context) if reason is None else None
                if result is not None and not result.ok:
                    reason = result.reason
                if reason is None:
                    try:
                        order, fee = round_order(result.order, self.model)
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
                    self.cash -= notional + fee
                    self.cost += notional + fee
                    self.quantity += q
                    self.initial_risk = Decimal(amount(self.initial_risk + q * abs(price - intent.sl)))
                    self.positions[intent.entry_ref] = Allocation(
                        q, Decimal(amount((notional + fee) / q))
                    )
                else:
                    removed = q * target.entry_price
                    profit = notional - removed - fee
                    self.cash += notional - fee
                    self.cost -= removed
                    self.quantity -= q
                    self.pnl = Decimal(amount(self.pnl + profit))
                    realized_r = profit / self.initial_risk if self.initial_risk > 0 else Decimal(0)
                    del self.positions[intent.entry_ref]
                    if self.quantity == 0:
                        self.loss_streak = self.loss_streak + 1 if self.pnl < 0 else 0
                        self.initial_risk = self.pnl = Decimal(0)
                if self.cash < 0 or self.quantity < 0 or self.cost < 0:
                    raise ValueError("NEGATIVE_SPOT_LEDGER")
                self.daily[day] = DailyStats(
                    stats.trades + 1,
                    Decimal(amount(stats.notional + notional)),
                    Decimal(amount(stats.realized_r + Decimal(amount(realized_r)))),
                    self.loss_streak,
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
                    "cash": amount(self.cash),
                    "cost": amount(self.cost),
                    "realized_r": amount(realized_r),
                }
                fills.append(fill)
                decisions.append(fill)
            return {"events": events, "decisions": decisions, "fills": fills}

    def export_state(self):
        return {
            "cash": str(self.cash), "quantity": str(self.quantity), "cost": str(self.cost),
            "initial_risk": str(self.initial_risk), "pnl": str(self.pnl),
            "loss_streak": self.loss_streak, "last_time": self.replay.last_time,
            "entries": [{"time": e.time, "entry_ref": e.entry_ref, "sl": str(e.sl), "tp": str(e.tp)}
                        for e in self.replay.entries],
            "positions": {ref: {"quantity": str(a.quantity), "entry_price": str(a.entry_price)}
                          for ref, a in self.positions.items()},
            "daily": {day: {"trades": d.trades, "notional": str(d.notional),
                             "realized_r": str(d.realized_r), "loss_streak": d.loss_streak}
                      for day, d in self.daily.items()},
        }

    def import_state(self, state):
        from robot_quant.bridge_replay import BridgeEntry
        expected = {"cash", "quantity", "cost", "initial_risk", "pnl", "loss_streak",
                    "last_time", "entries", "positions", "daily"}
        if set(state) != expected or len(state["entries"]) > 1000 or len(state["positions"]) > 1000 or len(state["daily"]) > 9:
            raise ValueError("INVALID_PAPER_STATE")
        for name in ("cash", "quantity", "cost", "initial_risk", "pnl"):
            setattr(self, name, finite_decimal(state[name]))
        for name in ("loss_streak", "last_time"):
            if type(state[name]) is not int or state[name] < 0:
                raise ValueError("INVALID_PAPER_STATE")
        if min(self.cash, self.quantity, self.cost, self.initial_risk) < 0:
            raise ValueError("INVALID_PAPER_STATE")
        self.loss_streak = state["loss_streak"]
        self.replay.last_time = state["last_time"]
        self.replay.entries = []
        for e in state["entries"]:
            if set(e) != {"time", "entry_ref", "sl", "tp"} or type(e["time"]) is not int or not 0 < e["time"] <= self.replay.last_time or e["entry_ref"] != f'{self.replay.deployment_id}:{e["time"]}:0':
                raise ValueError("INVALID_PAPER_STATE")
            sl, tp = finite_decimal(e["sl"]), finite_decimal(e["tp"])
            if not 0 < sl < tp:
                raise ValueError("INVALID_PAPER_STATE")
            self.replay.entries.append(BridgeEntry(e["time"], e["entry_ref"], sl, tp))
        if len({e.entry_ref for e in self.replay.entries}) != len(self.replay.entries):
            raise ValueError("INVALID_PAPER_STATE")
        if any(a.time >= b.time for a, b in zip(self.replay.entries, self.replay.entries[1:], strict=False)):
            raise ValueError("INVALID_PAPER_STATE")
        self.positions = {}
        for ref, a in state["positions"].items():
            if set(a) != {"quantity", "entry_price"} or not isinstance(ref, str) or not ref.startswith(self.replay.deployment_id + ":"):
                raise ValueError("INVALID_PAPER_STATE")
            suffix = ref[len(self.replay.deployment_id) + 1:].split(":")
            if len(suffix) != 2 or not suffix[0].isdigit() or suffix[1] != "0" or not 0 < int(suffix[0]) <= self.replay.last_time:
                raise ValueError("INVALID_PAPER_STATE")
            q, price = finite_decimal(a["quantity"]), finite_decimal(a["entry_price"])
            if q <= 0 or price <= 0:
                raise ValueError("INVALID_PAPER_STATE")
            self.positions[ref] = Allocation(q, price)
        if sum((a.quantity for a in self.positions.values()), Decimal(0)) != self.quantity:
            raise ValueError("INVALID_PAPER_STATE")
        self.daily = {}
        for day, d in state["daily"].items():
            if set(d) != {"trades", "notional", "realized_r", "loss_streak"} or type(d["trades"]) is not int or type(d["loss_streak"]) is not int or min(d["trades"], d["loss_streak"]) < 0:
                raise ValueError("INVALID_PAPER_STATE")
            datetime.strptime(day, "%Y-%m-%d")
            notional = finite_decimal(d["notional"])
            if notional < 0:
                raise ValueError("INVALID_PAPER_STATE")
            self.daily[day] = DailyStats(d["trades"], notional, finite_decimal(d["realized_r"]), d["loss_streak"])


def finite_decimal(value):
    if not isinstance(value, str):
        raise ValueError("INVALID_DECIMAL_STATE")
    result = Decimal(value)
    if not result.is_finite():
        raise ValueError("INVALID_DECIMAL_STATE")
    return result
