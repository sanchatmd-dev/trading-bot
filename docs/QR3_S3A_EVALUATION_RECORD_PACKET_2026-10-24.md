# QR-3 S3a evaluation record assembler packet

Status: PREPARED; ROOT-ADOPTED FOR LOCAL IMPLEMENTATION; NOT ACCEPTED.

Feature: PM-1 F10-02 "QR-3 full fair comparison", local sub-slice S3a. Target of this packet: local engineering only.

Revision read: branch `codex/fe2b-ci-local-fix`, HEAD `3a46849`. Line numbers below teach interfaces at that revision only.
They are not acceptance evidence.

This packet changes no contract, Roadmap row or PM-1 credit. It is not a GO. It does not amend
`docs/QR_3_FAIR_COMPARISON_CONTRACT.md`. The record version id it names is PROPOSED inside this packet only.

---

## 0. Reading key

- Short names: QR3 = `docs/QR_3_FAIR_COMPARISON_CONTRACT.md`; FEC = `src/quant-research/fixed-eval-contract.js`;
  FEPY = `quant_lab/src/robot_quant/fixed_eval.py`; FES = `src/postgres/quant-fixed-eval.js`;
  VAL = `src/comparison/valuation.js`; EVD = `src/comparison/evidence.js`; RNK = `src/comparison/ranking.js`;
  CMN = `src/comparison/common.js`; STORE = `src/postgres/comparison-store.js`; SQL = `src/postgres/quant-comparison.sql`;
  PARITY = `test/fixed-eval-qr3-parity.test.js`; FE2B = `docs/FE2B_RELEASE_PLAN_DRAFT.md`.
- `file:line` cites the revision above.
- "Refuse" means the function returns `{ok:false, code, detail}` and builds nothing. Nothing is repaired.

---

## 1. Purpose and position

### 1.1 The gap

The QR-3 result tables exist (S2c-2, QR3:987 RC-C45), and their writers exist (`writeEvaluation` STORE:343,
`writeBenchmark` STORE:362, `writeOutcome` STORE:381). The FE-2b fixed-input evaluation lifecycle exists and stays off by
default. No code connects the two. No module in `src` calls the three writers, and no module turns a stored
`fixed-eval-result-v1` into the inputs of the S1 valuation, benchmark, participant status and outcome functions.

FEC:425 records the split: the step validator "does not re-derive metrics; FE-3 valuation owns that." FE2B:22 records that
"QR-3 ranking/benchmark orchestration and QR-4 owner tolerances remain their own slices."

### 1.2 What S3a is

S3a is the pure half of that orchestration. It is three pure functions that build the exact bodies the three writers accept,
from one terminal fixed-evaluation result, the frozen dataset rows and the frozen comparison spec. The functions read no
database, file, network, clock or random source. Nothing imports them: no route, worker, service or runtime root.

### 1.3 What S3a is not

- S3a is not acceptance of QR-3 slice S3. The S3 gate (QR3:841) also needs a capacity review and local PostgreSQL recovery
  and cancel evidence; native QS-1, systemd and cgroup proof remains NOT RUN (FE-2b evidence limits).
- S3a does not discharge the RD-5 V8 hold (QR3:909). See ruling R1.
- S3a does not write any row, start any job, enable `QUANT_FIXED_EVAL_ENABLED`, add a route, or touch staging.
- The database orchestrator that reads a terminal fixed-evaluation job and calls the writers is a later slice.

---

## 2. Root rulings for this packet

| ID | Ruling |
| --- | --- |
| R1 (draft RC-C46) | Conservative. This slice does not discharge the RD-5 V8 hold. Every record states the basis as unconfirmed: `basis_confirmed: false` in the body, and every S1 valuation call passes `basis_confirmed: false`, so `end_treatment` is `VALUATION_BASIS_UNCONFIRMED` (VAL:107-108). Discharging V8 needs a separate, independently reviewed ruling. |
| R2 | Consequence of R1 and of library G8 (QR3:112): the evidence class stays development evidence, every evaluated participant is `DEVELOPMENT_EVIDENCE` (EVD:145-153, EVD:125-133), and the outcome is `NO_QUALIFIED_RESULT`. The value `SINGLE_QUALIFIED_RESULT` is never emitted (QR3:958 OPEN-2; QR3:987 RC-C45). |
| R3 | The evaluation record version id is `qr3-evaluation-record-v1`, status PROPOSED inside this packet. It is not a contract amendment. |
| R4 | The stress valuation (the engine-defined 2x fee and slippage step) is stored in the evaluation record body beside the base valuation. |
| R5 | No S1 file is edited, `src/comparison/index.js` included. The new module is not exported from `src/comparison/index.js`. |

