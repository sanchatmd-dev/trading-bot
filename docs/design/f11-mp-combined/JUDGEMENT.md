# Design judgement: F11 combined evaluator `mp-combined-paper-v1` and RS-6 prerequisites

Role: architecture auditor as design judge (Opus 5.5 / high), for "Root: astra-vps-trade-bot-v2".
Repository read: the repository at `7847a05`. Read-only; no Git, no tests run, no network.
Drafts judged:

- Primary (P): `DRAFT_OPUS.md` (Opus; rows RD-MP-24 to 33; RQ-1 to 10, OQ-1 to 2).
- Alternative (A): `DRAFT_FABLE.md` (Fable; rows RD-MP-24 to 31; Q-1 to 3).

Status: proposal for root. Nothing here is a root decision, an owner decision or a GO. Every finding below was checked
against code at `7847a05` unless marked "not verified". Line numbers are 1-based.

## 0. Summary of picks

| Area | Pick | One-line reason |
| --- | --- | --- |
| 1 Input/output shape | Merge: P job protocol and source gate; A's split of `ledger` and `diagnostics` | P keeps the one-Pine source gate in the evaluating process; A's sibling diagnostics make T-P1 a plain byte compare. |
| 2 Ledger semantics | Merge: P mechanism (subclass `PaperState`), A's no-branch rule | Both state the same per-Bot/per-member scope (correct per code); `PaperState` already has a tested equivalence to `paper_replay`. |
| 2b Same-bar order | Either (identical) | Both drafts state `exit-first-ordinal-v1` the same way and match MPC 5.5. |
| 2c Reduce-only EXIT | Either (identical) | Both rest on unchanged `evaluate_risk` reduce-only handling. |
| 3 Warm-up | Either (identical) | Both: one ledger start `first_time + warmup * 60000`, cold start at row 0. |
| 4 T-P1 method | A (no branch, no projection) on P's mechanism | A plain byte comparison of the unchanged 7-key ledger dict; no `combined_replay_single`, no `one_pine_view`. |
| 5 Candidate search | P (superset of A) | Same algorithm; P adds the evaluation cap and a parity test that A omits. |
| 6 Baseline failure | Merge: A's "two baselines" separation; P's stored record | Baseline record stored in the terminal result; it never changes the run status; C4 refuses `MP_COMBINED_BASELINE_FAILED`. |
| 7 Engine-hash closure | P (wide manifest) plus A's Python traversal test | A's narrow file list is incomplete against real imports. |
| 8 Executor | Merge: claim by RUNNING (both); P's `sweep`; A's one process per step; injected runner | Simplest protocol that fits the store; sweep is code, not a manual DB write. |
| 9 Oracle input | Signals (both drafts agree) | Stricter than MPC 5.6 wording; record as a root clarification. |
| 10 Fixtures | P (6,000 bars, M2 EMA 34/250) with A's pinned signal counts | P's arithmetic is right; A's split is off by one. |
| 11 Result storage | P shape (hashes, counts, baseline record) with A's `ledger_hash` per candidate | Fits the 1 MiB result; full traces are an owner question. |

## 1. Verification of named claims

### 1.1 Opus risk #1: `validate_custom_snapshot` picks the membership row by source hash only

Verdict: TRUE as stated; the consequence is a fail-closed false refusal, not silent use of the wrong inputs.

Evidence:

- `quant_lab/src/robot_quant/spt_custom_evaluator.py:90`:
  `membership = next((row for row in snapshot.get("membership", []) if row.get("source_hash") == SOURCE_HASH), None)`.
  The match key is `source_hash` only.
- A member deployment's `snapshot.membership` holds every connected member, not only its own row:
  `src/multi-pine/member-set.js:160` (`membershipProjection` maps all members to
  `{pine_import_id, source_version, source_hash, analysis}`), `:268` and `:281` (each member deployment's
  `snapshot.membership` must equal that full projection, else `MP_MEMBER_SET_STALE`). The order is ascending
  `pine_import_id` (`member-set.js:159`).
- Under fixture Option A (MPC 11.2) both rows carry the same `source_hash`, so `next(...)` returns member 1's row for
  member 2's snapshot too.
- What then happens for member 2: the review check at `spt_custom_evaluator.py:94-103` passes (member 1's review is
  valid); the identity check at `:104-106` passes (same source, same 58 input ids); the value check at `:107-111`
  compares member 2's `selection` effective values with member 1's analysis and raises `CUSTOM_EFFECTIVE_INPUT_CHANGED`,
  because Option A requires different effective inputs (and equal inputs would be `MP_MEMBER_DUPLICATE_LOGIC`).
- The signal inputs themselves come from the snapshot's `selection` (`:122`, `:130`), not from the membership row, so a
  wrong row can never produce wrong signals; it can only refuse.

So the hazard is real and blocks every Option A run that calls `validate_custom_snapshot` on the unprojected member
snapshot. P's fix (project `membership` to the member's own row by `pine_import_id` and `source_version` before the call,
with no edit to the module) is correct and needed. The Node mirror is not affected: `member-admission.js:126-139` checks
the member's own `pine_source_revisions` row, never `snapshot.membership`. A does not hit the hazard only because its job
never calls `validate_custom_snapshot` (section 2.1 explains why that is a loss).

### 1.2 Other claims checked and true

| Claim | Draft | Evidence |
| --- | --- | --- |
| `PaperState` is the incremental form of `paper_replay` with an identical per-intent body | P fact 1 | `paper_state.py:67-202` against `bridge_paper.py:83-218`; equivalence is already tested in `quant_lab/tests/test_research_chunk.py:118-142` (5 policy variants, record lists equal). |
| `BridgeReplay.step` emits EXITs (descending traversal) then at most one BUY, suppression per instance | both | `bridge_replay.py:153-183`; BUY `sequence` is always 0 (`:182`). |
| `entry_ref` is `<deployment_id>:<time>:0` | both | `bridge_replay.py:180`. |
| Node ledger: streak changes only when the symbol position reaches zero | both | `src/postgres/ledger.js:248-253`; the one-Pine oracle mirrors it (`scripts/quant-bridge-reference.mjs:59`). |
| `runQuantProcess` always uses `systemd-run` on Linux; non-Linux refused unless a test flag | P fact 7 | `src/quant-research/process-supervisor.js:67`, `:104`; 30 s cap `:68`; 8 MiB request `:75`; 2 MiB response `:239`. This container has `/usr/bin/systemd-run` but no user bus ("Failed to connect to bus"), so the call cannot work here. |
| Run store: RUNNING after RUNNING is refused; FAILED, CANCELLED, TIMED_OUT carry a reason and no result; SUCCEEDED and NO_VALID_CANDIDATE carry a tied result at most 1 MiB | both | `mp-run-store.js:56` (EDGES), `:134-157`; `mp-run-store.sql:134`, `:271-345`. Concurrent RUNNING appends collide on the event key, retry, then fail the transition guard (`mp-run-store.js:310-333`). |
| JS `canonical` writes numbers with `JSON.stringify` | P fact 9 | `src/pine-bridge/source.js:6-10`. Python `ql3a.canonical` (`ql3a.py:45-46`) also uses default `ensure_ascii=True`, so any cross-language hash must stay ASCII and float-free, as P says. |
| Ledger start formula `first_time + warmup * 60000` | P D3 | `research_chunk.py:291`. |
| Split formula | P D10 | `run-contract.js:123` (`train_end = warmup + floor(0.6 * count)`, `validation_end = warmup + floor(0.8 * count)`). |
| Evaluation cap `planned + 2 * dims + 2 + 3` | P D5 | `src/postgres/quant-research.js:136`. |
| One-Pine worker slices holdout bars out of selection steps | both | `quant-research-worker.js:14-15`. |
| Set `policy_hash` comes from the member snapshots and all members must agree | P 9.2 | `member-set.js:180`, `:298`, `:313`. |
| Existing closure tests walk only named roots, so new modules cannot enter an existing closure by traversal | P 8.2 | `test/quant-engine-files.test.js:13-14` (four Node roots), `:52-63` (five Python roots). |
| RS-5 injects `engineHash` from the constructor | both | `src/multi-pine/fixture-service.js:132-139`. |
| `supported_source_hash` is configuration in RS-5, and admission hashes the stored source bytes | context | `member-admission.js:133`; `fixture-service.js:138`. |
| The tracked SPT file is not the reviewed source | P fact 6 | `tradingview/spt_pro_v4_robot_trade.pine` hashes to `48528f49...`; `spt_evaluator.py:13` pins `0be2c64c...`. |

