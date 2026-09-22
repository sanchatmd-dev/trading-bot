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
| synthetic-ema-v1 | Yes | No | No engine yet | No |
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

## Local validation — 2026-09-22

- Windows / Python 3.12.14: clean dependency installation from `uv.lock` with all
  extras succeeded; `uv lock --check --offline` confirms the manifest matches it.
- Ruff passes; 27 offline pytest cases pass, including full NUMERIC(38,18)
  precision, decimal JSON round trips, immutable risk, invalid versions/units,
  bounds, locked candidates, scoped intents and export provenance.
- All 12 package imports in `robot_quant.smoke` pass after the Plotly 5 constraint.
- Node regression: 104/104 pass, including the CI routing matrix. `git diff --check`
  passes and both workflow YAML files parse.
- Linux/Windows hosted workflow results and real PostgreSQL integration remain
  pending. This machine has no configured TEST_DATABASE_URL or available PostgreSQL
  tools/Docker. No production database is used as a substitute.
- Changes remain local and uncommitted; no deployment or production change occurred.
