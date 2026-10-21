# F09 builder slice S3: trace reproduction module (draft design, Opus primary)

Status: draft for root review, 2026-10-21. Read-only design. Nothing here is accepted, wired, installed or deployed.
Repository revision read: HEAD `05e7a47` (uncommitted F11 multi-Pine files ignored).
Authority: `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (cited below as CT), sections 3.1, 4.1, 5.3, 8, 10, 10.1, 10.2.
The original local builder design D1 to D12 is lost. This draft restates the S3 part only from CT and current code.
`CODE:` marks a fact read from code at HEAD; code facts are interface facts, not acceptance evidence.

## 0. Summary of decisions

| ID | Decision | Basis |
| --- | --- | --- |
| T1 | Recompute five step kinds of the selected candidate: `candidate` (kind CANDIDATE), every sensitivity neighbour (kind CANDIDATE or SENSITIVITY, derived from the contract), `stress:selected` (STRESS) and `holdout:selected` (HOLDOUT). Re-selection over all candidates is out of scope. | CT 5.3 row "trace files reproduce the stored steps for the selected candidate, sensitivity, cost-stress and `holdout:selected`"; CODE `quant-research-worker.js` `run()` |
| T2 | The three trace files are `quant-data/equity.csv`, `trades.csv`, `decisions.csv`, rendered from one extra recomputed HOLDOUT replay of the selected parameters. | CODE `package-gates.js` `TRACE_FILES`; schema `bi_trace_reproductions_path_check`; `package-render.js` `trace` input |
| T3 | Step results are recomputed through the exact run engine path: the exported `pythonEvaluation` of `src/postgres/quant-research-worker.js`, which spawns `robot_quant.research_engine`. No closure file changes, so every existing engine hash stays the same. | RC-17; CODE `quant-research.js` lines 19-21 and `engineHash` |
| T4 | Trace rows come from a new Python driver outside every closure that calls the unchanged `research_engine.evaluate` and captures the `paper_replay` return by wrapping that one module attribute. Its `result` must equal the engine-path HOLDOUT result byte for byte, otherwise the build is refused. | RC-17 "outside the run engine closure"; CT 8 deterministic build |
| T5 | Comparison: exact equality of SHA-256 over canonical JSON (the gate module digest). Zero tolerance. No numeric tolerance exists anywhere in S3. | CT 5.3 "(canonical bytes)"; CODE `package-gates.js` `storedStepDigests`, `traceReproduced` |
| T6 | S3 judges nothing. It writes recomputed digests even when they differ from stored steps; gate C3 alone emits `BI_RESULT_MISMATCH` / `HOLDOUT_MISMATCH`. It refuses the build only when it cannot recompute (engine hash, contract hash, run shape, evaluator failure, tap divergence). | RC-4, RC-17 |
| T7 | One record per trace file maps to one `bi_trace_reproductions` row; `steps_digest` and `holdout_digest` are the same per-run values on all three rows; `sha256` is the digest of the rendered file bytes. Rows are inserted by the S4 build transaction after the seq 1 `EXPORT_CANDIDATE` event. No schema change. | CODE schema lines 251-269, header step 5; migration lines 77-80, 119, 213-222 |
| T8 | Runs only locally on labelled fixtures and in a throwaway PostgreSQL cluster. Wired into no route, worker, table writer or UI in S3. Today every reproducible run is engineering scope, so every S3 output is fixture evidence. | CT 2 item 5, 11.2; RC-12; CODE `research_engine.py` scope check |
| T9 | Failure codes: existing codes only for gate-visible outcomes; existing worker codes for evaluator failures; one new module refusal code `TRACE_TAP_DIVERGED` (root to confirm), which never reaches a gate or the owner. | CT 5 intro "existing codes are reused where the meaning is the same" |
| T10 | Slice split S3a (Python driver), S3b (Node module), S3c (fixture and isolated PostgreSQL acceptance), one writer per file. | RC-12; AGENTS.md one writer per file |

Owner-only questions are in section 9. Root-only decisions are marked `ROOT:` inline and listed in section 9.2.

## 1. What is recomputed (T1, T2)

### 1.1 Stored target the gate compares against

CODE `src/quant-library/package-gates.js` `storedStepDigests(selected)` (about line 668) defines the two stored digests:

- `steps` = digest of `{candidate:{parameters, result}, sensitivity, cost_stress}` of `run.result.selected`.
- `holdout` = digest of `{test}` of `run.result.selected`.

`traceReproduced` requires, for each of the three `TRACE_FILES`, exactly one record whose `sha256` equals the hash of the
packaged file bytes, whose `steps_digest` equals `steps`, and whose `holdout_digest` equals `holdout`. A missing, duplicated
or different record gives `BI_RESULT_MISMATCH`; a missing or duplicated record or a different holdout digest also gives
`HOLDOUT_MISMATCH`. S3 must therefore produce, from recomputation only (RC-17), a `steps_digest` over an object of the same
shape and a `holdout_digest` over `{test}`.

### 1.2 Recomputed steps

The worker `run()` (CODE `quant-research-worker.js` lines 102-138) produced the stored steps. S3 recomputes the same steps
for the selected candidate only, with inputs taken from the frozen contract and the selected parameters, never from
stored results:

1. `candidate`: kind `CANDIDATE`, parameters `selected.parameters`. Precondition: `selected.parameters` is canonically equal
   to exactly one entry of `contract.plan.candidates`; otherwise the build is refused (section 7, `BI_PROVENANCE_UNRESOLVED`).
2. `sensitivity`: the neighbour list is re-derived from the contract with the worker rule, not read from the stored list:
   for each `name` of `Object.keys(contract.input_lock.domains).sort()`, for `next` in `[index-1, index+1]` inside the grid,
   parameters `{...selected.parameters, [name]: grid[next]}`, skipped when `validParameters(parameters, fixed)` is false
   (`fixed` from `contract.input_lock.selection.fixed_inputs`). Each entry is `{dimension, parameters, result}`.
   The kind is `CANDIDATE` when the neighbour parameters equal a plan candidate (the worker reused the saved candidate
   result), otherwise `SENSITIVITY`. The kind is derived from `contract.plan.candidates`, never from the stored result.
   Reason: the stored result object carries `kind`, so a wrong kind changes the digest.
3. `cost_stress`: kind `STRESS`, parameters `selected.parameters` (the engine doubles fee and slippage for STRESS).
4. `holdout:selected`: kind `HOLDOUT`, parameters `selected.parameters`. Only `result.test` enters the holdout digest.

The recomputed steps object is `{candidate:{parameters, result}, sensitivity:[...], cost_stress:result}` and the holdout
object is `{test: holdoutResult.test}`. Both are digested with the same canonical hash the gate uses (section 4).

Not recomputed, by design:

- The other plan candidates and the selection itself. CT 5.3 names only the selected candidate, sensitivity, cost-stress and
  holdout. Re-selection would multiply cost by the plan budget. A wrong `selected` is still caught: the candidate step must
  be a plan member, and gate C3 compares `metrics.json` and `validation.json` with the stored selection. The residual risk
  (stored selection not the true argmax) is listed in section 11.
- `screen_reasons`, which the gate does not digest.

### 1.3 Holdout handling

The holdout recomputation re-runs the already-evaluated holdout of the same run for the same parameters. It creates no new
exposure and selects nothing. Guards, all before any evaluation:

- Run status `SUCCEEDED`, `result.holdout_evaluated === true`, `completion_reason === 'RESEARCH_CANDIDATE_PENDING_ACCEPTANCE'`.
  Otherwise refuse with `HOLDOUT_NOT_EVALUATED` or `BI_RUN_NOT_QUALIFIABLE` (existing CT 4.3 codes). B0 already requires
  this; S3 repeats it so the module cannot open a holdout on its own.
- The HOLDOUT kind is used only with `selected.parameters`. No other parameters ever reach a HOLDOUT evaluation. A test pins
  this (section 10, mutation M10).
- The holdout results are never returned to a caller except as the `{test}` digest and the trace rows (section 3).

### 1.4 Trace source

The three trace files come from one extra recomputation: the HOLDOUT replay of `selected.parameters` over the full bar
range, which is one continuous path from warm-up to `test_end`. `mark_period` (CODE `ql3a.py` line 87) derives train,
validation and test metrics from this same fill list, so the trace and the metrics share one path. The Python driver
returns the replay `fills` and `decisions` with the engine result (section 2.2). Trace rows from the warm-up (bars before
`split.warmup`) are excluded. What the trace contains for the holdout partition is an owner question (section 9, OQ-1).

## 2. Engine path and engine-hash invariance (T3, T4)

### 2.1 Step results: the run engine path, reused, unchanged

S3 calls `pythonEvaluation(contract, parameters, kind, signal, options)`, exported by CODE
`src/postgres/quant-research-worker.js` line 12. It is the exact function the worker used for every stored step:

- It slices `contract.dataset.bars` to `split.validation_end` for every kind except HOLDOUT ("Holdout candles never enter a
  candidate/sensitivity/stress subprocess"). Reusing it keeps that guard without a copy.
- It spawns `python -m robot_quant.research_engine` with the same request `{contract, parameters, kind}`, the same 8 MiB
  input bound, 2 MiB output bound, timeout and stderr suppression.
- After each call S3 applies the same result shape check the worker applies in `step()` (parameters echo, kind echo,
  `train`/`validation` present, `test` only for HOLDOUT, metric types). ROOT: the check is duplicated in S3, because the
  worker keeps it inside the `step` method. Extracting it would change a closure file and rotate the engine hash, so S3
  copies it (small, pinned by a test that feeds the same bad responses to both).

Engine closure identity (RC-17):

- `contract.version` must be `ql3a-research-job-v1`, the only version `research_engine.evaluate` accepts (CODE
  `research_engine.py` line 21). The legacy worker runs with `foundation === false` (CODE worker `claim()` throws
  `RESEARCH_FOUNDATION_WORKER_REQUIRED` otherwise), so the run closure is `LEGACY_ENGINE_FILES` and the expected hash is
  `engineHash(false)` (CODE `quant-research.js` lines 19-38).
- S3 computes `engineHash(false)` before the first evaluation and again after the last one (the worker pattern: check before
  and after each step). Either value different from `contract.engine_hash` refuses the build with
  `BI_ENGINE_HASH_MISMATCH` and writes no row (RC-17).
- Any other contract version refuses the build. ROOT: code for this refusal; recommended `BI_ENGINE_HASH_MISMATCH`, because
  no reviewed engine closure exists for that version and RC-17 already maps "closure cannot be matched" to this code.
  Alternative: a module refusal code. The first option adds no code.

Why existing engine hashes stay unchanged:

- S3 edits no file in `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`, `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`,
  `FIXED_EVAL_ENGINE_FILES` or the multi-Pine closure. It only imports `pythonEvaluation`, `engineHash`, `validParameters`
  and `canonical`/`hash`. Importing a module never changes its bytes.
- New files (section 8) are added to no closure list. A closure-invariance test (section 10, T-CL) pins this: it asserts the
  new paths are absent from every closure list and that `src/quant-research/runtime-engine-files.js` is unchanged.
- `src/postgres/quant-research.js` lines 19-21 and `src/quant-research/preflight-resolver.js` lines 26-54 are not edited.
- Why not `fixed_eval.py` (QR-4 `FIXED_INPUT_EVAL`): it is a different evaluator with its own closure
  (`fixed-eval-closure-v1`, CODE `quant-fixed-eval-engine.js`) and its own result shape (`_report`). Its output cannot equal
  the stored research step bytes, and its hash is not the run `engine_hash`. Using it would make every reproduction a
  mismatch, or would need a mapping layer that copies stored structure, which RC-17 forbids. `fixed_eval.py` is unchanged.

### 2.2 Trace rows: a new driver outside every closure

The engine result has aggregates only (CODE `research_engine.py` lines 61-71: train, validation, test, counts); it drops
`replay["fills"]` and `replay["decisions"]`. Emitting them from `research_engine.py` would rotate the run engine hash and
break every existing run (worker `QUANT_ENGINE_CHANGED`, C3 `BI_ENGINE_HASH_MISMATCH`). So S3 adds a new driver module,
`quant_lab/src/robot_quant/trace_reproduce.py`, outside every closure:

- Input on stdin, same bounds: `{contract, parameters}`; kind is fixed to `HOLDOUT`; the full contract is passed (no slicing,
  holdout included), exactly what `pythonEvaluation` passes for HOLDOUT.
- It imports `robot_quant.research_engine` and, for one call, replaces the module attribute `research_engine.paper_replay`
  with a wrapper that calls the original and keeps its return value and its `bars` argument. It then calls the unchanged
  `research_engine.evaluate({contract, parameters, kind:'HOLDOUT'})` and restores the attribute in `finally`.
- Output: `{result, fills, decisions, bar_times}` where `result` is the evaluate output verbatim, `fills` and `decisions` are
  the captured lists, and `bar_times` is only the list of bar close times needed to label partitions (no OHLCV).
- Exactly one captured call is required; zero or more than one fails with the driver error code.
- Errors print only a short code, the `research_engine` and `fixed_eval` pattern (no message, path or traceback).

Binding the trace to the engine path: S3 requires canonical equality between the driver `result` and the HOLDOUT result
from `pythonEvaluation`. A difference refuses the build with `TRACE_TAP_DIVERGED` (section 7). This proves the trace rows
belong to the same computation as the holdout digest. The wrapper changes no value: it passes the same arguments and
returns the same object.

ROOT: alternative considered and rejected: a copy of the evaluate body in the driver. A copy can drift from the engine
without any hash change. The attribute wrapper reuses the engine body itself. Its coupling (the engine must call
`paper_replay` by that module name exactly once) is pinned by the S3a test, and a break fails closed.

Trace engine hash: S3 defines `TRACE_REPRODUCTION_CLOSURE_VERSION = 'trace-reproduction-closure-v1'` and
`TRACE_REPRODUCTION_FILES` = `LEGACY_ENGINE_FILES` plus the Python import closure of `trace_reproduce` plus the two new
files. `traceEngineHash()` = hash of canonical `{version, files:{path: sha256}}`, the `fixedEvalEngineHash` pattern. It is
stored as `trace_engine_hash` (the validator records its own engine hash, OD-13). The S3 test checks the list covers the
Python import closure with the existing `pythonClosure` test helper (CODE `test/fixed-eval-engine.test.js` line 80).

## 3. Trace file content

S3 returns the renderer `trace` input (CODE `package-render.js` line 25): `{equity, trades, decisions}`, each
`{columns, rows}`, cells string, finite number, boolean or null. The renderer turns them into RFC 4180 LF CSV. S3 renders no
bytes; it builds rows only. Every row carries `partition` (`train`, `validation`, `test`), from `split` boundaries over
`bar_times`; warm-up rows are dropped. Decimal values stay as the engine's decimal strings; nothing is re-rounded.

- `trades.csv`, one row per closed position episode (renderer `TRACE_SEMANTICS`): BUY fill paired with its EXIT fill by
  `entry_ref`. Columns (ROOT to pin in S3b): `partition, entry_ref, entry_time, entry_price, quantity, entry_fee,
  exit_time, exit_price, exit_fee, exit_reason, net, realized_r`. `net` uses the `mark_period` formula. An open position at
  the end has no row (fills appear only as closed rows).
- `decisions.csv`, one row per entry of `replay["decisions"]` in engine order: `partition, time, event_type, entry_ref,
  outcome, reason, sizing_outcome, quantity, fee`. `outcome` is FILLED or REJECTED; `sizing_outcome` is ACCEPTED or CAPPED
  for a fill and null for a rejection.
- `equity.csv`: recommended event-sampled curve, one row per fill: `partition, time, cash, position_quantity, equity_at_fill`
  where `equity_at_fill = cash + quantity * fill price`. No per-bar row, so no bar close series ships (CT 4.3 "Holdout bars
  never ship inside a package"). OQ-1 covers the alternative.

Cross-check inside S3 (fail closed, no tolerance): the count of closed trades per partition in `trades.csv` equals
`closed_trades` of the matching recomputed train, validation and test metrics. A difference refuses the build with
`TRACE_TAP_DIVERGED`, because it shows that the pairing logic and `mark_period` disagree.

## 4. Comparison rule and tolerances (T5, T6)

- Digest function: `hash(canonical(value))` from `src/pine-bridge/source.js`, the same function behind `digest` in
  `package-gates.js` line 87. S3 imports `canonical` and `hash` from `source.js`; it does not edit the accepted gate module
  to export a helper. A test asserts that S3 digests over stored-equal steps make C3 pass on the golden fixture, so a
  drift on either side fails the test. ROOT: if root prefers one shared helper, exporting `storedStepDigests` from
  `package-gates.js` is a small change that needs its own review.
- Equality is exact. Recomputed and stored results are both parsed from the engine's JSON output, so the same engine, data
  and parameters give the same canonical bytes. No numeric tolerance, no rounding, no field filtering. The contract asks
  for canonical bytes (CT 5.3), and the engine is decimal-exact (`Decimal`, decimal strings).
- S3 does not compare. It writes the recomputed digests. C3 compares at each validation attempt. A mismatch is therefore
  recorded evidence, ends `EXPORT_REFUSED` at the first attempt (both codes are non-retryable, RC-4), and keeps the package
  manifest and gate report (OD-16). It never becomes a silent build refusal and never a retry loop.
- One deliberate exception: S3 refuses the build when its own two computations disagree (`TRACE_TAP_DIVERGED`), because
  then it has no single recomputed result to record.

## 5. Record mapping to `bi_trace_reproductions` (T7)

Table (CODE schema lines 251-269; migration column list line 119): `export_id uuid`, `path text`, `sha256 text`,
`steps_digest text`, `holdout_digest text`, `trace_engine_hash text`, `run_engine_hash text`, `recorded_at_ms bigint`, all
NOT NULL; primary key `(export_id, path)`; `path` in the three trace paths; every hash `^[0-9a-f]{64}$`; time in
`[0, 253402300799999]`.

| Column | Value |
| --- | --- |
| `export_id` | The export being built (S4 supplies it) |
| `path` | Each of `TRACE_FILES`, one row each, three rows per export |
| `sha256` | SHA-256 of the rendered UTF-8 bytes of that file, taken from the renderer output, equal to the `bi_package_files` row of the same path |
| `steps_digest` | Recomputed steps digest (1.2); same value on all three rows |
| `holdout_digest` | Recomputed `{test}` digest (1.2); same value on all three rows |
| `trace_engine_hash` | `traceEngineHash()` (2.2) |
| `run_engine_hash` | `engineHash(false)` as computed at build, which S3 has proven equal to `contract.engine_hash` |
| `recorded_at_ms` | The build clock value S4 passes in (S3 has no clock), the same instant as the export `created_at` |

Order of the build (RC-16 restated with S3): S3 recompute; render; B0; render again if limitation codes changed (trace
input unchanged, so S3 does not re-run); SERIALIZABLE transaction inserts blobs, export, 12 files and seq 1
`EXPORT_CANDIDATE`, then the three trace rows (schema header step 5: candidate records only while the latest status is
`EXPORT_CANDIDATE`; guard `bi_guard_candidate_record`, SQLSTATE `QR004`; `bi_require_serializable`, `QR003`; edits refused
by `bi_freeze`, `QR002`). S3 exposes `traceRecords(rendered.files, reproduction, recordedAtMs)` that returns the three row
objects; S4 owns the SQL.

Read-back for gate C3 (attempt service, S6): S3 exposes `gateTraceReproduction(rows, contract)` that maps rows to the gate
shape `{path, sha256, steps_digest, holdout_digest}` and drops any row whose `run_engine_hash` differs from
`contract.engine_hash` or whose fields are malformed. A dropped row is an absent record, so C3 gives `BI_RESULT_MISMATCH` and
`HOLDOUT_MISMATCH`. The gate module stays unchanged.

The schema has no cross-check that the trace row `sha256` equals the `bi_package_files` hash. Gate C3 makes that check
against the package bytes, so no schema change is needed in S3. ROOT: optional later hardening; not recommended now,
because S2 is accepted and a schema change rotates the classifier.

## 6. Where it runs (T8)

- Local machine only, on labelled fixtures. Host for every S3 packet: local only; no SSH, no remote shell, no host
  credentials, no VPS, no browser, no TradingView (AGENTS.md host and ultracode rules).
- Database tests use a throwaway PostgreSQL cluster, one test file per process (CT 11.2). S3 itself opens no database
  connection: it is a library with injected ports (`evaluate`, `traceEvaluate`, `engineHash`, `traceEngineHash`). S4 binds
  the real ports.
- S3 is wired into no route, worker, table writer or UI. It is not deployed to staging by this slice (RC-12: no slice is
  deployed without its own gate).
- Fixture-only today: `research_engine.evaluate` refuses any scope other than `SPT_CUSTOM_ENGINEERING_ONLY` (CODE
  `research_engine.py` line 21), and the schema forces `fixture = true` for that scope (CODE schema `bi_guard_export`
  check, `QR004`). So every package S3 can serve today is a fixture package, never READY and never a G8 source (RC-18,
  RC-28). A real package needs the next research contract version and its engine (CT 12 R1); S3 then needs a reviewed
  extension for that closure.
- Cost: per build `1 + n_neighbours + 1 + 1` engine evaluations plus one driver evaluation, where `n_neighbours` is at most
  `2 * dimensions` (at most 10 dimensions: 8 source plus the Bridge pair). On the 10K-bar profile each call is bounded by the
  worker's 30 s timeout. The worker job of S4 must hold the QS-1 admission like any research evaluation; S3 adds no
  scheduler of its own. Nothing runs on a shared host in S3.

## 7. Failure codes (T9)

S3 never emits a gate code into a gate result. It either returns a reproduction or throws a coded refusal (the renderer
pattern, `RENDER_*`). A refusal writes no export row (RC-17). Codes, existing where the meaning matches:

| Condition | Code | Kind | Source of the code |
| --- | --- | --- | --- |
| Run closure hash differs from `contract.engine_hash` (before or after), or unsupported contract version (ROOT, 2.1) | `BI_ENGINE_HASH_MISMATCH` | refusal | CT 4.3, RC-17 |
| `hash(canonical(contract))` differs from `contract_hash`; selected parameters not a plan member; `run.result.selected` absent or malformed | `BI_PROVENANCE_UNRESOLVED` | refusal | CT 5.3 |
| Run not `SUCCEEDED`, completion reason not `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` | `BI_RUN_NOT_QUALIFIABLE` | refusal | CT 4.3 |
| `holdout_evaluated` not true | `HOLDOUT_NOT_EVALUATED` | refusal | CT 4.3 |
| Contract bars missing, wrong length or gapped (the engine refuses) | `BI_DATASET_UNAVAILABLE` | refusal | CT 4.3 |
| Python not available | `QUANT_PYTHON_UNAVAILABLE` | refusal, transient | CODE worker `pythonEvaluation` |
| Timeout, abort | `EVALUATION_TIMED_OUT`, `RESEARCH_INTERRUPTED` | refusal, transient | CODE worker |
| Non-zero exit, error JSON | `EVALUATION_FAILED`, `INVALID_EVALUATION_RESPONSE` | refusal | CODE worker |
| Output or request too large | `EVALUATION_OUTPUT_TOO_LARGE`, `RESEARCH_REQUEST_TOO_LARGE` | refusal | CODE worker |
| Driver result differs from the engine-path HOLDOUT result, or trade counts differ from metrics, or the tap captured not exactly one replay | `TRACE_TAP_DIVERGED` | refusal, new, ROOT | none fits: it is an internal consistency failure, not a stored-result mismatch |
| Recomputed digests differ from stored ones | none at build; C3 emits `BI_RESULT_MISMATCH` / `HOLDOUT_MISMATCH` at attempt 1 | gate | RC-4 |
| Trace row absent, malformed or with another `run_engine_hash` at read-back | none at read; C3 emits `BI_RESULT_MISMATCH` and `HOLDOUT_MISMATCH` | gate | RC-4 |

Transient refusals let S4 retry the whole build within its own bounded policy; a build retry is not a validation attempt
and changes no input (CT 6.1 spirit). ROOT: S4 decides the retry bound; recommended at most 2 build retries, then no row.
`TRACE_TAP_DIVERGED` matches `^[A-Z][A-Z0-9_]{1,63}$`. It is a module refusal like `RENDER_ASSEMBLE_FAILED`, never stored
in a status event and never shown to the owner.

## 8. Slice split, files and writers (T10)

All slices: Coder role (Sonnet 5.5 / high) for writing, Tester (Sonnet 5.5 / medium) plus Architecture auditor
(Opus 5.5 / high) for verify, because S3 touches parity and evaluator logic (AGENTS.md verify panel sizing). No slice
edits an existing file. One writer per file.

| Slice | Writer | New files (only these) | Depends on |
| --- | --- | --- | --- |
| S3a Python driver | Coder A | `quant_lab/src/robot_quant/trace_reproduce.py`; `quant_lab/tests/test_trace_reproduce.py` | none |
| S3b Node module | Coder B | `src/quant-library/trace-reproduction.js`; `test/quant-library-trace-reproduction.test.js` | S3a interface (stdin/stdout JSON), can start in parallel against a stub port |
| S3c Acceptance | Tester | `test/trace-reproduction-closure.test.js`; `test/postgres/bi-trace-reproduction.test.mjs` | S3a and S3b accepted |

Read-only for every S3 writer: `src/postgres/quant-research-worker.js`, `src/postgres/quant-research.js`,
`src/quant-research/*`, `src/quant-library/package-gates.js`, `src/quant-library/package-render.js`,
`src/postgres/best-inputs-package-*`, `quant_lab/src/robot_quant/research_engine.py` and every other closure file.

S3b module surface (pure orchestration plus injected ports, no clock, no I/O of its own):

```text
reproduceRun({run, ports:{evaluate, traceEvaluate, engineHash, traceEngineHash}, signal})
  -> {steps_digest, holdout_digest, run_engine_hash, trace_engine_hash, trace:{equity, trades, decisions}}
traceRecords(renderedFiles, reproduction, recordedAtMs) -> [3 row objects, TRACE_FILES order]
gateTraceReproduction(rows, contract) -> [{path, sha256, steps_digest, holdout_digest}]
TRACE_REPRODUCTION_FILES, TRACE_REPRODUCTION_CLOSURE_VERSION, traceEngineHash(readFile)
```

Default ports (`pythonEvaluation`, a `traceEvaluate` spawner of `robot_quant.trace_reproduce` with the same bounds,
`engineHash(false)`) are exported as a separate `defaultPorts()` so the pure core stays testable and S4 binds them.

## 9. Questions

### 9.1 Owner-only (OWNER)

- OQ-1 (OWNER) Holdout content in trace files. CT 4.3 says holdout bars never ship inside a package, and RC-4 requires a
  holdout digest per trace file, so the traces cover the test partition. Fills, decisions and fill-time equity in the test
  partition are derived data, not bars, but fill prices reveal some holdout prices.
  Recommended default: ship test-partition rows of `trades.csv` and `decisions.csv` and the event-sampled `equity.csv`
  (one row per fill, no per-bar curve), labelled `partition = test`. Packages are owner-private and shown only when READY.
  Alternative A: per-bar equity for all partitions (more detail, ships a per-bar holdout value series).
  Alternative B: drop test-partition rows from the traces; the holdout digest still covers `{test}` metrics. This hides
  holdout trades from the owner review.
- OQ-2 (OWNER) Re-running the opened holdout at build. S3 re-evaluates the holdout of the same run for the same selected
  parameters (twice: engine path and driver). It adds no selection and no new window, but it is one more computation on
  holdout data. Recommended default: allow, only for `selected.parameters`, only when `holdout_evaluated` is true, and
  record it in `limitations` as "holdout recomputed for reproduction". Alternative: skip the holdout recomputation; then
  `holdout_digest` cannot come from recomputation and RC-4/RC-17 cannot be met, so every package fails C3.

### 9.2 Root decisions needed (ROOT, not owner)

- R-a Code for an unsupported research contract version: recommended `BI_ENGINE_HASH_MISMATCH` (2.1).
- R-b New module refusal code `TRACE_TAP_DIVERGED` (7), or an alternative name in the project namespace.
- R-c Attribute wrapper in the driver versus an engine copy (2.2): recommended wrapper.
- R-d Duplicated result shape check in S3 versus extracting it from the worker (extraction rotates the engine hash):
  recommended duplicate plus pin test.
- R-e Trace column lists (3): pin in S3b.
- R-f Build retry bound for transient refusals (S4): recommended at most 2.
- R-g Later schema hardening: the deferred completeness check `bi_guard_export_complete` does not require the three trace
  rows, and `bi_guard_candidate_record` accepts a trace row at any time while the latest status is `EXPORT_CANDIDATE`. A
  writer other than the build could add rows before attempt 1. Recommended: S4 inserts them in the build transaction now;
  a later hardening slice adds "three trace rows at commit" to the deferred check (schema change, own review, classifier
  rotation). Not part of S3.

## 10. Test plan

Python tests run with the project `quant_lab` test runner; Node tests with `node --test`; database tests in a throwaway
cluster. No test writes outside its temp directory. No network.

### 10.1 S3a driver (`quant_lab/tests/test_trace_reproduce.py`)

1. Golden fixture contract (engineering scope, small bar set): driver `result` equals `research_engine.evaluate` HOLDOUT
   output exactly (JSON canonical).
2. Exactly one `paper_replay` call is captured; `fills` and `decisions` equal a direct `paper_replay` call on the same bars.
3. The module attribute `research_engine.paper_replay` is restored after success and after an exception.
4. Bad request (extra key, kind supplied, non-HOLDOUT, oversize) gives only the short error code, no traceback text.
5. Output carries no OHLCV: keys are exactly `result, fills, decisions, bar_times`.

### 10.2 S3b module (`test/quant-library-trace-reproduction.test.js`)

1. With fake ports returning stored-equal results: `steps_digest` and `holdout_digest` make `evaluateProvenance` C3 pass
   for the golden package fixture (no `BI_RESULT_MISMATCH`, no `HOLDOUT_MISMATCH`).
2. Port call log: exact kinds and parameters in worker order; HOLDOUT only with `selected.parameters`; never a stored
   result returned.
3. Engine hash differs before, or changes between before and after: refusal `BI_ENGINE_HASH_MISMATCH`, no partial output.
4. Each refusal row of section 7 by one negation.
5. `traceRecords`: three rows, `TRACE_FILES` order, `sha256` = hash of rendered bytes, all fields match the schema CHECK
   patterns (same regex as the migration column checks).
6. `gateTraceReproduction`: a row with another `run_engine_hash`, a malformed hash or a duplicate path is dropped, and C3
   then gives both mismatch codes.
7. Result shape check: the same bad responses the worker refuses are refused by S3 (pin against drift of the copy).
8. Determinism: same input gives the same digests and trace rows; key order of input objects does not matter.

### 10.3 S3c acceptance

- T-CL closure invariance (`test/trace-reproduction-closure.test.js`): new paths absent from `LEGACY_ENGINE_FILES`,
  `FOUNDATION_ENGINE_FILES`, `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`, `FIXED_EVAL_ENGINE_FILES` and the multi-Pine
  closure; `TRACE_REPRODUCTION_FILES` covers the Python import closure of `trace_reproduce` (`pythonClosure` helper);
  changing one byte of a listed file changes `traceEngineHash`.
- Real engine end to end (local Python, fixture run produced by the existing worker test path): reproduction of an
  untouched run passes C3; tampering one stored sensitivity result, the stored cost-stress result or `selected.test`
  gives `BI_RESULT_MISMATCH` or `HOLDOUT_MISMATCH`.
- Throwaway PostgreSQL (`test/postgres/bi-trace-reproduction.test.mjs`): the three rows insert inside the build
  transaction after seq 1 `EXPORT_CANDIDATE`; outside SERIALIZABLE gives `QR003`; after a terminal status gives `QR004`;
  UPDATE, DELETE and TRUNCATE give `QR002`; a second row for the same path is a primary key violation; read-back through
  `gateTraceReproduction` feeds C3.

### 10.4 Mutation targets (each must turn a named test red)

| ID | Mutation | Caught by |
| --- | --- | --- |
| M1 | Copy stored `selected` results instead of recomputing | 10.2 item 2 (call log), 10.3 tamper test |
| M2 | Read sensitivity neighbours from the stored list | 10.3 tamper test with one neighbour removed from stored |
| M3 | Use kind SENSITIVITY for a neighbour that is a plan candidate | 10.2 item 1 on a fixture whose neighbour is a candidate |
| M4 | Drop the `validParameters` skip | fixture with an invalid neighbour, 10.2 item 1 |
| M5 | Pass STRESS as CANDIDATE | 10.3 end to end |
| M6 | Remove the before or after engine hash check | 10.2 item 3 |
| M7 | Write `contract.engine_hash` without computing the closure | 10.2 item 3 |
| M8 | `sha256` over the trace rows JSON instead of the rendered bytes | 10.2 item 5, C3 in 10.2 item 1 |
| M9 | Remove the driver versus engine-path equality check | 10.2 fake port with a divergent driver result |
| M10 | Allow HOLDOUT for a non-selected parameter set | 10.2 item 2 |
| M11 | Skip the warm-up filter or mislabel a partition boundary | 10.2 trace rows test with a fill at `split.train_end` |
| M12 | Keep an open final position as a trade row | 10.2 trace rows test |
| M13 | Not restore `research_engine.paper_replay` | 10.1 item 3 |
| M14 | Accept a row with another `run_engine_hash` in `gateTraceReproduction` | 10.2 item 6 |
| M15 | Add a new file to a closure list | T-CL |

## 11. Top risks

1. Every reproducible run today is engineering scope; S3 output is fixture evidence only and cannot support a real package
   until a new contract version and its engine closure exist (CT 12 R1). S3 then needs an extension, not a reuse.
2. The attribute wrapper couples the driver to the engine's internal call of `paper_replay`. A later engine refactor
   breaks the trace path; it fails closed (`TRACE_TAP_DIVERGED`), and that engine change also rotates the engine hash.
3. Recomputation is exact; a Python or Decimal runtime difference between the run host and the build host gives a C3
   mismatch and `EXPORT_REFUSED` for a correct run. Mitigation: build on the same reviewed runtime; record the trace engine
   hash. Python interpreter version is not in any hash today (open for root).
4. Selection is not re-verified (only membership); a stored selection that is not the true best candidate passes S3.
5. Holdout exposure through trace content (OQ-1) and holdout recomputation (OQ-2) need owner decisions.
6. Trace rows are not required at commit by the schema (R-g); S4 must insert them in the build transaction.
7. Cost of up to 24 evaluations per build (1 candidate, at most 20 neighbours, 1 stress, 1 holdout, 1 driver) on the 10K-bar profile must go through S4 QS-1 admission.