### 1.3 Claims the code contradicts

| # | Draft | Claim | What the code says | Weight |
| --- | --- | --- | --- | --- |
| C1 | A D-13 | The narrow `MP_ENGINE_FILES` list is the Python import closure of `mp_combined_engine`, kept complete by a traversal test. | The list omits modules the listed files import. `analytics.py:11` imports `contracts`; `ql3a.py:16` imports `ql2a`; `ql2a.py:21-23` import `spt_checkpoint` and `spt_repaint`; the `TYPE_CHECKING` block of `__init__.py` imports `backtest`, `contracts`, `market_data`, `optimizer`, `records`, `risk_preview`, `strategy`, `validation`, and its comment says these imports exist to keep those modules "inside the engine-hash import closures". The traversal regex A cites (`quant-engine-files.test.js:57`) matches indented imports, so A's own completeness test fails on A's own list. Node side: the executor imports `src/postgres/mp-run-store.js` and `src/quant-library/package-gates.js` (via `src/multi-pine/codes.js:1`); neither is listed. | High: the closure as written does not pin what runs. |
| C2 | A D-16 | 4,000 bars, warm-up 1,006 give split 1,796 / 598 / 600. | `run-contract.js:123` gives train 1,796, validation 599, test 599 (2,802 and 3,401 cut points). | Low (arithmetic). |
| C3 | A D-6 | `_apply` "is a copy of `bridge_paper.py:95-209`" and one `localcontext` for the whole run makes the copy safe. | Statement is consistent with code, but it duplicates the money path a third time (`bridge_paper.py`, `paper_state.py`, new file) while `PaperState` already exists with a tested equivalence. Not a contradiction of fact; a contradiction of A's own goal of no drift. | Medium (design). |
| C4 | P D7 | `src/pine-bridge/contract.js` is in the expected multi-only set "not in the runtime manifest or SHARED_APPLICATION_FILES". | `test/helpers/runtime-shared-boundary.js` lists `src/pine-bridge/contract.js` (and `src/money.js`, `src/pine-bridge/source.js`, `src/postgres/ledger.js`) as shared files. Under P's own rule it would be excluded. P hedges ("the test computes the real set"). Section 2.7 resolves it. | Low. |
| C5 | P D6 | Baseline failure ends the run NO_VALID_CANDIDATE with `completion_reason: MP_COMBINED_BASELINE_FAILED`, and C4 then refuses `MP_COMBINED_BASELINE_FAILED`. | MPC 8.2 gives the code stage C4. MPC 6.3 (B0) and RD-MP-10 require "the completion reason must still be the one that derives G7 PASS" (`RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`). A run with completion reason `MP_COMBINED_BASELINE_FAILED` is refused at B0 or G7 before C4, so the C4 code can never fire; F20 also says a NO_VALID_CANDIDATE run gives "no package". | Medium: P's outcome makes the contract's C4 code dead. |
| C6 | P D1 / D9 | Events and decisions carry `ordinal` and `deployment_id`, removed by `one_pine_view` for T-P1. | Not a code contradiction, but MPC 5.4 asks for byte equality "on canonical output"; a projection is a filter on that output. A shows the tags are derivable from `entry_ref` (`bridge_replay.py:180`), so the widening is unnecessary. | Medium (test strength). |
| C7 | A D-10 | The oracle "is evidence, not the engine", so the executor never runs it; C4 reads the result. | A stores nothing C4 could read (A's result has no baseline record), so C4 would have to rerun the oracle outside the run, and rerunning HOLDOUT for traces (A D-17) is a second holdout evaluation (worker rule `quant-research-worker.js:14`, PKG 5.0 item 5). | Medium: gap, not a false statement. |
| C8 | P 2.2 | One member snapshot's `policy` is enough for all members. | True, because `member-set.js:298` forces equal `policy_hash` across members; listed here only to close A's alternative of reading the Bot policy again, which is also correct but redundant with the freshness check. | None. |
| C9 | P D9 / 7.2 | `intent_stream_hash` is cross-language safe because the schema has no floats; a differing hash fails the baseline. | The schema carries `sl` and `tp` as decimal strings. Python renders them with `str(Decimal)` (`bridge_paper.py:96-97`); the Node oracle renders `exact(...)` (`src/pine-bridge/contract.js:10`, `src/money.js:13-16`, `toFixed`). The two agree on the cases tried here (`98.25`, `98`, `100`), but nothing pins Python `str` to `toFixed` form for every value, and the one-Pine oracle feeds `levels` with `Number(...)` (`scripts/quant-bridge-reference.mjs:20`). `ql2a.compare_replays` compares `sl`/`tp` as `Decimal` (`ql2a.py:180-182`), not as strings. | Low to medium: a false baseline failure, never a false pass. |

No other claim in either draft was found false. Claims about MPC sections were checked against
`docs/MULTI_PINE_CONTRACT.md` 3.4 to 6.3, 8.2, 11 and 14 to 15.

## 2. Judgement per area

### 2.1 Input and output shape

Both drafts agree on the core: per-member boolean signal pairs plus one shared pair, members carry no pair (T-P3), bars
built with the frozen market `atr14` (`research_engine.py:42-45`). They differ in three places.

1. What the job receives per member. P sends source text plus the member snapshot, projects `membership`, and runs the
   unchanged one-Pine gate `validate_custom_snapshot` before `evaluate_bars`. A sends only the ten `CATALOG` values that
   Node extracted from `pine_source_revisions.analysis.inputs` and never checks the source in Python.
   Pick P. Reasons: (a) MPC 11.4 item 2 requires the source-bound evaluator, and RD-MP-23 shows `supported_source_hash`
   is configurable (`fixture-service.js:138`), so under A a fixture admitted with any configured hash (for example the
   tracked `48528f49...` file) would run the SPT Python evaluator against a source it was never proven equivalent to,
   and nothing in the evaluating process would notice; under P `validate_custom_snapshot` refuses with
   `UNSUPPORTED_SOURCE_HASH` (`spt_custom_evaluator.py:74-75`). (b) The one-Pine job runs the same gate in-process
   (`research_engine.py:26` through `CustomOptimizationPlan.from_snapshot`), so P keeps parity. (c) The cost is the
   private-source dependency for job-level tests, which exists anyway because admission hashes the stored source bytes
   (`member-admission.js:133`). Library-level tests stay source-free, as the existing tests do
   (`test_research_chunk.py:66-71` monkeypatches only source enrollment).
2. Output shape. P widens every event and decision with `ordinal` and `deployment_id` and needs a projection for T-P1.
   A returns `ledger` (exactly the seven `paper_replay` keys, `bridge_paper.py:210-218`) and a sibling `diagnostics`.
   Pick A. The per-fill tag MPC 5.7 and 6.2 require is derivable without widening: `entry_ref.rsplit(":", 2)[0]` is the
   deployment id (`bridge_replay.py:180`) and `diagnostics.members` maps deployment id to ordinal. The package writer
   (R6) derives it and must assert every prefix maps to exactly one member.
3. Function name and member count. MPC 5.4 names `combined_paper_replay(members, bars, shared_pair, model, policy,
   capital)`. Pick A's name and A's rule that the library accepts 1 to 3 members (one member for T-P1); the job refuses
   fewer than 2 or more than 3 with `MP_INPUT_INVALID` (defence in depth; the set builder already refuses with
   `MP_NOT_MULTI_PINE` and `MP_MEMBER_COUNT_EXCEEDED`). Drop P's separate `combined_replay_single`.

Merged job protocol: P's `mp-combined-request-v1` (closed keys; `run` echo; market; model; policy; capital; split;
`first_time`; members with `ordinal`, `deployment_id`, `pine_import_id`, `source_version`, `source_hash`,
`effective_inputs_hash`, `source`, `snapshot`; rows; and P's checks 1 to 6), changed to one `step` per call (section
2.8) instead of a `steps` batch, and with no `page` field (section 2.6). Response per step: A's fields (`parameters`,
`kind`, `train`, `validation`, `test` for HOLDOUT only, `decision_count`, `fills`, `rejections`, `exit_fill_reasons`,
`diagnostics`, `ledger_hash`) plus P's `member_signals` (`signals_hash`, native counts). The HOLDOUT response alone also
carries the full `ledger.events` and `ledger.decisions` for the baseline. Errors leave the process as a short upper-case
code only (`fixed_eval` driver pattern, as both drafts say).