---

## 3. Paths

Writable by the coder (two new files only):

- `src/comparison/evaluation-record.js`
- `test/qr3-evaluation-record.test.js`

Read-only for the coder:

- `src/comparison/common.js`, `context.js`, `period.js`, `valuation.js`, `evidence.js`, `labels.js`, `ranking.js`, `index.js`
- `src/quant-research/fixed-eval-contract.js`
- `src/postgres/comparison-store.js`, `src/postgres/quant-comparison.sql`, `src/postgres/quant-fixed-eval.js`
- `quant_lab/src/robot_quant/fixed_eval.py`
- `test/fixed-eval-qr3-parity.test.js`, `test/qr3-fair-comparison.test.js`
- `docs/QR_3_FAIR_COMPARISON_CONTRACT.md`, `docs/FE2B_RELEASE_PLAN_DRAFT.md`, this packet

The module may import only from `src/comparison/*.js`, `src/money.js`, the canonical and hash helpers already used by those
files, and FEC. It must not import STORE, any `src/postgres` file, `node:fs`, `node:net`, `node:child_process` or a database
driver.

---

## 4. Inputs

### 4.1 Fixed-evaluation result

- The stored run result is `fixed-eval-result-v1` with keys `version, mode, purpose, lineage, engine_hash,
  evaluation_closure, dataset_sha256, base, stress` (FEC:66; built FEC:433-442).
- `base` and `stress` are step results with keys `version, evaluator_closure, kind, cost_stress, model, bridge,
  initial_equity, split, engine_hash, dataset_sha256, parent_run_id, selection_id, metrics_precision, metrics, fills,
  fees_total, slippage_cost_incl_tick_total, exposure, episodes, closed_allocations, open_position, rejected`
  (FEC:67-69; checked FEC:401-422).
- Versions: result `fixed-eval-result-v1`, step `fixed-eval-v1`, closure `fixed-eval-closure-v1`, cost model
  `paper-close-v1`, mode `FIXED_INPUT_EVAL` (FEC:19-21). Purposes `QR4_SELECTION` and `QR3_COMPARISON` (FEC:22).
- Each fill row is the evaluator fill plus `bar_time_ms`, `side` (`BUY` or `SELL`) and `slippage_cost_incl_tick`
  (FEPY:305-318). It keeps the evaluator fields `time`, `price`, `quantity`, `fee` and `sequence`.
- `metrics` carries `end_equity`, `net_return_percent`, `max_drawdown_percent`, `closed_trades` and other partition fields
  as decimal strings at 80 digits (`metrics_precision` 80; FEPY:341-356).
- `exposure` is `{bars_in_market, bars, fraction}`; `episodes` is `{completed_count, completed}`; `rejected` is
  `{total, intents_total, orphan_exits, by_event_type_and_reason}` (FEPY:356-372 and the `_rejected` helper above it).

### 4.2 Function inputs

1. `evaluationRecordBody(input)` with
   `input = {comparison_id, spec_hash, spec, participant_id, evaluation_run_id, fixed_contract, binding, fixed_result, rows}`.
   - `spec` is the frozen STANDARDIZED spec; `spec.period` gives `{start_ms, end_ms}` (RNK:85; STORE:113 stores the
     same window).
   - `fixed_contract` and `binding` are the frozen fixed-evaluation contract and dataset binding of the evaluation job.
   - `rows` are the frozen closed-bar dataset rows with keys `time, open, high, low, close, volume, atr14` (FEC:65), in
     order, `rows[i].time === fixed_contract.dataset.first_time + i * 60000` (FEC:387).
2. `benchmarkRecordBody(input)` with `input = {comparison_id, spec_hash, spec, fixed_contract, rows}`.
3. `outcomeRecord(input)` with
   `input = {spec, spec_hash, context_key, participants:[{participant_id, status_input, evaluation}]}` where
   `evaluation` is `null` or `{body, created_at_ms}` read back from the store, and `status_input` carries the
   participantStatus fields that S3a does not derive (integrity, compatibility, coverage, evidence, episode gate; EVD:150-154).

