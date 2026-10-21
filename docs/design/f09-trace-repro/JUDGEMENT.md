# F09 builder S3 trace reproduction: design judgement

Status: judge output for root, 2026-10-21. Role: Architecture auditor as design judge (Opus 5.5 / high). Root: "Root: astra-vps-trade-bot-v2".
Nothing here is accepted, implemented, wired or deployed. Root decides. Read-only review; no Git, no tests run, no host work.

Inputs judged:

- Primary: `DRAFT_OPUS.md` (cited as OPUS with its section numbers).
- Alternative: `DRAFT_FABLE.md` (present; cited as FABLE). Per AGENTS.md, no Fable finding below is used unless this judge confirmed it in code.
- Authority: `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (cited as CT), sections 2, 4.3, 5.3, 8, 10.1 (RC-4), 10.2 (RC-12 to RC-33), OD-1 to OD-20.

Revision note: the task names HEAD `05e7a47`. The checkout HEAD is `2b8d398`. `git diff --name-only 05e7a47 HEAD` touches only multi-Pine and QR-2 files
(`src/multi-pine/fixture-service.js`, `src/postgres/qr2-compute-pool.js` and their tests). No file read for this judgement differs between the two
revisions. Uncommitted F11 multi-Pine files were ignored.

Next free contract row number: RC-34 (CT 10.2 ends at RC-33, line 764).

## 1. Verdict summary

| ID | Decision | Pick | One-line reason |
| --- | --- | --- | --- |
| J1 | Steps recomputed | OPUS (T1) | FABLE recomputes a candidate-equal neighbour as SENSITIVITY; the stored entry has `kind: CANDIDATE`, so its digest can never match |
| J2 | Trace source | Merge | One HOLDOUT replay of `selected.parameters` (both); event-sampled equity (OPUS) as default; Decimal arithmetic in Python (FABLE) |
| J3 | Engine path, legacy runs | Merge | Non-holdout steps through the unchanged `pythonEvaluation` (OPUS); HOLDOUT once, through the new driver with the scoped `paper_replay` capture (OPUS wrapper, not the FABLE mirror); no second HOLDOUT run |
| J4 | Engine path, foundation runs | FABLE design, deferred slice | Foundation runs exist and use `engineHash(true)`; OPUS would refuse them with a false `BI_ENGINE_HASH_MISMATCH`. Refuse with a module code now; add the `evaluate_chunk` trace-sink path in a later slice S3d |
| J5 | Comparison rule | Both (identical) plus FABLE test | Exact canonical digests, zero tolerance, S3 never judges; add the FABLE JSONB round-trip acceptance test as the premise check |
| J6 | Record mapping | OPUS, plus FABLE S4 assertion | Three rows, column map as OPUS 5; S4 asserts each `sha256` equals the `bi_package_files` row; no schema change |
| J7 | Trace engine hash | OPUS | `trace-reproduction-closure-v1` covers the S3 files plus every engine file they execute, the `fixedEvalEngineHash` pattern |
| J8 | Where it runs | Both (identical) | Local, fixture-only, throwaway cluster for SQL tests, no route or worker wiring |
| J9 | Failure codes | Merge | Existing codes first, using CT 4.3 split (`STATUS_NOT_COMPLETED`, `BI_RUN_NOT_QUALIFIABLE`, `HOLDOUT_NOT_EVALUATED`); two new module refusal codes; never `BI_ENGINE_HASH_MISMATCH` for an unsupported backend |
| J10 | Slice split | OPUS shape, FABLE file name, plus doc packet | Lanes A (quant_lab) and B (src/quant-library) in parallel against the interface frozen in section 6; C acceptance after both; D docs after root acceptance; S3d foundation later |
| J11 | Driver output cap | FABLE | 16 MiB for the driver only (RC-14 package cap); `pythonEvaluation` keeps 2 MiB and is not edited |
| J12 | Interpreter drift | Root, not owner | Covered by OD-13 (engine change is a recorded limitation); no new owner question, no schema change |

## 2. Claims checked against code

Confirmed (both drafts or one, file:line at HEAD):

- C1. The gate digests: `steps = digest({candidate:{parameters, result}, sensitivity, cost_stress})`, `holdout = digest({test})` of
  `run.result.selected` (`src/quant-library/package-gates.js:667-669`); `traceReproduced` needs exactly one record per `TRACE_FILES` path with
  `sha256 = hash(packaged bytes)` and both digests equal (`package-gates.js:676-686`); `TRACE_FILES` at `package-gates.js:110`.
- C2. `digest` is `hash(canonical(value))` with `canonical`, `hash` from `src/pine-bridge/source.js` (`package-gates.js:85-87`).
- C3. Stored steps come only from `QuantResearchWorker.run` (`src/postgres/quant-research-worker.js:102-138`); the foundation worker reuses it
  (`src/postgres/quant-research-foundation.js:58` `extends QuantResearchWorker`, `:185` `run(job){return super.run(...)}`).
- C4. Sensitivity order: sorted domain names, `[index-1, index+1]`, skip outside the grid and when `validParameters` is false
  (`quant-research-worker.js:117-121`).
- C5. A neighbour equal to a plan candidate reuses that candidate's stored result: `saved?.result??await this.step(...'SENSITIVITY'...)`
  (`quant-research-worker.js:121-122`). The result object carries `kind` (`quant_lab/src/robot_quant/research_engine.py:61`;
  `research_chunk.py:343`). So the stored entry for such a neighbour has `result.kind === 'CANDIDATE'`.
- C6. `research_engine.evaluate` drops fills and decisions; only aggregates return (`research_engine.py:60-71`). Trace rows need a replay.
- C7. `research_engine.py` imports `paper_replay` into its own module namespace (`research_engine.py:11`) and calls it once by that global
  name (`:55`). Replacing the module attribute for one call therefore changes the callee for that process only; the OPUS wrapper is sound.
- C8. `research_engine.evaluate` accepts only `version ql3a-research-job-v1` and scope `SPT_CUSTOM_ENGINEERING_ONLY` (`research_engine.py:21`),
  enforces the exact dataset length for the kind (`:35-37`) and 60000 ms spacing (`:39-40`). A wrong slice fails closed inside the engine.
- C9. `pythonEvaluation` slices bars to `validation_end` except for HOLDOUT, caps input 8 MiB and output 2 MiB, discards stderr and maps
  errors to `RESEARCH_REQUEST_TOO_LARGE`, `QUANT_PYTHON_UNAVAILABLE`, `EVALUATION_TIMED_OUT`, `RESEARCH_INTERRUPTED`,
  `EVALUATION_OUTPUT_TOO_LARGE`, `EVALUATION_FAILED`, `INVALID_EVALUATION_RESPONSE` (`quant-research-worker.js:12-32`).
- C10. Closures: `LEGACY_ENGINE_FILES` (`src/postgres/quant-research.js:19,31`), `FOUNDATION_ENGINE_FILES` (`:20-32`), `engineHash`
  (`:33-37`); legacy contracts store `engineHash()` (`:136`), foundation contracts `engineHash(true)` (`:117`).
  `FIXED_EVAL_ENGINE_FILES` = runtime engine files plus its own four files, hashed with a version tag
  (`src/postgres/quant-fixed-eval-engine.js:12-26`). These and `preflight-resolver.js:26-54` are not edited by any S3 file.
- C11. `fixed_eval.py` metrics are 80-digit and "not string-comparable with prec-28 parent metrics" (`quant_lab/src/robot_quant/fixed_eval.py:48-49`).
  Both drafts correctly reject it as the recompute engine.
- C12. Table `bi_trace_reproductions` columns and checks (`src/postgres/best-inputs-package-schema.sql:251-269`; migration column list
  `best-inputs-package-migration.js:119`, constraints `:213-222`, triggers `:77-80`). Insert guards: `bi_require_serializable` (QR003),
  `bi_guard_candidate_record` (advisory lock plus latest status `EXPORT_CANDIDATE`, QR004, `schema.sql:500-511`), `bi_freeze` (QR002,
  ENABLE ALWAYS, `schema.sql:551-552,597-598`).
- C13. The deferred check `bi_guard_export_complete` requires seq 1 `EXPORT_CANDIDATE` and 12 package files, not trace rows
  (`schema.sql:341-354`). A terminal status event reads the trace table to force 40001 on a racing writer (`schema.sql:397-403`).
  OPUS R-g is correct.
- C14. Both `quant_jobs.result` and `quant_job_steps.result` and `quant_jobs.contract` are JSONB (`src/postgres/quant-research-schema.sql:7,11,17`).
  The worker itself evaluates from the JSONB-read contract, so S3 sees the same contract bytes the worker saw.
- C15. Renderer trace input `{equity, trades, decisions}` as `{columns, rows}`, cells string, finite number, boolean or null
  (`src/quant-library/package-render.js:25,109-118,347-349`). `TRACE_SEMANTICS` binds content: native signals and intents in `decisions.csv`,
  fills only as closed rows of `trades.csv`, `equity.csv` "the equity curve of the evaluated run" (`package-render.js:48`).
- C16. `mark_period` counts a closed trade in the partition of its EXIT bar (`ql3a.py:99-111`, `if i >= start`), and pops the entry on
  the first EXIT, so one EXIT per `entry_ref` (`ql3a.py:108`).
- C17. `paper_replay` decision dicts: rejection `{...event, outcome:'REJECTED', reason, quantity:'0', fee:'0'}`
  (`bridge_paper.py:151-158`); fill `{...event, outcome:'FILLED', sizing_outcome, sizing_adjustment, quantity, price, notional, fee, cash,
  cost, realized_r}`, appended to both `fills` and `decisions` (`bridge_paper.py:195-209`).
- C18. CT 4.3 codes: research run `STATUS_NOT_COMPLETED`, `BI_RUN_NOT_QUALIFIABLE`; holdout `HOLDOUT_NOT_EVALUATED` (CT lines 256, 261;
  gate use at `package-gates.js:276,299,304`).

Contradictions found:

- X1 (FABLE, blocking). FABLE section 3 table, SENSITIVITY row: "a neighbour equal to a plan candidate is recomputed anyway (the stored result
  was the deterministic candidate result, so the bytes are the same)". False: the stored result has `kind: 'CANDIDATE'`
  (C5, `research_engine.py:61`); a SENSITIVITY recompute has `kind: 'SENSITIVITY'`, so `steps_digest` differs and every such package fails C3
  with `BI_RESULT_MISMATCH`. OPUS 1.2 item 2 is correct. FABLE test 1 and section 1 item 4 even state the reuse fact.
- X2 (OPUS, blocking for foundation runs). OPUS 2.1: "The legacy worker runs with `foundation === false` ... so the run closure is
  `LEGACY_ENGINE_FILES`" and "Any other contract version refuses the build ... recommended `BI_ENGINE_HASH_MISMATCH`". Foundation runs are
  produced by `QuantResearchFoundationWorker` (`quant-research-foundation.js:58,185`) with `engine_hash: engineHash(true)`
  (`quant-research.js:117`) and stored contract version `ql3a-research-job-v2` (`src/quant-research/research-contract-v2.js:12,94`). For
  those runs the engine hash matches; reporting `BI_ENGINE_HASH_MISMATCH` records a false fact. Ruling J4/J9: a module refusal code instead.
- X3 (OPUS, minor). OPUS T3 says steps run through "the exact run engine path" for every run; this holds only for legacy runs. Foundation steps
  ran through `research_chunk.evaluate_chunk` under the process supervisor (`quant-research-foundation.js:279-303`).
- X4 (OPUS, minor). OPUS 2.2 driver input "same bounds": the driver reply (fills, decisions, equity points of up to 10000 bars) can exceed the
  2 MiB cap of `pythonEvaluation` (`quant-research-worker.js:25`). FABLE 8 is right to give the driver its own cap.
- X5 (OPUS, minor). OPUS 1.3 and 7 split refusals as `BI_RUN_NOT_QUALIFIABLE` and `HOLDOUT_NOT_EVALUATED` but omit `STATUS_NOT_COMPLETED`
  for a non-terminal run (CT 4.3 line 256, `package-gates.js:299`). FABLE omits `HOLDOUT_NOT_EVALUATED`. Ruling J9 uses all three.
- X6 (FABLE, design). FABLE 5 per-bar `equity.csv` uses `cash + quantity * close` for every bar. On any test-partition bar with an open
  position, `(equity - cash) / quantity` returns the holdout close. That ships a holdout price series, against the intent of CT 4.3
  ("Holdout bars never ship inside a package"). Kept only as an owner alternative (section 5, OQ-1).
- X7 (FABLE, design). FABLE `trace_engine_hash` covers only the two S3 files. The rows are produced by the engine files as well; the existing
  closure pattern hashes everything executed (C10, fixed-eval). Ruling J7 follows OPUS.
- X8 (OPUS, design). OPUS runs HOLDOUT twice (engine path and driver) and asks the owner to allow it (OQ-2). The driver calls the unchanged
  `research_engine.evaluate`; a second run adds cost and a second holdout touch and proves only what test S3a-1 pins. Ruling J3: once.
- X9 (OPUS OQ-2, scope). Holdout recomputation is already required by CT 5.3 (`holdout:selected` in the C3 trace row) and RC-17 (digests
  "come from recomputed results and are never copied"). It is not a new owner decision. Ruling R7 below records its limits.
- X10 (OPUS 2.2, minor). The driver need not return `bar_times`; Node holds `contract.dataset.bars` for a legacy run and needs only the four
  boundary times `rows[warmup|train_end|validation_end].time` and `test_end`. Dropping it shrinks the reply.

## 3. Rulings in detail

### J1. Steps recomputed (OPUS T1, with FABLE input rule)

S3 reads from storage only: the frozen contract, `contract_hash`, `run.status`, `run.result.completion_reason`,
`run.result.holdout_evaluated` and `run.result.selected.parameters`. It never reads `selected.result`, `selected.sensitivity`,
`selected.cost_stress` or `selected.test` (RC-17). Recomputed, in worker order (C3, C4):

1. `candidate`: kind `CANDIDATE`, `selected.parameters`. Precondition: canonically equal to exactly one entry of `contract.plan.candidates`,
   else `BI_PROVENANCE_UNRESOLVED`.
2. `sensitivity`: neighbours re-derived from `contract.input_lock.domains` and `contract.input_lock.selection.fixed_inputs` by the worker
   rule (C4). Each entry `{dimension, parameters, result}` with `parameters = {...selected.parameters, [name]: grid[next]}`. Kind
   `CANDIDATE` when the neighbour canonically equals a plan candidate (C5), else `SENSITIVITY`. The kind comes from the contract plan,
   never from a stored result.
3. `cost_stress`: kind `STRESS`, `selected.parameters`.
4. `holdout:selected`: kind `HOLDOUT`, `selected.parameters` only; `{test: result.test}` enters `holdout_digest`.

Not recomputed: the other plan candidates and the selection itself (CT 5.3 names only these four; QR-1 `report_matches_checkpoints`
binds the candidate list). Residual risk in section 8.

### J2. Trace source and content (merge)

- Source: the single HOLDOUT replay of `selected.parameters` over `bars[:test_end]` (both drafts). `mark_period` derives all three
  partitions from this one fill list (`ql3a.py:87-99`), so trace rows and the train, validation and test metrics share one path.
- Decimal arithmetic stays in Python (FABLE). The driver returns trade rows and equity points already computed with `Decimal`, as strings.
  Node only labels and orders cells. Node never does decimal arithmetic on trace values.
- Partition label: `train` for `[warmup, train_end)`, `validation` for `[train_end, validation_end)`, `test` for
  `[validation_end, test_end)`, by bar time. A trade row takes the partition of its EXIT bar (C16, the `mark_period` count rule).
- No row before `rows[warmup].time` can exist (`paper_replay` `start_time`, `bridge_paper.py:99`); S3 asserts this and refuses with
  `TRACE_REPRODUCTION_DIVERGED` if one appears.
- `trades.csv`: one row per `entry_ref` with both a BUY fill and its EXIT fill. An entry still open at `test_end` has no row (C15).
  `net` = `exit notional - exit fee - entry cost * exit quantity / entry quantity`, the `ql3a.py:109` formula, computed in the driver.
- `decisions.csv`: one row per `replay["decisions"]` entry, engine order (C17); cell names follow the event dict keys of `bridge_paper.py:101-115`, pinned by the S3b coder. Native signals that produced no intent are not in
  `replay["decisions"]`; root confirms with the S3b coder that this matches `TRACE_SEMANTICS` (C15) or adds `events` rows (ROOT R5).
- `equity.csv`: default event-sampled, one row per fill, `equity_at_fill = cash_after_fill + position_quantity * fill_price`
  (OPUS 3). Per-bar curve is the owner alternative (OQ-1), because it reveals holdout closes (X6).
- Columns (frozen as `TRACE_COLUMNS` in S3b; time as both `time_ms` integer and `time_utc` ISO-8601 Z, FABLE 5):
  - equity: `time_ms, time_utc, partition, event_type, cash, position_quantity, equity_at_fill`
  - trades: `entry_ref, partition, entry_time_ms, entry_time_utc, entry_price, quantity, entry_fee, exit_time_ms, exit_time_utc,
    exit_price, exit_fee, exit_reason, net, realized_r`
  - decisions: `time_ms, time_utc, partition, event_type, entry_ref, outcome, reason, sizing_outcome, quantity, price, fee`
  Owner answer to OQ-1 may drop test-partition rows or price columns; the digests do not depend on trace rows (they bind only via `sha256`).
- Cross-checks in S3, fail closed with `TRACE_REPRODUCTION_DIVERGED`, no tolerance: closed trade rows per partition equal
  `closed_trades` of the recomputed `train`, `validation`, `test`; decision rows equal `result.decision_count`; fill count equals
  `result.fills`.

### J3. Engine path for legacy runs (merge)

- Legacy run: `contract.version === 'ql3a-research-job-v1'` and no `execution_backend` (matches `quant-research.js:136`).
- CANDIDATE, SENSITIVITY and STRESS steps: the exported, unchanged `pythonEvaluation` (C9). It gives the holdout slice guard, framing,
  caps and error codes without a copy (OPUS 2.1).
- HOLDOUT: one call of the new driver `robot_quant.trace_reproduction` (section 6 interface). The driver imports the unchanged
  `robot_quant.research_engine`, replaces `research_engine.paper_replay` with a capturing wrapper for one call, calls
  `research_engine.evaluate({contract, parameters, kind:'HOLDOUT'})`, restores the attribute in `finally`, and requires exactly one
  captured call (C7). Its `result` is serialized with the same `json.dumps(..., allow_nan=False, separators=(",", ":"))` as
  `research_engine.main` (`research_engine.py:81`). This `result` is the HOLDOUT recompute; there is no second HOLDOUT run (X8).
- Rejected: the FABLE mirror (a copy of `research_engine.py:32-59`). A copy can drift without any hash change; the wrapper reuses the
  engine body itself, and the coupling (one call by that global name) fails closed and is pinned by test A2.
- Rejected: `fixed_eval.py` (C11), a Node re-implementation, and any edit of `research_engine.py` (rotates `LEGACY_ENGINE_FILES` and
  every stored `engine_hash`).
- Engine identity (RC-17): S3 computes `engineHash(false)` before the first evaluation and after the last one; either differing from
  `contract.engine_hash` refuses with `BI_ENGINE_HASH_MISMATCH` and no output. S4 repeats the check inside its SERIALIZABLE build
  transaction (FABLE 4 item 2).
- Why existing hashes stay unchanged: S3 adds files only, edits no file in `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`,
  `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES`, `FIXED_EVAL_ENGINE_FILES` or the multi-Pine closure, and adds
  its files to none of them. Importing or spawning a module does not change its bytes. Test C1 pins disjointness.
- The worker result shape check lives inside `QuantResearchWorker.step` (`quant-research-worker.js:82-88`); extracting it would edit a closure
  file. S3 copies it and test B7 feeds the same bad responses to both (OPUS R-d, accepted).

### J4. Foundation runs (FABLE design, deferred)

- Foundation run: `contract.execution_backend === 'quant-foundation-v1'`; closure `engineHash(true)`; bars are not in the contract; steps
  ran through `research_chunk.evaluate_chunk` (X2, X3).
- S3 v1 refuses a foundation run with the new module code `TRACE_REPRODUCTION_UNSUPPORTED` before any evaluation, never with
  `BI_ENGINE_HASH_MISMATCH`.
- Later slice S3d (own review): driver mode `chunk` loops `evaluate_chunk(request, trace=sink)` in one process over rows that S4 reads
  through the dataset binding and passes in; the in-process sink (`research_chunk.py:252-253,334-335`) yields fills and decisions with no
  wrapper or mirror; closure check `engineHash(true)`. Its premise "one in-process pass equals the stored chunked result" is a test (FABLE 11),
  not an assumption. Not needed for fixture packages today, because legacy fixture runs cover the builder path.

### J5. Comparison rule (both drafts agree)

- `steps_digest` and `holdout_digest` = `hash(canonical(value))` from `src/pine-bridge/source.js` (C2). S3 imports them; it does not edit
  `package-gates.js`. `sha256` = SHA-256 of the exact rendered UTF-8 bytes of the file.
- Exact equality, zero tolerance, no rounding, no field filter (CT 5.3 "canonical bytes", line 441; RC-4).
- S3 never compares with stored digests. Gate C3 judges at each attempt; a difference is `BI_RESULT_MISMATCH` / `HOLDOUT_MISMATCH`,
  non-retryable, `EXPORT_REFUSED` at attempt 1 (RC-4). S3 refuses only when it cannot produce one recomputed result.
- Premise check (FABLE 6, test C3): stored values come back from JSONB (C14) while recomputed values come from Python JSON. Results hold
  decimal strings, integers and grid values. The cluster round-trip test decides the premise; a failure stops the slice and goes to root
  as a design fact, never fixed by a tolerance.

### J6. Record mapping (OPUS 5, plus FABLE assertion)

| Column | Value |
| --- | --- |
| `export_id` | The export of the build, same transaction (S4) |
| `path` | Each of `TRACE_FILES`, three rows, `TRACE_FILES` order |
| `sha256` | `hash(files[path])` of the rendered bytes; S4 asserts equality with the `bi_package_files` row of the same path |
| `steps_digest` | Recomputed steps digest (J1); same on all three rows |
| `holdout_digest` | Recomputed `{test}` digest (J1); same on all three rows |
| `trace_engine_hash` | `traceReproductionEngineHash()` (J7) |
| `run_engine_hash` | `engineHash(false)` as computed at build, proven equal to `contract.engine_hash` |
| `recorded_at_ms` | Build clock value passed by S4; S3 has no clock |

Order (RC-16, RC-26): S3 recompute outside any transaction; render; B0; render again if limitation codes changed (trace input unchanged);
one SERIALIZABLE transaction inserts blobs, export, 12 package files, seq 1 `EXPORT_CANDIDATE`, then the three trace rows (guards C12).
No schema change. The completeness gap (C13) is closed by S4 writing the rows in the build transaction; a schema hardening is a later,
separately reviewed slice (OPUS R-g). S3 also exports the pure read-side mapper `gateTraceReproduction(rows, contract)` that drops a row
with another `run_engine_hash` or a malformed field, so C3 sees an absent record (OPUS 5).

### J7. Trace engine hash (OPUS)

`TRACE_REPRODUCTION_CLOSURE_VERSION = 'trace-reproduction-closure-v1'`. `TRACE_REPRODUCTION_FILES` = sorted set of the two S3 source files
plus `LEGACY_ENGINE_FILES` (which holds `quant-research-worker.js` for `pythonEvaluation` and the Python import closure of
`research_engine`). `traceReproductionEngineHash(readFile)` = `hash(canonical({version, files:{path: sha256}}))`, the
`fixedEvalEngineHash` pattern (C10). Test C1 checks the list covers the driver's Python import closure with the `pythonClosure` helper
pattern of `test/fixed-eval-engine.test.js:33,80`. S3d extends the list when the foundation path lands (that rotates the trace hash,
not any run hash).

### J8. Where it runs (both)

Local machine and cloud container only, labelled fixtures only. SQL tests on a throwaway PostgreSQL cluster, one file per process
(CT 11.2). No route, worker, table writer or UI wiring; no staging or VPS deploy (RC-12). Every package S3 can serve today is a fixture
package (C8: engineering scope only; RC-18, RC-28). Host for every S3 packet: local only; no SSH, remote shell or host credentials.

### J9. Failure codes (merge)

S3 returns a reproduction or throws one coded refusal (renderer pattern, `RENDER_REFUSAL_CODES`, `package-render.js:33`). A refusal writes
no row (RC-17). No refusal code reaches a gate result, a status event or the owner.

| Condition | Code | Source |
| --- | --- | --- |
| Live closure hash differs from `contract.engine_hash`, before or after | `BI_ENGINE_HASH_MISMATCH` | CT 4.3 line 266, RC-17 |
| Run not terminal | `STATUS_NOT_COMPLETED` | CT 4.3 line 256 |
| Run not `SUCCEEDED` or completion reason not `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` | `BI_RUN_NOT_QUALIFIABLE` | CT 4.3 line 256 |
| `holdout_evaluated !== true` | `HOLDOUT_NOT_EVALUATED` | CT 4.3 line 261 |
| `hash(canonical(contract)) !== contract_hash`; `selected` or `selected.parameters` absent or malformed; selected not exactly one plan candidate | `BI_PROVENANCE_UNRESOLVED` | CT 5.3 |
| Legacy bars missing, wrong length or gapped (pre-check before spawn) | `BI_DATASET_UNAVAILABLE` | CT 4.3 Data window |
| Python framing failures | `QUANT_PYTHON_UNAVAILABLE`, `EVALUATION_TIMED_OUT`, `RESEARCH_INTERRUPTED`, `EVALUATION_OUTPUT_TOO_LARGE`, `EVALUATION_FAILED`, `INVALID_EVALUATION_RESPONSE`, `RESEARCH_REQUEST_TOO_LARGE` | C9, same meaning |
| Captured replay count not one; cross-check of J2 fails; a row before warm-up | `TRACE_REPRODUCTION_DIVERGED` (new) | none fits; internal consistency |
| Foundation run (S3 v1), unknown `execution_backend`, unknown contract version | `TRACE_REPRODUCTION_UNSUPPORTED` (new) | none fits; `BI_ENGINE_HASH_MISMATCH` would be false (X2) |
| Recomputed digest differs from stored | none at build; C3 gives `BI_RESULT_MISMATCH` / `HOLDOUT_MISMATCH` | RC-4 |

Transient codes (`QUANT_PYTHON_UNAVAILABLE`, `EVALUATION_TIMED_OUT`, `RESEARCH_INTERRUPTED`) let S4 retry the whole build within its own
bound; a build retry is not a validation attempt. Both new codes match `^[A-Z][A-Z0-9_]{1,63}$` and are exported as
`TRACE_REFUSAL_CODES`.

### J10 to J12

- J10 slices: section 6.
- J11 driver reply cap 16 MiB (RC-14 package cap; FABLE 8); request cap 8 MiB; timeout injectable, default 30000 ms per call like the
  worker. `pythonEvaluation` is not edited.
- J12 interpreter or Decimal runtime drift is invisible to file closures. It is an engine change under OD-13 (owner-decided): a recorded
  limitation; a resulting digest difference is `BI_RESULT_MISMATCH` and needs a new run. No owner question, no `python_version` column.
  S4 records the driver's reported interpreter version in its build log only (ROOT R6).

## 4. Paste-ready contract rows (CT 10.2, after root acceptance)

Proposed for the CT 10.2 table. "Decided by" and the date become final only when root accepts. The doc packet S3e pastes them and the
matching 5.3 sentence; nothing else in CT changes.

```text
| RC-34 | The S3 trace reproduction recomputes, for the selected candidate only, the candidate step (kind CANDIDATE; the selected parameters must equal exactly one plan candidate), each sensitivity neighbour re-derived from the frozen contract by the worker rule (sorted domain names, grid index minus one then plus one, skipped outside the grid or when the fixed-input check fails; kind CANDIDATE when the neighbour equals a plan candidate, otherwise SENSITIVITY), the cost-stress step (kind STRESS) and `holdout:selected` (kind HOLDOUT, selected parameters only, only when `holdout_evaluated` is true). It reads no stored step result. Other candidates and the selection are not recomputed. The holdout recomputation selects nothing and is not an exposure record | 5.3 | Root | 2026-10-21 |
| RC-35 | For a `ql3a-research-job-v1` run without `execution_backend`, the candidate, sensitivity and stress steps run through the unchanged legacy evaluation call and the holdout step runs once through a new driver outside every engine closure that calls the unchanged legacy evaluator and captures its one Paper replay. No closure file is edited and no S3 file joins a closure. The live closure hash is checked against the contract engine hash before the first and after the last evaluation; a difference refuses the build with `BI_ENGINE_HASH_MISMATCH` and no row. A foundation-backend run is refused with `TRACE_REPRODUCTION_UNSUPPORTED` until a separately reviewed slice adds it | 5.3, 8 | Root | 2026-10-21 |
| RC-36 | `steps_digest` and `holdout_digest` are the canonical SHA-256 digests the gate module uses, over the recomputed steps; `sha256` is the SHA-256 of the rendered file bytes. Equality is exact; no numeric tolerance exists. The module never compares with stored digests; Gate C3 does (RC-4). An interpreter or runtime difference that changes a digest is an engine change under OD-13 | 5.3, 8 | Root | 2026-10-21 |
| RC-37 | Each build writes exactly three `bi_trace_reproductions` rows, one per trace file, in the SERIALIZABLE build transaction after the seq 1 `EXPORT_CANDIDATE` event, with the same `steps_digest` and `holdout_digest` on every row, `run_engine_hash` equal to the verified contract engine hash, and `trace_engine_hash` the hash of `trace-reproduction-closure-v1` (the S3 files plus the legacy engine files). The builder checks that each `sha256` equals the package file row of the same path. A refused build writes no row | 5.3, 8 | Root | 2026-10-21 |
| RC-38 | Trace rows come from the one holdout replay, from the warm-up end to the test end, each labelled `train`, `validation` or `test` by bar time; a trade takes the partition of its exit bar; an entry still open at the end has no trade row; decimals are the engine's strings computed in Python. Per-partition closed trades, decision count and fill count must equal the recomputed results, otherwise the build is refused with `TRACE_REPRODUCTION_DIVERGED`. Test-partition content and the equity sampling follow the owner decision OD-21 | 4.2, 4.3, 5.3 | Root | 2026-10-21 |
| RC-39 | The trace module refuses a build with existing codes where the meaning is the same (`BI_ENGINE_HASH_MISMATCH`, `STATUS_NOT_COMPLETED`, `BI_RUN_NOT_QUALIFIABLE`, `HOLDOUT_NOT_EVALUATED`, `BI_PROVENANCE_UNRESOLVED`, `BI_DATASET_UNAVAILABLE` and the research evaluation process codes) and two module refusal codes, `TRACE_REPRODUCTION_DIVERGED` and `TRACE_REPRODUCTION_UNSUPPORTED`. Module refusal codes are never gate codes, never stored in a status event and never shown to the owner; the retryable list stays closed (RC-5) | 5 intro, 5.3 | Root | 2026-10-21 |
```

Owner row, only after the owner answers OQ-1 (CT 10 table, next OD number):

```text
| OD-21 | Holdout content of the trace files | <owner answer to OQ-1; recommended: test-partition trade and decision rows ship, labelled `partition = test`; `equity.csv` is sampled at fills only, so no per-bar holdout value series ships> |
```

## 5. Root rulings and owner questions

### 5.1 Root-decidable (recommended ruling given)

- R1. Neighbour kind rule of J1 (CANDIDATE when equal to a plan candidate). Recommended: accept; FABLE's alternative fails C3 (X1).
- R2. HOLDOUT runs once, through the driver (J3). Recommended: accept. Alternative: OPUS double run with a byte-equality check; costs one
  extra 10000-bar evaluation per build and proves only what test A1 pins.
- R3. Wrapper, not mirror (J3). Recommended: wrapper.
- R4. Foundation runs refused in S3 v1 with `TRACE_REPRODUCTION_UNSUPPORTED`; S3d later (J4). Recommended: accept; do not use
  `BI_ENGINE_HASH_MISMATCH` (X2).
- R5. `decisions.csv` holds `replay["decisions"]` only, or also native signals without an intent (C15 semantics text). Recommended:
  decisions only. If root reads `TRACE_SEMANTICS` (`package-render.js:48`) as requiring every native signal, S3b adds the captured
  `replay["events"]` rows with `outcome = SIGNAL` instead; the renderer text is not edited. Root reads `bridge_paper.py:93-115` first.
- R6. Interpreter drift under OD-13 (J12). Recommended: accept; S4 logs the driver interpreter version, no schema change.
- R7. Holdout recomputation limits (X9): selected parameters only, only after `holdout_evaluated` is true, no exposure record, no new window.
  Recommended: accept as RC-34. It is inside CT 5.3 and RC-17, not a new owner decision; root may still show it to the owner with OQ-1.
- R8. New code names `TRACE_REPRODUCTION_DIVERGED`, `TRACE_REPRODUCTION_UNSUPPORTED` (J9). Recommended: accept.
- R9. Result shape check copied into S3 with a drift test (J3; OPUS R-d). Recommended: accept.
- R10. S4 build retry bound for transient codes. Recommended: at most 2 retries, then no row (OPUS R-f); decided in the S4 design.
- R11. Later schema hardening "three trace rows at commit" (C13; OPUS R-g). Recommended: defer to a separate slice; S4 writes the rows in
  the build transaction now.
- R12. RC-34 to RC-39 wording (section 4).

### 5.2 Owner-only (OWNER)

- OQ-1 (OWNER). Holdout content in the trace files. CT 4.3 forbids shipping holdout bars; RC-4 requires a holdout digest on every trace
  file, and C3 binds the files by `sha256`, so whatever the files hold is evidence. Test-partition fills, decisions and equity are derived
  data, but fill prices, SL and TP reveal some holdout prices.
  - Recommended default: ship test-partition rows of `trades.csv` and `decisions.csv`, labelled `partition = test`; `equity.csv`
    sampled at fills only (no per-bar curve). Packages are owner-private and shown only when READY (and fixture packages never are).
  - Alternative A (FABLE default): per-bar equity for all partitions; ships a per-bar holdout value series from which holdout closes can
    be derived (X6).
  - Alternative B: no test-partition rows in any trace file; the digests are unchanged, but the owner cannot review holdout trades.

No other owner question. OPUS OQ-2 is root R7 (X9); FABLE Q2 is root R6 (OD-13 already decided).

## 6. Slice plan

### 6.1 Frozen interface (lets lanes A and B run in parallel)

Driver `python -m robot_quant.trace_reproduction`, `cwd` repo root, `PYTHONPATH=quant_lab/src`, stdin one JSON object, stdout one JSON
object, stderr discarded by the caller.

- Request: exactly `{"contract": <legacy research contract, full bars>, "parameters": <selected parameters>}`. No `kind` key; the kind is
  fixed to HOLDOUT. Request cap 8 MiB (checked in Python and Node). `parse_constant` refuses NaN and Infinity.
- Reply on success: exactly `{"result", "trades", "decisions", "equity"}`.
  - `result`: the `research_engine.evaluate` HOLDOUT dict, unchanged.
  - `trades`: list of `{entry_ref, entry_time, entry_price, quantity, entry_fee, exit_time, exit_price, exit_fee, exit_reason, net,
    realized_r}` for closed entries, exit order; decimals as strings; times integer ms.
  - `decisions`: list of the captured decision dicts, engine order, keys as emitted by `bridge_paper.py`.
  - `equity`: list of `{time, event_type, cash, position_quantity, equity_at_fill}`, one per fill, fill order.
- Reply on failure: exit 1 and `{"error": "<CODE>"}` only, no message, path or traceback. Codes: `TRACE_REPRODUCTION_DIVERGED` (captured
  calls not exactly one), `RESEARCH_REQUEST_TOO_LARGE`, `RESEARCH_CONTRACT_OR_EVALUATION_FAILED` (any engine refusal, as `research_engine.main`).
- Node maps exit 1 to `EVALUATION_FAILED`, except a reply `{"error":"TRACE_REPRODUCTION_DIVERGED"}`, which maps to that code.
  Reply cap 16 MiB (`EVALUATION_OUTPUT_TOO_LARGE`).

Node module `src/quant-library/trace-reproduction.js` (pure core plus injected ports, no clock, no database, no file writes):

```text
reproduceRun({run, ports:{evaluate, traceEvaluate, engineHash}, signal})
  -> frozen {steps_digest, holdout_digest, run_engine_hash, trace_engine_hash, trace:{equity, trades, decisions}}
