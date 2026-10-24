# QR-2 S5-4 Stage 3B (O6): coverage response wiring

Status: **PREPARED; NEEDS OWNER GO NAMING O6; NOT STARTED**. No implementation, test run or acceptance has happened. Root must not dispatch this packet until the owner gives the GO described in the first section. Spot/Paper only. No deployment, route activation, target contact or production budget selection.

## Authority: explicit owner GO naming O6 required

O6 changes two public response contracts: the per-Bot body gains `market_data.coverage` and the owner body gains `market_coverage`. The relevant records are:

- The owner's chat grant of 2026-10-24 gave continuous local work and a continuous GO. The Roadmap records it as "granted continuous local work" (ROADMAP.md:3).
- When root adopted Stage 3A under that grant, root recorded its own interpretation of the grant's limits: "Root adopted this slice under that authority, which covers bounded local engineering only. It does not cover the C3 or PostgreSQL runtime, target contact, or public response wiring." (QR2_S5_4_STAGE3A_PUBLIC_COVERAGE_PACKET_2026-10-24.md:3). The same packet says: "Wiring into the response validators and worker (O6) and the EN/TH UI with local rendering (O7) each need their own packet. Public response wiring is excluded from tonight's authority." (:15). These lines are root's recorded interpretation, not owner text. They bind root until the owner speaks.
- The S5-4 design: "These later stages need exact packets and independent acceptance; their numerical budgets are not set by this document." (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:63)
- The owner's S5-1 GO excluded response contract changes: "Consume the existing per-Bot and owner GET responses. Do not add a backend route, change response contracts, change server flags or weaken admission/authentication." (QR2_S5_1_LOCAL_UI_GO_PACKET_2026-10-22.md:18). S5-3 repeats this: "Use only existing public response fields and codes. Do not add a backend field" (QR2_S5_3_LOCAL_VERIFICATION_PACKET_2026-10-23.md:9).
- Stage 2C C1: "public response changes require separate root dispatch" (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:102).
- AGENTS.md: "Root issues a GO only within explicit owner authority", and "Do not infer authorization to complete every project phase unattended from this standing delegation policy."

Evidence that points the other way:

- The S5-4 design states that "The owner's continuous local Roadmap GO of 2026-10-23 authorizes this bounded continuation" (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:3), and Stage 3 publication is part of that design (:59).
- The owner-decided contract requires bar gaps in the report range to be listed as intervals in the response (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:493), and S5 is the slice that delivers it (:510).

**Determination.** Root still requires an explicit owner GO that names O6, because public response wiring changes the API contract and root's own recorded limit excludes it. The owner's broad words "continuous work" and "continuous GO" are not reread as covering O6. The only alternative to the suggested GO below is a new owner statement in chat, made after this packet, that names O6 or public response wiring; root must then quote and record that statement in this packet before dispatch. All O6 effects stay local: routes stay disabled in every environment, and nothing is deployed. The GO is therefore a contract-scope decision, not a host or target decision.

Suggested owner decision: **GO QR-2 S5-4 O6 local coverage response wiring as scoped in this packet: `market_data.coverage` in the per-Bot body and `market_coverage` in the owner body, with `market_coverage` optional in the owner validator until O7, and a one-line exclusion of both coverage keys from the generic metadata view in `public/paper-performance.js`. Focused unit tests locally, PostgreSQL regression in exact-revision CI only, independent review, a mutation pass and periodic commit/push. No rendered check, demonstration or deployment between O6 and O7. No deployment, route activation, target contact or budget selection.**

## Purpose and position

Contract section 11 requires bar gaps in the report range to be listed as intervals (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:493). Stage 2C reads one coverage registry per request and validates it once in the worker, but it publishes nothing (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:35). Stage 3A added the pure, unwired projection `projectPublicCoverage` and the closed validator `validateOwnerCoverage` (src/portfolio/qr2-coverage-public.js:60, :105). O6 connects that projection to the worker and the two response composers and validators.

O6 adds no rendering. Its only UI change is the exclusion line that keeps raw coverage out of the generic metadata view. O7 owns the EN/TH rendering and the local desktop and mobile check that S5 acceptance needs (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:510). O6 earns no PM-1 credit and does not close full S5.

## Root rulings recorded

1. **GO.** Open. An explicit owner GO naming O6 is required (Authority section).
2. **Validator strictness.** `market_coverage` stays optional in `validateOwnerResponse` until O7 updates the UI fixtures. O6 does not edit `test/fixtures/qr2-performance-ui/responses.json`.
3. **Owner route mapping.** No owner route amendment. The owner route maps a worker `kind:'qr2'` result to 503 `QR2_REPORT_FAILED`. That outcome is reachable only through the test seam and is recorded here.
4. **Unresolved owner range.** When the owner range is null, the owner body omits `market_coverage` entirely. This keeps the GAP :59 rule that the coverage mapping matches the existing account list, and it publishes no member identity in a branch whose `accounts` list is empty.
5. **Per-Bot refused body.** A refused per-Bot body publishes no coverage, while the owner body keeps the mapping of a refused, non-propagated member. The asymmetry keeps the RC-Q26 and RC-Q32 refusal shape exact.
6. **O6 and O7 sequencing.** O6 includes the one-line exclusion of the coverage keys from the generic metadata view in `public/paper-performance.js`, so no raw coverage dump can appear between O6 and O7. No rendered check, demonstration or deployment happens between O6 and O7.

