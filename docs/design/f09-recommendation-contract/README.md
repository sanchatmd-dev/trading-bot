# F09 next research contract and recommendation trace profile: design draft

Status: **PROPOSED; NOT ADOPTED; NO CODE OR ENGINE CHANGE AUTHORIZED**. Draft of 2026-10-24 for root review (slice F09-V3-D1), revision 2 after the independent draft review (findings F1 to F11). Role: architecture auditor as design author. Root: "Root: astra-vps-trade-bot-v2".

This note proposes how the next research contract could be defined so that one stored one-Pine run can both reproduce through the trace module (S3) and pass the owner-recommendation gate G7. It adopts no ruling, names no accepted version, issues no GO and changes no file other than itself. Every proposal below is input for a later root decision and, where marked, an owner decision. The authority is the [package contract](../../QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md) (cited as CT) and the [S4 build-worker note](../f09-build-worker/README.md).

## 1. Problem

No stored one-Pine contract form both reproduces and passes G7 today.

- G7 is derived only from the completion reason and the contract version (OD-18; CT:496-499, CT:710, CT:811-812). The code lists one version, `ql3a-research-job-v3`, and its comment calls that entry "a placeholder that must be replaced when that version is named" (`src/quant-library/owner-recommendation.js:7-13`). The gate ignores any stored `owner_recommendation_ready` flag (`owner-recommendation.js:15-19`).
- The completion reason that derives G7 PASS is `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` (`owner-recommendation.js:6`; CT:256, CT:498). The legacy worker writes it at `src/postgres/quant-research-worker.js:136`.
- S3 has one ACTIVE profile: `ql3a-research-job-v1` without an `execution_backend` key, checked against `engineHash(false)` (`src/quant-library/trace-reproduction.js:67-69`). The v3 placeholder is DEFERRED to "the slice that defines the next research contract (OD-3, OD-12, OD-18)" (`trace-reproduction.js:70-74`; RC-35 at CT:766).
- No v3 contract exists. The legacy admission path builds only v1 (`src/postgres/quant-research.js:136`), the foundation path builds only v2 (`quant-research.js:116-118`; `src/quant-research/research-contract-v2.js:12`), and the legacy Python engine refuses every version except v1 (`quant_lab/src/robot_quant/research_engine.py:21-22`).
- Result: v1 reproduces but fails G7; the v3 placeholder passes G7 but cannot reproduce (`docs/design/f09-build-worker/README.md:9-21`; `docs/FE2B_RELEASE_PLAN_DRAFT.md:81-83`; risk R1 at CT:883-885). `fixture=true` exempts the episode gate, not G7 (`src/quant-library/package-gates.js:364-368`).

The build-worker note records that this is an intentional dependency, not a defect to repair by weakening a gate, and forbids rewriting v1 contracts to v3, promoting a profile or injecting a passing gate (`f09-build-worker/README.md:19`). It assigns the fix to the slice that defines the next recommendation contract, which must supply a compatible ACTIVE trace profile with real fixture evidence (`f09-build-worker/README.md:21`).

Three owner decisions already bind that contract: OD-3 split blocker model (CT:276-293, CT:695), OD-12 explicit `policy_version`/`policy_hash` field (CT:157, CT:704) and OD-18 G7 derivation (CT:496-499, CT:710).

## 2. Proposed contract version

Working name: `ql3a-research-job-v3`, the string already in the G7 list (`owner-recommendation.js:13`) and in the S3 DEFERRED table (`trace-reproduction.js:74`). Keeping it avoids a rename of the G7 constant and of the classification pins (`test/trace-reproduction-closure.test.js:181`, `:216-233`). The owner or root still names the final version (question Q1). A different name changes the G7 list, the DEFERRED key and those pins in the same slice; the S3 keys stay literal strings (`trace-reproduction.js:60-66`; RC-35).

Proposed backend: the legacy inline-bars backend, the same execution family as v1, with no `execution_backend` key. Reasons: S3 already reproduces that family through the unchanged legacy evaluation call and the S3a driver (RC-35, CT:766; `trace-reproduction.js:360-369`), and the foundation form is DEFERRED to a separately reviewed foundation slice (`trace-reproduction.js:72`; JUDGEMENT J4). The limit is the inline-bar cap of 10,000 bars that S3 enforces (`trace-reproduction.js:144-150`). A foundation-backed v3 stays an alternative (question Q5).

Executor-mode constraint. The legacy backend ties v3 to the global LEGACY executor mode. The service builds the legacy contract only when it is not in foundation mode (`quant-research.js:108`, `:120`), admission refuses with `RESEARCH_EXECUTOR_MODE_MISMATCH` when the stored executor mode differs from the service mode (`quant-research.js:51-56`), and the legacy worker refuses in foundation mode with `RESEARCH_FOUNDATION_WORKER_REQUIRED` (`quant-research-worker.js:44`). A legacy-backend v3 and the foundation v2 path therefore cannot be admitted or run in one service mode. Any deployment that runs foundation research must switch modes, or wait for a foundation-backed v3 (Q5).

Request selection. The request body has an exact key set (`quant-research.js:58`) and the submission hash covers the whole body (`quant-research.js:65`). This draft does not yet say how a request chooses v3 over v1. Two options are open (root question R5):

- An optional request key, for example `contract_version`, added to the exact key list. Because the submission hash covers the body, the same idempotency key with a different version then refuses with `IDEMPOTENCY_CONFLICT` instead of silently returning a job of the other version, and a v1 request that omits the key keeps its current submission hash.
- v3 replaces v1 for new admissions, with no request key (tied to Q8).