### 2.2 Ledger semantics

Both drafts give the same scope table, and the code confirms it:

- Per Bot: cash, committed cost, position quantity, position `initial_risk` and `pnl` (reset at Bot flat), loss streak
  (moves only at Bot flat), the daily map (trades count BUY and EXIT fills), `open_positions = int(quantity > 0)`.
  Evidence: `paper_state.py:120-186`; Node `ledger.js:71`, `:248-253`, `:277`; MPC 5.4.
- Per member: Pine entry arrays, 1,000-entry capacity, descending EXIT traversal, BUY suppression (one `BridgeReplay`
  per member, `bridge_replay.py:144-183`; MPC 5.3).
- Per allocation: one map keyed by `entry_ref`, owner derivable from the key.

Mechanism. P subclasses `PaperState` and replaces `self.replay` with a merged replay; A copies the per-intent body into
a new `_apply`. Pick P. `PaperState` already carries a tested equivalence to `paper_replay`
(`test_research_chunk.py:118-142`), the subclass touches no money statement, and A's copy would be the third copy of
the ledger body (C3). The subclass depends on two names of `PaperState` (`self.replay`, `self.replay.step(...)`,
`paper_state.py:73`, `:86`); `paper_state.py` is in the runtime manifest (`runtime-engine-files.js:15`), so any change
rotates the multi closure hash and re-runs T-P1. One wording deviation: MPC 5.4 says each allocation "stores its owning
`deployment_id`"; `PaperState.Allocation` stores quantity and entry price only (`paper_state.py:61-64`). The owner is
encoded in the key and the guard below checks it, which meets the intent; root should record that reading (section 3,
row RD-MP-25).

Cross-target guard. P raises `MP_CROSS_SOURCE_TARGET` in the merged replay when an intent's `entry_ref` prefix is not
its producing member's deployment id; A raises at the ledger when the found allocation's owner differs. Both are
structurally unreachable with real `BridgeReplay` instances. Pick P (before the ledger, so nothing is half-applied) plus
the counter that must stay 0 (both) and a forged-producer test (both).

Duplicate intents (F9). P drops an exact repeat of `(deployment_id, event_type, entry_ref)` and counts it; A relies on
distinct `entry_ref` values. A real `BridgeReplay` cannot repeat a BUY ref (strictly increasing times,
`bridge_replay.py:156-157`) or an EXIT ref (the entry is popped, `:167`). Keep P's drop-and-count so F9's "0 extra
effects" holds for a forged producer, and make a non-zero count on any executor step a run failure
(`EVALUATION_FAILED`), so the drop can never hide a defect in a real run.

Same-bar order and reduce-only EXIT: identical in both drafts and correct. Step every member's `BridgeReplay` in ordinal
order first (intent generation reads no ledger state, `bridge_replay.py:1-5`), then all EXITs by ordinal in each
member's own order, then BUYs by ordinal (MPC 5.5). EXIT signals carry `reduceOnly: true` and `targetTradeId`
(`paper_state.py:105`, `:119`), so entry guards never block them (`risk_evaluator.py`, as both cite).

### 2.3 Warm-up

Identical in both drafts; adopt as written. Floor `max over members of max(1006, 5 * emaSlowInput)` (RD-MP-20,
`member-admission.js:147`), all members and replays cold-start at row 0, one ledger start
`first_time + warmup * 60000` (`research_chunk.py:291`), pre-start intents kept in `events` and skipped by the ledger
(`paper_state.py:91-92`). Per-member start times are rejected (P's reason: one cash balance; and they would break T-P1).

### 2.4 T-P1 byte identity

P: `canonical(one_pine_view(combined_replay_single(...))) == canonical(paper_replay(...))`, with a pinned whitelist of
removed keys. A: `canonical(combined_paper_replay([m], ...).ledger) == canonical(paper_replay(...))` with no branch and no
projection.

Pick A's method on P's mechanism. Because the merged output keeps the seven `paper_replay` keys unchanged (2.1), the test
is a plain byte comparison of the whole ledger dict, and no projection can hide a difference. Keep from P: the four
cases (M1 inputs, M2 inputs, a scripted series with caps, rejections, a loss-streak pause, a daily refusal and an
orphan exit, and the STRESS model) and equality of `mark_period` metrics. Keep from A: the fixture dataset at several
pairs, the SHA-256 equality (T-P5), and the mutation check (remove the ordinal sort; T-P1 must still pass and a
two-member order test must fail), which proves the order rule, not a branch, carries the one-member case. Canonical form:
`ql3a.canonical` (`ql3a.py:45-46`), the existing Python form; do not introduce a second one.

### 2.5 Candidate search

Both drafts define the same plan: a new pure `multiCandidatePlan` over the decimal-string `bridge_domains`, baseline
pair first, index neighbours per axis in sorted name order, exhaustive when `combinations <= budget`, else the same LCG
(`contract.js:91-95`), no `validParameters` filter (it compares EMA inputs, `contract.js:69-72`), plan derived from the
stored contract, `plan_hash` in the result; selection, screen, coverage, sensitivity, stress (factor 2,
`research_engine.py:47-52`) and one holdout as `QuantResearchWorker.run` (`quant-research-worker.js:102-138`).

Pick P. It adds what A lacks: the evaluation cap `planned + 9` mirroring `quant-research.js:136` (RD-MP-18 deferred the
cap to "the plan slice"), refusal past it with `EVALUATION_BUDGET_EXCEEDED`, and a parity test against `candidatePlan`
on an equivalent numeric grid. File name: P's `src/multi-pine/candidate-plan.js` (A's `run-plan.js` is equally good;
one must be chosen).

