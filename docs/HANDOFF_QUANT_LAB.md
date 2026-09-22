# Handoff: Quant Lab

- **VPS Release:** `39590f7`
- **Mode:** `PAPER_ONLY` — Live Trading remains locked
- **Quant Service:** `astra-trade-quant.service` active, loopback `127.0.0.1:7654`
- **Python Runtime:** installed `uv 0.12.17`; venv at `/home/mikey/apps/astra-trade/shared/quant-venv`

## Released

- Quant Lab sidebar and UI
- Offline synthetic-data Backtest
- Constrained Optimizer with validation, sensitivity and stress gates
- Risk Preview
- Authenticated Node proxy: `/api/quant/*`
- Request limits, loopback-only bridge, timeout/error handling

## Not released

- Pine Export — exporter/API contract is not validated; intentionally excluded.
- Quant Lab never submits, modifies, or authorizes trades.

## Verification

- Quant tests: `71/71` passed
- Node tests: `111/111` passed
- API health: `PAPER_ONLY`
- Quant bridge health: `OFFLINE_RESEARCH_ONLY`
- Quant endpoints require login (`401` without session)

## Files

- `src/quant_bridge.py`
- `src/postgres/server.js`
- `public/quant-lab.js`
- `public/index.html`
- `.deploy/astra-trade-quant.service`
