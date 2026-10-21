# F11 combined evaluator `mp-combined-paper-v1` and RS-6 prerequisite rulings (design draft)

Author role: architecture auditor as primary designer (Opus 5.5 / high), for "Root: astra-vps-trade-bot-v2".
Base revision read: `be8e02e` (HEAD moved to `629bcb4` during the read; that commit touches only QR-2 files, none read here).
Status: proposal only. Nothing here is decided until root records it. No repository file was written.

## 0. Scope, sources and the missing local notes

This draft designs the combined Python evaluator `mp-combined-paper-v1` (RD-MP-1) and the RS-6 executor, and states each
choice as a proposed root-decision row (RD-MP-24 onward, section 12). It restates the root items that the handoff names
for RS-6 (R5, R7, R11, R12) and the package slice (R6). The owner's local notes that defined those items are not
readable from the cloud, so the mapping below is a reconstruction from the tracked contract. Root must confirm it.

| Item | Reconstructed meaning | Covered by |
| --- | --- | --- |
| R5 | Combined evaluator semantics: input shape, shared ledger, same-bar order, warm-up, one-member equivalence | D1 to D5, D9 |
| R7 | RS-6 executor path: process launch, run events, deadline, cancellation | D8 |
| R11 | Combined Quant baseline against the Node/Paper oracle and its storage | D6, D9 |
| R12 | Engine hash for multi runs (named in the RS-5 evidence: "engine_hash is injected; RS-6 decides it (R12)") | D7 |
| R6 | Multi-Pine package slice | Out of scope here; section 11 lists only the interfaces it consumes |

Sources: `docs/MULTI_PINE_CONTRACT.md` (MPC) sections 3 to 16 and RD-MP-1 to RD-MP-23; the 2026-10-21 cloud checkpoint
and handoff; code under `quant_lab/src/robot_quant/` and `src/multi-pine/`, `src/postgres/mp-run-store.*`,
`src/postgres/quant-research.js`, `src/quant-research/preflight-resolver.js`, `src/postgres/quant-fixed-eval-engine.js`
(the FE-2a closure precedent), `src/postgres/quant-research-worker.js` (the one-Pine selection flow) and
`scripts/quant-bridge-reference.mjs` (the one-Pine Node oracle).

Hard constraints this design keeps:

- No edit to any file in an existing engine closure (LEGACY, FOUNDATION, INGESTION, PF-2 engine, PF-2 evaluator, the
  runtime manifest `QUANT_RUNTIME_ENGINE_FILES`, the FE-2a closure). New files only. `quant_lab/src/robot_quant/__init__.py`
  and `src/quant-research/process-supervisor.js` (including `QUANT_IO_MODULES`) stay unchanged.
- No edit to `bridge_paper.py`, `paper_state.py`, `bridge_replay.py`, `risk_evaluator.py` or `spt_custom_evaluator.py`
  (MPC 12: "the Python evaluator's one-Pine behaviour" is out of scope).
- No edit to `prepareBridgeExecution`, `activateDeployment`, the receiver, Risk Manager, ledger sizing or any route
  (MPC 5.6, 10, T-R5). The three refusals stay (T-R1 to T-R3).
- Spot/Paper only, BINANCE:BTCUSDT Spot 1m, `paper-close-v1`, reduce-only EXIT, fixture only, no host work.

## 1. Code facts that drive the design

1. `paper_replay` (`bridge_paper.py`) and `PaperState.step` (`paper_state.py`) hold one ledger: cash, cost, position
   quantity, `initial_risk`, `pnl`, `loss_streak`, a daily map keyed by the bar's UTC day, and an allocation map keyed by
   `entry_ref`. `PaperState` is documented as the "incremental form of the unchanged serial Paper reference loop"; its
   per-intent body is identical to `paper_replay`.
2. Each ledger step takes the intents of `self.replay.step(bar, buy, native_exit)` in returned order. The ledger never
   reads `deployment_id`; it keys allocations by `entry_ref`, which `BridgeReplay` builds as `<deployment_id>:<time>:0`.
3. `BridgeReplay.step` emits that deployment's EXIT intents first (descending array traversal), then at most one BUY,
   and suppresses the BUY on its own exit bar. Suppression is per instance, so per deployment (MPC 5.3).
4. The Node Paper ledger (`src/postgres/ledger.js`) keeps one position row per Bot account and symbol: `initial_risk` and
   `cumulative_pnl` are position-level, `realized_r = profit / position initial_risk`, and `ledger_streak` changes only
   when the position quantity reaches zero. Daily trades count every fill, BUY and EXIT. So the shared-ledger semantics
   the contract asks for (MPC 5.4) are exactly the one-Pine loop fed with every member's intents.
5. `validate_custom_snapshot` selects the membership row by `source_hash` alone (`next(row for row in
   snapshot["membership"] if row["source_hash"] == SOURCE_HASH)`). Under fixture Option A both members share the SPT
   source hash, so for member 2 it would pick member 1's analysis. This is a real hazard for the combined job (D1 fixes it
   without editing the module).
6. `validate_custom_snapshot` requires the source bytes to hash to the reviewed `SOURCE_HASH`. The reviewed SPT source is
   not tracked (`tradingview/spt_pro_v4_robot_trade.pine` hashes to `48528f49…`, not `0be2c64c…`). Any end-to-end run of a
   source-bound job therefore needs private inputs (owner question OQ-1).
7. `runQuantProcess` (`process-supervisor.js`) launches any dotted module through `systemd-run --user` on Linux, refuses
   other platforms unless a test flag is set, caps the request at 8 MiB, the response at 2 MiB and each call at 30 s.
   The cloud container has no user systemd manager (checkpoint, PF-2 R4 item).
8. `mp_research_run_events` takes ADMITTED, RUNNING and five terminal states. FAILED, CANCELLED and TIMED_OUT need a
   `reason_code` and no result. SUCCEEDED and NO_VALID_CANDIDATE need a result (at most 1 MiB jsonb) that names the run's
   `run_id` and `contract_hash`, carries `owner_recommendation_ready: false` and lists `MULTI_PINE_REQUIRES_APP_3B`.
9. JS `canonical` writes numbers with `JSON.stringify`, so a float such as `1.0` becomes `1`; Python `json.dumps` keeps
   `1.0`. A cross-language hash is only safe over values without floats.
10. The FE-2a closure (`quant-fixed-eval-engine.js`) is the precedent for a versioned closure outside the research
    closures: runtime manifest plus named extra files, version inside the hashed object, and a test that the extra files
    sit in no research closure.

## 2. D1: evaluator input and output shape

### 2.1 Layers

The evaluator has two layers. Only layer B touches money.

- Layer A, member signals (per member, independent): the member's own source-bound evaluator turns rows into one boolean
  pair `(buy, native_exit)` per bar. For SPT this is `evaluate_bars(rows, inputs)` with the member's frozen inputs.
  Bridge ATR is the frozen market `atr14` of each row, never the source ATR (as `research_engine` does).