### 2.6 Baseline-failure handling

The drafts mix two questions. A is right that there are two different baselines: the screening baseline (row 0's
validation return, `quant-research-worker.js:110`, `contract.js:103-108`) and the combined Quant baseline (MPC 5.6,
parity against the Node oracle). A failure of the first is a research outcome (NO_VALID_CANDIDATE). A failure of the
second is an engine defect signal whose contract code `MP_COMBINED_BASELINE_FAILED` has stage C4 (MPC 8.2).

P stores the parity record but turns a mismatch into NO_VALID_CANDIDATE with completion reason
`MP_COMBINED_BASELINE_FAILED`. That makes the C4 code unreachable (C5) and mixes a defect into an outcome. A keeps the run
status clean but stores nothing C4 can read, and regenerating traces by rerunning HOLDOUT would evaluate the holdout a
second time (C7).

Merged ruling:

1. The executor runs the oracle once, in Node, after the single HOLDOUT step, on the HOLDOUT step's own trace (rows
   `0..test_end`, the decisions the HOLDOUT process already produced). This covers the whole range including the holdout
   fills that the package's `trades.csv` and `decisions.csv` will show, and it adds no second Python evaluation of the
   holdout. It replaces P's extra BASELINE kind over `0..validation_end` and P's paging. A fixture run produces a few
   hundred decisions, far below the 2 MiB response cap; a larger trace fails `EVALUATION_OUTPUT_TOO_LARGE` rather than
   paging.
2. The record `mp-combined-baseline-v1` (P 7.3: pair, range, counts, hashes, `differences`, maximum per-entry cash delta,
   final deltas, `matched`) goes into the terminal result as `combined_baseline`.
3. The record never changes the run status or `completion_reason`; those follow the search exactly as the one-Pine
   worker does.
4. C4 (R6 slice) refuses `MP_COMBINED_BASELINE_FAILED` (non-retryable) when `combined_baseline` is missing, not tied to
   the run's `contract_hash` and selected pair, or `matched` is false.
5. No baseline runs when no candidate reaches HOLDOUT; such a run is NO_VALID_CANDIDATE and has no package (F20).
6. Failure conditions: P 7.2, with decimals compared as decimals (C9) and `intent_stream_hash` used as an identity
   inside each language only, never as a cross-language pass condition.

### 2.7 Engine-hash closure scope and proof that existing closures do not change

P: wide closure, `QUANT_RUNTIME_ENGINE_FILES` plus multi-only files and their audited Node import closure, version inside
the hash (the FE-2a pattern, `quant-fixed-eval-engine.js:12-26`). A: narrow list of what the multi run executes.

Pick P. A's list is incomplete against real imports (C1), and the wide manifest is the accepted precedent for a
side-by-side closure. Take A's idea of a Python traversal test from `mp_combined_job` (use the FE-2a traversal,
`test/fixed-eval-engine.test.js` `pythonClosure`, which also handles `from robot_quant import x`).

Shared files (C4). The runtime shared boundary (`test/helpers/runtime-shared-boundary.js`) exists so runtime roots may
import application files without hashing them. The multi closure should not inherit that exemption for the files the
multi run decides money with. Ruling: `MP_COMBINED_ONLY_FILES` lists the new files plus every file in the Node import
closure of `executor.js`, `combined-oracle.js` and `candidate-plan.js` that is not already in
`QUANT_RUNTIME_ENGINE_FILES`, shared files included (expected: `src/money.js`, `src/pine-bridge/source.js`,
`src/pine-bridge/contract.js`, `src/postgres/risk.js`, `src/postgres/pine-bridge-execution.js` and its imports,
`src/multi-pine/codes.js`, `member-set.js`, `run-contract.js`, `src/postgres/mp-run-store.js`,
`src/quant-library/package-gates.js`); the closure test computes the set and fails on any unlisted import.

Proof that existing closures do not change: adopt P 8.2 items 1 to 3 (static absence from LEGACY, FOUNDATION,
INGESTION, PF2 engine, PF2 evaluator, runtime and FE-2a lists; `QUANT_IO_MODULES` unchanged; no runtime root imports
the new modules; before/after equality of the six closure hashes recorded in the final pass; empty intersection of the
diff with every existing list). These hold by construction because every existing list is an explicit array and the
existing traversals start from fixed roots (`quant-engine-files.test.js:13-14`, `:61`). The W4 test
(`quant-engine-files.test.js:65-73`) must pass unchanged.

### 2.8 Executor

Agreed in both drafts and correct against the store: a new `MultiPineFixtureExecutor.execute({owner_id, run_id})`,
config only from the constructor, `getMultiRun` first, claim by appending RUNNING (the transition guard is the only
mutual exclusion, `mp-run-store.js:56`, `mp-run-store.sql:311-345`), read-only materialisation with every hash bound in
Node (dataset by `CONTENT_DIGEST_SQL`, `research-contract-v2.js:21-27`; each member's source row and snapshot against the
contract; policy from the snapshot against `policy_hash`), engine hash and member-set freshness re-checked before every
step and before the terminal append, terminal result validated before the write, allowlisted reason codes, no lease, no
step table, no route; the RS-3 static isolation test gains exact allowlist entries.

Differences and picks:

1. Crash recovery. P: `sweep({owner_id, run_id})` appends TIMED_OUT `JOB_DEADLINE_EXCEEDED` once the deadline has passed.
   A: the operator appends FAILED by hand. Pick P. It is a few lines of tested code, uses the worker's existing code
   (`quant-research-worker.js:39`), and avoids ad hoc writes to an insert-only store. A crashed run stays RUNNING at most
   until its deadline (at most 900 s, `mp-run-store.sql:102`). `sweep` is a method the operator script and tests call;
   no background loop.
2. Cancellation. Adopt both: an abort signal ends the run CANCELLED `RESEARCH_INTERRUPTED` (P), and before each step the
   executor re-reads the last event and stops without writing if an operator already appended a terminal event (A).
3. Process granularity. P batches up to 10 steps per Python call and shares member signals; A runs one process per step
   like the one-Pine worker. Pick A. It keeps the worker's request and response checks
   (`quant-research-worker.js:82-89`), makes holdout isolation a slice of rows per call, and removes batch partial-failure
   handling. Cost: member signals are recomputed per step. With the merged fixture (6,000 bars, about 25 candidates plus
   at most 4 sensitivity, 1 stress, 1 holdout) that is about 31 calls. S1 must measure one 3-member call on 6,000 and on
   10,000 bars and record it (P RQ-5). If the total does not fit the run deadline, lower the fixture budget; do not
   change the protocol or raise the deadline.
