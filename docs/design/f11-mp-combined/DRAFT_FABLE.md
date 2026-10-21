# F11 RS-6 design draft: combined Python evaluator `mp-combined-paper-v1`

Author: Fable 5.1, alternative designer, for "Root: astra-vps-trade-bot-v2". Independent draft; the Opus draft was not read. Revision read: `629bcb4` (branch `codex/app3a-market-wait-checkpoint-gwylmk`). Date: 2026-10-21 (Bangkok).

Status: a proposal. Nothing here is a GO, a contract change or an owner decision. Every decision below is written as a row root can adopt, reject or amend. Citations use the form `path:line` for code read at this revision and `CONTRACT §n` for `docs/MULTI_PINE_CONTRACT.md`. Scope guard: Spot/Paper only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, fixture only (`CONTRACT §0`, `AGENTS.md § Host and product safety`).

The design is organised as decisions D-1 to D-18, then proposed contract rows (RD-MP-24 to RD-MP-31), owner-only questions, and the places where this draft departs from a conventional design.

---

## 1. What exists and what RS-6 must add

The one-Pine engine is `paper_replay` (`quant_lab/src/robot_quant/bridge_paper.py:69-218`): one `BridgeReplay` (`bridge_replay.py:144-183`) produces the intents of one deployment, and one serial ledger applies `evaluate_risk` (`risk_evaluator.py:90`) and `round_order` (`bridge_replay.py:93`) to each intent. The research driver `research_engine.py:17-71` evaluates each member's source signals with `evaluate_bars` (`spt_custom_evaluator.py:182`), builds `BridgeBar`s with the frozen market `atr14` (`research_engine.py:42-45`) and calls `paper_replay` with `start_time = rows[split["warmup"]]["time"]` (`research_engine.py:58`).

The multi-Pine run contract exists and is stored (`src/multi-pine/run-contract.js`, `src/postgres/mp-run-store.js`). It carries no `plan`, no bars, no source text and no policy object: only `bridge_domains`, `dataset` by range and content digest, `policy_hash`, `capital`, `model`, `rules`, `engine_hash`, `members` (hashes and ids) and `same_bar_order` (`run-contract.js:40`). The run store has no step table, no lease and no result column; status lives only in the event stream `ADMITTED -> RUNNING -> terminal`, and a terminal `SUCCEEDED` or `NO_VALID_CANDIDATE` event must carry a result tied to `run_id`, `contract_hash`, `owner_recommendation_ready:false` and the `MULTI_PINE_REQUIRES_APP_3B` blocker (`mp-run-store.js:134-157`, RD-MP-19, RD-MP-21). `engine_hash` is injected into the fixture service and RS-6 decides it (`fixture-service.js:137`, RD-MP-23, handoff V6/V7).

RS-6 therefore needs: (a) the combined evaluator in Python, (b) a stdio driver for it, (c) a Node executor that turns a stored run into events, (d) a deterministic candidate plan over `bridge_domains`, (e) the multi-run engine-hash closure, (f) a Node oracle for the combined Quant baseline, and (g) fixture data. Each is a new file. No existing closure file is edited (D-13).

## 2. Decisions

### D-1. Module layout: new files only

| File | Role |
| --- | --- |
| `quant_lab/src/robot_quant/mp_combined.py` | `combined_paper_replay(...)` and the member signal helpers. Imports only `bridge_replay`, `risk_evaluator`, `analytics` and `node_policy` from `bridge_paper`. |
| `quant_lab/src/robot_quant/mp_combined_engine.py` | stdio JSON driver, one step per process, same shape of contract as `research_engine.py` and `fixed_eval.py` (`{"result":...}` on exit 0, `{"error":CODE}` on exit 1, `fixed_eval.py:519-542`). |
| `src/multi-pine/run-plan.js` | pure candidate plan over the decimal-string `bridge_domains` (D-9). |
| `src/multi-pine/engine-files.js` | `MP_ENGINE_FILES`, `MP_CLOSURE_VERSION`, `mpEngineHash()` (D-13). |
| `src/multi-pine/fixture-executor.js` | `MultiPineFixtureExecutor.execute({owner_id, run_id})`: reads the run, appends events, loads server rows, spawns the Python step (D-11, D-12). |
| `scripts/mp-bridge-reference.mjs` | Node oracle for the combined baseline (D-14). Not in the engine closure. |
| `test/fixtures/multi-pine/` | deterministic dataset generator and scripted member signals (D-16). |

Reason: `CONTRACT §12` keeps "the Python evaluator's one-Pine behaviour" out of scope and I12/T-R4/T-R5 require the one-Pine suites to pass unchanged; `bridge_paper.py`, `bridge_replay.py` and `risk_evaluator.py` are in the LEGACY, PF2 evaluator and runtime closures (`src/postgres/quant-research.js:19`, `src/quant-research/preflight-resolver.js:26-32`, `src/quant-research/runtime-engine-files.js:9-22`), so an edit there rotates every existing engine hash. The precedent for a side-by-side evaluator with its own closure is FE-2 (`src/postgres/quant-fixed-eval-engine.js:5-27`).

### D-2. Evaluator input shape

