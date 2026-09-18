# Robot Trade — Forward Implementation Plan

Status: proposed implementation sequence after release `c573e39`. This document defines future work; it does not mark that work complete or authorize production database access, payments, or Live trading.

Use `APP-*` for the application roadmap and `QL-*` for Quant Lab. The previously deployed application Phases 0–2 retain their names. APP-3 below is the proposed next application scope, not an assertion that an older Phase 3 specification already exists.

## Verified starting point

- Node.js 24 application, PostgreSQL 16 schema 11, separate API and Paper worker, immutable releases with a current symlink.
- Multi-user authentication, MFA, bot profiles, risk controls, decimal accounting and FIFO analytics exist. Live execution remains locked.
- Release `c573e39` added owner-selected branding, mobile installation guidance and a standalone web app manifest. Local regression: 93/93 passed; production API/worker health and asset delivery verified. Physical iOS/Android installation is still an acceptance check.
- PostgreSQL integration checks previously passed for the Phase 2 implementation; rerun them for shared contracts/schema changes. The 93-test result is not a fresh PostgreSQL integration result.
- The main workflow is `.github/workflows/test.yml`, displayed as “Safety checks”.
- Scheduled off-host backup remains deferred by the owner until final project preparation. No off-host destination or schedule is claimed.

## Sequence and dependencies

1. R-0: record the baseline and acceptance gaps.
2. QL-1: isolated Python setup and CI.
3. QL-2: safe data export, market-data contracts and accounting parity.
4. APP-3: operational readiness and measured Paper scaling.
5. QL-3 and QL-4: backtesting and research reports, eligible to proceed after QL-2 without blocking APP-3.
6. APP-4: customer onboarding, subscriptions and paid Paper launch readiness.
7. APP-5: optional, separately approved Live broker rollout.

The application may proceed to APP-3 while QL-2 research work continues if research is isolated and no shared contract is changing. Quant Lab reports are not a gate for delivering the core bot service. Customer-facing Quant Lab UI is a later product decision.

## R-0 — Baseline and acceptance record

Deliverables:
- Reconcile release, service, schema and test records in Context.md.
- Verify the main CI result for the actual release SHA through GitHub; an empty connector response does not prove that no workflow ran.
- Record desktop/mobile login, password editing, MFA and installation acceptance. Use physical iOS/Android for installation acceptance; emulator/unit results are not substitutes.
- Carry forward deferred backups and remaining load/security work explicitly.

Done when: each baseline item has a result, evidence or a named outstanding acceptance task. Do not hold research setup for unrelated device availability.

## QL-1 — Isolated setup and reproducible CI

Deliverables:
- Create `quant_lab/{data,notebooks,src/robot_quant,tests,reports}` and `quant_lab/pyproject.toml`.
- Use Python 3.12 as the initial tested interpreter. Lock a compatible dependency set; do not claim support for untested later Python versions.
- Core: DuckDB, Polars, pandas, PyArrow and psycopg. Market-data extra: ccxt and yfinance. Research extra: vectorbt, a verified compatible pandas-ta version, QuantStats and Jupyter. Development extra: Ruff and Pytest.
- Keep Python dependencies out of Node deployment. Exclude Quant Lab from the application Docker context/release payload; maintain its own environment and execution location.
- Ignore virtual environments, caches, checkpoints, local databases, exports, generated reports and secrets. Preserve small synthetic test fixtures. Strip notebook outputs before committing.
- Add `.github/workflows/quant-lab.yml` with Ruff, offline Pytest, package import checks and locked installation. Test Linux and Windows for supported developer workflows.
- Make main heavy CI skip Quant-only changes while shared Node/schema/risk/workflow changes still trigger relevant checks. Quant CI must also react to shared schema/analytics contract changes.
- Inspect branch protection before applying workflow-level path filters. If required checks would remain pending, retain a lightweight dispatcher/required gate and skip only unrelated heavy jobs.

Done when: a clean environment installs from the lock, meaningful configuration/package tests pass, and a CI change matrix demonstrates correct behavior for Quant-only, docs-only, application-only and shared-contract changes. Baseline Node and isolated PostgreSQL checks pass for the CI configuration change. CI never requires production secrets or live market downloads.

## QL-2 — Read-only data, market data and accounting parity

