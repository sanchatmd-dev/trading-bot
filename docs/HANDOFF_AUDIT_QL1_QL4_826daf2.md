# Independent re-audit handoff — Robot Trade QL-1 through QL-4

Prepared for Antigravity and the project owner. Audit date: 2026-09-22.

## Verdict

**Changes exist through QL-4, but QL-1–QL-4 are not fully accepted.** The existing
unit suites pass, yet this review confirms execution, research-validity and export
defects outside their coverage. Resolve the P1 findings before using exported
alerts or presenting optimized results as execution-equivalent. Infrastructure
scaling and object storage are lower priorities than these correctness failures.

This is an audit deliverable, not an implementation or deployment instruction.
No application source, production service, database or TradingView alert was changed.

## Reviewed snapshot and evidence

- Repository: `C:/Users/USER/Documents/Codex/2026-09-13/create-an-image-of/work/astra-vps-trade-bot-v2`.
- Local `main`: `826daf2d9b83d24f6695281c0db61bcfa5cd38d4`.
- Local tracking state at review: **ahead 2** of `origin/main`; no network refresh
  was performed. Do not assume the two commits are published or covered by hosted CI.
- Latest commits: `826daf2` QL-4; `9a87ab6` R-1; `e2669d9` QL-3;
  `53acf66` QL-2; `32625fb` QL-1.
- Inputs: Desktop `Handoff Report QL-1 ถึง QL-4.txt`, `Context.md`,
  `docs/ROADMAP.md`, root README, Quant Lab README, implementation and relevant tests.
- Fresh local checks: **Node 111/111**, **Python 63/63**, **Ruff passes**.
- Diagnostic reproductions: `docs/audit_ql_repro.py`; six probe groups completed.
  These assert the observed defects at this SHA; they are not acceptance tests.
- Not verified in this audit: hosted CI, real PostgreSQL execution/migration,
  production state, Pine compilation, rendered reports in a browser, or TradingView
  forward delivery. Production schema 11 is the last documented state, not a new
  production observation.

Run the probes from the repository root with the existing Quant Lab environment:

```powershell
uv run --project quant_lab --no-sync python docs/audit_ql_repro.py
```

## Priority findings and handoff acceptance criteria

### F01 — P1: Export replaces the researched risk and market with hard-coded values

Evidence: `quant_lab/src/robot_quant/exporter.py:96`, `:200`, `:413`, `:431`.
Both Pine templates request risk 100%; risk-profile.json also writes requested/max
risk 100%. Export always uses Binance Global/BTCUSDT and metadata timeframe 1h.
The API receives only a risk hash, not the actual RiskProfile, so the emitted
snapshot cannot represent a user's 0.5% risk, THB broker or other market faithfully.
The VPS may reject or cap it, but that does not restore research/export parity.

Fix gate: pass and validate the actual frozen risk/market/interval configuration;
verify its digest; export those exact values. Test a 0.5% profile, non-BTC symbol,
THB broker and multiple intervals. Reject mismatches before writing any package.

### F02 — P1: Research and generated Pine execute different strategies

Evidence: `strategy.py:93` and `:149`; `backtest.py:136`; exporter templates at
`exporter.py:69` and `:170`.
Python is one-position EMA crossover, ATR stop, warm-up, next-open BUY/SELL and
intrabar stop. Export adds a 1.5R TP, never acts on the calculated bearCross,
omits the Python warm-up gate and changes execution timing. Python ATR uses EWM
initialization and four-decimal rounding; Pine uses ta.atr without that rounding.
Order-fill export leaves `slMsg` unused: its combined stop/limit exit always sends
`tpMsg`, so an SL is reported as TP.

Fix gate: one explicit strategy specification, matched signal fixtures including
warm-up/ATR seed, bearish exit, target, gap and same-bar behavior; separate validation
for each alert source. Use reason-specific stop/profit messages in the strategy.
Do not label either export mode validated before Pine compile and Paper forward checks.

### F03 — P1: Exported webhook timestamps and metadata do not match the integration claim

Evidence: `exporter.py:129`, `:228`; `src/domain.js:45`; `src/postgres/risk.js:14`.
Payload timestamp is Pine `time` (bar opening). At close of a one-hour bar it is
about one hour old, so an ordinary 60/120-second stale policy rejects it. Generated
payloads omit strategy/deployment/version/alert-source metadata and news/volatility
fields; enabled guards reject missing values. Entry IDs use only time, so two
exports on the same bot can collide. The receiver accepts arbitrary metadata
strings but does not enforce a supported contract version or authenticated deployment.

