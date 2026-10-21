# Multi-Pine contracts and evaluator/package compatibility

Status: owner decisions OD-MP-1 to OD-MP-11 recorded 2026-10-19. Root decisions RD-MP-4, RD-MP-5,
RD-MP-7, RD-MP-8, RD-MP-9 and RD-MP-10 recorded the same day; RD-MP-1, RD-MP-2, RD-MP-3 and RD-MP-6
were decided the same day (RD-MP-1 to RD-MP-11 decided; RD-MP-12 to RD-MP-22 decided 2026-10-20; RC-MP-1 clarifies 3.3; the member-set tables extension is root-accepted as local engineering evidence and not installed on staging). Root accepted the
other rules on 2026-10-19 after independent review. The S1 pure member-set builder (src/multi-pine) is root-accepted as local engineering
evidence and not wired; no other implementation has started; this contract is not a GO, and nothing here
activates a multi-Pine Bot or exposes multi-Pine results to the owner before APP-3B.

Feature: PM-1 F11-01 "Multi-Pine contracts and evaluator/package compatibility". Target: isolated
accepted fixture. [SRC: INV row F11-01]

## 0. Reading key

- `[SRC: path § section]` marks a sourced rule. `CODE:` marks a fact read from committed code; code
  facts teach interfaces and are not acceptance evidence. A rule without a marker is a rule of this
  contract.
- `OD-MP-n` is an owner decision. `RD-MP-n` is a root decision. Both are in sections 13 and 14.
  `OD-n` without prefix is a decided PKG decision.