traceReproductionRecords(reproduction, files, recordedAtMs) -> 3 row objects in TRACE_FILES order
gateTraceReproduction(rows, contract) -> [{path, sha256, steps_digest, holdout_digest}]
defaultPorts() -> {evaluate: pythonEvaluation, traceEvaluate: <spawner of the driver>, engineHash: () => engineHash(false)}
TRACE_REPRODUCTION_CLOSURE_VERSION, TRACE_REPRODUCTION_FILES, traceReproductionEngineHash(readFile), TRACE_COLUMNS, TRACE_REFUSAL_CODES
```

`run` is the durable run view of the renderer (`package-render.js:21`): `{owner_id, bot_id, run_id, status, contract, contract_hash, result}`.

### 6.2 Packets, writers and lanes

All writers are new files only. One writer per file. Read-only for every S3 writer: `src/postgres/quant-research-worker.js`,
`src/postgres/quant-research.js`, `src/postgres/quant-research-foundation.js`, `src/quant-research/*`,
`src/postgres/quant-fixed-eval-engine.js`, `src/quant-library/package-gates.js`, `src/quant-library/package-render.js`,
`src/postgres/best-inputs-package-*`, every file under `quant_lab/src/robot_quant/` except the new driver, and every closure list.

| Packet | Lane | Role (Claude column) | Writable paths (only these) | Depends on | Stop condition |
| --- | --- | --- | --- | --- | --- |
| S3a driver | A (`quant_lab`) | Coder, Sonnet 5.5 / high | `quant_lab/src/robot_quant/trace_reproduction.py`, `quant_lab/tests/test_trace_reproduction.py` | interface 6.1 | tests A1-A6 green; `git status` shows only the two paths |
| S3b module | B (`src/quant-library`) | Coder, Sonnet 5.5 / high | `src/quant-library/trace-reproduction.js`, `test/quant-library-trace-reproduction.test.js` | interface 6.1; stub driver in the test temp dir | tests B1-B10 green; only the two paths |
| S3c acceptance | C, after A and B accepted | Tester, Sonnet 5.5 / medium | `test/trace-reproduction-closure.test.js`, `test/postgres/bi-trace-reproduction.test.mjs` | S3a, S3b | tests C1-C4 green, or C3 failure reported as a design fact and the slice stops |
| S3e contract text | after root accepts S3 | Documentation, Sonnet 5.5 / low | `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (10.2 rows RC-34 to RC-39, one 5.3 sentence; OD-21 only after the owner answers) | root acceptance | text only, no other file |
| S3d foundation | later workflow | Coder, Sonnet 5.5 / high | driver and module files above (new writer packet, after S3 is integrated) plus `quant_lab/tests/test_trace_reproduction_chunk.py` | S4 dataset reader port | own review |

- Lanes A and B touch different packages and meet only at the frozen JSON interface, so they run in parallel (owner rule 2026-10-17: at most
  three lanes, one package each). If root reads the interface as design parts that reference each other, run B after A in one lane
  (FABLE 9); cost is one serial step.
- Verify panel per packet: Tester (Sonnet 5.5 / medium) plus Architecture auditor (Opus 5.5 / high), because S3 is lineage and verdict
  evidence. No Fable second opinion required (not host-adjacent, no GO) unless root records a reason. A fix round re-verifies only the
  changed files with one rerun of the suite.
- Peak concurrency: 2 writers (A, B) plus up to 4 verify agents; within the 10-agent and 6-writer limits.

### 6.3 What this cloud container can accept (checked read-only, 2026-10-21)

- Present: Python 3.13.16 (system), `uv` and a `quant_lab/.venv`; Node v22.22.0; PostgreSQL 16 binaries
  (`psql` on PATH; `initdb` not on PATH). System Python has no `pytest`; CI runs `uv run --no-sync pytest`
  (`.github/workflows/quant-lab.yml:44`), so A tests run through `uv` in `quant_lab`. Whether the venv already holds pytest is unknown.
- PostgreSQL tests need `TEST_DATABASE_URL` (`test/helpers/preflight-pg-fixture.mjs:44`); the tester starts a throwaway cluster in the
  session scratchpad with the PG 16 binaries. Not tried here.
- Therefore the container can accept S3a, S3b and S3c evidence locally (unverified until the first run), and S3e text. It cannot accept
  anything host, VPS, staging or browser related, and none is needed. Cloud agents return patches; root applies and integrates.
- Evidence limit: the container Python version may differ from the staging host (risk 3). Container results are local fixture evidence only.

## 7. Test plan and mutation targets

No test writes outside its temp directory or the throwaway cluster. No network.

S3a (`quant_lab/tests/test_trace_reproduction.py`, fixtures of `test_research_engine.py`):

- A1. Driver `result` equals `research_engine.evaluate` HOLDOUT output as `json.dumps(sort_keys=True)` bytes, on the golden fixture and on
  a fixture with at least one closed trade per partition.
- A2. Exactly one `paper_replay` call captured; `decisions` equal a direct `paper_replay` call on the same bars; a monkeypatched engine
  that calls `paper_replay` zero or two times gives `TRACE_REPRODUCTION_DIVERGED`.
- A3. `research_engine.paper_replay` is the original after success and after an exception.
- A4. Trade rows: open entry at the end has no row; `net` equals the `ql3a.py:109` formula; per-partition closed counts equal the
  `closed_trades` of `result`.
- A5. Request hygiene: extra key, `kind` key, NaN, oversize request give only `{"error": CODE}`; reply has no `Traceback` and no path.
- A6. Reply keys are exactly `result, trades, decisions, equity`; no OHLCV field anywhere in the reply.

S3b (`test/quant-library-trace-reproduction.test.js`, injected ports, no Python, no database):

- B1. Fake ports returning stored-equal results: digests make `evaluateProvenance` C3 pass on the golden package fixture
  (`test/quant-library-package-gates.test.js:124-125` digests).
- B2. Port call log: kinds and parameters in worker order; HOLDOUT only via `traceEvaluate` and only with `selected.parameters`; no
  `evaluate` call with kind HOLDOUT.
- B3. No copy: `selected.result`, `.sensitivity`, `.cost_stress`, `.test` are throwing getters that never fire (FABLE 3).
- B4. Engine hash: mismatch before gives `BI_ENGINE_HASH_MISMATCH` with zero port calls; a change between first and last gives the
  same code and no output.
- B5. Neighbour fixture: three domains, an edge index, a pair `validParameters` rejects, and one neighbour equal to a plan candidate;
  recomputed `steps_digest` equals the golden digest.
- B6. Each refusal row of J9 by one negation, including a foundation contract giving `TRACE_REPRODUCTION_UNSUPPORTED` with zero port calls.
- B7. Result shape check: the bad responses the worker refuses are refused by S3 (drift pin).
- B8. Records: three rows, `TRACE_FILES` order, `sha256 = hash(files[path])`, every field matches the migration CHECK regex
  (`best-inputs-package-migration.js:213-222`).
- B9. Partition boundaries: fills at `train_end - 1`, `train_end`, `validation_end` labelled correctly; rendering the same reproduction twice
  through `renderPackage` gives the same three `sha256`.
- B10. Driver spawner with a stub script: reply above 16 MiB, non-zero exit, `{"error":"X"}`, `{"error":"TRACE_REPRODUCTION_DIVERGED"}`,
  sleep past timeout, abort signal, request above 8 MiB.
- B11. `gateTraceReproduction` drops a row with another `run_engine_hash`, a malformed hash or a duplicate path; C3 then gives both codes.

S3c:

- C1. `test/trace-reproduction-closure.test.js`: S3 files absent from `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`,
  `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES`, `FIXED_EVAL_ENGINE_FILES` and, once committed, `MP_COMBINED_ENGINE_FILES` (uncommitted F11 file `src/multi-pine/engine-closure.js` today);
  `TRACE_REPRODUCTION_FILES` covers the driver's Python import closure; one changed byte or one dropped file changes
  `traceReproductionEngineHash`; the existing engine hashes of the checkout equal their values at the S3 base revision.
- C2. Real Python end to end on a fixture run produced by the existing worker test path: untouched run passes C3; tampering one stored
  sensitivity result, the cost-stress result or `selected.test` gives `BI_RESULT_MISMATCH` or `HOLDOUT_MISMATCH`.
- C3. Round-trip premise (`test/postgres/bi-trace-reproduction.test.mjs`): fixture run stored through the worker into JSONB and read back;
  S3 digests equal `storedStepDigests` of the read-back `selected`. A failure stops the slice (J5).
- C4. Same file: three rows insert after seq 1 in one SERIALIZABLE transaction; before the event QR004; outside SERIALIZABLE QR003; a
  fourth path 23514; a duplicate path 23505; UPDATE, DELETE, TRUNCATE QR002; read-back through `gateTraceReproduction` feeds C3.

Mutation targets (each must turn a named test red):

| ID | Mutation | Caught by |
| --- | --- | --- |
| M1 | Copy a stored result instead of recomputing | B3, C2 |
| M2 | Read neighbours from the stored list | B3, C2 |
| M3 | Neighbour equal to a plan candidate run as SENSITIVITY (the FABLE rule) | B5, C3 |
| M4 | Swap `[index-1, index+1]` order or drop the `validParameters` skip | B5 |
| M5 | STRESS sent as CANDIDATE | B2, C2 |
| M6 | Remove the before or after engine hash check, or move it after the first call | B4 |
| M7 | Write `contract.engine_hash` without computing the closure | B4 |
| M8 | Remove the holdout slice (send full bars to a non-HOLDOUT step) | B2 call log, engine length refusal in C2 |
| M9 | `sha256` over row JSON instead of rendered bytes | B8, B1 |
| M10 | HOLDOUT with non-selected parameters | B2 |
| M11 | Partition off by one, or trade partition by entry bar | B9, A4 |
| M12 | Open final entry kept as a trade row | A4 |
| M13 | Wrapper not restored | A3 |
| M14 | Skip the per-partition count cross-check | A4, B6 |
| M15 | Accept a row with another `run_engine_hash` | B11 |
| M16 | Add an S3 file to a closure list | C1 |
| M17 | Drop `kind` from the digest input or rename `cost_stress` | B1 |
| M18 | Map an unsupported backend to `BI_ENGINE_HASH_MISMATCH` | B6 |

## 8. Top risks

1. Fixture-only: both engines refuse any scope except `SPT_CUSTOM_ENGINEERING_ONLY` (C8, `research_chunk.py:263`). S3 output is fixture
   evidence and cannot serve a real package until a new contract version and engine closure exist (CT 12 R1); S3 then needs an extension.
2. Round-trip exactness (J5) is a premise proven only by C3. If it fails, no package passes C3; the fix is in the storage path, not a tolerance.
3. Interpreter or Decimal runtime drift between the run host and the build host gives a correct run `BI_RESULT_MISMATCH` (J12, OD-13).
   Build on the same reviewed runtime.
4. The wrapper couples the driver to one global call of `paper_replay` in `research_engine.py`; a refactor fails closed with
   `TRACE_REPRODUCTION_DIVERGED` and also rotates the legacy engine hash.
5. Foundation runs cannot be packaged until S3d; if root expects fixture packages from foundation runs, S3d moves up.
6. Selection is not re-verified, only plan membership; a stored selection that is not the true best candidate passes S3.
7. Holdout disclosure through trace content (OQ-1) is an owner decision; the default limits it but fill prices still reveal some holdout prices.
8. Trace rows are not required at commit by the schema (C13); S4 must insert them in the build transaction.
9. Cost: up to 1 + 2 x dimensions + 1 non-holdout evaluations plus 1 driver call per build (at most 10 dimensions, so at most 23), each up to
   10000 bars and 30 s; S4 must hold QS-1 admission and run them outside the SERIALIZABLE transaction.
10. `TRACE_SEMANTICS` says native signals are listed in `decisions.csv`; if root reads that as every signal, decisions-only rows are
    incomplete (R5).