A service-level switch outside the body is not recommended: the submission hash would not record the chosen version, so an idempotent replay could return a v1 job for a v3 intent.

## 3. Proposed v3 field table

Base: the v1 contract object at `src/postgres/quant-research.js:136`. "Same as v1" means the same key, value rule and producer as that line. Nothing below edits a stored v1 or v2 contract.

| Field | Proposed v3 rule | Change from v1 | Source |
| --- | --- | --- | --- |
| `version` | `ql3a-research-job-v3` (working name, Q1) | New value | `owner-recommendation.js:13`; `trace-reproduction.js:74`; CT:499 |
| `scope` | A non-engineering scope for a real run; the engineering scope only for a labelled fixture run. Name open (Q2) | New value for real runs | Engineering scope forces `fixture = true` (`package-gates.js:23`, `:738-739`; CT:170). The legacy engine accepts only the engineering scope today (`research_engine.py:21`) |
| `owner_id`, `bot_id`, `deployment_id`, `pine_import_id`, `source_version`, `source`, `source_hash`, `baseline_snapshot_hash` | Same as v1 | None | `quant-research.js:136`; CT:152-154 |
| `snapshot` | Same as v1, including `snapshot.policy` and `snapshot.policy_hash` | None | `quant-research.js:136`; `src/postgres/pine-bridge-readiness.js:26` |
| `policy_version` | New top-level text field, frozen at admission (OD-12). Value source open (Q3) | New | CT:157, CT:704. C3 reads `contract.policy_version` in `derivedBinding` (`package-gates.js:607`, reached through `bindingMismatch` at `:724`) and in `riskCodes` (`:658`, reached at `:726`), both inside `evaluateProvenance` (`:720`). B0 sees the policy fields only through `bindingComplete` on the supplied binding (`:181`, `:359`). The freshness tuple compares the binding with current state (`package-gates.js:755-759`; CT:173-177). No v1 or v2 contract carries the field, so every current binding lacks it |
| `policy_hash` | New top-level SHA-256 field (OD-12). Admission refuses unless it equals `snapshot.policy_hash` | New | CT:157, CT:704. C3 reads the hash from `contract.snapshot.policy_hash` (`package-gates.js:607`, `:658`); the equality rule keeps the gate unchanged but leaves C3 sourcing the hash from the snapshot, not from the new field (owner question Q9). Alternative: change those two reads to the top-level field (root question R3), which edits `package-gates.js`, a member of six runtime closures (section 6) |
| `input_lock`, `plan`, `model`, `rules`, `capital`, `ledger_initialization`, `max_evaluations` | Same as v1 | None | `quant-research.js:136`; CT:155, CT:158-163 |
| `engine_hash` | `engineHash(false)` at admission, as v1 | Value changes once the engine edit in section 6 lands | `quant-research.js:33-37`, `:136` |
| `dataset`, `split` | Same as v1: inline bars, warm-up and 60/20/20 split | None | `quant-research.js:136`; `trace-reproduction.js:144-150` |
| `acceptance_blockers` | Exactly the candidate evidence blockers `VARIED_INPUT_TRADINGVIEW_PARITY_REQUIRED` and `CUSTOM_REPAINT_EVIDENCE_REQUIRED`, in that order. Never a capability blocker | v1 also freezes `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED` | OD-3 (CT:276-293, CT:695); `package-gates.js:39-41`, `:328-332`; v1 list at `quant-research.js:136` |
| Admission capability check | Admission refuses while any capability blocker applies to the source. No v3 row is written in that case | New admission rule, no new field | CT:280-283, CT:291-293 |
| `execution_backend` | Absent. A v3 contract that carries the key, null included, is refused by S3 as for v1 | None | RC-35 (CT:766); `trace-reproduction.js:76-80` |
| Result `completion_reason` | Unchanged worker rule: `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` only when no check failed | None | `quant-research-worker.js:136`; CT:256 |
| Result `owner_recommendation_ready` | Stays `false` as written today; G7 ignores it | None | `quant-research-worker.js:114`; `owner-recommendation.js:15`; CT:811-812 |
| G7 derivation | Unchanged function. PASS needs the completion reason above and a listed version | None | OD-18 (CT:496-499, CT:710); `owner-recommendation.js:16-19` |

Notes on the table:

