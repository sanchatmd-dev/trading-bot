#!/usr/bin/env python3
"""Loopback-only HTTP bridge for the offline Quant Lab research engine."""
import json
import os
import sys
from decimal import Decimal, InvalidOperation
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "quant_lab" / "src"))
from robot_quant import (BacktestConfig, ConstrainedOptimizer, ParameterBounds, RiskProfile, Scope,
    StrategyDefinition, SyntheticEmaParameters, SyntheticEmaStrategy, generate_risk_preview,
    generate_synthetic_ohlcv, run_backtest)

PORT = int(os.environ.get("QUANT_PORT", "7654"))
MAX_BODY_BYTES = 16 * 1024
MAX_CANDLES = 10_000
MAX_CANDIDATES = 100

def decimal(value, label, minimum=None):
    try: result = Decimal(str(value))
    except (InvalidOperation, ValueError) as error: raise ValueError(f"Invalid {label}") from error
    if not result.is_finite() or (minimum is not None and result < minimum): raise ValueError(f"Invalid {label}")
    return result

def integer(value, label, minimum, maximum):
    try: result = int(value)
    except (TypeError, ValueError) as error: raise ValueError(f"Invalid {label}") from error
    if result < minimum or result > maximum: raise ValueError(f"Invalid {label}")
    return result

