"""Backtest simulation and ledger accounting engine.

Enforces Spot long-only execution, inventory-limited reduce-only exits,
cash non-negativity, fee/slippage modeling, and daily notional limits.
Generates an auditable transaction ledger (SignalRecord, FillRecord,
CashJournalRecord, PositionAllocationRecord) that reconciles exactly
with QL-2 FIFO analytics at 80-digit precision.
"""

from dataclasses import dataclass
from decimal import Decimal, localcontext
from typing import Any

import pandas as pd

from robot_quant.analytics import (
    PRECISION_CONTEXT,
    SummaryMetrics,
    fifo_analytics,
    summarize_closed_positions,
)
from robot_quant.contracts import RiskProfile
from robot_quant.market_data import Candle
from robot_quant.records import (
    CashJournalRecord,
    FillRecord,
    PositionAllocationRecord,
    SignalRecord,
)
from robot_quant.strategy import StrategySignal, SyntheticEmaStrategy


@dataclass(frozen=True)
class BacktestConfig:
    initial_capital: Decimal = Decimal("10000.00")
    max_risk_percent: Decimal = Decimal("100.0")
    # Fraction of available balance to allocate per trade
    requested_risk_percent: Decimal = Decimal("100.0")
    max_order_notional: Decimal = Decimal("10000.00")
    max_daily_notional: Decimal = Decimal("50000.00")
    fee_bps: Decimal = Decimal("10")  # 10 bps = 0.1%
    slippage_bps: Decimal = Decimal("5")  # 5 bps = 0.05%
    lot_size_step: Decimal = Decimal("0.0001")
    symbol: str = "BTCUSDT"
    broker: str = "binance-global"
    execution_mode: str = "PAPER"
    account_id: str = "paper"
    user_id: str = "research_user"

    @classmethod
    def from_risk_profile(
        cls,
        profile: RiskProfile,
        fee_bps: Decimal = Decimal("10"),
        slippage_bps: Decimal = Decimal("5"),
    ) -> "BacktestConfig":
        return cls(
            initial_capital=profile.initial_capital,
            max_risk_percent=profile.max_risk_percent,
            requested_risk_percent=profile.requested_risk_percent,
            max_order_notional=profile.max_order_notional,
            max_daily_notional=profile.max_daily_notional,
            fee_bps=fee_bps,
            slippage_bps=slippage_bps,
            symbol="BTCUSDT",
            broker=profile.scope.broker,
            account_id=profile.scope.account_id,
            user_id=profile.scope.owner_id,
        )


@dataclass
class BacktestResult:
    config: BacktestConfig
    signals: list[SignalRecord]
    fills: list[FillRecord]
    cash_journal: list[CashJournalRecord]
    allocations: list[PositionAllocationRecord]
    metrics: SummaryMetrics
    trades_summary: dict[str, Any]
    equity_curve: pd.DataFrame
    final_cash: Decimal
    final_book_equity: Decimal
    final_mtm_equity: Decimal