- Layer B, combined replay (pure, one pair, one ledger): `combined_replay(members, bars, *, pair, model, policy, equity,
  cash, broker, symbol, start_time)` in the new library `quant_lab/src/robot_quant/mp_combined_paper.py`.

```text
MemberSignals (frozen dataclass, closed fields):
  ordinal: int              1..N, dense, ascending
  deployment_id: str        distinct across members
  signals: tuple[(bool, bool), ...]   one (buy, native_exit) per bar, same length as bars
BridgePair (frozen dataclass): atr_multiplier: Decimal, rr: Decimal
bars: tuple[BridgeBar, ...]  shared by all members (one market, one timeframe)
```

`members` is a tuple of 2 to 3 `MemberSignals` in ascending ordinal (1 is allowed only through the T-P1 entry, 2.4).
There is no per-member Bridge field anywhere in the signature, so a per-member pair cannot be expressed (T-P3).

### 2.2 Job protocol (`robot_quant.mp_combined_job`, stdin JSON, stdout JSON)

Request `mp-combined-request-v1`, closed keys at every level:

```text
{
  version: "mp-combined-request-v1",
  evaluator: "mp-combined-paper-v1",
  closure: "mp-combined-closure-v1",
  run: {run_id, contract_hash, engine_hash, set_hash},     echoed only; Node is the binding authority
  market: {broker: "binance-global", symbol: "BTCUSDT", timeframe: "1"},
  model: {version: "paper-close-v1", price_tick, quantity_step, fee_bps, slippage_bps, risk_percent},
  policy: {the 16 node_policy names, plus the other locked-policy keys the snapshot carries},
  capital: {equity, cash},                                  decimal strings
  split: {warmup, train_end, validation_end, test_end},
  first_time: int,                                          closed-bar ms of row 0
  members: [{ordinal, deployment_id, pine_import_id, source_version, source_hash, effective_inputs_hash,
             source: <text>, snapshot: <deployment snapshot, membership projected to this member>}],
  rows: [{time, open, high, low, close, volume, atr14}],    rows 0..validation_end, or 0..test_end for HOLDOUT
  steps: [{step_id, kind, pair: {atr_multiplier, rr}}],     1..K steps; kinds CANDIDATE, SENSITIVITY, STRESS share one
                                                            row range; HOLDOUT and BASELINE run alone
  page: {offset, limit}                                     BASELINE only
}
```

Checks in the job, first failure wins, each with a short upper-case error code and no message, path or traceback
(the `fixed_eval` driver pattern):

1. Closed keys, versions, evaluator id and closure id (`MP_INPUT_INVALID`).
2. 2 to 3 members, ordinals 1..N ascending, ascending `pine_import_id`, distinct `deployment_id`
   (`MP_INPUT_INVALID`); distinct `(source_hash, effective_inputs_hash)` (`MP_MEMBER_DUPLICATE_LOGIC`, defence in depth
   behind the freeze check).
3. Per member, membership projection (fixes fact 5): the job replaces `snapshot.membership` by the one row whose
   `pine_import_id` and `source_version` equal the member's; zero or two such rows is `MP_INPUT_INVALID`. Then
   `validate_custom_snapshot(source, projected)` runs unchanged and yields `UNSUPPORTED_SOURCE_HASH`,
   `UNSUPPORTED_CUSTOM_MARKET`, `CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED`, `UNSUPPORTED_CUSTOM_SETTING:<name>` or
   `UNSUPPORTED_SIGNAL_MAPPING` as the one-Pine path does. A non-empty `selection.bindings` is
   `MP_SOURCE_SLOTS_FORBIDDEN` (no slot, so no search domain reaches the evaluator).
4. Market and model: `binance-global`, `BTCUSDT`, `1`; `paper-close-v1` (the `PaperModel` constructor refuses any other
   version). Policy keys complete for `node_policy`.
5. Rows: contiguous 60,000 ms from `first_time`, length equal to the range the step kinds require, every value finite
   and positive (`BridgeBar` checks), `atr14` present.
6. Steps: no member-level Bridge key exists in the request schema; a pair is two positive finite decimal strings. One
   HOLDOUT or one BASELINE per call, never mixed with other kinds.

Member signals are computed once per call and shared by every step of the call. Holdout rows reach the process only in a
HOLDOUT call (the worker rule "Holdout candles never enter a candidate/sensitivity/stress subprocess").

### 2.3 Output

Response `mp-combined-result-v1` (search steps, at most 2 MiB):

```text
{
  version, evaluator, closure, run (echo),
  member_signals: [{ordinal, deployment_id, signals_hash, native_buy, native_exit}],   counted on rows warmup..end of call
  steps: [{
    step_id, kind, pair,
    train, validation, test?,                        Bot-level mark_period metrics (ql3a.mark_period, unchanged)
    bot: {decision_count, fills, rejections{reason: n}, exit_fill_reasons{SL,TP,NATIVE}},
    funnel: [{ordinal, deployment_id, native_buy, native_exit, intents_buy, intents_exit,
              suppressed_buy{exit_bar, no_atr, invalid_levels}, accepted, capped,
              rejected{reason: n}, exits{SL, TP, NATIVE}, orphan_exits{warmup_entry, refused_entry}}],
    cross_source_target: 0, duplicate_intents: 0,
    intent_stream_hash, decisions_hash,
    final_cash, position_quantity, position_cost, open_allocations
  }],
  owner_recommendation_ready: false
}
```