Every money or metric value in every input is a decimal string. A JavaScript number in a money or metric position refuses
`QR3_SPEC_INCOMPLETE` with detail `NUMBER_NOT_DECIMAL_STRING`, as the S1 rule does (VAL:16; CMN `numberRefusal`).

---

## 5. Rules

### 5.1 Validation first

`evaluationRecordBody` first calls `validateFixedEvalResult(fixed_contract, binding, fixed_result)` (FEC:444). A thrown or
refused validation refuses `QR3_INTEGRITY_FAILED` with detail `FIXED_RESULT_INVALID`. S3a never re-implements that
validator and never accepts a result it did not validate.

### 5.2 Lineage and purpose refusals

Each check below refuses `QR3_INTEGRITY_FAILED` with the detail shown. Checks run in this order and the first failure wins.

| Check | Detail |
| --- | --- |
| `fixed_result.purpose === 'QR3_COMPARISON'` | `PURPOSE` |
| `fixed_result.lineage.object_id === comparison_id` | `LINEAGE_OBJECT` |
| `fixed_result.lineage.parent_run_id === participant_id`, and the same in `base` and `stress` | `LINEAGE_PARENT` |
| `base.selection_id === null` and `stress.selection_id === null` | `SELECTION_ID` |
| `spec.participants` includes `participant_id` | `PARTICIPANT_NOT_IN_SPEC` |
| `evaluation_run_id` is a valid run id (STORE id rule) | `EVALUATION_RUN_ID` |
| `fixed_result.evaluation_closure.version === 'fixed-eval-closure-v1'` | `CLOSURE_VERSION` |
| `base.split` equals `stress.split` field by field | `SPLIT_MISMATCH` |

The spec hash is not recomputed here; the store and the database tie `record_spec_hash` to the frozen spec (SQL:172-179;
QR3:368-372 F3). `outcomeRecord` recomputes it through `decideOutcome` (RNK:174-176).

### 5.3 Window and time translation

The dataset times are verified closed-bar timestamps (FEC:16-17). The QR-3 grid and fills use bar-open times
(`qr3-grid-bar-close-v1`, QR3:302 V4; VAL:50-57). FE2B:26 requires the translation to be explicit: matching integer fields
alone is insufficient.

Rules:

- W1 Scored rows are `rows[split.warmup]` to `rows[split.end - 1]` (FEC:193-196).
- W2 Grid: for each scored row, `{time_ms: row.time - 60000, close: row.close}`.
- W3 Period: `start_ms = rows[split.warmup].time - 60000` and `end_ms = rows[split.end - 1].time`. This must equal
  `spec.period.start_ms` and `spec.period.end_ms`; otherwise refuse `QR3_INTEGRITY_FAILED`, detail `WINDOW_MISMATCH`.
  FES:223-224 states the same rule from the other side: the first scored close is S plus one minute and the last is E.
- W4 Grid length equals `split.evaluated_bars`; otherwise refuse `WINDOW_MISMATCH`.
- W5 Each fill must have `bar_time_ms === time - 60000` (FEPY:316; FEPY:28). Otherwise refuse `QR3_INTEGRITY_FAILED`, detail
  `FILL_TIME_TRANSLATION`.
- W6 Each fill's `bar_time_ms` must lie in `[start_ms, end_ms)`. Otherwise `valueRun` refuses `QR3_METRIC_UNAVAILABLE`,
  detail `FILL_OUTSIDE_WINDOW` (VAL:73), and S3a passes that refusal through.

Worked example (warm-up 2 bars is illustrative only; the real floor is 1006 bars, FEC:25):

| Item | Value |
| --- | --- |
| Spec period | S = 1800000000000, E = 1800000180000 (three 1m bars) |
| Dataset rows (closed-bar `time`) | index 0: S − 60000; 1: S; 2: S + 60000; 3: S + 120000; 4: S + 180000 = E |
| Split | warmup 2, end 5, evaluated_bars 3 |
| Grid (bar-open `time_ms`) | S, S + 60000, S + 120000 |
| Period from rows (W3) | start_ms = (S + 60000) − 60000 = S; end_ms = E |
| Fill with `time` S + 120000 | `bar_time_ms` S + 60000: second grid bar, accepted |
| Fill with `time` E | `bar_time_ms` E − 60000: last grid bar, accepted |
| Fill with `time` S | `bar_time_ms` S − 60000: a warm-up bar, outside `[S, E)`, refused |

