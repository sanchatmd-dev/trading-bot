# F09 builder slice S3: trace reproduction module (independent draft, Fable 5.1)

Status: design draft for root's judge panel. Written from the contract and the code at HEAD 05e7a47 without reading the Opus draft. Nothing here is accepted until root decides. The original D1-D12 builder design is lost; every rule below is restated from docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md (cited as "contract") and from the code (cited as file:line).

## 0. Authority used

- contract 5.3 (trace row of the C3 table and the RC-4 paragraph, lines 441 and 448-450), 4.3 "Engine identity" row (line 266), 8 (lines 655-656, deterministic build), 11.1 item 6 and 11.2.
- contract 10.1 RC-4 (line 727), 10.2 RC-12 (slice list), RC-16 (build order), RC-17 (line 748: module outside the run engine closure, digests recomputed never copied, `BI_ENGINE_HASH_MISMATCH` and no row), RC-18 (fixture packages in the same tables), RC-26 (every builder write SERIALIZABLE), RC-32 and RC-33 (classifier rules the S3 tests must not disturb), OD-13 (engine change is a recorded limitation), OD-16 (traces of refused packages are not kept).
- src/postgres/best-inputs-package-schema.sql:24-25 (the build transaction writes the trace reproductions), 251-269 (table), 502-511 (`bi_guard_candidate_record`), 551-552, 564, 575, 597-598, 609, 620 (guards and ENABLE ALWAYS); src/postgres/best-inputs-package-migration.js:77-80 (guard list), 119 (columns), 213-222 (constraints).
- src/quant-library/package-gates.js:109-110 (`TRACE_FILES`), 667-698 (`storedStepDigests`, `traceReproduced`, `resultCodes`), 713-740 (`evaluateProvenance`, subject shape, line 734 engine hash rule).
- src/quant-library/package-render.js:25, 44-48, 109-118, 251, 347-349 (the renderer takes `trace {equity, trades, decisions}` as `{columns, rows}` and renders RFC 4180 CSV).
- Run engines that must not change: src/postgres/quant-research.js:19-37 (`LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`, `engineHash`), src/quant-research/runtime-engine-files.js, src/quant-research/preflight-resolver.js:25-54 (PF2 closures), src/postgres/quant-fixed-eval-engine.js:12-26 (`fixed-eval-closure-v1`), quant_lab/src/robot_quant/research_engine.py (legacy step evaluator), quant_lab/src/robot_quant/research_chunk.py:252-346 (foundation chunk evaluator), src/postgres/quant-research-worker.js:12-32 and 102-138 (how the stored steps were produced), src/postgres/quant-research-foundation.js:265-312 (same for the foundation backend).

## 1. What the stored evidence actually holds (facts the design rests on)

1. A run stores one `quant_job_steps` row per step: `step_id`, `kind`, `parameters`, `result` (quant-research-worker.js:93; quant-research-foundation.js:303). The step ids are `candidate:NNN`, `sensitivity:<name>:<index>`, `stress:selected`, `holdout:selected` (worker lines 107, 122, 127, 131).
2. A step `result` holds only aggregates: `parameters`, `kind`, `train`, `validation`, `decision_count`, `fills` (a count), `rejections`, `exit_fill_reasons`, `owner_recommendation_ready`, and `test` for HOLDOUT (research_engine.py:60-71; research_chunk.py result at line 343-345 has the same keys). No fill list, no decision list, no equity curve is stored anywhere. So the three trace files cannot be read from storage; they can only come from a replay.
3. The gate judges traces by digest only (package-gates.js:676-685). `steps_digest` must equal `digest({candidate:{parameters, result}, sensitivity, cost_stress})` and `holdout_digest` must equal `digest({test})` of the stored selected candidate (line 668-669), `sha256` must equal the hash of the packaged file bytes, and exactly one record per `TRACE_FILES` path must exist. The gate never replays (line 718).
4. The run `selected` object is `{parameters, result, screen_reasons, sensitivity:[{dimension, parameters, result}], cost_stress, test}` (worker lines 111-131). `sensitivity` order is the sorted domain names, each with grid index minus one then plus one, skipping an index outside the grid and a pair that fails `validParameters` (lines 117-125). When a neighbour equals a plan candidate the worker reused that candidate's step result (line 121-122).
5. Two run backends exist. Legacy (`version ql3a-research-job-v1`, no `execution_backend`): bars are inline in `contract.dataset.bars`, `engine_hash = engineHash(false)` (quant-research.js:136), steps come from `research_engine.evaluate` through a plain spawn (worker lines 12-32), and holdout bars never enter a non-HOLDOUT subprocess (line 15). Foundation (`execution_backend === 'quant-foundation-v1'`): bars come from the dataset store through the write-once binding, `engine_hash = engineHash(true)` (quant-research.js:117), steps come from `research_chunk.evaluate_chunk` run chunk by chunk with checkpoints (quant-research-foundation.js:279-303). `evaluate_chunk` has an in-process `trace` sink that receives every bar's `{signal, events, decisions, fills, ...}` (research_chunk.py:252, 334-335) and is unavailable through IPC.
6. `fixed_eval.py` is outside every research closure and in `fixed-eval-closure-v1` (fixed_eval.py:51-55). Its metrics are 80-digit (`metrics_precision`) and "not string-comparable with prec-28 parent metrics" (lines 48-50). It has no SENSITIVITY or HOLDOUT kind and no train/validation/test split.