- Funnel counts are internal diagnostics only (OD-MP-5): counts, never returns, P&L or ranking. The job asserts that every
  Bot count equals the sum of the member counts and fails with `EVALUATION_FAILED` otherwise (MPC 5.7 "they sum to the
  Bot-level counts").
- Funnel windows start at `start_time` (D3). `signals_hash` is SHA-256 of the canonical boolean pairs of that member over
  the call's rows; F24 compares it across runs.
- `rejected` keys are the exact reason strings the decisions carry (the existing counters do the same); grouping into
  reason classes is left to the package report (root question RQ-10).
- BASELINE responses carry full tagged `events` and `decisions` (schemas in D9) for one pair, paged by decision index so
  each page stays under 2 MiB; every page repeats `decision_total`, `intent_stream_hash` and `decisions_hash`, so the
  pages bind to one stream.

### 2.4 One-member entry for T-P1

`combined_replay` itself requires 2 or more members. A separate function `combined_replay_single(member, ...)` runs the
same code path with one member and exists only so T-P1 can call it; the job never accepts one member (`MP_NOT_MULTI_PINE`
stays a freeze refusal). Both functions call one internal `_replay(members, ...)`, so the equivalence proof covers the
code the job runs.

## 3. D2: combined ledger semantics

### 3.1 Mechanism: reuse the one-Pine ledger unchanged

The combined replay subclasses `PaperState` without editing it:

```text
class _CombinedPaperState(PaperState):
    __init__: super().__init__(deployment_id=<member 1 id>, multiplier=pair.atr_multiplier, rr=pair.rr, ...)
              then self.replay = _MergedReplay(members, pair, model)
_MergedReplay.step(bar, _buy, _exit):
    for each member in ordinal order: intents_k = replay_k.step(bar, buy_k[i], exit_k[i])   (one BridgeReplay per member)
    check every intent's entry_ref belongs to its member (rsplit(":", 2)[0] == deployment_id), else raise MP_CROSS_SOURCE_TARGET
    drop an exact repeat of (deployment_id, event_type, entry_ref) inside the run (count duplicate_intents)
    return [EXITs of member 1, 2, 3 in each member's own order] + [BUYs of member 1, 2, 3]
    remember the (ordinal, deployment_id) tag of each returned intent in the same order
```

`_MergedReplay` exposes `last_time` like `BridgeReplay`. `PaperState.step` then applies its unchanged per-intent body to
the merged list. The wrapper attaches the tags to the returned events (one event per intent, same order) and to the
decisions (matched by `(event_type, entry_ref)`, unique within a bar).

Reason for reuse over a copy: the accept, cap, reject and money arithmetic stay byte-identical to the accepted one-Pine
loop, so the only new behaviour is the merge, the tags and the guard. A copy would add a second ledger that can drift.
Cost: the subclass depends on the attribute name `replay` and the `step` call; T-P1 and the closure hash catch any
change (`paper_state.py` is in the runtime manifest, so it is in the new closure). If root prefers a copy, T-P1 still
applies unchanged (RQ-8).

### 3.2 Which state is per Bot and which is per member

| State | Scope | Source of the rule |
| --- | --- | --- |
| Cash, committed cost, position quantity (one symbol) | Bot | MPC 5.4; Node `ledger_positions` per Bot account and symbol |
| `initial_risk`, `pnl` of the open position; reset to 0 when the Bot position is flat | Bot (position) | Node ledger fact 4; `PaperState` |
| `realized_r` of an EXIT = profit / Bot position `initial_risk` | Bot | Node ledger; so per-member R is not meaningful, consistent with "no per-strategy returns" (O14) |
| Loss streak: +1 when the Bot position goes flat with `pnl < 0`, else 0 | Bot | Node `ledger_streak` |
| Daily trades, notional, realized R, keyed by the bar's UTC day; trades count BUY and EXIT fills | Bot | MPC 5.4; `PaperState` |
| `open_positions` = 1 when Bot quantity > 0 (unique-symbol capacity) | Bot | MPC 5.4, risk evaluator |
| Allocation map keyed by `entry_ref`, owner deployment derivable from the key | Per allocation | MPC 5.4, CODE fact 12 |
| Pine entry arrays, 1,000-entry capacity, exit traversal, BUY suppression | Per member (`BridgeReplay` instance) | MPC 5.3, I5 |
| EXIT target | Only the member's own allocation | I4; the merged replay never emits a foreign `entry_ref` |

Consequences recorded for reviewers:

- A losing EXIT of member A while member B still holds does not move the loss streak until the Bot position is flat.
  This matches Node and is not an isolation defect.
- `one_position_per_symbol`, `max_open_positions`, daily limits and loss guards act across members by design (I9). A BUY
  they refuse is a policy skip attributed to its member in the funnel (MPC 5.4).
- Entry guards never block a reduce-only EXIT: the risk evaluator treats SELL with `reduceOnly` as an exit, and the
  merge puts every EXIT of the bar before any BUY.

### 3.3 Same-bar order `exit-first-ordinal-v1`

Per bar: step every member's `BridgeReplay` in ordinal order to obtain its intents (the Pine calculation does not depend
on the ledger, so stepping order cannot change intents), then apply in this order: all EXITs of ordinal 1, then 2, then
3, each in that member's own traversal order; then the BUY of ordinal 1, 2, 3. This is MPC 5.5 exactly. With one member
the order equals `BridgeReplay` order, which is what makes D4 possible.

### 3.4 Spot, Paper and reduce-only

The job refuses any market other than BINANCE:BTCUSDT 1m and any model other than `paper-close-v1`. Every signal the
ledger builds is Spot with leverage 1; an EXIT is `SELL` with `reduceOnly: true` and `targetTradeId`; the existing
`NEGATIVE_SPOT_LEDGER` check stays. The admission side (RS-4) already requires `paperTrading` and
`requireReduceOnlySell` in the locked policy.

### 3.5 Cross-target guard (`MP_CROSS_SOURCE_TARGET`)

Two layers: (1) the merged replay raises `MP_CROSS_SOURCE_TARGET` before the ledger sees an intent whose `entry_ref` does
not belong to its member; (2) the output counter `cross_source_target` counts EXIT fills whose allocation owner differs
from the intent's member and must be 0 (T-P4). Layer 1 makes layer 2 structurally 0; a test with a forged producer proves
layer 1 is reachable. A cross-member EXIT that the Node receiver would see (F5) is refused there with
`INVALID_ENTRY_REFERENCE` or `TARGET_NOT_OPEN`; in the Python ledger an EXIT whose key is absent is `TARGET_NOT_OPEN`.

## 4. D3: combined warm-up and ledger start

- Warm-up floor: the maximum over members of `max(1006, 5 * emaSlowInput)` (RD-MP-20, RS-4 `checkMemberSetAdmission`).
  The contract's single `dataset.warmup_bars` must be at least that floor and at most 5,000, and the dataset must keep at
  least 2,000 compared bars after it (already enforced at admission).
- Every member evaluator and every member `BridgeReplay` cold-starts at row 0 of the shared dataset. So each member
  gets at least its own floor of warm Pine state.
- One ledger start for the Bot: `start_time = first_time + split.warmup * 60000`, the closed-bar time of row
  `split.warmup`. This is the formula of `research_chunk` (`first_time + split["warmup"] * 60000`) and equals
  `rows[split["warmup"]]["time"]` of `research_engine` on a contiguous dataset.
- Intents before `start_time` are kept in `events` but never reach the ledger (unchanged `PaperState` rule). Their later
  EXITs reject with `TARGET_NOT_OPEN` and are counted as `orphan_exits.warmup_entry`.
- Per-member start times are rejected as a design: they would start the shared cash at different times for different
  members and break the one-member equivalence.

## 5. D4: T-P1 byte equality (one member equals `paper_replay`)

Target (MPC 5.4, F16): `canonical(one_pine_view(combined_replay_single(m, ...))) == canonical(paper_replay(...))`, byte
for byte, where `canonical` is `json.dumps(sort_keys=True, separators=(",", ":"), ensure_ascii=False).encode()`.

- `one_pine_view(output)` is a fixed, tested projection. It removes exactly the keys `ordinal` and `deployment_id` from
  every event and decision, and exactly the top-level keys `evaluator`, `same_bar_order`, `funnel`, `cross_source_target`
  and `duplicate_intents`. It adds, renames or reorders nothing.
- A second assertion pins the projection: the set of removed keys must equal that whitelist, and every remaining key and
  value must be present in `paper_replay`'s output. So the projection cannot hide a difference.
- Inputs: identical bars (same `BridgeBar` objects), identical `deployment_id`, pair, model, policy, equity, cash,
  broker, symbol and `start_time`.