def payload(handler):
    try: size = int(handler.headers.get("Content-Length", "0"))
    except ValueError as error: raise ValueError("Invalid Content-Length") from error
    if size < 1 or size > MAX_BODY_BYTES: raise ValueError("Request body must be between 1 and 16384 bytes")
    try: result = json.loads(handler.rfile.read(size).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error: raise ValueError("Body must be valid JSON") from error
    if not isinstance(result, dict): raise ValueError("Body must be a JSON object")
    return result

def respond(handler, status, body):
    raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("Content-Length", str(len(raw)))
    handler.end_headers(); handler.wfile.write(raw)

def parameters(raw):
    return SyntheticEmaParameters(
        ema_fast=integer(raw.get("ema_fast", 10), "ema_fast", 1, 500),
        ema_slow=integer(raw.get("ema_slow", 30), "ema_slow", 2, 1000),
        atr_period=integer(raw.get("atr_period", 14), "atr_period", 1, 500),
        atr_multiplier=decimal(raw.get("atr_multiplier", "2"), "atr_multiplier", Decimal("0.01")))

def config(raw):
    return (integer(raw.get("num_candles", 2000), "num_candles", 30, MAX_CANDLES),
        integer(raw.get("seed", 42), "seed", 0, 2**31 - 1),
        decimal(raw.get("starting_balance", "10000"), "starting_balance", Decimal("0.01")),
        decimal(raw.get("fee_bps", "10"), "fee_bps", Decimal("0")),
        decimal(raw.get("slippage_bps", "5"), "slippage_bps", Decimal("0")))

def serialize_metrics(metrics):
    return {"total_trades": metrics.total_trades, "wins": metrics.wins, "losses": metrics.losses,
        "win_rate": metrics.win_rate, "net_profit": metrics.net_profit, "profit_factor": metrics.profit_factor,
        "max_drawdown": metrics.max_drawdown, "max_drawdown_percent": metrics.max_drawdown_percent,
        "expectancy": metrics.expectancy, "avg_win": metrics.avg_win, "avg_loss": metrics.avg_loss,
        "fee_impact": metrics.fee_impact}

def backtest(body):
    params = parameters(body.get("params", {}))
    count, seed, balance, fee_bps, slippage_bps = config(body.get("config", {}))
    result = run_backtest(generate_synthetic_ohlcv(bars_count=count, seed=seed), strategy=SyntheticEmaStrategy(params),
        config=BacktestConfig(initial_capital=balance, balance=balance, fee_bps=fee_bps, slippage_bps=slippage_bps))
    curve = result.equity_curve.tail(300)
    return {"summary": serialize_metrics(result.metrics),
        "equity_curve": [{"t": int(row.timestamp), "book": str(row.book_equity), "mtm": str(row.mtm_equity)} for row in curve.itertuples(index=False)],
        "num_candles": count, "params": {"ema_fast": params.ema_fast, "ema_slow": params.ema_slow,
        "atr_period": params.atr_period, "atr_multiplier": str(params.atr_multiplier)}}

def bounds(raw):
    # raw could be the old bounds object or the new array of indicators
    result = []
    
    indicators = raw.get("indicators", [])
    if not isinstance(indicators, list):
        indicators = []

    # Count how many indicators we have
    is_multi_indicator = len(indicators) > 1

    # Extract all parameters
    for ind in indicators:
        params = ind.get("params", [])
        for p in params:
            minimum = decimal(p.get("minimum", 1), p.get("name"), Decimal("0.01"))
            maximum = decimal(p.get("maximum", 1), p.get("name"), minimum)
            step = decimal(p.get("step", 1), p.get("name"), Decimal("0.01"))
            default = decimal(p.get("default", 1), p.get("name"), minimum)
            
            # CASE 2 constraint: if multi-indicator, lock all indicator inputs
            locked = True if is_multi_indicator else bool(p.get("locked", False))
            optimizable = False if is_multi_indicator else bool(p.get("optimizable", True))
            
            if not minimum <= default <= maximum: raise ValueError(f"{p.get('name')} range must include its default value")
            result.append(ParameterBounds(name=p.get("name"), unit=p.get("unit", "bars"), minimum=minimum, maximum=maximum, step=step, default=default, locked=locked, optimizable=optimizable))
            
    # Add SL / RR (always optimizable if requested, not locked by multi-indicator rule)
    for risk_param in ["sl_atr_multiplier", "rr_ratio"]:
        if risk_param in raw:
            p = raw[risk_param]
            minimum = decimal(p.get("minimum", 1), risk_param, Decimal("0.01"))
            maximum = decimal(p.get("maximum", 1), risk_param, minimum)
            step = decimal(p.get("step", 1), risk_param, Decimal("0.01"))
            default = decimal(p.get("default", 1), risk_param, minimum)
            locked = bool(p.get("locked", False))
            optimizable = bool(p.get("optimizable", True))
            
            if not minimum <= default <= maximum: raise ValueError(f"{risk_param} range must include its default value")
            result.append(ParameterBounds(name=risk_param, unit="multiplier", minimum=minimum, maximum=maximum, step=step, default=default, locked=locked, optimizable=optimizable))
            
    # CASE 1 constraint check
    optimizable_count = sum(1 for p in result if p.optimizable and not p.locked)
    if optimizable_count > 10:
        raise ValueError("Maximum 10 optimizable inputs exceeded")

    # Fallback to old format if empty
    if not result:
        spec = (("ema_fast", "bars", "ema_fast_min", "ema_fast_max", "5", "25", "1", "10"),
          ("ema_slow", "bars", "ema_slow_min", "ema_slow_max", "30", "80", "1", "30"),
          ("atr_period", "bars", "atr_period_min", "atr_period_max", "10", "21", "1", "14"),
          ("atr_multiplier", "multiplier", "atr_multiplier_min", "atr_multiplier_max", "1.5", "3.5", "0.5", "2.0"))
        for name, unit, min_key, max_key, low, high, step, default in spec:
            bounds_data = raw.get("bounds", {}) if "bounds" in raw else raw
            minimum = decimal(bounds_data.get(min_key, low), min_key, Decimal("0.01")); maximum = decimal(bounds_data.get(max_key, high), max_key, minimum)
            if not minimum <= Decimal(default) <= maximum: raise ValueError(f"{name} range must include its default value ({default})")
            result.append(ParameterBounds(name=name, unit=unit, minimum=minimum, maximum=maximum, step=Decimal(step), default=Decimal(default)))

    # Inject required Dummy parameters for SyntheticEmaStrategy
    names = {p.name for p in result}
    dummy_spec = [
      ("ema_fast", "bars", "10"),
      ("ema_slow", "bars", "30"),
      ("atr_period", "bars", "14"),
      ("atr_multiplier", "multiplier", "2.0")
    ]
    for name, unit, default in dummy_spec:
        if name not in names:
            result.append(ParameterBounds(name=name, unit=unit, minimum=Decimal(default), maximum=Decimal(default), step=Decimal("1"), default=Decimal(default), locked=True, optimizable=False))

    return tuple(result)

def profile(balance, maximum=Decimal("100"), requested=Decimal("2"), name="quant-ui"):
    return RiskProfile(risk_profile_id=name, version=1, scope=Scope(owner_id="quant", bot_id="quant", account_id="paper", broker="binance-global", currency="USDT"), effective_at=0,
      capital_basis="COST_BASIS_NOT_MARK_TO_MARKET", initial_capital=balance, balance=balance, max_risk_percent=maximum,
      requested_risk_percent=requested, max_order_notional=balance, max_daily_notional=balance * Decimal("100"))

def optimize(body):
    raw = body.get("config", {}); count, seed, balance, fee_bps, _ = config(raw)
    budget = integer(raw.get("max_candidates", 40), "max_candidates", 1, MAX_CANDIDATES)
    strategy = StrategyDefinition(strategy_id="quant-ui", version=1, template_id="synthetic-ema-v1", source_sha256="0" * 64,
      alert_source="alert_calls", parameters=bounds(body))
    report = ConstrainedOptimizer(strategy, profile(balance), generate_synthetic_ohlcv(bars_count=count, seed=seed), search_budget=budget).optimize()
    def candidate(row): return {"params": row.params, "train_score": row.in_sample_return, "validation_score": row.val_return,
      "test_score": row.test_return, "passed_stress": row.passed_stress, "stability_ok": row.passed_sensitivity, "status": row.status}
    top = [row for row in report.candidates if row.passed_all_gates][:10] or report.candidates[:10]
    split = report.run_contract
    return {"best": candidate(report.best_candidate) if report.best_candidate else None, "candidates": [candidate(row) for row in top],
      "total_evaluated": report.total_evaluated, "fee_bps": str(fee_bps), "dataset_split": {"train_end": split.train_end, "validation_end": split.validation_end, "test_end": split.test_end}}

def risk_preview(body):
    raw = body.get("input", {}); balance = decimal(raw.get("balance", "10000"), "balance", Decimal("0.01"))
    maximum = decimal(raw.get("max_risk_percent", "2"), "max_risk_percent", Decimal("0.01")); requested = decimal(raw.get("requested_risk_percent", "1"), "requested_risk_percent", Decimal("0.01"))
    if requested > maximum: raise ValueError("requested_risk_percent cannot exceed max_risk_percent")
    item = profile(balance, maximum, requested, "quant-preview")
    item = item.model_copy(update={"max_order_notional": decimal(raw.get("max_order_notional", "5000"), "max_order_notional", Decimal("0.01")), "max_daily_notional": decimal(raw.get("max_daily_notional", "50000"), "max_daily_notional", Decimal("0.01"))})
    return generate_risk_preview(item, decimal(raw.get("reference_price", raw.get("entry_price", "50000")), "reference_price", Decimal("0.00000001"))).to_dict()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, _format, *_args): pass
    def do_GET(self):
        respond(self, 200, {"ok": True, "version": "0.4.0", "mode": "OFFLINE_RESEARCH_ONLY"}) if self.path == "/quant/health" else respond(self, 404, {"error": "Not found"})
    def do_POST(self):
        routes = {"/quant/backtest": backtest, "/quant/optimize": optimize, "/quant/risk-preview": risk_preview}
        try:
            route = routes.get(self.path)
            if route is None: respond(self, 404, {"error": "Not found"})
            else: respond(self, 200, route(payload(self)))
        except ValueError as error: respond(self, 400, {"error": str(error)})
        except Exception:
            print("Quant bridge request failed", file=sys.stderr, flush=True); respond(self, 500, {"error": "Quant engine failed"})

if __name__ == "__main__":
    print(f"Quant Lab bridge listening on 127.0.0.1:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