- Short names: ROADMAP = `docs/ROADMAP.md`; ADP = `docs/PINE_BRIDGE_ADAPTER_API.md`; PEX =
  `docs/PINE_EXPORT.md`; PKG = `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md`; QR2 =
  `docs/QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md`; QR3 = `docs/QR_3_FAIR_COMPARISON_CONTRACT.md`; QR4 =
  `docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md`; INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`;
  SC = `docs/progress/PM1_SCORECARD_S1_2026-10-15.json`; OWN = `docs/OWNER_DECISIONS_2026-10-13.md`.

Scope guard for every rule [SRC: AGENTS.md § Host and product safety]: Spot/Paper only,
BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, no Live, no automatic optimizer loop, no guard reset, no
automatic Best Inputs apply, independent holdout gates, immutable research evidence.

## 1. Purpose and acceptance target

F11-01 acceptance: "Multiple registered sources use the declared shared Bridge pair and source-bound
evaluation/package rules without owner-facing activation." [SRC: INV row F11-01]

Scorecard: D UNKNOWN, I 0, V 0, T 0. D rationale: "Shared Bridge pair and source-membership rules
specified; complete evaluator/package fixture contract review not found." Carry limitation:
"Membership constraints and basic owner isolation alone do not complete multi-Pine evaluator
support." [SRC: SC row F11-01]

F11-02 (APP-3B multi-Pine Paper isolation and canary, target staging) owns shared-symbol allocations
under live load, reservations, workload, recovery and the canary. [SRC: INV row F11-02; ROADMAP
§ Governing phase sequence, APP-3B row] F11-01 claims no F11-02 outcome.

Phase placement: "Before APP-3B, multiple-Pine Quant/export paths may generate internal, isolated
evidence but cannot be released for owner apply/new Bot start." [SRC: ROADMAP § Governing phase
sequence] F11-01 is that internal, isolated evidence path.

## 2. Current state

1. Rule: Pine count is the number of registered script identities connected to the Bot, resolved on
   the server. Adding, removing or changing a connected script invalidates run/export evidence. A
   single Bot-level Bridge pair applies consistently to every member deployment. Until APP-3B passes,
   multi-Pine evaluation and package checks run only in an isolated fixture; owner-facing apply and
   new Bot start stay disabled. [SRC: ROADMAP § Binding and optimization contract]
2. Rule: multi-Pine search freezes every source input, including previously mapped slots, and
   optimizes exactly 2 shared Bot-level Bridge values; before APP-3B these runs/packages remain
   internal fixture evidence. [SRC: ADP § Numeric parameter selection, "Multiple Pine scripts / one
   Bot"]
3. Rule: a multi-Pine Bot package may contain one deployment per member script, all tied to the same
   shared Bridge pair and `export_id`; comparison packages must not execute one logical event twice on
   a Bot. [SRC: PEX § Export selection]
4. Rule: a multi-Pine run stores all participating `pine_import_id`/`source_version` pairs. [SRC:
   ROADMAP § Identity and provenance]
5. CODE: `pine_memberships` has primary key `pine_import_id` with `owner_id`, `bot_id`,
   `source_version`, `connected` (`src/postgres/pine-bridge-schema.sql`). One source belongs to at
   most one Bot.
6. CODE: `membershipSnapshot` returns connected members ordered by `pine_import_id` with
   `source_version`, `source_hash`, `analysis` (`src/postgres/pine-bridge-registry.js`).
7. CODE: `pine_deployments` binds one `pine_import_id`/`source_version`; its `snapshot` holds the full
   membership list and that deployment's own `selection.bridge` pair. No Bot-level pair record exists.
   Index `pine_one_entry_route` allows one READY route per `(bot_id, pine_import_id)`.
8. CODE: a membership change or new analysis calls `invalidateEntries` (every READY deployment of the
   Bot becomes `EXIT_ONLY`).
9. CODE: three refusals hold multi-Pine back:
   - research enqueue: `MULTI_PINE_RESEARCH_NOT_SUPPORTED` (409) when
     `snapshot.membership.length !== 1` (`src/postgres/quant-research.js`, after
     `RESEARCH_DEPLOYMENT_NOT_READY` for a non-READY deployment);
   - activation: `MULTI_PINE_REQUIRES_APP_3B` (409) in `activateDeployment`
     (`src/postgres/pine-bridge-readiness.js`);
   - BUY execution: `MULTI_PINE_REQUIRES_APP_3B` in `prepareBridgeExecution`
     (`src/postgres/pine-bridge-execution.js`).
10. CODE: research enqueue requires one `deployment_id` in state `READY`; activation refuses a
    multi-Pine Bot, so the current enqueue path cannot admit a multi-Pine run even without the
    membership check.
11. CODE: `activateDeployment` on success sets every other READY deployment of the Bot to
    `EXIT_ONLY`, whatever its member. This is one-Pine behaviour; APP-3B must scope it to the same
    `pine_import_id`. F11-01 does not change it.
12. CODE: `validateEvent` refuses `DEPLOYMENT_MISMATCH` (identity fields differ from the stored
    deployment) and `INVALID_ENTRY_REFERENCE` (`entry_ref` not `^<deployment_id>:\d+:0$`)
    (`src/pine-bridge/contract.js`). EXIT resolves only entries of the same deployment
    (`TARGET_NOT_OPEN`).
13. CODE: the evaluator replays one deployment: `BridgeReplay(deployment_id, multiplier, rr, model)`
    and `paper_replay` hold one entry list and one ledger
    (`quant_lab/src/robot_quant/bridge_replay.py`, `bridge_paper.py`). `ql3a.py` states no
    multiple-Pine membership is supported. No combined replay exists.
14. CODE: the research contract carries one `deployment_id`; `quant_jobs.deployment_id` is
    `NOT NULL`; the V2 validator requires an exact key list; terminal runs are immutable (SQLSTATE
    `QR001`).
15. Rule (PKG): B0 admits `MULTI_PINE` only on the internal path; a multi-Pine package passing C1 to
    C4 ends `EXPORT_INTERNAL`, terminal, never READY; G8 counts only non-fixture `ONE_PINE`
    validation; multi-Pine packages are never shown to the owner before APP-3B; an APP-3B release
    needs a new `export_id` with `parent_export_id`. [SRC: PKG § 5.0 item 3; § 5.5; § 6.1; § 6.3;
    § 7.2]
16. Rule: per-Bot reports plus a per-fill deployment tag; no per-strategy returns before APP-3B.
    [SRC: OWN § O14; QR2 attribution rule]
17. Rule: QR-3 and QR-4 exclude multi-Pine participants before APP-3B and exclude fixtures from
    customer results. [SRC: QR3 § Out of scope; QR4 E2/E6, `QR4_MULTI_PINE_PARTICIPANT`,
    `QR4_FIXTURE_PARTICIPANT`]

Consequence: F11-01 needs (a) a frozen member-set identity binding several deployments to one shared
pair, (b) a combined source-bound evaluator over one shared Paper ledger, (c) an internal-only
admission path that leaves every existing owner route and refusal unchanged, and (d) multi-Pine
package binding that ends `EXPORT_INTERNAL`.

## 3. Membership and identity

### 3.1 Member

- A member is one connected `pine_import_id` at one `source_version`, resolved on the server from
  `pine_memberships` and `pine_source_revisions`. A client list or mode is never authority. [SRC:
  ROADMAP § Binding and optimization contract]
- Member record, canonical JSON: `{ordinal, pine_import_id, source_version, source_hash,
  effective_inputs_hash, deployment_id, deployment_snapshot_hash, exit_version, evidence_hash}`.
- `ordinal` is a dense integer 1..N assigned at freeze in ascending `pine_import_id` order (the
  `membershipSnapshot` order). It carries no meaning beyond a stable server order (OD-MP-2).

### 3.2 Mode and count

- `pine_count` = number of members; `mode` = `ONE_PINE` for 1, `MULTI_PINE` for 2 or more;
  server-derived only. [SRC: PKG § 3.2, row `mode, pine_count, membership list`]
- `MULTI_PINE` member count is 2 to `MP_MAX_MEMBERS`, which is 3 (OD-MP-1). Zero members:
  `MP_MEMBERSHIP_EMPTY`. Above the limit: `MP_MEMBER_COUNT_EXCEEDED`. These refusals fire only at
  member-set freeze on the internal path; connect, analyze and generate routes are not changed.
- A single member is not a multi-Pine set: the internal builder refuses it with `MP_NOT_MULTI_PINE`.
- Two members with equal `(source_hash, effective_inputs_hash)` refuse with
  `MP_MEMBER_DUPLICATE_LOGIC` at freeze only (OD-MP-3). Basis: "must not execute one logical event
  twice on a Bot". [SRC: PEX § Export selection]

### 3.3 Member set

- Identity `member_set_id` (random server UUID, never derived from a hash) for one frozen multi-Pine
  membership of one Bot:

  ```text
  member_set {
    version,              -- `mp-member-set-v1`
    member_set_id, owner_id, bot_id, mode: MULTI_PINE, pine_count,
    members: [member records, 3.1, ascending ordinal],
    content_digest,       -- RC-MP-1: canonical digest of members, pair and order, without member_set_id
    membership_hash,      -- SHA-256 of canonical [{pine_import_id, source_version, source_hash}] in ordinal order
    bridge_pair: {atr_multiplier, rr},   -- section 4
    bridge_atr_period: 14,
    market: {broker: binance-global, symbol: BTCUSDT, timeframe: "1"},
    exit_version, execution_model_hash, policy_hash, funding_cutoff, capital_basis_hash,
    same_bar_order,       -- `exit-first-ordinal-v1` (5.5)
    fixture: true,        -- set at birth, never cleared; F11-01 creates no non-fixture set
    set_hash,             -- SHA-256 of canonical record without set_hash and created_at
    created_at            -- ISO-8601 UTC, server clock
  }
  ```

- RC-MP-1 (root clarification, 2026-10-19): the record also carries `content_digest`, the canonical digest of members, shared pair and order WITHOUT `member_set_id`. Freeze-or-load returns the existing set of the same Bot when `content_digest` is equal (idempotent re-freeze); it never creates a second set for equal content.
- `content_digest` covers exactly these keys, as coded: `version`, `owner_id`, `bot_id`, `mode`, `pine_count`, `members`, `membership_hash`, `bridge_pair`, `bridge_atr_period`, `market`, `exit_version`, `execution_model_hash`, `policy_hash`, `funding_cutoff`, `capital_basis_hash`, `same_bar_order`, `fixture`. That is every content field: members, shared pair, same_bar_order, version, policy, capital, funding, model, owner and Bot. It never covers `member_set_id` or `created_at` (nor `set_hash`).
- Canonicalisation and hashing reuse `canonical` and `hash` from `src/pine-bridge/source.js`, as PKG
  § 3.1 does.
- The member set is insert-only. Any membership, source, effective-input, deployment snapshot, pair,
  policy, capital or funding change makes it stale at read (9.2); the row is never edited. This is
  consistent with "Changes to material inputs mark evidence stale". [SRC: ROADMAP § Identity and
  provenance]
- A hash is never authorization; every read checks owner and Bot. [SRC: ROADMAP § Identity and
  provenance]

### 3.4 Per-member deployment

- Each member needs its own `deployment_id`. [SRC: PEX § Export selection] One deployment binds
  exactly one execution symbol and timeframe. [SRC: ADP § Separate capabilities, "Bridge execution
  per deployment"]
- The caller names exactly one `deployment_id` per member (M3). The builder validates that it exists, is `DRAFT` and has the same owner, Bot, `pine_import_id` and `source_version` as the member. Other `DRAFT` rows of the same member are allowed and ignored. A deployment in any state other than `DRAFT` is refused. Exactly one deployment per member in a set. Missing: `MP_MEMBER_DEPLOYMENT_MISSING`. Two named for
  one member: `MP_MEMBER_DEPLOYMENT_AMBIGUOUS`.
- Every member deployment has the same `market`; otherwise `MP_MARKET_MIXED`. Under the M4 restriction this cannot fire in F11-01; the check stays as defence in depth.
- Market restriction (M4): only `binance-global`, `BTCUSDT`, timeframe `1`. Any other market is `MP_INPUT_INVALID` with field `market.unsupported`.
- Member deployments stay `DRAFT`; F11-01 never activates them (OD-MP-7). `READY`, `EXIT_ONLY` or `REVOKED`
  members (any state other than `DRAFT`) refuse `MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE`. Each needs a `pine_bridge_evidence` row bound to
  its own `snapshot_hash` and `artifact_hash`, validated by the existing `validateEvidence`;
  otherwise `MP_MEMBER_EVIDENCE_MISSING`.
- Each member deployment's `snapshot.membership` equals the member-set membership; otherwise
  `MP_MEMBER_SET_STALE` (same logic as `freshSnapshot` `STALE_MEMBERSHIP`); the snapshot membership is compared unsorted.
- `bot_state` freshness (M1): `buildMemberSet` and `memberSetFreshness` take a required input `bot_state {policy_hash, capital_basis_hash, funding_cutoff}`, read on the server like `freshSnapshot`: `policy_hash` = hash(canonical(locked or default policy)); `capital_basis_hash` = hash(canonical(paper accounts mapped to {broker, configuredEquity, configuredBalance}, in store order)); `funding_cutoff` = COALESCE(max(id), 0) of the Bot's Paper funding rows. A difference from the frozen set is `MP_MEMBER_SET_STALE` with the field named. Missing `bot_state` is `MP_INPUT_INVALID`.
- An evidence row whose `deployment_id` is not among the deployments is `MP_INPUT_INVALID` with field `evidence[i].deployment_id` (M6).

## 4. Shared Bridge pair

- One Bot-level Bridge ATR/RR pair applies to every member deployment. [SRC: ROADMAP § Binding and
  optimization contract] Bridge ATR period stays 14 as versioned configuration, not a dimension.
  [SRC: ADP § Numeric parameter selection]
- Bridge values stay independent from source inputs and hard policy; similar variables in user Pine
  are never rebound. [SRC: ROADMAP § Risk calculation and rejection reporting, "Bridge ATR/RR remain
  independent"]
- Storage for F11-01 (OD-MP-6): the insert-only member set holds `bridge_pair` once, so the declared
  pair has an identity (`set_hash`) that runs and packages reference. Each member deployment's
  `snapshot.selection.bridge` must equal it exactly (decimal-string compare after canonicalisation);
  otherwise `MP_BRIDGE_PAIR_DIVERGENT`. No change to `pine_deployments`, to the generate route or to
  any owner write surface. A Bot-level Bridge Settings record (ROADMAP § Identity and provenance,
  "Bot Risk Manager page displays Bridge Settings") is decided with APP-3B and F09-03 apply.
- `MULTI_PINE` search has exactly 2 dimensions, `atr_multiplier` and `rr`; every source input is
  frozen, including slots mapped for one-Pine use. [SRC: ADP § Numeric parameter selection]
- Non-empty `parameter_slots` refuses `MP_SOURCE_SLOTS_FORBIDDEN`. Bridge domains reuse the
  `lockInputs` rules for the two Bridge keys (CODE: `src/quant-research/contract.js`).
- Invariant: each candidate pair is applied to every member replay at once; a per-member candidate
  does not exist (T-P3).

## 5. Evaluation

### 5.1 Admission (internal path only)

Sequence inside the internal fixture service (section 10), never on an HTTP route:

1. `fixture = true` required, else `MP_FIXTURE_ONLY`.
2. Resolve membership on the server; freeze or load the member set (3.3); every 3.x and 4 check
   passes.
3. For each member in ordinal order, run the existing one-Pine admission checks unchanged, against
   that member's deployment: owner and Bot (`NOT_FOUND`), `SNAPSHOT_HASH_MISMATCH`,
   `BRIDGE_EXECUTION_EVIDENCE_REQUIRED`, `RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED`,
   `UNSUPPORTED_CUSTOM_MARKET`, `UNSUPPORTED_SOURCE_HASH`, `CUSTOM_EFFECTIVE_INPUT_REVIEW_REQUIRED`,
   `UNSUPPORTED_CUSTOM_SETTING`, `UNSUPPORTED_SIGNAL_MAPPING`, `SPOT_PAPER_POLICY_REQUIRED`, `STALE_EVIDENCE`, except the READY-state check, which is
   replaced by the DRAFT rule of 3.4. The first failing member ends admission; the diagnostic names
   its `ordinal` and `pine_import_id`.
4. Each member needs `quant_capability` for its `(source_hash, effective_inputs_hash)`; one
   unsupported member refuses the whole set with `MP_MEMBER_QUANT_UNSUPPORTED`. The set never runs
   with a member dropped. [SRC basis: ROADMAP § Binding and optimization contract, Pine count
   invalidation]
5. Dataset rules unchanged: verified bars, 1m alignment, at most 10,000 bars, at least 2,000 compared
   bars after warm-up, capital present. [SRC: ADP, row "Warm-up/sample floor"; CODE:
   `quant-research.js`]
6. All members share one `exit_version` (`MP_EXIT_VERSION_MIXED`) and one execution model
   (`MP_EXECUTION_MODEL_MIXED`). Unsupported exit versions refuse as in PKG
   (`BI_EXIT_VERSION_UNSUPPORTED`, OD-6).

### 5.2 Per-source evaluation (source-bound)

- Each member's native BUY and exit booleans come from that member's own source-bound evaluator with
  its frozen effective inputs. The evaluator must replay the actual connected source semantics or a
  proven equivalent; unsupported constructs are blockers. [SRC: ROADMAP § Source, exit and validation
  rules] A Node stub injected through the worker `evaluate` seam may drive mechanics-only tests, but
  it never counts as the source-bound evaluator for acceptance (11.4, RD-MP-4).
- Per-member Quant evidence (dataset alignment, warm-up/sample floor, native signal parity, repaint)
  is bound to that member's own hashes and dataset. [SRC: ADP § Quantitative parity and readiness
  gates] Evidence of member A never satisfies member B (`MP_MEMBER_PARITY_SCOPE_MISMATCH`).
- Combined warm-up = maximum of member warm-ups, from `max(1006, 5 * L)` per source, the one-Pine code floor, which is stricter
  than the `max(500, 5 * L)` of the source row (RD-MP-20). [SRC: ADP, row "Warm-up/sample floor"; CODE: `quant-research.js`]
- Invariant: one member's inputs never change another member's signals (case F24).
- A member with zero native signals in the dataset is a blocker `MP_MEMBER_NO_SIGNALS` (OD-MP-10),
  because the shared pair would be optimized against a strict subset of the membership.

### 5.3 Per-member Bridge replay

- Each member gets its own Bridge replay keyed by its `deployment_id`, with the shared pair. CODE
  basis: `BridgeReplay(deployment_id, multiplier, rr, model)`.
- Exit priority SL, then TP, then native; both-touched chooses SL; levels frozen from the confirmed
  entry close and ATR(14); exit version bound to the deployment. Native exit applies only to entries
  of the same source deployment. [SRC: ROADMAP § Source, exit and validation rules; ADP § Exit
  semantics]
- BUY suppression is per deployment: "Suppress that deployment's new BUY on an exit-intent bar."
  [SRC: ROADMAP § Source, exit and validation rules] "Other scripts remain subject to their own
  signals and shared Bot limits." [SRC: ADP § Exit semantics] An EXIT of member B never suppresses a
  BUY of member A.

### 5.4 Combined Paper ledger (one Bot account)

- Multi-Pine research evaluates combined fixed signals under shared Bot limits; previews need
  combined signals against shared cash/reservations. [SRC: PEX § Generated artifacts; ROADMAP
  § Risk calculation and rejection reporting]
- `combined_paper_replay(members, bars, shared_pair, model, policy, capital)`:
  - One cash balance, one reservation set, one daily-stats map and one loss-streak counter for the
    Bot.
  - One allocation map keyed by `entry_ref` (unique per deployment, CODE fact 12), each allocation
    storing its owning `deployment_id`.
  - Bot-level limits count intents of all members together. Counter semantics stay as defined: daily
    trade counts include accepted BUY and EXIT; entry guards never block a valid reduce-only exit;
    unique-symbol capacity differs from entry-allocation capacity. [SRC: ROADMAP § Risk calculation
    and rejection reporting]
  - Accept, cap and reject use the existing Node policy semantics as reproduced by `node_policy`
    (CODE: `bridge_paper.py`). Rejected BUYs create no allocation; capped BUYs keep only accepted
    quantity. [SRC: ROADMAP § Source, exit and validation rules]
  - A BUY refused by a shared limit is an expected policy skip attributed to its member, not an
    isolation defect. No cash top-up, re-arm or guard reset may manufacture coverage. [SRC: ROADMAP
    § Risk calculation and rejection reporting]
- The one-member case of `combined_paper_replay` reproduces `paper_replay` byte for byte on canonical
  output (F16, T-P1).

### 5.5 Same-bar order

Rule `exit-first-ordinal-v1` (OD-MP-2):

1. All EXIT intents of all members first, in ascending `ordinal`, then each member's existing exit
   order (CODE: entry traversal in `BridgeReplay.step`).
2. Then BUY intents in ascending `ordinal`.

Reason: reduce-only exits release cash and must never be blocked by entry guards. [SRC: ROADMAP
§ Risk calculation and rejection reporting] The run contract records `same_bar_order`; a missing or
unsupported version refuses `MP_EVENT_ORDER_UNDEFINED`. Limitation: live intake orders by arrival;
live-order parity is an APP-3B question (F11-02). Ordinal order is deterministic but can favour one
member under tight cash; recording it makes the bias visible, not fair.

### 5.6 Combined Quant baseline

- The combined replay needs its own baseline against the Node/Paper decision path: accept/cap/reject
  match 100%, allocation target mismatches 0, quantity difference 0 venue steps, per-entry and final
  cash within 1 minor unit. [SRC: ADP § Quantitative parity, row "Quant baseline"] The comparison
  includes cross-member contention cases (11.3). Failure: `MP_COMBINED_BASELINE_FAILED`
  (non-retryable).
- Node oracle: the fixture harness feeds the same ordered intents through the pure Node decision
  functions in an isolated PostgreSQL cluster. `prepareBridgeExecution` is never edited or bypassed in
  product code.

### 5.7 Metrics and attribution

- Reported metrics are per Bot. Per-fill tags carry `deployment_id`. No per-strategy returns before
  APP-3B. [SRC: OWN § O14; QR2 attribution rule]
- Per-member funnel counts (native signals, intents, accepted, capped, rejected by reason class,
  exits by reason, suppressed BUYs) are internal diagnostics only (OD-MP-5). They are counts, never
  returns, P&L or ranking, and they sum to the Bot-level counts.

### 5.8 Research run contract (multi-Pine)

- New version `ql3a-research-job-multi-v1` (and a matching foundation-executor version if that
  executor is used), built by a pure builder. One-Pine versions are not modified (exact-key
  validator, immutable terminal runs, CODE fact 14). The final names are frozen by RD-MP-1
  (section 14).
- Fields: every Bot-level field of the one-Pine contract (owner, Bot, policy hash, capital, funding
  cutoff, model, rules, engine hash, dataset, split, budget, seed), plus `mode`, `pine_count`,
  `member_set_id`, `set_hash`, `membership_hash`, `members` (3.1), `bridge_domains`,
  `same_bar_order`, `fixture: true`. Top-level `deployment_id`, `pine_import_id` and `source_version`
  are absent; they would privilege one member.
- `acceptance_blockers` carry the candidate evidence blockers (PKG § 4.4) plus
  `MULTI_PINE_REQUIRES_APP_3B`. A multi run never reaches `owner_recommendation_ready: true` before
  APP-3B, even if every other gate passes, because the multi-Pine contract version is never listed
  among the versions whose G7 derives `PASS` (PKG § 5.5, OD-18). [SRC basis: ROADMAP § Governing
  phase sequence, APP-3B row] `MULTI_PINE_REQUIRES_APP_3B` is a capability blocker that B0 and G6 for
  export tolerate only on the `EXPORT_INTERNAL` path (6.3, RD-MP-10).
- Capability blockers are clear at admission except the APP-3B blocker above; candidate evidence
  blockers clear later by append-only records. [SRC basis: PKG § 4.4, OD-3] The APP-3B exception is
  a rule of this contract; PKG § 4.4, § 5.0 items 1 and 2 and § 5.4 carry the matching root
  clarification (RD-MP-10).
- Thresholds come from the run's own frozen `rules`. [SRC: PKG § 5] `NO_VALID_CANDIDATE` remains a
  valid outcome. [SRC: PKG § 5.0]
- Storage: the run binds `member_set_id`, not one `deployment_id`. Because `quant_jobs.deployment_id`
  is `NOT NULL`, storage follows the RD-MP-2 outcome (section 14: separate internal run store).

## 6. Package binding (multi-Pine)

PKG governs every package. This section adds only the multi-Pine binding.

### 6.1 Identity and binding tuple

- `export_id` binds `bot_id`, `run_id`, all participating `pine_import_id`/source-version pairs and
  the risk-policy snapshot. [SRC: PEX § Generated artifacts] A second build for the same run returns
  the same `export_id`. [SRC: PKG § 3.1]
- Multi-Pine binding tuple = PKG § 3.2 tuple with these changes:
  - `deployment_id`, `pine_import_id`, `source_version`, `source_hash`, `baseline_snapshot_hash`,
    `effective_input_hash` become a `members` array (3.1). A missing member field gives
    `BI_BINDING_INCOMPLETE`.
  - Add `member_set_id`, `set_hash`, `membership_hash`, `pine_count`, `mode: MULTI_PINE`,
    `bridge_pair`, `same_bar_order`.
  - `input_lock_hash` covers the two Bridge domains plus every member's frozen fixed snapshot.
- Freshness tuple F (PKG § 3.2) uses the member set: current membership equals `membership_hash`;
  every member source version, effective-input hash and deployment snapshot unchanged; pair, policy,
  capital and funding unchanged.

### 6.2 Files

Layout (OD-MP-4); PKG § 4.1 stays the one-Pine layout:

```text
inputs.json                       (actionable block: shared Bridge pair only)
risk-profile.json
setup-guide.md                    (lists every member script; one alert per member deployment)
validation.html
members/<ordinal>/indicator.pine
members/<ordinal>/indicator.json  (member identity, exit version, alert_source)
quant-data/manifest.json          (mode, pine_count, membership_hash, set_hash, member counts 5.7)
quant-data/metrics.json           (Bot aggregate only)
quant-data/equity.csv
quant-data/trades.csv             (each fill tagged with deployment_id)
quant-data/decisions.csv          (each decision tagged with deployment_id and ordinal)
quant-data/validation.json
quant-data/members/<ordinal>/parity.json
```

- `inputs.json`: only the shared Bridge pair is actionable; fixed source snapshots stay in private
  provenance. [SRC: PEX § Generated artifacts, `inputs.json` bullet; PKG § 4.2]
- `members/<ordinal>/indicator.pine`: the member's original bytes plus the Bridge block with the
  shared pair as Bridge defaults. No source input default changes in multi-Pine mode; any diff
  outside the Bridge default values refuses `BI_SOURCE_LOGIC_CHANGED`. [SRC basis: ADP § Numeric
  parameter selection]
- `alert_source = alert_calls` for every member. [SRC: PEX § Export selection]
- No webhook secret, URL or credential in any file. [SRC: PKG § 7.2]

### 6.3 Gates for multi-Pine

- B0: mode `MULTI_PINE` only on the internal path. [SRC: PKG § 5.0 item 3] Added checks: member set
  fresh, every member capability clear, shared pair equality, same market, same exit version. The
  only capability blocker allowed is the run-level `MULTI_PINE_REQUIRES_APP_3B` (RD-MP-10). On the
  `EXPORT_INTERNAL` path only, G7 may fail only because the run's contract version is the multi-Pine
  research contract version, which is never listed among the versions whose G7 derives `PASS`
  (`OWNER_RECOMMENDATION_NOT_READY`). The completion reason must still be the one that derives G7
  `PASS` (OD-18, RC-11). Holdout independence (PKG § 5.0 item 5) applies unchanged, including OD-19
  (`BI_HOLDOUT_EXPOSED_BY_SELECTION`, `BI_EXPOSURE_REGISTER_UNAVAILABLE`), committed in `2fd1b5b`
  (RD-MP-5).
- C1: file set per 6.2; checksums over every member file.
- C2: one compile record per member file, each bound to that file's SHA-256. A missing member record
  gives `BI_COMPILE_EVIDENCE_MISSING` (retryable). [SRC basis: PKG § 5.2]
- C3: every member's fixed snapshot equals the frozen run member snapshot (`BI_FIXED_INPUT_CHANGED`);
  the pair in `inputs.json` equals the selected candidate (`BI_INPUTS_MISMATCH`); source slots 0
  (`MP_SOURCE_SLOTS_FORBIDDEN`); `fixture = true` (`BI_FIXTURE_LABEL_MISSING`).
- C4: per-member alignment, parity and repaint for the chosen pair, each scoped to its member;
  combined baseline (5.6); freshness F (6.1). Missing member evidence reuses the existing retryable
  codes `BI_DATASET_ALIGNMENT_MISSING`, `BI_PARITY_EVIDENCE_MISSING`, `BI_REPAINT_EVIDENCE_MISSING`,
  with the member `ordinal` and `pine_import_id` in the diagnostic (OD-MP-11). PKG's closed retryable
  list stays unchanged. Evidence naming another member's hashes gives
  `MP_MEMBER_PARITY_SCOPE_MISMATCH` (non-retryable). G6 for export ignores
  `MULTI_PINE_REQUIRES_APP_3B` on the internal path only (RD-MP-10).
- C1 to C4 pass writes the `ql4c_validation` record and status `EXPORT_INTERNAL`, terminal, never
  READY. [SRC: PKG § 6.1] A multi-Pine record is never a G8 source. [SRC: PKG § 5.5]
- Retry rules, attempt limit (5) and append-only storage follow PKG unchanged. [SRC: PKG § 6.1, OD-7;
  § 8]

## 7. Isolation between sources

Each rule has a test in section 15.

| ID | Rule | Code |
| --- | --- | --- |
| I1 | Owner isolation: a foreign or absent member set, run or export reads as absent. [SRC: PKG § 7.3] | `NOT_FOUND` (404) |
| I2 | Bot isolation: a member belongs to one Bot (CODE: `pine_memberships` primary key); a set never contains another Bot's source. | `MP_MEMBER_FOREIGN_BOT` |
| I3 | Identity isolation: a payload for member A is never accepted on member B's deployment. CODE. | `DEPLOYMENT_MISMATCH`, `INVALID_ENTRY_REFERENCE` (existing) |
| I4 | Target isolation: an EXIT resolves only allocations of its own `deployment_id`; never another member's, never symbol-wide. [SRC: ADP § Versioned webhook contract] | `TARGET_NOT_OPEN` (existing), `MP_CROSS_SOURCE_TARGET` |
| I5 | Suppression isolation: BUY suppression is per deployment (5.3). | behaviour |
| I6 | Event identity isolation: uniqueness per `(deployment_id, event_id)` (CODE: `pine_bridge_events` key). | behaviour |
| I7 | Evidence isolation: parity, repaint, compile and Bridge evidence bind one member's hashes. | `MP_MEMBER_PARITY_SCOPE_MISMATCH`, `MP_MEMBER_EVIDENCE_MISSING` |
| I8 | Input isolation: one member's inputs never change another member's signals (5.2). | behaviour |
| I9 | Shared resources explicit: cash, reservations, limits and guards are shared by design and counted once per Bot; no private member cash pool in F11-01. | behaviour |
| I10 | Membership change: any membership, member source or pair change makes the set, runs and packages stale; nothing is re-bound silently. [SRC: ROADMAP § Binding and optimization contract] | `MP_MEMBER_SET_STALE`, `BI_MEMBERSHIP_CHANGED` |
| I11 | Fixture isolation: every F11-01 set, run and package has `fixture = true` and never appears in a customer view, a QR-3 comparison or a QR-4 universe. [SRC: ROADMAP § Data readiness; QR3; QR4] | `BI_FIXTURE_LABEL_MISSING`, `QR3_FIXTURE_PARTICIPANT`, `QR4_FIXTURE_PARTICIPANT`, `QR4_MULTI_PINE_PARTICIPANT` |
| I12 | One-Pine isolation: no F11-01 change alters a one-Pine result, contract, package, route or refusal. | regression T-R |

## 8. Refusal codes

All codes match `^[A-Z][A-Z0-9_]{1,63}$`. [SRC: PKG § 5] Existing codes keep their meaning. No new
code collides with an existing code in `src` or `public` at revision `2a6554f`.

### 8.1 Existing codes that keep firing unchanged

| Code | Where | Meaning in F11-01 |
| --- | --- | --- |
| `MULTI_PINE_RESEARCH_NOT_SUPPORTED` | public research enqueue | Unchanged; the HTTP path still refuses multi-Pine. |
| `MULTI_PINE_REQUIRES_APP_3B` | activation, BUY execution; also run-contract blocker | Unchanged in code; no multi-Pine deployment becomes READY or executes. |
| `STALE_MEMBERSHIP` | snapshot freshness | Reused for member deployments. |
| `DEPLOYMENT_MISMATCH`, `INVALID_ENTRY_REFERENCE`, `TARGET_NOT_OPEN` | receiver, EXIT resolution | Reused for cross-member payloads and targets. |
| One-Pine admission codes (5.1 step 3) | internal admission | Applied per member; failing member named. |
| `NOT_FOUND`, `BOT_ACCESS_DENIED` | ownership | Per PKG § 7.3. |
| `BI_*` package codes | PKG gates | Per PKG, applied per member where 6.3 says. |

### 8.2 New codes (prefix `MP_`; prefix frozen by RD-MP-1, section 14)

| Code | Stage | Retryable | Meaning |
| --- | --- | --- | --- |
| `MP_MEMBERSHIP_EMPTY` | member set | no | No connected member. |
| `MP_MEMBER_COUNT_EXCEEDED` | member set | no | More than `MP_MAX_MEMBERS` (3). |
| `MP_MEMBER_DUPLICATE_LOGIC` | member set | no | Equal source hash and effective-input hash (OD-MP-3). |
| `MP_MEMBER_FOREIGN_BOT` | member set | no | Member resolves to another Bot. |
| `MP_MEMBER_DEPLOYMENT_MISSING` | member set | no | No deployment named for a member, or the named id is absent or belongs to another import or source version. |
| `MP_MEMBER_DEPLOYMENT_AMBIGUOUS` | member set | no | Two deployments named for one member. |
| `MP_MEMBER_DEPLOYMENT_NOT_ELIGIBLE` | member set | no | Member deployment `READY`, `EXIT_ONLY` or `REVOKED` (any state other than `DRAFT`). |
| `MP_MEMBER_EVIDENCE_MISSING` | member set | no | No valid Bridge evidence row for a member deployment. |
| `MP_MEMBER_SET_STALE` | member set, run, export read | no | Membership, member snapshot, pair, or Bot policy, capital or funding (`bot_state`) changed since freeze. |
| `MP_BRIDGE_PAIR_DIVERGENT` | member set | no | A member deployment pair differs from the shared pair. |
| `MP_MARKET_MIXED` | member set | no | Members bind different markets (unreachable while only binance-global BTCUSDT 1m is allowed, M4). |
| `MP_EXIT_VERSION_MIXED` | member set | no | Members bind different exit versions. |
| `MP_EXECUTION_MODEL_MIXED` | member set | no | Members' evidence uses different execution models. |
| `MP_SOURCE_SLOTS_FORBIDDEN` | admission, C3 | no | Source slots requested or present. |
| `MP_MEMBER_QUANT_UNSUPPORTED` | admission | no | A member lacks Quant capability. |
| `MP_MEMBER_NO_SIGNALS` | evaluation blocker | no | A member emits zero native signals (OD-MP-10). |
| `MP_EVENT_ORDER_UNDEFINED` | admission | no | No supported same-bar order version. |
| `MP_MEMBER_PARITY_SCOPE_MISMATCH` | C4 | no | Member evidence names another member's hashes. |
| `MP_COMBINED_BASELINE_FAILED` | C4 | no | Combined replay differs from the Node/Paper oracle. |
| `MP_CROSS_SOURCE_TARGET` | combined replay | no | Defect guard; count must stay 0. |
| `MP_FIXTURE_ONLY` | internal admission | no | Internal path called without `fixture = true`. |
| `MP_INPUT_INVALID` | member set | no | Builder input is malformed or incomplete; the diagnostic names the field (for example `bot_state`, `market.unsupported`, `evidence[i].deployment_id`). |
| `MP_NOT_MULTI_PINE` | member set | no | Fewer than 2 members (a single member is One-Pine). |
| `MP_OWNER_FACING_FORBIDDEN` | any owner route | no | An owner route tried to read or act on a multi-Pine set, run or package as actionable. |

## 9. Statuses

### 9.1 Stored statuses

| Object | Statuses | Source |
| --- | --- | --- |
| Member deployment | `DRAFT` only; F11-01 causes no `READY` or `EXIT_ONLY` transition | CODE states; restriction of this contract (OD-MP-7) |
| Member set | insert-only record; no stored status | This contract |
| Research run | existing terminal set `SUCCEEDED`, `NO_VALID_CANDIDATE`, `FAILED`, `CANCELLED`, `TIMED_OUT`; `owner_recommendation_ready` always false | CODE: `TERMINAL` in `quant-research.js`; this contract |
| Export | `EXPORT_CANDIDATE`, `EXPORT_INTERNAL`, `EXPORT_REFUSED` only; never `EXPORT_VALIDATED` | [SRC: PKG § 6.1] |
| Capability (per member) | `bridge_capability`, `quant_capability`, independent | [SRC: ADP § Separate capabilities] |
| Multi-Pine capability (per Bot) | `INTERNAL_FIXTURE_ONLY` until APP-3B | This contract |

### 9.2 Derived state

- `member_set.fresh`: every field of the set's freshness tuple equals current server state; otherwise
  the read shows `STALE` with the first differing code. Derived at read, never stored, like PKG OD-8.
- `READY` is always false for `MULTI_PINE`. [SRC: PKG § 6.3]

## 10. What stays internal until APP-3B

[SRC: ROADMAP § Governing phase sequence, APP-3B row; PEX § Export selection; PKG § 7.2 and § 9]

- Owner review, apply and new Bot start for multi-Pine.
- Activation of any member deployment of a multi-Pine Bot (`MULTI_PINE_REQUIRES_APP_3B` stays).
- Webhook intake to queued Paper BUY for a multi-Pine Bot (execution refusal stays).
- Public research enqueue for multi-Pine (`MULTI_PINE_RESEARCH_NOT_SUPPORTED` stays).
- Any owner view of multi-Pine packages, values, metrics, status, best labels or downloads (PKG
  § 7.2: multi-Pine packages are never shown before APP-3B).
- Email Report for multi-Pine packages; no outbox row.
- Per-strategy returns. [SRC: OWN § O14]
- Bot-level Bridge Settings writes for multi-Pine.
- Per-member scoping of route retirement in `activateDeployment` (CODE fact 11).
- QR-3 comparisons and QR-4 selections with multi-Pine or fixture participants. [SRC: QR3; QR4]

Internal surface (OD-MP-8):

- Pure modules plus one internal service method, for example `MultiPineFixtureService.admit(...)`,
  not wired to any HTTP route, requiring `fixture = true` (`MP_FIXTURE_ONLY`), called only by tests
  and an operator fixture script in an isolated local cluster.
- No environment flag turns any owner route into a multi-Pine path in F11-01. Any later route belongs
  to APP-3B with its own gate.
- The three existing refusals are not edited. T-R1 to T-R3 prove each still fires after F11-01 code
  lands.
- No change to connect, analyze, generate, activation, receiver or execution routes.

## 11. Fixture design for isolated acceptance

### 11.1 Environment

- Local only: pure Node and Python modules plus a throwaway PostgreSQL cluster, one test file per
  process. No VPS, no network, no browser, no TradingView. [SRC: AGENTS.md § Host and product safety]
- Every object has `fixture = true` and a visible label in evidence.

### 11.2 Sources and data

- Option A (OD-MP-9), used for evaluation cases: two members that are both the reviewed SPT Spot v4
  source, with two different complete 58-input reviewed effective-input snapshots (same
  `source_hash`, different `effective_inputs_hash`), each keeping the 11 fixed Custom settings the
  admission code checks (CODE: `quant-research.js`). `MP_MEMBER_DUPLICATE_LOGIC` does not fire. A
  third source equal to member 1 in both hashes serves the duplicate negative case.
  - Limitation: varied-input TradingView parity for SPT is an open candidate blocker
    (`VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED`, PKG § 2). Fixture parity records are labelled
    fixture evidence and prove mechanics only.
- Option B, used only for scripted contention cases that A cannot produce: synthetic sources from the
  evaluator allowlist. Synthetic EMA runs remain demos. [SRC: ROADMAP § Source, exit and validation
  rules]
- Bars: a committed deterministic fixture dataset labelled `BINANCE:BTCUSDT` 1m with fixture
  provenance, at least 2,000 compared closed bars after the combined warm-up. [SRC: ADP, row
  "Warm-up/sample floor"]

### 11.3 Required fixture cases

| Case | Setup | Expected |
| --- | --- | --- |
| F1 shared pair | 2 members, both deployments with the shared pair | Set frozen; `set_hash` stable across key order |
| F2 divergent pair | member 2 pair differs | `MP_BRIDGE_PAIR_DIVERGENT`; no set |
| F3 cash contention | both members BUY on one bar; cash covers one | ordinal 1 accepted, ordinal 2 rejected or capped per policy, attributed as policy skip; Node oracle equal |
| F4 exit-first | member 2 EXIT and member 1 BUY on one bar, cash only after exit | EXIT first; BUY accepted |
| F5 cross target | member 1 EXIT targets member 2 `entry_ref` | `INVALID_ENTRY_REFERENCE` or `TARGET_NOT_OPEN`; member 2 allocation unchanged; `MP_CROSS_SOURCE_TARGET` 0 |
| F6 suppression scope | member 1 exit-intent bar, member 2 BUY same bar | member 2 BUY not suppressed; member 1 BUY suppressed |
| F7 shared daily cap | member 1 reaches Bot daily BUY limit | member 2 BUY rejected; member 2 EXIT accepted (reduce-only) |
| F8 loss guard | combined losses trip the Bot guard | entries of all members stop; exits continue; no guard reset |
| F9 duplicate event | same `event_id` replayed on member 1, same `event_id` on member 2 | member 1 duplicate 0 extra effects; member 2 event distinct |
| F10 membership change | disconnect member 2 after freeze | set, admission and export read `MP_MEMBER_SET_STALE` or `BI_MEMBERSHIP_CHANGED` |
| F11 source revision | new analysis of member 1 | as F10; no READY deployment affected because none exists |
| F12 source slots | multi request with one source slot | `MP_SOURCE_SLOTS_FORBIDDEN` |
| F13 three members | 3 members, contention on one bar | deterministic order 1, 2, 3; oracle equal |
| F14 over limit | `MP_MAX_MEMBERS + 1` (4) members | `MP_MEMBER_COUNT_EXCEEDED` |
| F15 duplicate logic | 2 members, equal source and effective-input hashes | `MP_MEMBER_DUPLICATE_LOGIC` |
| F16 one-member equivalence | combined replay with 1 member | byte-equal canonical output to `paper_replay` |
| F17 package | run with a candidate, completion reason `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE`, holdout evaluated, full member evidence and clearance records | C1 to C4 pass; `EXPORT_INTERNAL`; READY false; not a G8 source |
| F18 member file edit | one source default changed in member 2 file | `BI_SOURCE_LOGIC_CHANGED` |
| F19 missing member parity | member 2 parity missing | `BI_PARITY_EVIDENCE_MISSING` (retryable) naming member 2; status stays `EXPORT_CANDIDATE` |
| F20 no candidate | combined run without passing candidate | `NO_VALID_CANDIDATE`; no package |
| F21 foreign owner | owner B reads owner A set, run, export | `NOT_FOUND`; no values; no audit row on owner A Bot |
| F22 refusals hold | multi-Pine Bot: public enqueue, activate, BUY execution | `MULTI_PINE_RESEARCH_NOT_SUPPORTED`, `MULTI_PINE_REQUIRES_APP_3B`, `MULTI_PINE_REQUIRES_APP_3B` |
| F23 no side effects | whole fixture run | outbox count, Bot policy hash, session state, deployment states unchanged |
| F24 input independence | new reviewed input for member 2, regenerate | member 1 native signal set byte-identical; set, runs, package `STALE` |
| F25 evidence swap | member 2 references member 1 evidence | `MP_MEMBER_EVIDENCE_MISSING` or `MP_MEMBER_PARITY_SCOPE_MISMATCH` |
| F26 ambiguous deployment | two deployments named for member 1 | `MP_MEMBER_DEPLOYMENT_AMBIGUOUS` |
| F27 export idempotency | second build for the same run | same `export_id` |
| F28 run blocker | terminal multi run | `MULTI_PINE_REQUIRES_APP_3B` in blockers; `owner_recommendation_ready` false; counts per member sum to Bot counts |
| F29 zero-signal member | member 2 emits no native signal | `MP_MEMBER_NO_SIGNALS` |
| F30 QR exclusion | fixture multi package offered to a non-fixture QR-3 comparison and a customer QR-4 selection | `QR3_FIXTURE_PARTICIPANT`; `QR4_FIXTURE_PARTICIPANT` or `QR4_MULTI_PINE_PARTICIPANT`; F30 is split: QR-3 half counts toward F11-01 acceptance, QR-4 half is an explicit acceptance carry-over (RD-MP-6) |

### 11.4 Acceptance bar for F11-01

F11-01 is accepted for its target only when all hold:

1. This contract is reviewed, the decisions in section 13 are recorded and every root decision in
   section 14 is made and recorded.
2. Cases F1 to F30 pass in the isolated fixture with the source-bound combined Python evaluator (not
   the Node stub), with an evidence record: commit, engine hash, set hash, package hash, codes, UTC
   stamps; no secrets, machine paths or raw logs.
3. The test plan in section 15 runs by a role other than the implementer and reports pass.
4. The one-Pine regression suite (T-R) passes unchanged.
5. No owner-facing route, view, activation, Bridge Settings write or outbox row exists for multi-Pine
   (F22, F23, T-A).

Acceptance claims engineering mechanics only: not real multi-Pine parity, not a recommendation, not
staging, not any F11-02 outcome. Root decides any PM-1 credit (RD-MP-8).

## 12. Out of scope

- All F11-02/APP-3B items: activation, live intake and execution for multi-Pine, shared-symbol Paper
  canary, cross-Bot behaviour, reservations under live load, workload, recovery, owner
  review/apply/start, Bot-level Bridge Settings. [SRC: INV row F11-02; ROADMAP § Governing phase
  sequence]
- Source-input optimization in multi-Pine mode. [SRC: ADP § Numeric parameter selection]
- Per-strategy returns, QR-2 actual Paper performance for fixture runs, QR-3 comparisons, QR-4
  selections.
- Changes to Risk Manager hard limits, `paperAccount()`, ledger, sizing, Pine Bridge template bytes,
  the Python evaluator's one-Pine behaviour, QD-1/QS-1 scheduling.
- Sources other than the supported SPT Spot v4 hash with a complete review (plus Option B mechanics
  sources). Broader source qualification is a QL-2A/QL-3A matter.
- Email, outbox and SMTP. [SRC: PKG § 9]
- Markets other than BINANCE:BTCUSDT Spot 1m; Live; Futures; shorts; margin; capacity above 10K
  bars.
- Any migration or deploy on a shared host; any VPS work; TradingView steps.
- DP1 native supervision and N1 work.
- Any claim of profitability, real multi-Pine parity or a global optimum.

## 13. Decisions

Owner decisions, all decided 2026-10-19 as the recommended option.

| ID | Decision | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| OD-MP-1 | Maximum members per multi-Pine Bot in F11-01 | 3 (`MP_MAX_MEMBERS`). Bounded fixture cost; F11-02 measures more. | Owner | 2026-10-19 |
| OD-MP-2 | Same-bar order across members | (a) `exit-first-ordinal-v1`: EXIT first, then BUY, each by ordinal. Exits release cash and are never blocked. Live arrival order stays an APP-3B question. | Owner | 2026-10-19 |
| OD-MP-3 | Members with identical logic (equal source and effective-input hashes) | Refuse (`MP_MEMBER_DUPLICATE_LOGIC`) at freeze only; owner routes unchanged. | Owner | 2026-10-19 |
| OD-MP-4 | Multi-Pine package layout | Per-member subdirectories by ordinal; PKG § 4.1 stays one-Pine. | Owner | 2026-10-19 |
| OD-MP-5 | Per-member diagnostics before APP-3B | Counts only, internal, never returns, P&L or ranking (O14). | Owner | 2026-10-19 |
| OD-MP-6 | Where the shared pair lives | (a) Insert-only member set plus equality gate for F11-01; Bot-level Bridge Settings decided with APP-3B and F09-03. | Owner | 2026-10-19 |
| OD-MP-7 | Member deployment state for the fixture | DRAFT with Bridge evidence; no new state. | Owner | 2026-10-19 |
| OD-MP-8 | Admission surface | (a) Internal service, no route. A flag on an owner route can open owner-facing multi-Pine research on a misconfigured host. | Owner | 2026-10-19 |
| OD-MP-9 | Fixture sources | (A) two reviewed SPT snapshots for evaluation cases; (B) synthetic allowlist sources only for scripted contention cases. | Owner | 2026-10-19 |
| OD-MP-10 | Member with zero native signals | Blocker `MP_MEMBER_NO_SIGNALS`. A limitation code would let a pair optimized for a subset count as covering the membership. | Owner | 2026-10-19 |
| OD-MP-11 | Missing member evidence code | (a) Reuse PKG retryable `BI_*_MISSING` codes with a member diagnostic; PKG retryable list stays closed and unamended. | Owner | 2026-10-19 |

## 14. Root decisions

Root decisions recorded 2026-10-19. RD-MP-1, RD-MP-2, RD-MP-3 and RD-MP-6 were decided on 2026-10-19 (UTC) as recorded below.
F30 is split. The QR-3 half counts toward F11-01 acceptance. The QR-4 half is an explicit acceptance carry-over and
F11-01 acceptance must not claim it. RC-MP-1 is a root clarification of 3.3 (in-place edit).

| ID | Item | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| RD-MP-1 | Contract version names (`ql3a-research-job-multi-v1`, foundation-executor version) and the `MP_` code prefix | Option A: freeze `ql3a-research-job-multi-v1` and the `MP_` prefix. Member set record version `mp-member-set-v1` inside `set_hash`. Combined evaluator id `mp-combined-paper-v1`. `same_bar_order` `exit-first-ordinal-v1`. | Root | 2026-10-19 |
| RD-MP-2 | Run storage: nullable `quant_jobs.deployment_id` versus a member-set run table; any schema change follows the migration, protected-backup and rehearsal rules and runs only on a local throwaway cluster in F11-01 | Option B: a separate internal run store that no owner reader, worker, mode-guard or QR-3 participant lookup can see. Table slice later. | Root | 2026-10-19 |
| RD-MP-3 | Member-set storage location (table versus fixture-only artifact) for the internal service | Option A: insert-only member-set table in the same later extension as RD-MP-2. Pure builder first. | Root | 2026-10-19 |
| RD-MP-4 | The Node stub through the worker `evaluate` seam is mechanics-only; the combined Python evaluator is required for acceptance (11.4 item 2) | Confirmed as written. | Root | 2026-10-19 |
| RD-MP-5 | Commit status of the PKG amendment (OD-19, OD-20) before this contract cites it as binding | Committed in `2fd1b5b`. Section 6.3 cites PKG § 5.0 item 5 with OD-19 (`BI_HOLDOUT_EXPOSED_BY_SELECTION`, `BI_EXPOSURE_REGISTER_UNAVAILABLE`). | Root | 2026-10-19 |
| RD-MP-6 | Reconcile with QR-3 and QR-4, whose files state accepted status; confirm codes `QR3_FIXTURE_PARTICIPANT`, `QR4_FIXTURE_PARTICIPANT`, `QR4_MULTI_PINE_PARTICIPANT` before F30 binds them | Option A: no new QR-3 code. F30 is split: QR-3 half checked in F11-01; QR-4 half is an explicit acceptance carry-over (section 14 note). | Root | 2026-10-19 |
| RD-MP-7 | Packet routing for implementation | High-risk slice (accounting, parity, isolation): coder plus tester plus Opus auditor; a second-opinion review only if root records a reason. | Root | 2026-10-19 |
| RD-MP-8 | Whether F11-01 fixture acceptance moves PM-1 D for F11-01; Roadmap and Time Management updates at the checkpoint | Root decides D at acceptance. | Root | 2026-10-19 |
| RD-MP-9 | APP-3B carry-over: scope `activateDeployment` retirement per `pine_import_id` (CODE fact 11) | Record in the Roadmap APP-3B row or the F11-02 contract. | Root | 2026-10-19 |
| RD-MP-10 | Whether `MULTI_PINE_REQUIRES_APP_3B` as a run-contract blocker is a capability blocker that B0 and G6 for export tolerate on the internal path only (6.3), and the PKG wording for that exception | On the `EXPORT_INTERNAL` path only, the blocker neither refuses Gate B0 nor fails G6 for export at C4; every other capability blocker still refuses. On the `EXPORT_INTERNAL` path only, G7 may fail only because the run's contract version is the multi-Pine research contract version, which is never listed among the versions whose G7 derives `PASS` (`OWNER_RECOMMENDATION_NOT_READY`). The completion reason must still be the one that derives G7 `PASS` (OD-18, RC-11). PKG § 4.4, § 5.0 items 1 and 2 and § 5.4 carry the matching root clarification. | Root | 2026-10-19 |
| RD-MP-11 | Table slice carry-over: member-set table constraint | The table slice adds `UNIQUE(owner_id, bot_id, content_digest)` and does freeze-or-load as insert-or-load in one transaction. | Root | 2026-10-19 |
| RD-MP-12 | Where `exit_version` is stored | Derived, never stored on a deployment. One pure shared function (`src/pine-bridge/exit-version.js`) derives it from the integrated Pine artifact after checking the artifact hash against the deployment snapshot and parsing only the Bridge block whose preceding text hashes to the snapshot source hash: exactly one exit header, exactly one alert prefix naming the deployment, the same version in both, and a version the template has emitted (`bridge-exit-v1` or `bridge-exit-v2`; which versions are supported is an admission rule, and the package gates support `bridge-exit-v2` only); otherwise `MP_INPUT_INVALID` with field `deployment.exit_version`. The value is frozen only in the member-set record, and freshness derives it again. The same function serves PKG RC-24 on the one-Pine path. `snapshot.instruction_versions.template` is a template revision label and is never read as the exit version. | Root | 2026-10-20 |
| RD-MP-13 | Member-set table packaging (clarifies RD-MP-3) | The member-set tables are their own offline extension (marker `mp_member_set_schema` version 1): a parent table with `UNIQUE(owner_id, bot_id, content_digest)` and a member child table. The internal run store of RD-MP-2 is a later extension that depends on it. | Root | 2026-10-20 |
| RD-MP-14 | Member-set guards | Edits are refused with `QR002`; member insert guards use the shared guard code `QR004` (PKG RC-25), mapped to `MP_MEMBER_SET_STALE`; a deferred check requires the member count to equal `pine_count` at commit; `exit_version` is limited to the known versions, and admission refuses an unsupported one. Root chose `QR004` over a new code to keep one SQLSTATE plan. | Root | 2026-10-20 |
| RD-MP-15 | Freeze-or-load transaction | One SERIALIZABLE transaction (`QR003` otherwise): the service takes FOR SHARE locks on the member deployments and on the Bot's memberships, inserts the parent with ON CONFLICT DO NOTHING on the content key, and on a serialization failure retries a bounded number of times and then loads. Root chose SERIALIZABLE over READ COMMITTED after the package builder review showed stale guard reads under mixed isolation. Both tables join the insert-only grant list; the marker is read-only. | Root | 2026-10-20 |
| RD-MP-16 | Member-set tables result | The deferred completeness check also requires the Bot's connected memberships to equal `pine_count`, so a set covers every connected Pine. A command-line install, inspect and rollback tool is added like the other extensions (accepted deviation from the design). | Root | 2026-10-20 |
| RD-MP-17 | Member-set store result | `freezeOrLoadMemberSet` runs one SERIALIZABLE transaction: FOR SHARE on the member deployments and the Bot's memberships, each member's artifact from the single succeeded generate job of the same owner, Bot and deployment, its exit version from `deploymentExitVersion`, the record from the S1 builder with its closed-key input check, then load by content digest or insert. A serialization failure or deadlock is retried at most three times; a lost content-key race loads; other unique violations are storage refusals; `QR004` maps to `MP_MEMBER_SET_STALE`. The Bot-state reader must use the same transaction handle; the function is wired into no route, worker or view. | Root | 2026-10-20 |
| RD-MP-18 | Run contract builder result | `buildMultiResearchContract` and the exact-key `validateMultiResearchContract` (`src/multi-pine/run-contract.js`) build `ql3a-research-job-multi-v1` from a frozen member set and Bot-level input. The Bot-level fields mirror `ql3a-research-job-v2` (v3 is not built) as top-level keys: owner, Bot, policy hash, funding cutoff, capital, model, rules, engine hash, dataset, split, budget and seed. `rules` must equal the one-Pine `RULES`; the capital comes from the server-read capital accounts, which must hash to the set's `capital_basis_hash`, taking the account of the set's market broker; the dataset needs at least 2000 compared bars after warm-up; `budget` carries only the requested candidates (the planned count and the evaluation cap come with the plan slice); `bridge_domains` are `{min,max,step}` decimal strings. Members, set hash, membership hash and pine count must equal the frozen set; top-level `deployment_id`, `pine_import_id` and `source_version` are refused; `fixture` must be true; `acceptance_blockers` are the two candidate-evidence blockers plus `MULTI_PINE_REQUIRES_APP_3B`. Binding mismatches are `MP_INPUT_INVALID` with a field diagnostic. Only the builder binds the set hash and the capital; the validator cannot recompute them. The module is pure and no runtime root imports it. | Root | 2026-10-20 |
| RD-MP-19 | Internal run store, slice RS-1 (RD-MP-2 option B) | Its own offline extension `mp-run-store` (marker `mp_run_store_schema` version 1), installed only over an INSTALLED member-set extension and never by `db.migrate`. Two insert-only tables: `mp_research_runs` (UUID run id; owner and Bot keys onto `users`; the member set by its key and by its set hash; the run contract with tie checks, including policy hash and funding cutoff against the set; contract hash; an idempotency key unique per owner and Bot; no status, result, lease or deployment column; deadline bounds equal to the one-Pine deadline bounds) and `mp_research_run_events` (ADMITTED, RUNNING and five terminal states; database-clock times strictly increasing; nothing after a terminal event; the first event written by the top-level transaction that wrote the run, so no savepoint around them). Only QR002, QR003 and named QR004 guards; a stale member set is refused in the database. Grants: a new `internal_only` category leaves the runtime role with no privilege on these tables; a separate fixture role (SELECT and INSERT on the two tables, SELECT on the marker) exists only on isolated clusters through `scripts/grant-postgres-mp-fixture.sql`; the inspection refuses a runtime role that reaches the fixture role. The classifier also refuses inheritance, outside foreign keys, publications and outside views or rules on the tables. Accepted residuals on isolated clusters: table statistics show row counts to the runtime role, and deleting the user of a fixture owner fails on the run-store key. The rollback refuses while any row exists; the member-set rollback fails while the run store is installed. No writer, service, route or worker exists. | Root | 2026-10-20 |
| RD-MP-20 | Per-member admission checks, slice RS-4 | `checkMemberSetAdmission` (with `checkMemberAdmission` per member and `checkDatasetAdmission`) in `src/multi-pine/member-admission.js` is a pure mirror of the one-Pine admission checks of 5.1 steps 3 to 6, with no edit to the one-Pine path: members in ordinal and ascending `pine_import_id` order, the first failing member ends admission with its ordinal and `pine_import_id`, the DRAFT rule of 3.4 replaces the READY check, one member without quant capability for its own source hash and effective inputs hash refuses the set (`MP_MEMBER_QUANT_UNSUPPORTED`), the dataset rules with a warm-up floor of `max(1006, 5 * L)`, and one supported exit version and one execution model. A parity test runs the one-Pine checks and the mirror on the same fixtures and expects the same code. The caller derives each exit version from the artifact, authorizes owner and Bot first, reads the capital accounts in the admission transaction and takes the supported source hash from service config. Which record proves quant capability is decided in RS-5. | Root | 2026-10-20 |
| RD-MP-21 | Run-store writer and readers, slice RS-2 | `src/postgres/mp-run-store.js`: `insertMultiRun` runs inside the caller's SERIALIZABLE transaction (checked first), takes FOR SHARE on the member deployments and the Bot's memberships, writes the run and its ADMITTED event with no savepoint, and retries nothing; the admission transaction retries 40001, 40P01 and a lost idempotency-key race as a whole. The same key with the same submission hash loads the stored run; a different submission is `MP_INPUT_INVALID` field `idempotency_key`; database guards map by constraint name (`mp_research_runs_set_stale` to `MP_MEMBER_SET_STALE`), and a refusal from a database error tells the caller to roll back. `appendRunEvent` appends one event in its own transaction with the database clock. The owner-scoped readers `getMultiRun`, `findMultiRunByKey` and `listMultiRuns` (keyset paging by time and run id) re-check the contract, its hash, the column ties, the frozen member set and every event on each row and refuse the whole answer on any mismatch. They run only on the fixture role; the runtime role gets 42501. The caller passes only `buildMultiResearchContract` output, because the capital cannot be re-bound here. | Root | 2026-10-20 |
| RD-MP-22 | Run-store isolation suite, slice RS-3 | A PostgreSQL behaviour matrix installs the run store with multi-Pine runs of every status and runs each owner reader, worker claim, mode guard, startup drain, retention and recovery step and QR-3/QR-4 lookup as the runtime role on databases with and without the runs; the full results must be equal, and a control proves that a content difference with equal counts is detected. A static test scans tracked source, scripts and deploy files for the run-store table names (case-insensitive) against an exact allowlist and walks the import closure of every runtime root, including the scripts named by package.json and the deploy files, which never reaches the run-store modules. The accepted residuals are tested: the runtime role sees table statistics, and deleting the user of a fixture owner fails on the run-store key. | Root | 2026-10-20 |

## 15. Independent test plan

Run by a tester independent of the implementer; an Opus auditor reviews the isolation and ledger
cases. Engineering acceptance only; fixture passes never count as a recommendation. No test-only
override exists inside a gate module. [SRC basis: PKG § 11]

### 15.1 Pure modules (Node and Python, no database)

- T-M1: member-set builder derives mode, count and ordinal from server rows only; client `mode` or
  list ignored or refused.
- T-M2: `set_hash` and `membership_hash` stable across key order; any single member field change
  changes `set_hash`.
- T-M3: each 8.2 refusal at set and admission stages has one negation test with exactly the expected
  code; missing or wrong-type input fails with a code, never passes, never throws uncaught. `MP_MARKET_MIXED` is exempt while M4 makes it unreachable; root accepted its removal from the S1 code list.
- T-M4: every emitted code matches `^[A-Z][A-Z0-9_]{1,63}$`.

### 15.2 Combined evaluator (Python, no database)

- T-P1: one-member combined replay equals `paper_replay` on canonical output (F16).
- T-P2: cases F3 to F9, F13, F24 and F29 give the expected decisions; order follows
  `exit-first-ordinal-v1`.
- T-P3: the candidate pair is one object for all members; a per-member pair is impossible through the
  function signature.
- T-P4: `MP_CROSS_SOURCE_TARGET` count 0 over every fixture run.
- T-P5: determinism: same inputs give identical canonical outputs and hashes.

### 15.3 Node/Paper oracle (isolated PostgreSQL, one file per process)

- T-O1: for F3, F4, F7, F8 and F13, Node decision functions and the combined replay agree on
  accept/cap/reject 100%, allocation target mismatches 0, quantity difference 0 venue steps, cash
  within 1 minor unit. [SRC: ADP, row "Quant baseline"]

### 15.4 Package gates (Node, pure module plus isolated PostgreSQL)

- T-K1: F17: C1 to C4 pass; `EXPORT_INTERNAL`; READY false; G8 unchanged; `QUALIFIED_TOTAL` 0.
- T-K2: F12, F18, F19 give the expected codes; F19 stays `EXPORT_CANDIDATE` and counts toward the
  attempt limit of 5.
- T-K3: `inputs.json` actionable block holds exactly `atr_multiplier` and `rr`.
- T-K4: insert-only freeze refuses update and delete on member-set, export, status-event, compile and
  validation rows, including for the application role.
- T-K5: F27 idempotent `export_id`.

### 15.5 Isolation and refusal regression

- T-I1 to T-I12: one test per isolation rule in section 7.
- T-R1: public research enqueue on a multi-Pine Bot still gives `MULTI_PINE_RESEARCH_NOT_SUPPORTED`.
- T-R2: activation on a multi-Pine Bot still gives `MULTI_PINE_REQUIRES_APP_3B`.
- T-R3: queued BUY execution on a multi-Pine Bot still gives `MULTI_PINE_REQUIRES_APP_3B`.
- T-R4: existing one-Pine suites for Pine Bridge, research and library pass unchanged, run once.
- T-R5: negative-scope diff check: the F11-01 diff writes nothing to `activateDeployment`,
  `prepareBridgeExecution`, the receiver, Risk Manager, ledger sizing, Pine template bytes or any HTTP
  route table; any hit fails the packet.

### 15.6 API and UI (Node, local, no browser)

- T-A1: no HTTP route reaches the internal admission service; a route inventory diff shows no new
  multi-Pine route.
- T-A2: Research Library and package reads for an owner never return multi-Pine packages, values,
  metrics, status, downloads or best labels; fixture objects never render in the customer view.
- T-A3: outbox count, Bot policy hash, session state and deployment states unchanged after the whole
  fixture run (F23).
- T-A4: F30 QR-3/QR-4 exclusion.

### 15.7 Evidence record

One record per acceptance run: commit, engine hash, member-set hash, package hash, per-case result,
codes, UTC stamps, tester role. No secrets, machine paths, raw logs or holdout bars. The tester never
marks the fixture accepted; root decides.

## 16. Known risks

- R1: live intake orders by arrival; `exit-first-ordinal-v1` is not live parity. APP-3B must measure
  it.
- R2: Option A reuses SPT with varied inputs, whose TradingView parity is an open blocker; fixture
  parity proves mechanics only.
- R3: run storage binds one `deployment_id` (`NOT NULL`); member-set runs need a schema decision and
  a migration rehearsal before any host use.
- R4: the per-deployment `selection.bridge` can drift from the shared pair; the equality gate runs at
  freeze, admission, package build and every read.
- R5: a combined replay that drops a member silently would look valid; 5.1 step 4 forbids it and
  T-M3, T-P2 test it.
- R6: ordinal order can systematically favour member 1 under tight cash; the bias is recorded, not
  removed.
- R7: `activateDeployment` retires every other READY route of the Bot; unchanged here, it must be
  scoped per member before APP-3B can activate several members.
- R8: QR-3, QR-4 and the PKG OD-19/OD-20 amendment are committed in `2fd1b5b`;
  RD-MP-6 (section 14) records the QR-3 and QR-4 code reconciliation.