### 5.4 Valuation calls

- Initial cash is `fixed_contract.capital.initial_cash`. It must equal `base.initial_equity` as decimals; this QR-3 profile
  requires sizing equity equal to cash (FE2B:24, C10). Otherwise refuse `QR3_INTEGRITY_FAILED`, detail `CASH_EQUITY`.
- Fill mapping, as PARITY:71-78: `{bar_time_ms, side, quantity, price, fee, sequence, slippage_cost:
  slippage_cost_incl_tick}`.
- `valueRun({initial_cash, period, grid, fills, flows: [], basis_confirmed: false})` once for `base` and once for
  `stress` (VAL:58). A refusal is passed through unchanged.

### 5.5 Exact-decimal cross-check

Money and percentages are compared as decimals with `Money` equality (`src/money.js`), never as JavaScript floats and never
with a tolerance. This is the PARITY:80 standard. Each pair below must be equal for `base` and for `stress`; any difference
refuses `QR3_INTEGRITY_FAILED` with the detail shown.

| Evaluator field | `valueRun` field | Detail |
| --- | --- | --- |
| `metrics.end_equity` | `end_nav` | `CROSS_CHECK_END_NAV` |
| `metrics.net_return_percent` | `net_return_percent_exact` | `CROSS_CHECK_RETURN` |
| `metrics.max_drawdown_percent` | `max_drawdown_percent_exact` | `CROSS_CHECK_DRAWDOWN` |
| `fees_total` | `total_fees` | `CROSS_CHECK_FEES` |
| `slippage_cost_incl_tick_total` | `total_slippage.value` | `CROSS_CHECK_SLIPPAGE` |
| `exposure.bars` | `bars` (integer equality) | `CROSS_CHECK_EXPOSURE` |
| `exposure.fraction` × 100, rounded once to 12 places half-even | `exposure_percent` | `CROSS_CHECK_EXPOSURE` |

The body stores the `valueRun` outputs. It never copies an evaluator figure that failed the check.

### 5.6 Evaluation record body (`qr3-evaluation-record-v1`, PROPOSED)

| Field | Content |
| --- | --- |
| `version` | `qr3-evaluation-record-v1` |
| `record_comparison_id` | `comparison_id` (SQL:174-175) |
| `record_spec_hash` | `spec_hash` (SQL:176-177) |
| `window` | `{start_ms, end_ms}` as numbers equal to the spec window (SQL:178-179; QR3:987) |
| `participant_id`, `evaluation_run_id` | lineage |
| `engine_hash`, `dataset_sha256`, `evaluation_closure` | copied from the validated result |
| `basis_confirmed` | `false` (R1) |
| `valuation` | the base `valueRun` result |
| `stress_valuation` | the stress `valueRun` result (R4) |
| `metrics` | the six `REQUIRED_METRICS` (EVD:119) from the base valuation, with `rejected_intents` from `base.rejected` (open question Q2) |
| `completed_episodes` | `base.episodes.completed_count` |
| `closed_allocations` | `base.closed_allocations` |
| `rejected` | `base.rejected` copied in full |
| `limitations` | sorted; always includes `VALUATION_BASIS_UNCONFIRMED` |

The canonical text must be at most `MAX_EVALUATION_BYTES` (4194304, STORE:270). The function returns
`{ok: true, body, body_hash}` with the hash of the canonical text, computed the same way as STORE `bodyText` and `hash`.

### 5.7 Benchmark body

`benchmarkRecordBody` builds the grid and period by W1 to W4 and calls `buyAndHold` (VAL:141-149) with `initial_cash` as in
5.4, `data_model` `{price_tick, quantity_step}` and `cost_model` `{fee_bps, slippage_bps}` from the frozen fixed contract
cost model, `basis_confirmed: false` and `include_liquidation_line: false` (QR3:333 section 5.3, OD-C12). The body is
`{benchmark_id: 'qr3-bh-close-same-cost-v1', record_comparison_id, record_spec_hash, window, result}`. `benchmark_id` must equal
STORE:271 and SQL:197-199. A refused benchmark is stored as a null line that keeps its own code (B6, RC-C20; VAL:141-147; excess return VAL:192-196); it
does not refuse the comparison. The canonical text must be at most `MAX_BENCHMARK_BYTES` (262144).