4. Runner. P: `runQuantProcess` (systemd) in the operator script plus a test-only direct-spawn helper. A: the executor
   spawns Python directly. Pick P's injection (the executor takes `runEvaluator(payload, signal)` from config) with one
   direct-spawn runner, `src/multi-pine/python-runner.js`, copying the `pythonEvaluation` limits
   (`quant-research-worker.js:12-32`: 8 MiB request, 2 MiB response, timeout at most 30 s and at most the deadline left,
   stderr discarded, `PYTHONPATH` set). Reason: MPC 11.1 makes F11-01 local only, `runQuantProcess` cannot run in this
   container or on a non-Linux owner machine (section 1.2), and the legacy one-Pine worker already uses direct spawn. The
   operator script refuses to start unless an explicit isolated-cluster flag and a fixture-role connection are given.
   A `runQuantProcess` runner is a later option for a Linux host with user systemd and is not needed for F11-01.
5. `MP_MEMBER_NO_SIGNALS` timing. A checks after the first CANDIDATE step; P after all CANDIDATE steps. Pick A: signals
   do not depend on the pair, so the first step already knows, and later calls are wasted. Count on rows
   `warmup..validation_end`; the window itself is owner question OQ-C (section 4).

### 2.9 Oracle input

Both drafts feed the oracle member signals, not Python's intents, and let the oracle regenerate intents with production
`levels`, `exitDecision`, `executionPrice` (`src/pine-bridge/contract.js`) and decide with `evaluateRisk`
(`src/postgres/risk.js`) and `roundBridgeOrder` (`src/postgres/pine-bridge-execution.js:43`), keeping
`prepareBridgeExecution` untouched. Adopt. It is stricter than MPC 5.6's wording ("feeds the same ordered intents")
because an ordering defect in Python cannot be copied into the oracle; root records it as a clarification of 5.6. The
comparison then requires the oracle's event list to equal Python's event list field by field (A) as well as P's
decision conditions.

Location: P's pure module `src/multi-pine/combined-oracle.js` (the executor must call it in process, section 2.6), not
A's stdio script. One-member output of the module must equal `scripts/quant-bridge-reference.mjs` `replay` on the same
input (P); that script is not edited. The comparison function (`compareCombined`) lives in the same module, ported from
`ql2a.compare_replays` (`ql2a.py:157-200`) and extended with per-member funnel counts and the zero counters, with one
parity test that runs the Python `compare_replays` and the port on the same one-member pair.

"Isolated PostgreSQL cluster" (MPC 5.6, 15.3). P runs T-O1 inside the PostgreSQL test process and adds one ledger
anchor through the real `recordExecution`; A says the oracle needs no database. Recommend P's anchor as a separate S2
test file: it is the only check that the oracle's Bot-level rules match `ledger.js` when two members' fills interleave.
Root may drop it if the fixture needs any production-code change (P RQ-2).

### 2.10 Fixtures

Pick P's plan (`test/fixtures/mp-combined/`, 6,000 synthetic closed bars, generator script with a fixed seed, pinned
SHA-256, `atr14` from the project's existing `closed-ohlcv-atr14-v1` derivation, M1 SPT defaults, M2 EMA 34/250 with
other catalog changes, M3 equal to M1 for F15, a zero-signal M2 variant for F29, Option B scripted vectors, private
inputs referenced by hash only). Reasons: P's numbers are right (floor 1,250; compared 4,750; split 2,850 / 950 / 950,
`run-contract.js:123`); A's split is off by one (C2) and A's 600-bar test segment leaves little room for the 5-trade test
rule (`contract.js:6`). Take from A: the test pins each member's native BUY and exit counts so a generator change is
visible, and the explicit per-case cash and limit settings for F3, F4, F7, F8 and F13 (A D-16). Keep P's signal floor
(at least 15 native BUY per member in each of train, validation and test); tune the generator, never the gates.

### 2.11 Result storage

Both drafts store one terminal event with metrics and counts only, within the 1 MiB limit
(`mp-run-store.sql:134`). Merge the fields: P's result (run ties, `owner_recommendation_ready: false`,
`acceptance_blockers` from the contract, `evaluator`, `closure {version, hash}`, `search {algorithm, seed, budget,
planned, grid_combinations, plan_hash, coverage}`, `candidates`, `selected`, `holdout_evaluated`, `completion_reason`,
`member_signals`, `funnel` for the selected pair, `combined_baseline`) plus A's per-candidate `ledger_hash`, top-level
`engine_hash`, `same_bar_order` and `fixture: true`. P's validator before the write stays.

Full traces. P stores none and leaves it to R6; A proposes regeneration by rerunning HOLDOUT, which would evaluate the
holdout a second time (C7). Recommend (root-decidable): the terminal result also stores the selected pair's HOLDOUT
`decisions` list (each decision already carries `entry_ref`, from which R6 derives the member tag). At fixture scale
this is tens to low hundreds of KiB. If the canonical result would exceed 1 MiB the executor ends the run FAILED
`EVALUATION_OUTPUT_TOO_LARGE`; no regeneration path exists. This keeps the research evidence immutable at write time.

## 3. Merged proposed rows (paste-ready)

Rows continue the MPC section 14 table. "Proposed" until root records them; RD-MP-24 to RD-MP-33 replace both drafts'
row sets.

