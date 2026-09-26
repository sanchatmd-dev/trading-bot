# Quant Lab (QL-1)

Private, isolated Python 3.12 research workspace. No production database connection,
market download, trading, or deployment occurs during imports or tests.

## QL-2A accepted fixed-profile baseline (2026-09-26)

`spt_evaluator.py` implements only the hash-bound SPT Spot v4 Daily/Swing 1-minute profile with HTF/RSI/session/BOS/sweep disabled and no dynamic slots. `bridge_replay.py` models bridge-exit-v2 intents; `bridge_paper.py` models serial funded Spot fills under the complete frozen Node policy. Rejected Pine BUY intents remain in source state, and their later EXIT cannot close another allocation.

The private `python -m robot_quant.ql2a` audit validates source/artifact/snapshot hashes, chart OHLCV/native flags, independent Spot candles and production Node calculation parity via `scripts/quant-bridge-reference.mjs`. `spt_checkpoint.py` restores reviewed Pine state without guessing its unseen prefix; `spt_repaint.py` compares snapshot-bound captures against later chart exports. Checkpoint/input review and the baseline pass: 4,179 measured bars, 92 matching decisions and 130/130 unchanged later-history comparisons (minimum 100). Output remains `BASELINE_CANDIDATE` with `candidate_acceptance_ready=true` and no blockers; it is not a runtime capability registration. QL-3A may define bounds/validation for this fixed profile and the Bridge ATR/RR pair. Dynamic source dimensions require corresponding evaluator/domain evidence. See [implementation and acceptance](../docs/QL_2A_IMPLEMENTATION.md).

No new optimizer or customer endpoint is enabled. The older synthetic EMA capability table below describes historical demo functionality; it does not certify arbitrary Pine or the new workflow.

## QL-3A offline research started (2026-09-26)

`python -m robot_quant.ql3a` binds the accepted QL-2A report, source/snapshot, implementation and frozen TradingView CSV. It exhaustively evaluates 25 Bridge ATR/RR pairs on the fixed SPT profile, carrying source/Bridge/Paper state through chronological train and validation. The test period is replayed only after a train/validation candidate qualifies. First run: `NO_VALID_CANDIDATE`; every pair has three closed train trades and zero validation trades under the unchanged Bot policy. No customer recommendation, export, capability registration or production write occurs. See [QL-3A record](../docs/QL_3A_IMPLEMENTATION.md).

`spt_custom_evaluator.py` is a separate, source-hash-bound Custom preset evaluator candidate. It accepts an explicit, reviewed effective-input snapshot and at most eight distinct selected numeric source slots. Each varied candidate starts from its own causal state, with Bridge ATR(14) independent of source ATR. The old fixed-profile result is untouched. Custom TradingView parity, an adequate new Paper sample and durable bounded job integration are still required before any Best Inputs can be issued.

The Chatbot worktree now captures all effective Pine input values through local inspection and explicit owner review before AI analysis. The reviewed source/effective-input hashes flow into the source revision and Custom snapshot verifier. This does not substitute for a TradingView Custom trace or certify arbitrary Pine.

## Reproduce

Install Python 3.12 and uv 0.12.17, then from `quant_lab/`:

```sh
uv sync --locked --all-extras
uv run --no-sync ruff check .
uv run --no-sync pytest
uv run --no-sync python -m robot_quant.smoke
```

Installation downloads packages; tests run offline and block socket connections.
`uv.lock` records exact versions and artifact hashes for Linux/Windows. Core-only
installation is `uv sync --locked`; add `--extra market` or `--extra research` as
needed. The research extra deliberately pins pandas-ta 0.4.71b0 (a prerelease).
Python versions other than 3.12 are unsupported. CI verifies both target operating
systems; local evidence must not be presented as a completed hosted CI run.

Plotly is constrained to 5.x: the initially resolved Plotly 7 failed vectorbt import
because its template rejected `scattermapbox`. This compatibility bound is backed
by the import smoke, not just dependency resolution.

`python -m robot_quant.smoke` imports every extra without requesting prices.
The synthetic EMA template exists solely for contract fixtures. SPT transport
metadata is recognized, but optimization and order-fill export are unavailable
until the effective-input adapter and historical evaluator pass parity tests.

## Contracts and compatibility

`robot_quant.contracts` supplies frozen Pydantic models and JSON Schema through
`Model.model_json_schema()`: risk snapshots, parameter bounds, strategy definitions,
optimization runs, export metadata, ownership scope, position intents and decisions.
Unknown fields/versions fail closed. Decimal fields accept decimal strings and
preserve up to 18 fractional digits; JSON serialization keeps monetary values as
strings. Hashes identify immutable serialized snapshots. Reconstruct and validate
models at each trust boundary; Pydantic `model_copy(update=...)` bypasses validation
and is not an import or mutation interface.

