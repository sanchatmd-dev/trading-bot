"""High-precision FIFO analytics engine matching src/postgres/analytics.js.

All monetary calculations use Decimal with an 80-digit precision context to guarantee
bit-level equivalence with PostgreSQL NUMERIC(38,18) and decimal.js calculations.
"""

from dataclasses import dataclass, field
from decimal import ROUND_DOWN, ROUND_HALF_EVEN, Decimal, localcontext
from typing import Any

from robot_quant.contracts import decimal_string

PRECISION_CONTEXT = 80


def D(value: Any) -> Decimal:
    """Convert any number or string to Decimal safely."""
    if isinstance(value, Decimal):
        return value
    return decimal_string(str(value))


def amount(value: Any) -> str:
    """Format to 18 decimal places using ROUND_HALF_EVEN."""
    d = D(value)
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        return str(d.quantize(Decimal("1e-18"), rounding=ROUND_HALF_EVEN))


def down(value: Any) -> str:
    """Format to 18 decimal places using ROUND_DOWN."""
    d = D(value)
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        return str(d.quantize(Decimal("1e-18"), rounding=ROUND_DOWN))


def ratio(a: Any, b: Any) -> float | None:
    """Ratio rounded to 8 decimal places, or None if b is zero."""
    da = D(a)
    db = D(b)
    if db == 0:
        return None
    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        res = (da / db).quantize(Decimal("1e-8"), rounding=ROUND_HALF_EVEN)
        return float(res)


def percent(a: Any, b: Any) -> float | None:
    """Percentage ratio (a * 100 / b)."""
    return ratio(D(a) * Decimal(100), b)


def currency_for_broker(broker: str) -> str:
    return "USDT" if broker == "binance-global" else "THB"


@dataclass(frozen=True)
class RealizationEvent:
    trade_id: str
    cycle_id: str
    broker: str
    currency: str
    symbol: str
    quantity: str
    entry_price: str
    exit_price: str
    entry_at: int
    exit_at: int
    holding_ms: int
    gross_pnl: str
    fees: str
    net_pnl: str
    return_percent: float | None


@dataclass(frozen=True)
class LegacyAdjustment:
    signal_id: int
    quantity_delta: str
    reason: str
    ledger_changed: bool = False


@dataclass
class BookLot:
    qty: Decimal
    cost: Decimal
    fee: Decimal
    time: int


@dataclass
class Book:
    cycle_id: str
    lots: list[BookLot] = field(default_factory=list)
    qty: Decimal = Decimal(0)
    cost: Decimal = Decimal(0)
    proceeds: Decimal = Decimal(0)
    fees: Decimal = Decimal(0)
    entry_fees: Decimal = Decimal(0)
    entry_time: Decimal = Decimal(0)
    holding: Decimal = Decimal(0)
    legacy: bool = False