Deliverables:
- Start with synthetic fixtures and a restored snapshot. Use a separate research directory/process; do not run notebook workloads inside the API or execution worker.
- Define an explicitly configured Unix-socket or TCP connection. Production currently has no TCP listener; do not enable one as an automatic fallback. Remote access uses an authorized tunnel or certificate-verified private connection.
- Define a dedicated research reader role with CONNECT/USAGE and SELECT only on reviewed columns/views, no write/DDL role membership, bounded pool size, statement/lock timeouts and read-only transactions. Exclude credentials, session data, secrets and unrestricted signal payloads.
- Reader contract: `signals`, `orders`, `fills`, `paper_cash_journal`, `paper_funding` and selected `analytics_settings` fields. Validate actual schema/version and fail on unknown contracts.
- Join fills to signals for bot ownership. Keep main owner, bot profile (`user_id` in the existing schema), broker, execution mode and currency explicit. Do not infer isolation from a caller-supplied user ID.
- Use a consistent, bounded snapshot/export with provenance and cutoff. Avoid long analytics transactions on production. Operator research credentials must never be exposed to customer notebooks; customer access later needs server-enforced scope.
- Preserve `NUMERIC(38,18)` as Decimal through exports and storage. Prevent silent pandas float coercion. Declare float conversions only at statistical/simulation boundaries.
- Market data records provider/exchange, raw and canonical symbol, base/quote, UTC interval, candle completion, source timestamps and adjustment policy. Reject duplicate, missing or incomplete bars according to explicit policy.
- Apply existing broker-scoped USD aliases only to signal identity. Yahoo BTC-USD is not Binance BTC/USDT market data. Keep USDT and THB separate.
- Store Parquet datasets with hashes/manifests; use DuckDB for querying. Retrieve crypto history from an exchange-appropriate source and paginate/rate-limit it. Measure available history per symbol/timeframe before promising 1–3 years.
- Establish golden fixtures comparing Python accounting to `src/postgres/analytics.js`: partial exits, scale-in, flat-to-flat cycles, funding, custom fees, breakeven, open positions and legacy precision adjustments. Custom analytics fees must not be silently charged twice.

Done when: fills/cash/funding export correctly; read-only privileges reject writes in an isolated test DB; no cross-bot/currency leakage; Decimal round trips preserve values; golden FIFO/PnL results match the Node contract with documented tolerances only where intended. Production reads remain optional until the isolated path passes.

## APP-3 — Operational readiness and measured Paper scaling

Deliverables:
- Define a target workload before scaling: concurrent owners, bots, webhook rate, burst size, history size and acceptable queue delay. Record measured results instead of choosing arbitrary replica counts.
- Measure API latency, queue age, worker heartbeat, error/rejection rates, DB connections, query times and disk growth. Redact sensitive data from logs and alerts.
- Load-test admission limits, per-owner fairness, concurrent risk reservations and recovery under worker restarts. Prevent noisy users from starving others.
- Add log/history pagination and measured indexes. Design incremental analytics only after profiling; verify that caching preserves tenant boundaries and accounting results.
- Document operational recovery, deploy rollback boundaries and alert response. Perform isolated restart/failure rehearsals.
- Close remaining risk UI, admin access, login/MFA and physical mobile acceptance gaps.

Done when: the agreed workload meets recorded thresholds, restart tests preserve order/accounting invariants, critical UI flows pass, and operators can detect and diagnose failures. This remains a Paper release; it is not a throughput claim beyond the tested workload or a Live approval.

## QL-3 — Backtesting with explicit execution assumptions

Deliverables:
- Implement one simple reference strategy before parameter sweeps. Keep strategy and indicators in importable source, with notebooks as thin experiment interfaces.
- Use vectorbt for research acceleration, with an explicit simulation layer for rules that do not map directly to its defaults. Preserve an auditable transaction ledger.
- Specify bar-close signal timing, next execution opportunity, warm-up, missing data, gap handling, tick/lot/minimum-notional constraints and same-bar SL/TP ambiguity. Do not assume favorable intrabar ordering from OHLC alone.
- Enforce long-only Spot, inventory-limited SELL, cash/fee-inclusive sizing, per-order and daily notional limits, position/risk limits, fees and slippage. State which production guards need external data and cannot be reproduced.
- Match the current cost-based book-equity risk policy where parity is intended; report mark-to-market equity separately. Export risk/strategy configuration versions without changing bot settings.
- Split training/validation/out-of-sample chronologically; add walk-forward validation before accepting optimized strategies. Prevent future-data leakage.
- Record dataset hash, strategy commit, dependency lock, parameters, seed if applicable and execution assumptions for every run.

