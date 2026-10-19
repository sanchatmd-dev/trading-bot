# QR-4 qualified best-performance selection contract

Status: owner decisions OD-S1 to OD-S20 recorded 2026-10-19; root decided RO-1 to RO-12 the same day.
Root accepted the other rules after independent review.
Implementation has not started; nothing here grants a ranking, label, recommendation, apply or Bot action.
This contract is not a GO. It changes no Roadmap row by itself and earns no PM-1 credit by itself.

Feature: PM-1 F10-03 "QR-4 qualified best-performance selection". Target: staging.

Revision read: branch `codex/app3a-market-wait-checkpoint`, HEAD `910b8f9`.
`docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md` is committed at this revision. The 2026-10-19 QL4
amendment (OD-19, OD-20) and the QR-3 contract (`docs/QR_3_FAIR_COMPARISON_CONTRACT.md`) were read
before commit.

## 0. Reading key

- `[SRC: path § section]` marks a rule taken from a source. Paths are relative to the repository.
- `CODE:` marks a fact read from current code. Code facts show the interfaces. They are not acceptance
  evidence.
- A rule without a `[SRC:]`, `CODE:` or `DERIVED` mark is a rule that this contract introduces. Root
  accepted these rules after independent review. Section 17 records the owner and root decisions.
- `DERIVED` marks a result that follows from two or more sourced facts or code facts. The reasoning is
  given so that a reviewer can check it.