def fifo_analytics(
    rows: list[dict[str, Any]], fee_bps: int | Decimal = 0
) -> tuple[list[RealizationEvent], list[RealizationEvent], list[LegacyAdjustment]]:
    """Calculate FIFO realizations and completed flat-to-flat cycles."""
    fee_bps_d = Decimal(str(fee_bps))
    books: dict[tuple[str, str, str, str], Book] = {}
    realizations: list[RealizationEvent] = []
    closed_positions: list[RealizationEvent] = []
    legacy_adjustments: list[LegacyAdjustment] = []

    # Sort deterministically: received_at ASC, signal_id ASC, cumulative_quantity ASC
    sorted_rows = sorted(
        rows,
        key=lambda r: (
            int(r.get("received_at", 0)),
            int(r.get("signal_id", 0)),
            D(r.get("cumulative_quantity", 0)),
        ),
    )

    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        for row in sorted_rows:
            qty = D(row["quantity"])
            price = D(row["price"])
            quote_raw = row.get("quote_amount")
            quote = D(quote_raw) if quote_raw is not None else (qty * price)
            recorded_fee = D(row.get("fee_quote", 0))
            custom_fee = (quote * fee_bps_d) / Decimal(10000)
            fee = recorded_fee + custom_fee

            if qty <= 0 or price <= 0 or fee < 0:
                raise ValueError("Invalid analytics fill")

            user_id = str(row.get("user_id", ""))
            broker = str(row["broker"])
            execution_mode = str(row.get("execution_mode", "PAPER"))
            symbol = str(row["symbol"])
            key = (user_id, broker, execution_mode, symbol)

            side = str(row["side"]).upper()
            if side == "BUY":
                if key not in books:
                    cycle_id = f"{row.get('signal_id', '')}:{row.get('cumulative_quantity', '')}"
                    books[key] = Book(cycle_id=cycle_id)
                book = books[key]
                if row.get("legacy_float") == 1:
                    book.legacy = True
                book.lots.append(
                    BookLot(qty=qty, cost=quote, fee=fee, time=int(row["received_at"]))
                )
                continue

            if side != "SELL":
                continue

            if key not in books or not books[key].lots:
                raise ValueError("Analytics SELL exceeds recorded FIFO inventory")

            book = books[key]
            inventory = sum((lot.qty for lot in book.lots), Decimal(0))
            difference = inventory - qty

            # Imported SQLite cycles used floating-point dust cutoffs
            is_legacy = book.legacy or row.get("legacy_float") == 1
            if is_legacy and difference != 0 and abs(difference) <= Decimal("1e-12"):
                legacy_adjustments.append(
                    LegacyAdjustment(
                        signal_id=int(row["signal_id"]),
                        quantity_delta=str(difference),
                        reason="LEGACY_FLOAT_NEAR_FLAT",
                        ledger_changed=False,
                    )
                )
                qty = inventory

            remaining = qty
            cost = Decimal(0)
            entry_fees = Decimal(0)
            weighted_time = Decimal(0)

            while remaining > 0 and book.lots:
                lot = book.lots[0]
                take = min(remaining, lot.qty)
                if take == lot.qty:
                    allocated_fee = lot.fee
                    allocated_cost = lot.cost
                else:
                    allocated_fee = (lot.fee * take) / lot.qty
                    allocated_cost = (lot.cost * take) / lot.qty

                cost += allocated_cost
                entry_fees += allocated_fee
                weighted_time += take * Decimal(lot.time)

                lot.qty -= take
                lot.cost -= allocated_cost
                lot.fee -= allocated_fee
                remaining -= take

                if lot.qty == 0:
                    book.lots.pop(0)

            if remaining > 0:
                raise ValueError(f"Analytics SELL exceeds recorded FIFO inventory by {remaining}")

            proceeds = quote
            total_fees = entry_fees + fee
            net_pnl = proceeds - cost - total_fees
            entry_at = weighted_time / qty
            holding_ms = max(Decimal(0), Decimal(row["received_at"]) - entry_at)

            ret_pct = percent(net_pnl, cost + entry_fees) if (cost + entry_fees) > 0 else None

            event = RealizationEvent(
                trade_id=str(row.get("trade_id", "")),
                cycle_id=book.cycle_id,
                broker=broker,
                currency=currency_for_broker(broker),
                symbol=symbol,
                quantity=amount(qty),
                entry_price=amount(cost / qty),
                exit_price=amount(price),
                entry_at=round(float(entry_at)),
                exit_at=int(row["received_at"]),
                holding_ms=round(float(holding_ms)),
                gross_pnl=amount(proceeds - cost),
                fees=amount(total_fees),
                net_pnl=amount(net_pnl),
                return_percent=ret_pct,
            )
            realizations.append(event)

            book.qty += qty
            book.cost += cost
            book.proceeds += proceeds
            book.fees += total_fees
            book.entry_fees += entry_fees
            book.entry_time += weighted_time
            book.holding += holding_ms * qty

            if not book.lots:
                cycle_net = book.proceeds - book.cost - book.fees
                cycle_ret_pct = (
                    percent(cycle_net, book.cost + book.entry_fees)
                    if (book.cost + book.entry_fees) > 0
                    else None
                )
                closed_positions.append(
                    RealizationEvent(
                        trade_id=event.trade_id,
                        cycle_id=book.cycle_id,
                        broker=broker,
                        currency=currency_for_broker(broker),
                        symbol=symbol,
                        quantity=amount(book.qty),
                        entry_price=amount(book.cost / book.qty),
                        exit_price=amount(book.proceeds / book.qty),
                        entry_at=round(float(book.entry_time / book.qty)),
                        exit_at=int(row["received_at"]),
                        holding_ms=round(float(book.holding / book.qty)),
                        gross_pnl=amount(book.proceeds - book.cost),
                        fees=amount(book.fees),
                        net_pnl=amount(cycle_net),
                        return_percent=cycle_ret_pct,
                    )
                )
                del books[key]

    return realizations, closed_positions, legacy_adjustments


@dataclass(frozen=True)
class EquityCurvePoint:
    time: int
    cumulative_pnl: str
    equity: str | None
    drawdown: str
    drawdown_percent: float | None