- OD-3 makes the blocker split part of the version (CT:291-293). Under it a v3 run that exists already passed the capability check, so B0 sees only candidate evidence blockers (`package-gates.js:331`) and C4 clears them by append-only records (CT:286-289, CT:476). G6 in the library view still fails while those blockers remain (`src/quant-library/derive.js:293-294`); B0 does not need G6 PASS (CT:338-340).
- No one-Pine source can clear `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED` today; this draft found no one-Pine capability registry in the code. Existing one-Pine surfaces that state a capability, none of which registers one:
  - Source analysis carries `quant_capability: {status: 'UNSUPPORTED', blockers: ['QUANT_UNSUPPORTED', 'EVALUATOR_REQUIRED:<dependency>' ...]}` (`src/pine-bridge/source.js:72`). The bridge worker passes it through to the job result (`src/postgres/pine-bridge-worker.js:58`), and deployment readiness returns `quant_capability: 'UNSUPPORTED'` (`src/postgres/pine-bridge-readiness.js:57`).
  - Legacy admission already enforces the supported `SOURCE_HASH` and a reviewed 58-input effective-input set (`quant-research.js:80-82`). These are the same facts that the multi-Pine fixture capability record proves.
  - The multi-Pine path has a per-member `quant_capability` record (`state: 'SUPPORTED'` with the member's source and effective-input hashes) that admission checks (`src/multi-pine/member-admission.js:195-199`, `:206-207`; producer `src/multi-pine/fixture-service.js:113-118`). That record is fixture-scoped and does not register a customer capability.

  Until one of these, or a new registry, registers a customer capability, v3 admission refuses every real run (question Q4). An isolated test can supply a capability reader that reports one fixture source as registered; an absent or unreadable registry counts as "blocker present".
- RC-11 stays the only exception to the split model and applies to the multi-Pine internal path only (CT:719-720, CT:734). v3 is one-Pine; admission still refuses multi-Pine (`quant-research.js:76`).
- A `NO_VALID_CANDIDATE` or `CANDIDATE_FAILED_CHECKS` run keeps failing G7, so a v3 version alone grants nothing (`owner-recommendation.js:17-19`).

## 4. Proposed ACTIVE trace profile

Proposed literal entry, added beside the v1 entry and removed from the DEFERRED table in the same change:

```js
'ql3a-research-job-v3':Object.freeze({state:'ACTIVE',closure:'engineHash(false)',path:'pythonEvaluation + trace driver'})
```

Rules:

1. Dispatch stays on `version` and on the presence of `execution_backend`, never on contract shape (RC-35; `trace-reproduction.js:60-66`). The key is a literal string, never computed from the G7 constant (`test/trace-reproduction-closure.test.js:216-233`).
2. Closure: the legacy run closure `engineHash(false)`, the same file list as v1 (`quant-research.js:19`, `:31`). The C5 subset test then holds without a new closure entry (`test/trace-reproduction-closure.test.js:185`, `:205-214`). Consequence: v1 and v3 share one engine hash, so the engine edit in section 6 changes the hash for both (section 6.3).
3. Ports bound to a closure (RC-35, last sentence). Today `defaultPorts` builds the ports before any run is read and always returns `engineHash(false)` (`trace-reproduction.js:364-368`). `reproduceRun` checks only that the port functions exist (`:220-223`, `:232`) and resolves the profile later, inside `readRun` (`:132`). Passing a profile to `defaultPorts` alone would therefore not stop a caller from using v1 ports for a v3 run. Proposal:
   - Every ports object carries a `closure` text that names the closure its `engineHash` computes. `defaultPorts({closure, python, timeoutMs})` maps that name to the hash function and throws on an unknown name. `checkPorts` refuses a ports object without the text.
   - `reproduceRun` compares `ports.closure` with `executionProfile(contract).closure` after `readRun` returns (state, contract hash, version dispatch, plan checks) and before `checkBars` and every port call, the engine-hash read included. A mismatch refuses with no port call and no output.
   - The refusal code is part of root question R2. `TRACE_REPRODUCTION_UNSUPPORTED` keeps the module's refusal set unchanged (pinned at `test/quant-library-trace-reproduction.test.js:284-288`); a new code changes that pin.

   With both profiles on `engineHash(false)`, a correct caller sees no change in result. A later profile with another closure cannot reuse the v1 ports by accident.
4. Steps: unchanged worker order (candidate, sensitivity neighbours, cost stress, then holdout) through the unchanged legacy evaluation call (`trace-reproduction.js:152-167`, `:255-269`; RC-34 at CT:765).
5. Driver: reuse the S3a driver without change (`quant_lab/src/robot_quant/trace_reproduction.py`; `trace-reproduction.js:39-49`, `:303-306`). It evaluates through the legacy engine, so it accepts a v3 contract only after the engine change in section 6.
6. Trace closure: `trace-reproduction-closure-v1` keeps its file list (RC-37 at CT:768). Editing `trace-reproduction.js` and the legacy engine files changes `trace_engine_hash` for new records, as any edit does. S3 adds no v3 shape validator, so no file joins the trace closure. Consequence: S3 relies on the admission validator, the freeze trigger (CT:95-98) and B0 for the v3 shape. A v1-shaped contract relabelled v3 (capability blocker frozen, no policy fields, contract hash recomputed) reproduces in S3; B0 then refuses it with `BI_CAPABILITY_BLOCKER_PRESENT` (`package-gates.js:331`) and, through the binding, `BI_BINDING_INCOMPLETE` (`package-gates.js:359`). Spec V3-P13 pins this.
7. Holdout content follows RC-38 (CT:769) until the owner records OD-21 (question Q6). Until then only fixture packages may exist.

Considered and not recommended:

- Materialize a v3 contract into a v1-shaped execution contract, as the foundation path does for v2 (`research-contract-v2.js:12`, `:194`). The worker calls the evaluator with the stored contract (`quant-research-worker.js:81`), so this still edits a closure file. It also sits close to the forbidden rewrite of versions (`f09-build-worker/README.md:19`; RC-35, "S3 never rewrites a stored contract's `version`").
- A separate v3 worker file outside the closure. It would duplicate the run algorithm that S3 mirrors and test B7 pins (`trace-reproduction.js:97-115`), so two sources of the step order could drift. It would also be imported by the runtime root and so join the runtime manifest (section 6.1).
- A new closure name for v3 only. The worker selects its closure from the service mode, not the contract (`quant-research-worker.js:36`), so this needs a worker edit as well, and the C5 closure table would grow (`test/trace-reproduction-closure.test.js:185`).

## 5. Files an implementation would touch

Revision 1 called these files "outside the closures". That is true only for `LEGACY_ENGINE_FILES`. `quant-research.js`, `owner-recommendation.js` and `package-gates.js` are members of `QUANT_RUNTIME_ENGINE_FILES` and therefore of five hashed closures that include that manifest (section 6.1). Every change below is runtime wiring or an engine-closure change. `docs/FE2B_RELEASE_PLAN_DRAFT.md:45` allows only design, dependency inventories and test specifications outside runtime closures while the gate is held, so each row **needs the FE-2b release plan and an owner GO** before change.

| File | Expected change | Closure membership (section 6.1) | Evidence |
| --- | --- | --- | --- |
| `quant_lab/src/robot_quant/research_engine.py` | Accept `ql3a-research-job-v3` and the agreed scope; ignore `policy_version` and `policy_hash` for evaluation | 8 closures | `:21-22` raise `UNSUPPORTED_RESEARCH_CONTRACT` today |
| `src/postgres/quant-research.js` | v3 builder call on the legacy admission path: `policy_version`, `policy_hash`, capability check, candidate blockers only, request selection (R5). It also defines the legacy and foundation closure lists, so a list edit here changes which bytes are hashed | 6 runtime-family closures; not LEGACY; not TRACE (named exclusion at `test/trace-reproduction-closure.test.js:117-129`) | `:19-37`, `:51-58`, `:65`, `:76-82`, `:108`, `:120`, `:136` |
| New `src/quant-research/research-contract-v3.js` (proposed) | Pure v3 builder and exact-key validator, as `research-contract-v2.js:41`, `:88-108` do for v2 | None today. Once `quant-research.js` imports it, `test/quant-engine-files.test.js:26-31` fails with "unhashed dependency" unless it is listed in `QUANT_RUNTIME_ENGINE_FILES`; it then joins the same 6 closures as `research-contract-v2.js` | `research-contract-v2.js:41`, `:88-134`; v2 is listed at `runtime-engine-files.js` (manifest entry `src/quant-research/research-contract-v2.js`) |
| `src/quant-research/runtime-engine-files.js` | Forced one-line entry for the new v3 module. The manifest hashes its own bytes (header, `:1-4`) | 6 runtime-family closures | `test/quant-engine-files.test.js:26-37` |
| `src/quant-library/trace-reproduction.js` | ACTIVE entry, DEFERRED removal, closure-bound ports (section 4, rule 3) | TRACE only | `:67-74`, `:132`, `:220-232`, `:364-368` |
| `src/postgres/quant-library.js` | Classify v3 in `familyOf` (today null for any version except v1 and v2) | None; imported only by `src/postgres/server.js:41`, not by a runtime root | `:109`, `:123`, `:167`, `:212`, `:233`, `:244` |
| `src/quant-library/owner-recommendation.js` | Only if the final name differs from the placeholder (Q1) | 6 runtime-family closures | `:13` |
| `src/quant-library/package-gates.js` | None if the `policy_hash` equality rule in section 3 is adopted; otherwise the two reads at `:607` and `:658` (R3) | 6 runtime-family closures | `:607`, `:658`, `:755-759` |
| Capability reader (Q4, R4; location open) | Reads the registered customer capability at admission | Depends on location: if `quant-research.js` imports it, it is forced into the runtime manifest like the v3 module | CT:280-283 |

`src/postgres/quant-storage-retention.js` refuses non-v1 legacy rows (`:93`) but scans only rows with `execution_backend = 'quant-foundation-v1'` (`:63`). A legacy-backend v3 row has no such key, so this draft expects no change there. A foundation-backed v3 (Q5) would need one; that file is itself a member of 6 runtime-family closures.

## 6. Engine-closure impact inventory

RC-35 says the slice that adds a new ACTIVE profile "needs the FE-2b release plan and an owner GO for any engine-file change" (CT:766). Every file in section 6.1 that an implementation would change **needs the FE-2b release plan and an owner GO**.

### 6.1 Closure-membership matrix

Closure lists found in `src` (search for exported `*_FILES` lists and closure hash functions; membership computed by importing the lists in Node on 2026-10-24 at branch `codex/fe2b-ci-local-fix`, head `a345017` at session start; script in the session scratchpad, no repository write):

| Short name | List (source) | Files | Hash identity |
| --- | --- | --- | --- |
| LEGACY | `LEGACY_ENGINE_FILES` (`src/postgres/quant-research.js:19`, `:31`) | 10 | `engineHash(false)` (`quant-research.js:33-37`) |
| FOUNDATION | `FOUNDATION_ENGINE_FILES` (`quant-research.js:20-30`, `:32`); includes LEGACY and RUNTIME | 104 | `engineHash(true)` |
| RUNTIME | `QUANT_RUNTIME_ENGINE_FILES` (`src/quant-research/runtime-engine-files.js:5`) | 104 | No own hash; merged into FOUNDATION, FIXED_EVAL, MP_COMBINED, INGESTION and PF2_ENGINE |
| TRACE | `TRACE_REPRODUCTION_FILES` (`src/quant-library/trace-reproduction.js:41-49`); includes LEGACY | 26 | `trace-reproduction-closure-v1` (`:51`) |
| FIXED_EVAL | `FIXED_EVAL_ENGINE_FILES` (`src/postgres/quant-fixed-eval-engine.js:14-22`); includes RUNTIME | 104 | `fixed-eval-closure-v1` (`:25`) |
| MP_COMBINED | `MP_COMBINED_ENGINE_FILES` (`src/multi-pine/engine-closure.js:19-44`); includes RUNTIME | 127 | `mp-combined-closure-v1` (`:47`) |
| MP_PKG_TRACE | `MP_PACKAGE_TRACE_FILES` (`src/multi-pine/package-closure.js:19-22`) | 2 | `mp-package-trace-closure-v1` (`:25`) |
| INGESTION | `INGESTION_ENGINE_FILES` (`src/postgres/quant-data.js:28`); includes RUNTIME | 105 | `ingestionEngineHash` (`:29`) |
| PF2_ENGINE | `PF2_ENGINE_FILES` (`src/quant-research/preflight-resolver.js:35`); includes RUNTIME | 106 | PF-2 `engine_hash` (`:188-200`) |
| PF2_EVALUATOR | `PF2_EVALUATOR_FILES` (`preflight-resolver.js:25`) | 14 | PF-2 `evaluator_hash` (`:188-200`) |

Membership (x = member; x* = member only after the forced manifest entry; - = not a member). "Six runtime-family closures" below means FOUNDATION, RUNTIME, FIXED_EVAL, MP_COMBINED, INGESTION and PF2_ENGINE.

| File | Proposed change | LEGACY | FOUNDATION | RUNTIME | TRACE | FIXED_EVAL | MP_COMBINED | MP_PKG_TRACE | INGESTION | PF2_ENGINE | PF2_EVALUATOR |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `quant_lab/src/robot_quant/research_engine.py` | Yes | x | x | x | x | x | x | - | x | x | - |
| `src/postgres/quant-research.js` | Yes | - | x | x | - | x | x | - | x | x | - |
| New `src/quant-research/research-contract-v3.js` | Yes (new file) | - | x* | x* | - | x* | x* | - | x* | x* | - |
| `src/quant-research/runtime-engine-files.js` | Yes (forced entry) | - | x | x | - | x | x | - | x | x | - |
| `src/quant-library/trace-reproduction.js` | Yes | - | - | - | x | - | - | - | - | - | - |
| `src/postgres/quant-library.js` | Yes | - | - | - | - | - | - | - | - | - | - |
| `src/quant-library/owner-recommendation.js` | Only if Q1 renames | - | x | x | - | x | x | - | x | x | - |
| `src/quant-library/package-gates.js` | Only under R3 alternative | - | x | x | - | x | x | - | x | x | - |
| `src/pine-bridge/source.js` | Only if Q4 picks it | - | - | - | x | - | x | - | - | x | - |
| `src/postgres/pine-bridge-readiness.js` | Only if Q4 picks it | - | - | - | - | - | x | - | - | - | - |
| `src/postgres/pine-bridge-worker.js` | Only if Q4 picks it | - | - | - | - | - | - | - | - | - | - |
| `src/quant-research/contract.js` | No by design | x | x | x | x | x | x | - | x | x | - |
| `src/postgres/quant-research-worker.js` | No by design | x | x | x | x | x | x | - | x | x | - |
| `spt_custom_evaluator.py`, `spt_evaluator.py`, `bridge_replay.py`, `risk_evaluator.py`, `analytics.py` (all `quant_lab/src/robot_quant/`) | Expected no | x | x | x | x | x | x | - | x | x | x |
| `quant_lab/src/robot_quant/bridge_paper.py`, `quant_lab/src/robot_quant/ql3a.py` | Expected no | x | x | x | x | x | x | - | x | x | - |
| `quant_lab/src/robot_quant/trace_reproduction.py` | No (driver reused) | - | - | - | x | - | - | - | - | - | - |
| `src/quant-library/derive.js` | No | - | x | x | - | x | x | - | x | x | - |
| `src/postgres/quant-storage-retention.js` | No (legacy backend) | - | x | x | - | x | x | - | x | x | - |
| `quant_lab/src/robot_quant/research_chunk.py` | Only for foundation v3 (Q5) | - | x | x | - | x | x | - | x | x | - |
| `src/quant-research/research-contract-v2.js` | Only for foundation v3 (Q5) | - | x | x | - | x | x | - | x | x | - |

Notes on the matrix:

- `src/pine-bridge/source.js` is also in the test-side shared-application boundary (`test/helpers/runtime-shared-boundary.js`), which lets runtime modules import it without listing it; that boundary does not remove it from the three closures above.
- The new v3 module cannot stay outside the closures. `test/quant-engine-files.test.js:26-31` walks the static import closure from `src/postgres/quant-research-main.js` and three other runtime roots, and fails on any import that is neither in FOUNDATION, INGESTION and PF2_ENGINE nor in the shared-application boundary. Building v3 inline in `quant-research.js` instead changes the same six closures. The shared-application boundary is not a proper home for a research contract builder.
- "No by design" and "Expected no" for `contract.js`, `quant-research-worker.js` and the evaluator files rest on reading their contract-version use: the worker reads no contract version (`quant-research-worker.js:114`, `:136`), and the evaluators showed no version read in a text search. The implementation packet must confirm each by reading the file. `ql3a.py:293` and `research_engine.py:67` write `owner_recommendation_ready: False`, which G7 ignores.
- A foundation-backed v3 (Q5) would also touch `research_chunk.py`, which refuses non-v1 execution contracts (`:263`), and `research-contract-v2.js`.

### 6.2 Hash identities under the recommended path

The recommended path changes `research_engine.py`, `quant-research.js`, `runtime-engine-files.js`, `trace-reproduction.js` and `quant-library.js`, and adds the v3 module.

| Identity | Rotates | Changed members that rotate it |
| --- | --- | --- |
| `engineHash(false)` (legacy research) | Yes | `research_engine.py` |
| `engineHash(true)` (foundation research) | Yes | `research_engine.py`, `quant-research.js`, `runtime-engine-files.js`, new v3 module |
| `fixed-eval-closure-v1` | Yes | as foundation |
| `mp-combined-closure-v1` | Yes | as foundation |
| ingestion | Yes | as foundation |
| PF-2 engine | Yes | as foundation |
| PF-2 evaluator | No member changed; the FE-2b plan requires this to be demonstrated, not assumed (`docs/FE2B_RELEASE_PLAN_DRAFT.md:68`) | none |
| `trace-reproduction-closure-v1` | Yes | `research_engine.py`, `trace-reproduction.js` |
| `mp-package-trace-closure-v1` | No | none |

Seven of nine identities rotate. Even without the Python change, the edit to `quant-research.js` alone rotates five. Optional changes (Q1 rename, R3 gate reads, Q4 surfaces) add no new identity beyond this set, except that a change to `src/pine-bridge/source.js` also rotates TRACE, MP_COMBINED and PF2_ENGINE through that file.

### 6.3 Release consequences that the FE-2b plan must cover

The FE-2b plan already requires a before/after identity manifest for every closure family, an engine compatibility matrix and an owner choice of drain or cancel for affected old jobs (`docs/FE2B_RELEASE_PLAN_DRAFT.md:61-72`, `:92`, `:103`, `:115`). The v3 change adds these consequences, per family:

| Family | In-flight work at the change | Stored runs and replay |
| --- | --- | --- |
| Legacy research (`engineHash(false)`) | Queued or running jobs fail `QUANT_ENGINE_CHANGED` at run entry, before evaluation or before checkpoint commit (`quant-research-worker.js:75`, `:92`, `:103`) | Every stored v1 run fails S3 with `BI_ENGINE_HASH_MISMATCH` (`trace-reproduction.js:239`, `:268`; RC-35) |
| Foundation research (`engineHash(true)`) | Jobs fail `QUANT_ENGINE_CHANGED` (`src/postgres/quant-research-foundation.js:216`); the recovery check reports not current (`:100`) | Stored v2 rows keep their old hash. S3 does not reproduce v2 today (DEFERRED, J4); a later foundation replay faces the same mismatch |
| Fixed evaluation | Jobs fail `QUANT_ENGINE_CHANGED` (`src/postgres/quant-fixed-eval-worker.js:150`) | Stored results keep the closure they recorded; no rewrite |
| Multi-Pine combined | Runs stop `FAILED` with `QUANT_ENGINE_CHANGED` (`src/multi-pine/executor.js:311`) | Stored internal fixture runs can no longer build or attempt a package: the live combined hash must equal the run's `engine_hash` (`BI_ENGINE_HASH_MISMATCH`, `src/postgres/mp-package-store.js:28`, `:33`, `:57`) |
| Ingestion and profile | Recovery checks report not current (`src/postgres/quant-data.js:105`; `src/postgres/quant-profile.js:255`); enrollment tickets read the live ingestion hash (`src/postgres/quant-profile-wiring.js:37`) | Stored contracts keep their old hash |
| PF-2 preflight | Resume or replay refuses `PF2_ENGINE_HASH_MISMATCH` (`src/quant-research/preflight-replay.js:715-719`) | PF-3 readiness reports `HISTORICAL_ENGINE_CHANGED` for old evidence (`src/postgres/pf3-readiness-report.js:233`) |
| One-Pine trace reproduction | Not a queue | New S3 records carry a new `trace_engine_hash` |

Consequences in summary:

1. Every family above loses exact replay of runs stored before the change. OD-13 records this as a limitation that blocks exact replay only (CT:705); the release plan must state it per family. S3 serves labelled fixture packages only today (CT:450), and only fixture packages may exist until OD-21 (RC-38, CT:769).
2. The drain or quiet window covers every runtime queue, not the legacy queue only: legacy, foundation, fixed evaluation, multi-Pine, ingestion and profile, and PF-2.
3. If the v3 change ships in a release separate from FE-2b, each release rotates the identities again and needs its own before/after manifest and drain decision.

## 7. Test specifications for a later implementation

Specifications only; no test exists or runs in this slice. Node pure tests run locally. PostgreSQL tests run in CI or a throwaway cluster under existing rules.

Existing pins that the change breaks. Each must be updated in the implementing slice with an old/new hash or old/new value inventory, never by a blanket rerun:

| Pin | Location | Why it changes |
| --- | --- | --- |
| BASE_HASHES LEGACY, FOUNDATION, FIXED_EVAL | `test/trace-reproduction-closure.test.js:165-177` ("Update only with an authorized engine change") | Section 6.2 |
| BASE_HASHES legacy, foundation, ingestion, pf2_engine, pf2_evaluator, fixed_eval | `test/mp-engine-closure.test.js:24-32`, asserted at `:181-189` ("Update only with an authorized engine change and an old/new closure inventory") | Section 6.2; `pf2_evaluator` must stay equal |
| Runtime import closure and pinned manifest members | `test/quant-engine-files.test.js:26-37` | The v3 module joins the manifest (section 6.1) |
| C5 literal versions, ACTIVE pin and closure table | `test/trace-reproduction-closure.test.js:181`, `:185`, `:198-203` | v3 moves from DEFERRED to ACTIVE |
| C5 rename probe mutants M20 and M21 | `test/trace-reproduction-closure.test.js:223-228` | M20 drops the DEFERRED v3 key, which no longer exists; M21 asserts v3 is not ACTIVE. Both must be rewritten against the new tables |
| B6 profile tables | `test/quant-library-trace-reproduction.test.js:333-342` | Two ACTIVE keys, two DEFERRED keys |
| B6b no shape dispatch | `test/quant-library-trace-reproduction.test.js:344-353` | Its v3 relabel case expects UNSUPPORTED; with v3 ACTIVE that case reproduces in S3 and moves to V3-P13 |
| B6c check order | `test/quant-library-trace-reproduction.test.js:355-371` | v3 with a broken plan becomes `BI_PROVENANCE_UNRESOLVED`; v3 with `execution_backend` stays UNSUPPORTED; the new closure check gets a pinned place |
| B6 refusal codes | `test/quant-library-trace-reproduction.test.js:284-288` | Only if R2 picks a new refusal code |
| defaultPorts tests | `test/quant-library-trace-reproduction.test.js:933-971` | They call `defaultPorts()` without a closure, and `:938` pins the exact key set of the ports object |
| Injected test ports | `test/quant-library-trace-reproduction.test.js:135-144` (`makePorts`) and `test/trace-reproduction-closure.test.js:332` | These ports carry no closure text, so the rule 3 `checkPorts` refusal would reject them; each needs the closure text of the profile it exercises |

Pure (Node, no database):

| ID | Specification |
| --- | --- |
| V3-P1 | The v3 validator accepts the exact key set and refuses an extra, missing or renamed key, an `execution_backend` key (null included), and a v1 or v2 version string |
| V3-P2 | `acceptance_blockers` must equal exactly the two candidate evidence blockers; `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED` or an unknown code refuses (OD-3) |
| V3-P3 | `policy_hash` must be 64 lower-case hex and equal `snapshot.policy_hash`; `policy_version` must be non-empty text (OD-12) |
| V3-P4 | G7: v3 with `RESEARCH_CANDIDATE_PENDING_ACCEPTANCE` gives PASS; v3 with any other reason gives `OWNER_RECOMMENDATION_NOT_READY`; v1 and v2 with the PASS reason still fail; a supplied `owner_recommendation_ready:true` changes nothing (OD-18, CT:811-812) |
| V3-P5 | B0 on a v3 fixture run: no `BI_CAPABILITY_BLOCKER_PRESENT`, no G7 code, no `BI_BINDING_INCOMPLETE` from a missing policy field |
| V3-P6 | S3 tables: ACTIVE is exactly v1 and v3; DEFERRED is exactly v2 and multi-v1; both frozen, disjoint, literal. Replaces the pins at `test/quant-library-trace-reproduction.test.js:333-342` and `test/trace-reproduction-closure.test.js:181`, `:198-203`, and rewrites mutants M20 and M21 (`:223-228`) |
| V3-P7 | C5 classification still covers every G7-listed version and the multi-Pine version; the rename probe still reports a renamed placeholder as unclassified (`test/trace-reproduction-closure.test.js:187-196`, `:216-233`) |
| V3-P8 | No shape dispatch: a v1-labelled contract that also carries the v3 fields dispatches as v1 by version alone and still fails G7 at B0; a v3 contract with `execution_backend` is UNSUPPORTED before any port call (B6b keeps its multi-v1 and v2 cases, `test/quant-library-trace-reproduction.test.js:344-353`) |
| V3-P9 | Closure-bound ports: `defaultPorts({closure:'engineHash(false)'})` uses `engineHash(false)` and carries the closure text; an unknown closure name throws; ports without the text fail `checkPorts`; v1-closure ports with a profile that names another closure refuse before any port call and before any engine-hash read, with no output; the new check's place in the B6c order is pinned |
| V3-P10 | Engine-hash drift: a changed legacy closure file refuses a v3 reproduction with `BI_ENGINE_HASH_MISMATCH` and no output |
| V3-P11 | Python engine accepts v3 with the agreed scope, refuses unknown versions and scopes, and returns byte-identical step results for a v1 and a v3 contract that differ only in version, scope, policy fields and `acceptance_blockers` (three codes against two). Each step result still carries `owner_recommendation_ready: False` (`research_engine.py:67`) |
| V3-P12 | `familyOf` classifies v3 as LEGACY; library listing shows the v3 version text |
| V3-P13 | Relabel without shape check: the v1 fixture relabelled v3 with the contract hash recomputed (capability blocker frozen, no policy fields; the test binding is derived from that relabelled contract, so it carries no policy fields either) reproduces in S3, and B0 refuses it with `BI_CAPABILITY_BLOCKER_PRESENT` and `BI_BINDING_INCOMPLETE` |
| V3-P14 | Import closure: with the v3 module imported by `quant-research.js` and listed in `QUANT_RUNTIME_ENGINE_FILES`, `test/quant-engine-files.test.js` passes; with the manifest entry removed it fails with "unhashed dependency" naming the module |
| V3-P15 | Closure identity inventory: a script over the release bytes reports the nine identities in section 6.2 before and after; exactly the seven listed rotate, and PF-2 evaluator and MP package trace stay equal |
| V3-P16 | Request selection (after R5): the chosen selector yields v3 only when requested or required; under a request key, the same idempotency key with another version refuses `IDEMPOTENCY_CONFLICT`, and a v1 body without the key keeps its submission hash |

PostgreSQL (CI or throwaway cluster, one file per process):

| ID | Specification |
| --- | --- |
| V3-G1 | Admission writes one v3 row only when the capability reader reports the source registered; absent, unreadable or "not registered" refuses with no row and no audit event |
| V3-G2 | One real stored v3 fixture run executed by the legacy worker reaches `SUCCEEDED` with the PASS reason, then reproduces through S3 with digests equal to the stored steps (acceptance named at `f09-build-worker/README.md:21`, `:65`) |
| V3-G3 | Existing v1 admission, worker and S3 suites, and the foundation, fixed-evaluation, multi-Pine, ingestion and PF-2 suites, stay green after the change. The only allowed expected changes are the pins listed above, each with its old and new value |
| V3-G4 | Terminal v3 rows are immutable under the freeze trigger (CT:95-98) |
| V3-G5 | Every importer of each changed file is found with `git grep` and its tests run before commit |
| V3-G6 | In LEGACY executor mode a v3 request is admitted and run; in FOUNDATION mode it is refused with `RESEARCH_EXECUTOR_MODE_MISMATCH` or, at the worker, `RESEARCH_FOUNDATION_WORKER_REQUIRED`, and no v3 row runs |

## 8. Questions

Owner questions:

- Q1. Final name of the next research contract version. Recommendation: keep `ql3a-research-job-v3`.
- Q2. Scope name for a real (non-fixture) v3 run. The engineering scope forces `fixture = true` (`package-gates.js:738-739`; CT:170).
- Q3. Source and value of `policy_version` (OD-12), both at admission and in the current-state reader that freshness compares against (`package-gates.js:755-759`, called at `:790` and `:896`). No deployment snapshot field carries it today; QR-4 scopes carry a `policy_version` (`src/selection/registration.js:52`), which could be a model.
- Q4. What registers the customer quant capability that clears `CUSTOMER_QUANT_CAPABILITY_NOT_REGISTERED` at admission. Candidates: the source-analysis `quant_capability` (`src/pine-bridge/source.js:72`, passed through at `src/postgres/pine-bridge-worker.js:58`), the deployment readiness `quant_capability` (`src/postgres/pine-bridge-readiness.js:57`), the facts legacy admission already checks (`quant-research.js:80-82`), the multi-Pine `quant_capability` record shape (`src/multi-pine/member-admission.js:195-199`), or a new registry. Each existing surface sits in different closures (section 6.1). Until one exists, no real v3 run can be admitted (CT:280-283).
- Q5. Backend for v3: legacy inline bars (recommended first, 10,000-bar cap) or the foundation backend (needs the deferred foundation trace slice, JUDGEMENT J4). The legacy backend runs only in LEGACY executor mode, so a deployment cannot run legacy-backend v3 and foundation v2 research in one service mode (section 2).
- Q6. OQ-1 / OD-21: holdout content of the trace files (`docs/design/f09-trace-repro/JUDGEMENT.md:283-286`, `:314-319`; RC-38 at CT:769). Still open; it gates any non-fixture package, not this draft.
- Q7. Acceptance of the release consequences in section 6.3 for every affected family: seven of nine closure identities rotate; in-flight legacy, foundation, fixed-evaluation, multi-Pine, ingestion and profile, and PF-2 work fails its engine check at the change unless drained or cancelled; stored runs of every family lose exact replay (OD-13), including stored v1 runs in S3 and stored multi-Pine fixture runs at package build and attempt; and PF-2 evidence reports a historical engine.
- Q8. Whether v1 admission continues after v3 exists. This draft proposes no change to v1.
- Q9. Whether the `policy_hash` equality rule (section 3) satisfies OD-12. OD-12 names the new explicit field as the source (CT:157, CT:704); under the equality rule the bytes are equal but C3 still reads the hash from `snapshot.policy_hash` (`package-gates.js:607`, `:658`). If not, R3's alternative applies.

Root questions:

- R1. Adopt the shared `engineHash(false)` closure for v3, or require a separate closure.
- R2. Closure-bound ports as in section 4, rule 3, and the refusal code for a closure mismatch (existing `TRACE_REPRODUCTION_UNSUPPORTED` or a new code).
- R3. Keep `policy_hash` equal to `snapshot.policy_hash` (no gate edit), or move the gate reads to the top-level field. The alternative edits `package-gates.js`, a member of six runtime-family closures, and so needs the same FE-2b plan and owner GO (section 6.1).
- R4. Which slice owns the capability registry reader, its refusal code and its location; a location imported by `quant-research.js` joins the runtime manifest.
- R5. How a request selects v3: an optional request key inside the submission hash, or v3 replacing v1 for new admissions (with Q8). A selector outside the body is not recommended (section 2).

## 9. Non-claims

- This draft claims no PM-1 credit. F09 stays OPEN.
- No profile is promoted. The S3 tables, the G7 list and every pin stay as they are.
- No v1 contract is rewritten to v3, and no stored contract, run, result or evidence is edited (`f09-build-worker/README.md:19`; RC-35).
- No gate is weakened and no passing gate is injected. G7 stays derived from the completion reason and the contract version only.
- No G7 PASS, no S3 reproduction of v3, no S4 success, no B0 pass and no qualified package is claimed. No test was written or run.
- The closure-membership matrix is a design inventory computed from the lists in the checkout named in section 6.1. It is not a release identity manifest; the FE-2b release candidate must derive its own from the exact release bytes (`docs/FE2B_RELEASE_PLAN_DRAFT.md:61`).
- No engine-closure file, runtime file, schema, host or deployment is changed or authorized. Each change named above needs the FE-2b release plan and an owner GO (RC-35, CT:766; `docs/FE2B_RELEASE_PLAN_DRAFT.md:45`).
- OQ-1 / OD-21 stays an open owner question. Only fixture packages may exist until it is decided (RC-38).
