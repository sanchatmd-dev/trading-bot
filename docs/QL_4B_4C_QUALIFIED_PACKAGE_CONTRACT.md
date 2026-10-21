# QL-4B/QL-4C qualified Best Inputs package contract

Status: owner decisions OD-1 to OD-19 and root decision OD-20 recorded 2026-10-19 (section 10); root clarifications RC-1 to RC-11 recorded the same day (section 10.1); root decisions RC-12 to RC-32 for the package builder recorded 2026-10-20 and RC-33 recorded 2026-10-21 (section 10.2). Root accepted the other rules on
2026-10-19 after independent review. The pure gate module (`src/quant-library/package-gates.js`) and the slice S1 pure renderer
(`src/quant-library/package-render.js`) are root-accepted as local engineering evidence and are wired into no route,
worker, table or view. Builder slice S2, the insert-only package tables (`src/postgres/best-inputs-package-schema.sql`),
is root-accepted as local engineering evidence and is not installed on staging; no package can be built, stored or
shown yet. Nothing in this contract grants a
recommendation, apply, email or Bot action by itself. It does not change the Roadmap. Each implementation step still needs its own gates and approvals.

Feature: F09-01. Target: staging.

## 0. Reading key

- `[SRC: path § section]` marks a rule taken from a source. Paths are relative to the repository. The
  citations let a reviewer trace each rule.
- `CODE:` marks a fact read from current code, used to learn interfaces. Code facts are not acceptance
  evidence.
- `OD-n` refers to an owner decision in section 10. Section 10 records every decision.
- Short names:
  - ROADMAP = `docs/ROADMAP.md`
  - QRL = `docs/QUANT_RESEARCH_LIBRARY.md`
  - PEX = `docs/PINE_EXPORT.md`
  - ADP = `docs/PINE_BRIDGE_ADAPTER_API.md`
  - FND = `docs/QUANT_FOUNDATION_CONTRACT.md`
  - INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`
  - SC = `docs/progress/PM1_SCORECARD_S1_2026-10-15.json`

Scope guard for every rule below [SRC: AGENTS.md § Host and product safety]: Spot/Paper only,
BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, no Live, no automatic optimizer loop, no guard reset, no
automatic Best Inputs apply, independent holdout gates. `NO_VALID_CANDIDATE` is a valid outcome.

## 1. Purpose and acceptance target

F09-01 acceptance: "A source-bound candidate package passes the QL-4B/QL-4C compile, provenance and
validation gates before being exposed as a recommendation." Target: staging. [SRC: INV row F09-01]

The scorecard gives F09-01 no credit (D UNKNOWN, I 0, V 0, T 0). Next action: "Eligible M4 evidence,
reviewed package contract, compilation/provenance/validation." Historical QL-4 completion cannot
transfer automatically to revised QL-4B/4C. [SRC: SC row F09-01]

Phase placement [SRC: ROADMAP § Governing phase sequence, rows QL-4B and QL-4C]:

- QL-4B exit gate: candidate files/report and guarded apply contract exist; no owner-facing
  recommendation, outbox enqueue, policy change or Bot activation before QL-4C validation.
- QL-4C exit gate: for one Pine, only validated fresh exports become owner-visible/applyable; Email
  Report enqueue only when validation and the SMTP delivery gate pass; multi-Pine results remain
  isolated until APP-3B. No post-export Paper trading cycle.

Milestones [SRC: ROADMAP § Work packages within the governing phases, rows M5 and M7]: M5 makes
candidate values, ownership, freshness and policy lock checkable, and no draft can change settings or
start a Bot. M7 requires one-Pine export status VALIDATED/READY before any owner recommendation, apply
or email enqueue.

This contract defines:

1. What a Best Inputs package is and what it binds to.
2. The gates a package passes before any owner sees it as a recommendation.
3. The READY predicate that F09-02 (email) and F09-03 (review, import, new Bot start) consume.

F09-01 implements neither email delivery nor owner apply. It defines the state those features read.

### 1.1 Relation to F09-02 and F09-03

- F09-02: "The validated export and matching report pass the delivery/SMTP gates without exposing an
  unqualified recommendation." [SRC: INV row F09-02] F09-02 reads READY and `export_id`. F09-01 creates
  no outbox row. [SRC: ROADMAP § Step 5 deliverables, "Report drafting in QL-4B creates no outbox row"]
  Email success never implies export validity. [SRC: SC row F09-02 carryLimitations]
- F09-03: "The owner reviews a compatible validated package and explicitly imports or starts a new Bot;
  no automatic apply or optimizer loop." [SRC: INV row F09-03] F09-03 reads READY (section 6.3).
  F09-01 never changes Bot settings.

## 2. Current state

These facts limit what F09-01 can claim today.

1. No eligible candidate exists. QL-3A research returned `NO_VALID_CANDIDATE` with the original holdout
   unopened. QL-4B/QL-4C remain gated. [SRC: ROADMAP § Current status table, rows "QL-3A research" and
   "QL-4B / QL-4C"]
2. Fixture-based package/report engineering may proceed after its engineering dependencies pass. Real
   recommendations, apply and email need a qualified run and export validation. [SRC: ROADMAP § Current
   status table, row "QL-4B / QL-4C"; § Work packages within the governing phases, paragraph after M7]
3. CODE: `src/quant-library/derive.js` implements `library-qualification-v2` (v1 before 2026-10-20; G5 now also reads the exposure register, QR-3 RC-C44) with eight fixed gates G1
   to G8. G8 `QL4C_VALIDATION` always fails with `QL4C_VALIDATION_NOT_AVAILABLE`. `QUALIFIED_TOTAL` is 0
   and `QUALIFIED_WINNER` is null. No run can be qualified today.
4. CODE: `src/postgres/quant-research-worker.js` always writes `owner_recommendation_ready:false`, so G7
   cannot pass for any run of the current engine.
5. CODE: both research contract builders freeze three `acceptance_blockers` at enqueue:
   `VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED`, `CUSTOM_REPAINT_EVIDENCE_REQUIRED`,
   `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED`, with scope `SPT_CUSTOM_ENGINEERING_ONLY`
   (`src/postgres/quant-research.js` line 136; `src/quant-research/research-contract-v2.js` lines 40
   and 134). The V2 validator requires exactly that list (line 108). Terminal results are immutable
   (item 6). So G6 cannot pass for any run created under either contract version. Section 4.4 and OD-3
   address this.
6. CODE: `src/postgres/quant-research-freeze.sql` (`quant-research-freeze-v1`) refuses update or delete
   of terminal research rows with SQLSTATE `QR001`, using `ENABLE ALWAYS` triggers and a pinned
   `search_path`. It was added in commit `0555330`, an ancestor of `faa95e5`, the revision read for this
   contract. Deployment state is unknown.
7. CODE: research admission refuses multi-Pine runs with `MULTI_PINE_RESEARCH_NOT_SUPPORTED`
   (`src/postgres/quant-research.js` line 76). Multi-Pine packages are not reachable today; the
   multi-Pine rules below are forward-looking.
8. CODE: the legacy offline exporter `quant_lab/src/robot_quant/exporter.py` builds
   `export_id = "export_{run_id}_{alert_source}"`, returns state `DRAFT` and writes `strategy.pine` and
   `strategy.json`. `contracts.py` fixes `export_validation` to `UNVERIFIED`. This is the legacy path,
   distinct from the revised authenticated workflow. [SRC: SC row F09-01 sourceIdentity; PEX status line]
9. CODE: no tracked `src` or `public` file defines `EXPORT_CANDIDATE`, `EXPORT_VALIDATED` or an
   `export_id` row. F09-01 implementation starts from the library qualification view only.
10. CODE: PF-4 confirmed save (`src/postgres/pf4-proposal-service.js`) shows a guarded-apply pattern in
    use: SERIALIZABLE transaction, owner check (`BOT_ACCESS_DENIED`), `RISK_POLICY_FROZEN` while the
    session is RUNNING or PAUSED, base-policy-hash staleness (`STALE_POLICY_STATE`), a confirm token
    (`CONFIRMATION_REQUIRED`) and audit events. Section 7 reuses it as guards.
11. CODE: the Research Library returns `NOT_FOUND` (404) for absent and foreign runs alike
    (`src/postgres/quant-library.js` line 274). Section 7 follows this for export reads.

## 3. Package identity and source binding

### 3.1 Identity

- A server-issued `export_id` identifies one immutable Best Inputs candidate and its report draft, bound
  to `bot_id`, `run_id`, all participating `pine_import_id`/source-version pairs and the risk-policy
  snapshot, with an ISO-8601 UTC creation timestamp. [SRC: PEX § Generated artifacts, export_id
  paragraph; ROADMAP § Identity and provenance, export_id row]
- Identity also includes owner, Bot, run, optional parent run, mode, strategy revision, Pine membership
  and version list, source hash and effective-input hash. [SRC: QRL § Research record and storage,
  "Identity"]
- `export_id` is a random server UUID, never derived from `run_id` or a hash, never reused. The legacy
  pattern `export_{run_id}_{alert_source}` is not used, because it is predictable and carries no owner
  scope.
- At most one `export_id` exists per `(owner_id, run_id)`, enforced by a database unique constraint. A
  second build request for the same run returns the existing `export_id` and never creates a second
  candidate. This keeps one package per owner-started workflow and stops re-building as a hidden retry
  loop. [SRC basis: PEX § Generated artifacts, "This preserves one optimization per owner-started
  workflow"] See OD-11.
- Two hashes travel with every package:
  - `binding_hash` = SHA-256 of the canonical JSON of the binding tuple (3.2). It states which research
    facts the package claims.
  - `package_hash` = SHA-256 of the canonical `quant-data/manifest.json`, whose `files` list holds
    `(path, sha256, bytes)` for every other file. It states which bytes were validated.
  - Canonicalisation and hashing reuse `canonical` and `hash` from `src/pine-bridge/source.js`, which
    `derive.js` already imports (CODE).
- A hash is never an access token or authorization. [SRC: QRL § Research record and storage;
  ROADMAP § Identity and provenance]

### 3.2 Source binding tuple

The package stores one binding tuple, copied from the immutable run contract and server records at build
time. Every field is required. A missing field refuses the build with `BI_BINDING_INCOMPLETE`; nothing is
defaulted.

| Field | Origin | Source rule |
| --- | --- | --- |
| `owner_id`, `bot_id` | `quant_jobs` row, never client input | [SRC: PEX § Webhook and deployment contract, "Do not use a payload user_id as authorization"] |
| `run_id`, `contract_hash`, `submission_hash` | `quant_jobs` row | CODE: `protect_quant_job_contract` trigger; [SRC: QRL § Research record and storage, "Identity"] |
| `deployment_id`, `pine_import_id`, `source_version`, `source_hash`, `baseline_snapshot_hash` | Run contract | [SRC: PEX § Generated artifacts]; CODE: contract fields |
| `input_lock_hash`, selected slot bindings, Bridge domains | Run `contract.input_lock` | [SRC: ROADMAP § Binding and optimization contract, "Changes to selected slots, domains or fixed values invalidate dependent evidence"] |
| `effective_input_hash` | Complete effective-input snapshot (selected plus fixed) | [SRC: QRL § Research record and storage, "Identity"] |
| `policy_version`, `policy_hash` | New explicit field of the next research contract version (OD-12) | [SRC: ROADMAP § Identity and provenance, "Store immutable policy version/hash"] |
| `capital`, `ledger_initialization` | Run contract | [SRC: QRL § Research record and storage, "Account assumptions"] |
| `model`, `cost_model_version` | Run contract | [SRC: PEX § Candidate and risk prerequisites, "Declare equity basis, fees/slippage/spread"; "Pine's fixed-tick slippage cannot be silently treated as a dynamic percentage model"] |
| `dataset_ref`, `split` | `{dataset_id or digest, sha256, metadata}`; train/validation/test boundaries and warm-up | [SRC: FND § Shared interfaces, `validateDatasetReference`; QRL § Research record and storage, "Data"] |
| `holdout_boundary_ref` | Owner-registered write-once holdout boundary where present | [SRC: ROADMAP § Approved extension — readiness before Run Bot, PF-2 row, R3 and R3b]; see OD-9 |
| `engine_hash` | Run contract | [SRC: QRL § Research record and storage, "Reproduction"] |
| `rules` | Run `contract.rules` (today equal to `RULES`) | CODE: `src/quant-research/contract.js` line 6 |
| `acceptance_blockers` | Run contract | CODE: G6 input |
| `library_versions`, `library_record_ref` | `LIBRARY_VERSIONS` and the frozen QR-1 record | CODE: `derive.js`; [SRC: ROADMAP § Quant Research Library, QR-1 row] |
| `alert_source` | Always `alert_calls` | [SRC: PEX § Export selection] |
| `exit_version` | Bridge exit contract of the evaluated deployment | [SRC: PEX § Candidate and risk prerequisites; ROADMAP § Governing phase sequence, APP-3A row (`bridge-exit-v2` for new artifacts; `bridge-exit-v1` for legacy); ADP § Chatbot system prompt (draft), "Existing v1 artifacts keep their frozen receiver behavior"]; see OD-6 |
| `market` | `binance-global`, `BINANCE:BTCUSDT`, Spot, timeframe `1` | [SRC: FND § Shared interfaces; ADP § Separate capabilities, "Spot venue identity"] |
| `mode`, `pine_count`, membership list | Server-resolved | [SRC: ROADMAP § Binding and optimization contract, "Pine count ... resolved on the server"] |
| `fixture` | Boolean; true for labelled engineering fixtures and for any engineering-only contract scope; set at birth, never cleared | [SRC: ROADMAP § Data readiness and candidate outcomes, "Fixture-based QL-4B work must be labelled and cannot create customer Best Inputs"] |
| `created_at` | ISO-8601 UTC, server clock | [SRC: PEX § Generated artifacts] |

The freshness tuple F is a subset of the binding: current deployment for the Bot, `source_hash` and
`source_version`, Pine membership, `policy_version`/`policy_hash`, `input_lock_hash`, and dataset
availability. F is compared at validation, at every read and at every owner action (sections 5.4, 6.2
and 7.3). A later engine change is not part of F. It is a recorded limitation that blocks exact replay
only, and the validator records its own engine hash (OD-13).

## 4. Contents and evidence

### 4.1 Files

The package contains `inputs.json`, the supported indicator Pine Script, a Setup Guide and Quant Data
(manifest, metrics, equity, trades, decisions, validation and dataset references). [SRC: ROADMAP
§ Step 5 deliverables, item 1; QRL § Quant Data in the Best Inputs package]

Earlier sources named the files differently (OD-1 aligns QRL and PEX with the set below):

- QRL (before 2026-10-19): [SRC: QRL § Quant Data in the Best Inputs package] `inputs.json`, `strategy.pine`, `setup-guide.md`, `quant-data/{manifest.json,
  metrics.json, equity.csv, trades.csv, decisions.csv, validation.json}`.
- PEX (before 2026-10-19): [SRC: PEX § Generated artifacts] `inputs.json`, `indicator.pine`, `indicator.json`, `risk-profile.json`,
  `setup.md`, `validation.html`.
- CODE: the legacy exporter writes `strategy.pine` and `strategy.json`.

The canonical set is below (OD-1). The workflow is indicator-only and rejects strategies [SRC: ADP § Scope
and transformation, `INDICATOR_REQUIRED`], so the Pine file is `indicator.pine`:

```text
inputs.json
indicator.pine
indicator.json
risk-profile.json
setup-guide.md
validation.html        (human rendering only; validation.json is the machine record)
quant-data/
  manifest.json
  metrics.json
  equity.csv
  trades.csv
  decisions.csv
  validation.json