## 2. Decision D-S3-1: what the module is and where it sits

S3 is one Node module plus one Python driver, both new files, outside every engine closure:

- `src/quant-library/trace-reproduction.js`: builds the step requests from the frozen run, enumerates the sensitivity neighbours exactly as the worker did, runs the Python driver once per build, turns the replay into the renderer's `trace` input, computes the two digests, computes its own closure hash, and maps the result to `bi_trace_reproductions` rows. No database, no clock, no network, no file write. The dataset rows and the recorded time are arguments.
- `quant_lab/src/robot_quant/trace_reproduction.py`: one stdin/stdout driver in the `research_engine` style (one JSON request, one JSON reply, exit 1 with `{"error": CODE}` and no message, path or traceback). It imports the stored closure's own evaluator and calls it unchanged (section 4). It adds no engine arithmetic of its own except the replay mirror of section 5, which it self-checks.

S3 returns to the build worker (S4) a frozen object:

```text
{
  run_engine_hash,                       contract.engine_hash, after the closure check of section 4
  trace_engine_hash,                     hash of trace-reproduction-closure-v1 (section 7)
  steps_digest, holdout_digest,          from the recomputed results only (section 3)
  recomputed: {candidate, sensitivity, cost_stress, holdout},   kept for the gate report, never written to a package file
  trace: {equity, trades, decisions}     the renderer input of package-render.js:25
}
```

and, after S1 has rendered the package, a pure second call `traceReproductionRecords(reproduction, files, recorded_at_ms)` returns the three rows of section 7. The split into two calls exists because `sha256` is the hash of the rendered CSV bytes and the renderer needs the trace rows first (RC-16 order: render, B0, render again, then one SERIALIZABLE transaction).

S3 judges nothing. It refuses (throws a coded error, section 8) only when it cannot recompute; it never compares its digests with the stored ones. The comparison stays in `package-gates.js` at validation time (C3), as RC-4 and line 718 require. This keeps the "evaluator produces, gate judges" split that the contract already fixed, and it keeps S3 testable with an injected evaluator exactly as the worker is (`evaluate=pythonEvaluation`, worker line 35).

## 3. Decision D-S3-2: which traces and which steps are recomputed

Trace files: all three of `TRACE_FILES` (`quant-data/equity.csv`, `quant-data/trades.csv`, `quant-data/decisions.csv`), each from ONE replay, the HOLDOUT replay of the selected parameters over `bars[:split.test_end]`. Reason: it is the only step whose window covers train, validation and test, and `paper_replay` is chronological, so its fills inside `[warmup, validation_end)` are the fills the CANDIDATE step saw (bridge_paper.py:93-209 reads nothing after the current bar). One replay keeps the three files mutually consistent (the same fills, the same equity path), which the trace semantics text of the manifest promises (package-render.js:48).

Steps recomputed for the digests, with the exact digest shapes of package-gates.js:668-669:

| Recomputed step | Request | Goes into |
| --- | --- | --- |
| CANDIDATE, `selected.parameters` | legacy: `research_engine.evaluate({contract: contract with bars[:validation_end], parameters, kind:'CANDIDATE'})`; foundation: `evaluate_chunk` to completion over the same window | `steps_digest` as `candidate:{parameters, result}` |
| SENSITIVITY, one per neighbour | same, kind `SENSITIVITY`, neighbours enumerated by the worker rule (section 1 item 4), in the worker's order; a neighbour equal to a plan candidate is recomputed anyway (the stored result was the deterministic candidate result, so the bytes are the same) | `steps_digest` as `sensitivity:[{dimension, parameters, result}]` |
| STRESS, `selected.parameters` | same, kind `STRESS` (the engine doubles fee and slippage, research_engine.py:47) | `steps_digest` as `cost_stress` |
| HOLDOUT, `selected.parameters` | same, kind `HOLDOUT`, bars `[:test_end]`; this replay also feeds the trace rows | `holdout_digest` as `{test: result.test}` |

The only stored values S3 reads are the contract, `run.result.selected.parameters` (which candidate), `run.result.holdout_evaluated` and `run.status` (a run that is not `SUCCEEDED` with a selected candidate and `holdout_evaluated === true` is refused, section 8). `selected.result`, `selected.sensitivity`, `selected.cost_stress` and `selected.test` are never read, so no digest can be copied (RC-17). A drift between the worker's neighbour rule and S3's copy of it changes `steps_digest` and fails closed at C3 with `BI_RESULT_MISMATCH`; it can never make a wrong package pass.

What the digests therefore prove: the stored selected, sensitivity, cost-stress and holdout results are the results the frozen engine bytes produce again today from the frozen contract and data. Together with the gate's own check that `metrics.json` and `validation.json` equal the stored values (package-gates.js:690-696), the package is bound on both sides: shipped equals stored and stored equals recomputed.

Not recomputed: the other plan candidates (the gate does not digest them; QR-1 `reportMatchesCheckpoints` already binds them to checkpoints, derive.js:185-188), and the holdout exposure checks (B0 owns them).

## 4. Decision D-S3-3: engine path, and why the existing hashes stay unchanged

Backend-matched replay through the closure's own evaluator, chosen by `contract.execution_backend`:

- Legacy run (`execution_backend` absent, `version === 'ql3a-research-job-v1'`): the Python driver imports `robot_quant.research_engine` and calls `evaluate(request)` four-plus times in one process, with the same request shape the worker sent (`{contract, parameters, kind}`, worker line 16) and the same bar slicing (bars `[:validation_end]` for every kind except HOLDOUT, worker line 15). The result dicts are the digest inputs, byte for byte the code path that produced the stored rows.
- Foundation run (`execution_backend === 'quant-foundation-v1'`): the driver imports `robot_quant.research_chunk` and loops `evaluate_chunk(request, trace=sink)` with the returned `checkpoint` fed back until `result` is not null, over rows the build worker read through the binding (S4 verifies `dataset_sha256`; S3 verifies count and 60000 ms spacing). The in-process `trace` sink yields decisions and fills for the trace rows without any mirror code. `StreamingMetrics` is documented as the exact `mark_period` arithmetic (research_chunk.py:162-177), and the foundation worker stored exactly this `result` (quant-research-foundation.js:303), so the recomputation reproduces the stored bytes by construction.

Why this leaves every engine hash unchanged:

1. A closure hash is the hash of the listed files' bytes (quant-research.js:33-37; quant-fixed-eval-engine.js:23-26; preflight-resolver.js:35-54 over `PF2_ENGINE_FILES`; runtime-engine-files.js). S3 adds two new files and edits none of the listed ones. Importing `research_engine` or `research_chunk` reads them; it does not change their bytes. The S3 unit test asserts that `trace-reproduction.js` and `trace_reproduction.py` are in none of `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`, `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES`, `FIXED_EVAL_ENGINE_FILES` (section 10 item 9), so a later "wire it in" cannot pass silently.
2. RC-17 requires the module to be outside the run engine closure, and the contract's `BI_ENGINE_HASH_MISMATCH` rule compares the run's closure with the contract value (contract line 443; gate line 734). S3 computes `engineHash(contract.execution_backend === 'quant-foundation-v1')` at its start and refuses with `BI_ENGINE_HASH_MISMATCH` before any Python process starts when it differs from `contract.engine_hash`. S4 repeats the same cheap check inside the build transaction (RC-16 re-reads everything in the transaction) so that no row is written after a deploy raced the build.

Why not the alternatives:

- `fixed_eval.py`: 80-digit metrics against the stored prec-28 metrics are different strings (fixed_eval.py:48-50), so the digest can never match; it has no SENSITIVITY or HOLDOUT step and a different contract shape (`fixed-eval-job-v1`); its closure is `fixed-eval-closure-v1`, not the run's. It is the right engine for QR-3/QR-4 fixed windows, not for reproducing a QL-3A run.
- A Node re-implementation of the Paper engine: a second implementation whose parity with Python would itself need proof; the contract wants an evaluator-produced record (RC-4), and OD-13 already accepts that an engine change blocks exact replay rather than demanding engine independence.
- Editing `research_engine.py` to emit fills: rotates `LEGACY_ENGINE_FILES` and `QUANT_RUNTIME_ENGINE_FILES` hashes, invalidates every stored `engine_hash` and makes every existing run irreproducible under RC-17. Forbidden by the task and by the contract's own logic.

## 5. Decision D-S3-4: trace rows and the legacy replay mirror

On the foundation path the trace rows come from the `trace` sink. On the legacy path `research_engine.evaluate` returns no fills, so the driver mirrors research_engine.py:32-59 once (bar build with the frozen `atr14`, `PaperModel` with factor 1, `paper_replay` with `start_time = rows[warmup].time`) for the selected parameters over `bars[:test_end]`, and then self-checks: it computes `mark_period` for train, validation and test from its own replay and requires the three dicts to equal `research_engine.evaluate(..., kind='HOLDOUT')['train' | 'validation' | 'test']` string for string. A difference is `TRACE_REPLAY_DIVERGED` and the build is refused. The mirror can therefore never ship a trace that disagrees with the digest-bearing result. Cost: one extra replay of at most 10000 bars per legacy build (five replays in all, plus one per sensitivity neighbour).