Done when: supported data covers the requested 1–3 years at the chosen interval, repeated runs reproduce results, trades and cash stay nonnegative within the declared precision policy, transactions reconcile to realized PnL, and shared risk fixtures explain any difference from Paper execution. No generated strategy automatically activates a bot or submits an order.

## QL-4 — Reconciled risk reports

Deliverables:
- Generate private HTML tear sheets under `quant_lab/reports/` for backtests and Paper fills.
- QuantStats handles appropriately sampled returns, Sharpe/Sortino and return charts. Calculate flat-to-flat trade counts, Win Rate and Profit Factor from the reconciled FIFO ledger.
- Distinguish realized/book and mark-to-market equity. Adjust return calculations for external deposits/withdrawals. Specify annualization, timezone, risk-free assumption, benchmark and fee model.
- Handle no trades, only wins, zero variance, zero capital, missing prices, open inventory and sparse samples explicitly; show unavailable metrics instead of fabricated zeros/infinities.
- Provide Drawdown, Monthly Returns, risk metrics, data coverage, cost assumptions and a reconciliation section. Do not imply theoretical fee adjustments changed recorded cash.
- Document setup, read-only export, market-data retrieval, experiments, reporting and known limitations in `quant_lab/README.md`.

Done when: identical fixtures reproduce Node FIFO Win Rate/Profit Factor definitions, reports reconcile capital and PnL, return metrics use the declared equity basis, and reports contain provenance and no credentials or cross-user data. Reports remain private operator artifacts until authenticated report delivery is designed.

## APP-4 — Customer lifecycle and paid Paper readiness

Deliverables:
- Define plans and enforce bot/history/research quotas on the server. Extend existing license/subscription controls instead of duplicating them.
- Add onboarding, lifecycle operations, support permissions, data export/retention and auditable administrative changes.
- After choosing a billing provider and plan rules, implement subscription events idempotently, including duplicate/out-of-order delivery, failed payment, expiry and reconciliation. Entry restrictions must preserve explicitly allowed risk-reducing exits.
- Complete independent security review and acceptance of the supported device/browser matrix.
- At final launch preparation, resume the owner-deferred off-host backup decision, configure encrypted automatic backups/retention and rehearse restore outside the VPS. Define and verify RPO/RTO for the offered service.
- Establish rollback, support ownership, incident response and a bounded private Paper beta before paid rollout.

Done when: customer lifecycle/entitlement tests pass, recovery is demonstrated, capacity/support claims match evidence and the owner approves the launch scope. Paid Paper service does not require all research features or authorize Live trading.

## APP-5 — Optional Live execution, one broker at a time

Deliverables:
- Choose the initial broker and confirm supported API access/capabilities before scheduling integration.
- Implement an external-order state machine, durable intent, client-order idempotency, partial-fill/cancel handling, uncertain-order reconciliation, balance/rule synchronization and documented protection-order behavior.
- Do not reuse instantaneous Paper transactions as an exactly-once guarantee for remote broker requests.
- Test sandbox/failure scenarios and credential isolation before separately authorized limited Live validation. Keep Paper and Live accounting/permissions explicit.
- Apply the same acceptance process to each subsequent broker; an adapter registry entry is not a working broker integration.

Done when: broker-specific acceptance and recovery evidence exist and the owner explicitly enables the approved scope. No live orders, broker connections or funding are authorized by this roadmap.

## Release discipline

- Each implementation phase ends with a scoped diff, appropriate tests, evidence and documented limitations.
- Node/schema/risk changes run both relevant Node and isolated PostgreSQL tests. Quant-only work runs its own CI and shared-contract checks when needed.
- New migrations require a backup and isolated rehearsal. Research snapshots/reports remain outside Git and public web assets.
- Deploy application changes through immutable releases and atomic symlink swaps. Quant Lab has a separate environment and is not deployed merely because it shares the repository.
- Commit/push/deploy follow the implementation request for that phase. This planning task changes documentation only.

Next implementation milestone: **QL-1**, with R-0 record cleanup as a small prerequisite. Then QL-2 and APP-3 according to the dependencies above.