```python
@dataclass(frozen=True)
class SharedPair:            # exactly one per run; no member carries a pair (T-P3)
    multiplier: Decimal
    rr: Decimal

@dataclass(frozen=True)
class MemberSignals:         # one per member, ascending ordinal
    ordinal: int
    deployment_id: str
    signals: tuple[tuple[bool, bool], ...]   # (buy, native_exit) per bar, same length as bars

def combined_paper_replay(
    members: tuple[MemberSignals, ...],
    bars: list[BridgeBar],
    shared_pair: SharedPair,
    *,
    model: PaperModel,
    policy: dict,                 # node_policy names, bridge_paper.py:29-60
    equity: Decimal,
    cash: Decimal,
    broker: str,
    symbol: str,
    start_time: int | None = None,
    same_bar_order: str = "exit-first-ordinal-v1",
) -> CombinedReplay
```

`CombinedReplay` is a small frozen holder with two fields: `ledger` (a dict with exactly the keys of `paper_replay`'s return value, `bridge_paper.py:210-218`) and `diagnostics` (the funnel, D-7). The two are separate on purpose (D-6).

Rules enforced at construction, each a `ValueError` with an existing code: `members` empty or with duplicate `deployment_id` or non-dense ordinals -> `MP_INPUT_INVALID`; a `same_bar_order` other than `exit-first-ordinal-v1` -> `MP_EVENT_ORDER_UNDEFINED` (`CONTRACT §5.5`); `signals` length not equal to `len(bars)` -> `MP_INPUT_INVALID`; a non-bool signal -> `BOOLEAN_SIGNAL_REQUIRED` (already raised by `BridgeReplay.step`, `bridge_replay.py:154-155`). The function accepts one member: T-P1 needs it, and the two-member minimum is the member-set builder's and validator's job (`run-contract.js:196`), not the evaluator's.

Why signals in and not sources: one member's inputs must never change another member's signals (`CONTRACT §5.2`, I8, case F24). If the ledger function never sees inputs or sources, the invariant holds by construction, and T-P2/F24 reduce to "the signal tuples of member 1 are byte-identical across runs", which the test asserts directly.

### D-3. Member signals: per member, frozen ATR, same rows

Member signals come from `evaluate_bars(rows, CustomSignalInputs.from_source_values(values))` (`spt_custom_evaluator.py:52-57, 182`), with `values` the member's ten catalog inputs taken from its own `pine_source_revisions.analysis.inputs` (effective values of the `CATALOG` pine variables, `src/quant-research/contract.js:5`). Bars are `BridgeBar(row.time, open, high, low, close, volume, Decimal(str(row["atr14"])))` built exactly as `research_engine.py:42-45` and `fixed_eval.py:463-476`: the frozen market ATR(14), never a source ATR (`CONTRACT §4`, "Bridge ATR period stays 14 as versioned configuration"). One bar list serves every member.

### D-4. Combined ledger semantics

One ledger for the Bot, as `CONTRACT §5.4` states and as the Node ledger is keyed: `ledger_positions` by `(user, account, mode, symbol)` (`src/postgres/ledger.js:71`), `ledger_streak` by `(user, account, mode)` with the streak updated only when the symbol position reaches zero (`ledger.js:252-253`), `ledger_daily` by day (`ledger.js:277`). No ledger table is keyed by deployment. The Python one-Pine loop mirrors that (`bridge_paper.py:184-186`). Hence:

| State | Scope | Reason |
| --- | --- | --- |
| `cash`, `cost`, `quantity` | one per Bot | `CONTRACT §5.4` "one cash balance"; `ledger.js:71`. |
| `positions` (allocations) | one map keyed by `entry_ref`, each with its owning `deployment_id` and `ordinal` | `CONTRACT §5.4`; `entry_ref` is unique per deployment (CODE fact 12, `src/pine-bridge/contract.js:34`). |
| `initial_risk`, `pnl`, `loss_streak` | one per Bot; `initial_risk` and `pnl` reset to 0 and the streak is updated only when the combined `quantity` is 0 | `bridge_paper.py:176-186`; `ledger.js:248-253`. A per-member streak would diverge from the Node ledger the oracle reproduces. |
| `daily` (trades, notional, realized_r, loss_streak) | one map per Bot; trades count accepted BUY and EXIT of every member | `CONTRACT §5.4`; `docs/ROADMAP.md:1268-1270`. |
| `open_positions` | `int(quantity > 0)` (unique-symbol capacity, one symbol) | `bridge_paper.py:140`; `ROADMAP.md:1271`. |
| `equity`, `cash_available`, `committed_notional` | computed per intent exactly as `bridge_paper.py:134-139` | T-P1. |

Consequences root should see: with two members holding inventory, a losing exit of member 1 does not increase the streak until member 2 also exits (flat-to-flat for the Bot). Loss-guard pauses (F8) therefore stop entries of every member at once, which is the intended shared-limit behaviour (`CONTRACT §5.4`, I9). A BUY of member 2 rejected because member 1 used the cash is a policy skip attributed to member 2 (`CONTRACT §5.4`), recorded in member 2's funnel.

Reduce-only EXIT: every EXIT signal carries `reduceOnly: true` and `targetTradeId: entry_ref` (`bridge_paper.py:113, 127`), so `evaluate_risk` skips the entry guards for it (`risk_evaluator.py:110-129`) and caps to the target's remaining quantity (`risk_evaluator.py:269-281`). Cases F7 and F8 rest on these lines and need no new code.

Target isolation (I4, T-P4): an EXIT resolves `positions.get(intent.entry_ref)`; a missing target is `TARGET_NOT_OPEN` as in `bridge_paper.py:101-104`. If the allocation found carries another member's `deployment_id`, the function raises `ValueError("MP_CROSS_SOURCE_TARGET")` and the step fails. By construction this cannot fire: each member's `BridgeReplay` writes refs `f"{deployment_id}:{time}:0"` (`bridge_replay.py:180`) and deployment ids are distinct (D-2). The count reported in the diagnostics must stay 0 (`CONTRACT §8.2`).

### D-5. Same-bar order `exit-first-ordinal-v1`

Per bar: (1) call `member.replay.step(bar, buy, native_exit)` for every member in ascending ordinal and keep each member's intent list; (2) apply to the ledger every EXIT intent, members in ascending ordinal, each member's own order preserved (that order is the descending entry traversal of `BridgeReplay.step`, `bridge_replay.py:161-168`); (3) then every BUY intent in ascending ordinal. `events`, `decisions` and `fills` are appended in processing order, so the three lists agree with each other and with the oracle (D-14).

Step (1) before (2) is safe because intent generation reads only Pine-side state (`bridge_replay.py:1-5`: "An intent remains in Pine's arrays even if the Paper worker rejects its BUY"), never the ledger. BUY suppression stays inside each member's `step` (`exit_bar`, `bridge_replay.py:160-169`): member 2's EXIT never suppresses member 1's BUY (`CONTRACT §5.3`, I5, case F6). The `sequence` field stays per member (`len(events)` inside that member's step), which is the live per-deployment payload sequence (`src/pine-bridge/contract.js:32-37`, I6).