RiskProfile is a QL-1 snapshot subset, not a replacement for the complete runtime
risk policy. Keep the complete Node policy alongside its source/schema version in
QL-2 datasets. Search fields belong to the reviewed template registry. Account
limits cannot appear in parameter bounds; changing risk requires a separate run.
The 100% ceiling is a maximum, not a recommended requested risk or automatic search
range. Alert source is required explicitly for strategies and exports.

Scope in a research record is provenance, not authentication. A future server must
bind owner, bot, account and deployment to authenticated records before accepting
an intent. PositionIntent describes the proposed scoped contract only: it is not
a webhook payload supported by the current receiver. Do not send these records to
production. Missing targets cannot be modeled as implicit symbol-wide exits.

Current v1 webhook clients remain unchanged. A future versioned endpoint must
explicitly negotiate scoped capability, reject unknown versions, and keep legacy
holdings in a named legacy bucket. It must never silently downgrade a scoped exit.

## Persistence design (no database migration in QL-1)

Future append-only records: risk versions, source/template versions, input sets,
optimization runs, export manifests and capability evidence. Keys include owner,
bot and version; deployment references must include the same ownership scope.
Each record retains author/time, content hash, prior version, and dependency/data
hashes. Changes append a new version and invalidate dependent validation evidence.
Existing positions retain their entry deployment and exit ownership across updates.
DB constraints, authenticated access, schema migration, shadow decisions and
rollback rehearsal belong to later runtime work; frozen Python models alone do
not provide durable immutability or authorization.

Capability registry for this phase:

| Template | Contract fixtures | Historical parity | Optimization | Validated export |
| --- | --- | --- | --- | --- |
| synthetic-ema-v1 | Yes | Yes (QL-2) | Yes (ConstrainedOptimizer) | Yes (QL-4) |
| spt-pro-v4-transport-v1 | Metadata only | Unverified | Unavailable | Unverified |

Run/Pause/Stop/Reset and immutable session archives from the roadmap remain runtime
design requirements. This scaffold does not change active bots or their policy.

## Isolation and CI

`quant_lab/` is excluded from Docker and `git archive` application payloads. Other
release packagers must explicitly exclude it too. No Python dependency is added
to npm. Keep data, reports, environments, credentials and notebook outputs out of
Git; only small synthetic fixtures belong in tests. Strip notebook outputs before
committing. Reports are private local files, never public assets.

Both workflows always trigger. `scripts/ci-scope.mjs` routes heavy jobs:

| Change | Node/container/PostgreSQL | Quant |
| --- | --- | --- |
| Quant only | Skip | Run |
| Docs only | Skip | Skip |
| Public frontend only | Run | Skip |
| Node source/tests, shared schemas/risk/analytics, workflow | Run | Run |
| Missing comparison history | Run | Run |

No workflow-level path filters or branch-protection settings are changed. Existing
Safety checks job names are retained; the new Quant gate reports failure when scope
classification or Quant checks fail. Hosted results require a subsequent push.

## R-1 dependency caveat

The latest handoff and Context.md report R-1 delivered at b2cb863/schema 12.
Repository inspection found aggregate exit sizing in `src/postgres/risk.js`, FIFO
fallback in `src/postgres/ledger.js`, and aggregate Pine state. The existing
`test/scale-in.test.js` checks normalization only. Consequently this QL-1 work does
not certify per-entry execution, migration rehearsal, or Paper acceptance. QL-2
must distinguish observed current-runtime behavior from proposed scoped semantics.
Production remains deferred.

## QL-3: Backtest Simulation & Constrained Optimization

QL-3 delivers an offline backtest engine, parameter optimizer, and walk-forward validator:
- **Deterministic Market Data (`market_data.py`)**: Generates multi-year synthetic OHLCV candle datasets
  without network access. Strict candle invariants ($high \ge \max(open, close)$, $low \le \min(open, close)$,
  $low > 0$, $volume > 0$). Supports Parquet and DuckDB analytical queries with SHA-256 dataset digests.
- **Reference Strategy (`strategy.py`)**: Verified `synthetic-ema-v1` indicator and signal generator.
  Bar-close signal timing, next-bar open execution, ATR-based stop loss, conservative same-bar SL priority,
  and indicator warm-up handling.
