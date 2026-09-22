"""Risk simulation preview generator.

Produces pre-flight sizing estimates, consumed/free capital breakdowns,
position capacity calculations, and active constraint audits based on
a frozen RiskProfile snapshot.
"""

from dataclasses import dataclass
from decimal import Decimal, localcontext

from robot_quant.analytics import PRECISION_CONTEXT
from robot_quant.contracts import RiskProfile


@dataclass(frozen=True)
class RiskSimulationPreview:
    initial_capital: Decimal
    available_balance: Decimal
    reference_price: Decimal
    requested_risk_percent: Decimal
    effective_order_notional: Decimal
    effective_quantity: Decimal
    consumed_capital: Decimal
    free_capital: Decimal
    position_capacity: int
    daily_trades_capacity: int
    active_limiting_rules: tuple[str, ...]
    disclaimer: str = (
        "This preview is an estimate based on the recorded snapshot and "
        "does not guarantee that a later order will be accepted by VPS risk checks."
    )

    def to_dict(self) -> dict[str, object]:
        return {
            "initial_capital": str(self.initial_capital),
            "available_balance": str(self.available_balance),
            "reference_price": str(self.reference_price),
            "requested_risk_percent": str(self.requested_risk_percent),
            "effective_order_notional": str(self.effective_order_notional),
            "effective_quantity": str(self.effective_quantity),
            "consumed_capital": str(self.consumed_capital),
            "free_capital": str(self.free_capital),
            "position_capacity": self.position_capacity,
            "daily_trades_capacity": self.daily_trades_capacity,
            "active_limiting_rules": list(self.active_limiting_rules),
            "disclaimer": self.disclaimer,
        }


def generate_risk_preview(
    profile: RiskProfile,
    reference_price: Decimal,
    fee_bps: Decimal = Decimal("10"),
    lot_size_step: Decimal = Decimal("0.0001"),
) -> RiskSimulationPreview:
    """Calculate pre-flight risk sizing, capital consumption, and limiting rules."""
    if reference_price <= Decimal("0"):
        raise ValueError("Reference price must be positive")

    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT

        balance = profile.balance
        requested_pct = profile.requested_risk_percent
        max_pct = profile.max_risk_percent
        max_order_notional = profile.max_order_notional
        max_daily_notional = profile.max_daily_notional
        fee_rate = fee_bps / Decimal("10000")

        limiting_rules: list[str] = []

        # 1. Requested notional calculation
        effective_pct = min(requested_pct, max_pct)
        if requested_pct > max_pct:
            limiting_rules.append(
                f"Requested risk {requested_pct}% capped by hard ceiling {max_pct}%"
            )

        raw_notional = balance * (effective_pct / Decimal("100"))
        effective_notional = raw_notional

        # 2. Check max order notional cap
        if effective_notional > max_order_notional:
            effective_notional = max_order_notional
            limiting_rules.append(f"Notional capped by max_order_notional ({max_order_notional})")

        # 3. Check available balance
        if effective_notional > balance:
            effective_notional = balance
            limiting_rules.append("Notional capped by available cash balance")

        # 4. Quantity calculation with fee
        if effective_notional <= Decimal("0"):
            effective_qty = Decimal("0")
            consumed_capital = Decimal("0")
        else:
            raw_qty = effective_notional / (reference_price * (Decimal("1") + fee_rate))
            # Lot step rounding
            effective_qty = (raw_qty // lot_size_step) * lot_size_step
            if effective_qty < raw_qty:
                limiting_rules.append(f"Quantity rounded down to lot step ({lot_size_step})")

            notional = effective_qty * reference_price
            fee = notional * fee_rate
            consumed_capital = notional + fee

        free_capital = max(Decimal("0"), balance - consumed_capital)

        # 5. Position capacity
        if consumed_capital > Decimal("0"):
            pos_capacity = int(balance // consumed_capital)
        else:
            pos_capacity = 0

        # 6. Daily trades capacity
        if effective_notional > Decimal("0"):
            daily_capacity = int(max_daily_notional // effective_notional)
        else:
            daily_capacity = 0

        return RiskSimulationPreview(
            initial_capital=profile.initial_capital,
            available_balance=balance,
            reference_price=reference_price,
            requested_risk_percent=requested_pct,
            effective_order_notional=effective_notional,
            effective_quantity=effective_qty,
            consumed_capital=consumed_capital,
            free_capital=free_capital,
            position_capacity=pos_capacity,
            daily_trades_capacity=daily_capacity,
            active_limiting_rules=tuple(limiting_rules),
        )