### D-6. One-member byte identity (T-P1, F16) without a special case

Three properties make a one-member combined run equal to `paper_replay` byte for byte on canonical output, with no `if len(members) == 1` branch (a branch would make T-P1 vacuous):

1. `BridgeReplay.step` already emits a member's EXITs before its BUY (`bridge_replay.py:161-183`), so for one member "all EXITs in ordinal order, then all BUYs in ordinal order" is the identity permutation of the member's own intent order.
2. The per-intent ledger body is the same code: `mp_combined.py` holds one private function `_apply(state, member, bar, intent)` whose statements are a copy of `bridge_paper.py:95-209`, inside one `localcontext()` with `ctx.prec = PRECISION_CONTEXT` for the whole run (`bridge_paper.py:83-84`). Record dicts keep the same keys and the same string renderings (`amount`, `str`).
3. The ledger dict returned carries exactly the seven keys of `bridge_paper.py:210-218`; every multi-Pine addition lives in `diagnostics`. Canonical output is `json.dumps(ledger, sort_keys=True, separators=(",", ":"))` as `ql3a.canonical` (`ql3a.py:45-46`).

Test T-P1 runs `paper_replay` and `combined_paper_replay` on the same scripted bars and on the fixture dataset with one member at several pairs, and asserts byte equality of the canonical ledger and equality of the SHA-256 (T-P5). A mutation test should remove the ordinal sort and confirm T-P1 still passes while a two-member order test fails: that proves the order rule, not the branch, carries the one-member case.

### D-7. Funnel counts (diagnostics)

