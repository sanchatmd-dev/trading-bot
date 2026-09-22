"""HTML tear sheet reporting engine for backtests and paper execution.

Generates self-contained, standalone, offline-safe performance tear sheets
with exact FIFO metrics, book vs. mark-to-market equity curves, drawdown
profiles, monthly returns, provenance metadata, and cash reconciliation.
Zero external CDN dependencies to ensure 100% offline test compliance.
"""

import math
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

import pandas as pd

from robot_quant.backtest import BacktestResult


def _safe_float(val: Any, default: float = 0.0) -> float:
    """Safely convert Decimal or string to float, defaulting on None or NaN."""
    if val is None:
        return default
    try:
        f = float(val)
        return default if math.isnan(f) or math.isinf(f) else f
    except (ValueError, TypeError):
        return default


def _format_pct(val: float | None) -> str:
    if val is None:
        return "N/A"
    return f"{val:+.2f}%"


def _format_curr(val: Any, curr: str = "USDT") -> str:
    if val is None:
        return "N/A"
    try:
        d = Decimal(str(val))
        return f"{d:,.2f} {curr}"
    except Exception:
        return f"{val} {curr}"


def _generate_svg_line_chart(
    series_dict: dict[str, list[float]],
    labels: list[str],
    colors: dict[str, str],
    width: int = 800,
    height: int = 240,
) -> str:
    """Generate a clean SVG multi-line chart with axes and legend."""
    if not series_dict or not labels:
        return f'<svg width="{width}" height="{height}" class="empty-chart"><text x="50%" y="50%" text-anchor="middle">No data available</text></svg>'

    all_vals = [v for s in series_dict.values() for v in s if not math.isnan(v)]
    if not all_vals:
        return f'<svg width="{width}" height="{height}" class="empty-chart"><text x="50%" y="50%" text-anchor="middle">No numeric data</text></svg>'

    min_y = min(all_vals)
    max_y = max(all_vals)
    if min_y == max_y:
        min_y -= 1.0
        max_y += 1.0

    pad_left = 70
    pad_right = 20
    pad_top = 20
    pad_bottom = 35
    plot_w = width - pad_left - pad_right
    plot_h = height - pad_top - pad_bottom

    n_pts = len(labels)
    x_step = plot_w / max(1, n_pts - 1)

    svg_parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart-svg" xmlns="http://www.w3.org/2000/svg">',
        '<style>.grid { stroke: #2a2e39; stroke-dasharray: 2,2; } .axis { stroke: #434651; } .text { fill: #787b86; font-size: 11px; font-family: monospace; }</style>',
    ]

    # Gridlines & Y-labels (4 levels)
    for i in range(5):
        frac = i / 4.0
        y_val = min_y + (max_y - min_y) * (1.0 - frac)
        y_pos = pad_top + plot_h * frac
        svg_parts.append(
            f'<line x1="{pad_left}" y1="{y_pos}" x2="{width - pad_right}" y2="{y_pos}" class="grid" />'
        )
        svg_parts.append(
            f'<text x="{pad_left - 8}" y="{y_pos + 4}" text-anchor="end" class="text">{y_val:,.1f}</text>'
        )

    # X-labels (start, middle, end)
    x_indices = [0, n_pts // 2, n_pts - 1]
    for idx in x_indices:
        if 0 <= idx < n_pts:
            x_pos = pad_left + idx * x_step
            svg_parts.append(
                f'<text x="{x_pos}" y="{height - 10}" text-anchor="middle" class="text">{labels[idx]}</text>'
            )

    # Lines
    for name, series in series_dict.items():
        color = colors.get(name, "#2962ff")
        pts = []
        for i, val in enumerate(series):
            x = pad_left + i * x_step
            y_norm = (val - min_y) / (max_y - min_y)
            y = pad_top + plot_h * (1.0 - y_norm)
            pts.append(f"{x:.1f},{y:.1f}")
        polyline_pts = " ".join(pts)
        svg_parts.append(
            f'<polyline fill="none" stroke="{color}" stroke-width="2" points="{polyline_pts}" />'
        )

    svg_parts.append("</svg>")
    return "\n".join(svg_parts)


def _generate_svg_drawdown_chart(
    drawdown_series: list[float],
    labels: list[str],
    width: int = 800,
    height: int = 150,
) -> str:
    """Generate a clean SVG underwater area chart for drawdowns."""
    if not drawdown_series or not labels:
        return f'<svg width="{width}" height="{height}"></svg>'

    min_dd = min(drawdown_series) if drawdown_series else 0.0
    min_dd = min(min_dd, -0.01)  # At least down to -1%

    pad_left = 70
    pad_right = 20
    pad_top = 15
    pad_bottom = 25
    plot_w = width - pad_left - pad_right
    plot_h = height - pad_top - pad_bottom

    n_pts = len(labels)
    x_step = plot_w / max(1, n_pts - 1)

    svg_parts = [
        f'<svg viewBox="0 0 {width} {height}" class="chart-svg" xmlns="http://www.w3.org/2000/svg">',
        '<style>.dd-grid { stroke: #2a2e39; stroke-dasharray: 2,2; } .text { fill: #787b86; font-size: 11px; font-family: monospace; }</style>',
    ]

    # Gridlines (0%, 50% max_dd, max_dd)
    for frac in (0.0, 0.5, 1.0):
        val = min_dd * frac
        y_pos = pad_top + plot_h * frac
        svg_parts.append(
            f'<line x1="{pad_left}" y1="{y_pos}" x2="{width - pad_right}" y2="{y_pos}" class="dd-grid" />'
        )
        svg_parts.append(
            f'<text x="{pad_left - 8}" y="{y_pos + 4}" text-anchor="end" class="text">{val * 100:.1f}%</text>'
        )

    # Area polygon
    pts = [f"{pad_left:.1f},{pad_top:.1f}"]
    for i, val in enumerate(drawdown_series):
        x = pad_left + i * x_step
        y_norm = val / min_dd if min_dd != 0 else 0.0
        y = pad_top + plot_h * y_norm
        pts.append(f"{x:.1f},{y:.1f}")
    pts.append(f"{pad_left + (n_pts - 1) * x_step:.1f},{pad_top:.1f}")

    area_pts = " ".join(pts)
    svg_parts.append(
        f'<polygon points="{area_pts}" fill="#f23645" fill-opacity="0.25" stroke="#f23645" stroke-width="1.5" />'
    )
    svg_parts.append("</svg>")
    return "\n".join(svg_parts)


def calculate_tearsheet_metrics(result: BacktestResult) -> dict[str, Any]:
    """Calculate comprehensive performance, risk, and trade statistics."""
    eq_df = result.equity_curve
    init_cap = float(result.config.initial_capital)
    final_book = float(result.final_book_equity)
    final_mtm = float(result.final_mtm_equity)
    final_cash = float(result.final_cash)

    total_return_pct = ((final_book - init_cap) / init_cap * 100.0) if init_cap > 0 else 0.0

    # Duration & CAGR
    n_bars = len(eq_df)
    cagr_pct = 0.0
    annualized_vol_pct = 0.0
    sharpe = 0.0
    sortino = 0.0

    if n_bars > 1 and "book_equity" in eq_df.columns:
        equity_series = eq_df["book_equity"].astype(float)
        ret_series = equity_series.pct_change().dropna()

        # Assuming hourly candles (24 * 365.25 = 8766 bars/year) or daily (365)
        # We estimate days from index if datetime, else approximate 24 bars/day
        if isinstance(eq_df.index, pd.DatetimeIndex) and len(eq_df.index) > 1:
            days = (eq_df.index[-1] - eq_df.index[0]).total_seconds() / 86400.0
        else:
            days = max(1.0, n_bars / 24.0)

        if days >= 1.0 and final_book > 0 and init_cap > 0:
            cagr = (final_book / init_cap) ** (365.25 / days) - 1.0
            cagr_pct = cagr * 100.0

        if len(ret_series) > 1:
            std_ret = ret_series.std()
            mean_ret = ret_series.mean()
            # Annualization factor for hourly bars
            ann_factor = math.sqrt(365.25 * 24)
            if std_ret > 0:
                annualized_vol_pct = std_ret * ann_factor * 100.0
                sharpe = (mean_ret / std_ret) * ann_factor

            downside_ret = ret_series[ret_series < 0]
            if len(downside_ret) > 0:
                downside_std = downside_ret.std()
                if downside_std > 0:
                    sortino = (mean_ret / downside_std) * ann_factor

    # Underwater drawdown curve
    drawdown_pcts = []
    if "book_equity" in eq_df.columns:
        peak = float(init_cap)
        for eq_val in eq_df["book_equity"].astype(float):
            if eq_val > peak:
                peak = eq_val
            dd = (eq_val - peak) / peak if peak > 0 else 0.0
            drawdown_pcts.append(dd)
    else:
        drawdown_pcts = [0.0] * n_bars

    # Monthly breakdown if DatetimeIndex
    monthly_table: dict[int, dict[int, float]] = {}
    if isinstance(eq_df.index, pd.DatetimeIndex) and len(eq_df) > 0:
        monthly_df = eq_df["book_equity"].resample("ME").last().dropna()
        prev_eq = init_cap
        for dt, eq_val in monthly_df.items():
            ret = (float(eq_val) - prev_eq) / prev_eq * 100.0 if prev_eq > 0 else 0.0
            year = dt.year
            month = dt.month
            if year not in monthly_table:
                monthly_table[year] = {}
            monthly_table[year][month] = ret
            prev_eq = float(eq_val)

    # FIFO trades summary from result.metrics
    m = result.metrics
    return {
        "initial_capital": init_cap,
        "final_book_equity": final_book,
        "final_mtm_equity": final_mtm,
        "final_cash": final_cash,
        "total_return_pct": total_return_pct,
        "cagr_pct": cagr_pct,
        "annualized_vol_pct": annualized_vol_pct,
        "sharpe": sharpe,
        "sortino": sortino,
        "max_drawdown_pct": m.max_drawdown_percent if m.max_drawdown_percent is not None else 0.0,
        "max_drawdown_amount": m.max_drawdown,
        "total_trades": m.total_trades,
        "winning_trades": m.wins,
        "losing_trades": m.losses,
        "win_rate": m.win_rate,
        "profit_factor": m.profit_factor,
        "realized_profit": m.net_profit,
        "realized_loss": m.fee_impact,
        "total_net_pnl": m.closed_net_profit,
        "average_win": m.avg_win,
        "average_loss": m.avg_loss,
        "realized_rr": m.avg_win_loss_ratio,
        "max_win_streak": m.max_consecutive_wins,
        "max_loss_streak": m.max_consecutive_losses,
        "drawdown_series": drawdown_pcts,
        "monthly_table": monthly_table,
        "n_bars": n_bars,
    }


def generate_tear_sheet(
    result: BacktestResult,
    output_path: Path,
    title: str = "Robot Trade — Backtest Performance Tear Sheet",
) -> Path:
    """Generate an offline, standalone HTML performance tear sheet with embedded SVG charts."""
    stats = calculate_tearsheet_metrics(result)
    cfg = result.config
    curr = "USDT" if cfg.broker == "binance-global" else "THB"

    # Prepare chart data (subsample if more than 500 bars to keep SVG lightweight)
    eq_df = result.equity_curve
    step = max(1, len(eq_df) // 300)
    sampled = eq_df.iloc[::step]
    if len(eq_df) > 0 and (len(sampled) == 0 or sampled.index[-1] != eq_df.index[-1]):
        sampled = pd.concat([sampled, eq_df.iloc[[-1]]])

    def format_x_label(idx: Any) -> str:
        if isinstance(idx, (pd.Timestamp, datetime)):
            return idx.strftime("%Y-%m-%d")
        return str(idx)

    x_labels = [format_x_label(idx) for idx in sampled.index]

    series_dict = {
        "Book Equity": [float(x) for x in sampled["book_equity"]],
        "MTM Equity": [float(x) for x in sampled["mtm_equity"]],
        "Cash": [float(x) for x in sampled["cash"]],
    }
    colors = {
        "Book Equity": "#2962ff",  # Vibrant Blue
        "MTM Equity": "#00b0ff",  # Light Cyan
        "Cash": "#9c27b0",  # Purple
    }
    svg_equity = _generate_svg_line_chart(series_dict, x_labels, colors)

    sampled_dd = [stats["drawdown_series"][i] for i in sampled.index.map(eq_df.index.get_loc)]
    svg_dd = _generate_svg_drawdown_chart(sampled_dd, x_labels)

    # Reconciliation math check
    init_cap = Decimal(str(cfg.initial_capital))
    net_pnl = Decimal(str(stats["total_net_pnl"]))
    final_book = Decimal(str(result.final_book_equity))
    reconciled = (init_cap + net_pnl) == final_book
    reconcile_status = (
        '<span class="badge badge-success">✓ EXACT MATCH (80-digit precision)</span>'
        if reconciled
        else '<span class="badge badge-danger">✗ RECONCILIATION MISMATCH</span>'
    )

    # Monthly performance table HTML
    monthly_rows = []
    month_names = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
    for year in sorted(stats["monthly_table"].keys()):
        m_data = stats["monthly_table"][year]
        year_total = sum(m_data.values())
        cols = [f"<td><strong>{year}</strong></td>"]
        for m_idx in range(1, 13):
            val = m_data.get(m_idx)
            if val is not None:
                color_cls = "pos" if val > 0 else ("neg" if val < 0 else "neutral")
                cols.append(f'<td class="{color_cls}">{val:+.1f}%</td>')
            else:
                cols.append('<td class="empty">-</td>')
        color_cls = "pos" if year_total > 0 else ("neg" if year_total < 0 else "neutral")
        cols.append(f'<td class="{color_cls} font-bold">{year_total:+.1f}%</td>')
        monthly_rows.append(f"<tr>{''.join(cols)}</tr>")

    monthly_table_html = (
        f"""
        <table class="data-table">
            <thead>
                <tr>
                    <th>Year</th>{''.join(f'<th>{m}</th>' for m in month_names)}<th>YTD</th>
                </tr>
            </thead>
            <tbody>
                {''.join(monthly_rows)}
            </tbody>
        </table>
        """
        if monthly_rows
        else "<p class='text-muted'>Monthly breakdown requires datetime-indexed candles.</p>"
    )

    now_utc = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    html_content = f"""<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>{title}</title>
    <style>
        :root {{
            --bg-primary: #131722;
            --bg-card: #1e222d;
            --text-primary: #d1d4dc;
            --text-muted: #787b86;
            --border-color: #2a2e39;
            --green: #26a69a;
            --red: #ef5350;
            --blue: #2962ff;
        }}
        * {{ box-sizing: border-box; margin: 0; padding: 0; }}
        body {{
            background-color: var(--bg-primary);
            color: var(--text-primary);
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            line-height: 1.5;
            padding: 24px;
        }}
        .container {{ max-width: 1100px; margin: 0 auto; }}
        .header {{
            display: flex;
            justify-content: space-between;
            align-items: center;
            border-bottom: 1px solid var(--border-color);
            padding-bottom: 16px;
            margin-bottom: 24px;
        }}
        .header h1 {{ font-size: 22px; color: #fff; }}
        .header .meta {{ color: var(--text-muted); font-size: 13px; }}
        .grid-4 {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }}
        .card {{
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 16px;
        }}
        .card-title {{ font-size: 12px; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; }}
        .card-value {{ font-size: 22px; font-weight: 600; color: #fff; }}
        .card-sub {{ font-size: 12px; color: var(--text-muted); margin-top: 4px; }}
        .chart-card {{
            background: var(--bg-card);
            border: 1px solid var(--border-color);
            border-radius: 6px;
            padding: 20px;
            margin-bottom: 24px;
        }}
        .chart-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }}
        .chart-title {{ font-size: 16px; color: #fff; font-weight: 500; }}
        .chart-legend {{ display: flex; gap: 16px; font-size: 12px; }}
        .legend-item {{ display: flex; align-items: center; gap: 6px; }}
        .legend-color {{ width: 12px; height: 12px; border-radius: 2px; }}
        .chart-svg {{ width: 100%; height: auto; display: block; }}
        .data-table {{ width: 100%; border-collapse: collapse; font-size: 12px; text-align: right; }}
        .data-table th, .data-table td {{ padding: 8px 10px; border: 1px solid var(--border-color); }}
        .data-table th {{ background: #181b24; color: var(--text-muted); font-weight: 500; }}
        .data-table td:first-child {{ text-align: left; }}
        .pos {{ color: var(--green); }}
        .neg {{ color: var(--red); }}
        .neutral {{ color: var(--text-muted); }}
        .empty {{ color: #434651; }}
        .font-bold {{ font-weight: 600; }}
        .badge {{ padding: 3px 8px; border-radius: 4px; font-size: 12px; font-weight: 500; }}
        .badge-success {{ background: rgba(38, 166, 154, 0.15); color: var(--green); }}
        .badge-danger {{ background: rgba(239, 83, 80, 0.15); color: var(--red); }}
        .provenance {{ font-size: 12px; color: var(--text-muted); }}
        .provenance-row {{ display: flex; justify-content: space-between; padding: 6px 0; border-bottom: 1px solid var(--border-color); }}
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <div>
                <h1>{title}</h1>
                <div class="meta">Symbol: <strong>{cfg.symbol}</strong> | Broker: <strong>{cfg.broker}</strong> | Mode: <strong>{cfg.execution_mode}</strong></div>
            </div>
            <div class="meta text-right">Generated: {now_utc}</div>
        </div>

        <div class="grid-4">
            <div class="card">
                <div class="card-title">Net Return (Book)</div>
                <div class="card-value {'pos' if stats['total_return_pct'] >= 0 else 'neg'}">{_format_pct(stats['total_return_pct'])}</div>
                <div class="card-sub">Initial: {_format_curr(stats['initial_capital'], curr)} → Final: {_format_curr(stats['final_book_equity'], curr)}</div>
            </div>
            <div class="card">
                <div class="card-title">Max Drawdown</div>
                <div class="card-value neg">-{stats['max_drawdown_pct']:.2f}%</div>
                <div class="card-sub">Amount: -{_format_curr(stats['max_drawdown_amount'], curr)}</div>
            </div>
            <div class="card">
                <div class="card-title">Profit Factor / Win Rate</div>
                <div class="card-value">{f"{stats['profit_factor']:.2f}" if stats['profit_factor'] is not None else "N/A"}</div>
                <div class="card-sub">Win Rate: {f"{stats['win_rate']:.1f}%" if stats['win_rate'] is not None else "N/A"} ({stats['winning_trades']}W / {stats['losing_trades']}L)</div>
            </div>
            <div class="card">
                <div class="card-title">Sharpe / Sortino Ratio</div>
                <div class="card-value">{stats['sharpe']:.2f}</div>
                <div class="card-sub">Sortino: {stats['sortino']:.2f} | Vol: {stats['annualized_vol_pct']:.1f}%</div>
            </div>
        </div>

        <div class="chart-card">
            <div class="chart-header">
                <div class="chart-title">Equity Curves</div>
                <div class="chart-legend">
                    <div class="legend-item"><div class="legend-color" style="background: #2962ff"></div>Book Equity (Cost Basis)</div>
                    <div class="legend-item"><div class="legend-color" style="background: #00b0ff"></div>MTM Equity</div>
                    <div class="legend-item"><div class="legend-color" style="background: #9c27b0"></div>Cash Balance</div>
                </div>
            </div>
            {svg_equity}
        </div>

        <div class="chart-card">
            <div class="chart-header">
                <div class="chart-title">Drawdown Profile (Underwater)</div>
            </div>
            {svg_dd}
        </div>

        <div class="chart-card">
            <div class="chart-header">
                <div class="chart-title">Monthly Returns</div>
            </div>
            {monthly_table_html}
        </div>

        <div class="grid-4" style="grid-template-columns: 1fr 1fr;">
            <div class="card">
                <div class="card-title">Reconciliation & Accounting Integrity</div>
                <div class="provenance" style="margin-top: 12px;">
                    <div class="provenance-row"><span>Initial Capital</span><strong>{_format_curr(stats['initial_capital'], curr)}</strong></div>
                    <div class="provenance-row"><span>Net Realized PnL</span><strong class="{'pos' if net_pnl >= 0 else 'neg'}">{_format_curr(stats['total_net_pnl'], curr)}</strong></div>
                    <div class="provenance-row"><span>Final Book Equity</span><strong>{_format_curr(stats['final_book_equity'], curr)}</strong></div>
                    <div class="provenance-row"><span>Final Cash Balance</span><strong>{_format_curr(stats['final_cash'], curr)}</strong></div>
                    <div class="provenance-row"><span>Final MTM Equity</span><strong>{_format_curr(stats['final_mtm_equity'], curr)}</strong></div>
                    <div class="provenance-row" style="border-bottom: none; margin-top: 8px;">
                        <span>Integrity Check</span>
                        {reconcile_status}
                    </div>
                </div>
            </div>

            <div class="card">
                <div class="card-title">Trade Analytics & Cost Model</div>
                <div class="provenance" style="margin-top: 12px;">
                    <div class="provenance-row"><span>Total Completed Trades</span><strong>{stats['total_trades']}</strong></div>
                    <div class="provenance-row"><span>Average Win / Average Loss</span><strong>{_format_curr(stats['average_win'], curr)} / {_format_curr(stats['average_loss'], curr)}</strong></div>
                    <div class="provenance-row"><span>Realized Risk:Reward</span><strong>{f"{stats['realized_rr']:.2f}" if stats['realized_rr'] is not None else "N/A"}</strong></div>
                    <div class="provenance-row"><span>Max Win / Loss Streak</span><strong>{stats['max_win_streak']} / {stats['max_loss_streak']}</strong></div>
                    <div class="provenance-row"><span>Fee Assumption</span><strong>{cfg.fee_bps} bps (0.{int(cfg.fee_bps):02d}%)</strong></div>
                    <div class="provenance-row" style="border-bottom: none;"><span>Slippage Model</span><strong>{cfg.slippage_bps} bps</strong></div>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(html_content, encoding="utf-8")
    return output_path