```

The gate logic does not depend on the names.

Manifest top-level sections: `schema_version` (`best-inputs-manifest-v1`), `identity` (3.1),
`binding` (3.2), `files`, `inputs`, `evidence` (4.3), `limitations` (text plus codes), `fixture`.

### 4.2 Required content per file

- `inputs.json`: selected slot IDs, before and after values, fixed source values, effective presets,
  source hash and run identity. One Pine: up to 8 optimized numeric source inputs, the Bridge ATR/RR pair
  and all other source inputs labelled fixed. Multi-Pine: only the shared Bridge pair is actionable;
  fixed snapshots stay in private provenance. [SRC: PEX § Generated artifacts, `inputs.json` bullet;
  ROADMAP § Step 5 deliverables, item 1] Values are decimal strings with declared units. [SRC: QRL
  § Research record and storage]
- `indicator.pine`: complete private indicator with approved numeric defaults and Bridge values. Only
  the selected numeric default edits and Bridge changes are allowed, disclosed in the diff; logic,
  source notices and every unselected input are preserved. [SRC: PEX § Generated artifacts,
  `indicator.pine` bullet]
- `indicator.json`: indicator identity and version, selected numeric slots, fixed input snapshot,
  `alert_source`, bridge-exit version, calculation and fill assumptions, supported symbol and timeframe.
  [SRC: PEX § Generated artifacts, `indicator.json` bullet]
- `risk-profile.json`: versioned risk snapshot; never overrides current server hard limits. [SRC: PEX
  § Generated artifacts, `risk-profile.json` bullet]
- `setup-guide.md`: source-specific TradingView condition, message, symbol, timeframe and webhook setup;
  webhook credentials stay outside the package; retiring the old entry route while keeping permitted
  exits for existing allocations. [SRC: PEX § Generated artifacts, setup guide bullet; ROADMAP § Step 5
  deliverables, alert paragraph]
- `validation.html`: parity results for the selected source and disclosure of execution differences.
  [SRC: PEX § Generated artifacts]
- `quant-data/manifest.json`: artifact schemas and checksums, dataset and engine references, IDs,
  inputs, policy and cost assumptions, periods and limitations, and how to tell native signals, intents,
  fills and position episodes apart. [SRC: QRL § Quant Data in the Best Inputs package]
- `metrics.json`: train/validation/test metrics of the selected candidate (CODE: `derive.js`
  `METRIC_KEYS`) plus Win Rate for the report. [SRC: ROADMAP § Step 5 deliverables, item 2] Absent
  metrics stay absent. [SRC: QRL § Research record and storage]

### 4.3 Evidence the package references

Every reference is an owner-scoped ID plus a SHA-256. A missing reference refuses the build or fails
validation with the listed code.

| Evidence | Pass rule | Source | Code |
| --- | --- | --- | --- |
| Research run | Terminal `SUCCEEDED`, `completion_reason = RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`, `holdout_evaluated = true` | CODE: worker lines 136 to 137 | `STATUS_NOT_COMPLETED`, `BI_RUN_NOT_QUALIFIABLE` |
| Search record | Domains, algorithm, budget, seed, candidate counts, completion reason recorded | [SRC: ROADMAP § Binding and optimization contract] | `BI_SEARCH_RECORD_MISSING` |
| Dimension coverage | 100% of selected dimensions participate; dropped dimensions 0 | [SRC: ADP § Quantitative parity, row "Search and candidate"; ROADMAP M4 row] | `BI_DIMENSION_COVERAGE` |
| Library record | QR-1 record frozen; `contract_hash_verified` and `report_matches_checkpoints` true | [SRC: ROADMAP QR-1 row]; CODE: G1 | `INTEGRITY_CHECK_FAILED` |
| Robustness | Sensitivity and cost-stress passed | [SRC: ROADMAP § Data readiness, "Recommendation" row]; CODE: G3 | `SENSITIVITY_FAILED`, `COST_STRESS_FAILED` |
| Holdout result | Run's own `rules`: at least 5 test closed trades, return not negative, test drawdown at most the rule limit (20% today) | CODE: worker lines 131 to 134, `RULES` | `HOLDOUT_NOT_EVALUATED`, `INSUFFICIENT_TEST_TRADES`, `NEGATIVE_HOLDOUT_RETURN`, `TEST_DRAWDOWN_EXCEEDED` |
| Holdout independence | Section 5.0 rule 5 | Section 5.0 | Section 5.0 |
| Episode coverage | At least 5 flat-to-flat episodes per partition. The versioned gate is required before the first real package (OD-4). A fixture package is exempt and is never READY (RC-10). | [SRC: ROADMAP § Data readiness, "Position episodes" row] | `BI_EPISODE_GATE_UNAVAILABLE` |
| Cost model | A version with accepted evaluator parity; V2 refused until V2 parity passes | [SRC: ROADMAP PF-2 row] | `BI_COST_MODEL_UNSUPPORTED` |
| Data window | `spot-dataset-v1`, `binance-global`, `BTCUSDT`, timeframe `1`, closed bars by cutoff, warm-up included, no gaps or duplicates, dataset readable with matching hash | [SRC: FND § Shared interfaces; QRL § Research record and storage, "Missing/deleted archived data must explicitly disable exact reproduction"] | `BI_DATASET_UNAVAILABLE`, `BI_DATASET_HASH_MISMATCH`, `BI_MARKET_SCOPE_INVALID` |
| Engine identity | Run `engine_hash` recorded; validator records its own engine hash | [SRC: QRL § "Reproduction"]; CODE: `QUANT_ENGINE_CHANGED` | `BI_ENGINE_HASH_MISMATCH` |
| Acceptance blockers | Section 4.4 | CODE: G6 | `BI_CAPABILITY_BLOCKER_PRESENT`, `ACCEPTANCE_BLOCKERS_PRESENT`, `BLOCKERS_UNKNOWN` |
| Compile record | Section 5.2 | [SRC: ADP § Quantitative parity, row "Compilation/binding"; PEX § Acceptance criteria 4] | Section 5.2 |
| Chosen-settings parity and repaint | Section 5.4 | [SRC: ADP § Quantitative parity, row "Search and candidate"] | Section 5.4 |

The package never contains raw OHLCV bars of any partition. It carries dataset references and hashes; a
bar dataset is a separately authorized optional download. [SRC basis: QRL § Quant Data, "Large
OHLCV/signal datasets may be a separately authorized optional download"] Holdout bars never ship inside a
package.

### 4.4 Split of acceptance blockers (OD-3)

The frozen blocker list mixes two kinds:

- Capability blockers (today `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED`): the source/evaluator capability
  itself. These must be clear at run admission. A run created while a capability blocker exists can never
  produce a qualifiable package; a new run under a new contract version is required. Reason: capability
  cannot be granted after seeing results.
- Candidate evidence blockers (today `VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED` and
  `CUSTOM_REPAINT_EVIDENCE_REQUIRED`): parity and repaint for the chosen settings. ADP places these checks
  after selection and before Export validated. [SRC: ADP § Quantitative parity, row "Search and
  candidate"] Each is cleared by an append-only evidence-clearance record that names `run_id`,
  `export_id`, the candidate parameter hash and the evidence hash. The frozen run row is never edited.
  G6 for export purposes = frozen list minus cleared candidate blockers; any remainder fails.

A new research contract version is required, because the V2 validator demands the exact three-blocker
list (section 2, item 5). Under the split, the new version freezes only candidate evidence blockers and
refuses admission while a capability blocker exists.

A clearance record clears a native-parity blocker only when its evidence hash equals the digest of the
native-parity evidence. It clears a repaint blocker only when its evidence hash equals the digest of the
repaint evidence (RC-7).

One exception to the admission rule for capability blockers applies on the `EXPORT_INTERNAL` path
only. There the multi-Pine research contract version freezes the capability blocker
`MULTI_PINE_REQUIRES_APP_3B` at admission, and that blocker neither refuses B0 nor fails G6 for
export at C4 (RC-11; docs/MULTI_PINE_CONTRACT.md § 5.8, RD-MP-10). Every other capability blocker
still refuses admission, B0 and C4. An internal package is never qualifiable and never READY, so this
exception grants no capability.

## 5. Gates

Gate order and thresholds are fixed before any result is seen. [SRC: QRL § Strategy Comparison, "A
fixed weighted score is not assumed or invented after viewing results"; CODE: `derive.js` "fixed here,
never chosen after a result is seen"]

Every check returns `PASS`, `FAIL` or `NOT_REACHED`, with a refusal code for each failure. Missing,
unreadable or unknown input is `FAIL`, never a pass or a skip. [SRC: ROADMAP § readiness before Run Bot,
PF-1 row, "Unknown data cannot become a pass"]

Thresholds are read from the run's own frozen `rules`, never from current code constants. A later change
of `RULES` cannot retro-qualify or retro-disqualify a run. A differing current `RULES` is recorded as
`RULES_VERSION_DIFFERS` in `limitations` (informational).

The current `RULES` are a required input of the check, so the check can make that comparison
(RC-9). The `RULES_VERSION_DIFFERS` rule does not change.

Codes use upper snake case matching `^[A-Z][A-Z0-9_]{1,63}$`; existing codes are reused where the
meaning is the same.

### 5.0 Gate B0: build eligibility (QL-4B entry)

Purpose: decide if a private `EXPORT_CANDIDATE` may be built at all.

Gate B0 runs only at build. A validation attempt runs C1 to C4 and Q and never re-runs B0 (RC-3).

Pass rule, all required:

1. Library gates G1 to G5 and G7 are `PASS`. On the `EXPORT_INTERNAL` path only, G7 may fail only
   because the run's contract version is the multi-Pine research contract version, which is never
   listed among the versions whose G7 derives `PASS` (`OWNER_RECOMMENDATION_NOT_READY`). The
   completion reason must still be the one that derives G7 `PASS` (OD-18, RC-11).
2. G6 for build purposes: no capability blocker remains (`BI_CAPABILITY_BLOCKER_PRESENT`); only
   candidate evidence blockers (4.4) may remain. G8 may fail only with `QL4C_VALIDATION_NOT_AVAILABLE`.
   (B0 cannot require full G6 PASS, because the evidence that clears G6 exists only after the build.)
   On the `EXPORT_INTERNAL` path only, the capability blocker `MULTI_PINE_REQUIRES_APP_3B` does not
   refuse B0 (RC-11; docs/MULTI_PINE_CONTRACT.md, RD-MP-10). Every other capability blocker still
   refuses.
3. Mode is `ONE_PINE`, or mode is `MULTI_PINE` and the package is created internal (`EXPORT_INTERNAL`
   path, section 6). [SRC: ROADMAP § Governing phase sequence, QL-4C and APP-3B rows]
   A `MULTI_PINE` run without the internal path fails B0 with `BI_MULTI_PINE_INTERNAL_ONLY`. The
   admission code `MULTI_PINE_RESEARCH_NOT_SUPPORTED` keeps its research meaning (RC-1).
4. Binding tuple complete (3.2).
5. Holdout independence, an extension of G5:
   - No earlier run of the owner has an overlapping holdout window. CODE: `derive.js` G5
     (`HOLDOUT_INDEPENDENCE_NOT_CHECKED`, `HOLDOUT_WINDOW_REUSED`).
   - The holdout window does not overlap any train or validation window that an earlier run of the same
     owner and same source searched. [SRC: ROADMAP § Report range and research capacity contract, "only
     untouched disjoint periods support independent evaluation"; QRL § Periods and data admission,
     "expanded datasets containing search history do not become fresh independent validation"] Code
     `BI_HOLDOUT_OVERLAPS_SEARCHED_DATA`. See OD-10.
   - Where a PF-2 R3 owner-registered boundary exists for the Bot, the holdout starts at or after it.
     The boundary is authoritative where present. Code `BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY`. See OD-9.
   - The holdout window does not overlap any window that a QR-3 comparison or a QR-4 selection of the same
     owner and the same market used. Such a window counts as exposed data for this check, because ranking
     finalists on it makes it selection data. [SRC: ROADMAP § Report range and research capacity contract;
     QR-3 contract, docs/QR_3_FAIR_COMPARISON_CONTRACT.md § 7; QR-4 contract,
     docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md § 13.3] Code `BI_HOLDOUT_EXPOSED_BY_SELECTION`. The check
     reads the one exposure register that both contracts share. An empty register is valid. An absent or
     unreadable register fails this check with `BI_EXPOSURE_REGISTER_UNAVAILABLE`. See OD-19.
     An exposure record counts only when its `at_utc` is at or before the durable creation time of the
     run. The check filters records by the same owner and the same market. A malformed entry is treated
     as an unreadable register (`BI_EXPOSURE_REGISTER_UNAVAILABLE`). Neither OD-19 code is retryable
     (RC-2).
6. The requesting owner owns the run. [SRC: QRL § Research record and storage, "Storage access checks
   owner authorization on every read/export"] Foreign or absent run: `NOT_FOUND` (404).

A failure creates no package and changes no library class. An unsuccessful run may export only a
clearly labelled diagnostic bundle (`DIAGNOSTIC_ONLY`, no `inputs.json` recommendation block), never an
actionable package. [SRC: QRL § Quant Data in the Best Inputs package]

`NO_VALID_CANDIDATE` is a valid outcome and creates no package. [SRC: ROADMAP § Step 5 deliverables,
status list; QRL § Strategy Comparison, "Allow ties, inadequate evidence and no qualifying strategy"]

### 5.1 Gate C1: structure and content integrity

Pass rule, all required:

| Check | Code |
| --- | --- |
| Every file in 4.1 present; no unlisted file | `BI_ARTIFACT_MISSING`, `BI_ARTIFACT_UNEXPECTED` |
| Manifest validates against `best-inputs-manifest-v1` | `BI_MANIFEST_SCHEMA_INVALID` |
| Every file SHA-256 and byte count equal the manifest; `package_hash` and `binding_hash` recompute identically | `BI_CHECKSUM_MISMATCH` |
| No credential, webhook bearer URL, secret pattern, private key or machine-specific path in any file [SRC: QRL § Quant Data] | `BI_SECRET_DETECTED`, `BI_MACHINE_PATH_DETECTED` |
| Monetary values are decimal strings with units; timestamps UTC [SRC: QRL § Research record and storage] | `BI_NUMERIC_FORMAT_INVALID` |
| Metrics absent in the run stay absent; never zero [SRC: QRL § Research record and storage] | `BI_METRIC_FABRICATED` |
| `alert_source = alert_calls`; exactly one `indicator()`; no `strategy()` or executable `strategy.*` [SRC: PEX § Export selection; ADP § Separate capabilities, "Declaration"] | `BI_ALERT_SOURCE_INVALID`, `INDICATOR_REQUIRED` |
| Market is `BINANCE:BTCUSDT` Spot 1m | `BI_MARKET_SCOPE_INVALID` |

The secret scan is a last line of defence. The primary control is that the builder never reads
credential sources.

### 5.2 Gate C2: compile and source integrity

Rules from sources:

- TradingView compilation is a recorded check; it cannot be presumed from job success. [SRC: ADP
  § Quantitative parity, paragraph after the table]
- 0 compilation errors, unresolved references, identifier collisions and duplicate slot bindings; 100%
  selected mappings correct; record and review 100% of warnings. [SRC: ADP, row "Compilation/binding"]
- 0 changed bytes before the appended block; original hash match 100%. [SRC: ADP, row "Source integrity"]
- Generated text alone is insufficient. No Strategy Tester gate. [SRC: PEX § Acceptance criteria 4]
- Changes outside approved input values are absent from the indicator logic diff. [SRC: PEX
  § Acceptance criteria 10]

Compile record, append-only: `{export_id, indicator_sha256, pine_version, errors[],
warnings[{text, disposition, reviewer_role}], unresolved_references, collisions, duplicate_bindings,
mapping_check, compiled_at_utc, operator_role, method}`. No machine paths or screenshots with secrets.

| Check | Code |
| --- | --- |
| A compile record exists for this `export_id` | `BI_COMPILE_EVIDENCE_MISSING` (retryable) |
| Record `indicator_sha256` equals the package `indicator.pine` hash | `BI_COMPILE_SOURCE_MISMATCH` |
| Errors, unresolved references, collisions, duplicate bindings all 0 | `BI_COMPILE_ERRORS` |
| Every selected slot maps to the Pine variable in the run's `input_lock.selection.bindings` (CODE: `pine_variable`) | `BI_SLOT_BINDING_MISMATCH` |
| Every warning has a review disposition | `BI_COMPILE_WARNINGS_UNREVIEWED` (retryable) |
| Prefix before the appended block matches the registered `source_hash` | `BI_SOURCE_HASH_MISMATCH` |
| Diff outside approved input defaults and Bridge values is empty | `BI_SOURCE_LOGIC_CHANGED` |
| Native alert routes disabled through existing configuration; unrelated/native payloads 0 [SRC: ADP, row "Webhook isolation"; PEX § Export selection] | `BI_NATIVE_ALERT_ISOLATION_UNPROVEN` (retryable) |

The validator never calls TradingView. It reads the recorded row. The compile step needs TradingView.
Among agents, only root coordinates it, as a serial step, and no workflow agent uses TradingView. [SRC: AGENTS.md § Claude
root ultracode; § File, Git and browser ownership] The owner may also run the compile and supply the
evidence. The record states the method and the operator role (OD-2).

### 5.3 Gate C3: provenance

| Check | Code |
| --- | --- |
| Every binding field equals the `quant_jobs` row and its immutable contract; owner-scoped records resolve with matching hashes | `BI_PROVENANCE_UNRESOLVED`, `BI_BINDING_MISMATCH` |
| `inputs.json` values equal the selected candidate parameters of the frozen run, slot by slot | `BI_INPUTS_MISMATCH` |
| At most 8 distinct selected numeric source slots plus exactly 2 Bridge slots [SRC: PEX § Generated artifacts; ADP § Separate capabilities, "Slots"] | `BI_SLOT_LIMIT` |
| Every value in its declared domain and step; finite numbers only [SRC: ADP § Separate capabilities, "Numeric domains"] | `BI_INPUT_OUT_OF_DOMAIN` |
| Fixed inputs equal the frozen fixed snapshot [SRC: PEX § Generated artifacts, "Membership/source/selection/domain/fixed-value changes invalidate evidence"] | `BI_FIXED_INPUT_CHANGED` |
| `risk-profile.json` equals the run policy snapshot; no field weaker than current server hard limits [SRC: PEX § Acceptance criteria 8] | `BI_POLICY_SNAPSHOT_MISMATCH`, `BI_RISK_RELAXATION` |
| `metrics.json`, `validation.json` and the trace files reproduce the stored steps for the selected candidate, sensitivity, cost-stress and `holdout:selected` (canonical bytes) | `BI_RESULT_MISMATCH`, `HOLDOUT_MISMATCH` |
| Dataset reference resolves and bytes verify | `BI_DATASET_UNAVAILABLE`, `BI_DATASET_HASH_MISMATCH` |
| Engine hash equals the run contract value | `BI_ENGINE_HASH_MISMATCH` |
| Cost model version admitted (V1 only today) | `BI_COST_MODEL_UNSUPPORTED` |
| Exit version equals the evaluated deployment exit version and is supported; an unsupported version is refused (OD-6) | `BI_EXIT_VERSION_UNSUPPORTED` |
| Fixture label honest: engineering scope or fixture request implies `fixture = true` | `BI_FIXTURE_LABEL_MISSING` |

The trace check uses an evaluator-produced reproduction record. The record holds, for each trace file,
the recomputed steps digest. An absent record or a digest difference gives `BI_RESULT_MISMATCH`. For the
holdout trace the code is `HOLDOUT_MISMATCH`. Both codes are non-retryable (RC-4).

A fixture package can pass C3. It can never be READY or a G8 source (sections 5.5 and 6.3).

### 5.4 Gate C4: validation (evidence and freshness)

Rules from sources:

- QL-4C first checks compilation, parity, ownership and freshness. [SRC: ROADMAP § Step 5 deliverables]
- The chosen candidate passes the same historical, evaluator and repaint checks before Export validated.
  [SRC: ADP, row "Search and candidate"]
- Changing any material assumption marks evidence stale; source changes invalidate prior
  source-specific validation. [SRC: PEX § Candidate and risk prerequisites; § Acceptance criteria 7]
- No post-export Paper trading cycle. [SRC: ROADMAP § Governing phase sequence, QL-4C row]

| Check, all for the chosen settings | Code |
| --- | --- |
| Dataset alignment: 100% matching closed-bar UTC timestamps and OHLCV; unmatched bars and future-data leakage 0 [SRC: ADP, row "Dataset alignment"] | `BI_DATASET_ALIGNMENT_MISSING` (retryable), `BI_DATASET_ALIGNMENT_FAILED` |
| Sample floor: warm-up at least `max(500, 5 * L)`; at least 2,000 closed bars and 100 native events including 30 BUY and 30 native exits [SRC: ADP, row "Warm-up/sample floor"] | `BI_PARITY_SAMPLE_FLOOR_NOT_MET` |
| Native signal parity: 100% match, 0 missing/additional events, 0-bar shift [SRC: ADP, row "Native signal parity"] | `BI_PARITY_EVIDENCE_MISSING` (retryable), `BI_NATIVE_SIGNAL_PARITY_FAILED` |
| Bridge protection parity: 100% against the bound exit version; SL/TP difference 0 ticks [SRC: ADP, row "Bridge protection parity"] | `BI_BRIDGE_PARITY_FAILED` |
| Repaint: at least 100 closed-bar observations, 0 changed native flags; one full-history recomputation insufficient [SRC: ADP, row "Repaint evidence"] | `BI_REPAINT_EVIDENCE_MISSING` (retryable), `BI_REPAINT_FLAGS_CHANGED` |
| Quant baseline: coverage 100%; accept/cap/reject match 100%; 0 venue-step quantity difference; cash within 1 minor unit [SRC: ADP, row "Quant baseline"] | `BI_QUANT_BASELINE_FAILED` (a missing baseline gives this code too; non-retryable) |
| Every evidence record names the same source hash, effective-input hash, dataset and engine as the package | `BI_PARITY_SCOPE_MISMATCH` |
| Freshness tuple F equals current server state | `BI_SOURCE_VERSION_STALE`, `BI_MEMBERSHIP_CHANGED`, `BI_POLICY_SNAPSHOT_MISMATCH`, `BI_DEPLOYMENT_CHANGED`, `BI_SELECTION_CHANGED` |
| Bridge pair inside the run's recorded domains and the Bot's current permitted Bridge bounds; hard limits untouched [SRC: PEX § Candidate and risk prerequisites, "The optimizer cannot raise hard limits or disable locked guards"] | `BI_BRIDGE_PAIR_OUT_OF_BOUNDS` |
| All candidate evidence blockers cleared (4.4); on the `EXPORT_INTERNAL` path only, `MULTI_PINE_REQUIRES_APP_3B` does not fail G6 for export (RC-11) | `ACCEPTANCE_BLOCKERS_PRESENT` (retryable) |

A missing quant baseline gives `BI_QUANT_BASELINE_FAILED`. This code is non-retryable, and the retryable
list in 6.1 stays closed (RC-5).

On the `EXPORT_INTERNAL` path only, the capability blocker `MULTI_PINE_REQUIRES_APP_3B` does not fail G6
for export at C4 (RC-11; docs/MULTI_PINE_CONTRACT.md, RD-MP-10). Every other blocker still fails G6.

### 5.5 Gate Q: qualification record

When C1 to C4 pass in one validation attempt, the server writes one append-only `ql4c_validation` record
`{export_id, package_hash, binding_hash, attempt_id, gate_results, validator_engine_hash, fixture,
validated_at_utc}`. A second validation of the same `(export_id, package_hash)` returns the existing
record.

Library G8 becomes `PASS` for a run only when a PASS `ql4c_validation` record exists for a package of
that run with `fixture = false` and mode `ONE_PINE`. [SRC for G8 meaning: CODE `derive.js` "Gate G8 (an
accepted QL-4C validation record)"] `QUALIFIED_TOTAL` then derives from those records and stays 0
until one exists. `QUALIFIED_WINNER` stays null in F09-01 (RC-6).

G7 (`owner_recommendation_ready`) for a new engine version is derived from the completion reason and the
contract version. It is never a free flag written by the engine (OD-18). The completion reason that
derives G7 `PASS` is `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` (section 4.3, research run row). The
listed contract versions are named with the next research contract version (OD-12).

Only qualified results may receive a best-in-scope label, and the label is "best within the selected
scope", never universal. [SRC: QRL § Strategy Comparison and Best Performance; ROADMAP § Report and
research behavior]

Rule changes create a new version and never re-label earlier records.

Invalid attempt metadata refuses the call. The call records no attempt and changes no status (RC-6).
The qualified winner stays null in F09-01, because ranking across runs belongs to QR-4.

## 6. Statuses and transitions

### 6.1 Stored export status

The Roadmap tracks `NO_VALID_CANDIDATE`, `EXPORT_CANDIDATE`, `EXPORT_VALIDATED/EXPORT_READY` and the
email statuses separately. Email status is a separate field owned by F09-02; email failure does not
invalidate a validated package. [SRC: ROADMAP § Step 5 deliverables; PEX § Acceptance criteria 12]

Stored statuses are append-only status events; the current status is the last event:

| Status | Meaning | Owner sees |
| --- | --- | --- |
| `NO_VALID_CANDIDATE` | Run-level outcome; no export row. Shown from the library record. | Outcome class and reason counts; diagnostic bundle |
| `EXPORT_CANDIDATE` | Built after B0; awaiting validation, or failed only on retryable codes | Status and codes only (OD-5) |
| `EXPORT_INTERNAL` | Multi-Pine package that passed C1 to C4; isolated until APP-3B | Nothing actionable; never READY |
| `EXPORT_VALIDATED` | One attempt passed C1 to C4; `ql4c_validation` written | Recommendation only when READY (6.3) |
| `EXPORT_REFUSED` | Non-retryable failure or attempts exhausted; terminal | Status and codes, no values |

Every transition not listed here is refused with `BI_TRANSITION_INVALID`:

```text
(run terminal, B0 fail)                          -> no export row
(run terminal, B0 pass)                          -> EXPORT_CANDIDATE
EXPORT_CANDIDATE --attempt passes C1-C4, 1 Pine  -> EXPORT_VALIDATED
EXPORT_CANDIDATE --attempt passes C1-C4, multi   -> EXPORT_INTERNAL
EXPORT_CANDIDATE --retryable failure only        -> EXPORT_CANDIDATE (attempt recorded)
EXPORT_CANDIDATE --non-retryable failure         -> EXPORT_REFUSED
EXPORT_CANDIDATE --attempt limit reached         -> EXPORT_REFUSED (BI_ATTEMPTS_EXHAUSTED)
EXPORT_VALIDATED, EXPORT_INTERNAL, EXPORT_REFUSED -> terminal; no further stored transition
```

Retryable codes, the only ones: `BI_COMPILE_EVIDENCE_MISSING`, `BI_COMPILE_WARNINGS_UNREVIEWED`,
`BI_NATIVE_ALERT_ISOLATION_UNPROVEN`, `BI_DATASET_ALIGNMENT_MISSING`, `BI_PARITY_EVIDENCE_MISSING`,
`BI_REPAINT_EVIDENCE_MISSING`, `ACCEPTANCE_BLOCKERS_PRESENT`. Each is a missing-evidence code, never a
failed measurement. A retry uses the same package bytes and adds evidence only. A retry never changes
inputs, data, bounds, rules or guards. [SRC: docs/TIME_MANAGEMENT.md § 3. ลำดับใช้เวลาให้คุ้มค่า, "ห้ามวน optimize
เปลี่ยน inputs หรือรีเซ็ต guard อัตโนมัติ"; AGENTS.md § Host and product safety] At most 5 validation attempts are allowed
per `export_id`. If the fifth attempt fails with retryable codes only, the status becomes `EXPORT_REFUSED`
with `BI_ATTEMPTS_EXHAUSTED` (OD-7). A failed
measurement (for example `BI_NATIVE_SIGNAL_PARITY_FAILED`) is non-retryable.

Gate B0 is not part of a validation attempt (RC-3). A retry never re-runs B0.

An APP-3B release of an `EXPORT_INTERNAL` package needs a new `export_id` with `parent_export_id` and a
full new validation. Apply (F09-03) is an audit event referencing `export_id`, not a status.

A validated package is superseded only by an owner archive action, if such an action is added at all. A
newer validated package never supersedes it automatically (OD-17).

### 6.2 Derived freshness

Freshness changes after validation, so it is derived at read time and never written over the status.

`fresh = true` only when every field of F still equals current server state. Otherwise the read shows
`STALE` with the first differing code from C4. `fresh` is also false while a `REPLAY_MISMATCH` event exists
for the package; the read then shows `STALE` with `REPLAY_MISMATCH` (OD-15, section 8). A stale or incompatible candidate cannot be applied. [SRC:
PEX § Generated artifacts, apply paragraph] Because freshness is derived, a reverted change shows READY
again (OD-8). The apply audit event stores the F snapshot it checked.

When a replay mismatch exists, list `REPLAY_MISMATCH` first among the freshness codes (RC-8). If the
replay state is unreadable or not a boolean, the read is refused with `BI_REPLAY_STATE_UNAVAILABLE`.
That state is never labelled `REPLAY_MISMATCH`, and `BI_REPLAY_STATE_UNAVAILABLE` is not a C4
freshness code.

### 6.3 READY predicate (consumed by F09-02 and F09-03)

`READY = status EXPORT_VALIDATED AND fresh AND mode ONE_PINE AND fixture false AND requester owns the
Bot`.

[SRC basis: ROADMAP § Governing phase sequence, QL-4C row, "only validated fresh exports become
owner-visible/applyable" and "Multi-Pine results remain isolated until APP-3B"; ROADMAP § Data readiness,
fixture rule]

## 7. Owner visibility and actions

### 7.1 Shown to the owner

- READY packages: recommended values, before/after diff, slot map, IDs, UTC timestamp, train/validation/
  test results, trade and sample counts, drawdown, Win Rate, Profit Factor, cost assumptions, holdout
  window, limitations and validation status. [SRC: ROADMAP § Step 5 deliverables, item 2, applied to
  the review screen]
- Note on the READY label (OD-20): "best within the selected scope" on a READY package describes the
  scope of that one package only. A cross-run label belongs to a QR-4 selection record
  (docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md § 11) or to a QR-3 comparison record
  (docs/QR_3_FAIR_COMPARISON_CONTRACT.md § 6.6).
- Pine-only source inputs separate from the Bridge pair; the Bridge pair is shown in Bot Risk Manager
  Bridge Settings separately from hard Policy limits and Capital. [SRC: ROADMAP § Step 5 deliverables,
  item 2; § Identity and provenance]
- `NO_VALID_CANDIDATE`, insufficient and failed runs: outcome class, reason counts, `DIAGNOSTIC_ONLY`
  bundle. [SRC: QRL § Research record and storage; ROADMAP § Report and research behavior]
- `EXPORT_CANDIDATE`, `EXPORT_REFUSED` and STALE packages: `export_id`, status, UTC times and codes.
  No values, metrics or actionable download (QL-4C "validated fresh" rule).
- Research Library text stays "Qualified recommendations: none. No qualified winner." while no G8 PASS
  exists. CODE: `public/research-library.js` lines 53 and 231.

### 7.2 Never shown to the owner

- Any recommended value or best/top/winner label for a package that is not READY. [SRC: ROADMAP
  § Governing phase sequence, QL-4B row; CODE: `derive.js` "no view may name a winner"]
- Fixture packages as Best Inputs. [SRC: ROADMAP § Data readiness, fixture rule]
- Multi-Pine packages before APP-3B. [SRC: PEX § Export selection]
- Secrets, webhook URLs, broker credentials or machine locations. [SRC: QRL § Quant Data]
- Holdout performance of rejected candidates as a selection aid. [SRC basis: ROADMAP § Data readiness,
  "Never inspect holdout to choose policy, bounds, source revision or collection duration"]
- A universal best, exhaustive-search or global-optimum claim. [SRC: ROADMAP § Binding and optimization
  contract, "This does not promise a global optimum"; ADP, row "Search and candidate"]
- Export validity inferred from email status. [SRC: SC row F09-02 carryLimitations]

### 7.3 Owner actions and guards

Every action is authenticated, CSRF-protected under the existing API rules, owner-scoped, and writes an
audit event with `export_id`, `package_hash`, actor, UTC time and outcome. [SRC: PEX § Acceptance
criteria 13, "records an audit event"] Foreign or absent `export_id`: `NOT_FOUND` (404), the Research
Library rule; foreign Bot on a Bot-scoped write: `BOT_ACCESS_DENIED` (403), the PF-4 rule.

| Action | Feature | Allowed when | Guards at the moment of action | Codes |
| --- | --- | --- | --- | --- |
| View status | F09-01 | Any export of the owner | Owner scope | `NOT_FOUND` |
| Download package | F09-01 | READY only; diagnostic bundle for unsuccessful runs | Owner scope; checksums re-verified and secret scan re-run on stored bytes before streaming | `BI_NOT_READY`, `BI_CHECKSUM_MISMATCH`, `BI_SECRET_DETECTED` |
| Import Bridge pair to Bot Risk Manager | F09-03 | READY at commit | Confirm token; SERIALIZABLE; recheck owner, Bot, policy version, Bridge bounds, membership and F; refuse while session RUNNING or PAUSED; request values must equal package values; hard limits, capital, counters and guards unchanged; F snapshot in audit [SRC: PEX § Generated artifacts, apply paragraph; § Acceptance criteria 13; ROADMAP § Identity and provenance] | `CONFIRMATION_REQUIRED`, `RISK_POLICY_FROZEN`, `STALE_POLICY_STATE`, `BI_NOT_READY`, `BI_BRIDGE_PAIR_OUT_OF_BOUNDS`, `BI_APPLY_VALUE_MISMATCH`, `BI_RISK_RELAXATION` |
| Start new Bot with reviewed values | F09-03 | After import, as a separate action | New deployment version; deliberate alert replacement acknowledged; old exits preserved; PF-1 readiness passes [SRC: ROADMAP § Step 5 deliverables, alert paragraph; PEX § Acceptance criteria 9 and 13] | Defined in F09-03 |
| Email Report enqueue | F09-02 | READY | SMTP 550 remediation and confirmed owner receipt; idempotent by `export_id` [SRC: ROADMAP § Step 5 deliverables] | Defined in F09-02 |
| Replay, new-period backtest, optimize again | QR-4 | Explicit owner request | New `run_id` with `parent_run_id`; QS-1 admission; never changes the package [SRC: QRL § Explicit follow-up jobs] | QR-4 codes |

Import writes only the Bridge pair; source inputs stay in the Pine file the owner installs. [SRC: PEX
§ Generated artifacts, "Only the Bridge ATR/RR pair maps to Bridge Settings on Bot Risk Manager"]
Package creation, validation, download and email never mutate Bot policy or activate a Bot. [SRC:
ROADMAP § Identity and provenance] No action applies values or starts a Bot automatically, including
after email receipt; viewing a report never starts or changes a Bot. [SRC: QRL § Strategy Comparison
and Best Performance; PEX § Acceptance criteria 13] Starting the Bot ends the workflow; nothing schedules
another optimization or a post-export Paper cycle. [SRC: ROADMAP § Five-step user workflow, step 5]

## 8. Immutability and replay

- Research records and required evidence are immutable and cannot be removed as ordinary cache.
  [SRC: QRL § Research record and storage]
- Package files are content-addressed and written once in protected versioned storage. The export row,
  status events, replay events, compile records, evidence-clearance records, reproduction records and
  validation records are insert-only.
  Update and delete are refused by `BEFORE UPDATE OR DELETE` triggers with `ENABLE ALWAYS`,
  `SECURITY INVOKER` and pinned `search_path`, following the QR-1b freeze pattern. The SQLSTATE for
  this freeze is assigned by root in the project error namespace (OD-14).
- Any change to inputs, source, data, policy or rules needs a new research run and a new `export_id`
  with `parent_export_id`; the original is never overwritten. [SRC basis: QRL § Explicit follow-up
  jobs, "never overwrite the original"]
- Deterministic build: the builder is a pure function of the frozen run, the frozen library record and
  the bound source bytes. The same inputs give the same `package_hash`.
- Replay is a new owner-requested run; it compares with the prior result and reports mismatches. [SRC:
  QRL § Explicit follow-up jobs] A mismatch is recorded as a `REPLAY_MISMATCH` append-only replay event that
  references `export_id`. It is not a status event and does not change the validation record. A `REPLAY_MISMATCH` forces STALE for apply (OD-15).
- If archived data or the evaluator artifact is gone, exact reproduction is marked disabled; never use
  replacement candles. [SRC: QRL § Research record and storage]
- Imported bundles are untrusted data: validate schema, checksums, owner, source capability and artifact
  references; never execute an uploaded evaluator or accept credentials. [SRC: QRL § Explicit follow-up
  jobs] An imported bundle can never become `EXPORT_VALIDATED` or READY; its uploaded validation record is
  ignored; it may only be compared.
- Retention: validated packages and traces are retained while the run is retained. Refused packages keep
  only the manifest and the gate report, with `retention_tier` recorded; traces are not kept (OD-16).

## 9. Out of scope

- Live trading, any broker other than Spot Paper, Futures, short, margin. [SRC: AGENTS.md § Host and
  product safety; ADP § Spot-only]
- Markets other than BINANCE:BTCUSDT Spot 1m.
- Automatic optimizer loop, automatic rerun, guard reset, automatic Best Inputs apply, automatic email
  enqueue. [SRC: QRL § Explicit follow-up jobs; AGENTS.md § Host and product safety]
- Multi-Pine owner review, apply or start (APP-3B). [SRC: ROADMAP § Governing phase sequence, APP-3B row]
- Cost-model V2 packages before V2 parity. [SRC: ROADMAP PF-2 row]
- Capacity above the current 10K-bar profile. [SRC: ROADMAP § Report range and research capacity contract]
- Creating or inspecting TradingView alerts for the owner. [SRC: PEX § Generation rules, last bullet]
- Post-export Paper acceptance cycle. [SRC: ROADMAP § Governing phase sequence, QL-4C row]
- Email delivery mechanics (F09-02), apply/start implementation (F09-03), Portfolio Performance (QR-2),
  full comparison (QR-3), cross-run best-performance ranking (QR-4, F10-03).
- Any claim of profitability or a global optimum.
- DP1 native supervision and N1 work.

## 10. Decisions

The owner decided OD-1 to OD-19 on 2026-10-19 and chose the recommended option for every item. OD-20 is
a root decision of the same day. Each outcome is part of this contract.

| ID | Decision | Decided outcome (2026-10-19) |
| --- | --- | --- |
| OD-1 | Canonical file names | Use the set in 4.1. Update QRL and PEX to match. |
| OD-2 | Who runs the TradingView compile; how the record is trusted | Root coordinates the compile as a serial step. The record states the method and the operator role. The owner may run it. |
| OD-3 | Blocker model for a new contract version | Split model (4.4): capability blockers at admission, candidate evidence blockers cleared by append-only records. |
| OD-4 | Episode gate (5 per partition) before the first real package | Require the versioned gate first. |
| OD-5 | Owner sees `EXPORT_CANDIDATE` existence before validation | Status only. No values and no download. |
| OD-6 | Exit version pinned in the package | Pin the evaluated deployment version. Refuse an unsupported version. Align PEX and ROADMAP with this rule. |
| OD-7 | Validation attempt limit per `export_id` | 5 attempts, then `BI_ATTEMPTS_EXHAUSTED`. |
| OD-8 | READY derived on read or sticky STALE | Derived on read. |
| OD-9 | PF-2 R3 holdout registry as authority for QL-4C | Authoritative where present. |
| OD-10 | Holdout overlap with earlier searched train/validation windows (check in 5.0) | Enforce for the same owner and the same source. |
| OD-11 | Packages per run | At most one per `(owner_id, run_id)`. |
| OD-12 | Source field of `policy_version`/`policy_hash` | A new explicit field in the next research contract version. |
| OD-13 | Engine change after the run | Recorded limitation that blocks exact replay only. The validator records its own engine hash. |
| OD-14 | SQLSTATE for package freeze | Root owns the namespace and assigns the code at implementation. |
| OD-15 | Replay mismatch effect | Forces STALE for apply. |
| OD-16 | Retention of refused packages | Keep the manifest and the gate report only. |
| OD-17 | Supersession of validated packages | Owner archive action only, if added at all. |
| OD-18 | G7 source for a new engine version | Derived from the completion reason and the contract version. Never a free flag. |
| OD-19 | Windows used by QR-3 comparisons and QR-4 selections in Gate B0 (amendment decided 2026-10-19; QR-3 OD-C8, QR-4 OD-S8) | Yes. Such windows count as exposed data for the holdout-independence check in 5.0 item 5. Code `BI_HOLDOUT_EXPOSED_BY_SELECTION`. |
| OD-20 | Scope of the READY label "best within the selected scope" (root amendment decided 2026-10-19; QR-4 RO-1) | The label describes one package's own scope. Cross-run labels belong to the QR-4 selection record and the QR-3 comparison record. |

### 10.1 Root clarifications (2026-10-19)

The owner decisions OD-1 to OD-19 do not change. The root recorded the following clarifications on
2026-10-19, after the independent review of the first gate-module implementation and of the
multi-Pine contract (docs/MULTI_PINE_CONTRACT.md). Each clarification is also written in the named
section. RC-11 is the only exception to the OD-3 split model. It applies to the `EXPORT_INTERNAL`
path only and never makes a package qualifiable or READY.

| ID | Clarification | Sections changed | Decided by | Date |
| --- | --- | --- | --- | --- |
| RC-1 | A `MULTI_PINE` run without the internal path fails B0 with `BI_MULTI_PINE_INTERNAL_ONLY`. The admission code `MULTI_PINE_RESEARCH_NOT_SUPPORTED` keeps its research meaning. | 5.0 item 3 | Root | 2026-10-19 |
| RC-2 | An exposure record counts only when its `at_utc` is at or before the durable creation time of the run. The check filters by the same owner and the same market. A malformed entry is an unreadable register (`BI_EXPOSURE_REGISTER_UNAVAILABLE`). Neither OD-19 code is retryable. | 5.0 item 5 | Root | 2026-10-19 |
| RC-3 | Gate B0 runs only at build. A validation attempt runs C1 to C4 and Q and never re-runs B0. | 5.0, 6.1 | Root | 2026-10-19 |
| RC-4 | The trace check uses an evaluator-produced reproduction record (per trace file, the recomputed steps digest). An absent record or a digest difference gives `BI_RESULT_MISMATCH` (holdout trace: `HOLDOUT_MISMATCH`). Non-retryable. | 5.3 | Root | 2026-10-19 |
| RC-5 | A missing quant baseline gives `BI_QUANT_BASELINE_FAILED`, which is non-retryable. The retryable list stays closed. | 5.4 | Root | 2026-10-19 |
| RC-6 | Invalid attempt metadata refuses the call. It records no attempt and changes no status. The qualified winner stays null in F09-01 (cross-run ranking is QR-4). | 5.5 | Root | 2026-10-19 |
| RC-7 | A clearance record clears a native-parity blocker only when its evidence hash equals the digest of the native-parity evidence, and a repaint blocker only with the digest of the repaint evidence. | 4.4 | Root | 2026-10-19 |
| RC-8 | When a replay mismatch exists, `REPLAY_MISMATCH` is listed first among the freshness codes. An unreadable or non-boolean replay state refuses the read with `BI_REPLAY_STATE_UNAVAILABLE`. That state is never labelled `REPLAY_MISMATCH`, and the code is not a C4 freshness code. | 6.2 | Root | 2026-10-19 |
| RC-9 | The current `RULES` are a required input of the check. The `RULES_VERSION_DIFFERS` rule is unchanged. | 5 intro | Root | 2026-10-19 |
| RC-10 | The episode-gate test applies to a non-fixture package. | 4.3, 11.1 item 18 | Root | 2026-10-19 |
| RC-11 | On the `EXPORT_INTERNAL` path only, the multi-Pine research contract freezes the capability blocker `MULTI_PINE_REQUIRES_APP_3B` at admission, and the blocker neither refuses B0 nor fails G6 for export at C4. On the `EXPORT_INTERNAL` path only, G7 may fail only because the run's contract version is the multi-Pine research contract version, which is never listed among the versions whose G7 derives `PASS` (`OWNER_RECOMMENDATION_NOT_READY`). The completion reason must still be the one that derives G7 `PASS` (OD-18). Every other capability blocker still refuses. Source: docs/MULTI_PINE_CONTRACT.md, RD-MP-10. | 4.4, 5.0 items 1 and 2, 5.4, 11.1 item 20 | Root | 2026-10-19 |

### 10.2 Root decisions for the package builder (2026-10-20)

Root accepted the builder design below after an independent architecture review (options D1 to D12) and the review
rounds of the S1 renderer. The owner decisions OD-1 to OD-20 do not change.

| ID | Decision | Sections | Decided by | Date |
| --- | --- | --- | --- | --- |
| RC-12 | Builder slices: S1 pure renderer; S2 insert-only tables, guards and offline migrator; S3 trace reproduction module; S4 build worker; S5 owner read routes; S6 attempt service. Each slice has its own review and none is deployed without its own gate | 11 | Root | 2026-10-20 |
| RC-13 | One insert-only table per record kind (`bi_exports`, `bi_package_files`, `bi_blobs`, `bi_status_events`, `bi_attempts`, `bi_compile_records`, `bi_evidence_records`, `bi_clearances`, `bi_trace_reproductions`, `ql4c_validation`, marker `bi_package_schema`); `bi_replay_events` comes in a later slice | 3, 8 | Root | 2026-10-20 |
| RC-14 | Package bytes are stored in PostgreSQL as content-addressed blobs keyed by SHA-256, with the hash and size checked on insert and a 16 MiB cap per package; no filesystem store. A download re-verifies the bytes and re-runs the content scan | 3, 4 | Root | 2026-10-20 |
| RC-15 | Two enforcement layers: the runtime role has no UPDATE or DELETE on the builder tables (a new insert-only grant list), and ALWAYS triggers refuse every edit with SQLSTATE `QR002`. Insert guards check the parent run (terminal `SUCCEEDED`, same owner and Bot, fixture forced for the engineering scope), the status graph, the attempt cap and the validation record, and refuse with SQLSTATE `QR004`, mapped to `BI_TRANSITION_INVALID` (`QR003` is the exposure register SERIALIZABLE guard) | 6, 8 | Root | 2026-10-20 |
| RC-16 | A build runs as a worker job, never as a `quant_jobs` row. The order is: render, B0 on the rendered binding, render again if the limitation codes changed, then one SERIALIZABLE transaction that re-reads the lookups and the exposure register, re-runs B0 and inserts everything; a B0 failure writes no export row; a second build of the same run returns the existing export | 3.1, 5.0 | Root | 2026-10-20 |
| RC-17 | The trace reproduction record (RC-4) is produced at build by a module outside the run engine closure. Its digests come from recomputed results and are never copied from stored ones. If the run engine closure no longer equals the contract engine hash, the build is refused with `BI_ENGINE_HASH_MISMATCH` and no row | 5.3 | Root | 2026-10-20 |
| RC-18 | Fixture packages use the same tables; `fixture` is fixed at birth and forced true for the engineering scope; the customer read route omits fixture exports | 4.3, 11.3 | Root | 2026-10-20 |
| RC-19 | The migration is one optional extension with exact classification (ABSENT, INSTALLED, OTHER), an offline maintenance lock and a rollback that refuses while any builder row exists | 8 | Root | 2026-10-20 |
| RC-20 | Internal multi-Pine packages are not built until the gate module supports the member layout of docs/MULTI_PINE_CONTRACT.md 6.2; until then a build on a multi-Pine run refuses at B0 and writes no row | 5.0 item 3 | Root | 2026-10-20 |
| RC-21 | Owner reads use their own routes, read only, with a not-found answer for an absent or foreign export; a non-READY export shows only its id, status, UTC times and codes | 6.2, 6.3 | Root | 2026-10-20 |
| RC-22 | B0 reads the exposure register through one reader port (`src/postgres/exposure-register.js`); while the register is not installed the reader is unavailable and B0 fails closed with `BI_EXPOSURE_REGISTER_UNAVAILABLE` | 5.0 item 5 | Root | 2026-10-20 |
| RC-23 | `validation.html` is rendered at build from the build-time `validation.json`; live parity is shown at read time from evidence rows, so one run keeps one package and a retry keeps the same bytes | 4.1, 6.2 | Root | 2026-10-20 |
| RC-24 | One export per run (`UNIQUE(owner_id, run_id)`) with `parent_export_id` null until APP-3B revisits the key. `exit_version` comes from the evaluated deployment and is never defaulted | 3.1, 3.2 | Root | 2026-10-20 |
| RC-25 | One SQLSTATE plan for the insert-only extensions (exposure register, package builder, QR-3 comparison, multi-Pine member set): `QR001` research freeze; `QR002` an edit (UPDATE, DELETE or TRUNCATE); `QR003` a write outside a SERIALIZABLE transaction; `QR004` an insert precondition guard, which each writer maps by the guard that raised it (the builder maps it to `BI_TRANSITION_INVALID`). No other QR code is assigned. RC-15 is read with this row | 6, 8 | Root | 2026-10-20 |
| RC-26 | Every write to a builder table runs in a SERIALIZABLE transaction (otherwise `QR003`) and retries a serialization failure a bounded number of times; guards also serialize per export with a transaction advisory lock | 6.1, 8 | Root | 2026-10-20 |
| RC-27 | The database enforces the 6.1 graph: an `EXPORT_CANDIDATE` event after an attempt needs a failed attempt with retryable codes only and fewer than five attempts; `EXPORT_REFUSED` needs a non-retryable code, or the fifth retryable-only failure with `BI_ATTEMPTS_EXHAUSTED`; no attempt follows a non-retryable failure or a pass. An export commits only with its first status event and exactly the twelve package files. A clearance needs the evidence record of the matching kind and hash. A run contract without a scope is refused | 4.1, 4.4, 6.1 | Root | 2026-10-20 |
| RC-28 | A fixture export may hold a `ql4c_validation` row and reach `EXPORT_VALIDATED` (11.1 item 1); the READY and G8 readers count only non-fixture one-Pine exports (4.3, 6.3) | 4.3, 5.5, 6.3 | Root | 2026-10-20 |
| RC-29 | The install inspection of each new extension uses one shared module that checks ownership by membership (tables, functions and schema `public`), every forbidden privilege held through any role the runtime role can reach, membership in a superuser or bypass-RLS role, and CREATE on schema `public`. The exposure register and research freeze tools adopt it in a later hardening slice | 8 | Root | 2026-10-20 |
| RC-30 | Gate C2 accepts an approved edit only where one shared anchored locator finds the default literal of the bound input: the stored span starts at a line start with the bound variable, uses the bound input call kind and ends at its closing parenthesis, and the edited literal equals the matching `inputs.json` before value; otherwise `BI_SOURCE_LOGIC_CHANGED`. The renderer uses the same locator. The fifth retryable failure gives `EXPORT_REFUSED` with the attempt codes followed by `BI_ATTEMPTS_EXHAUSTED`, and no attempt carries `BI_ATTEMPTS_EXHAUSTED` | 4.2, 5.2, 6.1 | Root | 2026-10-20 |
| RC-31 | Every offline extension's classifier also requires each of its relations and functions to be owned by the owner of its own marker table (otherwise `OWNER_MISMATCH` and state OTHER). The QR-3 comparison, QR-4 selection and multi-Pine member-set extensions do this now; the exposure register, research freeze and builder tools, column collation checks and adoption of the shared inspection module come in one later cross-extension hardening slice | 8 | Root | 2026-10-20 |
| RC-32 | The hardening slice of RC-31 is implemented: every extension classifier compares column collation; the exposure register, research freeze and builder classifiers also require the owner of their marker or anchor table (an anchor that is not an ordinary table is OTHER); the exposure register and research freeze inspections use the shared runtime-role module. The research freeze tool must run as the owner of `quant_jobs`: any other user, a superuser included, is refused before any write | 8 | Root | 2026-10-20 |
| RC-33 | Every offline extension classifier with foreign keys (exposure register, builder, QR-3 comparison, QR-4 selection, multi-Pine member set, QR-2 capital model) also checks the internal foreign-key triggers of its named keys, through the shared `src/postgres/fk-trigger-inspection.js` (the capital model keeps its own copy of the same check): the triggers on both the referencing and the referenced table must match the PostgreSQL 16 fresh-install shape, be enabled and carry the key's deferrable flags. A disabled, missing or altered trigger, including one on a referenced base table such as `users` or `quant_jobs`, classifies the extension OTHER, so install, rollback and inspection refuse until it is repaired; insert-only evidence relies on the referenced row staying | 8 | Root | 2026-10-21 |

## 11. Test and evidence plan

Engineering acceptance and recommendation acceptance are separate. [SRC: ROADMAP § Governing phase
sequence, QL-3A row, "Record both statuses separately"] Engineering tests use labelled fixtures; a
fixture pass never counts as a real recommendation. No test-only override of any gate exists in the
gate module.

### 11.1 Pure gate module (Node, no database)

Build the evaluator as a pure module in the style of `derive.js`: no clock, no I/O, plain-value inputs.

1. Golden fixture (`fixture: true`): passes B0 and C1 to C4; reaches `EXPORT_VALIDATED` in the
   evaluator output; READY is false; it is never a G8 source.
2. One negation per check in 5.0 to 5.4: exactly the expected code; ordered gates after a hard failure
   are `NOT_REACHED`; independent checks within one gate still report.
3. Missing, null, empty or wrong-type input for each check: `FAIL` with a missing or unknown code, never
   `PASS` and never an exception.
4. Thresholds come from the fixture's own `rules`: a variant whose `rules` differ from current `RULES`
   is judged by its own rules and carries `RULES_VERSION_DIFFERS`.
5. Gate order and codes do not depend on result values.
6. `binding_hash` and `package_hash` are stable across key order and whitespace; any single byte change
   in any file changes `package_hash`; deterministic rebuild gives the same hash.
7. Content scan: a webhook URL with a token, a bearer pattern, a Windows and a POSIX absolute path,
   each refused.
8. Logic diff: one byte changed outside approved defaults gives `BI_SOURCE_LOGIC_CHANGED`.
9. Slots: 9 source slots, duplicate slots, nonnumeric, NaN or infinity give `BI_SLOT_LIMIT` or
   `BI_INPUT_OUT_OF_DOMAIN`.
10. Absent metric stays absent; a zero for a missing metric gives `BI_METRIC_FABRICATED`.
11. Holdout: overlap with an earlier holdout gives `HOLDOUT_WINDOW_REUSED`; overlap with an earlier
    searched train/validation window gives `BI_HOLDOUT_OVERLAPS_SEARCHED_DATA`; a holdout before a
    registered boundary gives `BI_HOLDOUT_BEFORE_REGISTERED_BOUNDARY`.
12. Blockers: a capability blocker refuses B0; candidate blockers allow B0 and fail C4 until clearance
    records exist.
13. Current real contract shape (scope `SPT_CUSTOM_ENGINEERING_ONLY`, three blockers,
    `owner_recommendation_ready:false`): B0 fails; `QUALIFIED_TOTAL` stays 0.
14. Multi-Pine fixture passing C1 to C4 ends `EXPORT_INTERNAL`, never READY.
15. Every emitted code matches `^[A-Z][A-Z0-9_]{1,63}$`.
16. `NO_VALID_CANDIDATE` run: no package; diagnostic bundle labelled `DIAGNOSTIC_ONLY` without a
    recommendation block.
17. G7 is derived from the completion reason and the contract version (OD-18). No input flag, field or
    override sets G7; a supplied flag is ignored, and G7 is computed from the derivation only.
18. Episode gate (OD-4): while the versioned episode gate is unavailable, a non-fixture package gives
    `BI_EPISODE_GATE_UNAVAILABLE`, never `PASS`. The count-failure code is defined with that gate version.
    The test does not apply to a fixture package (RC-10).
19. Comparison exposure (OD-19): a holdout window that overlaps a window used by an earlier QR-3 comparison
    or QR-4 selection of the same owner and the same market gives `BI_HOLDOUT_EXPOSED_BY_SELECTION`; the
    same window under another market or another owner does not. An empty register passes; an absent or
    unreadable register gives `BI_EXPOSURE_REGISTER_UNAVAILABLE`.
20. Internal-path blocker exception (RC-11): a `MULTI_PINE` internal fixture whose only capability
    blocker is `MULTI_PINE_REQUIRES_APP_3B` passes B0 and the C4 blocker check and ends
    `EXPORT_INTERNAL`, never READY. The same blocker on a run without the internal path gives
    `BI_MULTI_PINE_INTERNAL_ONLY`. Any other capability blocker on the internal path gives
    `BI_CAPABILITY_BLOCKER_PRESENT`. On the internal path, a G7 failure with any other completion
    reason or any other contract version refuses B0 with `OWNER_RECOMMENDATION_NOT_READY`. The
    multi-Pine research contract version is never listed among the versions whose G7 derives `PASS`
    before APP-3B.

### 11.2 Isolated PostgreSQL (throwaway cluster, one file per process)

1. One export per `(owner_id, run_id)`; a concurrent double build gives one row and one idempotent reply.
2. Update and delete of export, status-event, compile, clearance and validation rows are refused with
   the chosen SQLSTATE, including for the application role (`ENABLE ALWAYS`).
3. Every illegal transition is refused with `BI_TRANSITION_INVALID`; the attempt limit ends in
   `EXPORT_REFUSED`.
4. Race: a policy save commits between validation and import; import refuses with `STALE_POLICY_STATE`
   or `BI_NOT_READY`.
5. Owner isolation: owner B reading, downloading, validating or importing owner A's `export_id` gets
   `NOT_FOUND` and no values; no audit row is written for owner A's Bot.
6. Library G8 is PASS only after a non-fixture one-Pine PASS `ql4c_validation` row exists; that row
   cannot be deleted.
7. A package cannot be built from a non-terminal run; terminal `quant_jobs` rows still refuse change
   under QR001.
8. Attempt limit (OD-7): attempts 1 to 4 that fail with retryable codes only allow a retry. The fifth
   retryable failure gives `EXPORT_REFUSED` with `BI_ATTEMPTS_EXHAUSTED`, and no sixth attempt is accepted.
9. Supersession (OD-17): a newer validated package never changes the status of an older validated package;
   only an owner archive action, if added, may do so.

### 11.3 API and UI (Node, local, no browser)

1. `EXPORT_CANDIDATE`, `EXPORT_REFUSED` and STALE responses carry status and codes only; no values in
   JSON or HTML; no download control.
2. Download of a non-READY package returns `BI_NOT_READY`.
3. STALE appears after a source version change; import refused.
4. Import on READY with Bot RUNNING gives `RISK_POLICY_FROZEN`; with request values different from the
   package gives `BI_APPLY_VALUE_MISMATCH`; a valid import changes only the Bridge pair, and hard limits,
   capital, counters and guards are byte-identical before and after.
5. No F09-01 route enqueues an outbox row (`notification_outbox` count unchanged) or changes Bot policy
   or session state (hashes unchanged).
6. Library view with no validation record shows "Qualified recommendations: none. No qualified winner."
   and no best or winner label.
7. READY row uses "best within the selected scope" and shows the Bridge pair separate from hard limits.
8. Fixture packages never render in the customer view.
9. EN and TH strings exist for every new status and refusal label. [SRC: PEX § Acceptance criteria 1]
10. Replay mismatch (OD-15): a `REPLAY_MISMATCH` event for a validated package makes the read show `STALE`
    with `REPLAY_MISMATCH` and refuses import. The event references `export_id`, and no status event is
    written. Reverting freshness changes does not clear it.

### 11.4 Staging evidence (F09-01 target)

1. Engineering: deploy the gate code to staging only under a recorded owner GO and the operations rules;
   run the labelled fixture path; show `fixture: true`, READY false and zero owner-facing
   recommendations. This is engineering evidence only.
2. Recommendation: needs one real run that passes B0 under a contract version without capability
   blockers, a root-coordinated compile record, chosen-settings parity and repaint evidence, and an
   independent holdout. None exists today (section 2). If the run ends `NO_VALID_CANDIDATE`, that is a
   valid outcome and F09-01 recommendation acceptance stays open.
3. Evidence files record commit, engine hash, package hash, gate results, refusal codes and UTC stamps;
   no secrets or machine paths; no raw logs.

## 12. Known risks

- R1: G6 and G7 cannot pass for any run under either current contract version and the current engine.
  Decisions OD-3, OD-12 and OD-18 and a new contract version are needed before F09-01 can reach a real
  pass, even with a good result.
- R2: File-name and exit-version drift between QRL, PEX and ROADMAP can split the package contract.
  Decisions OD-1 and OD-6 remove the drift in QRL and PEX; root aligned the matching ROADMAP lines and the
  ADP "Bridge protection parity" row on 2026-10-19.
- R3: Compile evidence depends on a TradingView step that only root coordinates. It is a manual trust
  point (OD-2). Without it every real package stops at `BI_COMPILE_EVIDENCE_MISSING`.
- R4: Validation retries could become an informal tuning loop. One package per run, missing-evidence-only
  retry codes, same bytes and an attempt limit reduce this risk.
- R5: Holdout independence today checks only holdout-against-holdout. The earlier runs' holdouts are
  recorded as unopened, but their train and validation windows were searched. A future holdout over
  those windows would not be independent (OD-10).
- R6: Multi-Pine runs are refused at admission today, so `EXPORT_INTERNAL` paths can only be tested with
  fixtures until research supports multi-Pine.
- R7: The secret scan is pattern-based and can miss an unusual format; the builder must never read
  credential sources.