Row schemas (every cell a string, a finite integer, a boolean or null, as package-render.js:25 demands; decimals are the engine's own strings, never re-rounded):

- `quant-data/equity.csv`, one row per bar from index `warmup` to `test_end - 1`: `bar_time_ms` (engine time, the closed-bar time, the same key the stored steps use), `time_utc`, `partition` (`train` for `[warmup, train_end)`, `validation` for `[train_end, validation_end)`, `test` for `[validation_end, test_end)`), `cash`, `position_quantity`, `equity` where equity is `cash + quantity * close` exactly as ql3a.py:116 marks it, with the Decimal arithmetic done in Python, not in Node.
- `quant-data/trades.csv`, one row per closed position episode (entry fill to its EXIT fill, keyed by `entry_ref`): `entry_ref`, `entry_time_ms`, `entry_time_utc`, `exit_time_ms`, `exit_time_utc`, `partition` (of the exit bar), `quantity`, `entry_price`, `exit_price`, `entry_fee`, `exit_fee`, `exit_reason` (`SL`, `TP`, `NATIVE`), `net_pnl` (the ql3a.py:109 formula), `realized_r`. An allocation still open at `test_end` is not a row (manifest semantics: fills appear only as closed rows, package-render.js:48); the count of open allocations goes into the gate report, not into a file.
- `quant-data/decisions.csv`, one row per entry of `replay["decisions"]` (intents after `start_time`; warm-up intents never reach the ledger, bridge_paper.py:99-100, and are not decisions): `bar_time_ms`, `time_utc`, `partition`, `event_type` (`BUY`, `EXIT`), `entry_ref`, `outcome` (`FILLED`, `REJECTED`), `reason`, `sizing_outcome`, `quantity`, `price`, `notional`, `fee`, `sl`, `tp`.

Column order is fixed in the Node module as frozen constants; S1 renders them as RFC 4180 with LF. The same reproduction twice gives the same bytes, which is what 11.1 item 6 (deterministic rebuild, same `package_hash`) needs.

Open owner point (section 11, Q1): whether the test partition rows (holdout fills, holdout equity) may ship in the package. Default: yes, labelled by the `partition` column. The run already opened its holdout, `metrics.json` already carries the test metrics (contract 4.2), and bars never ship (contract line 271-274); fill prices are not bars.

## 6. Decision D-S3-5: comparison rule and tolerances

Rule: exact digest equality, no tolerance. `steps_digest` and `holdout_digest` are `hash(canonical(value))` with the `canonical` and `hash` of src/pine-bridge/source.js, the same functions the gate uses (package-gates.js `digest`). `sha256` is the SHA-256 of the exact rendered bytes.

Why exact and not a numeric tolerance:

1. The contract says "canonical bytes" (line 441) and RC-4 says "digest difference" (line 727). A tolerance would need a new rule and a new code path in the gate, and it would create the informal tuning hole that risk R4 (contract line 885) warns about.
2. The engine is deterministic Decimal arithmetic; metrics are decimal strings (ql3a.py:126-132), counters are integers, parameters are the plan's JSON numbers. Equal inputs give equal strings; there is nothing to tolerate.
3. The only place where bytes could drift without an engine change is the storage round trip: Python `json.dumps` to Node `JSON.parse` to `JSON.stringify` to PostgreSQL JSONB and back. JSONB changes key order (irrelevant under `canonical`) and normalises JSON numbers, but the numbers in these results are integers (counts) and the plan's grid values, which were JavaScript numbers before they were stored and come back as the same JavaScript numbers; every metric is a string. Section 10 item 13 proves this on a real cluster for a fixture run and is the acceptance evidence for this rule. If that test fails, the design premise is wrong and the slice stops; it does not add a tolerance.

Interpreter drift (another Python version producing different shortest-repr floats or a different Decimal behaviour) is an engine change that the file closure cannot see. It is recorded as a limitation in the same way OD-13 records engine changes (section 11, Q2); a digest difference is still `BI_RESULT_MISMATCH`, and never a tolerance.

## 7. Decision D-S3-6: record to `bi_trace_reproductions` columns and guards

One row per `TRACE_FILES` path, three rows per export, written by S4 in the build transaction (schema line 24-25), from `traceReproductionRecords(reproduction, files, recorded_at_ms)`:

| Column | Value | Constraint it meets (migration.js:213-222) |
| --- | --- | --- |
| `export_id` | the export of the build, same transaction | FK `bi_trace_reproductions_export_id_fkey` |
| `path` | one of `TRACE_FILES` | `path_check`, primary key `(export_id, path)` gives exactly three rows |
| `sha256` | `hash(files[path])` of the rendered bytes; equals the `bi_package_files.sha256` of the same path, which S4 asserts | `sha256_check` |
| `steps_digest` | section 3 | `steps_check` |
| `holdout_digest` | section 3 | `holdout_check` |
| `trace_engine_hash` | `hash(canonical({version:'trace-reproduction-closure-v1', files:{<the two S3 files>: sha256}}))`, computed like `fixedEvalEngineHash` (quant-fixed-eval-engine.js:23-26) with an injectable `readFile`; this is S3's own identity, the analogue of `validator_engine_hash` (OD-13) | `trace_engine_check` |
| `run_engine_hash` | `contract.engine_hash`, written only after the section 4 check made it equal to the live closure | `run_engine_check` |
| `recorded_at_ms` | S4's clock, passed in; S3 has no clock | `recorded_at_check` |

Guards the insert passes through, and what S4 must do for them:

- `bi_trace_reproductions_00_serializable` (`bi_require_serializable`, QR003): the rows go inside the one SERIALIZABLE build transaction of RC-16 and RC-26, with the bounded 40001 retry from the start of the transaction.
- `bi_trace_reproductions_guard` (`bi_guard_candidate_record`, schema 502-511, QR004): takes the per-export advisory lock and requires the latest status to be `EXPORT_CANDIDATE`. The seq-1 `EXPORT_CANDIDATE` event must therefore be inserted before the three rows in the same transaction; the insert order is exports, package files, status event seq 1, then trace rows (the deferred `bi_exports_complete` check runs at commit and does not count trace rows).
- `bi_trace_reproductions_no_change` and `_no_truncate` (`bi_freeze`, QR002, ENABLE ALWAYS): rows are never edited. A rebuild of the same run returns the existing export (RC-16) and writes nothing; a changed engine means a new run and a new export (contract line 652-654).
- OD-16: a refused package keeps the manifest and the gate report only; S4 never writes trace rows for a build that B0 refused, because B0 fails before the transaction commits and the transaction rolls back as a whole.

Reading side for the gate: S6 (attempt service) selects the three rows and passes them as `subject.trace_reproduction = [{path, sha256, steps_digest, holdout_digest}]`; `traceReproduced` ignores extra keys, so the two engine hash columns may be passed through unchanged. The record with a missing row, a duplicate row or a different digest gives `BI_RESULT_MISMATCH` and `HOLDOUT_MISMATCH` as package-gates.js:676-685 already encodes.

## 8. Decision D-S3-7: where it runs and failure codes

Where: local machine, fixture packages only (RC-18, contract 11.1 item 1), and in tests the throwaway PostgreSQL cluster of test/postgres (one file per process, contract 11.2). S3 starts no VPS work, reads no host credential and has no route. The Python process is a plain spawn in the style of `pythonEvaluation` (worker 12-32): `QUANT_RESEARCH_PYTHON`, `cwd` repo root, `PYTHONPATH=quant_lab/src`, stderr discarded (no private source through Python errors), stdin request cap 8 MiB, timeout, and an output cap of 16 MiB instead of the worker's 2 MiB because the trace rows of a 10000-bar run can exceed 2 MiB (the package cap of RC-14 is the natural bound; a reply above it is refused). The first real (non-fixture) build runs under S4's gate and the owner's authority, not under S3.

Failure codes, existing first. Every S3 failure refuses the build and writes no row:

| Situation | Code | Source |
| --- | --- | --- |
| Live run closure hash differs from `contract.engine_hash` | `BI_ENGINE_HASH_MISMATCH` | contract 4.3 line 266, 5.3 line 443, RC-17 |
| Run not `SUCCEEDED`, or `completion_reason` not `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`, or `holdout_evaluated !== true`, or no `selected.parameters` | `STATUS_NOT_COMPLETED`, `BI_RUN_NOT_QUALIFIABLE` | contract 4.3 "Research run" row |
| Rows missing, wrong count, gapped, misaligned with `contract.dataset`, or (foundation) the binding is absent | `BI_DATASET_UNAVAILABLE` | contract 4.3 "Data window" row |
| Row digest differs from the frozen dataset digest (foundation `dataset_sha256`; legacy rows are inside the contract whose `contract_hash` S4 verified) | `BI_DATASET_HASH_MISMATCH` | contract 4.3 |
| Multi-Pine membership | refuse before S3 at B0 (RC-20); S3 does not need a code | RC-20 |
| Python unavailable, timeout, output too large, nonzero exit, unparsable or `{"error"}` reply, request too large | `QUANT_PYTHON_UNAVAILABLE`, `EVALUATION_TIMED_OUT`, `EVALUATION_OUTPUT_TOO_LARGE`, `EVALUATION_FAILED`, `INVALID_EVALUATION_RESPONSE`, `RESEARCH_REQUEST_TOO_LARGE` | worker lines 17-29, reused with the same meaning |
| Legacy mirror self-check failed (section 5) | `TRACE_REPLAY_DIVERGED` (new) | root assigns; not a gate code |
| S3 called with an input shape it cannot read (not a research contract, missing split, unknown backend) | `TRACE_REPRODUCTION_INPUT_INVALID` (new) | root assigns; same role as `RENDER_INPUT_INVALID` |

The two new codes are build refusals, not gate codes, so `RETRYABLE_CODES` and the 6.1 graph stay closed (RC-5). If root prefers no new code, `TRACE_REPLAY_DIVERGED` can map to `INVALID_EVALUATION_RESPONSE` with a loss of diagnosis; the recommendation is the new code.

## 9. Decision D-S3-8: slice split, exact files, one writer per file

New files only. No edit to research_engine.py, research_chunk.py, quant-research.js, quant-research-worker.js, quant-research-foundation.js, preflight-resolver.js, runtime-engine-files.js, quant-fixed-eval-engine.js, package-gates.js, package-render.js, best-inputs-package-schema.sql or best-inputs-package-migration.js.

| Packet | Role (Claude column) | Writable paths | Stop condition |
| --- | --- | --- | --- |
| S3-A driver | Coder, Sonnet 5.5 / high | `quant_lab/src/robot_quant/trace_reproduction.py`, `quant_lab/tests/test_trace_reproduction.py` | pytest green for section 10 items 10-12; no engine file touched (`git status` shows only the two paths) |
| S3-B Node module | same Coder, same lane, after S3-A (the request and reply framing reference each other, so the two are not split into lanes; owner rule 2026-10-17) | `src/quant-library/trace-reproduction.js`, `test/trace-reproduction.test.js` | `node --test test/trace-reproduction.test.js` green for items 1-9 |
| S3-C cluster evidence | Tester, Sonnet 5.5 / medium | `test/postgres/bi-trace-reproduction.test.mjs` (new; the S2 file `test/postgres/best-inputs-package.test.mjs` is not edited) | items 13-15 green on the throwaway cluster, or a recorded failure of item 13 that stops the slice |
| S3-D contract text | Documentation, Sonnet 5.5 / low, after root accepts | docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md 5.3 paragraph and a 10.2 row (RC-34) naming the engine path, the two codes and the closure constant | text only |

Verify panel: tester plus an Opus 5.5 architecture auditor (high-risk logic: lineage and verdict evidence). No Fable second opinion is required by the 2026-10-17 sizing rule (not host-adjacent, no GO) unless root records a reason. A fix round re-verifies only the changed files with one rerun of the existing suite.

Interface S3 exposes to S4 (fixed now so S4 can be designed against it): `reproduceTraces({run, rows, binding, closureHash, evaluate})` returning the section 2 object, where `closureHash` is `engineHash(foundation)` computed by the caller or by S3 (S3 computes it when not injected) and `evaluate` is the injectable process runner; `traceReproductionRecords(reproduction, files, recordedAtMs)` returning the three rows; `TRACE_REPRODUCTION_FILES`, `TRACE_REPRODUCTION_CLOSURE_VERSION`, `traceReproductionEngineHash(readFile)`; `TRACE_COLUMNS` (the frozen column lists of section 5).

## 10. Test plan with mutation targets

Node unit tests (`test/trace-reproduction.test.js`, injected evaluator, no Python, no database):

1. Neighbour enumeration equals the worker's for a fixture contract with three domains, an edge index and an `emaFast >= emaSlow` pair that `validParameters` rejects. Mutation: swap the `[index-1, index+1]` order, or stop skipping the invalid pair; the recomputed `steps_digest` then differs from the golden digest and the test fails.
2. Digest shape equals `storedStepDigests`: with an evaluator stub that returns the golden fixture's stored results (test/helpers/quant-library-fixture.mjs, the `stepsDigest` and `holdoutDigest` of test/quant-library-package-gates.test.js:124-125), S3's digests equal the golden subject's. Mutation: drop the `kind` key from the digest input or rename `cost_stress`; fails.
3. No copy from storage: the stub returns results that differ from `selected.result`; S3's digests must differ from the stored digests, and `selected.result`, `.sensitivity`, `.cost_stress`, `.test` are replaced by throwing getters that must never fire. Mutation: an implementation that reads any stored result; fails.
4. Engine check first: `contract.engine_hash` not equal to the injected closure hash gives `BI_ENGINE_HASH_MISMATCH` with zero evaluator calls. Mutation: move the check after the first step; fails.
5. Backend routing: a legacy contract yields `research_engine` requests with bars sliced to `validation_end` for CANDIDATE, SENSITIVITY and STRESS and full bars for HOLDOUT; a foundation contract yields chunk requests with the binding rows and `checkpoint: null`. Mutation: remove the slice (holdout candles enter a candidate request); fails.
6. Records: exactly three rows, path set equals `TRACE_FILES`, every `sha256` equals `hash(files[path])`, every digest and hash matches `^[0-9a-f]{64}$`; a missing or non-string file refuses. Mutation: hash the trace rows instead of the rendered bytes; fails.
7. Trace rows: partition labels at both boundaries (`train_end - 1` is `train`, `train_end` is `validation`, `validation_end` is `test`); warm-up intents absent from decisions; an open allocation absent from trades; equity string equals `cash + quantity * close` from the stub replay; rendering the same reproduction twice through `renderPackage` gives identical `sha256` for all three files. Mutation: off-by-one on a boundary; fails.
8. Process framing with a stub Python script: reply above 16 MiB gives `EVALUATION_OUTPUT_TOO_LARGE`; nonzero exit gives `EVALUATION_FAILED`; `{"error":"X"}` gives `INVALID_EVALUATION_RESPONSE`; a sleeping stub gives `EVALUATION_TIMED_OUT`; a request above 8 MiB is refused before spawn with `RESEARCH_REQUEST_TOO_LARGE`.
9. Closure identity: `TRACE_REPRODUCTION_FILES` is disjoint from `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`, `QUANT_RUNTIME_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES` and `FIXED_EVAL_ENGINE_FILES`; `traceReproductionEngineHash` changes when one listed byte changes (injected `readFile`) and when a file is dropped from the list. Mutation: add an S3 file to a closure list in a scratch copy; the disjointness assertion fails.

Python tests (`quant_lab/tests/test_trace_reproduction.py`, same fixtures as test_research_engine.py):

10. Legacy driver: for each of the four kinds the driver's result equals `research_engine.evaluate(request)` as `json.dumps(sort_keys=True)` bytes. The self-check raises `TRACE_REPLAY_DIVERGED` when the mirror is monkeypatched to factor 2 or to a cold-start ATR. Mutation target: the mirror's `PaperModel` factor or `start_time`.
11. Foundation driver: looping `evaluate_chunk` to completion with the trace sink equals a one-shot run over all rows; the sink's decision count equals `result["decision_count"]` and its fill count equals `result["fills"]`; a tampered checkpoint integrity is refused by the engine and surfaces as `EVALUATION_FAILED`.
12. Driver hygiene as fixed_eval.py: NaN and Infinity refused by `parse_constant`, request size cap, only an upper-case code on stderr-free stdout, no path or traceback in any reply (assert the reply bytes contain no `/` outside the fixed keys and no `Traceback`).

Isolated PostgreSQL (`test/postgres/bi-trace-reproduction.test.mjs`, labelled fixture run, real Python):

13. Round-trip exactness, the acceptance test of section 6: a fixture research run inserted with the research fixture helpers and its `quant_job_steps` rows read back from JSONB; `digest` over the read-back selected steps equals S3's recomputed `steps_digest` and `holdout_digest`. This is the only test allowed to decide the exactness premise; a failure stops the slice and is reported to root as a design fact, not patched with a tolerance.
14. Guards: three rows inserted after the seq-1 event in one SERIALIZABLE transaction succeed; the same insert before the event gives QR004; outside SERIALIZABLE gives QR003; a fourth path gives 23514; a duplicate path gives 23505; `UPDATE` and `DELETE` give QR002 also for the runtime role; a `sha256` of 63 hex characters gives 23514.
15. End to end through the gate: `evaluateProvenance` with the rows read back from the table gives neither `BI_RESULT_MISMATCH` nor `HOLDOUT_MISMATCH` for the golden package; one changed byte in `quant-data/trades.csv` gives `BI_RESULT_MISMATCH`; a changed `holdout_digest` gives `HOLDOUT_MISMATCH`. Mutation target: a record whose `steps_digest` was copied from the stored digest still passes this test, which is why item 3 exists at unit level and is required too.

Mutation target summary: neighbour order and skip rule; digest key set; stored-result read; engine check position; holdout bar slice; bytes hashed; partition boundaries; mirror factor and start time; closure list membership.

## 11. What needs the owner (recommended default marked)

- Q1 (owner): may the test partition rows (holdout fills in `trades.csv`, holdout decisions, holdout equity points) ship inside a package? Default: yes, labelled by the `partition` column; bars never ship, metrics.json already carries test metrics, and the run already opened its holdout. Alternative if the owner prefers tighter disclosure: `trades.csv` and `decisions.csv` carry train and validation rows only, `equity.csv` keeps the full curve; the digests are unaffected because they never depend on the trace rows.
- Q2 (owner): accept "Python interpreter version is outside the engine hash" as a recorded limitation in the OD-13 style, with no schema change, and with a digest difference after an interpreter upgrade treated as `BI_RESULT_MISMATCH` (new run and new export needed)? Default: accept; the alternative (a `python_version` column) needs an S2 schema revision and a new package schema version.

Root decisions, not owner: the two new codes of section 8 and their names; whether S3-C may run on the existing S2 template cluster helper; the RC-34 wording.

## 12. Top risks

1. Round-trip exactness (section 6) is a premise proven only by test 13. If JSONB or the Node parse changes any value, no package can pass C3 and the fix is in the storage path, not in S3.
2. The legacy mirror (section 5) duplicates about twenty lines of research_engine.py. The self-check bounds the damage to a refused build, but a divergence makes legacy runs unpackagable until the mirror is fixed; the foundation path has no mirror.
3. Interpreter drift is invisible to every file closure (section 6, Q2).
4. Recomputation cost: a legacy build runs the engine five times plus once per neighbour, up to 10000 bars each, in one Python process with a 16 MiB reply cap; the build worker must size its timeout to this (the worker's 30 s per step is the reference) and must not run it inside the SERIALIZABLE transaction.
5. Holdout disclosure through fill prices (Q1) is a product decision, not a code decision; the default shown here is the more permissive one.
6. `evaluate_chunk`'s `trace` sink is an in-process hook documented as "unavailable through IPC" (research_chunk.py:253); S3 relies on it from inside the driver, which is in-process, but any later change to that signature is an engine change that rotates `FOUNDATION_ENGINE_FILES` anyway.