- Short names: ROADMAP = `docs/ROADMAP.md`; QRL = `docs/QUANT_RESEARCH_LIBRARY.md`; QL4 =
  `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md`; QR2 = `docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md`;
  INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`; SC = `docs/progress/PM1_SCORECARD_S1_2026-10-15.json`;
  DERIVE = `src/quant-library/derive.js`; LIB = `src/postgres/quant-library.js`; UI =
  `public/research-library.js`.
- Owner decision IDs use the prefix `OD-S` (S for selection), so they never collide with QL4 `OD-n` or
  QR2 `OD-Qn`. Root-only items use the prefix `RO-n` (section 17.2).

Scope guard for every rule below [SRC: AGENTS.md § Host and product safety; QL4 § 0]:

- Spot/Paper only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, no Live.
- No automatic optimizer loop, no guard reset and no automatic Best Inputs apply.
- Independent holdout gates apply.
- Development scores are never qualified recommendations.
- `NO_VALID_CANDIDATE` is a valid run outcome. "No qualifying strategy" and "inadequate evidence" are
  valid selection outcomes.
- No number in a selection view is a profitability claim or a forecast.

## 1. Purpose, acceptance target and dependencies

### 1.1 Acceptance target

F10-03 acceptance: "Selection distinguishes development scores from qualified recommendations and
refuses unsupported rankings." Target: staging. [SRC: INV row F10-03]

The scorecard gives F10-03 no credit: D UNKNOWN, I 0, V 0, T 0. [SRC: SC row F10-03]

- D rationale: "Approved QR-4 principles exist; fixed qualified-ranking objective and full review checks
  not reconciled." This contract answers with the objective registry (section 6) and the review checks
  (sections 4, 5 and 7).
- I rationale: "no-winner safety display alone is not full selection."
- Carry limitation: "Development scores and historical winning candidates cannot become qualified
  recommendations." Sections 3 and 4 and the refusal `QR4_DEVELOPMENT_SCORE_NOT_RANKABLE` enforce it.
- Next action: "QR-2/QR-3 and eligible independent validation before qualified selection." Section 1.3
  makes this a set of hard dependencies.

### 1.2 Sourced principles this contract implements

- QR-4 row: "Best Performance Report and owner-requested replay, new-period backtest or new optimization
  with lineage." Gate: "New run/parent identity, capability/data/privacy/resource checks; no original
  result overwritten or automatic rerun/apply. Qualified ranking/export is validation-gated." Also,
  "QR-2/QR-3 precede QR-4 customer reporting." [SRC: ROADMAP § Approved extension — Quant Research
  Library and Best Performance, row QR-4 and the paragraph after the table]
- Rank only qualified results on a predeclared objective within owner risk limits. Show the Buy & Hold
  benchmark, drawdown, episode counts, costs, exposure and uncertainty. Label the winner as best within
  the selected scope, never universally best. No qualified winner is a valid outcome. Previously exposed
  holdout becomes development evidence for later selection, and new claims need independent data.
  [SRC: ROADMAP § Report and research behavior]
- "Only untouched disjoint periods support independent evaluation. Ranking finalists on holdout makes it
  selection data, not independent proof of the selected winner." [SRC: ROADMAP § Report range and
  research capacity contract]
- Standardized evaluation needs the same asset and venue, a common evaluation window, capital, policy,
  costs, execution and valuation conventions, and a declared comparison objective. Comparing selected
  winners is itself a selection step, so record prior searches, exposed periods and all participants.
  Register the objective and the risk and sample filters before ranking. Report net return, Buy & Hold
  on the same price and cost basis, drawdown, costs, exposure, completed episodes, rejected intents and
  robustness or uncertainty. [SRC: QRL § Strategy Comparison and Best Performance]
- Only qualified results may receive a best-in-scope label. Allow ties, inadequate evidence and no
  qualifying strategy. A fixed weighted score is not assumed or invented after viewing results. Viewing a
  report never starts or changes a Bot. [SRC: QRL § Strategy Comparison and Best Performance]
- Follow-ups receive a new `run_id`, mode and `parent_run_id`. A comparison has its own `comparison_id`
  with all participants. The old record is kept. A report view never starts an automatic optimization,
  a Bot apply, a new session or an email enqueue. [SRC: ROADMAP § Report and research behavior; QRL
  § Explicit follow-up jobs]

### 1.3 Hard dependencies (gates)

| Dependency | Why | Until met |
| --- | --- | --- |
| QL-4C READY packages and library G8 PASS [SRC: QL4 § 5.5, § 6.3] | Only qualified results may be ranked [SRC: QRL § Strategy Comparison] | Every registration refuses `QR4_NO_ELIGIBLE_PARTICIPANT` |
| QR-3 standardized valuation and Buy & Hold methods [SRC: QR2 § 1.3, "QR-3 owns benchmarks (OD-Q15)"; ROADMAP row QR-3] | The ranking needs one common valuation, cost and benchmark basis | Registration refuses `QR4_QR3_CONTEXT_UNAVAILABLE` |
| A fixed-input evaluation run mode with `parent_run_id` (section 5.4) | New runs evaluate the common window. Old runs are never edited | Registration refuses `QR4_EVALUATION_MODE_UNAVAILABLE` |
| The QL4 episode gate [SRC: QL4 OD-4] | Episode counts are a required report field and filter | Registration refuses `QR4_EPISODE_GATE_UNAVAILABLE` |
| An exposure registry that exists and is readable (section 13.3) | Window checks need it | Registration refuses `QR4_EXPOSURE_REGISTRY_UNAVAILABLE` |
| QS-1 admission for the evaluation runs [SRC: QRL § Periods and data admission] | Heavy work shares the global budget | Evaluation waits in the queue, or the selection ends `SELECTION_INCOMPLETE` |

QR-2 is not a ranking input. QR-2 never feeds the standardized evaluation mode, and it has no ranking or
best output. QR-4 may cite a QR-2 view only as actual-history context. [SRC: QR2 § 1.3]

A QR-3 comparison outcome is not a ranking input either, `QUALIFIED_RANKING` included. From QR-3 this
contract uses only the valuation and Buy & Hold method ids (section 5.2), the shared evaluation job class
(RO-7) and the shared exposure register (section 13.3). [SRC basis: SC row F10-03 carry limitation;
QR-3 contract § 1.3]

## 2. Current state

1. No run can be qualified today. CODE: DERIVE gate G8 `QL4C_VALIDATION` always fails with
   `QL4C_VALIDATION_NOT_AVAILABLE`. `QUALIFIED_TOTAL` is 0 and `QUALIFIED_WINNER` is null (DERIVE lines
   18-20, 262).
2. CODE: LIB returns `qualified_total` and `qualified_winner` on the list, detail and compare routes. The
   compare route accepts 2 to 4 runs (`COMPARE_RUN_COUNT`, LIB line 348). It sorts them by `created_at`
   and then `run_id` (LIB line 311). It returns `COMPATIBLE` only when all 13 `library-compat-v1` fields
   are equal, and it never ranks. Every read runs after `SET TRANSACTION READ ONLY` (LIB line 246).
3. CODE: UI line 267 states "Development scores are in-sample selection; no run is ranked." UI lines
   53, 231 and 249 state "Qualified recommendations: none. No qualified winner."
4. CODE: the development score is the stored validation net return of the engine-selected candidate
   (`SCORE_BASIS = VALIDATION_NET_RETURN_PERCENT`). DERIVE says it "is in-sample selection, never a
   recommendation". The objective inside a run is `VALIDATION_NET_RETURN_THEN_DRAWDOWN_THEN_PARAMETERS`,
   fixed in engine code (LIB `OBJECTIVE`, line 170).
5. CODE: LIB always reports the provenance gap `NO_BENCHMARK_OR_COMPARISON_OBJECTIVE` (line 166).
6. CODE: the stored cost stress of a selected candidate covers `train` and `validation` only. No holdout
   cost stress is stored (DERIVE `selectedView`, line 113).
7. CODE: no tracked `src` file defines `parent_run_id` or a replay or new-period run mode. The QR-4
   follow-up modes do not exist yet.
8. The owner decided QL4 OD-1 to OD-19, and root decided OD-20. QL4 is not implemented. G6 and G7 cannot
   pass for any run under either current research contract version. [SRC: QL4 § 2 items 4 and 5; § 12 R1]
9. The QR-3 contract (`docs/QR_3_FAIR_COMPARISON_CONTRACT.md`) was recorded on 2026-10-19. It is not
   implemented. QR-3 status in ROADMAP is "Partial: minimum context-matched comparison only." [SRC:
   ROADMAP § Work packages and phase placement, row QR-3]
10. The current runtime capacity is 10,000 bars, warm-up included, for the narrow profile. [SRC: ROADMAP
    § Report range and research capacity contract]

### 2.1 Consequence: own holdouts cannot be ranked (DERIVED)

- G5 `HOLDOUT_INDEPENDENT` fails with `HOLDOUT_WINDOW_REUSED` when an earlier run of the same owner and
  market, with `holdout_evaluated = true`, has an overlapping holdout window. (CODE: DERIVE G5; LIB
  `EARLIER` query and `load`, lines 82-85 and 283-294.) QL4 § 5.0 item 5 repeats the rule for build
  eligibility, and QL4 OD-10 adds overlap with earlier searched windows.
- The `library-compat-v1` key includes `dataset` and `split`. `holdoutWindow` uses only the dataset start
  and the split. So two runs with equal keys have the same holdout window. (CODE: DERIVE
  `compatibilityFields`, `holdoutWindow`.)
- Therefore at most one run of one owner can be qualified within one `library-compat-v1` class. Any two
  qualified runs of one owner on this market have disjoint holdout windows.
- A ranking of qualified runs by their own holdout results therefore compares different periods. That
  breaks the "common evaluation window" rule [SRC: QRL § Strategy Comparison, mode 2]. If the periods
  did match, ranking on holdout would turn it into selection data [SRC: ROADMAP § Report range].

For this reason the contract evaluates all participants on one new common window W (section 5). A
request to rank on own holdouts is refused with `QR4_OWN_HOLDOUT_NOT_COMPARABLE`.

## 3. Terms and the development view

### 3.1 Kinds of score (wording based on sources)

| Term | Source | Can be ranked | Can be called a recommendation |
| --- | --- | --- | --- |
| Development score | Validation net return of the engine-selected candidate of one run (CODE: DERIVE `developmentScore`) | Never across runs. Only the engine ranks inside one run, at run time | Never |
| Own holdout result | Holdout metrics of a qualified run (G4) | Never (section 2.1) | Only as part of a READY package under QL4, never as a cross-run ranking |
| Selection result | Metrics of a fixed-input evaluation run on the common window W (section 5) | Yes, but only for eligible participants and only by the registered objective | Only with the QR-4 label of section 11 |

### 3.2 Development-only runs

A development-only run is any run whose library qualification label is not `QUALIFIED`. The labels are
`NOT_EVALUATED`, `NO_SCREENED_CANDIDATE` and `DEVELOPMENT_ONLY` (CODE: DERIVE `qualification`). A run is
also development-only for selection when its package is not READY, even if G8 passed once.
The carry limitation applies [SRC: SC row F10-03].

### 3.3 Development view: structurally unordered

The acceptance clause "distinguishes development scores from qualified recommendations" is met by
structure. The only place that shows development scores cannot express an order of merit.

- D1 Rows are ordered by `created_at` and then `run_id`, the order of the compare route today (CODE: LIB
  line 311). The route accepts no sort parameter. A request with `sort`, `order_by`, `rank`, `top` or
  `best` is refused with `QR4_DEVELOPMENT_SCORE_NOT_RANKABLE` before any row is read.
- D2 No row carries a rank number, a medal, an arrow, or a "leader" or "winner" field. No response field
  name contains `rank`, `best`, `top` or `winner`, except the fixed `qualified_winner: null` echo.
- D3 Every row shows `score_basis: VALIDATION_NET_RETURN_PERCENT` and `score_kind: DEVELOPMENT_ONLY` next
  to the value. The note "Development score: in-sample selection, not a recommendation" (CODE: UI line
  105) stays.
- D4 The development view is not a QR-4 outcome. It never writes a selection record and never appears
  in the Best Performance report.

### 3.4 Selection objects

- `selection_id`: a random server UUID for one owner-started selection. It is the QR-4 form of the
  sourced `comparison_id`, with its own participant list [SRC: ROADMAP § Report and research behavior].
- Registration: the frozen declaration of scope, window W, objective, filters, tie rule, universe
  snapshot and participants. It is written before any evaluation starts.
- Universe snapshot: every terminal, non-fixture run of the owner on BINANCE:BTCUSDT Spot 1m, with its
  library class, its qualification label, its package status and its eligibility result (section 4).
- Participant: one READY package (`export_id`) and its run (`run_id`).
- Evaluation run: one new fixed-input run per participant on W. It has `parent_run_id` = the
  participant `run_id` and a `selection_id` reference.
- Outcome: the frozen result of the pure ranking function over the registration and the evaluation
  results.

## 4. Eligibility: the link to QL-4C READY and library G8

### 4.1 Checks (built on sourced predicates)

A universe member is a participant only when every check below is `PASS` at registration. Checks E1, E2
and E3 are checked again when its evaluation run starts. Each check returns `PASS`, `FAIL` or
`NOT_REACHED`. Missing, unreadable or unknown input is `FAIL`, never a pass or a skip [SRC: QL4 § 5].

At each evaluation start, and again in the transaction that writes the outcome, QR-4 also rechecks the
evaluation part of W against the shared exposure register (section 13.3) and against the windows of
other runs of the owner on each participant's source (section 5.3). Each recheck shares one
SERIALIZABLE transaction with the step it guards: the start of an evaluation run, or the outcome write.
At the first evaluation start, that transaction writes the selection's own exposure record only after
the recheck passes. A serialization failure is retried, and the retry runs the recheck again. If an
exposure record other than this selection's own overlaps the evaluation part of W, the selection ends
`SELECTION_INCOMPLETE` with `QR4_WINDOW_EXPOSED`. If a train, validation or holdout window of another
run of the owner on a participant's source overlaps the evaluation part of W, the selection ends
`SELECTION_INCOMPLETE` with `QR4_WINDOW_OVERLAPS_SEARCHED_DATA`. In both cases no ranking is made, and
a failed first start writes no exposure record (RO-12). The selection's own exposure record and its own
evaluation runs never fail its recheck.

| Check | Rule | Fail code |
| --- | --- | --- |
| E1 Library gates | Qualification label `QUALIFIED`: G1 to G8 all `PASS`, with the detail-level integrity check, not the list row's unchecked integrity (CODE: DERIVE `qualification`; LIB `load`) | `QR4_PARTICIPANT_NOT_QUALIFIED`, with the first failing gate code copied exactly |
| E2 Package READY | `EXPORT_VALIDATED` AND fresh AND `ONE_PINE` AND fixture false AND the requester owns the Bot. Fresh is false while a `REPLAY_MISMATCH` event exists [SRC: QL4 § 6.2, § 6.3, OD-15] | `QR4_PARTICIPANT_NOT_READY`, with the QL4 status or freshness code as detail |
| E3 Validation binding | The `ql4c_validation` record that makes G8 `PASS` names the `export_id` and `package_hash` of the READY package. The selection stores both values and `validated_at_utc` [SRC: QL4 § 5.5] | `QR4_VALIDATION_BINDING_MISMATCH` |
| E4 Market | BINANCE:BTCUSDT Spot 1m [SRC: QL4 § 3.2, `market` row] | `BI_MARKET_SCOPE_INVALID` |
| E5 Scope match | Every scope field of section 5.2 matches | `QR4_SCOPE_INCOMPATIBLE`, with the list of fields that do not match |
| E6 Not a fixture, not multi-Pine | Covered by E2; reported on its own for clarity | `QR4_FIXTURE_PARTICIPANT`, `QR4_MULTI_PINE_PARTICIPANT` |

A run that passes E1 but whose package is STALE is listed in the universe as `QUALIFIED_STALE`. It is
visible and named, and it is never ranked.

### 4.2 Never participants

- Development-only runs, at any score: `QR4_DEVELOPMENT_SCORE_NOT_RANKABLE`.
- `NO_VALID_CANDIDATE`, insufficient, failed, cancelled or timed-out runs. They have no package.
  [SRC: QL4 § 5.0]
- `EXPORT_CANDIDATE`, `EXPORT_INTERNAL`, `EXPORT_REFUSED` and STALE packages. [SRC: QL4 § 6.1, § 7.2]
- Imported bundles, which "can never become `EXPORT_VALIDATED` or READY". [SRC: QL4 § 8]
- QR-2 actual Paper views and actual-Bot histories: `QR4_ACTUAL_HISTORY_NOT_RANKABLE`. A request that
  mixes an actual-history basis with simulated runs: `QR4_MIXED_BASIS`. [SRC: QR2 § 1.3, "Actual history
  and simulation never mix in one comparison"]
- Evaluation runs of an earlier selection or of a QR-3 comparison. They are not research runs and
  produce no package.

### 4.3 Participant set: complete, frozen and disclosed

- The registration stores the universe snapshot. Every member that is not a participant is shown with
  its first failing code. [SRC basis: QRL § Strategy Comparison, "record prior searches, exposed periods
  and all participants"]
- V1 rule (OD-S10): every eligible package in the scope is a participant. The owner
  cannot remove an eligible package. A package is excluded only by rule, with a code. Reason: a
  participant set chosen by the owner would hide cherry-picking.
- Participant count: 2 to 4 (OD-S6). The upper bound mirrors the compare route (CODE: LIB
  `COMPARE_RUN_COUNT`) and limits compute and multiple-comparison risk. Fewer than 2 eligible packages
  gives `QR4_TOO_FEW_PARTICIPANTS`. More than 4 gives `QR4_TOO_MANY_PARTICIPANTS`, and nothing is
  truncated silently. A repeated `export_id` gives `QR4_DUPLICATE_PARTICIPANT`.
- After registration no participant is added, removed or replaced. Suppose a participant becomes
  ineligible before its evaluation run starts. Then the whole selection ends `SELECTION_INCOMPLETE` with
  `QR4_PARTICIPANT_STALE`. The ranking never drops a participant silently.
- Universe read budget: a universe above the cap is refused with `QR4_UNIVERSE_TOO_LARGE`, never
  truncated. Root sets the cap at implementation from measured cost (RO-6).

## 5. Selection scope and the common window W

### 5.1 Why a new common window (DERIVED from section 2.1)

Participants were qualified on different holdout periods. A fair ranking needs the same asset and venue,
a common evaluation window, capital, policy, costs, execution and valuation conventions, and a declared
objective [SRC: QRL § Strategy Comparison, mode 2]. The sources already name the tool for this:
"Backtest another period: fixed strategy/inputs on a newly frozen dataset." [SRC: QRL § Explicit
follow-up jobs] So the frozen package inputs of each participant run once on one common window W.

### 5.2 Common scope fields (`qr4-scope-v1`)

The fields are frozen at registration. Every participant must match each field, or the participant
fails E5 with the mismatch list (the same shape as `compatibilityMismatches` in DERIVE).

| Field | Rule | Source basis |
| --- | --- | --- |
| `market` | `binance-global`, `BINANCE:BTCUSDT`, Spot, timeframe `1` | [SRC: QL4 § 3.2] |
| `data_model` | Equal `data_profile`, `price_tick`, `quantity_step` | CODE: DERIVE compat field `data_model` |
| `cost_model` | One admitted cost model version, `fee_bps`, `slippage_bps`. V1 only until V2 parity | [SRC: QL4 § 5.3, `BI_COST_MODEL_UNSUPPORTED`] |
| `capital` | One declared `equity` and `cash` for every evaluation run | [SRC: QRL § Strategy Comparison, "capital"] |
| `policy` | One risk policy snapshot (`policy_version`, `policy_hash`). In v1 the package policy of each participant must equal it (OD-S7) | [SRC: ROADMAP § Report and research behavior, "within owner risk limits"] |
| `rules` | In v1 every participant was qualified under the same frozen `rules` hash, else `QR4_RULES_VERSION_MIXED` (OD-S7) | [SRC basis: QL4 § 5, "Thresholds are read from the run's own frozen rules"] |
| `valuation` | QR-3 standardized valuation `qr3-valuation-std-v1` and Buy & Hold `qr3-bh-close-same-cost-v1` (QR-3 contract § 5.1, § 5.3) | [SRC: QRL § Strategy Comparison, "Define benchmark trade timing/costs and funding treatment explicitly"] |
| `engine` | All evaluation runs record one engine hash. A difference ends the selection `SELECTION_INCOMPLETE` with `QR4_ENGINE_MISMATCH` | [SRC: QRL § Research record and storage, "Reproduction"] |

Sources, strategies and selected inputs differ between participants. A selection compares exactly that
difference.

### 5.3 Rules for window W

- W is a UTC half-open interval of completed 1m bars with a declared warm-up. Bars are counted exactly,
  and the view shows evaluation + warm-up = total. [SRC: ROADMAP § Report range] Code
  `QR4_WINDOW_INVALID`.
- The total bars of W, warm-up included, fit the current runtime limit (10,000 today). A window over the
  limit is refused and never truncated. [SRC: ROADMAP § Report range, "No silent truncation"] Code
  `QR4_WINDOW_OVER_CAPACITY`. Larger windows wait for QD-1 stage capacity.
- Disjoint data (extended beyond the sources). The evaluation part of W must not overlap any of
  these windows:
  - any part of a participant's own run dataset (train, validation, holdout), or any dataset that the
    participant's package evidence references;
  - any train, validation or holdout window of any other run of the owner on the source of any
    participant [SRC basis: QL4 § 5.0 item 5 and OD-10];
  - any exposure record of the owner and the same market (section 13.3), including a QR-3 comparison
    exposure event (QR-3 contract § 7) [SRC basis: ROADMAP § Report and research behavior, "Previously
    exposed holdout becomes development evidence for later selection"].
  [SRC basis: ROADMAP § Report range, "only untouched disjoint periods support independent evaluation"]
  Codes: `QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA`, `QR4_WINDOW_OVERLAPS_SEARCHED_DATA`,
  `QR4_WINDOW_EXPOSED`. Warm-up bars of W may overlap, because they are not evaluated. These overlaps
  are checked again at each evaluation start and before the outcome write (section 4.1).
- Suppose a PF-2 R3 owner-registered holdout boundary exists for a participant's Bot. Then the
  evaluation part of W starts at or after that boundary. [SRC basis: QL4 OD-9] Code
  `QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY`.
- Window kind (OD-S1). The default is `PROSPECTIVE`: W starts after the registration time.
  Then no participant, owner or agent could see results for W before the objective was frozen. The
  alternative `FORWARD_PAST`, allowed as a labelled cheaper option, needs W to start at or after the
  latest dataset end of all participants. The view labels it as a past window. The disjoint rule above
  applies to both kinds. No other window kind exists. A request for another kind gives
  `QR4_WINDOW_INVALID` (OD-S1).
- Data quality: verified Binance Spot 1m history, with no gaps, no duplicates and no incomplete bars.
  The dataset is frozen with a hash before evaluation. [SRC: ROADMAP § Work packages, QD-1 gate,
  "gaps/duplicates/incomplete bars rejected"] Codes are in section 10.

### 5.4 Evaluation runs

- Each participant gets one evaluation run, mode `QR4_SELECTION_EVAL`. The run has a new `run_id`,
  `parent_run_id` = the participant `run_id`, and the `selection_id`. It uses the frozen package inputs
  (`inputs.json` values and the Bridge pair), the common scope fields and the frozen W dataset. [SRC:
  QRL § Explicit follow-up jobs, "fixed strategy/inputs on a newly frozen dataset"; "Assign a new run ID
  and parent-run link, never overwrite the original"]
- No search: zero free dimensions. A request with a search dimension, bound, domain or budget is refused
  with `QR4_EVALUATION_SEARCH_REFUSED`. So the selection cannot become an optimizer loop.
- Each run produces these results on W:
  - the DERIVE `METRIC_KEYS` metrics;
  - the completed flat-to-flat episode count (QL4 OD-4 gate);
  - the rejected intent count;
  - fees, slippage and exposure;
  - the engine-defined 2x fee-and-slippage cost stress (CODE: LIB
    `cost_stress: 'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE'`);
  - the QR-3 Buy & Hold benchmark on the same price and cost basis.
- Evaluation runs are research rows under the QR-1b terminal freeze. They never become packages, G8
  sources or library-qualified runs.
- Admission: QS-1 checks run before each evaluation run. If admission is refused, the run stays queued
  until a frozen deadline. After the deadline the selection ends `SELECTION_INCOMPLETE` with
  `QR4_ADMISSION_REFUSED` (OD-S14). No retry loop runs, and no new selection starts automatically.
- Partial results stay hidden until the selection is terminal. So the owner cannot see some W results
  and then cancel to protect a favourite.

## 6. Objective registry and filters (the qualified-ranking objective)

### 6.1 Registry rule (SRC and contract rule)

- The objective and the risk and sample filters are registered before ranking, and a weighted score is
  not invented after results are seen. [SRC: QRL § Strategy Comparison]
- The owner picks one objective id from a server registry at registration. The registry is a
  versioned frozen constant in the pure selection module. A custom formula, weights, a sort key or an
  unknown id is refused (`QR4_OBJECTIVE_UNKNOWN`, `QR4_CUSTOM_WEIGHTS_REFUSED`). A registry change makes a
  new version and never relabels earlier outcomes. [SRC basis: QL4 § 5.5, "Rule changes create a new
  version and never re-label earlier records"]
- The registration stores copies of the objective id, all of its parameter values and the filter
  values. It does not store references to current code constants. [SRC basis: QL4 § 5]
- A filter value may be stricter than, but never weaker than, the matching threshold in any
  participant's frozen `rules` or the scope policy. Otherwise registration refuses `QR4_FILTER_INVALID`.

### 6.2 Objective `qr4-objective-lexi-v1` (OD-S2)

The objective is lexicographic and has no weights. Inputs are the exact decimal strings of the
evaluation runs. Comparisons use exact decimal arithmetic, never binary floating point. [SRC basis: QRL
§ Research record and storage, "Use decimal strings and documented units"]

1. Filters. Each participant gets `PASS` or `FAIL` for each filter, and all filters are required:
   - F1 `FILTER_DRAWDOWN_LIMIT`: `max_drawdown_percent` on W is at most the registered limit (section
     6.1). [SRC: ROADMAP § Report and research behavior, "within owner risk limits"]
   - F2 `FILTER_EPISODE_FLOOR`: completed episodes on W are at least the registered floor (OD-S5). The
     v1 floor is 5, the QL4 OD-4 floor. It is an engineering minimum and not a statistical guarantee.
     [SRC: QRL § Strategy Comparison, "completed episodes"; ROADMAP § Data readiness and candidate
     outcomes, "Position episodes" row]
   - F3 `FILTER_COST_STRESS`: net return on W under the 2x cost stress is not negative. [SRC basis: QL4
     § 4.3, "Robustness" row]
   - F4 `FILTER_NET_RETURN_POSITIVE`: net return on W after costs is greater than 0.
   - F5 `FILTER_BEATS_BUY_AND_HOLD`: optional at registration (OD-S4). When declared, the net return on
     W is greater than the Buy & Hold net return on the same basis.
2. Primary key: net return percent on W after costs. Higher is better.
3. Secondary key: max drawdown percent on W. Lower is better. It is used only inside a tie group of the
   primary key.
4. There is no third key. Parameter order, creation time, run id and source name never break a tie.

Rejected alternatives, recorded for review:

- Return-to-drawdown ratio: unstable when drawdown is near zero, and a hidden weighting.
- Ranking by development score or own holdout: refused (sections 2.1 and 3.1).
- Weighted multi-metric score: refused by the sources.
- A tie margin from the stored cost stress (an alternative that was considered): the engine stores no holdout cost stress
  (section 2 item 6). A fixed registered tolerance is simpler to test.

### 6.3 Uncertainty (OD-S12)

v1 uses `qr4-uncertainty-disclosure-v1`. It computes no statistical significance and claims none. The
view shows, for each participant, the episode count, closed trades, cost-stress result, exposure,
rejected intents and bar counts on W. It also shows the participant count, the tie tolerances and
`prior_selection_count`. The fixed sentence "No statistical significance is claimed." appears beside
every ranking. A resampling method can come in a later version.

## 7. Ranking, ties and outcomes

### 7.1 Pure ranking function

`rankSelection(registration, evaluations) -> outcome` is a pure module in the style of DERIVE. It uses no
clock, no I/O and no random source. Its inputs are plain values and its outputs are whitelisted.

1. Suppose any participant has no terminal evaluation, a missing required metric or an integrity
   failure. Then the outcome is `SELECTION_INCOMPLETE` with the code from section 10. There is no
   partial ranking.
2. Apply the registered filters. Each participant gets one result:
   - `PASSED` when it passes every filter;
   - `EVIDENCE_INADEQUATE` when F2 is its only failing filter;
   - `NOT_QUALIFYING_IN_SCOPE` when any other filter fails.
   Each failing filter code is listed. Only `PASSED` participants receive a rank.
3. If no participant passed, the outcome is one of these valid, complete results:
   - `INADEQUATE_EVIDENCE` when every participant is `EVIDENCE_INADEQUATE`;
   - `NO_QUALIFYING_STRATEGY` otherwise.
   [SRC: QRL § Strategy Comparison, "Allow ties, inadequate evidence and no qualifying strategy"]
4. Among passing participants, let `top` be the highest primary value. The primary tie group is every
   passing participant with `top - value <= tie_tolerance_return_pp` (inclusive). Because the group is
   anchored on `top`, it does not depend on input order.
5. If the group has one member, the outcome is `BEST_IN_SCOPE`, decided by the primary key.
6. Otherwise, let `low` be the lowest drawdown inside the group. The secondary group is every member
   with `value - low <= tie_tolerance_drawdown_pp`. One member gives `BEST_IN_SCOPE`, decided by the
   secondary key, and the view says so. More than one member gives `TIED_IN_SCOPE` with the tied set.
7. Other passing participants get dense ranks by the same keys. The same tolerance rule applies against
   the member directly above. Tied participants share a rank.
8. The output holds:
   - the outcome code;
   - the ordered list of passing participants, with ranks and the deciding key;
   - the list of participants that did not pass, with their codes;
   - the tie tolerances used and `registration_hash`;
   - the evaluation run ids and result hashes;
   - the ruleset ids and `outcome_hash`.

The tolerance values are registered parameters of the objective (OD-S3).

### 7.2 Outcome codes

| Outcome | Meaning | Label |
| --- | --- | --- |
| `BEST_IN_SCOPE` | One participant leads after the registered keys and tolerances | The QR-4 best label (section 11) for that participant only |
| `TIED_IN_SCOPE` | Two or more participants cannot be separated within the tolerances | The QR-4 tied label for each tied participant. No single winner |
| `NO_QUALIFYING_STRATEGY` | All evaluations complete. No participant passed, and at least one failed a strategy filter | None. Text: "No qualifying strategy within the selected scope." |
| `INADEQUATE_EVIDENCE` | All evaluations complete. Every participant failed only the episode floor | None. Text: "Evidence is not adequate to rank within the selected scope." |
| `SELECTION_INCOMPLETE` (status) | Data gap, failed or cancelled evaluation, stale participant, engine mismatch or admission timeout | None |

`BEST_IN_SCOPE` is allowed when only one of N participants passes the filters. Then the view states
"1 of N participants passed the filters".

## 8. Statuses and transitions

### 8.1 Stored selection status

Status events are append-only. The current status is the last event.

| Status | Meaning | Owner sees |
| --- | --- | --- |
| `SELECTION_REGISTERED` | Registration frozen. W is not closed yet (prospective), or evaluation has not started | Scope, objective, filters, universe, participants, W, budget. No results |
| `SELECTION_EVALUATING` | At least one evaluation run started. W is now exposed | Progress counts only. No metrics |
| `SELECTION_COMPLETED` | Outcome written: `BEST_IN_SCOPE`, `TIED_IN_SCOPE`, `NO_QUALIFYING_STRATEGY` or `INADEQUATE_EVIDENCE` | Full selection view (section 12) |
| `SELECTION_INCOMPLETE` | Terminal. No ranking. Codes recorded | Codes and completed evaluation ids. No ranking and no label |
| `SELECTION_CANCELLED` | Terminal. The owner cancelled before completion | Codes. W stays exposed if evaluation had started |

Every transition not in this list is refused with `QR4_TRANSITION_INVALID`:

```text
(registration request, any refusal)            -> no selection row
(registration request, all checks pass)        -> SELECTION_REGISTERED
SELECTION_REGISTERED --first evaluation start  -> SELECTION_EVALUATING
SELECTION_REGISTERED --owner cancel            -> SELECTION_CANCELLED
SELECTION_REGISTERED --participant ineligible  -> SELECTION_INCOMPLETE (QR4_PARTICIPANT_STALE)
SELECTION_REGISTERED --window recheck fails    -> SELECTION_INCOMPLETE (QR4_WINDOW_EXPOSED or QR4_WINDOW_OVERLAPS_SEARCHED_DATA)
SELECTION_EVALUATING --all evaluations done    -> SELECTION_COMPLETED or SELECTION_INCOMPLETE
SELECTION_EVALUATING --owner cancel            -> SELECTION_CANCELLED
SELECTION_EVALUATING --deadline passed         -> SELECTION_INCOMPLETE (QR4_ADMISSION_REFUSED or QR4_EVALUATION_FAILED)
SELECTION_EVALUATING --window recheck fails    -> SELECTION_INCOMPLETE (QR4_WINDOW_EXPOSED or QR4_WINDOW_OVERLAPS_SEARCHED_DATA)
SELECTION_COMPLETED, SELECTION_INCOMPLETE, SELECTION_CANCELLED -> terminal
```

A terminal selection is never run again or ranked again in place. A new attempt is a new `selection_id`
with a new W that is not exposed. [SRC basis: QRL § Explicit follow-up jobs, "never overwrite the
original"] Each selection records `prior_selection_count` and `prior_selection_ids` for the owner, so
repeated selections are disclosed as multiple comparisons [SRC basis: QRL § Strategy Comparison,
"record prior searches"].

### 8.2 Derived read overlays

Overlays are computed at read time and never written over the status. This follows QL4 § 6.2.

- `WINNER_NOT_READY`: the package of a best or tied participant is no longer READY. The frozen record
  keeps the label. The view suppresses the label and hides the recommended values and links (OD-S13).
- `SELECTION_REPLAY_MISMATCH`: a replay event exists (section 13.2). The label is suppressed.
- `RULESET_SUPERSEDED`: the objective or scope version is no longer current. This is information only,
  and the outcome is not relabelled.

### 8.3 View-level states without a record

- `NO_QUALIFIED_PARTICIPANT_AVAILABLE`: the owner has no READY package. The view shows "Qualified
  recommendations: none. No qualified winner." and offers no registration. This is the current library
  text (CODE: UI line 53) and the expected state today.
- `ONE_QUALIFIED_PARTICIPANT_ONLY`: exactly one package is eligible. The view says "Only one qualified
  package in this scope. Nothing can be compared." It offers no registration and no label.

## 9. Refusal codes

All codes match `^[A-Z][A-Z0-9_]{1,63}$` [SRC: QL4 § 5]. Existing codes are reused where the meaning is
the same. A refusal at registration writes no selection row and starts no run.

| Code | When | Stage |
| --- | --- | --- |
| `NOT_FOUND` (404) | Absent or foreign `selection_id`, `export_id` or `run_id` [SRC: QL4 § 7.3, Research Library rule] | Any |
| `CONFIRMATION_REQUIRED` | Registration or cancel without the confirm token [SRC: QL4 § 2 item 10, PF-4 pattern] | Registration, cancel |
| `QR4_NO_ELIGIBLE_PARTICIPANT` | No package passes E1 to E6 in the scope | Registration |
| `QR4_PARTICIPANT_NOT_READY` | E2 fails. Detail = QL4 status or freshness code | Registration, evaluation start |
| `QR4_PARTICIPANT_NOT_QUALIFIED` | E1 fails. Detail = first failing gate code | Registration, evaluation start |
| `QR4_VALIDATION_BINDING_MISMATCH` | E3 fails | Registration, evaluation start |
| `QR4_FIXTURE_PARTICIPANT` | A fixture package in a customer selection | Registration |
| `QR4_MULTI_PINE_PARTICIPANT` | A multi-Pine package before APP-3B [SRC: QL4 § 7.2] | Registration |
| `QR4_DEVELOPMENT_SCORE_NOT_RANKABLE` | Any request to rank, sort or label by development score, or a development-only run as participant | Registration, read |
| `QR4_OWN_HOLDOUT_NOT_COMPARABLE` | Any request to rank by participants' own holdout results | Registration, read |
| `QR4_ACTUAL_HISTORY_NOT_RANKABLE` | A QR-2 view or actual-Bot history as participant | Registration |
| `QR4_MIXED_BASIS` | Actual history and simulated runs in one request | Registration |
| `QR4_TOO_FEW_PARTICIPANTS`, `QR4_TOO_MANY_PARTICIPANTS`, `QR4_DUPLICATE_PARTICIPANT` | Count outside 2 to 4, or a repeated `export_id` | Registration |
| `QR4_UNIVERSE_TOO_LARGE` | Universe above the read budget. Never truncated | Registration |
| `QR4_SCOPE_INCOMPATIBLE` | A scope field differs. The fields are listed | Registration |
| `QR4_RULES_VERSION_MIXED` | Participants qualified under different frozen `rules` | Registration |
| `BI_MARKET_SCOPE_INVALID` | Market not BINANCE:BTCUSDT Spot 1m [SRC: QL4 § 5.1] | Registration |
| `QR4_OBJECTIVE_UNKNOWN`, `QR4_CUSTOM_WEIGHTS_REFUSED` | Objective not in the registry, or a custom formula, weights or sort key | Registration |
| `QR4_FILTER_INVALID` | A filter value is missing, has the wrong type, or is weaker than a participant's `rules` or the scope policy | Registration |
| `QR4_REGISTRATION_IMMUTABLE` | Any change request to a registered selection | Any |
| `QR4_WINDOW_INVALID` | W is not a UTC half-open completed-bar interval, or does not fit the registered window kind | Registration |
| `QR4_WINDOW_OVER_CAPACITY` | W total bars above the current limit | Registration |
| `QR4_WINDOW_OVERLAPS_PARTICIPANT_DATA` | The evaluation part of W overlaps a participant dataset | Registration |
| `QR4_WINDOW_OVERLAPS_SEARCHED_DATA` | The evaluation part of W overlaps a window of another run of the owner on a participant's source | Registration, evaluation start |
| `QR4_WINDOW_EXPOSED` | The evaluation part of W overlaps an exposure record of the owner and market (QR-4 selection or QR-3 comparison) | Registration, evaluation start |
| `QR4_WINDOW_BEFORE_REGISTERED_BOUNDARY` | W starts before a registered holdout boundary | Registration |
| `QR4_QR3_CONTEXT_UNAVAILABLE` | QR-3 standardized valuation or benchmark method not implemented | Registration |
| `QR4_EVALUATION_MODE_UNAVAILABLE` | Fixed-input evaluation mode not implemented | Registration |
| `QR4_EPISODE_GATE_UNAVAILABLE` | QL4 OD-4 episode gate not available | Registration |
| `QR4_EXPOSURE_REGISTRY_UNAVAILABLE` | Exposure registry absent or unreadable. An empty registry is valid | Registration |
| `QR4_EVALUATION_SEARCH_REFUSED` | Evaluation request with a search dimension, bound or budget | Evaluation |
| `QR4_SELECTION_EXISTS` | Same registration key repeated. Returns the existing `selection_id` | Registration |
| `QR4_APPLY_REFUSED` (403) | Any apply, import, Bot start, email enqueue or alert step sent to a QR-4 route | Any |
| `QR4_TRANSITION_INVALID` | Transition not in section 8.1 | Any |

Section 10 lists the data-gap codes that end a selection. `QR4_WINDOW_EXPOSED` and
`QR4_WINDOW_OVERLAPS_SEARCHED_DATA` also end a selection when a recheck of section 4.1 fails (sections
4.1 and 8.1). Codes that end a selection are not refusals.

## 10. Data gaps

Missing, unreadable or unknown input is `FAIL`, never a pass, a skip or a zero. [SRC: QL4 § 5, citing
ROADMAP PF-1 row "Unknown data cannot become a pass"; QRL § Research record and storage, "absence of a
metric must never become zero"]

| Gap | Effect | Code |
| --- | --- | --- |
| W data not available yet (prospective, before close plus cutoff) | Stays `SELECTION_REGISTERED`. No evaluation | none (waiting) |
| W history unavailable at the venue or cache | `SELECTION_INCOMPLETE` | `QR4_WINDOW_DATA_UNAVAILABLE` |
| Gap, duplicate or incomplete bar in W | `SELECTION_INCOMPLETE`. No repair and no resampling [SRC: QRL § Periods and data admission] | `QR4_WINDOW_DATA_GAP` |
| Frozen W dataset hash differs at evaluation | `SELECTION_INCOMPLETE` | `BI_DATASET_HASH_MISMATCH` |
| Evaluation run FAILED, TIMED_OUT or CANCELLED | `SELECTION_INCOMPLETE`. The other results stay hidden | `QR4_EVALUATION_FAILED` |
| Required metric absent in a terminal evaluation | `SELECTION_INCOMPLETE` | `QR4_METRIC_MISSING` |
| Evaluation integrity check fails (contract hash, checkpoints) | `SELECTION_INCOMPLETE` | `INTEGRITY_CHECK_FAILED` (CODE: DERIVE G1 code) |
| Engine hashes differ between evaluation runs | `SELECTION_INCOMPLETE` | `QR4_ENGINE_MISMATCH` |
| Buy & Hold not computable on W | `SELECTION_INCOMPLETE` | `QR4_BENCHMARK_UNAVAILABLE` |
| Participant becomes ineligible before its evaluation starts | `SELECTION_INCOMPLETE` | `QR4_PARTICIPANT_STALE` |
| Admission not granted before the frozen deadline | `SELECTION_INCOMPLETE` | `QR4_ADMISSION_REFUSED` |
| Archived dataset or evaluator artifact of a participant or of W is gone | Outcome kept. `exact_replay_disabled: true` for that item. No replacement candles [SRC: QRL § Research record and storage] | none (flag) |

A shortfall on the strategy side is not a data gap. Too few episodes, too much drawdown, or a negative
return on complete data are filter results (section 6.2). They can lead to `NO_QUALIFYING_STRATEGY` or
`INADEQUATE_EVIDENCE`.

## 11. Label rules

### 11.1 Relation to the accepted QL4 label

QL4 lets a READY package show "best within the selected scope". Its scope is the run's own search. [SRC:
QL4 § 5.5; § 7.2; § 11.3 item 7] This contract does not change that rule. The QR-4 label is a different,
cross-run label, and it must never be confused with the package label. RO-1 covers the reconciliation.
A QR-3 comparison label (QR-3 contract § 6.5 T3, § 6.6 R3) lives only inside a QR-3 comparison record.
It is not a QR-4 label and never a QR-4 input.

### 11.2 QR-4 label

1. A QR-4 label exists only on a `SELECTION_COMPLETED` record with outcome `BEST_IN_SCOPE` or
   `TIED_IN_SCOPE`, and only for the passing participant or participants at rank 1. [SRC: QRL § Strategy
   Comparison, "Only qualified results may receive a best-in-scope label"]
2. The label text is generated by the server as `label_text`. The UI renders it exactly and never builds
   a label itself. Text (OD-S17): "Best of N compared strategies within the selected scope" and
   "Tied for best of N compared strategies within the selected scope". Both texts keep the sourced
   phrase "within the selected scope" [SRC: ROADMAP § Report and research behavior].
3. The words "best", "top", "winner" and "optimal" never appear without the scope phrase. Outside a
   selection record they appear only in the QL4 READY package label and in the QR-3 comparison labels on a
   QR-3 comparison record (QR-3 contract § 6.5 T3, § 6.6 R3). They never appear on a library,
   run, development or QR-2 view. [SRC: ROADMAP § Report and research behavior, "never universally
   best"; CODE: DERIVE "No view applies a best, top or winner label"]
4. The scope statement is always shown beside the label. It covers:
   - asset, W dates (UTC), and evaluation, warm-up and total bars;
   - risk profile id, costs, capital, coverage and evaluation basis;
   - objective id, filters and tie tolerances;
   - participant count, the universe with exclusion codes, and `prior_selection_count`.
   [SRC: QRL § Strategy Comparison, "Reports state asset, dates, risk profile, costs, coverage and
   evaluation basis"]
5. Fixed exposure sentence: "This selection used the period W. That period is now development evidence.
   A claim about another period needs new independent data." [SRC: ROADMAP § Report and research
   behavior; § Report range]
6. Fixed sentences: "No statistical significance is claimed." and "This is not a profitability claim or
   a forecast." [SRC basis: AGENTS.md scope guard; QL4 § 7.2, no global-optimum claim]
7. While `WINNER_NOT_READY` or `SELECTION_REPLAY_MISMATCH` applies, the label is suppressed and the view
   shows the overlay code.
8. The library `qualified_winner` field stays null permanently, because a library has no selection scope
   (OD-S9). `qualified_total` becomes the count of library-qualified runs once G8 has a source [SRC: QL4
   § 5.5]. A QR-4 label lives only inside a selection record.
9. EN and TH strings exist for every outcome, overlay, filter, view state and refusal label. [SRC: QL4
   § 11.3 item 9] The owner approves the Thai label text before UI work (OD-S19).

## 12. Owner view and actions

### 12.1 Views (read-only)

- Universe and eligibility preview. Every universe member is listed in creation order, without ranks. It
  shows its eligibility result and first failing code. The note says "Their holdout periods differ. They
  are not compared here." Own holdout metrics are not placed side by side. Each row links to its QL4
  package review instead. [SRC basis: QL4 § 7.2, "Holdout performance of rejected candidates
  as a selection aid" never shown]
- Selection list: every selection of the owner, including `NO_QUALIFYING_STRATEGY`,
  `INADEQUATE_EVIDENCE`, incomplete and cancelled ones, with counts for each outcome. [SRC: QRL § Research
  record and storage, "Report unsuccessful trials, not just winning settings"]
- Selection detail:
  - the label block of section 11;
  - the passing list with ranks and the deciding key;
  - the list of participants that did not pass, with filter codes;
  - for every participant, these values on W: net return, Buy & Hold on the same basis, drawdown,
    episodes, closed trades, rejected intents, fees and slippage, exposure and the cost-stress result;
  - links to evaluation runs, parent runs and package reviews;
  - the registration and outcome hashes and the `exact_replay_disabled` flags.
- Development view (section 3.3): a separate panel, unordered, labelled "development scores, not a
  ranking" (OD-S20).
- QR-2 context link: the actual Paper history of a participant's Bot, labelled as actual history and
  never ranked. [SRC: QR2 § 1.3]

### 12.2 Actions

Every write is authenticated, CSRF-protected and owner-scoped. It is audited with `selection_id`, actor,
UTC time and outcome. [SRC basis: QL4 § 7.3] Only the owner may register (OD-S18).

| Action | Allowed when | Guards | Effect |
| --- | --- | --- | --- |
| Register selection | At least 2 eligible participants and every dependency of section 1.3 met | Confirm token that shows W, objective, filters, tolerances, universe, participants, compute budget and the exposure warning. SERIALIZABLE. Eligibility and window checks at commit | Writes the registration. Starts nothing until W is available and admitted |
| Cancel selection | `SELECTION_REGISTERED` or `SELECTION_EVALUATING` | Confirm token | `SELECTION_CANCELLED`. W stays exposed if evaluation started. No results shown |
| Open a ranked package | The participant package is READY now | Same guards as the QL4 view | Opens the QL4 package review. Nothing else |
| Replay a selection outcome | `SELECTION_COMPLETED` | Owner request | Recomputes the pure ranking only (section 13.2). Runs nothing |
| Import, apply or start | Never from a selection | `QR4_APPLY_REFUSED` | Only the F09-03 action on the package, under the QL4 § 7.3 guards |
| Email | Never from a selection | `QR4_APPLY_REFUSED` | Only F09-02 for each `export_id` |

No selection action applies inputs, changes a Bot, starts a session, enqueues email, starts another
selection or starts an optimization. [SRC: QRL § Strategy Comparison, "Viewing a report never starts or
changes a Bot"; § Explicit follow-up jobs; ROADMAP § Report and research behavior]

## 13. Immutability, replay and exposure

### 13.1 Records

- These tables are insert-only:
  - the selection registration, with `registration_hash` = SHA-256 of canonical JSON;
  - the universe and participant rows;
  - the status events;
  - the outcome (one per selection, with `outcome_hash`);
  - the replay events and the window exposures.
  `BEFORE UPDATE OR DELETE` triggers refuse update and delete. The triggers use `ENABLE ALWAYS`,
  `SECURITY INVOKER` and a pinned `search_path`, following the QR-1b freeze pattern. [SRC basis: QL4 § 8;
  CODE: `src/postgres/quant-research-freeze.sql`] Root assigns the SQLSTATE in the project namespace
  (RO-2).
- Canonical form and hashing reuse `canonical` and `hash` (SHA-256) from `src/pine-bridge/source.js`.
  (CODE: DERIVE imports; `source.js` line 5.)
- Idempotency: one registration for each `(owner_id, registration key)`. The key hashes the scope, W,
  objective, filters and participants. A repeat returns the existing `selection_id`.
- Evaluation runs are ordinary research rows under the QR-1b terminal freeze. The selection references
  them by id and result hash.
- A selection is kept while any participant run is kept. It is never removed as cache. [SRC: QRL
  § Research record and storage]

### 13.2 Replay

- Outcome replay: run `rankSelection` again on the frozen registration and the frozen evaluation
  results. An equal `outcome_hash` is a pass. A difference writes an append-only
  `SELECTION_REPLAY_MISMATCH` event and suppresses the label. The stored outcome is never edited.
- Evaluation replay: an exact replay of an evaluation run, requested by the owner, is a new run with
  `parent_run_id`. Mismatches are reported and recorded as a replay event. [SRC: QRL § Explicit follow-up
  jobs, "Replay: reproduce the original data/settings/execution version; compare with the prior result
  and report mismatches"]
- If the W dataset or the evaluator artifact is gone, exact reproduction is marked disabled.
  Replacement candles are never used. [SRC: QRL § Research record and storage]
- A ruleset change creates new version ids and never relabels earlier records. [SRC: QL4 § 5.5]

### 13.3 Exposure registry

- When the first evaluation run of a selection starts and the recheck of section 4.1 passes, the
  evaluation part of W is written as an exposure record `{owner_id, market, window, selection_id, at_utc}`.
- The exposure registry of this contract and the exposure register of the QR-3 contract (§ 7) are one
  register. It holds QR-4 selection records and QR-3 comparison exposure events. Every reader (the QR-4
  window check, the QR-3 evidence class, library G5 and QL4 B0) reads both kinds for the same owner and
  the same market. Root fixes the shared schema at implementation. Every transaction that reads the
  register and then writes to it (QR-4 registration, each QR-4 recheck with the step it guards, and the
  QR-3 comparison create) runs at SERIALIZABLE isolation. A writer at a lower isolation level would
  bypass the recheck.
- Later selections refuse an overlap (`QR4_WINDOW_EXPOSED`). An empty registry is valid. Only an absent
  or unreadable registry refuses registration.
- Window race: a registration is not an exposure. So, between registration and the outcome write,
  another QR-3 comparison or QR-4 selection may expose the evaluation part of W, and a new run of the
  owner may search over it. The recheck of section 4.1 runs at each evaluation start and before the
  outcome write, each time in one SERIALIZABLE transaction with the step it guards. A failed recheck
  ends the selection `SELECTION_INCOMPLETE` with `QR4_WINDOW_EXPOSED` or
  `QR4_WINDOW_OVERLAPS_SEARCHED_DATA`, and no ranking is made (RO-12).
- (OD-S8) Later research runs treat exposure records as exposed data in the QL4 B0 holdout check. QL4
  records this as OD-19 (§ 5.0 item 5, code `BI_HOLDOUT_EXPOSED_BY_SELECTION`, same owner and same
  market). A later holdout over W is then not independent.

## 14. Out of scope

- Live trading, any broker other than Spot Paper, Futures, short and margin. [SRC: AGENTS.md § Host and
  product safety]
- Markets other than BINANCE:BTCUSDT Spot 1m, and multi-asset selection.
- Automatic optimizer loop, automatic rerun, automatic new selection, guard reset, automatic Best Inputs
  apply, automatic email enqueue and automatic winner deployment. [SRC: QRL § Explicit follow-up jobs]
- Multi-Pine participants before APP-3B. [SRC: QL4 § 7.2, § 9]
- QR-2 implementation and QR-3 implementation (QR-3 is a dependency, not part of this feature). Also
  QL4 package build and validation, F09-02 email, and F09-03 apply or start.
- "Optimize again" follow-ups. They are new QL-3A research workflows with their own admission (OD-S11).
- Later independent confirmation of a selected participant (OD-S16), until a later version adds it under
  a new owner decision.
- Capacity above the current 10K-bar profile, and QD-1 stage D, E and F windows.
- Statistical significance testing in v1 (OD-S12).
- Any profitability, forecast, universal-best or global-optimum claim.
- DP1 native supervision and N1 work.

## 15. Known risks

- K1: F10-03 depends on QL4, QR-3, a new evaluation mode, the episode gate and the exposure registry.
  None is implemented. Real acceptance may be far away. Engineering work can still proceed on labelled
  fixtures.
- K2: At 10,000 bars, W covers about one week of 1m data. Few episodes are likely. So
  `INADEQUATE_EVIDENCE` or `NO_QUALIFYING_STRATEGY` is the probable outcome. The view must disclose the
  small window. Larger windows need QD-1 capacity.
- K3: Prospective windows add a wait between registration and outcome.
- K4: Over time an owner can register many selections and keep the best-looking one. Exposure records,
  the full selection history with counts, `prior_selection_count` and the participant count in every
  label reduce this multiple-comparison risk but do not remove it.
- K5: A common policy and common `rules` (OD-S7) may exclude packages validated under another policy, so
  fewer selections are possible.
- K6: The exposure rule (OD-S8) changes QL4 B0 behaviour. QL4 OD-19 records the change. Library G5
  changes when the derive module changes (QR-3 contract § 13.5, slice S2).
- K7: The fixed-input evaluation mode is not proven feasible on the current engine (RO-8).
- K8: With the rule "all eligible included", more than 4 eligible packages blocks registration until
  OD-S6 or OD-S10 changes.

## 16. Independent test plan

Engineering acceptance and recommendation acceptance stay separate. [SRC: QL4 § 11, citing ROADMAP QL-3A
row] An independent tester writes the tests from this contract, not from the implementation. The module
has no test-only override of any gate or filter.

### 16.1 Pure ranking and eligibility module (Node, no database)

1. A golden fixture with 3 participants and distinct returns gives `BEST_IN_SCOPE` with the expected
   ranks and `outcome_hash`.
2. A primary tie inside the tolerance, separated by drawdown, gives `BEST_IN_SCOPE` decided by the
   secondary key. Equal values on both keys give `TIED_IN_SCOPE` with the full set.
3. Boundary: a difference exactly equal to the tolerance is a tie. A difference one decimal unit above
   it is not.
4. Exact decimal: values such as `"0.1"`, `"0.2"` and `"0.3"` compare exactly, and `"1.10"` equals
   `"1.1"`. A floating-point implementation fails this test.
5. All participants fail a strategy filter: `NO_QUALIFYING_STRATEGY`, with no label and no rank.
6. All participants fail only F2: `INADEQUATE_EVIDENCE`. A mix of F2-only and other failures gives
   `NO_QUALIFYING_STRATEGY`.
7. Each filter negation gives exactly its filter code. A participant that fails two filters lists both.
8. Permutation invariance: shuffled participant order and shuffled object keys give the same
   `outcome_hash`, over 100 permutations.
9. A participant that fails a filter never changes the ranks or the outcome of the others.
10. No third tiebreak: two participants equal on both keys, with different run ids, creation times and
    parameters, stay tied.
11. A missing evaluation, a missing metric, a null, a wrong type or an integrity failure gives
    `SELECTION_INCOMPLETE` with the section 10 code. It never gives a ranking with fewer participants and
    never throws an exception.
12. Eligibility: one negation for each check E1 to E6 gives the expected code. These are each refused:
    a development-only run with the highest development score, a `NO_VALID_CANDIDATE` run, an imported
    bundle, a fixture, a multi-Pine package, a QR-2 view and a mixed-basis request. A STALE package of a
    qualified run is listed as `QUALIFIED_STALE`.
13. E3: a G8 record that names another `package_hash` gives `QR4_VALIDATION_BINDING_MISMATCH`.
14. Current real state: with DERIVE G8 always `FAIL`, every registration gives
    `QR4_NO_ELIGIBLE_PARTICIPANT`. The library still returns `qualified_total: 0` and
    `qualified_winner: null`.
15. Registered thresholds win: a registration is judged by its own copied filter values. A filter weaker
    than a participant's `rules` gives `QR4_FILTER_INVALID`.
16. Mixed `rules` hashes give `QR4_RULES_VERSION_MIXED`.
17. Window checks: each of these gives its own code: an overlap with a participant train, validation or
    holdout window; an overlap with a window of another run on a participant's source; an overlap with an
    exposure record, including a QR-3 comparison exposure event of the same owner and market;
    a start before a registered boundary; an over-capacity total; a window that is not
    half-open or has incomplete bars. An overlap of warm-up bars only passes. An empty exposure registry
    passes. An unreadable one gives `QR4_EXPOSURE_REGISTRY_UNAVAILABLE`.
17a. Window race: a selection is registered over W. A QR-3 comparison, or another QR-4 selection,
    then exposes the evaluation part of W before one of this selection's evaluation starts. At that
    evaluation start the selection ends `SELECTION_INCOMPLETE` with `QR4_WINDOW_EXPOSED`, and no
    ranking and no outcome are produced. The same holds before the outcome write, and the same holds with `QR4_WINDOW_OVERLAPS_SEARCHED_DATA` when a
    run of the owner on a participant's source, created after registration, has a train, validation
    or holdout window over the evaluation part of W. The selection's own exposure record and its own
    evaluation runs never fail its own recheck.
18. Adversarial input: a registration with extra fields `weights`, `sort` or `rank` is refused before
    any evaluation.
19. The exported objective registry is frozen. A test asserts the exact ids and key order for
    `qr4-objective-lexi-v1` and fails on any change without a version bump.
20. Every emitted code matches `^[A-Z][A-Z0-9_]{1,63}$`.

### 16.2 Isolated PostgreSQL (throwaway cluster, one file per process)

1. Update and delete of registration, universe, participant, status, outcome, replay and exposure rows
   are refused with the assigned SQLSTATE, also for the application role.
2. Every illegal transition gives `QR4_TRANSITION_INVALID`.
3. Two concurrent registrations with the same key give one row and one idempotent reply. Two different
   registrations give `prior_selection_count` 0 and 1.
4. Race: a participant package turns STALE between registration and evaluation start. The selection ends
   `SELECTION_INCOMPLETE` with `QR4_PARTICIPANT_STALE`, and no outcome row exists.
5. Owner isolation: when owner B reads, registers with, cancels or replays owner A's ids, the reply is
   `NOT_FOUND` and contains no values.
6. Exposure: the first evaluation start writes one exposure row. A second selection over the same W is
   refused. A selection cancelled after evaluation start keeps its exposure.
7. Evaluation runs carry `parent_run_id` and `selection_id` and contain no search dimension. The parent
   run rows are byte-identical before and after (QR-1b freeze).
8. Equal outcome replay writes no event. A fixture with a tampered evaluation result hash gives one
   `SELECTION_REPLAY_MISMATCH` event and a suppressed label.
9. Read routes run under `SET TRANSACTION READ ONLY`.
10. Window race under concurrency: two selections whose evaluation parts of W overlap start evaluation
    at the same time. The recheck and the exposure write of each run in one SERIALIZABLE transaction.
    Exactly one exposure write commits. The other selection ends `SELECTION_INCOMPLETE` with
    `QR4_WINDOW_EXPOSED`, also after a serialization failure is retried, and no outcome row exists.
    The same holds when a QR-3 comparison create over the evaluation part of W commits at the same
    time as an evaluation start or an outcome write.

### 16.3 API and UI (Node, local, no browser)

1. Development rows, library rows and QR-2 rows carry no field named `rank`, `best` or `winner` and no
   sort order. Development rows keep creation order. A query that asks to sort or rank by development
   score gives `QR4_DEVELOPMENT_SCORE_NOT_RANKABLE`, and the body contains no row.
2. A text scan of the rendered EN and TH strings finds "best", "top", "winner" or "optimal" only in the
   QR-4 label strings of section 11.2, in the QL4 READY package label and in the QR-3 comparison label
   strings (QR-3 contract § 6.5 T3, § 6.6 R3). The exact existing string "Qualified recommendations:
   none. No qualified winner." is allowed and does not fail the scan.
3. `SELECTION_REGISTERED`, `SELECTION_EVALUATING`, `SELECTION_INCOMPLETE` and `SELECTION_CANCELLED`
   responses contain no metrics for W.
4. A completed selection shows the scope statement, the exposure sentence, the no-significance sentence
   and the no-profitability sentence beside every label.
5. `WINNER_NOT_READY` suppresses the label and hides the recommended values and the package link.
6. A POST to a QR-4 route that names apply, import, start, email or alert gives 403
   `QR4_APPLY_REFUSED`. No selection route changes Bot policy, session state or the notification
   outbox: hashes and row counts stay unchanged. No route starts a run except the registered evaluation
   runs.
7. The UI renders `label_text` exactly and composes no label.
8. EN and TH strings exist for every new status, outcome, overlay, filter, view state and refusal code.

### 16.4 Staging evidence (F10-03 target)

1. Engineering: deploy only under a recorded owner GO and the operations rules. Run a labelled fixture
   selection (OD-S15) through every outcome. Show zero customer-visible QR-4 labels. This is engineering
   evidence only.
2. Real-state check: on staging with no READY package, every registration is refused with
   `QR4_NO_ELIGIBLE_PARTICIPANT`. The library shows "Qualified recommendations: none. No qualified
   winner." This shows the "refuses unsupported rankings" half of the acceptance on real data.
3. Recommendation-level acceptance needs at least two real READY packages in one scope and a completed
   selection. None exists today (section 2). `NO_QUALIFYING_STRATEGY` or `INADEQUATE_EVIDENCE` would be
   a valid result. F10-03 recommendation acceptance stays open until then.
4. Evidence files record the commit, engine hash, registration and outcome hashes, refusal codes and UTC
   stamps. They contain no secrets, machine paths or raw logs.

### 16.5 Mapping to the PM-1 acceptance text

| Acceptance phrase | Tests |
| --- | --- |
| "distinguishes development scores from qualified recommendations" | 16.1 items 12 and 14; 16.3 items 1, 2, 5 and 7 |
| "refuses unsupported rankings" | 16.1 items 11, 12, 13, 15 to 18; 16.2 item 4; 16.3 items 1 and 6; 16.4 item 2 |
| Ties, inadequate evidence and no qualifying strategy | 16.1 items 2, 3, 5, 6 and 10 |

## 17. Decisions

The owner decided OD-S1 to OD-S20 on 2026-10-19 as the outcomes below. Root decided the root-only items on
the same day. The outcomes bind the sections named in the text.

### 17.1 Owner decisions

| ID | Decision | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| OD-S1 | Window kind for W | (a) `PROSPECTIVE` is the default. `FORWARD_PAST` is allowed as a labelled cheaper option. Any other disjoint past window is refused. | Owner | 2026-10-19 |
| OD-S2 | Objective v1 and filters F3, F4 | (a) `qr4-objective-lexi-v1` with F1 to F4 required. | Owner | 2026-10-19 |
| OD-S3 | Tie tolerances | (a) Fixed registry defaults that the owner sets before the first selection (example: 0.5 pp return, 0.5 pp drawdown). The example values are not decided values. | Owner | 2026-10-19 |
| OD-S4 | Buy & Hold | (b) Display plus optional filter F5. | Owner | 2026-10-19 |
| OD-S5 | Episode floor on W | (a) The QL4 OD-4 floor of 5, disclosed as an engineering minimum and not a statistical guarantee [SRC: ROADMAP § Data readiness]. | Owner | 2026-10-19 |
| OD-S6 | Participant count | (a) 2 to 4. | Owner | 2026-10-19 |
| OD-S7 | Policy and rules | (a) In v1 one common policy and one common `rules` hash are required. | Owner | 2026-10-19 |
| OD-S8 | Selection windows as exposed data for later holdout checks | (a) Yes, with a QL4 amendment (RO-5). | Owner | 2026-10-19 |
| OD-S9 | Library `qualified_winner` | (a) Null permanently. | Owner | 2026-10-19 |
| OD-S10 | Participant set | (a) Every eligible package, excluded only by rule. | Owner | 2026-10-19 |
| OD-S11 | Follow-ups inside F10-03 | (a) Selection evaluation mode and outcome replay only. | Owner | 2026-10-19 |
| OD-S12 | Uncertainty method | (a) Disclosure only, with the fixed no-significance sentence. | Owner | 2026-10-19 |
| OD-S13 | Winner package becomes stale after the outcome | (a) Suppress the label and hide values and links, as in QL4 § 7.1. | Owner | 2026-10-19 |
| OD-S14 | Admission deadline for evaluation runs | (a) A fixed deadline for each registration. | Owner | 2026-10-19 |
| OD-S15 | Engineering fixture selections on staging | (a) Allowed with `fixture = true`, internal view only, never a label. | Owner | 2026-10-19 |
| OD-S16 | Later independent confirmation of a selected participant | (a) Deferred to a later version. | Owner | 2026-10-19 |
| OD-S17 | QR-4 label wording | (a) "Best of N compared strategies within the selected scope", so that the cross-run label differs from the package label. | Owner | 2026-10-19 |
| OD-S18 | Who may register a selection | (a) Owner only, the same authority as the F09-03 import. | Owner | 2026-10-19 |
| OD-S19 | Thai label text | (a) Root drafts and the owner approves before UI work. | Owner | 2026-10-19 |
| OD-S20 | Development view | (a) Keep a separate unordered panel. | Owner | 2026-10-19 |

### 17.2 Root decisions

Root decided these items. A change to an accepted QL4 rule is not a root decision. Root routes such a
change as its own change.

| ID | Decision | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| RO-1 | Reconcile the label rules with the accepted QL4 contract | The QL4 package label and the QR-4 label stay separate (section 11.1). QL4 OD-20 and its note in § 7.1 point to this contract and to the QR-3 comparison label. QL4 § 11.3 item 7 is unchanged. The QL4 rule itself does not change. | Root | 2026-10-19 |
| RO-2 | SQLSTATE for the QR-4 freeze | Root assigns it in the project namespace at implementation, as in QL4 OD-14. | Root | 2026-10-19 |
| RO-3 | Dependency order in Roadmap | The QR-3 contract defines the valuation and Buy & Hold method ids (QR-3 § 5.1, § 5.3). This contract is accepted now. Its implementation waits for QR-3 implementation. | Root | 2026-10-19 |
| RO-4 | Rules that this contract introduces | Accepted: the code names, the statuses and transitions, the pure ranking function, hidden partial results, exact decimal arithmetic, the idempotency key, the extended W disjointness rule and the `INADEQUATE_EVIDENCE` outcome. | Root | 2026-10-19 |
| RO-5 | QL4 B0 exposure amendment (from OD-S8) | Routed as its own change. QL4 records it as OD-19 in § 5.0 item 5, code `BI_HOLDOUT_EXPOSED_BY_SELECTION` (amendment of 2026-10-19). This contract does not edit QL4. | Root | 2026-10-19 |
| RO-6 | Universe read budget (`QR4_UNIVERSE_TOO_LARGE`) | Root sets the cap at implementation from measured cost. | Root | 2026-10-19 |
| RO-7 | Relation of mode `QR4_SELECTION_EVAL` to the follow-up "Backtest another period" and to the QR-3 fixed-input evaluation (QR-3 § 1.3), and its QS-1 job class | Deferred. The QS-1 job class is the one shared with the QR-3 fixed-input evaluation (QR-3 RD-7). Root decides the mode relation in the first implementation packet, after the RO-8 check. Until then the mode keeps its own id. | Root | 2026-10-19 |
| RO-8 | Feasibility check of a fixed-input evaluation on a new frozen window | A bounded engineering check runs before the first implementation packet. Done 2026-10-19: feasibility is partial. The engine can replay one fixed parameter set on a new window with bar-close fills, adverse tick rounding and a fresh ledger, and its results match the QR-3 valuation exactly; lineage, a zero-search mode, the full fill list, flat-to-flat episodes and the QS-1 job class are missing. The pure evaluator fixed_eval.py (FE-1) now emits the missing records but is outside every engine closure and must not reach a run row until a versioned evaluation closure and the job class exist (FE-2). | Root | 2026-10-19 |
| RO-9 | Exact-decimal arithmetic method | Root picks the method at implementation. Binary floating point is not allowed. | Root | 2026-10-19 |
| RO-10 | Acceptance records | At the checkpoint, root records engineering acceptance and recommendation acceptance separately in Roadmap and Time Management. This contract earns no PM-1 D credit by itself. | Root | 2026-10-19 |
| RO-11 | Second review of the final text | Done. Root accepted the other rules after independent review under the AGENTS.md verify panel rules. | Root | 2026-10-19 |
| RO-12 | Window recheck at evaluation start and outcome write (from the final checks) | At each evaluation start and before the outcome write QR-4 rechecks the evaluation part of W against the exposure register and against the windows of other runs of the owner on the participant sources. Each recheck shares one SERIALIZABLE transaction with the step it guards, and every register writer, QR-3 included, runs at SERIALIZABLE isolation (sections 4.1, 8.1, 13.3). A failed recheck ends the selection `SELECTION_INCOMPLETE` with `QR4_WINDOW_EXPOSED` or `QR4_WINDOW_OVERLAPS_SEARCHED_DATA`. This tightens the accepted window rule and closes the gap between registration and the outcome write. | Root | 2026-10-19 |
