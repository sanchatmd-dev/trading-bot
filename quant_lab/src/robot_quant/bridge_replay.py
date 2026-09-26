"""Causal Bridge intents, separate from accepted Paper allocations.

This is the bridge-exit-v2 calculation contract, not the synthetic EMA backtest.
An intent remains in Pine's arrays even if the Paper worker rejects its BUY.
"""

from dataclasses import dataclass
from decimal import ROUND_CEILING, ROUND_FLOOR, Decimal, localcontext
from typing import Literal

from robot_quant.analytics import PRECISION_CONTEXT, amount


@dataclass(frozen=True)
class BridgeBar:
    time: int  # closed-bar UTC milliseconds, never CSV bar-open time
    open: Decimal
    high: Decimal
    low: Decimal
    close: Decimal
    volume: Decimal
    atr14: Decimal | None

    def __post_init__(self):
        values = [self.open, self.high, self.low, self.close, self.volume]
        if any(not v.is_finite() for v in values) or self.volume < 0:
            raise ValueError("INVALID_MARKET_BAR")
        if not (
            0 < self.low <= min(self.open, self.close) <= max(self.open, self.close) <= self.high
        ):
            raise ValueError("INVALID_MARKET_BAR")
        if isinstance(self.time, bool) or not isinstance(self.time, int) or self.time <= 0:
            raise ValueError("INVALID_MARKET_BAR")
        if self.atr14 is not None and (not self.atr14.is_finite() or self.atr14 < 0):
            raise ValueError("INVALID_ATR")


@dataclass(frozen=True)
class PaperModel:
    price_tick: Decimal = Decimal("0.01")
    quantity_step: Decimal = Decimal("0.00001")
    fee_bps: Decimal = Decimal("10")
    slippage_bps: Decimal = Decimal("1")
    risk_percent: Decimal = Decimal("1")
    version: str = "paper-close-v1"

    def __post_init__(self):
        if self.version != "paper-close-v1":
            raise ValueError("UNSUPPORTED_EXECUTION_MODEL")
        if any(
            not v.is_finite() or v <= 0
            for v in [self.price_tick, self.quantity_step, self.risk_percent]
        ):
            raise ValueError("INVALID_EXECUTION_MODEL")
        if self.risk_percent > 100 or any(
            not v.is_finite() or not 0 <= v <= 1000 for v in [self.fee_bps, self.slippage_bps]
        ):
            raise ValueError("INVALID_EXECUTION_MODEL")


def tick_round(value: Decimal, tick: Decimal, *, upward: bool) -> Decimal:
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        return (value / tick).to_integral_value(
            rounding=ROUND_CEILING if upward else ROUND_FLOOR
        ) * tick


def entry_levels(
    close: Decimal, atr: Decimal, multiplier: Decimal, rr: Decimal, tick: Decimal
) -> tuple[Decimal, Decimal]:
    if any(not v.is_finite() or v <= 0 for v in [close, atr, multiplier, rr, tick]):
        raise ValueError("INVALID_ENTRY_LEVELS")
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        distance = atr * multiplier
        sl = tick_round(close - distance, tick, upward=False)
        tp = tick_round(close + distance * rr, tick, upward=True)
        if not 0 < sl < close < tp:
            raise ValueError("INVALID_ENTRY_LEVELS")
        return sl, tp


def execution_price(close: Decimal, event_type: str, model: PaperModel) -> Decimal:
    if event_type not in ["BUY", "EXIT"]:
        raise ValueError("INVALID_EVENT_TYPE")
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        adverse = model.slippage_bps / 10000 * (1 if event_type == "BUY" else -1)
        return tick_round(close * (1 + adverse), model.price_tick, upward=event_type == "BUY")


def round_order(order: dict, model: PaperModel) -> tuple[dict, Decimal]:
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        quantity = tick_round(Decimal(order["quantity"]), model.quantity_step, upward=False)
        if quantity <= 0:
            raise ValueError("BELOW_QUANTITY_STEP")
        notional = Decimal(amount(quantity * Decimal(order["price"])))
        fee = Decimal(amount(notional * model.fee_bps / 10000))
        rounded = {**order, "quantity": amount(quantity), "notional": amount(notional)}
        if quantity < Decimal(order["quantity"]):
            previous = order.get("sizingAdjustment", {})
            rounded["sizingAdjustment"] = {
                **previous,
                "requestedQuantity": previous.get(
                    "requestedQuantity", amount(Decimal(order["quantity"]))
                ),
                "quantity": amount(quantity),
                "reason": "Capped/rounded to verified venue quantity step",
            }
        return rounded, fee


@dataclass(frozen=True)
class BridgeEntry:
    time: int
    entry_ref: str
    sl: Decimal
    tp: Decimal


@dataclass(frozen=True)
class BridgeIntent:
    event_type: Literal["BUY", "EXIT"]
    time: int
    entry_ref: str
    sequence: int
    reason: str | None = None
    sl: Decimal | None = None
    tp: Decimal | None = None


def exit_reason(entry: BridgeEntry, bar: BridgeBar, native_exit: bool = False) -> str | None:
    if bar.time <= entry.time:
        return None
    if bar.low <= entry.sl:
        return "SL"
    if bar.high >= entry.tp:
        return "TP"
    return "NATIVE" if native_exit else None


class BridgeReplay:
    def __init__(self, deployment_id: str, multiplier: Decimal, rr: Decimal, model: PaperModel):
        if any(not v.is_finite() or v <= 0 for v in [multiplier, rr]):
            raise ValueError("INVALID_BRIDGE_SETTINGS")
        self.deployment_id = deployment_id
        self.multiplier, self.rr, self.model = multiplier, rr, model
        self.entries: list[BridgeEntry] = []
        self.last_time = 0

    def step(self, bar: BridgeBar, buy: bool, native_exit: bool) -> list[BridgeIntent]:
        if type(buy) is not bool or type(native_exit) is not bool:
            raise ValueError("BOOLEAN_SIGNAL_REQUIRED")
        if bar.time <= self.last_time:
            raise ValueError("NON_MONOTONIC_CLOSED_BARS")
        self.last_time = bar.time
        events: list[BridgeIntent] = []
        exit_bar = native_exit
        # Match Pine's descending array traversal, including sequence numbers.
        for i in range(len(self.entries) - 1, -1, -1):
            entry = self.entries[i]
            reason = exit_reason(entry, bar, native_exit)
            if reason:
                events.append(BridgeIntent("EXIT", bar.time, entry.entry_ref, len(events), reason))
                self.entries.pop(i)
                exit_bar = True
        if buy and not exit_bar and bar.atr14 is not None:
            try:
                sl, tp = entry_levels(
                    bar.close, bar.atr14, self.multiplier, self.rr, self.model.price_tick
                )
            except ValueError as error:
                if str(error) != "INVALID_ENTRY_LEVELS":
                    raise
                return events  # Pine suppresses an invalid entry; never moves SL.
            if len(self.entries) >= 1000:
                raise ValueError("BRIDGE_INTENT_CAPACITY_REACHED")
            ref = f"{self.deployment_id}:{bar.time}:0"
            self.entries.append(BridgeEntry(bar.time, ref, sl, tp))
            events.append(BridgeIntent("BUY", bar.time, ref, 0, sl=sl, tp=tp))
        return events
