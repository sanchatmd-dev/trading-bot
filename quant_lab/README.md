# Quant Lab (QL-1)

Private, isolated Python 3.12 research workspace. No production database connection,
market download, trading, or deployment occurs during imports or tests.

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
| synthetic-ema-v1 | Yes | Yes (QL-2) | Yes (ConstrainedOptimizer) | Pending QL-4 |
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

## Local validation — 2026-09-22

- Windows / Python 3.12.14: clean dependency installation from `uv.lock` with all
  extras succeeded; `uv lock --check --offline` confirms the manifest matches it.
- Ruff passes with zero violations (`ruff check quant_lab`).
- 56 offline pytest cases pass (`pytest quant_lab/tests`), verifying NUMERIC(38,18) precision,
  deterministic market data, reference strategy execution, FIFO ledger reconciliation,
  chronological validation, walk-forward splitting, constrained optimization, and risk simulation preview.
- Node regression: 104/104 pass (`npm test`).
- Changes remain strictly isolated in `quant_lab/`; production database, schema, and workers remain untouched.