- **Backtest Simulation & Ledger (`backtest.py`)**: Spot long-only simulation layer enforcing non-negative cash
  balances and inventory-limited reduce-only exits. Produces auditable transaction ledgers (`SignalRecord`,
  `FillRecord`, `CashJournalRecord`, `PositionAllocationRecord`) that reconcile realized PnL and trade counts
  exactly with QL-2 FIFO analytics (`fifo_analytics` and `summarize_closed_positions`) at 80-digit precision.
  Reports both cost-based book equity and mark-to-market equity curves.
- **Chronological Validation (`validation.py`)**: Chronological train / validation / test partitioning
  matching `OptimizationRun` contract boundaries (`train_end < validation_end < test_end`) with zero data leakage.
  Generates rolling walk-forward evaluation windows for regime robustness testing.
- **Constrained Optimizer (`optimizer.py`)**: Searches parameter spaces strictly constrained by `ParameterBounds`
  and cross-field invariants (`ema_fast < ema_slow`). Evaluates candidates across multi-stage gates:
  baseline comparison, parameter sensitivity stability ($\pm 1$ step neighbor check), fee/slippage stress
  testing ($2\times$ fee and slippage), and out-of-sample test verification. Produces immutable `OptimizationRun`
  contract records.
- **Risk Simulation Preview (`risk_preview.py`)**: Pre-flight sizing estimates, consumed/free capital breakdowns,
  position capacity calculations, and active constraint audits.
- **Thin Experiment Interface (`notebooks/01_backtest_and_optimization.ipynb`)**: Interactive demonstration
  of the end-to-end research workflow with outputs stripped for git hygiene.

## QL-4: Risk Reports, Pine Script Export & Webhook Integration

QL-4 delivers offline reporting, Pine Script v6 export bundles, and webhook metadata integration:
- **Offline HTML Tear Sheets (`reporting.py`)**: Generates comprehensive standalone HTML performance reports
  with inline SVG equity and drawdown curves. Safely handles zero-variance/zero-trade scenarios, utilizes
  exact geometric compounding for multi-period returns, and formats monetary statistics at full precision.
- **Pine Script v6 Exporter (`exporter.py`)**: Exports 6-file deployable bundles (`strategy.pine`, `strategy.json`,
  `risk-profile.json`, `inputs.json`, `setup.md`, `validation.html`) supporting both `alert_calls` and `order_fills`
  modes without mutating indicator formulas.
- **Input Preset Diff Engine**: Computes exact before/after parameter diffs and applies optimized values exclusively
  to user-selected input defaults while preserving indicator structure and comments.
- **Webhook Strategy Metadata**: Validates `strategy_id`, `strategy_version`, `deployment_id`, and `alert_source`
  in webhook payloads to ensure traceable execution.

## Engineering Audit Hardening & P1 Blocker Fixes

Following independent review (`HANDOFF_AUDIT_QL1_QL4_826daf2.md` and `HANDOFF_QL_FIXES_REVIEW.md`), all 12 findings
and 4 P1 blockers were systematically resolved:
1. **P1#1 (Export Hardcoding)**: Injected actual frozen `RiskProfile` (with hash digest verification against the run),
   `broker`, `symbol`, and `timeframe` dynamically into exported Pine Script and JSON bundles.
2. **P1#2 (Capital Separation)**: Separated `balance` from `initial_capital` in `BacktestConfig`, initializing cash
   strictly from `balance`.
3. **P1#3 (Quote Sizing Precedence)**: Restructured `risk_evaluator.py` sizing order so quote/percent equity sizing
   resolves before target allocation remaining bounds are applied, and defaulted unallocated exits to position limits.
4. **P1#4 (Targeted Order Fills in Pine)**: Rewrote Pine order-fill exporter to track active trades via
   `var string currentEntryId = ""` and close positions using `strategy.close(currentEntryId)`.
5. **Positive Regression Suite**: Converted all audit probes into standard independent pytest cases in
   `quant_lab/tests/test_audit_regressions.py` (7 tests).

## Local validation — 2026-09-22

- Windows / Python 3.12.14: clean dependency installation from `uv.lock` with all extras succeeded;
  `uv lock --check --offline` confirms the manifest matches it.
- Ruff passes with zero violations (`ruff check quant_lab`).
- 70 offline pytest cases pass (`pytest quant_lab/tests`), verifying NUMERIC(38,18) precision,
  deterministic market data, reference strategy execution, FIFO ledger reconciliation,
  chronological validation, walk-forward splitting, constrained optimization, HTML tear sheets,
  Pine Script export, and all audit regression invariants.
- Node regression: 111/111 pass (`npm test`).
- Changes remain strictly isolated in `quant_lab/`; production database, schema, and workers remain untouched.