- Cases: (a) SPT M1 inputs on the fixture bars, full range; (b) SPT M2 inputs; (c) a scripted single-member series that
  produces caps, rejections, a loss-streak pause, a daily-limit refusal and an orphan exit; (d) the STRESS model (fee and
  slippage x2). Equality also holds for `mark_period` metrics computed from both outputs.
- Why it holds: the merged replay with one member returns exactly the intents `BridgeReplay.step` returns, in the same
  order, and the ledger body is the same code (3.1). If root picks a copied ledger (RQ-8), the same test is the proof.

## 6. D5: candidate search over `bridge_domains`

### 6.1 Plan

New pure module `src/multi-pine/candidate-plan.js`, `multiCandidatePlan({bridge_domains, baseline_pair, budget, seed})`:

- Grids are canonical decimal strings: `min + i * step`, i = 0..n-1, using `decimalString` (`member-set.js`), so 0.1
  steps never pass through binary floats. The run contract already holds the domains as `{min, max, step}` strings and
  the builder checked the baseline pair is on both grids (RD-MP-18).
- Algorithm identical to `candidatePlan` (`src/quant-research/contract.js`) over grid indexes: the baseline pair first;
  then, per dimension in sorted name order (`atr_multiplier`, `rr`), the index-1 and index+1 neighbours; if
  `n_atr * n_rr <= budget`, the full grid in nested order; otherwise the same LCG
  (`state = (state * 1664525 + 1013904223) mod 2^32`, value `state / 2^32`, seeded with `seed >>> 0`) for at most
  `budget * 100` draws, deduplicated by canonical form. Algorithm labels stay `exhaustive-grid-v1` and
  `axis-covered-seeded-grid-v1`. Too small a budget for baseline plus neighbours is `INSUFFICIENT_DIMENSION_BUDGET`
  (existing code).
- The module does not call `candidatePlan` because that function filters candidates through `validParameters`, which
  compares the source EMA inputs and is meaningless for Bridge-only rows. A parity test runs both on equivalent grids
  (numeric one-Pine lock with valid EMA fixed inputs) and expects the same index sequence.
- The plan is derived from the stored contract alone (`bridge_domains`, the set's `bridge_pair`, `budget.candidates`,
  `seed`), so retries and audits rebuild the identical plan; the result stores `plan_hash`. The evaluation cap mirrors
  `evaluationsFor`: `planned + 2 * 2 + 2 + 3`; the executor refuses a step past it with `EVALUATION_BUDGET_EXCEEDED`.

### 6.2 One candidate object for all members (T-P3)

A plan row is `{atr_multiplier, rr}` and nothing else. Each step request carries one `pair`. The library builds every
member's `BridgeReplay` from that one `BridgePair`. Tests: the `combined_replay` signature has no per-member pair; the
`MemberSignals` field set is exactly `ordinal, deployment_id, signals`; the job schema refuses any extra member key; all
member replays in a run report the same `(multiplier, rr)`.

### 6.3 Selection

The executor follows the one-Pine worker (`QuantResearchWorker.run`) step for step, with the same `RULES` (the multi
contract requires them equal) and the pure `screen` and `coverage` functions:

1. CANDIDATE steps for every plan row on rows `0..validation_end`.
2. Screen against the baseline row (row 0); coverage must be 100% (both dimensions vary).
3. Order eligible rows by validation net return (desc), max drawdown (asc), canonical pair (lexical).
4. For the top row: SENSITIVITY neighbours (index-1 and index+1 per dimension, reusing CANDIDATE results when the pair
   was already evaluated), then STRESS (fee and slippage x2, the `research_engine` factor).
5. HOLDOUT exactly once, only if sensitivity and stress pass, on rows `0..test_end`.
6. Completion reasons as in the worker: `NO_VALID_TRAIN_VALIDATION_CANDIDATE`, `CANDIDATE_FAILED_CHECKS`,
   `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`; then the baseline (D6) decides between SUCCEEDED and NO_VALID_CANDIDATE.

## 7. D6: combined baseline and `MP_COMBINED_BASELINE_FAILED`

### 7.1 When the baseline runs

After the holdout, for the selected pair only, the executor sends one BASELINE request (paged) over rows
`0..validation_end` and runs the Node oracle (D9) on the same bars, member signals, pair, model, policy, capital and
`start_time`. The range excludes the holdout so the holdout keeps its single evaluation (RQ-3 if root wants the full
range). The tagged member signals for the oracle come from the BASELINE response; the oracle checks Bridge and ledger
mechanics, while native signal parity stays per-member evidence (MPC 5.2, C4).

### 7.2 Failure conditions

`mp-combined-baseline-v1` compares, extending `ql2a.compare_replays`. Any one of these fails it:

- Intent stream: count differs; any `(ordinal, deployment_id, event_type, time, entry_ref, sequence, reason)` differs;
  any BUY `sl` or `tp` differs by any tick; `intent_stream_hash` differs.
- Decisions: count differs; any outcome or reason differs (accept, cap, reject must match 100%); any `entry_ref` differs
  (allocation target mismatch must be 0); any quantity differs (0 venue steps); any fee differs; any FILLED price differs
  by a tick; sizing outcome or adjustment reason or quantities differ.
- Money: per-entry cash difference above 0.01 USDT (1 minor unit, the `compare_replays` bound); final cash or final
  position cost difference above 0.01; final quantity or open allocation count differ.
- Multi-only: per-member funnel counts differ; `cross_source_target` or `duplicate_intents` is non-zero on either side.

Decimal fields are compared as decimals, never as strings (Python `amount` and JS `amount`/`exact` may format differently).

### 7.3 Storage and outcome

- The baseline record goes into the terminal run result under `combined_baseline`:
  `{version: "mp-combined-baseline-v1", pair, range: [0, validation_end], compared_decisions, intent_stream_hash,
  python_decisions_hash, node_decisions_hash, differences{...}, per_entry_cash_max_delta, final_cash_delta,
  final_position_cost_delta, matched}`. Only hashes and counts are stored, so the result stays far below 1 MiB.
- Matched: the run ends SUCCEEDED with `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`.
- Not matched: the run ends NO_VALID_CANDIDATE with `completion_reason: "MP_COMBINED_BASELINE_FAILED"`, the selected row
  kept with that screen reason and the full baseline record. NO_VALID_CANDIDATE is chosen over FAILED because a FAILED
  event cannot carry a result (fact 8) and the diff would be lost (RQ-7).