The owner gave the GO naming O6 on 24 October 2026 (Bangkok). Root recorded these rulings after the implementation review:

7. **Import assertion amendment.** The coder stopped on one existing assertion that this packet did not name: the exact import list of `src/portfolio/qr2-coverage-public.js` in `test/qr2-coverage-public.test.js`. `validateOwnerCoverageShape` needs `QR2_COVERAGE_LIMITS`, so the list gains `./qr2-coverage-limits.js`. That module is pure, is already in the test's allowed set and is already imported by the worker. Root amends the packet to name this one replacement. The guard is not weakened, and duplicating the numeric limits was rejected.
8. **Fix round for test gaps.** The mutation pass left one boundary gap (an interval count of exactly 4097 at the composer) and three mutants that only the out-of-repo oracle killed (the worker's null-range omission, duplicate shape entries, and an interval sum of exactly 4097 in the shape validator). One test-only fix round adds unit cases for all four. It also applies two auditor wording items: the old-seam assertion uses the literal old seam, and the owner leak walk in the PostgreSQL integration test is owner-only. Product sources do not change in this round.
9. **Stale source comment deferred.** The comment in `src/portfolio/qr2-coverage-public.js` that says no worker, route or UI imports the module is no longer true. A Stage 3A test strips that line before scanning the source, so rewording it belongs to O7, together with that test.
10. **Second opinion.** The owner GO makes this a GO packet, so a second independent Opus 5.5 / high architecture auditor substitutes for the paused Fable 5.1 second opinion on the final diff, as the reviewer panel below requires.
11. **Owner-independent test file.** The ownership row for `test/qr2-owner-independent.test.js` lists fixture changes only, while T2 assigns new cases to that file. T2 governs: the new case added there is in scope.
12. **Timing observation.** The recorded observation covers `validateOwnerCoverageShape` on a maximum envelope (median 5.2 ms, maximum 9.5 ms over 50 runs). The rest of `validateOwnerResponse` and the event-loop bars were not measured; O7 measures them before any rendered check.

Carried to O7 from the O6 reviews, none blocking: make `market_coverage` mandatory in `validateOwnerResponse` with the UI fixtures (ruling 2); update the stale comments in `src/portfolio/qr2-coverage-public.js` (with its Stage 3A scan test) and in the header and `kind:'qr2'` JSDoc of `src/postgres/qr2-compute-worker.js`; add a test that composes an owner response from a passed-in envelope with the snapshot coverage removed, so the single-validation rule cannot regress silently; add a worker-level null-range owner case with admitted members; pin the agreement between the reader's admission cutoff and the allocation cutoff with a test; and record digests that do not depend on working-tree line endings.

## Ownership

One coder may write only these paths:

| Path | Change |
| --- | --- |
| `src/postgres/qr2-compute-worker.js` | Project coverage once, map its outcome, pass it to the composers and check the composed bodies. |
| `src/portfolio/qr2-response.js` | Accept the `coverage` option, add `market_data.coverage` and its closed checks. |
| `src/portfolio/qr2-owner-response.js` | Accept the `coverage` option, add top-level `market_coverage`, its composition and its closed validation. |
| `src/portfolio/qr2-coverage-public.js` | Additive only: the exports `validateOwnerCoverageShape` and `projectPublicCoverageOutcome`. Existing exports keep their exact behavior. |
| `public/paper-performance.js` | One line: exclude `market_coverage` and `market_data.coverage` from the generic metadata view. |
| `public/index.html` | The `paper-performance.js` cache token only: `?v=qr2s53` becomes `?v=qr2o6`. |
| `test/asset-cache-tokens.test.js` | The `/paper-performance.js` `PINNED` entry only: the new token and the new digest. |
| `test/qr2-performance-ui.test.js` | One new case for the exclusion line. Existing assertions and the fixture file stay unchanged. |
| `test/qr2-response.test.js` | New coverage cases. Existing assertions stay unchanged. |
| `test/qr2-owner-response.test.js` | Coverage registry fixtures and new cases. |
| `test/qr2-owner-independent.test.js` | Coverage registry fixtures only where composition now needs them. |
| `test/qr2-compute-pool.test.js` | The named assertion replacements below and new worker wiring cases. The bare-import guard assertion stays unchanged. |
| `test/qr2-coverage-public.test.js` | Cases for the additive exports only. The 28 existing tests stay unchanged. |
| `test/postgres/qr2-compute-http.test.mjs` | The named assertion replacement below only. |
| `test/postgres/qr2-coverage-financial.test.mjs` | The named assertion replacement below only. |
| `test/postgres/qr2-coverage-integration.test.mjs` | The named assertion replacements below only. |
| an assigned ignored report directory | Author report and raw local logs. |

Root owns this packet, the evidence record, the Roadmap and Time Management notes, integration, Git and acceptance.

Read-only for every role:

- `src/postgres/qr2-routes.js`, `src/postgres/qr2-owner-route.js`, `src/postgres/qr2-compute-pool.js`
- all readers, including `src/postgres/qr2-coverage-reader.js`
- `src/portfolio/qr2-coverage.js`, `src/portfolio/qr2-coverage-snapshot.js`, `src/portfolio/qr2-coverage-limits.js`, `src/market-gap-intervals.js`, `src/portfolio/qr2-allocation.js`, `src/portfolio/qr2-labels.js`
- everything under `public/` except the two lines named above, i18n, schema, migrations and authentication
- `test/fixtures/qr2-performance-ui/`
- every other test

### Named assertion replacements

O6 must change these existing assertions. Each replacement is exact in intent; the coder keeps the surrounding test unchanged.

- **`test/postgres/qr2-compute-http.test.mjs:102-111`.** Today `direct` and `cloned` are composed without coverage and `stable(viaWorker.body)` must equal `stable(direct)`. Replacement: compute `coverage` as the `market_data.coverage` of the `projectPublicCoverage(snapshot.coverage, input.coverage_context).accounts` entry whose `(bot_id, broker)` equals the request. Compose `direct` and `cloned` with `{requestTime, coverage}`. Keep the `stable(viaWorker.body)` equals `stable(direct)` assertion, and add one assertion that `viaWorker.body.market_data.coverage` deep-equals `coverage`.
- **`test/qr2-compute-pool.test.js:130` and `:137`.** The parity loop composes `direct` without coverage. Replacement: compose `direct` with the projected account coverage obtained by the same rule. For the refused fixture the option is still passed and the body still has no `market_data`. The `stableResult` assertion at `:136` stays unchanged.
- **`test/qr2-compute-pool.test.js:209`.** The compose seam `()=>({status:'COMPLETE'})` expects `ok:true`. Under the worker post-check this body has no `market_data.coverage`, so it now gives `kind:'response'`. Replacement: the seam echoes its option, `(view,{coverage})=>({status:{status:'COMPLETE'},market_data:{coverage}})`, and the expected body is that object, with `body.market_data.coverage` identical (`===`) to the projected coverage. Add one assertion that the old seam `()=>({status:'COMPLETE'})` now gives `{ok:false,kind:'response'}`.
- **`test/qr2-compute-pool.test.js:211`.** The seam `()=>({})` is used to check that a missing findings array gives `[]`. Replacement: use the echo seam above with `compute:()=>({reader:{}})`, and keep the `auditFindings` deep-equal `[]` assertion.
- **`test/qr2-compute-pool.test.js:779`.** The check that the owner result JSON contains no `"coverage"` key no longer holds, because `market_coverage.entries[i].coverage` is published. Replacement: a recursive key walk over the result. It fails on any key named `coverage_context`, `coverage_window_id`, `coverage_input_bytes`, `coverage_output_bytes`, `budgets`, `unions`, `windows`, `bindings` or `charges` at any depth. It allows a key named `coverage` only at `body.market_coverage.entries[i].coverage` in an owner result and at `body.market_data.coverage` in an account result, and fails on `coverage` anywhere else.
- **`test/qr2-compute-pool.test.js:795`.** The source count of `validateCoverageSnapshot(` in the worker equals 1. Replacement: the worker source contains zero `validateCoverageSnapshot(` and zero `projectPublicCoverage(` call sites, and exactly one `projectPublicCoverageOutcome(` call site.
- **`test/postgres/qr2-coverage-integration.test.mjs:36` (`noInternalKeys`).** It forbids a key named `coverage` anywhere, which fails at `:47` on `market_coverage.entries[i].coverage`. Replacement: the same path-aware walk as the `:779` replacement, with the same forbidden list (this file also forbids `coverage_input_bytes` and `coverage_output_bytes` today; both stay forbidden).
- **`test/postgres/qr2-coverage-integration.test.mjs:47`.** Keep `actual.body` deep-equal `baseline.body`. Add one assertion that `actual.body.market_coverage` deep-equals `projectPublicCoverage(read.snapshot.coverage, read.input.coverage_context).owner.market_coverage`.
- **`test/postgres/qr2-coverage-financial.test.mjs:9` and `:85`.** `stableBody` today zeroes the two reader timers. Replacement: it also removes `market_data.coverage` from its copy, and the `:85` whole-body equality stays. Add two assertions: `first.body.market_data.coverage` deep-equals `coverageOf(before)` (COMPLETE with no interval), and `second.body.market_data.coverage` deep-equals `coverageOf(after)` (exactly one one-minute interval at the removed bar).

Leak guards stay strict. No guard is weakened beyond allowing `coverage` at the two published paths.

## Public keys added

### Per-Bot response

`market_data` gains one key, `coverage`, holding one `qr2-bar-coverage-v1` object with exactly the Stage 1 key set (src/portfolio/qr2-coverage.js:6). The existing keys `checked`, `table_present`, `instants`, `bars` and `gap` keep their meaning and values (src/portfolio/qr2-response.js:192-195). The scalar `gap` is not removed. The top-level allowlist does not change, because `market_data` is already allowed (src/portfolio/qr2-response.js:19-20).

- A non-refused body produced by the worker always carries `coverage`.
- A refused body has no `market_data` block today (src/portfolio/qr2-response.js:118-127). It gains no coverage. The refusal shape of RC-Q26 and RC-Q32 stays exact.
- The scalars `market_data.checked` and `market_data.gap` describe the valuation path only: whether the needed valuation instants had bars. They can disagree with `coverage`, which describes every bar in the inspected range (Stage 2C sets `checked:false` on member snapshots; test/postgres/qr2-coverage-integration.test.mjs:46). O6 adds no consistency rule between them. O7 must explain the scalar beside the coverage.

### Owner response

The owner body gains one top-level key, `market_coverage`, with the frozen Stage 3A shape (QR2_S5_4_STAGE3A_PUBLIC_COVERAGE_PACKET_2026-10-24.md, Owner envelope):

```
market_coverage:{
  version:'qr2-owner-bar-coverage-v1',
  entries:[{id:'coverage:<N>', coverage:<qr2-bar-coverage-v1>}],
  accounts:[{bot_id, broker, coverage_ids:['coverage:<N>']}]
}
```

- A non-REFUSED owner body with a non-null `resolved_range`, produced by the worker, always carries `market_coverage`. This includes the unavailable and undeclared branches.
- An owner body with a null `resolved_range` never carries it (root ruling 4). The worker still runs the projection, so a coverage failure still fails the request.
- A REFUSED owner body never carries it. That branch keeps header, status, code and counts only (src/portfolio/qr2-owner-response.js:30).
- Owner member rows in `accounts` gain no coverage key. The mapping is by ID only, and members never embed a duplicate coverage object.
- The closed owner `counts` schema and its ceilings do not change (src/portfolio/qr2-owner-response.js:25-27). No coverage counter, budget or charge is published (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:25).

## Worker wiring

`qualifyCoverage` currently validates the registry with one `validateCoverageSnapshot` call (src/postgres/qr2-compute-worker.js:74). O6 replaces that call with one `projectPublicCoverageOutcome(snapshot.coverage, context, coverageOutputLimit)` call. The projection runs `validateCoverageSnapshot` itself. The worker path therefore keeps exactly one full registry validation and builds each unique coverage entry exactly once. This settles Stage 3A root ruling 2 for the worker path.

1. All existing association checks in `qualifyCoverage` stay in their current order before the projection. The member reference check against `bindings` stays after it.
2. `qualifyCoverage` returns the projection. It still runs before any financial computation or owner composition (src/postgres/qr2-compute-worker.js:88).
3. **Outcome mapping.** Only the post-build byte admission refusal maps to `kind:'qr2'`. That refusal is raised by `admitSerializedBytes` after `validateCoverageSnapshot` has succeeded and the entries are built. `projectPublicCoverageOutcome` identifies it by where it is raised, not by error code alone, and returns `{refused:true}` for it; the worker then returns `{ok:false,kind:'qr2',code:'QR2_RANGE_ADMISSION_REFUSED'}` with no `detail`. Every other projection failure stays `{ok:false,kind:'other'}`. This includes a `QR2_RANGE_ADMISSION_REFUSED` raised by `planCoverage` for a context-level overflow (unique windows, ID length or minimum envelope; src/portfolio/qr2-coverage-snapshot.js:14, :164), which Stage 2C requires to use the report-failure path (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:33). Projection errors are plain `Error` objects from `coverageError`, not `Qr2Error`, so the existing `Qr2Error` branch (src/postgres/qr2-compute-worker.js:98) is not used for them.
4. **Account job.** Require exactly one projected account whose `(bot_id, broker)` equals the input. Pass its `market_data.coverage` to `composePerformanceResponse` as the `coverage` option. After composition, check the body: when `body?.status?.status !== 'REFUSED'`, `body.market_data.coverage` must be the same object (`===`) as the option; when the status is `REFUSED`, the body must have no `market_data`. A failed check, or any throw while checking, gives `{ok:false,kind:'response'}`. The check applies to the `compose` test seam too.
5. **Owner job.** Pass `projection.owner.market_coverage` (the inner envelope object, not `projection.owner`) to `composeOwnerResponse` as the `coverage` option. After composition, a non-REFUSED body with a non-null `resolved_range` must carry `market_coverage` that is the same object (`===`) as the option. A REFUSED body, or a body with a null `resolved_range`, must not carry it. Otherwise the job fails as `kind:'response'`.
6. A test-only `coverageOutputLimit` option of `executeQr2Job`, in its second (seam) argument beside the existing `compute` and `compose` seams, forwards a lowering-only limit to the projection. No route, query, environment or message field can set it. The worker listener never passes a second argument, so a `coverageOutputLimit` field in a message, at top level or inside `input`, has no effect.
7. Imports stay pure. The worker graph gains `src/portfolio/qr2-coverage-public.js`, which is pure; its own imports are already reachable. No package import is added. The bare-import list must still equal `decimal.js`, `node:crypto` and `node:worker_threads` (test/qr2-compute-pool.test.js:505). `Buffer` is a language global and needs no import.
8. The projection output is frozen (src/portfolio/qr2-coverage-public.js, `lock`). Composers place the frozen objects into new containers and never mutate them. Tests that build a negative case from a composed body clone it first. The pool result crosses `postMessage`, so the route receives unfrozen copies.

## Composer and validator changes

### `qr2-response.js`

- `composePerformanceResponse(view, {requestTime, coverage, build})` accepts an optional `coverage`. When it is absent, `market_data` keeps its current five keys, so existing direct callers and tests are unchanged. Owner member composition passes no coverage, because member bodies are never published. The worker never omits it (Worker wiring, step 4).
- Coverage enters after `build`: the built non-REFUSED body's `market_data` must have exactly the five existing keys, and a built `coverage` key fails with `QR2_RESPONSE_INVALID`; only then does the composer add `coverage` to a copy of that `market_data` before validation. The `build` test seam therefore cannot bypass or pre-empt the coverage checks.
- The coverage rules apply to non-REFUSED bodies only, meaning `body.status.status !== 'REFUSED'`. With the option present, a REFUSED body ignores the option and must still have no `market_data`.
- For a non-REFUSED body with the option present, the body is invalid unless all of these hold:
  - `market_data` has exactly the five existing keys plus `coverage`
  - `market_data.coverage` is the same object (`===`) as the option
  - `validateBarCoverage(coverage).ok` is true
  - `coverage.resolved_range` deep-equals the header `resolved_range`
  - `coverage.market` is the supported identity only when `scope.broker` is `binance-global`, and is null otherwise
  - `coverage.interval_count` is at most `QR2_COVERAGE_LIMITS.output_intervals`
- When the option is absent, a non-REFUSED `market_data` must have exactly the five existing keys.
- Any failure throws the existing fixed `QR2_RESPONSE_INVALID`, with validation codes only and no coverage value.

### `qr2-owner-response.js`

- `composeOwnerResponse(snapshot, input, {compute, compose, coverage})` keeps its existing seams and gains the `coverage` option, which is the `market_coverage` envelope object. When the option is absent, the composer calls `projectPublicCoverage(snapshot.coverage, input.coverage_context).owner.market_coverage` itself. Direct calls therefore fail closed on a missing or corrupt registry, and a direct call equals the worker result (test/postgres/qr2-coverage-integration.test.mjs:47). The worker always passes the option, so the worker path validates once.
- The composer places `market_coverage` only into a non-REFUSED body whose `resolved_range` is not null.
- `validateOwnerResponse(body)` stays context-free, because the owner route calls it on the main thread with the body only (src/postgres/qr2-owner-route.js:43). It adds `market_coverage` to the closed key list as an optional key and checks these rules:
  - It is absent when `status.status` is `REFUSED`.
  - It is absent when `resolved_range` is null.
  - When present, `validateOwnerCoverageShape` passes.
  - When present, the set of `(bot_id, broker)` pairs in `market_coverage.accounts` equals the set of pairs in `body.accounts` rows that are not `NO_ACCOUNT` rows.
- The key stays optional in the validator until O7 (root ruling 2). The UI fixtures `owner`, `ownerTHB` and `ownerUndeclared` must keep validating (test/qr2-performance-ui.test.js:51), and those fixtures belong to O7. Presence is enforced by the composer and the worker instead. O7 may make the key mandatory when it updates the fixtures.

### Additive exports in `qr2-coverage-public.js`

`projectPublicCoverageOutcome(registry, context, outputByteLimit)` shares one internal implementation with `projectPublicCoverage`. It returns `{refused:false, projection}` on success and `{refused:true}` only for the post-build `admitSerializedBytes` refusal (Worker wiring, step 3). Every other failure throws exactly as `projectPublicCoverage` does. `projectPublicCoverage` keeps its exact Stage 3A behavior. If the shared implementation cannot be built without changing an existing export's behavior, the coder stops.

`validateOwnerCoverageShape(value)` works without context and returns `{ok, errors}` like `validateOwnerCoverage`. Its input is the `market_coverage` envelope object. It checks:

- closed keys at every level and the version string
- data-only plain objects and dense arrays, reusing the existing internal helpers
- at most `QR2_COVERAGE_LIMITS.unique_windows` entries and at most 20 accounts
- IDs `coverage:0` to `coverage:N-1` in order
- each entry coverage passes `validateBarCoverage`
- entries strictly increasing by market key (unsupported null first), then by numeric range with null first. Strict order also proves deduplication.
- the sum of `interval_count` is at most `QR2_COVERAGE_LIMITS.output_intervals`
- accounts strictly increasing by `bot_id`, then `broker`, by code-unit comparison
- each account holds exactly one ID that resolves to an entry, and every entry is referenced
- a referenced entry has a null market exactly when the broker is not `binance-global`

`validateOwnerCoverage` keeps its exact Stage 3A behavior. It may call the new check internally only if all 28 existing Stage 3A tests pass unchanged.

### Main-thread import graphs

`qr2-response.js` gains imports of `qr2-coverage.js` and `qr2-coverage-limits.js`. `qr2-owner-response.js` gains `qr2-coverage-public.js`; the coverage snapshot module and `market-gap-intervals.js` were already reachable from the owner route through the owner reader. All of these modules are pure and import no package. The worker bare-import assertion (test/qr2-compute-pool.test.js:505) stays the guard, and the full unit suite covers the static isolation tests.

### UI exclusion line (`public/paper-performance.js`)

After `delete metadata.account; delete metadata.total;` (public/paper-performance.js:154), one line removes `market_coverage` from `metadata` and replaces `metadata.market_data`, when it is an object, with a copy that has no `coverage` key. The line never mutates `body`. Nothing else in the file changes. The asset cache token for this file changes as listed under Ownership, because test/asset-cache-tokens.test.js pins the file digest.

## Account order reconciliation

This answers Stage 3A root ruling 5. `market_coverage.accounts` keeps registry binding order: `bot_id`, then `broker`, by code-unit comparison (src/portfolio/qr2-coverage-snapshot.js:84). The owner `accounts` rows are sorted by the same code-unit comparator, `bot_id` then `broker`, with `NO_ACCOUNT` rows using an empty broker (src/portfolio/qr2-allocation.js:76, :280). The non-`NO_ACCOUNT` rows therefore already appear in the same order.

The validator reconciles by set only. It imposes no new order on `body.accounts`, and the composer reorders nothing. A test asserts that the filtered `body.accounts` pairs equal the `market_coverage.accounts` pairs in order for the fixtures, and documents that this holds only because both sides use the same comparator.

## Refused-member rule

This answers the question Stage 3A left open (QR2_S5_4_STAGE3A_PUBLIC_COVERAGE_PACKET_2026-10-24.md, rule 5).

- **Owner response.** A member whose view is refused but does not refuse the whole owner keeps its mapping in `market_coverage.accounts`. Its coverage comes only from the registry window read independently for that verified, admitted account. It is never inferred from the refused summary (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:61; QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:60). The propagated refusals `QR2_CROSS_BOT_ROW` and `QR2_NON_PAPER_ROW` refuse the whole owner body (src/portfolio/qr2-allocation.js:68), so that body publishes no coverage.
- **Per-Bot response.** A refused body publishes no coverage, which keeps the RC-Q26 and RC-Q32 refusal shape exact. The worker still runs the projection before computation, so coverage failures fail the request even when the view later refuses.
- **Failure.** If valid coverage cannot be obtained, the whole request fails. Nothing fabricates coverage.

## Byte and budget handling and refusal codes

- The worker passes no lowering limit, so the effective limit is `context.budgets.coverage_output_bytes`. Those budgets are the provisional local/off envelope or a lowering of it (src/portfolio/qr2-coverage-limits.js:4-5). O6 adds no numeric constant and selects no production budget.
- `validateCoverageSnapshot` already guarantees that the registry upper bound is at most that budget. In production, the actual size can therefore exceed the effective limit only through an estimator defect. A refusal for a lowered limit is reachable only through the test seam.
- The projection measures the owner envelope and each `{market_data:{coverage}}` wrapper. The real `market_data` block has five more small keys, so the published block is slightly larger than the measured wrapper. O6 places no new limit on the whole body. A unit test records actual serialized body sizes at the 4096-interval synthetic maximum as an observation only.

| Condition | Internal code | Worker result | Per-Bot route | Owner route |
| --- | --- | --- | --- | --- |
| Invalid context, association or corrupt registry | `QR2_INPUT_INVALID` or `QR2_REPORT_FAILED` | `kind:'other'` (unchanged) | 503 `QR2_REPORT_FAILED` | 503 `QR2_REPORT_FAILED` |
| Context-level overflow raised by `planCoverage` | `QR2_RANGE_ADMISSION_REFUSED` | `kind:'other'` | 503 `QR2_REPORT_FAILED` | 503 `QR2_REPORT_FAILED` |
| Actual size above the estimate (estimator defect; root stop condition) | `QR2_REPORT_FAILED` | `kind:'other'` | 503 `QR2_REPORT_FAILED` | 503 `QR2_REPORT_FAILED` |
| Actual size within the estimate but above a lowered limit (test seam only) | `QR2_RANGE_ADMISSION_REFUSED` | `kind:'qr2'`, code only, no detail | 422 with no detail | 503 `QR2_REPORT_FAILED` (route read-only; root ruling 3) |
| Composer, validator or worker post-check rejects coverage | `QR2_RESPONSE_INVALID` | `kind:'response'` | 500 `QR2_RESPONSE_INVALID` | 500 `QR2_RESPONSE_INVALID` |
| Owner route revalidation fails | none | none | none | 500 `QR2_RESPONSE_INVALID` (existing) |

No new code is added, and `QR2_ERROR_TEXT` does not change. Error objects and details carry fixed codes only, with no coverage data, account metadata or counts (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:62). Coverage never changes a price, valuation or financial field.

## Backward compatibility

- **Per-Bot body.** The only change is one nested key inside an existing block. The top-level allowlist and every existing value are unchanged. The existing test that asserts five `market_data` keys (test/qr2-response.test.js:207) does not pass coverage and stays valid.
- **Owner body.** The change is one new top-level key. `validateOwnerResponse` accepts bodies with and without it, so the existing UI fixtures still validate.
- **Current UI.** `public/paper-performance.js` accepts unknown keys, because its numeric check passes objects without a `value` key. It renders all remaining body metadata through a recursive generic tree (public/paper-performance.js:77, :152-155). Without the O6 exclusion line, a body carrying real coverage would show raw coverage objects with up to 4096 interval rows and no EN/TH explanation of partial candles or of the four inspection states (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:17, :63). The exclusion line prevents that, so the current UI shows no coverage at all between O6 and O7. O7 renders coverage on purpose. Routes stay disabled in every environment, nothing is deployed, and no rendered check, demonstration or deployment happens between O6 and O7.
- **Main-thread cost.** The owner route revalidates the body on the main thread. That revalidation now includes the coverage structural check, which is bounded by 20 entries and 4096 intervals. O6 records one local timing observation. The RC-Q35 and RC-Q36 event-loop bars remain unmeasured.

## Tests

### Local (pure `node:test`)

These tests use no PostgreSQL, network, browser or child process other than the worker threads the existing pool tests already start. They use a 90-second process bound and one sole runner.

- **T1** (`test/qr2-response.test.js`)
  - coverage present and identical (`===`) to the option
  - coverage absent gives the legacy five keys
  - invalid coverage, range mismatch and market/broker mismatch
  - interval count above the maximum
  - an extra `market_data` key
  - a `build` seam that returns a body already holding a different coverage object is rejected
  - a refused view with the option present gives the exact legacy refusal body, with no `market_data`
  - no coverage value appears in the error
- **T2** (`test/qr2-owner-response.test.js` and `test/qr2-owner-independent.test.js`, registries built with `buildCoverageSnapshot`)
  - present on COMPLETE, PARTIAL, UNAVAILABLE and undeclared bodies with a resolved range
  - absent on REFUSED bodies
  - absent when the owner range is null, including the branch with admitted members; the validator rejects a null-range body that carries it
  - set reconciliation: a missing pair, an extra pair, and `NO_ACCOUNT` rows excluded
  - zero accounts
  - duplicate, orphan, unresolved and out-of-order entries and accounts
  - market/broker mismatch
  - the documented order equality
  - unchanged `counts` schema
  - a direct composer call without the option equals a call with the precomputed envelope
  - a missing registry throws
  - a refused non-propagated member keeps its mapping
- **T3** (`test/qr2-compute-pool.test.js`)
  - the named assertion replacements above
  - the account job body coverage deep-equals the Stage 1 `buildBarCoverage` result
  - the owner job carries `market_coverage` whose entries are shared by reference before cloning
  - the source-count check: zero `validateCoverageSnapshot(`, zero `projectPublicCoverage(`, one `projectPublicCoverageOutcome(` in the worker
  - the lowered-limit seam gives `kind:'qr2'` `QR2_RANGE_ADMISSION_REFUSED` with no detail, which the existing route mapping turns into 422 with no detail
  - a context-level overflow from `planCoverage` gives `kind:'other'`, not `kind:'qr2'`
  - an injected estimator defect gives `kind:'other'`
  - a corrupt registry gives `kind:'other'` before any compute call
  - a composer that drops coverage, or returns a different coverage object, gives `kind:'response'`
  - a refused account view passes the post-check with no `market_data`
  - a message carrying `coverageOutputLimit` at top level or inside `input`, sent through `executeQr2Job(message)` and through the real pool, behaves as if the field were absent
  - the result passes a structured-clone round trip
  - bare-import guard assertion unchanged
- **T4** (`test/qr2-coverage-public.test.js`) `validateOwnerCoverageShape` accepts every Stage 3A projection and rejects each rule violation. `projectPublicCoverageOutcome` returns the same projection as `projectPublicCoverage`, returns `{refused:true}` only for the post-build refusal, and throws for a context-level overflow. The 28 existing tests pass unchanged.
- **T6** (`test/qr2-performance-ui.test.js`, one new case) The test clones the existing owner and per-Bot fixtures in memory, adds a synthetic `market_coverage` and `market_data.coverage`, and renders them. The rendered text contains no `qr2-owner-bar-coverage-v1`, no `qr2-bar-coverage-v1` and no `coverage:0`, the existing `market_data` scalars still render, and the input bodies are unchanged after rendering. The fixture file is not edited.
- **T5. Regression.** Root runs every unit test that imports a changed module (found with `git grep`) in one sole-runner pass: `test/qr2-response.test.js`, `test/qr2-owner-response.test.js`, `test/qr2-owner-independent.test.js`, `test/qr2-compute-pool.test.js`, `test/qr2-coverage-public.test.js`, `test/qr2-performance-ui.test.js`, `test/asset-cache-tokens.test.js`, `test/mp-package-store-static-isolation.test.js` and `test/mp-run-store-static-isolation.test.js`. It also runs the four existing coverage suites and the full `npm test` unit suite once.

### CI only (PostgreSQL)

Local PostgreSQL is not started. The local Windows functional packet stays held under its 1 GiB headroom gate.

- `test/postgres/qr2-compute-http.test.mjs`, `test/postgres/qr2-coverage-financial.test.mjs` and `test/postgres/qr2-coverage-integration.test.mjs`: the named assertion replacements above.
- Unchanged regression: `test/postgres/qr2-route-http.test.mjs`, `test/postgres/qr2-owner-route.test.mjs`, `test/postgres/qr2-owner-compute.test.mjs` (its body checks are field-level only) and `test/postgres/qr2-owner-http-contention.test.mjs` (it drives both routes through the real worker). If either needs a change, the coder stops and requests a path amendment.

After root's serial commit and push to the permitted branch, root confirms on the exact revision that Safety checks and Quant Lab passed. Root reads the actual job and step results and the raw PostgreSQL log for the named tests, and infers no test counts. Results from separate checks are not added together.

## Exclusions

O6 does not include any of the following:

- edits to routes, the pool, readers, the coverage snapshot, limits or Stage 1 modules, allocation, labels, i18n, the UI fixtures, schema, migrations or authentication
- any `public/` edit other than the exclusion line and the cache token
- rendering of coverage, EN/TH text, or any rendered check, demonstration or deployment before O7
- new codes, counters, limits, budget constants or production budget selection
- a whole-body byte limit
- an owner route amendment
- PostgreSQL started locally, the C3 diagnostic or combined measurement, or performance claims
- target or host contact, VPS work, deployment, route activation, shared or target migration, Live, guard reset, Best Inputs apply or backfill

## Reviewer panel

The slice changes public financial response contracts and the worker, so it is treated as high-risk logic.

| Role | Model / effort | Scope |
| --- | --- | --- |
| Coder | Sonnet 5.5 / high | Owned paths, T1 to T4 and T6 |
| Tester | Sonnet 5.5 / medium | Independent oracle in an ignored directory: worker output against Stage 1 builds and owner reconciliation over seeded registries and owner fixtures, plus T5 |
| Mutation tester | Sonnet 5.5 / medium | One serialized mutation pass over `validateOwnerCoverageShape`, the owner set reconciliation, the per-Bot coverage rules, the worker post-checks and the outcome mapping. It never runs in parallel with a test-running reviewer on the same checkout. |
| Architecture auditor | Opus 5.5 / high | Contract shapes, single validation, outcome and refusal mapping, refused-member rule, redaction, import graphs, backward compatibility, UI exclusion line |

Fable 5.1 is paused by the owner. If root treats this slice as a GO packet, the planned Fable second opinion is replaced by a second independent Opus 5.5 / high architecture auditor, and root records the substitution. Otherwise no second opinion runs. A fix round re-verifies only the changed files, with one rerun of the affected suites. Root alone accepts.

## Stop conditions

The coder stops and returns to root on any of these:

- a needed change outside the owned paths, including any route or UI fixture
- ambiguous shape, order or set semantics
- an existing assertion that must change but is not named in this packet
- a bare-import guard change
- a second registry validation on the worker path
- an outcome mapping that needs an existing export's behavior to change
- any coverage value in an error
- an estimator defect observed in a test
- a financial value that differs in any regression

Original failures are preserved. No child dispatch, Git, browser or host work is allowed. Usage follows the AGENTS.md bands with the 3% reserve, as one short checkpointable wave after a fresh reading.

## Unchanged gates

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held; P13j held. Real authentication and target integration remain NOT RUN. Full S5, O7 rendering, combined performance and prototype completion remain OPEN. No deployment or target route activation.
