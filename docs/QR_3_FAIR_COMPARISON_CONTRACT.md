# QR-3 full fair comparison contract

Status: owner decisions OD-C1 to OD-C22 recorded 2026-10-19; root decided RD-1 to RD-10 the same day. Root
accepted the other rules after independent review. Root recorded clarifications RC-C1 to RC-C27 on 2026-10-19
from the S1 review (section 15, "Root clarifications"); two owner items stay open (OPEN-1, OPEN-2) and fail
closed. The S1 pure module (src/comparison) is root-accepted as local engineering evidence and is not wired into any route, worker or view. Root split slice S2 into S2a, S2b and S2c on 2026-10-20 (RC-C28). Root decided the S2c table design the same day (RC-C37 to RC-C42). S2a, the shared exposure register extension with its one writer, one reader and adapters, is root-accepted as local engineering evidence; it is not installed on staging, and no route, worker or view writes or reads it yet. Nothing here grants a
ranking, label, recommendation, apply or Bot action. This contract is not a GO. Each implementation step
still needs its own gates and approvals.

Feature: PM-1 F10-02 "QR-3 full fair comparison". Target: staging.

Revision read: `HEAD` `910b8f9` on branch `codex/app3a-market-wait-checkpoint`. QR-2 and QL-4B/QL-4C contracts
are committed at this revision. The 2026-10-19 PKG amendment (OD-19, OD-20) and the QR-4 contract
(`docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md`) were read before commit. Line numbers teach interfaces only.

This contract changes no Roadmap row and earns no PM-1 credit by itself (decision RD-4).

---

## 0. Reading key

- `[SRC: path § section]` marks a rule taken from a source. Paths are relative to the repository.
- `CODE:` marks a fact read from current code. Code facts teach interfaces; they are not acceptance evidence.
- "Decision OD-Cn" and "Decision RD-n" point to the Decisions table in section 15.
- Short names: ROADMAP = `docs/ROADMAP.md`; QRL = `docs/QUANT_RESEARCH_LIBRARY.md`;
  PKG = `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (accepted); QR2 = `docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md`
  (owner-decided); INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`;
  SC = `docs/progress/PM1_SCORECARD_S1_2026-10-15.json`; DERIVE = `src/quant-library/derive.js`;
  LIB = `src/postgres/quant-library.js`.

Scope guard for every rule below [SRC: AGENTS.md § Host and product safety; PKG § 9]: Spot/Paper only,
BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, no Live, no automatic optimizer loop, no guard reset, no automatic
Best Inputs apply, independent holdout gates. No QR-3 output is a profitability claim. Development scores are
never qualified recommendations. `NO_VALID_CANDIDATE` is a valid run outcome and "no qualified winner" is a
valid comparison outcome. Viewing a comparison never starts or changes a Bot. [SRC: QRL § Strategy Comparison
and Best Performance; ROADMAP row QR-3]

---

## 1. Purpose, acceptance and current state

### 1.1 Acceptance target

F10-02 acceptance: "Complete declared-period comparisons enforce compatible data, policy, cost and validation
contexts." [SRC: INV F10-02]

SC gives F10-02 D UNKNOWN, I 0, V 0, T 0. D rationale: the approved QR-3 design requires a fixed objective,
common valuation and ranking rules; a complete final contract is not evidenced. Next action: "Define complete
common context and independent evidence, then QR-3." Carry limitation: no double credit for the minimal
comparison as a completed full comparison. [SRC: SC F10-02]

ROADMAP QR-3 gate as testable rules [SRC: ROADMAP § Approved extension, row QR-3]:

- A1 Compatible market, period, capital, cost, valuation and risk assumptions across every ranked participant.
- A2 Independent evaluation provenance is recorded for every participant.
- A3 Sample adequacy and ranking rules are fixed before the comparison is evaluated.
- A4 No qualified winner is a valid result.
- A5 Strategies for the same asset under a declared common evaluation context, beside a separate actual-Bot
  comparison. QR-3 depends on QR-1, and on QD-1 for expanded ranges.

QRL requirements [SRC: QRL § Strategy Comparison and Best Performance]: two explicit modes; compatible
out-of-sample evidence; comparing selected winners is a selection step, so prior searches, exposed periods and
all participants are recorded; a used holdout is never reused as independent proof after new tuning; objective
and risk/sample filters registered before ranking; report net return, Buy & Hold on the same price/cost basis,
drawdown, costs, exposure, completed episodes, rejected intents and robustness/uncertainty; benchmark timing,
costs and funding defined explicitly; only qualified results receive a best-in-scope label; ties, inadequate
evidence and no qualifying strategy are allowed; no weighted score invented after viewing results; reports
state asset, dates, risk profile, costs, coverage and evaluation basis.

ROADMAP report behavior [SRC: ROADMAP § Report and research behavior]: rank only qualified results on a
predeclared objective within owner risk limits, with Buy & Hold, drawdown, episode counts, costs/exposure and
uncertainty; label the winner best within the selected scope, never universally best; previously exposed
holdout becomes development evidence; comparisons have their own `comparison_id` referencing all
participating versions and runs.

Meaning of "complete declared-period comparison": for one declared, resolved UTC half-open period,
every participant either (a) has a frozen evaluation record covering the whole period under the comparison
context, and every number shown derives from that record and the frozen comparison dataset by a versioned
rule, or (b) is excluded, or shown as null, with a stated reason code. No participant is shown with partial
coverage, zero-filled history or interpolated values. No ranking appears unless the spec (objective, period,
participants, filters) was frozen before the first metric was computed. [SRC basis: ROADMAP § Report range,
"without zero-filling missing history"; QR2 § 1.1, meaning of "complete"]

### 1.2 Current state (limits what F10-02 can claim today)

1. CODE: LIB `compare(owner, runIds)` takes 2 to 4 owner-scoped run ids (`COMPARE_RUN_COUNT`,
   `DUPLICATE_RUN_ID`, `INVALID_RUN_ID`), reads inside `SET TRANSACTION READ ONLY`, orders runs by
   `created_at` then `run_id`, and returns `quant-library-compare-v1` with `verdict` `COMPATIBLE` or
   `INCOMPATIBLE` and `mismatches`. Metrics are withheld for an incompatible set. No ranking exists.
   `qualified_total` is 0 and `qualified_winner` is null.
2. CODE: DERIVE `library-compat-v1` has 13 hard fields: `scope`, `market`, `data_model`, `dataset`, `split`,
   `engine`, `source`, `fixed_strategy`, `dimension_set`, `cost_model` (`version`, `fee_bps`, `slippage_bps`,
   `risk_percent`), `capital` (`equity`, `cash`), `policy`, `validation_protocol` (hash of `rules` and
   `ledger_initialization`). An unreadable field becomes `MISSING:<run_id>`. Key:
   `hash(canonical({version, ...fields}))`.
3. Consequence of item 2: `source`, `fixed_strategy`, `dimension_set`, `dataset` and `split` are hard, so a
   `COMPATIBLE` set today is one Pine source over one dataset and split, differing only in search
   configuration, Bot, deployment or baseline. It cannot compare two strategies. This is the "minimum
   context-matched comparison" of the ROADMAP QR-3 row, prototype P06-03. [SRC: INV P06-03; SC P06-03]
4. CODE: the per-run metric is `development_score`, basis `VALIDATION_NET_RETURN_PERCENT`, of the
   engine-selected candidate; DERIVE states it is in-sample selection, never a recommendation. The engine
   selection rule is `VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS`, `source: ENGINE_CODE` (LIB
   `OBJECTIVE`). It describes in-run candidate selection, not a cross-run comparison.
5. CODE: a run stores per-partition summary metrics (`train`, `validation`, `test`): `bars`,
   `closed_trades`, `start_equity`, `end_equity`, `net_return_percent`, `max_drawdown_percent`,
   `profit_factor`, `gross_profit`, `gross_loss`. The library view has no equity curve, no fee total, no
   exposure, no rejected-intent count and no episode list.
6. CODE: LIB `limitationsOf` always adds `NO_BENCHMARK_OR_COMPARISON_OBJECTIVE`. No benchmark code exists in
   `src`.
7. CODE: `library-qualification-v1` G8 always fails `QL4C_VALIDATION_NOT_AVAILABLE`; G7 cannot pass for the
   current engine; G6 cannot pass for runs of either research contract version. [SRC: PKG § 2 items 3 to 5]
   No participant can be qualified today, so every full comparison today ends without a ranking.
8. CODE: G5 `HOLDOUT_INDEPENDENT` checks holdout overlap against earlier holdout-evaluated runs of the same
   owner and the same market (LIB `EARLIER` query and `marketKey` filter).
9. CODE: the research split is fixed by bar index: train to 60 %, validation to 80 %, test (holdout) to the
   end, after warm-up (`src/postgres/quant-research.js` line 136). Frozen `rules` are
   `minimum_closed_trades_{train,validation,test}` 5/5/5, `maximum_drawdown_percent` 20,
   `sensitivity_max_drop_percentage_points` 2 (`src/quant-research/contract.js` line 6).
10. Capacity: 10,000 bars including warm-up, narrow profile. [SRC: ROADMAP § Report range]
11. The completed flat-to-flat episode gate is not implemented; closed allocations are not episodes. [SRC:
    ROADMAP § Data readiness and candidate outcomes] PKG OD-4 requires the versioned episode gate before the
    first real package.
12. QR-2 is a contract only. Its views publish a machine-readable valuation context; QR-3 compares two QR-2
    views only when the contexts match field by field; QR-2 never feeds the standardized mode; QR-3 owns
    benchmarks (OD-Q15). [SRC: QR2 § 1.3]
13. Existing compatible-comparison evidence is labelled synthetic fixtures in tests only. [SRC: ROADMAP
    § 2026-10-02 QR-1 release]

### 1.3 Relation to neighbours