| ID | Item | Outcome |
| --- | --- | --- |
| RD-MP-24 | Combined evaluator interface (RS-6, R5) | `combined_paper_replay(members, bars, shared_pair, *, model, policy, equity, cash, broker, symbol, start_time, same_bar_order)` in new `quant_lab/src/robot_quant/mp_combined_paper.py`. `members` are 1 to 3 frozen `MemberSignals{ordinal, deployment_id, signals}` in dense ascending ordinal with distinct deployment ids; `shared_pair` is one frozen `BridgePair{atr_multiplier, rr}`; no member carries a pair (T-P3). The function returns `ledger` with exactly the seven keys of `paper_replay` and their record shapes unchanged, and a separate `diagnostics` object (per-member funnel counts that sum to Bot counts, `cross_source_target`, `duplicate_intents`, `same_bar_order`). Per-fill and per-decision member tags are derived from the `entry_ref` prefix and the `diagnostics.members` map; ledger records are never widened. An unsupported `same_bar_order` raises `MP_EVENT_ORDER_UNDEFINED`. No one-Pine module is edited. |
| RD-MP-25 | Combined ledger (R5) | The ledger subclasses `PaperState` and replaces its replay with a merged replay of one `BridgeReplay` per member; no ledger statement is copied or edited. Per Bot: cash, committed cost, position quantity, position `initial_risk` and `pnl` (reset when the Bot position is flat), loss streak (moves only at Bot flat), the UTC-day daily map (trades count accepted BUY and EXIT of every member), `open_positions = int(quantity > 0)`. Per member: Pine entry arrays and capacity, descending EXIT traversal, BUY suppression. Allocations are one map keyed by `entry_ref`; the owning `deployment_id` is the key prefix (root reading of MPC 5.4 "each allocation storing its owning `deployment_id`"). The merged replay raises `MP_CROSS_SOURCE_TARGET` before the ledger when an intent's `entry_ref` prefix is not its member's deployment id, and drops and counts an exact repeat of `(deployment_id, event_type, entry_ref)`; both counters must be 0 on every executor step, else the run fails `EVALUATION_FAILED`. Spot, `paper-close-v1` and reduce-only EXIT only. |
| RD-MP-26 | Same-bar order and warm-up | Per bar: step every member's `BridgeReplay` in ascending ordinal, then apply all EXITs by ordinal in each member's own traversal order, then BUYs by ordinal (`exit-first-ordinal-v1`); events, decisions and fills in processing order; per-member `sequence`. One `warmup_bars` at least the maximum member floor `max(1006, 5 * emaSlowInput)`; every member evaluator and replay cold-starts at row 0; one ledger start `first_time + warmup * 60000`; pre-start intents stay in `events` only. |
| RD-MP-27 | One-member equivalence (T-P1, F16) | `canonical(combined_paper_replay((m,), ...).ledger) == canonical(paper_replay(...))` byte for byte with `ql3a.canonical`, with no member-count branch and no projection, on: M1 inputs and M2 inputs over the fixture bars at several pairs, a scripted series with caps, rejections, a loss-streak pause, a daily-limit refusal and an orphan exit, and the STRESS model; `mark_period` metrics and SHA-256 equal; a mutation that removes the ordinal sort must leave T-P1 passing and fail a two-member order test. |
| RD-MP-28 | Job protocol | New `robot_quant.mp_combined_job`, stdin `mp-combined-request-v1` with closed keys, one step per process (CANDIDATE, SENSITIVITY, STRESS on rows `0..validation_end`; HOLDOUT alone on rows `0..test_end`). Per member it receives source text and the deployment snapshot, replaces `snapshot.membership` by the member's own row (matched by `pine_import_id` and `source_version`; zero or two rows is `MP_INPUT_INVALID`) and then runs the unchanged `validate_custom_snapshot`, because that function selects the membership row by source hash only and Option A members share one; non-empty `selection.bindings` is `MP_SOURCE_SLOTS_FORBIDDEN`. 2 to 3 members, else `MP_INPUT_INVALID`. Response `mp-combined-step-v1`: metrics per `mark_period`, counts, rejections, exit reasons, `diagnostics`, `member_signals` (`signals_hash`, native counts), `ledger_hash`; the HOLDOUT response also carries the full ledger events and decisions and each member's signal vector. Errors leave the process as a short upper-case code only. Node binds every hash; the job only echoes `run`. |
| RD-MP-29 | Candidate search | New pure `multiCandidatePlan` in `src/multi-pine/candidate-plan.js`: the `candidatePlan` algorithm on grid indexes over decimal-string `bridge_domains` (baseline pair first, neighbours per axis in sorted name order, exhaustive if `combinations <= budget`, else the same seeded LCG, same algorithm labels, `INSUFFICIENT_DIMENSION_BUDGET`), no `validParameters` filter, parity-tested against `candidatePlan`; derived from the stored contract only, `plan_hash` in the result; evaluation cap `planned + 9`, refusal `EVALUATION_BUDGET_EXCEEDED`. Selection, screen against row 0, 100% coverage, sensitivity, stress (fee and slippage x2) and one HOLDOUT follow `QuantResearchWorker.run` with the frozen `rules`; one pair object per step for all members. |
| RD-MP-30 | Combined Quant baseline (R11) | After the single HOLDOUT step, the executor runs the pure Node oracle `src/multi-pine/combined-oracle.js` on the HOLDOUT step's bars, member signals, pair, model, policy, capital and ledger start. The oracle regenerates intents from signals with production `levels`, `exitDecision` and `executionPrice`, orders them by `exit-first-ordinal-v1`, decides with `evaluateRisk` and `roundBridgeOrder` and keeps Bot state by the Node ledger rules (root clarification of MPC 5.6: signals in, so the intent order is checked independently). Pass needs: equal event lists; accept, cap and reject equal on every decision; allocation target mismatches 0; quantity difference 0 venue steps; equal fees; price within 0 ticks; per-entry and final cash within 0.01 USDT; equal open allocations and per-member funnel counts; both zero counters 0. Decimals compare as decimals; hashes are identities within one language only. The record `mp-combined-baseline-v1` (pair, range, counts, hashes, differences, maximum deltas, `matched`) is stored in the terminal result as `combined_baseline` and never changes the run status or `completion_reason`. C4 refuses `MP_COMBINED_BASELINE_FAILED` (non-retryable) when the record is missing, not tied to the run and selected pair, or not matched. One-member oracle output equals `scripts/quant-bridge-reference.mjs` `replay`; that script, `prepareBridgeExecution` and the ledger are not edited. |
| RD-MP-31 | Engine hash for multi runs (R12) | New `src/multi-pine/engine-closure.js`: `MP_COMBINED_CLOSURE_VERSION = "mp-combined-closure-v1"`; `MP_COMBINED_ENGINE_FILES` = `QUANT_RUNTIME_ENGINE_FILES` plus `MP_COMBINED_ONLY_FILES` (the new Python and Node files and every file in the Node import closure of the executor, oracle and plan that is not in the runtime manifest, shared application files included); hash `hash(canonical({version, files}))` as FE-2a. The run contract's `engine_hash` and the RS-5 injected value are this hash. A closure test pins: the Python traversal from `mp_combined_job` and the Node traversal from the new modules stay inside the list; no new file is in LEGACY, FOUNDATION, INGESTION, PF2 engine, PF2 evaluator, runtime or FE-2a lists; `QUANT_IO_MODULES` unchanged; no runtime root imports a new module; a changed byte rotates the hash and a missing file fails closed. The final pass records the six existing closure hashes at base and head and requires equality, and the diff must not intersect any existing list. |
| RD-MP-32 | Executor (R7) | `MultiPineFixtureExecutor` in `src/multi-pine/executor.js`, constructor config only (fixture-role db, Store on the same db, Bot-state reader, clock, `runEvaluator`, `engineHash`, call timeout at most 30 s). `execute({owner_id, run_id})`: `getMultiRun`; ADMITTED required, else return without writing; deadline (TIMED_OUT `JOB_DEADLINE_EXCEEDED`); engine hash (FAILED `QUANT_ENGINE_CHANGED`); member-set freshness (FAILED `MP_MEMBER_SET_STALE`); claim by appending RUNNING (the transition guard is the only lease); read-only materialisation with all hash binding in Node; plan; one Python process per step; `MP_MEMBER_NO_SIGNALS` after the first CANDIDATE step; deadline, engine hash, freshness and the last event re-checked before every step and before the terminal append; terminal result validated, including `combined_baseline` when a holdout ran and the selected HOLDOUT decisions. Abort gives CANCELLED `RESEARCH_INTERRUPTED`; `sweep({owner_id, run_id})` appends TIMED_OUT `JOB_DEADLINE_EXCEEDED` for a RUNNING run past its deadline; no checkpoint, step table, lease, route or background loop. Runner: a direct-spawn `src/multi-pine/python-runner.js` with the `pythonEvaluation` limits, used by tests and by the operator script `scripts/mp-fixture-run.mjs`, which requires an explicit isolated-cluster flag and a fixture-role connection. `MULTI_PINE_REQUIRES_APP_3B` stays in the blockers; `owner_recommendation_ready` is always false; T-R1 to T-R3 and the F23 side-effect digest run after a full run. |
| RD-MP-33 | Fixture data and routing | Committed `test/fixtures/mp-combined/` with 6,000 deterministic synthetic closed 1m bars labelled BINANCE:BTCUSDT fixture (generator with fixed seed, pinned SHA-256, `atr14` from the existing `closed-ohlcv-atr14-v1` derivation); warm-up 1,250; split 2,850 / 950 / 950; M1 SPT defaults, M2 a different complete reviewed input set (EMA 34/250 and other catalog changes), M3 equal to M1 (F15), a zero-signal M2 variant (F29); each member's native BUY and exit counts pinned, at least 15 native BUY per member per segment; Option B as scripted per-member signal vectors at the library layer; private reviewed source and analyses referenced by hash only and read from an ignored directory named by an environment variable. Routing per RD-MP-7: each slice coder, independent tester, Opus auditor; the oracle writer is not the Python ledger writer. |