Fix gate: distinct bar-close, generation and receipt timing with a defined stale
policy; deterministic IDs scoped to deployment/symbol/timeframe; send and enforce
the negotiated metadata and guard contract. Test actual generated payloads against
the production normalizer/worker, including unknown versions and duplicate IDs.
TradingView documents bar timestamps and realtime-only alert behavior in its
[Time](https://www.tradingview.com/pine-script-docs/concepts/time/) and
[Alerts](https://www.tradingview.com/pine-script-docs/concepts/alerts/) documentation.

### F04 — P1: Rejected or invalid candidates can be exported; validation status is misleading

Evidence: `exporter.py:366` checks only alert-source equality. The diagnostic exports
`status=REJECTED_BOUNDS`, `passed_all_gates=False`, `ema_fast=-5` successfully.
No candidate bounds, run membership, proof hashes or source capability are checked.
At `:350`, a caller-controlled boolean produces an overall VALIDATED label although
returned ExportMetadata remains DRAFT and no Pine/forward evidence exists.

Fix gate: revalidate candidate, immutable run association, provenance and source-specific
capability before filesystem writes. Separate research-screened status from export
compile/forward validation. Invalid inputs must leave no deployable artifact.

### F05 — P1: Backtest drops a pending BUY when its execution bar also hits SL

Evidence: `backtest.py:136–145`. Current-bar SL is selected before previous-bar BUY.
With BUY at bar 0 and SL at bar 1, the engine processes an exit with zero inventory
and never executes the pending entry. Diagnostic result: **zero fills** instead of
entry-at-open followed by stop. This erases a possible losing trade and affects optimization.

Fix gate: sequence pending open fills before intrabar protective checks; drive
position state from accepted fills. Add entry-bar stops, rejected BUYs, gaps and
simultaneous signals to the executable ledger fixtures.

### F06 — P1: Backtest sizing, cash and ownership differ from runtime policy

Evidence: `backtest.py:51–68`, `:102`, `:157–159`.
Backtest treats requested_risk_percent as a fraction of cash to spend. Node Percent
Equity sizes by equity risk divided by stop distance. Example: equity 1000, price
100, stop 95, risk 1% gives 2 units before caps in Node, versus about 0.1 units from
cash allocation in this simulator. It also starts cash from initial_capital, drops
RiskProfile.balance, and writes owner_id into user_id instead of bot_id.
The probe confirms initial_capital=1000/balance=100 loses the balance distinction.

Fix gate: share the tested risk evaluator or explicitly version a different research
mode; retain funded equity versus free cash; preserve canonical bot scope. Test
balance below equity, two bots under one owner, tight stops and all risk gates.

### F07 — P1: Python targeted-exit parity and real-record import are broken

Evidence: `risk_evaluator.py` has no target allocation context and defaults exits to
position.quantity. Executing the same P1-targeted TP against aggregate quantity 3
and P1 remainder 1 produces **Node quantity 1, Python quantity 3**.
`records.py:27–28` rejects actual PostgreSQL statuses FILLED, PARTIALLY_FILLED,
SUBMITTED, CANCELED and EXPIRED; it instead permits PROCESSED/CANCELLED.
Existing parity tests use copied expectations rather than running both current engines.

Fix gate: versioned shared fixtures executed against both languages, with explicit
legacy/scoped exit semantics and actual database status mappings. Add a bounded
read-only export/reader and isolated privilege rejection tests; Pydantic records
alone do not establish a PostgreSQL read-only pipeline or tenant authorization.

### F08 — P1: Optimizer uses the held-out test set to choose the winner

Evidence: `optimizer.py:268–283`: all surviving candidates are evaluated on test;
net-return selection uses `(val_return, test_return)`. Tied validation results are
resolved with supposedly untouched test performance. This is selection leakage.
Also, zero-trade/undefined-metric candidates can pass all gates; there is no minimum
trade requirement. At `:292`, zero drawdown becomes -100 via `or`, producing the
wrong ranking when zero is a valid best result.

Fix gate: choose and freeze the winner using train/validation only, then evaluate
one final test result. Test that changing test prices cannot change selection.
Require sample sufficiency and handle None separately from zero for each objective.

### F09 — P1: Search budget does not bound optimizer allocation work

Evidence: `optimizer.py:139–182`: each parameter's full value list, Cartesian
product and valid-candidate list are materialized before applying search_budget.
The submitted audit is right about OOM, but execution is a sequential custom
backtester, not vectorbt's parallel matrix evaluation.

Fix gate: validate cardinality and positive step before expansion; use bounded lazy
enumeration/batches, time/memory budgets and explicit rejection. Prove budget=1
does not materialize a million-candidate grid. Optuna is optional, not required to fix this.

### F10 — P1: R-1 still lacks full inventory/accounting ownership guarantees

Evidence: `src/postgres/ledger.js:57`, `:111`, `:157`, `:183`.
Each partial BUY fill creates another time-based position ID; target lookup uses
LIMIT 1, so close-remaining by entry trade ID may close only the first fill's lot.
Entry fees enter aggregate cost but not allocation cost; exits remove quantity times
entry_price. BUY 1 @100 plus fee1 then full exit removes cost100 from101, leaving
cost1 despite quantity0. Realized R uses aggregate initial risk, not the closed lot.
Schema 11-to-12 migration creates an empty allocation table without explicit legacy
mapping. Missing-target exits retain symbol-wide behavior without a version gate.

Fix gate: one stable entry identity across partial fills; exact per-allocation
quantity/cost/fees/risk; explicit legacy bucket; negotiated scoped exits; real
PostgreSQL fee/partial/concurrency/migration tests. The updated mocked P1/P2 test is
useful but cannot prove database constraints, transaction rollback or concurrency.

### F11 — P2: Input-only patching can generate invalid Pine or silently omit changes

Evidence: `exporter.py:29–61`; confirmed `input.bool(True, ...)` is emitted for a
Python boolean. Multiline input changes are silently ignored. Strings are not
serialized/escaped by Pine type, and line reconstruction can lose trailing content.
The current test explicitly accepts capitalized True, so it does not catch invalid syntax.

Fix gate: typed literal serialization, exact whitelist match count, unsupported-format
failure, preserved source spans and source-hash/diff validation. Compile supported
outputs. Do not promise arbitrary-source support merely by recommending a linter.

### F12 — P2: Report metrics/provenance contain misleading calculations

Evidence: `reporting.py:192–223`, `:325–339`; `exporter.py:354`.
Annualization always assumes hourly bars. YTD sums monthly percentages rather than
compounding (10%,10% gives20%, not21%). Undefined Sharpe/Sortino are rendered as0.
Export validation labels candidate returns as percentages although optimizer stores
absolute net profit. Reconciliation converts reported closed-cycle PnL back to Decimal,
excluding partial realized results and using ambient precision for an "80-digit"
claim. Report API takes BacktestResult but no dataset/strategy/lock hashes, so full
provenance cannot be shown. User-supplied title/rejection text is interpolated into HTML.

Fix gate: explicit interval/annualization/return units, compounded returns, unavailable
metrics, full-realization/cash reconciliation, immutable provenance and HTML escaping.
Use fixtures for daily/hourly bars, partial exits, no trades and adversarial text.

## Reassessment of the supplied six-point audit

| Supplied point | Independent result |
| --- | --- |
| Manual Python/Node contracts can drift | Confirmed, already occurs: targeted exit 1 versus3 and FILLED rejection. Treat as correctness work now. |
| Float64 ledger needs a final Decimal pass | Inaccurate description of this code. The ledger already uses Decimal with local precision80; indicators and metrics use floats. Fix semantics/rounding and compare real fixtures; Decimal alone cannot guarantee 100% runtime equality. |
| Optimizer OOM | Confirmed, full Cartesian materialization before budget. Cause is Python lists, not vectorbt matrix execution. |
| Regex Pine edits are brittle | Confirmed current failures, including booleans and silent omission. Needs strict rejection and compiler evidence. |
| Local artifacts require cloud storage | Retention/quotas are useful future operations work. S3 is not a prerequisite for private local research. Export currently overwrites existing files; add atomic immutable writes/checksums before scaling. |
| Strategy metadata is entirely dropped by DB | Too broad. `ledger.js:45` stores normalized metadata in signals.payload; order intent also retains fields. Allocation/deployment binding and safe read-only exposure are missing. JSONB alone would not enforce ownership. |

## Phase disposition

| Phase | What exists | Remaining acceptance |
| --- | --- | --- |
| QL-1 | Isolated environment, lock, frozen models, CI routing | Current hosted checks and downstream contract corrections; local tests pass. |
| QL-2 | Synthetic records, FIFO/risk Python code, hashes | Actual reader/export permissions, current cross-language parity, status/scope mapping, representative restored snapshot. |
| QL-3 | Synthetic EMA, Decimal simulator, grid optimizer, split utilities | Execution/sizing corrections, untouched test selection, bounded search, real-data coverage, SPT baseline equivalence and documented research-mode limits. |
| QL-4A | HTML/SVG reports | Metrics/reconciliation/provenance corrections and rendered QA. |
| QL-4B | Six-file Pine export scaffold | Faithful risk/strategy export, candidate/capability gates, exact payload tests, compiler checks. |
| QL-4C | Optional metadata normalizer fields | Authenticated deployment/version enforcement and both TradingView/Paper forward runs with event evidence. |

Synthetic multi-year candles are test fixtures, not verified 1–3-year exchange history.
SPT transport support is not historical SPT input-optimization support. APP-3 runtime
ownership/versioning remains a dependency for scoped QL-4 execution integration.

## Recommended repair order for the next agent

1. Freeze any ready/validated claims for current exports; keep work in isolated Paper fixtures.
2. Correct F05–F07 and F10 first: entry/exit sequencing, sizing/cash, ownership and ledger parity.
3. Correct F08–F09: selection integrity, undefined outcomes and bounded resource use.
4. Correct F01–F04 and F11: export only the validated configuration; test emitted payloads directly.
5. Correct F12; make package writes immutable/atomic and attach checksums and full provenance.
6. Re-run Node/Python/real PostgreSQL tests, verify hosted CI for the exact SHA, compile both Pine modes,
   then execute controlled Paper scenarios with recorded IDs and balances. Prove multiple targeted
   exits on the same candle, stale handling and alert replacement; alert frequency alone is not evidence.
7. Reconcile Context/Roadmap/READMEs from those results. Keep delivered code and accepted behavior distinct.

This audit does not authorize production migration, deployment, Live orders, fixes,
commit or push. Retain the project's backup, isolated restore and immutable-release
requirements for any later authorized production work.