### 5.8 Outcome record

For each participant, `outcomeRecord`:

1. Sets `has_evaluation` to `evaluation !== null`.
2. Sets `evaluation` for participantStatus to `{basis_confirmed: false, metrics: body.metrics}`; S3a never passes `true`.
3. Calls `participantStatus` (EVD:155) with the caller's `status_input` plus those two fields and the spec thresholds from
   `specThresholds(spec)` (RNK:242).
4. Maps to the decideOutcome participant `{id, created_at_ms, status, primary_metric, reasons}`, with `created_at_ms` the
   stored record time (`evaluation.created_at_ms`), and `primary_metric` the body `net_return_percent`.

It then calls `decideOutcome({mode: 'STANDARDIZED', spec, spec_hash, context_key, participants})` (RNK:167). The returned
record has exactly the `OUTCOME_FIELDS` `version, mode, spec_hash, context_key, outcome, participants, uncertainty,
only_qualified_participant_id, limitations` (STORE:277), with `version` `qr3-outcome-v1` (CMN:19; SQL:222-229).

Outcome constraints:

- With R1, every participant with a record fails the evaluation check and is `DEVELOPMENT_EVIDENCE`, so the outcome is
  `NO_QUALIFIED_RESULT`. S3a refuses `QR3_INTEGRITY_FAILED`, detail `OUTCOME_NOT_ALLOWED`, if `decideOutcome` ever
  returns another value.
- `SINGLE_QUALIFIED_RESULT` is never produced (QR3:987).
- A participant whose status needs a stored evaluation must have one with the same time, and `NOT_EVALUATED` must have
  none (QR3:987; STORE:276). S3a refuses `QR3_INTEGRITY_FAILED`, detail `OUTCOME_EVALUATION_MISMATCH`, otherwise.
- The participant ids must equal `spec.participants` exactly.
- A spec hash that differs from the recomputed hash refuses `QR3_SPEC_IMMUTABLE` (RNK:174-176; QR3 F4).

### 5.9 Immutability

Each function deep-freezes its output and never mutates an input. It writes nothing back to the fixed-evaluation result,
the spec or the dataset rows. It reads no participant's own holdout window and writes no exposure; exposure is appended
only by the create transaction (QR3 RC-C32).

---

## 6. Acceptance

Pure `node:test` checks in `test/qr3-evaluation-record.test.js` on synthetic objects only. No Python spawn and no
PostgreSQL.

| ID | Check |
| --- | --- |
| A1 | The evaluation, benchmark and outcome bodies meet the SQL CHECK shapes (SQL:172-179, 197-199, 222-229) and the byte limits (STORE:270). The same input gives the same canonical text and hash. |
| A2 | Time translation: a fill with `bar_time_ms` not equal to `time − 60000` refuses `FILL_TIME_TRANSLATION`; a warm-up fill refuses `FILL_OUTSIDE_WINDOW`; a grid shifted by one bar or a period that differs from the spec refuses `WINDOW_MISMATCH`. The worked example in 5.3 is a test. |
| A3 | Cross-check: changing any one evaluator figure in 5.5 by the smallest decimal step refuses with its detail. Nothing is repaired. |
| A4 | Lineage and purpose: each row of 5.2 refuses with its detail when its single input is changed; a `QR4_SELECTION` result refuses `PURPOSE`. |
| A5 | A JavaScript number in any money or metric position refuses `NUMBER_NOT_DECIMAL_STRING`. |
| A6 | Benchmark: `benchmark_id` equals the constant; unreadable bars give a null line with `QR3_BENCHMARK_DATA_UNAVAILABLE`; one unaffordable quantity step gives `NO_UNITS_AFFORDABLE`. |
| A7 | Outcome: exactly the `OUTCOME_FIELDS`; inputs that would otherwise be eligible still give `NO_QUALIFIED_RESULT`; never `SINGLE_QUALIFIED_RESULT`; participant ids equal the spec; `NOT_EVALUATED` has no record; a spec hash mismatch refuses `QR3_SPEC_IMMUTABLE`. |
| A8 | Basis: every evaluation body has `basis_confirmed: false` and `VALUATION_BASIS_UNCONFIRMED`; no input field can turn it to `true` (an input carrying `basis_confirmed` refuses `INVALID_FIELDS`). |
| A9 | Inputs are deep-equal before and after each call, and outputs are frozen. |
| A10 | A static check of the module source finds no import of `node:fs`, `node:net`, `node:child_process`, a database driver, STORE or any `src/postgres` file, and no `Date.now` or `Math.random`. |