## 4. Decisions

### 4.1 Root-decidable now

Each item has a code or contract basis and needs no owner input.

| # | Item | Recommended ruling | Basis |
| --- | --- | --- | --- |
| R-1 | Adopt RD-MP-24 to RD-MP-33 (section 3) | Adopt. | Sections 2.1 to 2.11. |
| R-2 | Mapping of handoff items (P RQ-1) | R5 = RD-MP-24 to 27; R7 = RD-MP-32; R11 = RD-MP-30; R12 = RD-MP-31; R6 package slice consumes RD-MP-30 and the stored decisions. Root confirms against its local notes (not readable in the cloud). | P section 0. |
| R-3 | Ledger mechanism (P RQ-8) | Subclass `PaperState`; no copy. | `test_research_chunk.py:118-142`; C3. |
| R-4 | T-P1 method | Plain byte compare of the unchanged `ledger`; no projection, no single-member entry point. | 2.4; C6. |
| R-5 | Baseline outcome (P RQ-7, A D-10) | Record stored, status unaffected, C4 refuses. | MPC 8.2 stage C4; MPC 6.3 B0 and RD-MP-10; C5. |
| R-6 | Baseline range (P RQ-3) | The HOLDOUT step's own trace, rows `0..test_end`; no second holdout evaluation; no paging. | 2.6; `quant-research-worker.js:14`. |
| R-7 | Oracle input and MPC 5.6 wording | Signals in, intents regenerated, event lists compared; record as a root clarification of 5.6. | 2.9. |
| R-8 | Ledger anchor through `recordExecution` (P RQ-2) | Keep as a separate S2 PostgreSQL test; drop only if it needs a production-code change. | 2.9. |
| R-9 | Closure scope and shared files | Wide FE-2a-style closure; shared application files the multi run imports are hashed, not exempt. | C1; C4; 2.7. |
| R-10 | Runner | Direct-spawn runner with the `pythonEvaluation` limits; `runQuantProcess` not used in F11-01. | MPC 11.1; `process-supervisor.js:67`, `:104`. |
| R-11 | Process granularity | One process per step; S1 measures call time; lower the fixture budget if needed, never raise the deadline (P RQ-5). | 2.8; `mp-run-store.sql:102`. |
| R-12 | Recovery | `sweep` to TIMED_OUT after the deadline; no manual FAILED writes. | 2.8. |
| R-13 | Evidence retention (A Q-3, moved from owner) | Store the selected HOLDOUT decisions in the terminal result; FAILED `EVALUATION_OUTPUT_TOO_LARGE` above 1 MiB; no regeneration. AGENTS.md already requires immutable research evidence, so this is a reading of existing policy, not a new owner choice. | 2.11; C7. |
| R-14 | Streak and loss-guard scope (A Q-1, moved from owner) | Adopt Bot-level streak and guards as MPC 5.4 already states ("one loss-streak counter for the Bot"); record A's consequence note (member A's losing exit does not count until the Bot is flat) in the evidence record as a known behaviour, and add it to the APP-3B carry-over list next to R6 ordinal bias. | MPC 5.4; `ledger.js:248-253`. |
| R-15 | Bars source (P RQ-6) | `pine_market_bars` over the contract range with the `CONTENT_DIGEST_SQL` check (count, digest, bad rows). | Both drafts; `research-contract-v2.js:21-27`; `quant-research.js:111-113`. |
| R-16 | Funnel `rejected` keys (P RQ-10) | Exact reason strings; grouping into classes is the package report's job. | MPC 5.7; `research_engine.py:65`. |
| R-17 | Guard allowlist edits (P RQ-9) | Root edits the exact allowlist entries in `test/mp-run-store-static-isolation.test.js` and `test/multi-pine-run-contract.test.js` if they flag the new importers, as for X1 and D7. | P 9.3. |
| R-18 | File names | `mp_combined_paper.py`, `mp_combined_job.py`, `candidate-plan.js`, `combined-oracle.js`, `engine-closure.js`, `executor.js`, `python-runner.js`, `test/fixtures/mp-combined/`. | One name per file; P's names except where 2.x says otherwise. |

### 4.2 Owner-only questions (merged from P OQ-1, OQ-2 and A Q-2; A Q-1 and Q-3 moved to root, R-13 and R-14)

- OQ-A Private inputs and the acceptance machine (P OQ-1). MPC 11.4 item 2 needs the source-bound job, which needs the
  reviewed SPT source bytes (`0be2c64c...`) and two complete reviewed 58-input analyses. These are not tracked.
  (a) Where does the F1 to F30 acceptance run happen? (b) May the second analysis carry a fixture review (`reviewed_by`
  naming the fixture) instead of an owner review?
  Recommended default: (a) this cloud container or the owner's local checkout, with the owner placing the private files
  in an ignored directory named by an environment variable, using the direct-spawn runner and a throwaway local
  PostgreSQL cluster; no host or VPS work, so no GO is needed. (b) Yes, a fixture review labelled as fixture evidence,
  because MPC 11.2 already limits Option A parity to mechanics only.
- OQ-B Option B reading (P OQ-2). OD-MP-9 (B) says "synthetic sources from the evaluator allowlist". Both drafts read it
  as scripted per-member signal vectors fed to the library layer (the PF-2 S1 precedent).
  Recommended default: confirm scripted signal vectors, labelled `scripted-signals-v1`, for F3 to F9 and F13 only.
- OQ-C `MP_MEMBER_NO_SIGNALS` window (A Q-2, P RQ-4). OD-MP-10 says "zero native signals in the dataset". Both drafts
  count native BUY on rows `warmup..validation_end` only, so a member that fires only in the holdout is still a blocker,
  and holdout bars never enter a selection process for this check.
  Recommended default: accept the narrower window and native BUY as the counted signal. It is stricter than the owner's
  wording (it blocks more runs, never fewer), so root may apply it provisionally until the owner answers.

## 5. Slice plan

One writer per file. Lanes follow the owner rule of at most three lanes per workflow, each in its own package; S1 and
S2 touch different packages. Every slice: coder, independent tester, Opus auditor (accounting and parity are high risk,
RD-MP-7); root runs the final sole-runner pass. No slice edits an existing engine-closure file, `bridge_paper.py`,
`paper_state.py`, `bridge_replay.py`, `risk_evaluator.py`, `spt_custom_evaluator.py`, `process-supervisor.js`,
`prepareBridgeExecution`, the ledger, Risk Manager or any route (T-R5).

### S1 Python evaluator, job and fixtures (lane 1; Coder A, Python)

Writable (new files only):

