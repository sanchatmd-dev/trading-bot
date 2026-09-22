# Robot Trade — Handoff for Antigravity

Date: 2026-09-22 (Asia/Bangkok)  
Repository: `C:\Users\USER\Documents\Codex\2026-09-13\create-an-image-of\work\astra-vps-trade-bot-v2`  
Branch: `main`  
Remote HEAD: `ab2aa2d4760984840e8c498baccacf0349814e9f`  
Production: `https://www.robottrade.io`  
Mode: PostgreSQL schema 11 in production, Spot Paper-only, immutable releases plus symlink.

## Current status

QL-1 implementation is committed and pushed:

- `32625fb feat(quant): scaffold QL-1 contracts and CI`
- `ab2aa2d docs: record QL-1 local validation and gates`

The working tree was clean after the latest push. No production service, database,
VPS configuration, webhook, alert, or deployment was changed by QL-1.

QL-1 added an isolated Python 3.12 workspace at `quant_lab/`. It has a pinned
`uv.lock`, offline tests, frozen Pydantic contracts, package import smoke tests,
and CI workflows. `quant_lab/` is excluded from Docker and Git archive release
payloads. No Python package was added to the Node runtime.

Local validation completed:

- Node regression: 104/104 pass.
- Quant tests: 27/27 pass.
- Ruff, `uv lock --check --offline`, workflow YAML parsing, and all locked package
  imports pass.
- `vectorbt` requires Plotly 5.x; `pyproject.toml` constrains Plotly below 6 after
  Plotly 7 rejected vectorbt's `scattermapbox` template during import.

QL-1 acceptance is still open. Required remaining evidence:

1. GitHub Actions results for commit `32625fb`/current `main`: Linux and Windows
   Quant jobs plus existing Safety checks.
2. `npm run test:postgres` against an isolated PostgreSQL test database. Do not use
   production as a test database.

The local machine had no `TEST_DATABASE_URL`, PostgreSQL tooling, or Docker
available. Do not report QL-1 as fully accepted until these checks pass.

## QL-1 files

- `quant_lab/pyproject.toml`, `quant_lab/uv.lock`: Python 3.12 dependencies and lock.
- `quant_lab/src/robot_quant/contracts.py`: immutable, extra-forbidden models for
  scope, risk profile, parameter bounds, strategy definition, run, export metadata,
  position intent and decision.
- `quant_lab/tests/`: offline contract and notebook-output tests. Socket access is
  blocked during tests.
- `quant_lab/README.md`: install commands, contract boundaries, capability registry,
  persistence design, and known limits.
- `.github/workflows/quant-lab.yml`: Windows/Linux lock, Ruff, pytest and import
  smoke workflow.
- `scripts/ci-scope.mjs` and `test/ci-scope.test.js`: routes CI heavy jobs. Workflows
  always trigger; jobs skip only when change scope is known safe, avoiding pending
  required-check behavior caused by workflow path filters.

## Start QL-2 only as isolated research

QL-2 may begin while QL-1 acceptance evidence is pending, provided no production
schema, production database, API/worker behavior, or deployment changes occur.

First QL-2 work should be read-only and fixture-driven:

1. Create synthetic fixtures and an explicit read-only data contract for signals,
   fills, cash journal, funding, and reviewed analytics fields.
2. Keep Decimal values as strings through export/storage. Do not silently coerce
   money to pandas floats.
3. Build golden parity fixtures against `src/postgres/analytics.js` and
   `src/postgres/risk.js` for partial exits, scale-in, funding, fees, limits,
   duplicate/stale signals, and reduce-only exits.
4. Define a dedicated research-reader role and bounded read-only connection only in
   an isolated database first. Production has Unix-socket PostgreSQL only; never
   enable TCP as fallback.
5. Record dataset hash, source, cutoff, currency, owner/bot scope, and schema
   version. Never export credentials, sessions, webhook secrets, or unrestricted
   raw payloads.

## Critical R-1 caveat

Repository documentation has been reconciled across `README.md`, `Context.md`, and `docs/ROADMAP.md` to record R-1 delivery in commit `b2cb863` (Schema 12).
However, repository inspection before QL-1 found:

- `src/postgres/risk.js` can size an exit from aggregate symbol holdings.
- `src/postgres/ledger.js` has an allocation FIFO fallback when no target matches.
- `tradingview/spt_pro_v4_robot_trade.pine` retains aggregate transport state.
- `test/scale-in.test.js` validates normalization, not end-to-end P1/P2 isolation.

Treat R-1 end-to-end acceptance as unproven. Do not enable independently managed
repeated BUY entries or declare targeted TP/SL safe without migration rehearsal,
concurrency tests, Pine validation, and controlled Paper evidence. QL-2 must label
current aggregate behavior separately from proposed scoped position semantics.

## Production constraints

- Production is Paper-only. Live execution remains locked.
- PostgreSQL production schema remains 11 until an approved, rehearsed migration.
- Production uses `npm run start:postgres` and `npm run worker:postgres`; do not use
  legacy `npm start` as a production runtime.
- Before any database migration: run `scripts/backup-postgres.mjs`, restore into an
  isolated database, verify records and secrets, then use immutable release plus
  symlink swap. Do not alter production DB before rehearsal passes.
- Do not store secrets, URLs, credentials, tokens, or key material in docs or Git.

## Primary references

- `Context.md`: production history and current operational constraints.
- `docs/ROADMAP.md`: QL-1 through QL-4 and APP sequence.
- `docs/UNIVERSAL_RISK_MANAGER.md`: ownership, allocation, reservation and parity design.
- `quant_lab/README.md`: exact QL-1 local validation and setup steps.
- `docs/PHASE2.md`: PostgreSQL operations, migration and restore restrictions.