class BacktestEngine:
    """Discrete-event simulation layer matching production risk and ledger invariants."""

    def __init__(self, config: BacktestConfig):
        self.config = config

    def run(self, candles: list[Candle], strategy: SyntheticEmaStrategy) -> BacktestResult:
        """Run backtest simulation over candles using strategy signals."""
        signals_raw = strategy.evaluate_signals(candles)
        signals_by_bar = {s.bar_index: s for s in signals_raw}

        # Simulation state
        with localcontext() as ctx:
            ctx.prec = PRECISION_CONTEXT

            cash = self.config.initial_capital
            inventory_qty = Decimal("0")
            open_lots: list[dict[str, Any]] = []

            # Ledgers
            signals_ledger: list[SignalRecord] = []
            fills_ledger: list[FillRecord] = []
            cash_journal_ledger: list[CashJournalRecord] = []
            allocations_ledger: list[PositionAllocationRecord] = []

            # Daily tracking
            current_day: int | None = None
            daily_notional_spent = Decimal("0")

            # Equity curve series
            equity_records = []

            signal_id_seq = 100
            fee_rate = self.config.fee_bps / Decimal("10000")
            slip_rate = self.config.slippage_bps / Decimal("10000")

            # Map candle timestamps to date (for daily notional limits)
            # 86400000 ms per day
            for i, candle in enumerate(candles):
                candle_day = candle.timestamp // 86400000
                if candle_day != current_day:
                    current_day = candle_day
                    daily_notional_spent = Decimal("0")

                # Check if there is an active signal triggered on bar i (e.g. SL intrabar)
                # or triggered at bar i-1 close to be filled at bar i open.
                sig_to_execute: StrategySignal | None = None
                exec_price_ref: Decimal = candle.open

                if i in signals_by_bar:
                    sig = signals_by_bar[i]
                    if sig.event == "SL":
                        # Intrabar Stop Loss triggered on bar i
                        sig_to_execute = sig
                        exec_price_ref = sig.price
                if sig_to_execute is None and (i - 1) in signals_by_bar:
                    prev_sig = signals_by_bar[i - 1]
                    if prev_sig.event in ("BUY", "SELL"):
                        sig_to_execute = prev_sig
                        exec_price_ref = candle.open

                if sig_to_execute is not None:
                    trade_id = f"t_{sig_to_execute.event.lower()}_{candle.timestamp}"

                    if sig_to_execute.event == "BUY":
                        # Spot BUY logic:
                        # 1. Compute requested notional based on requested risk % and available cash
                        risk_ceiling = min(
                            self.config.requested_risk_percent, self.config.max_risk_percent
                        )
                        risk_mult = risk_ceiling / Decimal("100")
                        allocatable_cash = cash * risk_mult
                        target_notional = min(allocatable_cash, self.config.max_order_notional)

                        # Daily notional limit check
                        remaining_daily = max(
                            Decimal("0"), self.config.max_daily_notional - daily_notional_spent
                        )
                        target_notional = min(target_notional, remaining_daily)

                        # Execution price with slippage (BUY pays higher)
                        exec_price = exec_price_ref * (Decimal("1") + slip_rate)

                        # Calculate quantity that fits within target notional including fees:
                        # cost = qty * exec_price * (1 + fee_rate) <= target_notional
                        if target_notional > Decimal("10.0") and exec_price > Decimal("0"):
                            max_qty = target_notional / (exec_price * (Decimal("1") + fee_rate))
                            # Round down to lot step
                            step = self.config.lot_size_step
                            lot_qty = (max_qty // step) * step

                            if lot_qty > Decimal("0"):
                                notional = lot_qty * exec_price
                                fee = notional * fee_rate
                                total_cash_required = notional + fee

                                if total_cash_required <= cash:
                                    # Execute BUY fill
                                    cash -= total_cash_required
                                    inventory_qty += lot_qty
                                    daily_notional_spent += notional
                                    signal_id_seq += 1

                                    sig_rec = SignalRecord(
                                        id=signal_id_seq,
                                        trade_id=trade_id,
                                        user_id=self.config.user_id,
                                        received_at=candle.timestamp,
                                        signal_time=sig_to_execute.timestamp,
                                        broker=self.config.broker,  # type: ignore[arg-type]
                                        symbol=self.config.symbol,
                                        event="BUY",
                                        side="BUY",
                                        entry_price=exec_price,
                                        stop_loss=sig_to_execute.stop_loss,
                                        take_profit=sig_to_execute.take_profit,
                                        status="PROCESSED",
                                        applied_quantity=lot_qty,
                                        applied_quote=notional,
                                        execution_mode=self.config.execution_mode,  # type: ignore[arg-type]
                                        account_id=self.config.account_id,
                                    )
                                    signals_ledger.append(sig_rec)

                                    fill_rec = FillRecord(
                                        signal_id=signal_id_seq,
                                        cumulative_quantity=lot_qty,
                                        delta_quantity=lot_qty,
                                        price=exec_price,
                                        fee_quote=fee,
                                        realized_r=Decimal("0"),
                                        received_at=candle.timestamp,
                                        quote_amount=notional,
                                    )
                                    fills_ledger.append(fill_rec)

                                    cash_rec = CashJournalRecord(
                                        signal_id=signal_id_seq,
                                        cumulative_quantity=lot_qty,
                                        user_id=self.config.user_id,
                                        broker=self.config.broker,  # type: ignore[arg-type]
                                        cash_delta=-total_cash_required,
                                        at=candle.timestamp,
                                    )
                                    cash_journal_ledger.append(cash_rec)

                                    pos_alloc = PositionAllocationRecord(
                                        position_id=f"pos_{signal_id_seq}",
                                        user_id=self.config.user_id,
                                        account_id=self.config.account_id,
                                        execution_mode=self.config.execution_mode,  # type: ignore[arg-type]
                                        broker=self.config.broker,  # type: ignore[arg-type]
                                        symbol=self.config.symbol,
                                        entry_signal_id=signal_id_seq,
                                        entry_trade_id=trade_id,
                                        status="OPEN",
                                        filled_quantity=lot_qty,
                                        remaining_quantity=lot_qty,
                                        entry_price=exec_price,
                                        stop_loss=sig_to_execute.stop_loss,
                                        take_profit=sig_to_execute.take_profit,
                                        opened_at=candle.timestamp,
                                        updated_at=candle.timestamp,
                                    )
                                    allocations_ledger.append(pos_alloc)

                                    open_lots.append({
                                        "allocation_id": pos_alloc.position_id,
                                        "quantity": lot_qty,
                                        "cost_basis": total_cash_required,
                                        "price": exec_price,
                                    })

                    elif sig_to_execute.event in ("SELL", "SL"):
                        # Spot SELL/SL exit logic:
                        # Strictly reduce-only: can only exit what is held in inventory!
                        if inventory_qty > Decimal("0") and open_lots:
                            exit_qty = inventory_qty  # Full close in synthetic-ema-v1
                            # Execution price with slippage (SELL receives lower)
                            exec_price = exec_price_ref * (Decimal("1") - slip_rate)
                            notional = exit_qty * exec_price
                            fee = notional * fee_rate
                            net_cash_proceeds = notional - fee

                            cash += net_cash_proceeds
                            inventory_qty -= exit_qty
                            signal_id_seq += 1

                            sig_rec = SignalRecord(
                                id=signal_id_seq,
                                trade_id=trade_id,
                                user_id=self.config.user_id,
                                received_at=candle.timestamp,
                                signal_time=sig_to_execute.timestamp,
                                broker=self.config.broker,  # type: ignore[arg-type]
                                symbol=self.config.symbol,
                                event=sig_to_execute.event,  # type: ignore[arg-type]
                                side="SELL",
                                entry_price=exec_price,
                                status="PROCESSED",
                                applied_quantity=exit_qty,
                                applied_quote=notional,
                                execution_mode=self.config.execution_mode,  # type: ignore[arg-type]
                                account_id=self.config.account_id,
                            )
                            signals_ledger.append(sig_rec)

                            fill_rec = FillRecord(
                                signal_id=signal_id_seq,
                                cumulative_quantity=exit_qty,
                                delta_quantity=exit_qty,
                                price=exec_price,
                                fee_quote=fee,
                                realized_r=Decimal("0"),
                                received_at=candle.timestamp,
                                quote_amount=notional,
                            )
                            fills_ledger.append(fill_rec)

                            cash_rec = CashJournalRecord(
                                signal_id=signal_id_seq,
                                cumulative_quantity=exit_qty,
                                user_id=self.config.user_id,
                                broker=self.config.broker,  # type: ignore[arg-type]
                                cash_delta=net_cash_proceeds,
                                at=candle.timestamp,
                            )
                            cash_journal_ledger.append(cash_rec)

                            # Close open lot allocations
                            for lot in open_lots:
                                for idx, alloc in enumerate(allocations_ledger):
                                    if alloc.position_id == lot["allocation_id"]:
                                        allocations_ledger[idx] = alloc.model_copy(
                                            update={
                                                "status": "CLOSED",
                                                "remaining_quantity": Decimal("0"),
                                                "closed_at": candle.timestamp,
                                                "updated_at": candle.timestamp,
                                            }
                                        )
                            open_lots.clear()

                # Record book equity and mark-to-market equity at candle close
                open_cost = sum((lot["cost_basis"] for lot in open_lots), Decimal("0"))
                book_equity = cash + open_cost
                mtm_equity = cash + (inventory_qty * candle.close)

                equity_records.append({
                    "timestamp": candle.timestamp,
                    "cash": float(cash),
                    "book_equity": float(book_equity),
                    "mtm_equity": float(mtm_equity),
                    "inventory": float(inventory_qty),
                })

            equity_df = pd.DataFrame(equity_records)
            equity_df["datetime"] = pd.to_datetime(equity_df["timestamp"], unit="ms", utc=True)
            equity_df.set_index("datetime", inplace=True)
            equity_df["peak_mtm"] = equity_df["mtm_equity"].cummax()
            peak = equity_df["peak_mtm"]
            equity_df["drawdown_pct"] = (equity_df["mtm_equity"] - peak) / peak

            # Analytics reconciliation using fifo_analytics
            fill_dicts = []
            for s, f in zip(signals_ledger, fills_ledger, strict=True):
                fill_dicts.append({
                    "signal_id": f.signal_id,
                    "trade_id": s.trade_id,
                    "user_id": self.config.user_id,
                    "side": s.side,
                    "quantity": str(f.delta_quantity),
                    "price": str(f.price),
                    "quote_amount": str(f.quote_amount),
                    "received_at": f.received_at,
                    "symbol": s.symbol,
                    "broker": s.broker,
                    "cumulative_quantity": str(f.cumulative_quantity),
                    "fee_quote": str(f.fee_quote),
                    "legacy_float": 0,
                })

            realizations, closed, _ = fifo_analytics(fill_dicts, fee_bps=0)
            currency = "USDT" if self.config.broker == "binance-global" else "THB"
            metrics = summarize_closed_positions(
                closed=closed,
                starting_equity=self.config.initial_capital,
                currency=currency,
                realizations=realizations,
            )
            trades_summary = {
                "total_trades": metrics.total_trades,
                "wins": metrics.wins,
                "losses": metrics.losses,
                "win_rate": metrics.win_rate,
                "net_profit": metrics.net_profit,
                "profit_factor": metrics.profit_factor,
                "max_drawdown": metrics.max_drawdown,
                "max_drawdown_percent": metrics.max_drawdown_percent,
            }

            final_book = cash + sum((lot["cost_basis"] for lot in open_lots), Decimal("0"))
            final_mtm = cash + (inventory_qty * candles[-1].close if candles else Decimal("0"))

            return BacktestResult(
                config=self.config,
                signals=signals_ledger,
                fills=fills_ledger,
                cash_journal=cash_journal_ledger,
                allocations=allocations_ledger,
                metrics=metrics,
                trades_summary=trades_summary,
                equity_curve=equity_df,
                final_cash=cash,
                final_book_equity=final_book,
                final_mtm_equity=final_mtm,
            )


def run_backtest(
    candles: list[Candle],
    strategy: SyntheticEmaStrategy | None = None,
    config: BacktestConfig | None = None,
) -> BacktestResult:
    """Convenience helper to run backtest simulation."""
    strat = strategy or SyntheticEmaStrategy()
    cfg = config or BacktestConfig()
    engine = BacktestEngine(cfg)
    return engine.run(candles, strat)