@dataclass(frozen=True)
class SummaryMetrics:
    currency: str
    total_trades: int
    wins: int
    losses: int
    breakeven: int
    win_rate: float
    net_profit: str
    closed_net_profit: str
    net_profit_percent: float | None
    profit_factor: float | None
    max_drawdown: str
    max_drawdown_percent: float | None
    expectancy: str
    avg_win: str
    avg_loss: str
    avg_win_loss_ratio: float | None
    max_consecutive_wins: int
    max_consecutive_losses: int
    average_holding_ms: int
    fee_impact: str
    starting_equity: str | None
    equity_curve: list[EquityCurvePoint]


def summarize_closed_positions(
    closed: list[RealizationEvent],
    starting_equity: Any = Decimal(0),
    currency: str = "USDT",
    realizations: list[RealizationEvent] | None = None,
    percentages_available: bool = True,
) -> SummaryMetrics:
    """Summarize closed positions and compute performance metrics."""
    events = realizations if realizations is not None else closed
    rows = sorted(closed, key=lambda r: r.exit_at)

    with localcontext() as ctx:
        ctx.prec = PRECISION_CONTEXT
        wins = [r for r in rows if D(r.net_pnl) > 0]
        losses = [r for r in rows if D(r.net_pnl) < 0]

        net = sum((D(r.net_pnl) for r in events), Decimal(0))
        closed_net = sum((D(r.net_pnl) for r in rows), Decimal(0))
        gross_wins = sum((D(r.net_pnl) for r in wins), Decimal(0))
        gross_losses = abs(sum((D(r.net_pnl) for r in losses), Decimal(0)))

        avg_win = gross_wins / len(wins) if wins else Decimal(0)
        avg_loss = gross_losses / len(losses) if losses else Decimal(0)

        cw = 0
        cl = 0
        mw = 0
        ml = 0
        for r in rows:
            pnl = D(r.net_pnl)
            if pnl > 0:
                cw += 1
                cl = 0
                mw = max(mw, cw)
            elif pnl < 0:
                cl += 1
                cw = 0
                ml = max(ml, cl)
            else:
                cw = 0
                cl = 0

        start_eq = D(starting_equity) if starting_equity is not None else None
        show_percent = percentages_available and start_eq is not None and start_eq > 0

        running = Decimal(0)
        peak = start_eq if start_eq is not None else Decimal(0)
        mdd = Decimal(0)
        mdd_percent = 0.0

        equity_curve: list[EquityCurvePoint] = []
        sorted_events = sorted(events, key=lambda r: r.exit_at)
        for r in sorted_events:
            running += D(r.net_pnl)
            eq = (start_eq + running) if start_eq is not None else None
            if eq is not None:
                peak = max(peak, eq)
                dd = min(Decimal(0), eq - peak)
                dp = float(percent(dd, peak)) if peak > 0 else 0.0
            else:
                dd = min(Decimal(0), running)
                dp = 0.0

            mdd = min(mdd, dd)
            mdd_percent = min(mdd_percent, dp)

            equity_curve.append(
                EquityCurvePoint(
                    time=r.exit_at,
                    cumulative_pnl=amount(running),
                    equity=amount(eq) if eq is not None else None,
                    drawdown=amount(dd),
                    drawdown_percent=round(dp, 8) if show_percent else None,
                )
            )

        total_trades = len(rows)
        win_rate = (len(wins) / total_trades * 100.0) if total_trades else 0.0
        profit_factor = ratio(gross_wins, gross_losses) if gross_losses > 0 else None
        fee_impact = sum((D(r.fees) for r in events), Decimal(0))
        expectancy_val = (closed_net / total_trades) if total_trades else Decimal(0)
        avg_holding = (
            round(sum(r.holding_ms for r in rows) / total_trades) if total_trades else 0
        )

        return SummaryMetrics(
            currency=currency,
            total_trades=total_trades,
            wins=len(wins),
            losses=len(losses),
            breakeven=total_trades - len(wins) - len(losses),
            win_rate=round(win_rate, 8),
            net_profit=amount(net),
            closed_net_profit=amount(closed_net),
            net_profit_percent=percent(net, start_eq) if show_percent else None,
            profit_factor=profit_factor,
            max_drawdown=amount(mdd),
            max_drawdown_percent=round(mdd_percent, 8) if show_percent else None,
            expectancy=amount(expectancy_val),
            avg_win=amount(avg_win),
            avg_loss=amount(avg_loss),
            avg_win_loss_ratio=ratio(avg_win, avg_loss) if avg_loss > 0 else None,
            max_consecutive_wins=mw,
            max_consecutive_losses=ml,
            average_holding_ms=avg_holding,
            fee_impact=amount(fee_impact),
            starting_equity=amount(start_eq) if start_eq is not None else None,
            equity_curve=equity_curve,
        )