- QR-2 (F10-01) is the input of `ACTUAL_BOT` mode only.
- QR-4 (F10-03) ranks READY packages only through its own selection on a new disjoint window, with its own
  objective and its own label (QR-4 contract, `docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md`, sections 4 to 7
  and 11). A QR-3 comparison outcome, `QUALIFIED_RANKING` included, is never a QR-4 participant,
  eligibility or ranking input. QR-4 uses from this contract only the valuation `qr3-valuation-std-v1`
  and the benchmark `qr3-bh-close-same-cost-v1` (section 5), the shared evaluation job class (decision
  RD-7) and the shared exposure register (section 7). A window used by a QR-3 comparison is exposed data
  for QR-4, and a window used by a QR-4 selection is exposed data for QR-3. The labels of 6.5 T3 and
  6.6 R3 and R5 exist only inside a QR-3 comparison record; they are not QR-4 labels. [SRC basis: INV
  F10-03; SC F10-03 carryLimitations; ROADMAP § Report range, "only untouched disjoint periods support
  independent evaluation"]
- PKG owns package gates, the `ql4c_validation` record and READY. QR-3 reads library gates G1 to G8 (G8 PASS
  only from a PASS non-fixture `ONE_PINE` `ql4c_validation` record, PKG § 5.5) and never writes them.
- The fixed-input evaluation of section 6 is the QRL follow-up "Backtest another period: fixed
  strategy/inputs on a newly frozen dataset". Each evaluation gets a new `run_id`, mode and `parent_run_id`.
  [SRC: QRL § Explicit follow-up jobs; ROADMAP § Report and research behavior, owner follow-ups]

---

## 2. Two comparison modes (never mixed)

[SRC: QRL § Strategy Comparison and Best Performance, modes 1 and 2; ROADMAP § Report and research behavior]

| Mode id | Participants | What it shows | Ranking |
| --- | --- | --- | --- |
| `ACTUAL_BOT` | QR-2 views of the owner's Bots | Actual Paper history of each Bot with its own policy, inputs and capital; differences disclosed | Never. Fixed fields `qualified_evidence: false`, `isolates_strategy_quality: false` |
| `STANDARDIZED` | Fixed strategy subjects evaluated by simulation under one declared context | Simulated research results on one common window | Only `ELIGIBLE_QUALIFIED` participants, under the frozen objective |

Rules:

- M1 One comparison has exactly one mode. A mixed request is refused `QR3_MODE_MIX`. [SRC: QR2 § 1.3]
- M2 A `STANDARDIZED` result is never labelled actual Paper execution; an `ACTUAL_BOT` result is never labelled a
  strategy evaluation. [SRC: ROADMAP row QR-2]
- M3 `GET /api/quant/library/compare` (`quant-library-compare-v1`) stays as the "same-source context
  check" of 1.2 item 3. It is relabelled so it is never presented as the QR-3 full comparison, and it never
  ranks. The QR-3 view shows the `library-compat-v1` key of each participant's source run beside the QR-3
  context key, so earlier evidence stays traceable. Decision OD-C14.
- M4 Stored-result view: a `STANDARDIZED` comparison may also show, as a separate labelled block, the
  stored partition metrics of the source runs, only when the period equals one stored `validation` or `test`
  window of every participant (`qr3-period-partition-aligned-v1`). That block is always
  `DEVELOPMENT_EVIDENCE`, is never ranked, and is never the full comparison. Decision OD-C5.

---

## 3. Compatibility contexts and keys

### 3.1 Context versus subject

`library-compat-v1` treats everything as context, so strategies can never differ. QR-3 splits each participant
into:

- Context: what must be identical for a fair comparison. Hashed into one context key. A participant whose
  context differs is excluded, never ranked. [SRC: QRL mode 2, "incompatible runs are grouped separately or
  rejected"]
- Subject: what the comparison compares. Subject fields may differ, and every difference is disclosed.
- Derived: computed by QR-3 from context and spec; shown, never an input to compatibility.

### 3.2 Standardized context `qr3-context-std-v1` (SRC column gives the requirement)

| # | Field | Content | Requirement source |
| --- | --- | --- | --- |
| C1 | `mode` | `STANDARDIZED` | [SRC: QRL mode 2] |
| C2 | `scope` | Research scope id, today `SPT_CUSTOM_ENGINEERING_ONLY` | CODE: DERIVE `scope` |
| C3 | `market` | `{broker:'binance-global', symbol:'BTCUSDT', timeframe:'1'}` | [SRC: QRL mode 2; AGENTS.md scope] |
| C4 | `data_model` | `{data_profile, price_tick, quantity_step}` | CODE: DERIVE `data_model` |
| C5 | `period` | Resolved UTC half-open `[start, end)` of completed bars and its evaluation bar count | [SRC: ROADMAP § Report range] |
| C6 | `dataset` | `{digest_kind, digest, first_bar, last_bar, bar_count, timestamp_semantics}` of one verified dataset covering `[start - W_max, end)`; `W_max` is the largest warm-up of any participant | [SRC: QRL § Research record, dataset hashes and closed-bar convention] |
| C7 | `engine` | Evaluator engine hash used for every participant evaluation | CODE: DERIVE `engine`; equality required, decision OD-C15 |
| C8 | `execution` | Fill model id (planned model: verified execution-bar close with identical adverse slippage, rounding and fees) and exit semantics version | [SRC: ROADMAP § Source, exit and validation rules]; decision RD-2 |
| C9 | `cost_model` | `{version, fee_bps, slippage_bps}` | [SRC: ROADMAP row QR-3, cost]; CODE: DERIVE `cost_model` (code also holds `risk_percent`, see C11 and decision RD-3) |
| C10 | `capital` | `{initial_cash, initial_inventory:'0', quote:'USDT'}` | [SRC: ROADMAP row QR-3, capital]; code `{equity, cash}` mapping, decision RD-3 |
| C11 | `risk_policy` | Hash of one declared comparison policy (including `risk_percent` and hard limits) applied to every participant | [SRC: ROADMAP row QR-3, risk; § Report and research behavior, "within owner risk limits"] |
| C12 | `ledger_initialization` | Independent historical flat Paper simulation; counters neither consumed nor reset | CODE: `quant-research.js` line 136 |
| C13 | `valuation` | `{price_series:'DATASET_CLOSE', grid_id, currency:'USDT', fx:'NONE', end_treatment}` | [SRC: ROADMAP row QR-3, valuation]; section 5 |
| C14 | `benchmark` | Benchmark method id (5.3) | [SRC: QRL, benchmark defined explicitly] |
| C15 | `spec_hash` | Hash of the frozen spec (objective, filters, adequacy, tie, uncertainty; section 6) | [SRC: ROADMAP row QR-3, "ranking rules fixed before comparison"] |
| C16 | `validation_protocol` | Hash of the comparison `rules` (adequacy, risk filter, sensitivity and cost-stress rules), `ledger_initialization` and the evaluation contract version | [SRC: INV F10-02, "validation contexts"]; CODE: DERIVE `validation_protocol` |

Key: `context_key = hash(canonical({version:'qr3-context-std-v1', ...C1..C16}))`, same canonical hashing as
DERIVE `compatibilityKey`. An unreadable field is `MISSING:<participant_id>` and never matches. A sub-key
inside a field that this table does not list is unreadable (`MISSING:<participant_id>`) until RD-3 decides the
field content (RC-C6).

Subject fields (may differ, always disclosed): source hash and version, source contract version, fixed
strategy hash, parameter values and Bridge ATR/RR pair, dimension set, warm-up bar count, originating run and
lineage (parent runs, searches, candidate counts, seed, algorithm, budget), frozen acceptance blockers, library
class, qualification label and gates, integrity warnings, Bot and deployment ids, the Bot's own policy hash.
[SRC: QRL § Research record, Identity and Inputs]

Change from `library-compat-v1`: `source`, `fixed_strategy`, `dimension_set` move to the subject.
`split` is replaced by `period`. `dataset` becomes the shared comparison dataset. `policy` becomes the declared
comparison policy; the Bot's own policy hash is disclosed only.

Different signal timeframes are out of v1: QRL allows them only with an explicit common pricing/valuation basis;
v1 supports 1m only and refuses another timeframe `QR3_TIMEFRAME_UNSUPPORTED`.

### 3.3 Actual-Bot context `qr3-context-actual-v1`

Fields: `mode: ACTUAL_BOT`, `market`, and every field of the QR-2 view header valuation context: contract
version, every method id of QR2 § 7.4, price source and age policy, drawdown grid id, ledger rule epochs met,
fee source `RECORDED_ONLY`, requested and resolved range, currency, `fx: NONE`, capital-model declaration
version. Field-by-field equality is required. [SRC: QR2 § 1.3; § 8.1 view header] Policy, inputs, capital,
registration date and funding flows are disclosed differences, not context. [SRC: QRL mode 1]

### 3.4 Mismatch reporting

Reuse DERIVE `compatibilityMismatches`: per differing context field, list the field and each participant's short
value. Metrics of an excluded participant are withheld (CODE: LIB `compareRun` returns base fields only when
incompatible). This applies to the new modes. Metrics are also hidden for `EXCLUDED_COVERAGE`,
`EXCLUDED_INTEGRITY` and `UNAVAILABLE` (RC-C26). `compareToDeclared` normalises the declared context through
the same readers as a participant context before it compares (RC-C7).

---

## 4. Period declaration and data

### 4.1 Declaration (SRC)

- `STANDARDIZED` choices: 1 Week, 1 Month, 3 Months, 6 Months, 1 Year, 2 Years, 3 Years, YTD, All Available,
  Custom. Week is seven days; months and years use calendar boundaries and month-end clamping in the report
  timezone; YTD starts January 1. Freeze UTC half-open intervals with completed bars. [SRC: ROADMAP § Report
  range, period-first UI]
- Anchors (RC-C16): the relative periods 1 Week to 3 Years end at the end of the last completed bar (end-anchored).
  A supplied `start_ms` makes them start-anchored instead. The anchor is shown and frozen with the interval.
  YTD at exactly January 1 00:00 UTC has an empty window and is refused `QR3_PERIOD_INVALID` (RC-C17).
- Show requested period, evaluation, warm-up and total bars, available history, stage limit, capability and
  admission result. Never silently change timeframe or downsample. [SRC: same]
- All Available is bounded by venue history, evaluator, mode, storage and admission; show and confirm its
  resolved interval. Over-limit ranges require the owner to shorten them or request admitted Deep Research. No
  silent truncation. [SRC: same]
- `ACTUAL_BOT`: All Time Registered and the QR-2 periods, resolved by QR-2 and never by QR-3 (QR-2 uses UTC and
  ISO weeks). Older exchange history is simulation, never actual fills. [SRC: ROADMAP § Report range; QR2
  § 3.5]

### 4.2 Resolution and admission

- P1 Report timezone for `STANDARDIZED` v1 is UTC.
- P2 `end` must not be later than the last completed bar when the spec is frozen: `QR3_PERIOD_IN_FUTURE`.
  `end <= start`, a non-aligned bound or an unknown choice: `QR3_PERIOD_INVALID`.
- P3 Total bars = evaluation bars + `W_max`, at most 10,000 under the current runtime [SRC: ROADMAP § Report
  range]. Over the limit is refused `QR3_RANGE_ADMISSION_REFUSED`, never truncated. Larger ranges wait for QD-1
  expanded admission. [SRC: ROADMAP row QR-3]
- P4 The resolved interval and bar counts are part of the frozen spec. A changed interval is a new comparison.

### 4.3 Data gaps and coverage

- G1 (SRC) Gaps, duplicates and incomplete bars are rejected [SRC: ROADMAP row QD-1]. Missing archived data
  disables exact reproduction; never use replacement candles. [SRC: QRL § Research record and storage] A bar
  counts for the period only when `complete === true` (RC-C8).
- G2 `STANDARDIZED`: the shared dataset must be gapless over `[start - W_max, end)`, else
  `QR3_DATASET_GAPPED` with the gap intervals. No interpolation, forward fill or shortening.
- G3 `ACTUAL_BOT`: price gaps follow QR2 § 2.1 and § 11 unchanged. An `UNAVAILABLE` QR-2 view is
  excluded `QR3_PARTICIPANT_UNAVAILABLE`. A `PARTIAL` view shows each null with its QR-2 reason. Decision
  OD-C17.
- G4 In both modes a participant must cover the whole resolved period, else `EXCLUDED_COVERAGE` with
  `QR3_COVERAGE_INCOMPLETE` and its covered interval. The comparison never shrinks the period itself. Decision
  OD-C13. [SRC basis: ROADMAP § Report range]
- G5 (SRC) A comparison read never starts a backfill, fetch or job. [SRC: ROADMAP § Report range, "Persisted
  result reads do not rerun jobs"]

---

## 5. Common valuation and benchmark

### 5.1 Standardized valuation `qr3-valuation-std-v1`

- V1 Price: the close of each bar of the shared dataset, BTCUSDT Spot 1m, quote USDT, no FX.
- V2 Every participant starts flat with the same `initial_cash` at `start`. Warm-up bars compute indicator state
  only; no intent, fill or position exists before `start`. [SRC basis: CODE `ledger_initialization`]
- V3 No deposits or withdrawals inside the window. Return = `NAV(end) / NAV(start) - 1`. Any flow refuses the
  evaluation `QR3_FLOW_IN_WINDOW`.
- V4 Valuation grid `qr3-grid-bar-close-v1`: every bar close in `[start, end)`. Drawdown uses this grid. The
  first grid point is `NAV(start)` = `initial_cash` (RC-C18).
- V5 End treatment `MARK_AT_END_CLOSE`: an open position at `end` is marked at the close of the last bar before
  `end` and not liquidated. A simulated liquidation exists only as a separately labelled line. [SRC: QRL
  § Portfolio Performance] Decision OD-C10.
- V6 Fees and slippage come only from the context cost model, applied by the evaluator at fill time. Total fees
  and total modeled slippage are information lines, never subtracted again. [SRC basis: QR2 § 8.4] Tick rounding is
  adverse (a buy rounds up, a sell rounds down) until RD-5 confirms the evaluator rule (RC-C19). Fills on the
  same bar are ordered by an explicit `sequence` field; a same-bar fill without `sequence` refuses
  `QR3_METRIC_UNAVAILABLE` with detail `FILL_ORDER_UNKNOWN` (RC-C9).
- V7 Decimal strings: money at 18 places half-even per position per instant; returns rounded once at output to
  12 places, matching QR-2 rounding ids. Ranking compares unrounded canonical decimals, so `1.50` equals
  `1.5`. [SRC basis: QR2 § 7.4] Money, metric and threshold inputs of type `number` (including context capital
  and costs and the spec drawdown limit, tie band and confidence) are refused `QR3_SPEC_INCOMPLETE` with detail
  `NUMBER_NOT_DECIMAL_STRING` (RC-C10). This refusal applies to the declared context and the spec; in a participant
  context a number is unreadable (`MISSING:<id>`) and excludes that participant with `QR3_CONTEXT_MISMATCH`. Every `*_exact` field is the unrounded value at 80 digits
  (RC-C14).
- V8 The evaluator's end-of-window rule and its ability to emit the bar-close grid, fees, exposure, rejected
  intents and completed episodes are not shown in the sources read. Until root confirms them from the evaluator
  source (decision RD-5), `valuation.end_treatment` carries `VALUATION_BASIS_UNCONFIRMED`, each missing metric
  is null with `METRIC_NOT_RECORDED`, and every participant fails the evaluation check (no ranking). This is a
  gap, never a pass. Status (RC-C2): a participant whose evaluation record exists but fails the evaluation check
  is `DEVELOPMENT_EVIDENCE` with `VALUATION_BASIS_UNCONFIRMED` and/or `METRIC_NOT_RECORDED`; recorded metrics
  stay visible, each missing one is null with its reason, the participant is never ranked, and later checks are
  `NOT_REACHED`. `NOT_EVALUATED` applies only when no record exists. The metrics V8 requires are those the S1
  module implements.

### 5.2 Actual-Bot valuation

Use QR-2 numbers unchanged; QR-3 computes no new valuation for `ACTUAL_BOT`. [SRC: QR2 § 1.3]

### 5.3 Benchmark `qr3-bh-close-same-cost-v1` (requirement SRC)

Requirement: Buy & Hold on the same price and cost basis, with timing, costs and funding defined explicitly.
[SRC: QRL; ROADMAP § Report and research behavior] QR-3 owns benchmarks. [SRC: QR2 § 1.3, OD-Q15]

- B1 One buy at the first evaluation bar under the context fill model: verified close of that bar with the
  context adverse slippage, tick rounding and fee. Quantity: all `initial_cash` after fee, rounded down to
  `quantity_step`; residual cash stays cash. Decision OD-C11. If `initial_cash` is below one quantity step, the
  benchmark row is null with `QR3_METRIC_UNAVAILABLE` detail `NO_UNITS_AFFORDABLE`, excess return is null and
  the comparison is not refused (RC-C20).
- B2 No further trades. Marked on the same grid and end treatment (V4, V5). No exit fee unless the separately
  labelled simulated liquidation line is shown. Decision OD-C12.
- B3 No funding inside the window (V3).
- B4 Computed once per comparison from the frozen dataset and stored in the comparison record.
- B5 Excess return = participant return minus benchmark return, both on this basis. The benchmark is a
  reference line, never a participant and never ranked.
- B6 If benchmark bars are not readable from the frozen dataset, the row is null with
  `QR3_BENCHMARK_DATA_UNAVAILABLE`; no replacement candles. [SRC: QRL § Research record and storage]

`ACTUAL_BOT`: no Buy & Hold line in v1, because Bots have funding flows and different capital. Decision OD-C16.

---

## 6. Comparison spec: objective fixed before results

### 6.1 Freeze order (requirement SRC)

Requirement: objective and risk/sample filters registered before ranking; ranking rules fixed before
comparison; no weighted score invented after viewing results. [SRC: QRL; ROADMAP row QR-3] Gate order and
thresholds fixed before any result is seen. [SRC: PKG § 5]

- F1 The owner creates a spec by an explicit action: mode, participant list, resolved period, context fields,
  objective id, risk filter, adequacy rule, tie rule, uncertainty method id and seed, benchmark id.
- F2 The server freezes the spec as an insert-only row with `spec_hash` and `frozen_at_utc` (server clock)
  before any participant evaluation on the window starts.
- F3 Every evaluation record used for ranking references `comparison_id` and `spec_hash` and was created after
  `frozen_at_utc`. A stored result created earlier is development evidence only (M4, section 7). Decision
  OD-C5. Strictness (RC-C1): the record inputs `record_comparison_id` and `record_spec_hash` must equal
  `comparison_id` and `spec_hash`, else `QR3_RESULT_PREDATES_SPEC` (unreadable: `QR3_INTEGRITY_FAILED`).
  `created_at` must be strictly later than `frozen_at`; equal times predate the spec.
- F4 The spec is immutable. A change of objective, filters, period or participants is a new comparison with
  `parent_comparison_id`; the earlier comparison and its exposures stay. A change request is refused
  `QR3_SPEC_IMMUTABLE`. The outcome decision refuses duplicate participant ids (`DUPLICATE_RUN_ID`) and a
  `spec_hash` that differs from the recomputed hash (`QR3_SPEC_IMMUTABLE`) (RC-C13).
- F5 The objective comes from a versioned registry only. Unknown id: `QR3_OBJECTIVE_UNKNOWN`. No free weights,
  no ad-hoc metric, no owner-authored tie-break order. An objective in `ACTUAL_BOT` mode is refused
  `QR3_OBJECTIVE_NOT_ALLOWED`.
- F6 Thresholds are read from the frozen spec, never from current code constants. A later registry change
  records `RULES_VERSION_DIFFERS` (informational) and never re-labels a frozen comparison. [SRC basis: PKG § 5]
- F7 The owner may only tighten a filter at spec time (higher episode minimum, lower drawdown
  limit) relative to the registry defaults. A looser value is refused `QR3_FILTER_LOOSENED`. Decision OD-C21. Tie band: see OPEN-1 in section 15.
- F8 The comparison screen shows no participant metric for the comparison window before the
  spec is frozen. It shows only the compatibility verdict, mismatches, library class and qualification label.

### 6.2 Objective registry entry `qr3-obj-net-return-v1` (decision OD-C1)

- Primary metric: net return percent over the evaluation window after costs (5.1), higher is better.
- Risk filter: maximum drawdown percent on grid V4 at most the spec limit (default the owner risk limit). Above
  the limit: `FILTERED_RISK`, never ranked. The registry default is `min(20, owner_max_drawdown_percent)`, where
  `owner_max_drawdown_percent` is an input (RC-C15).
- No composite or weighted score. No secondary metric changes the order: this objective has no tie-break
  (decision OD-C1).

The library `development_score` is never the QR-3 objective metric, because it is in-sample selection. [SRC
basis: CODE DERIVE `developmentScore`; INV F10-03]

### 6.3 Sample adequacy (requirement SRC; values by decision OD-C4)

Sources: engineering minimum 5 completed flat-to-flat episodes per partition as a versioned gate; planning
target 20 holdout completed episodes, not a statistical guarantee; correlated episodes reduce effective
evidence. [SRC: ROADMAP § Data readiness and candidate outcomes]

- S1 Fewer than 5 completed episodes in the window: `INADEQUATE_SAMPLE`; metrics shown with the reason; never
  ranked.
- S2 5 to 19 completed episodes: `DEVELOPMENT_EVIDENCE`; never ranked.
- S3 Ranking needs at least the spec value (20) plus every other gate.
- S4 Closed allocations are not episodes. They are shown as information (`closed_trades`). [SRC: ROADMAP § Data
  readiness]
- S5 While the versioned episode gate does not exist, the episode count is unknown and adequacy is FAIL
  with `QR3_EPISODE_GATE_NOT_AVAILABLE`, never a pass. [SRC basis: PKG § 5, unknown is FAIL; PKG OD-4] A
  malformed adequacy spec refuses the comparison outcome with `QR3_SPEC_INCOMPLETE` and never becomes
  `INADEQUATE_EVIDENCE`. `QR3_EPISODE_GATE_NOT_AVAILABLE` applies only when the gate is absent; an available
  gate with an unreadable episode count gives `QR3_METRIC_UNAVAILABLE` (RC-C11).

### 6.4 Uncertainty (requirement SRC; method by decision OD-C2)

Method `qr3-unc-paired-daily-block-bootstrap-v1`: daily returns of each participant on the common UTC day
grid; for the top two ranked candidates, a seeded stationary block bootstrap of the paired daily difference;
resample count, block length, confidence and seed in the spec; output is the interval of the difference.
Deterministic for a given spec and dataset. The report states it is an approximation, not a guarantee. The
interval is required for a sole best label.

Method details (RC-C23): stationary block bootstrap; a new block starts with probability 1/`block_length` at
each step; the series is circular; both participants use the same resampled indices; the statistic is the
difference of the compounded returns; the interval tails are index `floor(R*(1-c)/2)` of the sorted statistics
for `R` resamples at confidence `c`; the first day return is measured against the initial NAV. The function
itself requires `0 < confidence < 1`, `resamples <= MAX_RESAMPLES` (20000) and `block_length <= MAX_BLOCK` (3650), else
`QR3_SPEC_INCOMPLETE` (RC-C12). A hand-derived non-degenerate golden fixture pins the method.

Robustness shown beside it: the source run's sensitivity rows and cost stress (`ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE`)
as stored, labelled as source-run validation data.

If the spec names no approved method, or the method is not implemented, the field is
`UNCERTAINTY_METHOD_NOT_APPROVED` and no sole best label is shown (outcome at most `QUALIFIED_TIE` or
`NO_QUALIFIED_RESULT`). The top two groups then merge exactly as in the interval-unavailable case: ranks
`[1,1,3]` and both top labels are `TIED_BEST_LABEL` (RC-C4).

### 6.5 Ties (requirement SRC "Allow ties"; decision OD-C3)

- T1 Two eligible participants tie when the primary metric difference is below the spec tie band (0.50
  percentage points), or when the uncertainty interval of their difference includes zero.
- T1a Ties chain by single linkage over the gaps between adjacent sorted values: a gap below the band joins the
  next value to the group (RC-C21).
- T2 A tie group shares one rank, competition style (ranks 1,1,3) (RC-C22). No tie-break chosen after results; no random or creation-time tie-break.
- T3 A tied top rank gives `QUALIFIED_TIE`; no single best label; each member may be labelled "tied best
  within the selected scope".

### 6.6 Ranking rules

Allowed:

- R1 Rank only participants with status `ELIGIBLE_QUALIFIED` (8.2). [SRC: ROADMAP § Report and research
  behavior, "Rank only qualified results"]
- R2 Order by the frozen objective only, after risk filter and adequacy, using exact decimals. [SRC: same]
- R3 Label the single top participant "best within the selected scope", never universally best. The scope
  string lists asset, resolved period, risk profile, cost model and context key. [SRC: same; PKG § 5.5] The label
  validator accepts only the exact label text; any case or spacing variant is `R3 LABEL_WITHOUT_SELECTED_SCOPE`,
  and any other non-null label is refused (`X1 LABEL` for a participant that is not eligible, `X4 LABEL` on an
  actual-Bot row, else `R3 LABEL_NOT_ALLOWED`) (RC-C3). It allows participant
  metrics only when the lifecycle is `COMPLETE`; `undefined`, `FAILED` and `CANCELLED` carry none (RC-C5).
- R4 Show rank beside the benchmark and the uncertainty interval.
- R5 A ranking needs at least two `ELIGIBLE_QUALIFIED` participants; one alone gets the label only as "only
  qualified participant within the selected scope", never as a winner over others. Decision OD-C18. With exactly one `ELIGIBLE_QUALIFIED` participant there is no rank,
  only the R5 label, and `only_qualified_participant_id` is set. The outcome value stays as implemented and is
  open: see OPEN-2 in section 15.

Forbidden:

- X1 Rank, best/top/winner label or highlight for any participant that is not `ELIGIBLE_QUALIFIED`. [SRC: QRL;
  PKG § 7.2]
- X2 A rank across modes or context keys. [SRC: QR2 § 1.3; QRL mode 2]
- X3 A weighted or composite score, or a metric or threshold chosen after results. [SRC: QRL]
- X4 Ranking `ACTUAL_BOT` participants. [SRC basis: QRL mode 1; QR2 `qualified_evidence: false`]
- X5 Holdout performance of rejected candidates as a selection aid. [SRC: PKG § 7.2]
- X6 A universal best, exhaustive-search, global-optimum or profitability claim. [SRC: PKG § 7.2; ROADMAP
  § Binding and optimization contract]
- X7 A performance sort or a "development ranking" for development-tier participants. They appear in neutral
  order: participant creation time, then id (CODE: LIB `compare` sort). Decision OD-C6.
- X8 Starting, changing or sizing a Bot, starting a run, or enqueueing an email from a comparison view. [SRC:
  QRL; ROADMAP § Report and research behavior]

Participant count in v1 is 2 to 4. Decision OD-C7.

---

## 7. Evidence classes and independence

Sources: compatible out-of-sample evidence; comparing selected winners is a selection step; a used holdout is
not independent proof after new tuning [SRC: QRL]; only untouched disjoint periods support independent
evaluation; ranking finalists on holdout makes it selection data [SRC: ROADMAP § Report range]; never inspect
holdout to choose policy, bounds, source revision or collection duration [SRC: ROADMAP § Data readiness].

Per participant:

| Class | Rule (all conditions) |
| --- | --- |
| `INDEPENDENT` | Evaluation record created after the spec freeze (F3); window disjoint from every holdout window opened by any earlier run of the same owner and same market (G5 scope); disjoint from every train or validation window searched by any run of the same owner and same source, lineage included (PKG OD-10 scope); disjoint from every earlier exposure in the exposure register (QR-3 comparison or QR-4 selection) of the same owner and same market; at or after a PF-2 R3 registered boundary where one exists (PKG § 5.0 item 5, OD-9); the source run passes library G1 to G8. |
| `DEVELOPMENT_EVIDENCE` | Any condition above fails, the result was viewable before the freeze, or it comes from the stored-result view (M4). Shown with failing reason codes. Never ranked. |
| `NOT_EVALUATED` | No evaluation record for the window. |

Scopes match code G5 (same owner, same market) and PKG OD-10 (same owner, same source). Decision OD-C9.

Exposure register: creating the evaluation records of a comparison appends one insert-only exposure
event per participant and window, `{owner_id, market, source_hash, window, comparison_id, at_utc}`. The
create reads and appends the register in one SERIALIZABLE transaction (QR-4 contract § 13.3). After
evaluation the window is selection data for every participant, including a winner. A later independence claim
needs a new disjoint window. The participant's library detail shows
`HOLDOUT_EXPOSED_BY_COMPARISON` with comparison or selection ids where a source holdout overlaps an exposure.
`HOLDOUT_EXPOSED_BY_COMPARISON` keeps the class `DEVELOPMENT_EVIDENCE` (RC-C25).
Library G5 and package B0 read this register (decision OD-C8). The QR-4 selection exposure records (QR-4
contract § 13.3) are part of the same register. Every reader (the QR-3 evidence class, the QR-4 window
check, library G5 and package B0) reads both kinds for the same owner and the same market. Root fixes the
shared schema at implementation. An empty register is valid. An absent or unreadable register refuses the
create request with `QR3_EXPOSURE_REGISTER_UNAVAILABLE`. For B0 the rule and its refusal code
`BI_HOLDOUT_EXPOSED_BY_SELECTION` are recorded as PKG OD-19 in PKG § 5.0 item 5. The matching change to library
G5 is a new `library-qualification` version in slice S2 (13.5). Retention: decision OD-C22.

Selection disclosure (SRC requirement): every participant shows its prior searches (run ids,
candidate counts, seed, algorithm, exposed windows) and gate states at freeze time; the comparison lists all
participants, including excluded ones. [SRC: QRL]

Imported bundles are untrusted and may only be compared [SRC: PKG § 8]: an imported participant is always
`DEVELOPMENT_EVIDENCE` with `QR3_NOT_QUALIFIED`. A `NO_VALID_CANDIDATE` source run has no fixed strategy to
evaluate; it is listed with its reason counts and `QR3_NO_SCREENED_CANDIDATE`, a valid outcome.

---

## 8. Statuses

### 8.1 Comparison status

| Level | Value | Meaning |
| --- | --- | --- |
| Request | `REFUSED` | Invalid or unsafe request; no record. Codes 9.1. |
| Lifecycle | `SPEC_FROZEN` | Spec stored; evaluations not finished. No metric shown. |
| | `EVALUATING` | Admitted evaluation job running. No metric shown. |
| | `COMPLETE` | Every participant has a final participant status. |
| | `FAILED` | Evaluation failed; reason code; partial metrics never shown as a comparison. |
| | `CANCELLED` | Owner cancelled; exposure events already written stay. |
| Outcome (`COMPLETE` only) | `QUALIFIED_RANKING` | At least two `ELIGIBLE_QUALIFIED` participants and a single top participant outside any tie (R5 for one). |
| | `QUALIFIED_TIE` | Top rank is a tie group, or no approved uncertainty method separates the top two. |
| | `NO_QUALIFIED_RESULT` | No participant is `ELIGIBLE_QUALIFIED`, or (interim, open owner item OPEN-2) exactly one is, with `only_qualified_participant_id` set and no rank. Valid. Today every comparison ends here (1.2 item 7). |
| | `INADEQUATE_EVIDENCE` | Every evaluated participant is `INADEQUATE_SAMPLE`. Valid. |
| | `ACTUAL_HISTORY_SIDE_BY_SIDE` | `ACTUAL_BOT` mode. No ranking by definition. |
| Derived at read | `STALE` | A participant integrity check now fails, a participant row is unreadable, a later exposure changed an evidence class, or a `REPLAY_MISMATCH` exists. Shown with the first differing code; stored numbers never rewritten. [SRC basis: PKG § 6.2] The `STALE`, replay-mismatch and `ACTUAL_BOT` checks are not in the S1 module and stay todo for slices S2, S4 and QR-2 S3 (RC-C27). |

### 8.2 Participant status

`ELIGIBLE_QUALIFIED`, `DEVELOPMENT_EVIDENCE`, `INADEQUATE_SAMPLE`, `FILTERED_RISK`, `EXCLUDED_INCOMPATIBLE`,
`EXCLUDED_COVERAGE`, `EXCLUDED_INTEGRITY`, `NOT_EVALUATED`, `UNAVAILABLE`. Each non-eligible status carries
reason codes. Fixed check order: integrity, compatibility, coverage, evaluation (including V8), evidence class,
adequacy, risk filter. A check returns `PASS`, `FAIL` or `NOT_REACHED`; unknown or unreadable input is `FAIL`.
[SRC basis: PKG § 5]

---

## 9. Codes

Codes match `^[A-Z][A-Z0-9_]{1,63}$`; existing codes are reused where the meaning is the same. [SRC: PKG § 5]

### 9.1 Request refusals (no record created)

Reused (CODE: LIB): `NOT_FOUND` (404, absent and foreign alike), `INVALID_RUN_ID`, `DUPLICATE_RUN_ID`,
`INVALID_FIELDS`, `METHOD_NOT_ALLOWED` (405), `QUANT_LIBRARY_UNAVAILABLE` (503). Reused (CODE:
`quant-research.js`): `MULTI_PINE_RESEARCH_NOT_SUPPORTED`.

New:

| Code | When |
| --- | --- |
| `QR3_MODE_REQUIRED` | No mode, or mode not `STANDARDIZED` / `ACTUAL_BOT` |
| `QR3_MODE_MIX` | Actual and simulated participants in one request |
| `QR3_PARTICIPANT_COUNT` | Outside the allowed count (v1 2 to 4, decision OD-C7) |
| `QR3_MARKET_UNSUPPORTED` | Any market other than BINANCE:BTCUSDT Spot |
| `QR3_TIMEFRAME_UNSUPPORTED` | Any timeframe other than 1m |
| `QR3_PERIOD_INVALID` | Malformed or non-aligned period, `end <= start`, unknown choice |
| `QR3_PERIOD_IN_FUTURE` | End after the last completed bar |
| `QR3_PERIOD_NOT_PARTITION_ALIGNED` | Stored-result view (M4) requested for a period that equals no stored partition window; lists the windows |
| `QR3_RANGE_ADMISSION_REFUSED` | Total bars over the admitted limit; never truncated |
| `QR3_READ_BUDGET_EXCEEDED` | Participant count or contract bytes over the fixed read budget (429); never truncated |
| `QR3_OBJECTIVE_UNKNOWN` | Objective id not in the registry |
| `QR3_OBJECTIVE_NOT_ALLOWED` | Objective supplied in `ACTUAL_BOT` mode |
| `QR3_FILTER_LOOSENED` | Spec filter looser than the registry default |
| `QR3_SPEC_INCOMPLETE` | Missing filter, adequacy, tie, benchmark or uncertainty field |
| `QR3_SPEC_IMMUTABLE` | Change requested on a frozen spec |
| `QR3_COST_MODEL_UNSUPPORTED` | Cost model V2 before V2 parity [SRC: PKG § 9] |
| `QR3_FIXTURE_PARTICIPANT` | Fixture participant in a non-fixture comparison |
| `QR3_DATASET_UNAVAILABLE` | Shared dataset missing or not verifiable |
| `QR3_DATASET_GAPPED` | Gap, duplicate or incomplete bar in `[start - W_max, end)` |
| `QR3_ADMISSION_CLOSED` | Research admission closed (QS-1) |
| `QR3_SCHEMA_ABSENT` | QR-3 or research tables absent (mirrors LIB `PRESENT` check) |
| `QR3_EXPOSURE_REGISTER_UNAVAILABLE` | Exposure register absent or unreadable; an empty register is valid (section 7) |
| `QR3_CONFIRMATION_REQUIRED` | Create action without confirm token (pattern of `CONFIRMATION_REQUIRED`, PKG § 7.3) |
| `QR3_NOT_CANCELLABLE` | Cancel when status is not `SPEC_FROZEN` or `EVALUATING` |
| `QR3_ACTUAL_BOT_UNAVAILABLE` | QR-2 route not deployed (503) |

### 9.2 Participant reasons (record created; participant not eligible)

`QR3_CONTEXT_MISMATCH` (with mismatch list), `QR3_COVERAGE_INCOMPLETE`, `QR3_INTEGRITY_FAILED`,
`QR3_PARTICIPANT_UNAVAILABLE`, `QR3_FLOW_IN_WINDOW`, `QR3_RESULT_PREDATES_SPEC`,
`QR3_WINDOW_OVERLAPS_SEARCHED_DATA`, `QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT`, `QR3_WINDOW_PREVIOUSLY_EXPOSED`,
`QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY`, `QR3_NOT_QUALIFIED` (with failing library gates, for example
`QL4C_VALIDATION_NOT_AVAILABLE`), `QR3_NO_SCREENED_CANDIDATE`, `QR3_EPISODE_GATE_NOT_AVAILABLE`,
`QR3_SAMPLE_INADEQUATE`, `QR3_RISK_FILTER_FAILED`, `QR3_METRIC_UNAVAILABLE`, `METRIC_NOT_RECORDED`,
`QR3_BENCHMARK_DATA_UNAVAILABLE`, `HOLDOUT_EXPOSED_BY_COMPARISON`.

Unnamed conditions (RC-C24): a metric that cannot be computed uses `QR3_METRIC_UNAVAILABLE` with a detail
string; a malformed or missing spec field uses `QR3_SPEC_INCOMPLETE`; an objective in `ACTUAL_BOT` mode uses
`QR3_OBJECTIVE_NOT_ALLOWED`. Details seen so far: `FILL_ORDER_UNKNOWN`, `NO_UNITS_AFFORDABLE`,
`NUMBER_NOT_DECIMAL_STRING`, `TIE_BAND_FIXED`. `QR3_SPEC_IMMUTABLE` is also used for a recomputed `spec_hash`
mismatch (RC-C13).

### 9.3 Limitations (informational)

`RULES_VERSION_DIFFERS`, `UNCERTAINTY_METHOD_NOT_APPROVED`, `VALUATION_BASIS_UNCONFIRMED`,
`REPRODUCTION_DISABLED`, `ENGINE_RELEASE_UNKNOWN` (reuse CODE: LIB `limitationsOf`), `SELECTION_WINDOW_EXPOSED`.

---

## 10. Immutability and replay

- I1 (SRC) A comparison has its own ID and participant list; it references several runs through the list, not
  a single-parent chain. [SRC: QRL § Research record, Identity; § Explicit follow-up jobs; ROADMAP § Report and
  research behavior]
- I2 Records: spec, participant evaluation records, benchmark result, outcome, exposure events,
  status events and replay events. All insert-only, refused on update or delete by `BEFORE UPDATE OR DELETE`
  triggers with `ENABLE ALWAYS`, `SECURITY INVOKER` and pinned `search_path`, following the QR-1b freeze
  pattern. [SRC basis: PKG § 8; CODE `quant-research-freeze.sql`] SQLSTATE assigned by root (decision RD-1).
  The migration follows QR2 § 7.5 rules (offline, classified install, rollback refused with rows unless
  exported and count-confirmed, own GO).
- I3 Determinism: the outcome is a pure function of the frozen spec, evaluation records and dataset;
  the same inputs give the same `outcome_hash`. The bootstrap uses only the spec seed.
- I4 (SRC) Replay is a new owner-requested job that compares with the prior result and reports mismatches.
  [SRC: QRL § Explicit follow-up jobs] A mismatch appends `REPLAY_MISMATCH` referencing
  `comparison_id`, never changes the outcome record, and makes the read `STALE`. [SRC basis: PKG § 8, OD-15]
- I5 (SRC) If archived data or the evaluator artifact is gone, exact reproduction is disabled; never use
  replacement candles. [SRC: QRL § Research record and storage]
- I6 (SRC) A comparison read never reruns a job; new price-based calculations use a declared admitted job class.
  [SRC: ROADMAP § Report range] Participant evaluations and the benchmark run as one admitted job class
  under QS-1 (one heavy Quant executor [SRC: QRL § Periods and data admission]), never inside a read. Each
  evaluation is a fixed-input new-period backtest with its own `run_id` and `parent_run_id` (1.3). Job class
  design: decision RD-7. An evaluation run never becomes a package, a G8 source or a library-qualified run,
  the same rule as QR-4 contract § 5.4.
- I7 (SRC) Research rows stay immutable under the QR-1b freeze; QR-3 reads them in a `READ ONLY` transaction.
  [CODE: LIB `read`]
- I8 Retention: a comparison is retained while any participant run is retained. Exposure events are
  retained for the owner's lifetime because they protect later independence claims (decision OD-C22).
  Required immutable evidence is never removed as cache. [SRC basis: QRL § Research record and storage]

---

## 11. What the owner sees

### 11.1 Shown (content SRC where marked)

1. Mode badge: "Actual Paper history" or "Simulated standardized evaluation"; badges from API fields, no browser
   arithmetic. [SRC basis: QR2 § 9]
2. Spec block before any metric: objective and its exact rule text, risk filter, adequacy rule, tie band,
   uncertainty method, benchmark definition, `frozen_at_utc`, `comparison_id`.
3. Period: requested and resolved interval, evaluation, warm-up and total bars, available history, limit and
   admission result. [SRC: ROADMAP § Report range]
4. Shared context table (section 3), the QR-3 context key and each source run's `library-compat-v1` key, and
   disclosed subject differences per participant.
5. Per participant: status, evidence class, reason codes, net return, Buy & Hold on the same basis, excess over
   Buy & Hold, maximum drawdown, total fees, total modeled slippage, exposure (time in market percent),
   completed episodes, closed allocations (information), rejected intents, uncertainty interval, robustness
   rows, prior searches and exposed windows. [SRC: QRL report list]
6. Rank column only for `ELIGIBLE_QUALIFIED`; "best within the selected scope" or "tied best within the
   selected scope" for the top. [SRC: ROADMAP § Report and research behavior]
7. When no participant qualifies: "Qualified recommendations: none. No qualified winner." This is the existing
   Research Library text and its Thai string. [CODE `public/research-library.js` lines 53, 231;
   `public/i18n.js` line 513; PKG § 7.1]
8. Exposure consequence: "This window is now development data for later selection."
9. Fixed notices in English and Thai through `public/i18n.js`: "Simulated research on
   historical data. Not actual Paper execution, not a profitability claim and not a recommendation." and
   "Development results are never qualified recommendations. No qualified winner is a valid result. Viewing this
   report changes nothing." For `ACTUAL_BOT`: the QR-2 notice. [SRC basis: QR2 § 9] The owner reviews the Thai
   text before staging (decision OD-C19).
10. A null shows an em dash and its reason; never 0. [SRC basis: QRL § Research record; QR2 § 9]

`ACTUAL_BOT` view: QR-2 views side by side, disclosed differences in policy, inputs, capital and registration,
`isolates_strategy_quality: false`; no objective, benchmark or rank. Timing: decision OD-C20.

### 11.2 Never shown

- A rank, best, top or winner label, or highlight, for a non-qualified participant. [SRC: QRL; PKG § 7.2]
- A "development ranking" or performance-sorted development table.
- Metrics of an incompatible participant; metrics of the comparison window before the spec is frozen.
- An interpolated, forward-filled or zero-filled value; a number serialized as 0 where the status is null.
- A table mixing modes or context keys. [SRC: QR2 § 1.3]
- A universal best, global optimum or profitability claim. [SRC: PKG § 7.2]
- Holdout performance of rejected candidates as a selection aid. [SRC: PKG § 7.2]
- An apply, import, start-Bot, email or optimize-again action that runs automatically. Owner follow-ups stay
  separate explicit owner actions, each a new job with its own lineage. [SRC: QRL § Explicit follow-up
  jobs; ROADMAP § Report and research behavior]
- Secrets, webhook URLs or machine locations. [SRC: QRL § Quant Data]

### 11.3 Owner actions

| Action | Guards | Codes |
| --- | --- | --- |
| Create comparison spec | Authenticated, CSRF, owner scope on every participant, confirm token, QS-1 admission, read budget, all 9.1 checks | 9.1 codes |
| View comparison | Owner scope; read only; `user_id` never a selector | `NOT_FOUND` |
| Cancel evaluation | Owner scope; status `SPEC_FROZEN` or `EVALUATING` | `QR3_NOT_CANCELLABLE` |
| Request replay | Explicit owner action; new job; never changes the outcome | 9.1 codes; a mismatch appends `REPLAY_MISMATCH` (I4) |

Every action writes an audit event with `comparison_id`, actor, UTC time and outcome. [SRC basis: PKG § 7.3]
No request body carries a Bot action.

---

## 12. Out of scope

- Live trading, brokers other than Spot Paper, Futures, short, margin. [SRC: AGENTS.md § Host and product safety]
- Markets other than BINANCE:BTCUSDT Spot 1m; other timeframes; multi-asset comparisons.
- Automatic optimizer loop, automatic rerun, automatic Best Inputs apply, guard reset, automatic email. [SRC:
  QRL § Explicit follow-up jobs]
- Multi-Pine participants before APP-3B. [SRC: PKG § 9; CODE `MULTI_PINE_RESEARCH_NOT_SUPPORTED`]
- Cost model V2 before V2 parity. [SRC: PKG § 9]
- Capacity above the current 10K profile until QD-1 expanded admission; Deep Research admission. [SRC: ROADMAP
  row QR-3]
- QR-2 computation (F10-01); QR-4 Best Performance Report, qualified selection and export (F10-03); PKG package
  build and READY (F09-01).
- Annualized figures, IRR and Sharpe-type ratios (follow QR2 § 3.7).
- Any profitability or global-optimum claim.
- DP1 native supervision and N1 work.

---

## 13. Independent test and evidence plan

Engineering acceptance and qualified-result acceptance are separate. [SRC: PKG § 11] Engineering tests use
labelled fixtures; a fixture pass never counts as a qualified result. No product override of any gate exists;
fixture gate forcing lives only in the test harness. A tester other than the implementer writes or reviews the
acceptance cases.

### 13.1 Pure module (Node; no database, clock or I/O; DERIVE style)

1. Context key: one change per field C1 to C16 changes the key and appears in mismatches; each subject field
   change keeps the key and appears in disclosed differences.
2. Missing field gives `MISSING:<id>` and never matches.
3. Mode mix refused `QR3_MODE_MIX`; `ACTUAL_BOT` never produces a rank; objective in `ACTUAL_BOT` refused.
4. Period golden cases: 1W, 1M with month-end clamp (31 January plus one month), YTD, All Available bounded,
   Custom; half-open bounds; future end refused; `end <= start` refused; over-limit refused, never truncated.
5. Gap in `[start - W_max, end)` refuses `QR3_DATASET_GAPPED` with intervals; a gap before `start - W_max` does
   not.
6. Coverage shorter than the period gives `EXCLUDED_COVERAGE`; the period never shrinks.
7. Valuation golden fixture: hand-computed NAV, return, drawdown on V4, end marking V5, rounding V7.
8. Benchmark golden fixture: B1 to B6, quantity rounding, residual cash, missing bars give
   `QR3_BENCHMARK_DATA_UNAVAILABLE`.
9. Freeze order: a record created before `frozen_at_utc` gives `QR3_RESULT_PREDATES_SPEC` and
   `DEVELOPMENT_EVIDENCE`.
10. Evidence class: overlap with an earlier holdout of the same owner and market gives
    `QR3_WINDOW_OVERLAPS_EARLIER_HOLDOUT`; with another market does not; overlap with searched train or
    validation of the same owner and source gives `QR3_WINDOW_OVERLAPS_SEARCHED_DATA`; with another source does
    not; earlier QR-3 exposure or QR-4 selection exposure of the same owner and market gives
    `QR3_WINDOW_PREVIOUSLY_EXPOSED`; window before a registered boundary gives
    `QR3_WINDOW_BEFORE_REGISTERED_BOUNDARY`.
11. Qualification today: every participant is `QR3_NOT_QUALIFIED` with `QL4C_VALIDATION_NOT_AVAILABLE`; outcome
    `NO_QUALIFIED_RESULT`.
12. Episode gate absent gives `QR3_EPISODE_GATE_NOT_AVAILABLE` and FAIL; closed allocations never count.
13. Unconfirmed valuation basis (V8) gives `VALUATION_BASIS_UNCONFIRMED` and no rank.
14. Labelled fixture forcing every gate PASS: adequacy boundaries 4, 5, 19, 20; risk filter boundary at the
    limit; tie band boundary; interval including zero gives `QUALIFIED_TIE`; exact decimals (`1.50` equals
    `1.5`); a fixture comparison is never shown as a qualified result outside the test.
15. Uncertainty determinism: same seed gives identical intervals; another seed gives another spec hash.
16. Label validator: refuses best/top/winner text and any rank for a non-qualified participant; refuses "best"
    without "within the selected scope"; refuses a 0 where status says null.
17. Development tier order is creation time then id, whatever the metrics.
18. Filter tightening allowed, loosening refused `QR3_FILTER_LOOSENED`.
19. Determinism: same frozen inputs give the same `outcome_hash`; property test that ordering is a total
    preorder consistent with the objective.
20. Stored-result view (M4): aligned period resolves; off by one bar refuses `QR3_PERIOD_NOT_PARTITION_ALIGNED`;
    block is always `DEVELOPMENT_EVIDENCE` and unranked.
21. Root clarification tests (RC-C1 to RC-C27): ranks `[1,1,3]` with both top labels `TIED_BEST_LABEL` when the
    method is not approved; label case and spacing variants refused; label metrics refused for lifecycle
    `undefined`, `FAILED` and `CANCELLED`; F3 id and hash mismatch, unreadable record, and equal
    `created_at` and `frozen_at`; V8 participant with a record gets `DEVELOPMENT_EVIDENCE` and later checks
    `NOT_REACHED` (updates test 13); bootstrap input bounds; duplicate participant ids; `spec_hash` mismatch;
    unlisted context sub-key; normalised declared context; bar with `complete !== true`; same-bar fills with and
    without `sequence`; number inputs refused; malformed adequacy spec; `*_exact` at 80 digits; drawdown default
    with a lower owner limit; relative periods end- and start-anchored; YTD at January 1; first grid point
    `NAV(start)`; adverse tick rounding; `NO_UNITS_AFFORDABLE`; tie chaining; hand-derived non-degenerate
    bootstrap golden; hidden metrics for `EXCLUDED_*` and `UNAVAILABLE`.
22. Mutation-gap tests: duplicate bars at `end_ms` ignored by `checkDatasetGaps`; tie band 0.51 and 0.6 per
    OPEN-1; `min_episodes_floor` equal to `min_episodes_ranking` accepted; resamples 20000 accepted and 20001
    refused; bootstrap tails with 999 resamples at 0.95; hand-derived bootstrap bounds with block restart;
    `dailyReturns` with an unsorted `navSeries`; `round18` half-even tie at the 19th decimal; SELL fill with a
    nonzero fee; exposure event at exactly `as_of_ms` counted; `EXCLUDED_COVERAGE` hides metrics; gate state
    `PASS` with `pass:false` is FAIL; `initial_inventory` `'2'` and `'0.5'` give `QR3_SPEC_INCOMPLETE`.

### 13.2 Isolated PostgreSQL (throwaway cluster, one file per process)

1. Update and delete on every QR-3 table refused with the root-assigned SQLSTATE, including by the owner role;
   the freeze survives a `search_path` shadowing attempt.
2. Foreign and absent comparison ids return `NOT_FOUND` (404) alike.
3. Reads run under `SET TRANSACTION READ ONLY`; a read never writes and never starts a job.
4. Spec row committed before the first evaluation write (transaction order check).
5. Exposure events append-only, one per participant and window; another owner unaffected. An empty
   register is valid; an absent or unreadable register refuses create with
   `QR3_EXPOSURE_REGISTER_UNAVAILABLE`.
6. Replay mismatch appends `REPLAY_MISMATCH`; outcome unchanged; read shows `STALE`.
7. Concurrent create of two specs over the same participants gives two comparisons with their own exposures.
8. Research rows byte-identical after repeated comparisons (QR-1 tester byte-identity method).

### 13.3 API and UI (Node, local, JSDOM; no browser)

1. Every 9.1 code reachable with exactly one input change.
2. Spec block renders before any metric; no metric while `SPEC_FROZEN` or `EVALUATING`.
3. `NO_QUALIFIED_RESULT` shows "Qualified recommendations: none. No qualified winner." in English and Thai.
4. No apply, import, start-Bot or email control on the comparison view; no POST other than create, cancel and
   replay request.
5. Incompatible participant shows mismatch fields and no metrics.
6. 1280 and 375 px layout on the local stub; Thai text check.

### 13.4 Staging evidence (F10-02 target)

1. Deploy with the QR-1b freeze present and verified, after root GO.
2. Labelled fixture path: a `STANDARDIZED` comparison of two fixture subjects within the 10K profile reaches
   `COMPLETE` with `NO_QUALIFIED_RESULT`; spec frozen before evaluation; exposure events present.
3. One real `STANDARDIZED` comparison of the owner's runs, if eligible data exists: `DEVELOPMENT_EVIDENCE`,
   `INADEQUATE_EVIDENCE` or `NO_QUALIFIED_RESULT`, never a rank. Record response hash and context keys.
4. One comparison with mismatched context (for example the historical legacy run against a FOUNDATION run):
   mismatched fields listed, no metrics.
5. Read-only proof: research rows byte-identical before and after; read p95 within the read budget of decision
   RD-6.
6. No Bot, session, job other than the admitted evaluation, email or policy change; health check ten minutes
   later.
7. `ACTUAL_BOT` needs QR-2 staging first; until then reported as not run.
8. Root accepts; the tester's report is evidence, not acceptance. Commit, CI, deploy and acceptance are separate
   facts.

### 13.5 Slice plan

| Slice | Content | Gate |
| --- | --- | --- |
| S1 | Pure module: context/subject split, period resolver, valuation, benchmark, evidence class, adequacy, ties, uncertainty, label validator, stored-result view | Unit suite green; auditor review of formulas and evidence rules |
| S2 | Insert-only tables and freeze triggers; the shared exposure register unless a QR-4 slice created it first; library G5 reads the register (new `library-qualification` version, decision OD-C8) | Migration review under QR2 § 7.5 rules, own GO |
| S3 | Admitted evaluation job class under QS-1 (fixed-input new-period backtest, lineage) | Decisions RD-5 and RD-7 carried out; capacity review; local PostgreSQL recovery and cancel |
| S4 | Owner-scoped API (create, view, cancel) | 13.2, 13.3 |
| S5 | UI and notices | JSDOM, mobile and Thai checks; owner Thai review (decision OD-C19) |
| S6 | Staging evidence 13.4 | Root acceptance |

Root split S2 (RC-C28): S2a is the exposure register extension (`src/postgres/quant-exposure-register.sql`, its rollback
and offline tool, `src/postgres/exposure-register.js`, grants); S2b is library G5 v2 reading the register; S2c is the QR-3
comparison tables. S2a is local only. Staging follows in one later data-model window (RC-C36).

---

## 14. Known risks

- K1 Nothing can be ranked today (G6, G7, G8; episode gate absent). F10-02 acceptance asks for enforced
  compatibility, not a winner; `NO_QUALIFIED_RESULT` is valid (decision RD-8).
- K2 With 10K bars and a 60/20/20 split, disjoint independent windows are short. Most comparisons will be
  `INADEQUATE_SAMPLE` or `DEVELOPMENT_EVIDENCE` until QD-1 expanded admission.
- K3 Every evaluation consumes its window (exposure register). Repeated comparisons exhaust fresh history. This
  is intended; the owner sees it as a cost.
- K4 Paired daily bootstrap on short windows often includes zero and gives `QUALIFIED_TIE`. Intended.
- K5 QR-2 is not implemented; `ACTUAL_BOT` depends on it.
- K6 The exposure register changes later G5 and B0 outcomes (decision OD-C8). PKG is accepted, so the B0
  extension is recorded as PKG OD-19 and not assumed.
- K7 The evaluator may not yet emit fees, exposure, rejected intents, episodes or a bar-close grid (V8). Then
  QR-3 shows nulls and ranks nothing until the research contract records them. Root judges at acceptance
  whether "complete" needs these metrics recorded first; this risk stays open.
- K8 Real staging runs may never share a context; the first real result is likely `EXCLUDED_INCOMPATIBLE` or
  `INADEQUATE_EVIDENCE`. That is a valid result, not a defect.
- K9 A QR-3 comparison can evaluate on a window that a QR-4 selection registered while some of its
  evaluation runs have not started or its outcome is not written. QR-4 rechecks the exposure register
  at each of its evaluation starts and before its outcome write, and ends `SELECTION_INCOMPLETE` with
  `QR4_WINDOW_EXPOSED` (QR-4 § 4.1, § 13.3).

---

## 15. Decisions

The owner decided OD-C1 to OD-C22 on 2026-10-19 and chose the recommended option for every item. Root decided
RD-1 to RD-10 the same day. Each outcome is part of this contract.

| ID | Decision | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| OD-C1 | v1 objective | Net return after costs with a drawdown filter and no tie-break; no composite score. | Owner | 2026-10-19 |
| OD-C2 | Uncertainty method; is it required for a sole best label | Paired daily block bootstrap; required for a sole best label. | Owner | 2026-10-19 |
| OD-C3 | Tie definition | Tie band 0.50 percentage points, or the uncertainty interval of the difference includes zero. | Owner | 2026-10-19 |
| OD-C4 | Ranking adequacy threshold | 20 completed episodes; 5 to 19 stay development evidence; the episode gate comes first. | Owner | 2026-10-19 |
| OD-C5 | Evaluation source | A fresh fixed-input evaluation after the freeze is the only rankable path; stored partitions appear only as a labelled development view. | Owner | 2026-10-19 |
| OD-C6 | Development-tier order | Neutral order only (creation time, then id). | Owner | 2026-10-19 |
| OD-C7 | Participant count in v1 | 2 to 4. | Owner | 2026-10-19 |
| OD-C8 | QR-3 exposures feed library G5 and package B0 | Yes. Recorded as a new PKG decision (PKG OD-19, code `BI_HOLDOUT_EXPOSED_BY_SELECTION`). | Owner | 2026-10-19 |
| OD-C9 | Independence and exposure scope | Holdout and exposure: same owner and same market. Searched train/validation: same owner and same source. Matches G5 and PKG OD-10. | Owner | 2026-10-19 |
| OD-C10 | Open position at window end | Mark at end close; liquidation only as a separately labelled line. | Owner | 2026-10-19 |
| OD-C11 | Buy & Hold entry timing | First evaluation bar close under the context fill model; same basis as participants. | Owner | 2026-10-19 |
| OD-C12 | Buy & Hold exit fee | None in the main line; a labelled liquidation line only. | Owner | 2026-10-19 |
| OD-C13 | Partial coverage | Exclude the participant. The owner may create a new comparison with a shorter period. | Owner | 2026-10-19 |
| OD-C14 | Existing `quant-library-compare-v1` route | Keep, relabelled as the same-source context check; show both keys. | Owner | 2026-10-19 |
| OD-C15 | Engine equality across participants | Required. | Owner | 2026-10-19 |
| OD-C16 | Benchmark in `ACTUAL_BOT` | None in v1. | Owner | 2026-10-19 |
| OD-C17 | `PARTIAL` QR-2 views in `ACTUAL_BOT` | Shown with nulls and QR-2 reasons; QR-2 expects many `PARTIAL` accounts and nothing is ranked. | Owner | 2026-10-19 |
| OD-C18 | Single eligible participant | Label "only qualified participant within the selected scope"; no winner. | Owner | 2026-10-19 |
| OD-C19 | Thai labels | The owner reviews them before staging. | Owner | 2026-10-19 |
| OD-C20 | `ACTUAL_BOT` timing | Specify now; implement after the QR-2 S3 routes. | Owner | 2026-10-19 |
| OD-C21 | Owner filter overrides | Tighten only. | Owner | 2026-10-19 |
| OD-C22 | Exposure retention | Owner lifetime. | Owner | 2026-10-19 |
| RD-1 | SQLSTATE for QR-3 freeze triggers in the project error namespace | Root assigns the code at implementation. | Root | 2026-10-19 |
| RD-2 | Exit semantics version in context (C8) or in the subject | In the context, field C8. | Root | 2026-10-19 |
| RD-3 | Final context field review C1 to C16 against both research contract builders: `risk_percent` grouping (code `cost_model`), capital mapping from code `{equity, cash}`, `timestamp_semantics` source | Root reviews C1 to C16 against both builders at implementation; the field list stays as written until that review. | Root | 2026-10-19 |
| RD-4 | PM-1 credit | D credit only after root accepts this contract; I, V, T only from implementation evidence; no double credit for P06-03. | Root | 2026-10-19 |
| RD-5 | End-of-window rule and metric emission of the evaluator | Root confirms from the evaluator source whether it can emit the bar-close grid, fees, exposure, rejected intents and completed episodes; until then V8 holds. Checked 2026-10-19 (QR-4 RO-8): for cost model paper-close-v1 the evaluator fills entries and every exit at the signal bar close with adverse slippage, rounds BUY prices up and EXIT prices down to the tick, rounds quantity down to the step, marks an open position at the last close without liquidation and orders same-bar fills by sequence. The research path emits counts only; the pure FE-1 evaluator emits the needed records but is not wired, so V8 still holds until the evaluation job (S3) emits them under a versioned closure. | Root | 2026-10-19 |
| RD-6 | Read budget numbers: participant count, contract bytes, read p95 | Root fixes the numbers with the API slice (S4); the v1 participant count stays 2 to 4. | Root | 2026-10-19 |
| RD-7 | Job class design | One shared fixed-input new-period backtest job class with QR-4, `run_id`/`parent_run_id` lineage, QS-1 budget and cancel/recovery. | Root | 2026-10-19 |
| RD-8 | K1 reading | Confirmed: F10-02 acceptance can be met with `NO_QUALIFIED_RESULT`. | Root | 2026-10-19 |
| RD-9 | Synchronize docs after owner decisions | PKG amended (OD-19, OD-20); QRL comparison section and ROADMAP QR-3 status text follow; Roadmap and Time Management at the checkpoint. | Root | 2026-10-19 |
| RD-10 | Independent review before acceptance | Done before acceptance; the review result is evidence, not acceptance. | Root | 2026-10-19 |

### Root clarifications (2026-10-19)

Root clarified these points from the QR-3 S1 review. None changes an owner decision OD-C1 to OD-C22. Each row
names the sections edited in place.

| ID | Clarification | Sections changed | Decided by | Date |
| --- | --- | --- | --- | --- |
| RC-C1 | F3 record inputs `record_comparison_id` and `record_spec_hash` must equal `comparison_id` and `spec_hash`, else `QR3_RESULT_PREDATES_SPEC` (unreadable: `QR3_INTEGRITY_FAILED`); `created_at` strictly later than `frozen_at` | 6.1 F3, 13.1 item 21 | Root | 2026-10-19 |
| RC-C2 | V8: a participant with a record that fails the evaluation check is `DEVELOPMENT_EVIDENCE` with `VALUATION_BASIS_UNCONFIRMED` and/or `METRIC_NOT_RECORDED`; recorded metrics visible, missing ones null with reason, never ranked, later checks `NOT_REACHED`; `NOT_EVALUATED` only with no record; required metrics are those the S1 module implements | 5.1 V8, 13.1 items 13 and 21 | Root | 2026-10-19 |
| RC-C3 | Label validator accepts only the exact label text; case or spacing variants are `R3 LABEL_WITHOUT_SELECTED_SCOPE`; any other non-null label is refused (`X1 LABEL` for a participant that is not eligible, else `R3 LABEL_NOT_ALLOWED`) | 6.6 R3, 13.1 item 21 | Root | 2026-10-19 |
| RC-C4 | Uncertainty method not approved: merge the top two groups as in the interval-unavailable case; ranks `[1,1,3]`, both top labels `TIED_BEST_LABEL` | 6.4, 13.1 item 21 | Root | 2026-10-19 |
| RC-C5 | Label validator allows participant metrics only when lifecycle is `COMPLETE` (`undefined`, `FAILED`, `CANCELLED` refused) | 6.6 R3, 13.1 item 21 | Root | 2026-10-19 |
| RC-C6 | Context sub-key not listed in 3.2 is unreadable (`MISSING:<id>`) until RD-3 is decided | 3.2 | Root | 2026-10-19 |
| RC-C7 | `compareToDeclared` normalises the declared context through the same readers as a participant context | 3.4 | Root | 2026-10-19 |
| RC-C8 | A bar counts for the period only when `complete === true` | 4.3 G1 | Root | 2026-10-19 |
| RC-C9 | Same-bar fills sort by an explicit `sequence` field; missing `sequence` refuses `QR3_METRIC_UNAVAILABLE` detail `FILL_ORDER_UNKNOWN` | 5.1 V6, 9.2 | Root | 2026-10-19 |
| RC-C10 | Money, metric and threshold inputs (context capital and costs, spec drawdown limit, tie band, confidence) of type `number` refused `QR3_SPEC_INCOMPLETE` detail `NUMBER_NOT_DECIMAL_STRING` in the declared context and the spec; in a participant context a number is unreadable and excludes the participant (`QR3_CONTEXT_MISMATCH`) | 5.1 V7, 9.2 | Root | 2026-10-19 |
| RC-C11 | Malformed adequacy spec refuses the outcome with `QR3_SPEC_INCOMPLETE` (never `INADEQUATE_EVIDENCE`); `QR3_EPISODE_GATE_NOT_AVAILABLE` only when the gate is absent; an unreadable episode count with the gate available is `QR3_METRIC_UNAVAILABLE` | 6.3 S5 | Root | 2026-10-19 |
| RC-C12 | `pairedBootstrapInterval` requires `0 < confidence < 1`, `resamples <= MAX_RESAMPLES` (20000), `block_length <= MAX_BLOCK` (3650), else `QR3_SPEC_INCOMPLETE` | 6.4 | Root | 2026-10-19 |
| RC-C13 | Outcome decision refuses duplicate participant ids (`DUPLICATE_RUN_ID`) and a `spec_hash` that differs from the recomputed hash (`QR3_SPEC_IMMUTABLE`); for a standardized comparison it also re-validates the frozen spec (mode `STANDARDIZED`, valid content against the registry defaults, canonical form equal to the supplied spec, matching hash), else `QR3_SPEC_INCOMPLETE` detail `SPEC` | 6.1 F4, 9.2 | Root | 2026-10-19 |
| RC-C14 | Every `*_exact` field is the unrounded value at 80 digits | 5.1 V7 | Root | 2026-10-19 |
| RC-C15 | Registry drawdown default is `min(20, owner_max_drawdown_percent)`, input `owner_max_drawdown_percent` | 6.2 | Root | 2026-10-19 |
| RC-C16 | Relative periods 1W to 3Y are end-anchored at the last completed bar end; `start_ms` makes them start-anchored; anchor shown and frozen | 4.1 | Root | 2026-10-19 |
| RC-C17 | YTD at exactly January 1 00:00 UTC is refused `QR3_PERIOD_INVALID` | 4.1 | Root | 2026-10-19 |
| RC-C18 | V4 first grid point is `NAV(start)` = `initial_cash` | 5.1 V4 | Root | 2026-10-19 |
| RC-C19 | Tick rounding is adverse (buy up, sell down); RD-5 confirmed this is the evaluator rule for paper-close-v1 on 2026-10-19 | 5.1 V6 | Root | 2026-10-19 |
| RC-C20 | `initial_cash` below one quantity step: benchmark row null `QR3_METRIC_UNAVAILABLE` detail `NO_UNITS_AFFORDABLE`, excess return null, comparison not refused | 5.3 B1 | Root | 2026-10-19 |
| RC-C21 | Tie chaining is single linkage over adjacent sorted gaps | 6.5 T1a | Root | 2026-10-19 |
| RC-C22 | Tie groups use competition ranks (1,1,3) | 6.5 T2 | Root | 2026-10-19 |
| RC-C23 | Bootstrap method fixed as implemented (stationary, restart 1/`block_length`, circular, same indices, difference of compounded returns, tails `floor(R*(1-c)/2)`, first day against initial NAV) plus a hand-derived non-degenerate golden | 6.4, 13.1 item 21 | Root | 2026-10-19 |
| RC-C24 | Unnamed conditions use `QR3_METRIC_UNAVAILABLE` with detail, `QR3_SPEC_INCOMPLETE`, `QR3_OBJECTIVE_NOT_ALLOWED` as implemented | 9.2 | Root | 2026-10-19 |
| RC-C25 | `HOLDOUT_EXPOSED_BY_COMPARISON` keeps the class `DEVELOPMENT_EVIDENCE` | 7 | Root | 2026-10-19 |
| RC-C26 | Metrics hidden for `EXCLUDED_INCOMPATIBLE`, `EXCLUDED_COVERAGE`, `EXCLUDED_INTEGRITY` and `UNAVAILABLE` | 3.4 | Root | 2026-10-19 |
| RC-C27 | `STALE`, replay-mismatch and `ACTUAL_BOT` checks stay todo for slices S2, S4 and QR-2 S3 | 8.1 | Root | 2026-10-19 |

Mutation-gap tests (ruling E) are listed in 13.1 item 22.

Open owner items (todo marked OWNER; fail closed until the owner decides):

- OPEN-1 (F7 wider tie band). OD-C3 fixes the band at 0.50 percentage points. Interim behaviour: a band narrower
  than 0.50 is refused `QR3_FILTER_LOOSENED`; a wider band is refused `QR3_SPEC_INCOMPLETE` with detail
  `TIE_BAND_FIXED`. Only the owner may change this.
- OPEN-2 (R5 single qualified participant outcome). OD-C18 fixes the label. Interim behaviour: exactly one
  `ELIGIBLE_QUALIFIED` participant gets no rank, only the R5 label, and `only_qualified_participant_id` is set.
  The outcome value stays as implemented. The owner decides whether a new outcome `SINGLE_QUALIFIED_RESULT` is
  added.

### Root decisions for slice S2 (2026-10-20)

Root accepted the S2 design options below after an independent architecture review, and the S2a review rounds.
None changes an owner decision.

| ID | Decision | Sections | Who | Date |
| --- | --- | --- | --- | --- |
| RC-C28 | S2 is split into S2a (register extension, writer, reader, adapters), S2b (library G5 v2) and S2c (QR-3 comparison tables); each slice has its own review | 13.5 | Root | 2026-10-20 |
| RC-C29 | One shared table `quant_exposure_register` in its own extension with a `kind` discriminator (`QR3_COMPARISON`, `QR4_SELECTION`), the market as three columns and a half-open minute-aligned window `[start_ms, end_ms)` with warm-up excluded and `end_ms` at most 253402300800000; marker table `quant_exposure_register_schema` version 1 | 7 | Root | 2026-10-20 |
| RC-C30 | Register rows are insert-only: UPDATE, DELETE and TRUNCATE fail with SQLSTATE `QR002`; an INSERT outside a SERIALIZABLE transaction fails with `QR003`; the triggers fire ALWAYS | 7, 10 | Root | 2026-10-20 |
| RC-C31 | One writer (`appendExposures`): its first statement locks the register in SHARE ROW EXCLUSIVE mode, it reads the clock once per call, and a missing or invalid register throws so the caller's transaction aborts. Only a refused overlap check (`EXPOSURE_CHECK_REFUSED`) and invalid input events (`EXPOSURE_EVENT_INVALID`, found before any statement runs) return `ok:false`; the caller must stop on `ok:false` | 7, 9.1 | Root | 2026-10-20 |
| RC-C32 | QR-3 appends one event per participant and window inside the spec-freeze (create) SERIALIZABLE transaction; a cancel keeps the events; an `ACTUAL_BOT` comparison writes no exposure | 6.1, 7 | Root | 2026-10-20 |
| RC-C33 | Library G5 v2 counts an exposure only when `at_ms` is at or before the run creation time; a later overlap is shown as the informational `HOLDOUT_EXPOSED_BY_COMPARISON` flag and does not change G5 | 7 | Root | 2026-10-20 |
| RC-C34 | Rollback runs only on an empty register; with rows it refuses and changes nothing | 10 | Root | 2026-10-20 |
| RC-C35 | Grants: the register is protected (no DELETE, TRUNCATE or TRIGGER for the runtime role) and keeps table UPDATE only to carry the writer lock; the marker table is read-only. Accepted residual risk: that UPDATE also permits a stronger table lock, bounded by the statement and idle-in-transaction timeouts, as for the scheduler table | 7, 10 | Root | 2026-10-20 |
| RC-C36 | S2 is local only. Staging needs one later data-model window after S3 and S4 local acceptance, covering the QR-1b freeze, the register, the QR-3 tables and a grant reapply, each checked by `--inspect`, with one fresh owner GO naming all steps, the operations worker only and a restore rehearsal | 13.5 | Root | 2026-10-20 |
| RC-C37 | S2c is its own offline extension (`quant-comparison` version 1, marker `quant_comparison_schema`) that requires the exposure register installed. It comes in two sub-slices inside the same uninstalled version 1 file before any staging step: S2c-1 (specs, participants, status events, the create path and the owner read) and S2c-2 (evaluation records with the F3 trigger, benchmarks, outcomes and replay events) | 13.5 | Root | 2026-10-20 |
| RC-C38 | SQLSTATE plan as PKG RC-25: `QR002` for edits, `QR003` for a write outside SERIALIZABLE, `QR004` for insert guards, mapped by guard (freeze order to `QR3_RESULT_PREDATES_SPEC`, status transition to `QR3_NOT_CANCELLABLE`, create completeness to `QR3_INTEGRITY_FAILED`). Every QR-3 write is SERIALIZABLE | 9, 10 | Root | 2026-10-20 |
| RC-C39 | Freeze and creation times of comparison rows come from the database clock in insert triggers and strictly increase within a comparison; the register `at_ms` keeps the application clock (RC-C31), and the two clocks are never compared | 6.1, 10 | Root | 2026-10-20 |
| RC-C40 | A deferred commit check makes the create atomic: the declared participant count, only the `SPEC_FROZEN` first event, no result rows, and exactly one register event per participant with the same owner, market, window, run and source hash | 6.1, 7 | Root | 2026-10-20 |
| RC-C41 | Prior exposure is recorded per participant inside the create transaction from the locked register read; a later exposure only makes a read `STALE` | 7, 8.1 | Root | 2026-10-20 |
| RC-C42 | Status is an insert-only event log with a transition guard; bodies are canonical text with a SHA-256 check; version 1 accepts `STANDARDIZED` only (`ACTUAL_BOT` follows QR-2 S3, OD-C20); result rows that break F3 are refused in the database; rollback runs only while every table is empty; an optional request key is unique per owner; the tables join the insert-only grant list | 2, 6.1, 8, 10 | Root | 2026-10-20 |

Owner items raised by the S2c design (fail closed until decided): which owner account holds staging fixture
comparisons, since every comparison writes real exposure rows that are kept for the owner lifetime (OD-C22); how
account deletion relates to those insert-only rows; and OPEN-2, which should be decided before S2c-2 fixes the outcome
values.

Known gaps recorded for the shared hardening backlog (not blocking S2a): the install inspection checks the runtime
role's own superuser and bypass-RLS attributes but not membership in a role that has them; the QR-1b freeze
inspection matches the table owner by exact name instead of role membership.