- Package gate C4 (R6 slice) reads `combined_baseline` from the run result and refuses `MP_COMBINED_BASELINE_FAILED`
  (non-retryable) unless `matched` is true and its hashes tie to the run. A SUCCEEDED result without the block cannot be
  written (the executor's result validator requires it), so a "missing baseline" case does not arise; C4 still fails
  closed on it with the same code.
- No new table in RS-6. The R6 slice decides whether C4 also copies the record into its append-only validation rows.

## 8. D7: engine hash for multi runs (`mp-combined-closure-v1`)

### 8.1 Closure

New module `src/multi-pine/engine-closure.js`, modelled on FE-2a:

```text
MP_COMBINED_CLOSURE_VERSION = "mp-combined-closure-v1"
MP_COMBINED_ONLY_FILES = [
  quant_lab/src/robot_quant/mp_combined_paper.py,
  quant_lab/src/robot_quant/mp_combined_job.py,
  src/multi-pine/candidate-plan.js,
  src/multi-pine/combined-oracle.js,
  src/multi-pine/engine-closure.js,
  src/multi-pine/executor.js,
  plus every file in the Node import closure of executor.js, combined-oracle.js and candidate-plan.js that is not in
  the runtime manifest or SHARED_APPLICATION_FILES (expected: src/multi-pine/codes.js, member-set.js, run-contract.js,
  src/postgres/mp-run-store.js, src/postgres/risk.js, src/pine-bridge/contract.js,
  src/postgres/pine-bridge-execution.js, src/quant-library/package-gates.js; the test computes the real set)
]
MP_COMBINED_ENGINE_FILES = sorted(unique(QUANT_RUNTIME_ENGINE_FILES + MP_COMBINED_ONLY_FILES))
mpCombinedEngineHash(readFile) = hash(canonical({version, files: {path: sha256(bytes)}}))
```

The run contract's `engine_hash` is this value. RS-5 already takes `engineHash` from the constructor; the operator
script and the tests pass `await mpCombinedEngineHash()`. The executor recomputes it before RUNNING, before every
evaluator call and before the terminal append, and ends the run FAILED with `QUANT_ENGINE_CHANGED` on a mismatch (the
worker's code).

### 8.2 Proof that existing closures do not change

1. Static: new test `test/mp-engine-closure.test.js` (mirrors `fixed-eval-engine.test.js`) asserts every
   `MP_COMBINED_ONLY_FILES` entry is absent from `LEGACY_ENGINE_FILES`, `FOUNDATION_ENGINE_FILES`,
   `INGESTION_ENGINE_FILES`, `PF2_ENGINE_FILES`, `PF2_EVALUATOR_FILES`, `QUANT_RUNTIME_ENGINE_FILES` and
   `FIXED_EVAL_ENGINE_FILES`; that `QUANT_IO_MODULES` still has exactly its two modules; that the Python import closure
   of `mp_combined_job` and the Node import closure of the new modules are inside the new closure or the shared
   boundary; that no runtime root and no other source file imports the new Node modules; that the version is inside the
   hash, a changed byte in any listed file rotates it, a missing file fails closed, and the value differs from every
   research hash.
2. Hash stability: the root final pass records the six existing closure hashes (`engineHash(false)`,
   `engineHash(true)`, `ingestionEngineHash()`, PF-2 `engine_hash` and `evaluator_hash`, `fixedEvalEngineHash()`) at
   the base revision and at each slice head and requires equality; the evidence record carries both lists. The existing
   W4 test keeps pinning the LEGACY and PF-2 evaluator lists.
3. Diff check (T-R5 extension): `git diff --name-only <base>..<head>` intersected with the union of the existing closure
   lists must be empty. Adding a new Python module cannot change a closure because every list is explicit and no test
   enumerates the `robot_quant` directory.

## 9. D8: RS-6 executor path

### 9.1 Module and runner

New `src/multi-pine/executor.js`, `MultiPineFixtureExecutor`. Constructor (config only, never request input): the
fixture-role `db`, the `Store` on the same handle, `clock`, `runEvaluator(payload, signal)`, `engineHash()` (the closure
function), and limits `{stepsPerCall (default 10), callTimeoutMs (<= 30000)}`. Method `execute({owner_id, run_id},
{signal})`; method `sweep({owner_id, run_id})` for recovery.

Two runners, one protocol:

- Operator fixture script `scripts/mp-fixture-run.mjs` (new): `runEvaluator = payload =>
  runQuantProcess({payload, module: "robot_quant.mp_combined_job", timeoutMs: 30000, limits:
  DEFAULT_PROCESS_LIMITS, signal})`, unchanged supervisor, no I/O controls (the job is not an I/O-protocol module, so
  `QUANT_IO_MODULES` stays as is). It runs only where `systemd-run --user` works; elsewhere it refuses as the supervisor
  does, with no fallback. It requires an explicit isolated-cluster flag and a fixture-role connection string.
- Test runner `test/helpers/mp-python-runner.mjs` (new, test-only): spawns the venv Python with
  `-m robot_quant.mp_combined_job`, `PYTHONPATH` as `pythonEvaluation` sets it, the same 8 MiB request cap, 2 MiB
  response cap, 30 s timeout and stderr discard. Tests that need it skip without Python unless `MP_REQUIRE_PYTHON=1`,
  which makes them fail (the PF-2 pattern).

The in-process runner is not a seam inside a gate module: the executor takes the runner as configuration, like the
worker's `evaluate` option. A Node stub runner stays mechanics-only (RD-MP-4).

### 9.2 Sequence

1. `getMultiRun` (owner-scoped, re-checks contract, hashes, member set and events). Status must be ADMITTED; anything
   else returns without writing.
2. Deadline: `clock() >= deadline_ms` appends TIMED_OUT with `JOB_DEADLINE_EXCEEDED`.
3. Engine hash equal, else FAILED `QUANT_ENGINE_CHANGED`. Member-set freshness (`memberSetFreshness` with the same
   readers RS-5 uses, in a SERIALIZABLE read), else FAILED `MP_MEMBER_SET_STALE`.
4. Claim: `appendRunEvent(RUNNING)`. A concurrent executor loses on the transition guard (RUNNING after RUNNING is not an
   edge) and stops without further writes. This is the only lease; the run store has none.
5. Materialize, read-only: bars from `pine_market_bars` over the contract range, checked against `CONTENT_DIGEST_SQL`
   (count equals `bar_count`, digest equals `content_digest`, no bad row); each member's source revision and deployment
   snapshot, checked against the contract member (`source_hash`, `hash(canonical(snapshot)) ===
   deployment_snapshot_hash`); the policy from member 1's snapshot with `hash(canonical(policy)) === policy_hash` (all
   members carry the same policy hash, RS-1 freeze rule). All hash binding happens in Node; the job only echoes.
6. Plan (D5), then CANDIDATE steps in batches of `stepsPerCall` on rows `0..validation_end`.
7. Zero-signal blocker (OD-MP-10): if any member has `native_buy == 0` on rows `warmup..validation_end`, FAILED
   `MP_MEMBER_NO_SIGNALS` (RQ-4 for the exact definition). The holdout is not inspected for this check.
8. Screen, sensitivity, stress, holdout once, baseline (D5, D6). Before every call: deadline, engine hash, freshness.
9. Terminal append, with a result validated against `mp-research-result-v1` before the write: SUCCEEDED or
   NO_VALID_CANDIDATE with `{run_id, contract_hash, owner_recommendation_ready: false, acceptance_blockers:
   contract.acceptance_blockers, evaluator, closure: {version, hash}, search: {algorithm, seed, budget, planned,
   grid_combinations, plan_hash, coverage}, candidates: [{pair, train, validation, screen_reasons, bot}], selected,
   holdout_evaluated, completion_reason, member_signals, funnel (selected pair), combined_baseline}`.
10. Errors map to FAILED with an allowlisted `reason_code`: the worker codes `EVALUATION_FAILED`,
    `INVALID_EVALUATION_RESPONSE`, `EVALUATION_TIMED_OUT`, `EVALUATION_OUTPUT_TOO_LARGE`, `QUANT_PYTHON_UNAVAILABLE`,
    `QUANT_ENGINE_CHANGED`, `EVALUATION_BUDGET_EXCEEDED`, plus the job codes of 2.2 and `MP_MEMBER_SET_STALE`,
    `MP_MEMBER_NO_SIGNALS`, `MP_CROSS_SOURCE_TARGET`. An abort appends CANCELLED `RESEARCH_INTERRUPTED`.
11. Recovery: no steps table and no checkpoint. A crash leaves RUNNING; `sweep` appends TIMED_OUT
    `JOB_DEADLINE_EXCEEDED` once the deadline passes. A rerun is a new admission with a new idempotency key; the plan and
    results are deterministic, so nothing is lost but time.

### 9.3 What stays closed

- `acceptance_blockers` always contain `MULTI_PINE_REQUIRES_APP_3B` (the run-store guard also refuses a result without
  it). `owner_recommendation_ready` is always false.
- No route, worker, view or runtime root imports the executor, the oracle, the plan or the closure module. The static
  isolation test and the run-contract import guard gain exact allowlist entries for the new importers (root edits and
  verifies the guards, as X1 and D7 did).
- `MULTI_PINE_RESEARCH_NOT_SUPPORTED` and both `MULTI_PINE_REQUIRES_APP_3B` refusals are untouched; T-R1 to T-R3 run in
  the executor's PostgreSQL suite after a full run (F22). F23's side-effect digest covers the run: only
  `mp_research_run_events` gains rows.

### 9.4 Runtime budget

The deadline is bounded at 900 s (RD-MP-19 table check). Each call recomputes member signals (3 members x up to 10,000
SPT bars) and then runs its steps. With `stepsPerCall` 10 the worst case is about 11 CANDIDATE calls plus 3 to 5 others.
S1 must measure the wall time of one call with 3 members on 10,000 bars and record it. If 100 candidates do not fit 900
s, fixture runs use a smaller budget (the fixture plan needs about 25) and root decides any later change (RQ-5); the
executor never raises the deadline itself.

## 10. D9: shared intent and decision schema (Python output and Node oracle input)

`mp-intent-v1`, one record per intent, ordered by bar time and then `exit-first-ordinal-v1`:

```text
{ordinal: int, deployment_id: str, event_type: "BUY" | "EXIT", time: int (closed-bar ms),
 entry_ref: str (^<deployment_id>:<time>:0$), sequence: int (member-local Pine sequence),
 reason: null | "SL" | "TP" | "NATIVE", sl: str | null, tp: str | null}
```

`mp-decision-v1` = the intent fields plus `outcome` (`FILLED` | `REJECTED`), `reason`, `quantity`, `fee`, and for
FILLED `sizing_outcome`, `sizing_adjustment`, `price`, `notional`, `cash`, `cost`, `realized_r`. These are the
`paper_replay` decision keys plus the two tags, so `one_pine_view` maps them back.

`intent_stream_hash` = SHA-256 over UTF-8 canonical JSON of the ordered list. The schema has only integers below 2^53,
ASCII strings and null, so JS `canonical` and Python `json.dumps(sort_keys=True, separators=(",", ":"),
ensure_ascii=False)` produce the same bytes (fact 9). Deployment ids are restricted to the identifier pattern the run
contract already uses. Decisions are compared field by field as decimals and are hashed only for identity on each side.

Oracle `src/multi-pine/combined-oracle.js` (pure, new, written by a different agent than the Python library):

- Input `mp-oracle-input-v1`: `{bars (decimal strings incl. atr14), members: [{ordinal, deployment_id, signals}], pair,
  model, policy, capital, broker, symbol, start_time, same_bar_order}`.
- It regenerates each member's intents with the production pure functions (`levels`, `exitDecision`, `executionPrice`
  from `src/pine-bridge/contract.js`), merges them by `exit-first-ordinal-v1`, and runs the decision path with
  `evaluateRisk` (`src/postgres/risk.js`) and `roundBridgeOrder` (`src/postgres/pine-bridge-execution.js`), keeping Bot
  state with the Node ledger rules of fact 4. One-member output must equal `scripts/quant-bridge-reference.mjs`
  `replay` (that script is not edited).