`diagnostics = {"version": "mp-combined-paper-v1", "same_bar_order": ..., "members": [per ordinal], "bot": sums, "cross_source_targets": 0}` with, per member, counts only (`CONTRACT §5.7`, OD-MP-5): `native_buy`, `native_exit` (bars at index `>= warmup`, i.e. `time >= start_time`), `intents_buy`, `intents_exit_by_reason` (SL, TP, NATIVE), `warmup_intents`, `suppressed_buys` (bar with `buy` true, `atr14` present and the member's own `exit_bar` true), `invalid_level_buys` (BUY dropped by `INVALID_ENTRY_LEVELS`, `bridge_replay.py:174-177`), `accepted_buy`, `capped_buy`, `rejected_buy_by_reason`, `exits_filled_by_reason`, `exits_rejected_by_reason` with `TARGET_NOT_OPEN` split into `warmup_entry` and `refused_entry` as `fixed_eval.py:260-287` does. The `bot` object is the field-wise sum; case F28 asserts the sum. No per-member return, P&L or ranking field exists anywhere in the output (OD-MP-5, OWN O14 via `CONTRACT §5.7`).

Per-fill member tag (`CONTRACT §5.7`, `§6.2` trades.csv and decisions.csv): the ledger records are not widened (D-6). `entry_ref` begins with the owning `deployment_id` (CODE fact 12), and `diagnostics.members[i]` carries `{ordinal, deployment_id}`, so the package writer (slice R6) derives the tag by prefix. This keeps the ledger byte-identical and still makes the attribution derivable from stored output.

### D-8. Warm-up start

One `start_time = bars[warmup_bars].time` for every member, where `warmup_bars` is the contract value admitted against the combined floor `max` over members of `max(1006, 5 * emaSlowInput)` (`CONTRACT §5.2`, RD-MP-20; `src/multi-pine/member-admission.js:147, 175, 237`). Every member's `BridgeReplay` and every source evaluator run from bar 0, and intents before `start_time` are recorded in `events` and skipped by the ledger, exactly as `bridge_paper.py:99-100`. A member with a smaller floor is not started earlier: there is one Bot ledger, and the one-Pine floor already applies to the whole dataset (`src/postgres/quant-research.js:93`).

### D-9. Candidate search over `bridge_domains`: one candidate, every member

A new pure `multiCandidatePlan(bridge_domains, bridge_pair, budget, seed)` in `src/multi-pine/run-plan.js` reproduces `candidatePlan` (`src/quant-research/contract.js:74-97`) on exact decimal strings: grid of each domain from `{min, max, step}` (the builder already proved `min < max`, step alignment, at most 1000 values and the pair on the grid, `run-contract.js:172-191, 304-305`); row 1 is the baseline (the member set's shared pair); then the adjacent value on each axis; then the exhaustive grid when `combinations <= budget`, else the same LCG (`1664525`, `1013904223`, `contract.js:92-94`) seeded by the contract seed, so a multi plan with the same domains, budget and seed as a one-Pine plan selects the same pairs. No `validParameters` filter applies (no source dimensions). Output: `{candidates:[{atr_multiplier, rr}], algorithm, seed, requested_budget, planned_candidates, grid_combinations, plan_hash}`.

The plan is not stored in the contract (the exact-key validator would refuse it, `run-contract.js:40, 218-219`); the executor derives it on every run and writes `plan_hash` into the terminal result. Each candidate is one `SharedPair` passed to one `combined_paper_replay` call that evaluates every member (`CONTRACT §4`, "each candidate pair is applied to every member replay at once", T-P3). Nothing in the request or in the function can address one member's pair.

Step kinds and screening follow the one-Pine worker unchanged: `CANDIDATE` for each plan row on `bars[:validation_end]`; `screen(result, baseline)` with the baseline the first row's validation return (`quant-research-worker.js:110-111`, `contract.js:103-110`); `coverage` must be 100 on both Bridge axes (`contract.js:99-101`, `worker.js:115`); `SENSITIVITY` on the two neighbours per axis of the selected pair; `STRESS` with fee and slippage doubled (`research_engine.py:47-52`); `HOLDOUT` once, on the full bars, only after the selected pair passes (`worker.js:130-135`, PKG § 5.0 item 5 via `CONTRACT §6.3`). Thresholds come from the frozen `rules`, which the validator forces equal to `RULES` (`run-contract.js:144-146`).

### D-10. Failure and outcome conditions

Two different "baselines" appear in the contract and must not be confused:

1. Screening baseline (search): the shared pair's own combined validation return. A candidate below it or below zero is `VALIDATION_BELOW_BASELINE_OR_ZERO` (`contract.js:107`). No eligible candidate, coverage under 100, a failed sensitivity, stress or holdout check -> terminal `NO_VALID_CANDIDATE` with `completion_reason` as the one-Pine worker names it (`worker.js:114-137`). A valid outcome (`CONTRACT §5.8`).
2. Combined Quant baseline (`CONTRACT §5.6`): parity of the combined replay with the Node oracle (D-14). Failure is `MP_COMBINED_BASELINE_FAILED` at package gate C4 and a test failure in T-O1. RS-6 produces the oracle and the fixture comparison; it does not run the oracle inside the executor (the oracle is evidence, not the engine).

Run-level failures the executor turns into a terminal `FAILED` event with an existing `reason_code` (handoff V7, codes match `MP_CODE_PATTERN`, `mp-run-store.js:151`):

| Condition | reason_code |
| --- | --- |
| A member has zero native BUY in the compared selection window (D-15) | `MP_MEMBER_NO_SIGNALS` (OD-MP-10) |
| `mpEngineHash()` differs from `contract.engine_hash` before any step or before the terminal write | `QUANT_ENGINE_CHANGED` (`worker.js:75, 92, 103`) |
| Stored member source hash or recomputed effective-inputs hash differs from `contract.members[i]`; policy hash differs from `contract.policy_hash` | `MP_MEMBER_SET_STALE` (`CONTRACT §8.2`) |
| Market rows missing, gapped, bad profile, or content digest differs from `contract.dataset.content_digest` | `VERIFIED_MARKET_DATA_REQUIRED` or `INSUFFICIENT_OR_GAPPED_RESEARCH_DATASET` (`quant-research.js:111-113`) |
| `model.version` not `paper-close-v1` | `RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED` (`member-admission.js:119`; `PaperModel` refuses other versions, `bridge_replay.py:47-49`) |
| Python step error, bad response shape, output too large | `EVALUATION_FAILED`, `INVALID_EVALUATION_RESPONSE`, `EVALUATION_OUTPUT_TOO_LARGE` (`worker.js:25-29`) |
| Deadline passed | terminal `TIMED_OUT`, reason `JOB_DEADLINE_EXCEEDED` (`worker.js:39`) |

### D-11. Executor path

`MultiPineFixtureExecutor` (constructor: fixture-role `db`, the `Store` on the same db, `readBotState` as in RS-5, `clock`, `python`, `engineHash` function; never request input, mirroring `fixture-service.js:132-140`). `execute({owner_id, run_id})`:

1. `getMultiRun` (owner-scoped, every stored check applied, `mp-run-store.js:338-345`). A run whose last event is not `ADMITTED` is refused with the store's `run.transition` refusal (no second execution).
2. Claim by event: `appendRunEvent(RUNNING)`. The database transition guard makes this the only claim mechanism (RD-MP-19: no lease column); two executors cannot both succeed.
3. Pre-flight, all read-only: recompute `mpEngineHash()`; read the Bot policy through the store and check `hash(canonical(policy)) === contract.policy_hash` (recipe of `member-set.js:82-83, 180`); read each member's `pine_source_revisions` row at `(pine_import_id, source_version)` and check `source_hash` and `effectiveInputsHash(analysis)` (`fixture-service.js:100`) against `contract.members[i]`; read `pine_market_bars` for the range with the model's `data_profile` and check count, continuity and the content digest (`CONTENT_DIGEST_SQL`, `research-contract-v2.js:21`). Any failure -> terminal `FAILED` (D-10). No lock is taken: the run is immutable and the stale checks are the guard.
4. Build the ten catalog inputs per member, the plan (D-9), and run the steps in the one-Pine order, each step one Python process (D-12). Before each step check the clock against `run.deadline_ms` and the last event (an operator may have appended `CANCELLED`); stop on either.
5. Terminal event with the result (D-17) or a reason code.

No worker, scheduler, route, lease or checkpoint table. A crash leaves the run `RUNNING` with no way to resume; the operator appends `FAILED` by hand (the store permits `RUNNING -> FAILED`, `mp-run-store.js:56`). This is acceptable for a fixture whose runs are bounded by `deadline_ms` (60 s to 900 s) and are re-admissible under a new idempotency key. The static isolation test of RS-3 must list `fixture-executor.js` and `run-plan.js` as modules no runtime root imports (`test/mp-run-store-static-isolation.test.js`).

### D-12. Python step process and request schema

One process per step, spawned like `pythonEvaluation` (`quant-research-worker.js:12-32`): `python -m robot_quant.mp_combined_engine`, `cwd` the repository root, `PYTHONPATH=quant_lab/src`, stdin limited to 8 MiB, stdout to 2 MiB, timeout `min(30 s, deadline remaining)`, stderr discarded. Holdout rows never enter a `CANDIDATE`, `SENSITIVITY` or `STRESS` process: the executor slices `rows[:validation_end]` for those kinds (`worker.js:14-15`).

Request (`mp-combined-request-v1`, exact keys): `{version, kind, contract_hash, parameters:{atr_multiplier, rr}, members:[{ordinal, deployment_id, inputs:{ten CATALOG names}}], model, policy, capital:{equity, cash}, market:{broker, symbol}, split:{warmup, train_end, validation_end, test_end}, same_bar_order, rows:[{time, open, high, low, close, volume, atr14}]}`. The driver checks exact keys, `kind` in the four kinds, the split order and length rule of `research_engine.py:36-40`, `same_bar_order`, 60000 ms continuity, and builds `CustomSignalInputs` per member (bounds enforced by its `__post_init__`, `spt_custom_evaluator.py:45-51`). It then evaluates signals per member, applies D-15, builds bars once, calls `combined_paper_replay` with `start_time = rows[warmup]["time"]`, and marks periods with `mark_period` (`ql3a.py:87-136`) on the ledger fills, which is the same function the one-Pine driver uses (`research_engine.py:62-64, 70`).

Response (`mp-combined-step-v1`): `{version, evaluator:"mp-combined-paper-v1", contract_hash, parameters, kind, train, validation, test (HOLDOUT only), decision_count, fills, rejections, exit_fill_reasons, diagnostics, ledger_hash}` where `ledger_hash` is the SHA-256 of the canonical ledger dict. The executor applies the same response checks as `worker.js:82-89` plus `contract_hash` echo and `evaluator` id. Errors leave the process as a short upper-case code only, never a message or path (`fixed_eval.py:500-503`).

### D-13. Multi-run engine-hash closure and proof that existing closures are unchanged

`src/multi-pine/engine-files.js`:

```js
export const MP_CLOSURE_VERSION='mp-combined-closure-v1';
export const MP_ENGINE_FILES=Object.freeze([
  // Python import closure of mp_combined_engine
  'quant_lab/src/robot_quant/__init__.py','quant_lab/src/robot_quant/analytics.py',
  'quant_lab/src/robot_quant/bridge_paper.py','quant_lab/src/robot_quant/bridge_replay.py',
  'quant_lab/src/robot_quant/mp_combined.py','quant_lab/src/robot_quant/mp_combined_engine.py',
  'quant_lab/src/robot_quant/ql3a.py','quant_lab/src/robot_quant/risk_evaluator.py',
  'quant_lab/src/robot_quant/spt_custom_evaluator.py','quant_lab/src/robot_quant/spt_evaluator.py',
  // Node modules that decide the run
  'src/money.js','src/pine-bridge/source.js','src/quant-research/contract.js',
  'src/multi-pine/codes.js','src/multi-pine/engine-files.js','src/multi-pine/fixture-executor.js',
  'src/multi-pine/member-set.js','src/multi-pine/run-contract.js','src/multi-pine/run-plan.js'
].sort());
export async function mpEngineHash(readFile=fs.readFile){ /* hash(canonical({version, files})) */ }
```

The hashed object carries the version string, as FE-2 does (`quant-fixed-eval-engine.js:12, 26`), so a change of the file list rotates the hash even with equal bytes. `ql2a.py`, `ql3a.py`'s CLI parts and `spt_evaluator.py` enter through imports (`ql3a.py:14-17`); the Python dependency traversal test pins that the closure is complete (pattern of `test/quant-engine-files.test.js:52-63`). The closure is narrow on purpose: it lists what the multi run executes, not the whole runtime manifest; see section 5 for the trade-off.

R12 (handoff): the fixture service's injected `engineHash` is `await mpEngineHash()`, computed by the operator script or test at construction; the executor recomputes it and refuses a drift (`QUANT_ENGINE_CHANGED`).

Proof obligations that no existing closure changes, all testable:

1. The RS-6 diff touches none of `src/postgres/quant-research.js`, `src/quant-research/preflight-resolver.js`, `src/quant-research/runtime-engine-files.js`, `src/postgres/quant-fixed-eval-engine.js`, nor any file those lists name. A negative-scope diff check in the packet (T-R5 style, `CONTRACT §15.5`).
2. `test/quant-engine-files.test.js:65-73` already pins `LEGACY_ENGINE_FILES` and `PF2_EVALUATOR_FILES` by list and by byte hash at the reviewed base revision; it must pass unchanged.
3. A new test asserts `MP_ONLY_FILES` (the new files) are disjoint from `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES`, `FIXED_EVAL_ENGINE_FILES` and `QUANT_RUNTIME_ENGINE_FILES`, and that `engineHash(false)`, `engineHash(true)`, `pf2ExecutableHashes()` and `fixedEvalEngineHash()` computed before and after the RS-6 files are added are equal (they cannot see the new files, so they are).
4. `mp_combined.py` is imported by no module in any existing closure (grep assertion), so no existing Python traversal reaches it.

### D-14. Node oracle for the combined baseline (`CONTRACT §5.6`)

A new `scripts/mp-bridge-reference.mjs`, sibling of `scripts/quant-bridge-reference.mjs` (the one-Pine oracle used by QL-2A, `quant_lab/src/robot_quant/ql2a.py:79-90, 311-338`). It imports only production decision functions: `evaluateRisk` (`src/postgres/risk.js`), `levels`, `exitDecision`, `executionPrice` (`src/pine-bridge/contract.js`) and `roundBridgeOrder` (`src/postgres/pine-bridge-execution.js:43`). `prepareBridgeExecution` is neither called nor edited (`CONTRACT §5.6`): it refuses a multi-Pine BUY by design (`pine-bridge-execution.js:21`) and needs READY deployments and a database, which the fixture never has (OD-MP-7).

Request `mp-oracle-request-v1`: `{operation:"combined-replay", same_bar_order, members:[{ordinal, deployment_id, signals:[{buy, native_exit}]}], bars:[{time, open, high, low, close, volume, atr14}], multiplier, rr, model, policy, equity, cash, broker, symbol, start_time}`. The oracle derives intents per member itself with `exitDecision` and `levels` (as `quant-bridge-reference.mjs:9-28` does per deployment), orders them by the same rule (all EXITs by ordinal, then BUYs by ordinal), and runs its own serial ledger (`quant-bridge-reference.mjs:30-66`) with one position map, one streak and one daily map. It takes signals, not Python's intents, so intent generation and ordering are checked independently; the contract wording "feeds the same ordered intents" is satisfied in the stronger sense that the oracle's events list must equal Python's events list.

Comparison (in the fixture harness, Python side, a `compare_combined` built on `ql2a.compare_replays`, `ql2a.py:157-200`): accept/cap/reject equal on every decision (100 %), allocation target (`entry_ref`) mismatches 0, quantity difference 0 venue steps, fee equal, per-fill `cash` and `final_cash` within 1 minor unit of the quote currency (USDT: 0.01), events equal including `sequence` and reason, `open_allocations` equal (ADP row "Quant baseline", `docs/PINE_BRIDGE_ADAPTER_API.md:142`). Cases F3, F4, F7, F8, F13 run through it (T-O1), plus F6 and a three-member cash contention. "Isolated PostgreSQL cluster" in `CONTRACT §5.6` refers to where the admitted run lives; the oracle itself needs no database.

### D-15. `MP_MEMBER_NO_SIGNALS` window

The driver counts each member's native BUY over bars with index `>= warmup` in the rows the step received. For every selection step those rows end at `validation_end`, so a member with zero BUY in train plus validation is a blocker even if it fires in the holdout: the shared pair would be chosen without that member's participation (OD-MP-10 reason). The check runs in the first `CANDIDATE` step (signals do not depend on the pair) and ends the run `FAILED` with `MP_MEMBER_NO_SIGNALS` and the ordinal. See owner question Q-2: OD-MP-10 says "in the dataset", and this draft narrows it to the selection window.

### D-16. Fixture data plan

Committed, deterministic, labelled fixture (`CONTRACT §11.2`): `test/fixtures/multi-pine/dataset.mjs` generates 4,000 one-minute bars from a fixed origin time with a seeded integer PRNG, with shaped trend and range segments so SPT Spot v4 fires on both reviewed input snapshots (Option A, OD-MP-9), `price_tick 0.01`, `quantity_step 0.00001`, `atr14` computed by the `closed-ohlcv-atr14-v1` recipe used for `pine_market_bars` rows, and provenance `{fixture:true, symbol:"BTCUSDT", timeframe:"1", broker:"binance-global"}`. 4,000 bars give warm-up 1006 and 2,994 compared bars (floor 2,000, `member-admission.js:59-60`), with the derived split 1,796 / 598 / 600. A JSON dump with a pinned SHA-256 feeds the Python tests; the Node PostgreSQL tests insert the same rows so the executor's digest check passes. The dataset is never a market claim: fixture parity proves mechanics only (`CONTRACT §11.2` limitation, `§11.4` last paragraph).

Members for Option A: two deployments of the reviewed SPT source with two complete 58-input snapshots differing in catalog values (for example `emaFastInput 50/200` against `21/100`), both keeping the eleven fixed settings (`member-admission.js:55`). A third snapshot equal to member 1 serves F15. The test pins each member's native BUY and exit counts so a dataset change is visible.

Option B (scripted contention, OD-MP-9): the Python and oracle cases feed hand-written `(buy, native_exit)` tuples per member directly into `combined_paper_replay`, as `test_fixed_eval.py` works its ledger values by hand (`quant_lab/tests/test_fixed_eval.py:1-13`). Cash and limits are set so the case bites: for F3 and F13 a cash balance that covers one PERCENT_EQUITY entry but not two; for F7 `maxTradesPerDay` reached by member 1; for F8 `maxDailyLossR` or `pauseAfterLossStreak` tripped by combined losses; for F4 member 2 holding the whole cash until its EXIT bar. Expected decisions are stated in the test as hand-derived values, and the oracle must agree.

### D-17. Terminal result shape (`mp-combined-result-v1`)

`{version, run_id, contract_hash, engine_hash, evaluator:"mp-combined-paper-v1", same_bar_order, plan:{algorithm, seed, requested_budget, planned_candidates, grid_combinations, plan_hash}, candidate_count, selected_dimensions, covered_dimensions, dimension_coverage_percent, candidates:[{parameters, train, validation, decision_count, fills, rejections, exit_fill_reasons, ledger_hash, screen_reasons}], selected:{... , sensitivity, cost_stress, test, screen_reasons} | null, holdout_evaluated, completion_reason, members:[{ordinal, deployment_id, funnel}], bot_funnel, cross_source_targets:0, owner_recommendation_ready:false, acceptance_blockers:contract.acceptance_blockers, fixture:true}`. The ties the store checks are present (`mp-run-store.js:148-149`). Full fills and decisions are not stored in the event: the engine is deterministic (T-P5) and each candidate carries its `ledger_hash`, so the package slice (R6) regenerates the selected candidate's traces by rerunning the `HOLDOUT` step and must reproduce the stored hash. One event holds the whole result; with at most 100 candidates (`FOUNDATION_LIMITS.candidates` via `run-contract.js:242`) and metrics only, the JSONB stays small.

### D-18. Diagnostics the executor emits for the operator

The executor returns `{ok:true, run_id, status, result_hash}` or a refusal with an allowlisted diagnostic in the RS-5 style (`fixture-service.js:51, 63-66`): no database message, path or Python text.

## 3. Proposed contract rows (for root to adopt)

| ID | Item | Proposed outcome |
| --- | --- | --- |
| RD-MP-24 | Combined evaluator module and signature | `combined_paper_replay(members, bars, shared_pair, *, model, policy, equity, cash, broker, symbol, start_time, same_bar_order)` in new `quant_lab/src/robot_quant/mp_combined.py`; returns `ledger` (the seven `paper_replay` keys) and `diagnostics` separately; one `SharedPair` object, members carry no pair (T-P3); one member accepted for T-P1; no one-Pine file edited (D-1, D-2, D-6). |
| RD-MP-25 | Combined ledger scope | One Bot ledger: cash, cost, quantity, positions by `entry_ref` with owning deployment and ordinal, one daily map, one `initial_risk`, `pnl` and `loss_streak` reset only at combined flat, as `ledger.js:248-253` and `bridge_paper.py:176-186`; `open_positions = int(quantity > 0)`; `MP_CROSS_SOURCE_TARGET` raised on an owner mismatch and reported as a count that must be 0 (D-4). |
| RD-MP-26 | Same-bar order implementation | Per bar, step every member first, then apply all EXITs by ordinal in each member's own order, then all BUYs by ordinal; events, decisions and fills in processing order; per-member `sequence`; suppression stays inside each member's `BridgeReplay.step` (D-5). |
| RD-MP-27 | Plan, steps and outcomes | `multiCandidatePlan` in `src/multi-pine/run-plan.js` reproduces `candidatePlan` on decimal-string grids with the shared pair as row 1; steps, screening, coverage, sensitivity, stress and single holdout follow the one-Pine worker; `plan_hash` in the result; terminal statuses and reason codes per D-10, existing codes only. |
| RD-MP-28 | Executor | `MultiPineFixtureExecutor.execute({owner_id, run_id})` in `src/multi-pine/fixture-executor.js`: claim by `RUNNING` event, read-only pre-flight (engine hash, policy hash, member hashes, dataset digest), one Python process per step with holdout slicing, terminal event with `mp-combined-result-v1`; no worker, lease, route or checkpoint table; listed in the RS-3 static isolation allowlist (D-11, D-12, D-17). |
| RD-MP-29 | Engine-hash closure | `MP_ENGINE_FILES` and `mpEngineHash()` in new `src/multi-pine/engine-files.js`, version `mp-combined-closure-v1` inside the hashed object; the fixture service's injected `engineHash` is this value (R12); the four proof obligations of D-13 are tests of the slice. |
| RD-MP-30 | Node oracle | New `scripts/mp-bridge-reference.mjs` (operation `combined-replay`, request `mp-oracle-request-v1`) deriving intents and order from signals with production `exitDecision`, `levels`, `evaluateRisk` and `roundBridgeOrder`; comparison thresholds per ADP "Quant baseline" with 0.01 USDT as the minor unit; `prepareBridgeExecution` untouched (D-14). |
| RD-MP-31 | Fixture data | `test/fixtures/multi-pine/` deterministic 4,000-bar labelled dataset with pinned digest for Option A, scripted per-member signals for Option B; member signal counts pinned (D-16). |

## 4. Owner-only questions

- Q-1. Streak and loss-guard scope. Because the Bot has one ledger, member 1's losing exits do not count toward the loss streak while member 2 still holds inventory, and a tripped guard pauses every member's entries. This follows the live Node ledger (`ledger.js:252-253`) and `CONTRACT §5.4`, but it is a visible product behaviour of a multi-Pine Bot. Does the owner accept it as the F11-01 definition, or should it be an APP-3B item like R6 (ordinal bias)?
- Q-2. `MP_MEMBER_NO_SIGNALS` window. OD-MP-10 says "zero native signals in the dataset". This draft counts native BUY in the train-plus-validation window only (D-15), so a member that fires only inside the holdout is still a blocker. Narrower than the owner's wording: owner confirmation needed.
- Q-3. Evidence retention. The terminal event stores metrics, funnel counts and per-candidate ledger hashes, not full fills and decisions (D-17). Full traces are regenerated by the package slice under the engine hash. Is hash-plus-regeneration acceptable as immutable research evidence, or must the fixture store the full traces of the selected candidate at run time?

Everything else in this draft is a root or engineering decision with a code or contract citation.

## 5. Where this draft departs from a conventional design, and why

1. Two return values instead of one widened dict. A conventional design adds `deployment_id` and `ordinal` to every record and funnel keys to the result, then special-cases the one-member output to satisfy T-P1. Here the ledger dict is never widened and the funnel is a sibling object, so T-P1 is a plain byte comparison and no branch exists to hide a regression (D-6, D-7). Cost: the package writer derives the member tag from the `entry_ref` prefix.
2. No one-member branch at all. Identity with `paper_replay` is a property of the order rule and of `BridgeReplay.step`, not of code that checks `len(members)`. A mutation test should prove it (D-6).
3. Narrow engine closure. The FE-2 and FOUNDATION closures include the whole runtime manifest, which rotates the hash on unrelated runtime edits. The multi closure lists the Python import closure and the Node modules that decide the run, with a traversal test to keep it complete (D-13). Root may prefer the wide manifest for uniformity; the trade is fewer spurious rotations against one more test to maintain.
4. The oracle re-derives intents and ordering from signals rather than consuming Python's intents (D-14). Stricter than the literal wording of `CONTRACT §5.6`; it catches an ordering defect in the evaluator that an intent-fed oracle would copy.
5. One Python process per step, not one per run. Costs repeated bar transfer (at most 10,000 rows per step, bounded by the 8 MiB limit) but keeps holdout rows out of every selection process, as the one-Pine worker does (D-12).
6. Claim by event, no lease. RD-MP-19 removed lease and status columns, so the `ADMITTED -> RUNNING` transition guard is the only mutual exclusion. A crashed executor leaves `RUNNING`; the operator closes it by hand. Conventional designs add a lease; for a fixture bounded by `deadline_ms` the simpler rule is enough (D-11).
7. The plan is derived, never stored. The exact-key contract cannot hold it; determinism plus `plan_hash` in the result replaces storage (D-9).

## 6. Test map (for the independent tester, `CONTRACT §15.2, §15.3`)

- T-P1: one member, scripted bars and the fixture dataset, several pairs: canonical ledger bytes and SHA-256 equal to `paper_replay`.
- T-P2: F3, F4, F6, F7, F8, F9 (same `event_id` on two members gives two distinct ledger effects because `entry_ref` differs), F13, F24 (member 1 signal tuple byte-identical after member 2 input change), F29.
- T-P3: the signature has one `SharedPair`; a `MemberSignals` with an extra pair field is a `TypeError` of the frozen dataclass.
- T-P4: `cross_source_targets == 0` over every fixture run; a hand-built allocation owned by another member raises `MP_CROSS_SOURCE_TARGET`.
- T-P5: two runs of the same request give identical canonical output and `ledger_hash`.
- T-O1: the oracle equals the combined replay on F3, F4, F7, F8, F13 and the three-member contention case within the ADP thresholds.
- Closure: the four obligations of D-13.
- Executor (PostgreSQL, one file per process): admit with RS-5, execute, read back the terminal event with `getMultiRun`; stale policy, stale member hash and changed dataset rows each give the expected `FAILED` reason; a second `execute` on the same run is refused by the transition guard; runtime role gets 42501 on every executor path.

## 7. Risks and limits of this draft

- The synthetic dataset may not drive SPT to enough BUYs on both snapshots; the generator must be shaped and the counts pinned (D-16). If it cannot, Option B scripted signals still cover every ledger case, and only the Option A end-to-end case waits for a better fixture. This is a fixture-engineering risk, not a contract gap.
- Decimal arithmetic in the Python ledger uses `amount` rounding at the same places as `paper_replay`; the Node oracle uses `money.js`. The one-Pine QL-2A comparison already tolerates 1 minor unit on cash for that reason; a combined run with more fills accumulates no more than per-fill rounding, but the tester should watch the per-fill cash maximum, not only the final cash.
- `MP_MEMBER_NO_SIGNALS` is detected only when a step runs; an earlier, pair-independent pre-step would detect it sooner at the price of one more process. Not needed for correctness.
- Nothing here is parity with live multi-Pine intake (R1), a recommendation, staging evidence or an F11-02 outcome (`CONTRACT §11.4`).