- `quant_lab/src/robot_quant/mp_combined_paper.py` (library: `MemberSignals`, `BridgePair`, merged replay,
  `_CombinedPaperState`, `combined_paper_replay`, diagnostics)
- `quant_lab/src/robot_quant/mp_combined_job.py` (stdio job, membership projection, checks, one step per call)
- `quant_lab/tests/test_mp_combined_paper.py` (T-P1 to T-P5, F3 to F9, F13, F24, F29 at library level)
- `quant_lab/tests/test_mp_combined_job.py` (protocol, projection incl. the Option A refusal without projection,
  slots forbidden, holdout rows only in HOLDOUT, codes; private-input cases skip unless `MP_REQUIRE_PRIVATE=1`)
- `quant_lab/tests/mp_scripted_driver.py` (test-only driver the Node tests spawn for scripted cases)
- `scripts/build-mp-fixture-bars.mjs`, `test/fixtures/mp-combined/bars-v1.json`, `scripted-cases-v1.json`,
  `manifest.json`, `private-inputs.manifest.json`

Acceptance: T-P1 byte equality; T-P2 to T-P5; the projection test proves `CUSTOM_EFFECTIVE_INPUT_CHANGED` without the
projection and success with it (needs private inputs; otherwise skipped and reported as not run); measured wall time of
one 3-member call on 6,000 and 10,000 bars; generator signal floor met with pinned counts; ruff and pytest pass; existing
Python suites unchanged.

### S2 Node oracle and baseline comparison (lane 2, parallel with S1; Coder B, Node, not Coder A)

Writable (new files only):

- `src/multi-pine/combined-oracle.js` (pure: intents from signals, merge, Bot ledger, `compareCombined`)
- `test/multi-pine-combined-oracle.test.js` (pure: scripted F3, F4, F7, F8, F13, three-member contention; mutations
  that must fail: one quantity step, swapped same-bar order, 0.02 USDT cash drift, wrong member tag; one-member equality
  with `scripts/quant-bridge-reference.mjs`)
- `test/postgres/mp-combined-baseline.test.mjs` (spawns the S1 scripted driver; Python against oracle on the scripted
  cases and the M1 plus M2 library run; waits for S1's driver)
- `test/postgres/mp-combined-ledger-anchor.test.mjs` (R-8; real `recordExecution` on a fixture Bot in an isolated
  cluster)

The pure oracle and its pure tests do not depend on S1 and start at once. The two PostgreSQL files start after S1's
driver lands.

### S3 Plan, closure, executor and runner (after S1 job protocol and S2 oracle API are frozen; Coder C, or Coder B after S2)

Writable (new files only):

- `src/multi-pine/candidate-plan.js`, `test/multi-pine-candidate-plan.test.js` (may start in parallel with S1 and S2 if
  root counts it as a third lane; it shares the `src/multi-pine/` package with S2's oracle, so under the lane rule it
  runs after S2 or in S2's lane)
- `src/multi-pine/engine-closure.js`, `test/mp-engine-closure.test.js` (must come after S1 and S2 files exist, because
  the closure lists them)
- `src/multi-pine/executor.js`, `src/multi-pine/python-runner.js`, `scripts/mp-fixture-run.mjs`
- `test/postgres/mp-executor.test.mjs` (full run to SUCCEEDED and NO_VALID_CANDIDATE, F20, F28, F29, deadline,
  RUNNING race, engine change, stale set, abort, sweep, holdout once and never in other payloads, result size, F23
  digest, T-R1 to T-R3 after the run)

Root-only edits in S3: the exact allowlist entries in `test/mp-run-store-static-isolation.test.js` and
`test/multi-pine-run-contract.test.js` (R-17). Documentation (root or Sonnet documentation): MPC section 14 rows
RD-MP-24 to 33, the 5.6 clarification, evidence record, Roadmap and Time Management lines.

### What this cloud container can and cannot accept

Checked here: `python3` and `quant_lab/.venv` with pytest exist; PostgreSQL `initdb`, `pg_ctl` and `postgres` exist under
`/usr/lib/postgresql/*/bin`; `systemd-run` exists but there is no user bus.

| Work | Cloud container | Needs owner private source | Needs a systemd host |
| --- | --- | --- | --- |
| S1 library, T-P1 to T-P5 with `CustomSignalInputs` M1 and M2, scripted Option B cases | Yes | No | No |
| S1 job protocol tests that do not reach the source gate | Yes | No | No |
| S1 job tests through `validate_custom_snapshot` (projection proof, end-to-end steps) | No (skip, report not run) | Yes | No |
| S1 runtime measurement | Yes (indicative; record machine class) | No | No |
| S2 oracle, comparison, mutations, PostgreSQL baseline on scripted and library cases, ledger anchor | Yes | No | No |
| S3 plan, closure test, six-hash equality, executor mechanics with a Node stub runner (RD-MP-4: mechanics only) | Yes | No | No |
| S3 executor full run with the real job, F1 to F30 acceptance (MPC 11.4 item 2) | Only if the owner places the private inputs here (OQ-A) | Yes | No, under R-10 |
| `runQuantProcess` operator path | No | Yes | Yes (only if root rejects R-10) |

Cloud agents work from a pushed revision and return patches (AGENTS.md); `.qa-local/` and private inputs are never
available to them, so any test that needs private inputs runs in root's session or the owner's local checkout.

## 6. Top risks

1. Private inputs gate acceptance. Without the reviewed SPT bytes and two reviewed analyses, F1 to F30 cannot run with
   the source-bound job; cloud evidence covers the library, scripted cases and mechanics only (OQ-A).
2. Option A membership ambiguity (1.1). Any code path that calls `validate_custom_snapshot` on an unprojected member
   snapshot refuses member 2. The projection and its negative test are mandatory.
3. Runtime unmeasured. One process per step recomputes 2 to 3 SPT signal series; 31 calls must fit the run deadline
   (at most 900 s) and each call 30 s. S1 measures before S3 fixes the fixture budget.
4. Oracle independence. The oracle re-implements Bot ledger transitions in Node. Independence rests on a different
   writer, production pure functions, the mutation tests and the `recordExecution` anchor.
5. Cross-language formatting. Decimal strings may render differently in Python and Node (C9); compare as decimals only,
   or the baseline fails falsely.
6. `PaperState` coupling. The subclass depends on `self.replay` and its `step` call; T-P1 and the closure hash detect
   drift, and `paper_state.py` cannot change without rotating every closure that holds it.
7. Result size. The 1 MiB result must hold metrics for up to 100 candidates, the baseline record and the selected
   decisions; fixture scale fits, larger runs fail `EVALUATION_OUTPUT_TOO_LARGE` by design.
8. Ordinal bias and Bot-level streak are visible product behaviour of a multi-Pine Bot (MPC R6, R-14); both are recorded,
   not removed, and belong to APP-3B.
9. Synthetic bars may not make SPT fire often enough on both members; tune the generator before evaluating any gate.

## 7. Not verified

- Wall time of SPT signal evaluation and of the combined replay at 6,000 and 10,000 bars (no tests were run).
- Whether `recordExecution` can be driven on an isolated fixture Bot without a production-code change (R-8).
- Size of a real HOLDOUT trace at 10,000 bars; the fixture-scale estimate is reasoning, not measurement.
- Root's local notes defining R5, R6, R7, R11 and R12 (not readable here); the mapping in R-2 is P's reconstruction.