- It is the same independence model the one-Pine baseline used (`ql2a`), extended to members. `prepareBridgeExecution`
  is never called or edited.
- "Isolated PostgreSQL cluster" (MPC 5.6, 15.3) is met two ways: T-O1 runs inside the PostgreSQL test process, and one
  ledger-anchor test applies a short scripted two-member sequence (about 10 fills, one UTC day) through the real
  `recordExecution` on a fixture Bot in an isolated cluster and compares position `initial_risk`, `cumulative_pnl`, cash,
  allocation remaining quantities, `ledger_streak` and daily trades and notional with the oracle state after each fill.
  The real ledger stamps days with the wall clock, so the anchor cannot test a day rollover; the pure oracle covers it.
  Root may drop the anchor (RQ-2).

## 11. D10: fixture data plan (MPC 11.2)

| Item | Plan |
| --- | --- |
| Bars | `test/fixtures/mp-combined/bars-v1.json`: 6,000 deterministic synthetic closed 1m bars labelled BINANCE:BTCUSDT, provenance `{profile: "closed-ohlcv-atr14-v1", source: "synthetic fixture mp-combined-v1", fixture: true}`, each row with `atr14`, `price_tick` 0.01 and `quantity_step` 0.00001. Generated by `scripts/build-mp-fixture-bars.mjs` from a fixed seed with trend, pullback and chop regimes; `atr14` from the project's existing `closed-ohlcv-atr14-v1` derivation, not a new formula. A manifest pins the file SHA-256. Python tests and the PostgreSQL loader read the same file. |
| Signal floor | Before use, each Option A member must have at least 15 native BUY in each of train, validation and test after warm-up. If the generator misses it, change the regimes, never the gates. |
| Member M1 | Reviewed SPT Spot v4 Custom inputs, defaults (EMA 50/200 and the rest of `CustomSignalInputs`). |
| Member M2 | Same source hash, different complete effective inputs: for example `emaFastInput` 34, `emaSlowInput` 250, `stFactorInput` 2.8, `zoneAtrMultInput` 1.0, `cooldownInput` 5, inside the `CATALOG` ranges. The 11 fixed Custom settings and the signal mapping are unchanged, so `MP_MEMBER_DUPLICATE_LOGIC` does not fire. |
| Warm-up and split | Floor `max(1006, 5 * 200, 5 * 250) = 1250`; `warmup_bars` 1,250; compared 4,750; split 2,850 / 950 / 950 bars. |
| Member M3 | Equal to M1 in both hashes under a new `pine_import_id`: the F15 duplicate case. |
| Zero-signal variant | An M2 input set (found in S1) that emits no BUY on rows `warmup..validation_end`, for F29. |
| Option B | `test/fixtures/mp-combined/scripted-cases-v1.json`: short bar series (60 to 200 bars) with explicit per-member boolean vectors and tight policies for F3, F4, F5, F6, F7, F8, F9 and F13, labelled `fixture_source: "scripted-signals-v1"`, mechanics only, fed to the library layer (no source gate). This reads OD-MP-9 (B) "synthetic allowlist sources" as scripted signal vectors, as PF-2 S1 did with its 9 scripted oracle cases (OQ-2). |
| Private inputs | The reviewed SPT source bytes and the two complete 58-input reviewed effective-input analyses are not committed. `test/fixtures/mp-combined/private-inputs.manifest.json` holds only their SHA-256 and the expected `effective_inputs_hash` values. End-to-end job tests read them from an ignored directory named by an environment variable and skip without it unless `MP_REQUIRE_PRIVATE=1` (OQ-1). |