The tester also runs a single-edit mutation pass on `src/comparison/evaluation-record.js`. Mutation runs are serialized:
no other agent runs tests that load these files at the same time. The tester reports killed, survived, equivalent and
invalid mutants separately.

Root runs the full default Node suite once at the end. PostgreSQL suites run only in GitHub CI.

---

## 7. Exclusions

- No edit to any S1 file, `src/comparison/index.js` included, or to STORE, SQL, FEC, FES, FEPY or any test other than the
  new test file.
- No database call, job start, worker or route wiring, feature flag change, staging step, host or VPS contact, migration,
  install or grant change.
- No holdout read, optimizer or data-range loop, Best Inputs apply, Bot action, Live or new research run.
- No change to any ranking threshold, registry default, tie band, uncertainty method, benchmark method or valuation formula.
- No discharge of the RD-5 V8 hold, no `SINGLE_QUALIFIED_RESULT`, no qualified label.
- No QR-4 change. A QR-3 outcome is never a QR-4 ranking input (QR-4 contract section 1.3).

---

## 8. Review panel

| Role | Model and effort | Scope |
| --- | --- | --- |
| Coder | Sonnet 5.5 / high | The two writable files only |
| Tester | Sonnet 5.5 / medium | Independent A1 to A10 and the serialized mutation pass |
| Architecture auditor | Opus 5.5 / high | Formulas, time translation, exact-decimal checks, basis ruling, outcome body against the store and SQL contract |

Fable 5.1 is paused by the owner and is not used. No substitution is needed because no Fable role is planned. Root accepts
or rejects; reviewer reports are evidence, not acceptance.

---

## 9. Documentation follow-up for root

- ROADMAP row QR-3 (`docs/ROADMAP.md` line 1434) still says "S3 to S6 have not started". FE-2b delivered the RD-7 job class
  as local engineering evidence. After S3a acceptance, root should update that row to name FE-2b and S3a without claiming
  S3 acceptance.
- After acceptance, root may record R1 as RC-C46 in QR3 section 15 and add an evidence record for S3a.
- This packet does not edit the Roadmap, Time Management or any handoff.

---

## 10. Open questions for root

- Q1 Should the evaluation body also store the stress run's episodes, rejected counts and closed allocations, or only the
  stress valuation (R4)?
- Q2 Is `rejected_intents` taken from `rejected.intents_total` (refused intents minus orphan exits) or `rejected.total`?
  This packet proposes `intents_total` and stores the full `rejected` object.
- Q3 Who supplies `episode_gate_available` and the integrity, compatibility, coverage and evidence inputs to
  participantStatus: the later database orchestrator from stored freeze records and library G5? S3a takes them as inputs
  and does not derive them.
- Q4 Should the benchmark body record the cost model of the base step only, given that the stress step doubles fee and
  slippage? This packet proposes base only (QR3 section 5.3 "same cost").

---

## 11. Root answers, 2026-10-24

- Q1: Only the stress valuation is stored (R4). Stress episodes, rejected counts and closed allocations stay in the
  validated fixed-evaluation result, which the record references through `evaluation_run_id`.
- Q2: `rejected_intents` comes from `rejected.intents_total`, as proposed; the full `rejected` object is stored. The
  architecture auditor confirms this against the `REQUIRED_METRICS` definition and the contract before acceptance.
- Q3: The caller supplies those participantStatus inputs. The later database orchestrator derives them from stored freeze
  records and library gates; S3a never derives or defaults them.
- Q4: The benchmark uses the base step cost model only, as proposed.
- The two packet-authored rules are confirmed: `OUTCOME_NOT_ALLOWED` refuses any outcome other than
  `NO_QUALIFIED_RESULT`, and any input carrying a `basis_confirmed` key refuses `INVALID_FIELDS` (A8).