Library-level Python tests use `evaluate_bars` with M1 and M2 `CustomSignalInputs`, which is the source-bound SPT
evaluator code; only the source-bytes identity gate needs the private inputs.

## 12. Proposed root-decision rows

| ID | Item | Proposed outcome |
| --- | --- | --- |
| RD-MP-24 | Combined evaluator I/O (D1, D9) | `mp-combined-paper-v1` has two layers: per-member signals and one pure `combined_replay(members, bars, *, pair, model, policy, equity, cash, broker, symbol, start_time)` with `MemberSignals{ordinal, deployment_id, signals}` and one `BridgePair`. Job `robot_quant.mp_combined_job` takes `mp-combined-request-v1` (closed keys, 2 to 3 members, one pair per step, steps batched per call, HOLDOUT and BASELINE alone) and returns `mp-combined-result-v1` with Bot metrics, per-member funnel counts that sum to Bot counts, `cross_source_target`, `intent_stream_hash` and `decisions_hash`. The job projects each member snapshot's `membership` to that member's own row before `validate_custom_snapshot`, because that function matches by source hash only and Option A members share one. Intent schema `mp-intent-v1` and decision schema `mp-decision-v1` are shared with the Node oracle; the intent hash is cross-language safe because the schema has no floats. |
| RD-MP-25 | Combined ledger (D2) | One Bot ledger implemented by subclassing `PaperState` with a merged replay; no ledger code is copied or edited. Cash, cost, position quantity, position `initial_risk` and `pnl` (reset when the Bot position is flat), loss streak, daily counters and `open_positions` are per Bot, matching the Node ledger; Pine arrays, capacity, BUY suppression and EXIT targets are per member. Order `exit-first-ordinal-v1`: all EXITs by ordinal in each member's own order, then BUYs by ordinal. A foreign `entry_ref` raises `MP_CROSS_SOURCE_TARGET` before the ledger; the fill counter must stay 0. Spot, `paper-close-v1`, reduce-only EXIT only. |
| RD-MP-26 | Combined warm-up (D3) | One `warmup_bars` at least the maximum member floor `max(1006, 5 * emaSlowInput)`; all members cold-start at row 0; one ledger start `first_time + warmup * 60000`; pre-start intents stay in events only. |
| RD-MP-27 | One-member equivalence (D4, T-P1) | `canonical(one_pine_view(combined_replay_single(...)))` equals `canonical(paper_replay(...))` byte for byte on four cases, with the projection's removed-key whitelist pinned by its own assertion. |
| RD-MP-28 | Candidate search (D5) | New pure `multiCandidatePlan` over decimal-string grids, the `candidatePlan` algorithm on indexes (same labels, same LCG), parity-tested against `candidatePlan`; plan derived from the stored contract only; evaluation cap `planned + 9`; selection, sensitivity, stress and single holdout as `QuantResearchWorker.run`. One pair object per step for all members. |
| RD-MP-29 | Combined baseline (D6) | After the holdout, a paged BASELINE replay of the selected pair on rows `0..validation_end` against the pure Node oracle; failure conditions per section 7.2 with the 0.01 USDT cash bound; record `mp-combined-baseline-v1` (hashes and counts) stored in the terminal result. Not matched ends NO_VALID_CANDIDATE with `completion_reason: MP_COMBINED_BASELINE_FAILED`; C4 refuses `MP_COMBINED_BASELINE_FAILED` unless `matched`. |
| RD-MP-30 | Engine hash (D7, R12) | New closure `mp-combined-closure-v1` in `src/multi-pine/engine-closure.js`: runtime manifest plus the multi-only files and their audited import closure, version inside the hash. Existing closures unchanged: static absence test, before/after hash equality of six closures in the final pass, and an empty intersection of the diff with every existing closure list. |
| RD-MP-31 | Executor (D8, R7) | `MultiPineFixtureExecutor.execute` in `src/multi-pine/executor.js` with an injected runner: `runQuantProcess` in the operator fixture script (Linux with user systemd only, no fallback), a direct-spawn test runner for local and cloud tests. RUNNING is the claim; deadline, engine hash and freshness checked before every call and before the terminal append; terminal results validated; allowlisted reason codes; no checkpoint, `sweep` times out a stale RUNNING. `MULTI_PINE_REQUIRES_APP_3B` always in the blockers; no runtime root imports the new modules. |
| RD-MP-32 | Fixture data (D10) | Committed 6,000-bar synthetic dataset with a pinned hash; M1, M2, M3 and a zero-signal variant as in section 11; Option B as scripted signal vectors; private reviewed inputs referenced by hash only. |
| RD-MP-33 | Slices and routing | S1 Python library, job and fixtures; S2 Node oracle and baseline tests; S3 plan, closure, executor and script. High-risk accounting and parity: coder plus tester plus Opus auditor per slice (RD-MP-7); the S2 oracle writer is not the S1 writer. |

## 13. Test plan

| Test | Where | Content |
| --- | --- | --- |
| T-P1 | `quant_lab/tests/test_mp_combined_paper.py` | Section 5: four cases, byte equality, projection whitelist, metric equality. |
| T-P2 | same | F3 cash contention (ordinal 1 filled, ordinal 2 rejected or capped, funnel attribution); F4 exit-first frees cash; F5 forged cross target rejected, member 2 allocation unchanged, counter 0; F6 suppression only on the exiting member; F7 shared daily BUY limit refuses member 2 BUY and accepts member 2 EXIT; F8 combined losses pause all entries and exits continue, no reset; F9 duplicate intent dropped with zero effect, same per-member event on member 2 distinct; F13 three members in order 1, 2, 3; F24 member 1 `signals_hash` unchanged when M2 inputs change; F29 library reports `native_buy` 0. Every case asserts the merged order. |
| T-P3 | same | Signature and dataclass field sets; job schema refuses a member-level pair key; all member replays share one `(multiplier, rr)`. |
| T-P4 | same plus every fixture run | `cross_source_target == 0`; a forged producer proves the guard raises. |
| T-P5 | same | Two runs give identical canonical output and hashes; also under two `PYTHONHASHSEED` values in subprocesses; members out of ordinal order are refused, not reordered. |
| Job tests | `quant_lab/tests/test_mp_combined_job.py` | Closed keys, version and closure ids, membership projection (member 2 validated against its own analysis; two matching rows refused), slots forbidden, holdout rows only in HOLDOUT, batch steps share signals, BASELINE paging binds to one stream, error codes allowlisted. Private-input cases skip without the inputs. |
| T-O1 | `test/multi-pine-combined-oracle.test.js` (pure) and `test/postgres/mp-combined-baseline.test.mjs` (Python and isolated PostgreSQL) | F3, F4, F7, F8, F13 scripted plus the M1+M2 fixture run: accept, cap, reject 100%; allocation target mismatches 0; quantity 0 steps; cash within 0.01; intent hashes equal. Mutations that must fail the comparison: one quantity step, one swapped same-bar order, a 0.02 cash drift, a wrong ordinal tag. One-member oracle equals `quant-bridge-reference.mjs`. Ledger anchor through `recordExecution` (RQ-2). |
| Plan | `test/multi-pine-candidate-plan.test.js` | Decimal grids, baseline first, neighbours, exhaustive versus seeded, parity with `candidatePlan`, determinism, budget refusal. |
| Closure | `test/mp-engine-closure.test.js` | Section 8.2. |
| Executor | `test/postgres/mp-executor.test.mjs` | Full run to SUCCEEDED and NO_VALID_CANDIDATE (F20); F28 blockers and counts; F29 FAILED `MP_MEMBER_NO_SIGNALS`; deadline TIMED_OUT; two executors race, one RUNNING; engine change FAILED; stale set FAILED; abort CANCELLED; holdout called at most once and never in other payloads; result size; F23 digest; T-R1 to T-R3 after the run. |
| Regression | final pass | Every importer of a changed module, the full unit suite, grant tests, the six closure hashes before and after. |

## 14. Slices, files and writers (one writer per file)

| Slice | Writer | New files | Edited files |
| --- | --- | --- | --- |
| S1 evaluator and fixtures | Coder A (Python) | `quant_lab/src/robot_quant/mp_combined_paper.py`, `quant_lab/src/robot_quant/mp_combined_job.py`, `quant_lab/tests/test_mp_combined_paper.py`, `quant_lab/tests/test_mp_combined_job.py`, `quant_lab/tests/mp_scripted_driver.py` (test-only driver the Node tests spawn), `scripts/build-mp-fixture-bars.mjs`, `test/fixtures/mp-combined/bars-v1.json`, `scripted-cases-v1.json`, `manifest.json`, `private-inputs.manifest.json` | none |
| S2 oracle and baseline | Coder B (Node, not Coder A) | `src/multi-pine/combined-oracle.js`, `test/multi-pine-combined-oracle.test.js`, `test/postgres/mp-combined-baseline.test.mjs` | none |
| S3 executor | Coder C (or B after S2 lands) | `src/multi-pine/candidate-plan.js`, `src/multi-pine/engine-closure.js`, `src/multi-pine/executor.js`, `scripts/mp-fixture-run.mjs`, `test/helpers/mp-python-runner.mjs`, `test/multi-pine-candidate-plan.test.js`, `test/mp-engine-closure.test.js`, `test/postgres/mp-executor.test.mjs` | Guard allowlists only, by root: `test/multi-pine-run-contract.test.js`, `test/mp-run-store-static-isolation.test.js` if they flag the new importers |
| Docs | Root or Sonnet documentation | contract rows RD-MP-24 onward, evidence records, Roadmap and Time Management lines | `docs/MULTI_PINE_CONTRACT.md` and status files |

Order: S1 and the S2 pure oracle can run in parallel (different packages; S2 tests that spawn Python wait for S1's
driver). S3 starts after S1's job protocol and S2's oracle API are frozen, because the closure lists their files. Each
slice: coder, independent tester, Opus auditor (accounting and parity), final sole-runner pass by root.

## 15. Open questions

### Owner only

- OQ-1 Private inputs and acceptance machine. MPC 11.4 item 2 needs the source-bound job, which needs the private
  reviewed SPT source and two complete reviewed 58-input analyses (fact 6). Where does the F1 to F30 end-to-end run
  happen: (a) the owner's local checkout (Windows, direct runner only), (b) this cloud environment with the private
  inputs placed as ignored files by the owner, or (c) a Linux machine with user systemd (the only option that exercises
  `runQuantProcess`; any host is an operations step under a fresh GO)? And may the second, varied analysis carry a
  fixture review (`reviewed_by` naming the fixture) rather than an owner review?
- OQ-2 Option B reading. OD-MP-9 (B) says "synthetic sources from the evaluator allowlist". This design uses scripted
  per-member signal vectors at the library layer for the contention cases (as PF-2 S1 did). Confirm, or name the
  allowlisted synthetic source to use instead.

### Root

- RQ-1 Confirm the R5, R7, R11, R12, R6 mapping (section 0).
- RQ-2 Oracle reading of "isolated PostgreSQL cluster": pure oracle inside the PostgreSQL test process plus the
  `recordExecution` ledger anchor, or drop the anchor.
- RQ-3 Baseline range `0..validation_end` (keeps the single holdout evaluation) or the full dataset.
- RQ-4 Zero-signal definition: native BUY count 0 on rows `warmup..validation_end`, FAILED `MP_MEMBER_NO_SIGNALS`.
- RQ-5 Runtime: fixture budget about 25 candidates; measure one 3-member 10,000-bar call in S1 before any change to the
  900 s bound (RD-MP-19).
- RQ-6 Bars read from `pine_market_bars` with the content-digest check, instead of the FOUNDATION dataset store files.
- RQ-7 Baseline failure as NO_VALID_CANDIDATE with the stored diff, not FAILED.
- RQ-8 `PaperState` subclass versus a copied ledger.
- RQ-9 Root-owned guard allowlist edits in S3.
- RQ-10 Funnel `rejected` keyed by exact reason text; class grouping deferred to the package report.

## 16. Top risks

1. Option A membership ambiguity in `validate_custom_snapshot` (fact 5): without the projection, member 2 is validated
   against member 1's analysis. The projection and its test are mandatory.
2. Acceptance blocked by private inputs (fact 6) until OQ-1 is answered; CI and cloud can run only the library layer and
   scripted cases end to end.
3. Runtime: 3 members x 10,000 bars per call against the 30 s call cap and the 900 s deadline. Unmeasured.
4. `runQuantProcess` needs Linux with user systemd; the owner's Windows machine and this container cannot run the
   operator script, so acceptance evidence comes from the direct runner.
5. The Node oracle reimplements ledger transitions; its independence rests on a different writer, production pure
   functions and the ledger anchor.
6. Subclassing `PaperState` couples to its attribute names; T-P1 and the closure hash detect drift.
7. Result size limits (1 MiB stored, 2 MiB per response) force hashes in the result and paging in BASELINE.
8. Ordinal order favours member 1 under tight cash (MPC R6); the funnel makes it visible, nothing removes it.
9. Synthetic bars may not make SPT emit enough signals; the generator must be tuned before any gate is evaluated.