- Process note: the packet author corrected twelve line citations with one in-place shell edit, against its brief. Only
  citation text changed; root accepted the resulting text after review and records the deviation here.

---

## 12. Root rulings after independent verification, 2026-10-24

The independent tester passed A1 to A10 and the serialized mutation pass killed every non-equivalent mutant except two
low-severity test gaps. The architecture auditor returned NO-GO on two findings. Root rules as follows; none of these
needs an SQL, store or S1 change.

- **P1, benchmark size (amends 5.7).** The stored benchmark result omits `valuation.nav_series`. In its place the result
  carries `nav_series_sha256`, the SHA-256 of the canonical text of the omitted series, and `nav_points`, its length, which
  must equal the scored bar count. Grounds: QR3 section 5.3 B1 to B6 never require the series; B5 uses only the net
  return; uncertainty (section 6.4) resamples participants, never the benchmark. Participant evaluation bodies keep their
  full series. The body must fit `MAX_BENCHMARK_BYTES` for the largest window the profile admits (8994 scored bars), and a
  test proves it. The coder confirms the new shape against the SQL CHECK and the store writer before changing it; if any
  check would refuse it, stop and report.
- **P2, hidden metrics (amends 5.8).** `primary_metric` is the body's `net_return_percent` only when
  `participantStatus` returns `metrics_visible: true` and a record exists; otherwise it is null. A test proves that an
  excluded or unavailable participant with a stored record gets a null metric.
- **P3 adopted:** the outcome refuses an evaluation body whose `version`, `participant_id`, `record_spec_hash` or
  `basis_confirmed` (must be false) does not match its entry; the outcome passes the `VALUATION_BASIS_UNCONFIRMED`
  limitation if `decideOutcome` and the SQL CHECK accept it (otherwise report and leave as is); the exposure cross-check
  also requires an integer `bars_in_market` with `round18(bars_in_market / bars) == fraction` and
  `round12(bars_in_market / bars * 100) == exposure_percent`; `rejected.intents_total` must equal `total` minus
  `orphan_exits` and `episodes.completed_count` must equal `episodes.completed.length`; a test at exactly the byte limit
  and at the limit plus one closes mutation gap M27.
- **Recorded, no code change:** three section 5.2 rows are unreachable after `validateFixedEvalResult` and stay as defence
  in depth; A5 refuses a number in an evaluator total as `FIXED_RESULT_INVALID` because validation runs first (both fail
  closed); nested `basis_confirmed` keys inside the spec or contract are not scanned, because the valuation basis is
  hard-coded false; mutant M38 is accepted as unreachable after contract validation; when R1 is lifted, ranking must use
  the unrounded `net_return_percent_exact` and the record's own drawdown (QR3 V7); the later orchestrator must read rows
  only through the verified binding and pass the stored spec.

---

## 13. Root ruling after exact-revision CI, 2026-10-24

The first push of S3a failed exact-revision CI in `test/fixed-eval-engine.test.js` ("runtime importers of fixed evaluation
remain inside the reviewed manifest"). That guard requires every `src` module whose text names the fixed-evaluation
contract or engine modules to be listed in the reviewed fixed-evaluation closure. Listing S3a there would change the FE-2b
closure hash, which is an engine-closure change that needs the FE-2b release plan and an owner GO. Local verification
missed it because the guard test was not among the suites run.

Ruling: S3a stays outside the evaluation closure. The module no longer imports the fixed-evaluation contract and its
source text names none of the guarded modules. `evaluationRecordBody` and `benchmarkRecordBody` take the contract's
validators as a required dependency argument (for example `{validateFixedEvalResult, validateFixedEvalContract}`) and
refuse with `QR3_INTEGRITY_FAILED`, detail `VALIDATOR_MISSING`, when a required validator is absent or not a function.
Constants previously imported from the contract are restated as literals and pinned by a test that compares them with the
contract's exports. Tests pass the real validators. The later database orchestrator, which will sit inside the reviewed
closure under its own packet and GO, supplies them. Every other rule in this packet is unchanged. Before any further push,
the full default Node suite runs locally once, and every test that imports a changed module runs.
