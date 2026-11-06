# F09-03 review, import and owner handoff contract

Status: ACCEPTED by Root as design revision 1 on 2026-11-06T07:40Z (ruling SB166), after an independent Opus review and a second review (READY_FOR_ROOT). Not a Roadmap change. Every owner decision in section 10 is OPEN and none is assumed; the Best Inputs apply lock stays closed (section 8). Not implemented. This contract grants no import, apply, Bot start, email or Live action by itself and alters no Risk Manager, Pine, route, table or configuration. Spot/Paper only; private acceptance NOT RUN; READY false. New choices are marked `[PROPOSED]`.

Feature: F09-03. Target: staging. It fills the two items the F09-01 contract defers to F09-03: the
start-new-Bot codes (QL:630 "Defined in F09-03") and the apply/start implementation contract (QL:681).
It reuses, and never weakens, the import guards of QL section 7.3 (QL:629).

## 0. Reading key

- Short names (paths relative to the repository root):
  - QL = `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (the F09-01 contract)
  - RM = `docs/ROADMAP.md`
  - PEX = `docs/PINE_EXPORT.md`
  - MP = `docs/MULTI_PINE_CONTRACT.md`
  - QR4 = `docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md`
  - R0 = `docs/R0_BASELINE_2026-09-24.md`
  - SC4 = `docs/progress/PM1_SCORECARD_S4_2026-11-05.json`
  - INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`
  - AG = `AGENTS.md`
  - REV = `.qa-local/l3-f09-contracts-2026-11-06/draft-contract-review.md`;
    AUD = `.qa-local/l3-f09-contracts-2026-11-06/audit.md`
- `file:line` cites the source of a carried requirement.
- `CODE:` marks a fact read from current code to learn interfaces. Code facts are not acceptance evidence.
- `[PROPOSED]` marks a new choice made by this draft. Root and the owner review each one.
- `OD-Fn` refers to an owner decision in section 10. Until the owner records it, the item stays open and
  the conservative state in this draft applies (feature locked, nothing written).

Scope guard for every rule below (AG:400-402; QL:29-31): Spot/Paper only, BINANCE:BTCUSDT Spot 1m,
reduce-only EXIT, no Live, no automatic optimizer or data-range loop, no guard reset, no automatic Best
Inputs apply, independent holdout gates. `NO_VALID_CANDIDATE` is a valid outcome.

## 1. Purpose and acceptance target

F09-03 acceptance: "The owner reviews a compatible validated package and explicitly imports or starts a
new Bot; no automatic apply or optimizer loop." Target: staging. (INV:383)

Scorecard S4 carries F09-03 at D UNKNOWN, I 0, V 0, T 0 (SC4:1338-1346). D rationale: "proposed workflow
lacks reconciled final contract review" (SC4:1348). Carry limitation: "Guarded apply contract is not
completed interface; no automatic apply or optimizer loop" (SC4:1359). Next action: "QL-4C validated
fresh package and explicit owner review/import" (SC4:1360). Root ruling SB163 (summary in the task brief):
no F09-03 contract existed; QL is the F09-01 contract and defers F09-03 (QL:11, QL:630, QL:681; AUD:15).

Phase placement:
- QL-4B exit gate: "guarded apply contract exist[s]; no owner-facing recommendation, outbox enqueue,
  policy change or Bot activation before QL-4C validation" (RM:2622).
- QL-4C exit gate: "For one Pine, only validated fresh exports become owner-visible/applyable" (RM:2623).
- APP-3B: "Multi-Pine owner review/apply/new Bot start unlock only after canary, workload and
  failure-recovery thresholds pass" (RM:2624).
- M5: "Build authenticated review/apply interface with explicit owner action, initially disabled until M7
  passes"; exit "no draft can change settings/start a Bot" (RM:2641).
- M7: "enable authenticated one-Pine review/apply ... and optional owner Bot start. Preserve old allocation
  exits during alert replacement" (RM:2643). "The initial owner apply/start gate covers only one Pine"
  (RM:2645).
- Workflow step 5: owner "may apply reviewed values and start the Bot again ... This workflow ends at the
  owner's decision/new Bot start" (RM:2566, RM:2568).

This contract defines:
1. The Bot-level Bridge Settings record, separate from hard Risk Policy (section 4).
2. The import interface: routes, request and response, confirm token, SERIALIZABLE write, double submit,
   session-state refusals, value equality, invariants and audit (sections 6.1 to 6.4).
3. STALE and `REPLAY_MISMATCH` refusal at import and at start (section 6.5).
4. The start-new-Bot request contract and codes (section 6.6).
5. The owner review UI rules (section 6.8).
6. The Best Inputs apply lock and the owner decisions that govern it (section 8).

### 1.1 Relation to F09-01, F09-02 and QR-4

- F09-03 consumes READY exactly as QL defines it: `READY = status EXPORT_VALIDATED AND fresh AND mode
  ONE_PINE AND fixture false AND requester owns the Bot` (QL:576-577). F09-03 never writes an export
  status; "Apply (F09-03) is an audit event referencing `export_id`, not a status" (QL:554).
- F09-02 email never imports or starts: "Email delivery alone cannot mutate Risk Manager settings or start
  a Bot" (PEX:118); "No action applies values or starts a Bot automatically, including after email
  receipt" (QL:637-638). An authenticated review link in an email (RM:2652) opens the review screen
  only.
- QR-4 selections never import, apply or start: refused `QR4_APPLY_REFUSED`; "Only the F09-03 action on
  the package, under the QL4 § 7.3 guards" (QR4:721). Selection registration authority is the same as
  the F09-03 import authority: owner only (QR4:984, OD-S18).

## 2. Current state

These facts limit what F09-03 can claim today.

1. No READY package can exist. No eligible candidate exists, G8 always fails and `QUALIFIED_TOTAL` is 0
   (QL:77-87). Any import or start today refuses with `BI_NOT_READY`.
2. CODE: the PF-4 confirmed save (`src/postgres/pf4-proposal-service.js:52-58, 181-212`) is the guarded
   write pattern QL reuses (QL:108-111): one SERIALIZABLE transaction, `BOT_ACCESS_DENIED` (403),
   `RISK_POLICY_FROZEN` while RUNNING or PAUSED, `STALE_POLICY_STATE` on a base-policy-hash change,
   `CONFIRMATION_REQUIRED`, two audit rows. Its confirm value is a fixed constant
   (`PF4_CONFIRM='SAVE_RISK_PROPOSAL'`, `src/postgres/pf4-risk-proposals.js:17`); it has no
   server-issued token, no expiry and no double-submit rule. Section 6.2 adds those.
3. CODE: the PF-4 routes (`src/postgres/pf4-proposal-routes.js:4-25`) run after the session, the own:write
   permission, the CSRF and origin checks and the bot selection, and accept only the `bot_id` query key.
4. CODE: the Bridge pair used at runtime lives in each deployment snapshot. The receiver verifies levels
   with `row.snapshot.selection.bridge.atr_multiplier` and `.rr` (`src/postgres/pine-bridge-receiver.js:33-34`).
   `pine_deployments.state` is one of `DRAFT`, `READY`, `EXIT_ONLY`, `REVOKED`
   (`src/postgres/pine-bridge-schema.sql:37-43`). No Bot-level Bridge Settings record exists in `src` or
   `public` (AUD:17).
5. CODE: activation (`src/postgres/pine-bridge-readiness.js:41-58`) refuses `NOT_FOUND`,
   `DEPLOYMENT_REPLACED` (REVOKED or EXIT_ONLY), `MULTI_PINE_REQUIRES_APP_3B` (more than one member),
   `BOT_STOPPED` (session not SETUP, RUNNING or PAUSED) and `RISK_EXCEEDS_POLICY`; it moves the previous
   READY deployment to `EXIT_ONLY` and writes audit `pine_bridge.activated`. An `EXIT_ONLY` deployment
   still accepts EXIT events (`src/postgres/pine-bridge-execution.js:12`).
6. CODE: Bot session states are `SETUP`, `RUNNING`, `PAUSED`, `STOPPED` (`src/postgres/db.js:167`).
   Transitions: SETUP run RUNNING; RUNNING pause PAUSED or stop STOPPED; PAUSED run RUNNING or stop
   STOPPED; STOPPED reset SETUP (`src/postgres/store.js:231-242`). The run route refuses a Bot without
   funded Paper capital (`src/postgres/server.js:359-361`).
7. CODE: no server source of "the Bot's permitted Bridge bounds" exists; the multi-Pine package service
   uses the frozen contract domains instead and says so (`src/postgres/mp-package-store.js:50, 166`).
   QL C4 and the QL import guard both name these bounds (QL:475, QL:629).
8. CODE: the Bridge selection validator accepts `atr_multiplier` and `rr` as numbers above 0 and at most
   1000 (`src/pine-bridge/source.js:93`); the template defaults are 2 and 1.5 (`source.js:75`; R0:11).
9. The F09-01 test plan already names two import checks: RUNNING gives `RISK_POLICY_FROZEN`, value
   difference gives `BI_APPLY_VALUE_MISMATCH` (QL:855-857). PAUSED is not tested there (AUD:17).

## 3. Definitions

- Bridge pair: the two Bridge values `atr_multiplier` and `rr`. ATR period stays 14 as versioned
  configuration, not a dimension (MP:193-195). "Only the Bridge ATR/RR pair maps to Bridge Settings on
  Bot Risk Manager; source inputs belong in Pine" (PEX:62; QL:634-635).
- Hard Risk Policy: the Bot risk policy, capital, counters and guards hashed by `policyHash`
  (CODE: `pf4-proposal-service.js:194`). Import never changes it (QL:629).
- Bridge Settings record: the Bot-level record of the owner's declared Bridge pair (section 4).
- Import: the explicit owner action that writes the package Bridge pair into the Bridge Settings record
  (QL:629, QL:634-635). It changes no deployment, no Pine and no hard policy.
- Start: the explicit owner action, separate from and after import, that activates a new deployment
  version carrying the imported pair and starts the Bot (QL:630; PEX:118; RM:2656).
- Handoff: import followed by an optional start. Starting ends the workflow; nothing schedules another
  optimization or a post-export Paper cycle (QL:639-640; RM:2566).
- F: the freshness tuple of QL:173-177 (current deployment for the Bot, source hash and version, Pine
  membership, policy version and hash, input lock hash, dataset availability).

## 4. Bot-level Bridge Settings record

### 4.1 Requirements carried

- "The Bot Risk Manager page displays Bridge Settings separately from hard Policy limits and Capital"
  (RM:2610). "Separate Bridge Settings from hard Risk Policy" (RM:2637, M1).
- "Bridge values stay independent from source inputs and hard policy; similar variables in user Pine are
  never rebound" (MP:196-197; R0:36, original SL/TP/RR "must not be rebound to the new Bridge pair").
- "One Bot-level Bridge ATR/RR pair applies to every member deployment" (MP:193).
- "A Bot-level Bridge Settings record ... is decided with APP-3B and F09-03 apply" (MP:203-204;
  OD-MP-6, MP:647). The text is not limited to multi-Pine (AUD:17). This section is the F09-03 half of
  that decision; the owner still decides it (OD-F6).
- "A RUNNING or PAUSED Bot's locked settings cannot be silently rewritten" (RM:2610).
- Owner review shows "the Bridge pair ... in Bot Risk Manager Bridge Settings separately from hard Policy
  limits and Capital" (QL:595-596).

### 4.2 Record shape [PROPOSED]

- One insert-only table, for example `bot_bridge_settings`, one row per version:
  `bot_id`, `version` (integer, 1 upward, unique per Bot), `atr_multiplier` and `rr` (positive canonical
  decimal strings, the RD-MP-48 string rule, MP:709), `atr_period` (fixed 14), `origin` (`IMPORT` only in
  this contract), `export_id`, `package_hash`, `actor`, `created_at` (ISO-8601 UTC, server clock).
- Current settings = the highest version for the Bot. Absent row = `NOT_SET`.
- Insert-only with the QR SQLSTATE plan: an edit is refused `QR002`, a write outside SERIALIZABLE is
  refused `QR003`, an insert precondition failure is `QR004` (QL:756, RC-25). The table joins the
  offline-extension inspection rules (QL:760-764, RC-29 to RC-33).
- RC-25 names a closed list of extensions and says "No other QR code is assigned" (QL:756). Adding
  this table, the confirmation table (6.2) and the handoff result table (6.2) to that plan needs a Root
  RC amendment that extends the list. No new QR code is proposed. Until Root records the amendment,
  these tables are a design only.
- Per-export serialization: RC-26 (QL:757) binds builder tables and adds "guards also serialize per
  export with a transaction advisory lock". F09-03 tables are not builder tables, so RC-26 does not
  bind them directly; this contract carries the same rule. Every import and start transaction first
  takes `pg_advisory_xact_lock(hashtextextended('robot:bi-handoff:' || export_id, 0))` (pattern
  CODE: `src/postgres/best-inputs-package-schema.sql:303`; `src/postgres/db.js:107-110`), then the Bot
  row lock (6.3 step 6). Fixed order: export lock, then Bot lock. The Bot row lock alone is not
  enough: it orders writes per Bot, but the one-start-per-export rule (6.6 step 7) and the replay answer
  (6.4) are per export. [PROPOSED]
- The record is not part of the hard policy and not part of `policyHash`. So an import never changes
  `policy_hash` and never makes the package STALE through `BI_POLICY_SNAPSHOT_MISMATCH`.
- The record is not part of F (QL:173-177). Section 6.3 step 7 guards a Bridge Settings change between
  preview and commit instead.

### 4.3 Relation to deployments [PROPOSED]

- An import never edits a deployment snapshot. The runtime pair stays the active deployment's
  `snapshot.selection.bridge` (section 2 item 4) until a start activates a new deployment.
- A start requires the new deployment's `snapshot.selection.bridge` to equal the current Bridge Settings
  pair and the package pair exactly (section 6.6).
- The Bot Risk Manager read shows both the current Bridge Settings pair and the active deployment pair,
  and flags `BRIDGE_SETTINGS_NOT_DEPLOYED` (display state, not an error) while they differ.

### 4.4 Single-Pine and multi-Pine [PROPOSED]

- Single-Pine: the record holds the one Bot-level pair. Import and start are allowed only under this
  contract's guards.
- Multi-Pine: the same record serves the Bot (MP:193). Before APP-3B every import or start on a
  multi-Pine Bot or package is refused with `MULTI_PINE_REQUIRES_APP_3B` (CODE: `pine-bridge-readiness.js:50`;
  RM:2624; QL:676). An `EXPORT_INTERNAL` package is never READY (QL:524). The F11-01 member-set
  `bridge_pair` and its equality gate `MP_BRIDGE_PAIR_DIVERGENT` stay as decided (MP:199-202); this record
  does not replace them. How an APP-3B release links the two is left to APP-3B (OD-F6).

## 5. States

### 5.1 Bridge Settings record

`NOT_SET` then `SET(v1)`, `SET(v2)`, and so on. Insert-only; no delete; no transition back to `NOT_SET`.
[PROPOSED]

### 5.2 Confirm token [PROPOSED]

| State | Meaning |
| --- | --- |
| `ISSUED` | Stored at preview; bound to its purpose and facts (6.2) |
| `CONSUMED` | One successful commit used it; the result row references it |
| `EXPIRED` | Derived at read: server time is past `expires_at` and not consumed |

A token is never reissued or extended. A refused commit does not consume it.

### 5.3 Handoff progress per `export_id` [PROPOSED]

Derived at read from the insert-only handoff result rows (6.2), never from audit events and never stored
as an export status (QL:554). Audit rows stay a record only; their refusal rows depend on OD-F11.
`NOT_IMPORTED` then `IMPORTED` (an `IMPORT` result row exists for the export and Bot) then `STARTED` (a
`START` result row exists; terminal for this export, QL:639-640). No transition leaves `STARTED`.

### 5.4 Session state matrix

| Session state (CODE: `db.js:167`) | Import | Start |
| --- | --- | --- |
| `SETUP` | Allowed under 6.3 guards [PROPOSED] | Allowed under 6.6 guards [PROPOSED] |
| `RUNNING` | Refused `RISK_POLICY_FROZEN` (RM:2610; QL:629) | Refused `BI_START_SESSION_NOT_SETUP` [PROPOSED] |
| `PAUSED` | Refused `RISK_POLICY_FROZEN` (RM:2610; QL:629) | Refused `BI_START_SESSION_NOT_SETUP` [PROPOSED] |
| `STOPPED` | Allowed (OD-F9) [PROPOSED] | Refused `BI_START_SESSION_NOT_SETUP`; the owner resets first as a separate action; start never resets [PROPOSED] |

## 6. Interfaces

All routes [PROPOSED]. Every action is authenticated, CSRF-protected under the existing API rules,
owner-scoped and audited (QL:620-622). Dispatch follows the PF-4 route rules: after the session, own:write
permission, CSRF and origin checks and the bot selection; one accepted query key `bot_id`
(CODE: `pf4-proposal-routes.js:4-25`). Method rule: the four write routes (import preview, import, start
preview, start) accept POST only; the read route accepts GET only; any other method gives
`METHOD_NOT_ALLOWED` (405) (CODE: `pf4-proposal-routes.js:20`). The read route needs the session and the
Bot owner check but no own:write permission and no CSRF token, like other owner reads. Route names are an exact-case
allow-list; any other name, a different case included, is refused (QR4:724-725 pattern). Foreign or
absent `export_id` gives `NOT_FOUND` (404); foreign Bot gives `BOT_ACCESS_DENIED` (403) (QL:622-623). A
hash or a confirm token is never authorization (QL:141); the session and the owner check are.

| Route [PROPOSED] | Purpose | Writes |
| --- | --- | --- |
| `GET /api/risk/bridge-settings?bot_id=` | Read current Bridge Settings, active deployment pair, `BRIDGE_SETTINGS_NOT_DEPLOYED` flag | None |
| `POST /api/quant/exports/{export_id}/import/preview?bot_id=` | Review screen data and, when allowed, a confirm token | Token row only |
| `POST /api/quant/exports/{export_id}/import?bot_id=` | Confirmed import | Bridge Settings version, token consumption, audit |
| `POST /api/quant/exports/{export_id}/start/preview?bot_id=` | Start checks and, when allowed, a confirm token | Token row only |
| `POST /api/quant/exports/{export_id}/start?bot_id=` | Confirmed start | Deployment states, session transition, token consumption, audit |

`export_id` path segment: a UUID (QL:126-129), matched like the existing deployment routes
(CODE: `src/postgres/pine-bridge.js:136`).

### 6.1 Import preview [PROPOSED]

Request body: `{}` (exact keys; any other key `INVALID_FIELDS`).

Response 200, READY package:
- `export_id`, `package_hash`, `binding_hash`, `created_at`, the QL 7.1 review fields (QL:587-596),
  Pine-only source inputs listed separately from the Bridge pair (RM:2652; QL:595-596).
- `bridge_settings`: `{version_before, pair_before, pair_after}` and the active deployment pair.
- `hard_policy`: `{policy_hash}` and a statement that it is unchanged by import.
- `import`: `{allowed, refusal_code, confirm_token, expires_at, consequences}`, the PF-4 preview shape
  (CODE: `pf4-proposal-service.js:135`). `confirm_token` and `expires_at` are present only when
  `allowed` is true.

Response for a non-READY package: status and codes only, no values, no token (QL:600-601, QL:607-608).

`allowed` is false, with the first refusal code, when the apply lock is closed (section 8), the session
is RUNNING or PAUSED, the package is not READY, the pair is out of bounds, the Bot is multi-Pine, or the
Bridge Settings already equal the package pair (`BI_IMPORT_NO_CHANGE`).

### 6.2 Confirm token issue and expiry [PROPOSED]

- Issued only by a preview whose `allowed` is true. Value: 32 random bytes, base64url. Stored only as its
  SHA-256 in an insert-only confirmation table, never in audit or logs.
- Bound at issue to: purpose (`IMPORT` or `START`), `owner_id`, `bot_id`, `export_id`, `package_hash`,
  package Bridge pair, the current hard-policy `policy_hash` read at preview (CODE: `policyHash`,
  `pf4-proposal-service.js:194`), current Bridge Settings version (or `NOT_SET`), digest of F as
  checked, and for START the target `deployment_id`. A preview issues a token only when READY holds, so
  the bound `policy_hash` equals the F field `policy_hash` of the package (QL:157, QL:174; source field
  OD-12, QL:704).
- `expires_at = issued_at + 10 minutes` by the server clock (OD-F8). Expiry is checked inside the commit
  transaction.
- Single use. A commit consumes it by inserting a result row with `UNIQUE(confirmation_id)`.
- The token proves only that the owner saw this exact preview. It is not authorization.
- Handoff result table [PROPOSED]: insert-only, one row per successful commit: `result_id`, `purpose`
  (`IMPORT` or `START`), `confirmation_id` (`UNIQUE`), `owner_id`, `bot_id`, `export_id`,
  `package_hash`, `bridge_settings_version_after`, for START `deployment_id` and
  `previous_deployment_id`, the stored response body, `created_at`. A partial unique key on
  `(export_id)` where `purpose = 'START'` enforces one start per export. Start guards (6.6 steps 6 and 7),
  the replay answer (6.4) and the progress (5.3) read this table only, never audit rows.

### 6.3 Import commit [PROPOSED order; guards carried from QL:629]

Request body, exact keys: `{confirm_token, atr_multiplier, rr}`; the pair as canonical decimal strings.

One SERIALIZABLE transaction (QL:629; RC-26 QL:757). Order, first failure wins, everything rolls back:

1. Body keys and types; missing token: `CONFIRMATION_REQUIRED` (400) (QL:629; PF-4 pattern
   `pf4-proposal-service.js:183-187`). Malformed: `INVALID_FIELDS` (400).
2. Apply lock closed: `BI_IMPORT_LOCKED` (409) (section 8).
3. Export owner-scoped lookup: `NOT_FOUND` (404); Bot ownership: `BOT_ACCESS_DENIED` (403) (QL:622-623).
   Then the per-export advisory lock (4.2).
4. Token: unknown, other owner, other Bot, other export or other purpose: `CONFIRMATION_MISMATCH` (409);
   expired: `CONFIRMATION_EXPIRED` (409); consumed: see 6.4.
5. Multi-Pine Bot or package: `MULTI_PINE_REQUIRES_APP_3B` (409) (RM:2624; QL:676).
6. Session RUNNING or PAUSED: `RISK_POLICY_FROZEN` (409) (RM:2610; QL:629). Checked after a row lock on
   the Bot, as activation does (CODE: `pine-bridge-readiness.js:44-46`).
7. Token-bound facts, checked before READY so that a change after preview gets its own code:
   current hard-policy `policyHash` differs from the token's bound `policy_hash` (the F field
   `policy_hash`, QL:174): `STALE_POLICY_STATE` (409) (QL:629; QL:836-837). Bridge Settings version
   differs from the token: `BI_BRIDGE_SETTINGS_STALE` (409). [PROPOSED order]
8. READY at commit, F re-read now: otherwise `BI_NOT_READY` (409) with `codes` (section 6.5) (QL:629,
   QL:563-567). A policy change reaches this step only if it happened before preview, and then the
   preview issued no token.
9. Request pair differs from the package `inputs.json` Bridge pair (exact canonical decimal string
   compare, no numeric tolerance): `BI_APPLY_VALUE_MISMATCH` (409) (QL:629; QL:855-856). The client
   never supplies values the server trusts; the values are an echo check only.
10. Pair outside the run's recorded domains or the Bot's permitted Bridge bounds:
    `BI_BRIDGE_PAIR_OUT_OF_BOUNDS` (409) (QL:475, QL:629). Bounds source: OD-F7.
11. Pair already equals current Bridge Settings: `BI_IMPORT_NO_CHANGE` (409), nothing written.
12. Read hard policy hash, capital, counters and guards; insert the Bridge Settings version; re-read
    them. Any difference: `BI_RISK_RELAXATION` (409) and rollback (QL:629, "hard limits, capital,
    counters and guards unchanged"; QL:855-857 "byte-identical before and after").
13. Insert the handoff result row (6.2; it consumes the token) and the audit event (6.7). Commit.

Response 200: `{version:'f09-03-import-v1', export_id, package_hash, bridge_settings_version_before,
bridge_settings_version_after, pair_before, pair_after, policy_hash_before, policy_hash_after (equal),
audit_event_id, replayed:false}`.

A serialization failure (`40001`) is retried a bounded number of times (RC-26, QL:757); after the bound
it is `409` with `SERIALIZATION_CONFLICT` and nothing written. Any other unexpected failure:
`BI_IMPORT_UNAVAILABLE` (503), with no internal message (PF-4 mapping, `pf4-proposal-service.js:46-58`).

### 6.4 Double submit [PROPOSED]

- Same token, same body, after a successful commit: 200 with the stored result and `replayed:true`. No
  second Bridge Settings version, no second `APPLIED` event. The answer comes from the handoff result
  row (6.2), which is insert-only, so it holds without expiry.
- Same token, different body: `CONFIRMATION_MISMATCH` (409), nothing written.
- Two concurrent commits with one token: SERIALIZABLE plus `UNIQUE(confirmation_id)`; one commits, the
  other retries and then answers the replay. Never two versions.
- A fresh preview after a successful import offers no token, because 6.3 step 11 gives
  `BI_IMPORT_NO_CHANGE`.

### 6.5 STALE and REPLAY_MISMATCH refusal

- "A stale or incompatible candidate cannot be applied" (QL:565; PEX:64). Freshness is derived at read
  (QL:559-567, OD-8).
- At import commit and at start commit, a package that is not READY is refused `BI_NOT_READY` with
  `codes`: the first differing F code from C4 (`BI_SOURCE_VERSION_STALE`, `BI_MEMBERSHIP_CHANGED`,
  `BI_POLICY_SNAPSHOT_MISMATCH`, `BI_DEPLOYMENT_CHANGED`, `BI_SELECTION_CHANGED`, QL:474).
- A `REPLAY_MISMATCH` event forces STALE for apply (QL:565-566, QL:658-659, OD-15 QL:707), is listed
  first among the codes (RC-8, QL:569, QL:731), and reverting freshness changes does not clear it
  (QL:865-867).
- An unreadable or non-boolean replay state refuses with `BI_REPLAY_STATE_UNAVAILABLE`, never labelled
  `REPLAY_MISMATCH` (QL:569-572).
- A refused response carries status and codes only, no values (QL:600-601).
- The audit event stores the F snapshot it checked (QL:567, QL:629).

### 6.6 Start-new-Bot request contract and codes

Carried guards (QL:630): separate action after import; new deployment version; deliberate alert
replacement acknowledged; old exits preserved; PF-1 readiness passes. Sources: PEX:64 ("Starting with
reviewed values requires deliberate alert replacement"), PEX:101 (new deployment version, switchover that
disables the previous alert and resolves position and exit ownership), PEX:114 (criterion 9, old/new
alert overlap preserves authorized exits), PEX:118 (separate explicit owner action, ends the workflow),
RM:2643 ("Preserve old allocation exits during alert replacement"), RM:2656 (new deployment version,
deliberate alert replacement, old entry route retired, permitted exits maintained). The server never
claims to create or inspect the owner's TradingView alert (PEX:102).

Meaning of "new Bot": same `bot_id`, new deployment version, new session run (OD-F4) [PROPOSED]. The
package binds `bot_id` (QL:119-121), so a different `bot_id` would fail the binding.

Precondition outside this action: the owner has created the new deployment as a `DRAFT` through the
existing Bridge generation path, from the package Pine. Whether that needs a new source version, and how
that interacts with F, is open question Q1. Required order while Q1 is open [PROPOSED]: import first,
then source registration and the `DRAFT`, then start. Registering the package Pine as a new source
version before import changes F (`source_version`, QL:173-174; PEX:101 "Changing source creates a new
export/deployment version"), so import then refuses `BI_NOT_READY` with `BI_SOURCE_VERSION_STALE`. The
review UI (6.8) states this order. The Root ruling on Q1 may replace it.

Start preview request body: `{deployment_id}`. Response: the checks of the commit with `allowed`,
`refusal_code`, `confirm_token`, `expires_at`, the previous READY deployment id and the exit consequences
(which open allocations stay exit-only). [PROPOSED]

Start commit request body, exact keys [PROPOSED]:
`{confirm_token, deployment_id, previous_deployment_id, alert_replacement_ack}` where
`alert_replacement_ack` must equal the fixed string `NEW_ALERT_CREATED_OLD_ENTRY_ALERT_DISABLED` and
`previous_deployment_id` must echo the current READY deployment (or null when none).

One SERIALIZABLE transaction. Order, first failure wins, everything rolls back [PROPOSED order]:

1. Body keys and types: `CONFIRMATION_REQUIRED` or `INVALID_FIELDS` (400).
2. Start lock closed: `BI_START_LOCKED` (409) (section 8).
3. `NOT_FOUND` (404), `BOT_ACCESS_DENIED` (403) (QL:622-623). Then the per-export advisory lock (4.2)
   and the Bot row lock (CODE: `pine-bridge-readiness.js:44-46`).
4. Token checks as 6.3 step 4; purpose `START`, bound `deployment_id`.
5. Multi-Pine: `MULTI_PINE_REQUIRES_APP_3B` (409) (RM:2624).
6. No `IMPORT` handoff result row (6.2) for this export and Bot, or the current Bridge Settings version is
   not that row's `bridge_settings_version_after`: `BI_START_IMPORT_REQUIRED` (409) (QL:630 "After
   import, as a separate action").
7. A `START` handoff result row (6.2) already exists for this export: `BI_START_ALREADY_DONE` (409). One
   start per export, also enforced by the partial unique key; the workflow ended (QL:639-640).
8. Session not `SETUP`: `BI_START_SESSION_NOT_SETUP` (409) (section 5.4).
9. READY at commit, F read before any write in this transaction: `BI_NOT_READY` with `codes` (6.5).
10. Target deployment: absent or foreign `NOT_FOUND`; `REVOKED` or `EXIT_ONLY` `DEPLOYMENT_REPLACED`
    (CODE: `pine-bridge-readiness.js:48`); not `DRAFT`, other Bot, `snapshot.selection.bridge` not equal
    to both the Bridge Settings pair and the package pair, integrated Pine hash not equal to the package
    Pine file hash, or `exit_version` not equal to the package `exit_version` (QL:167, OD-6):
    `BI_START_DEPLOYMENT_MISMATCH` (409).
11. `alert_replacement_ack` wrong or `previous_deployment_id` not the current READY deployment:
    `BI_START_ALERT_ACK_REQUIRED` (409).
12. Exit preservation: the previous READY deployment moves to `EXIT_ONLY`, never `REVOKED`
    (CODE: `pine-bridge-readiness.js:54`; `pine-bridge-execution.js:12`). The check covers only the
    deployments whose state this transaction changes (the previous READY deployment and the target):
    any open allocation on one of them that would end in neither `READY` nor `EXIT_ONLY` gives
    `BI_START_EXIT_OWNERSHIP_UNRESOLVED` (409). Allocations that already sit on a deployment this
    transaction does not change (for example an earlier `REVOKED` one) do not block start; this action
    neither creates nor resolves them. [PROPOSED]
13. Activation risk check as today: `RISK_EXCEEDS_POLICY` (CODE: `pine-bridge-readiness.js:53`).
14. PF-1 readiness for the Bot with the new deployment is not the passing status:
    `BI_START_READINESS_BLOCKED` (409) with the PF-1 reasons (QL:630; CODE: `src/postgres/risk-readiness.js:64-114`).
    The passing status value is open question Q2.
15. No funded Paper capital: `BI_START_CAPITAL_UNFUNDED` (409) (CODE: `server.js:359-361`).
16. Writes: previous READY to `EXIT_ONLY`, target to `READY`, session `SETUP` to `RUNNING` through the
    existing transition (CODE: `store.js:231-242`), hard policy hash and capital re-checked unchanged
    (else `BI_RISK_RELAXATION`), handoff result row inserted (6.2; it consumes the token), audit events
    `pine_bridge.activated`, `bot.lifecycle.run` and `bi.start` (6.7). Commit. Whether activation and run
    are one action is OD-F5.

Failure mapping [PROPOSED], same as import (6.3): a serialization failure (`40001`) is retried a bounded
number of times (RC-26, QL:757); after the bound it is `409` with `SERIALIZATION_CONFLICT` and nothing
written. Any other unexpected failure: `BI_START_UNAVAILABLE` (503), with no internal message (PF-4
mapping, `pf4-proposal-service.js:46-58`).

Execution mode is always Paper; the request has no mode field and the response states
`execution_mode:'PAPER'` (CODE: `pine-bridge-readiness.js:57`; AG:400-402). Live is out of scope.

After commit the package reads STALE with `BI_DEPLOYMENT_CHANGED`, because the current deployment in F
changed (QL:173-174). This is expected: the workflow ended (QL:639-640). Nothing schedules a new run,
optimization or Paper cycle.

Response 200 [PROPOSED]: `{version:'f09-03-start-v1', export_id, bot_id, deployment_id,
previous_deployment_id, previous_state:'EXIT_ONLY', session_state:'RUNNING', execution_mode:'PAPER',
audit_event_id, replayed:false}`. Double submit follows 6.4.

### 6.7 Audit events

Every action writes an audit event with `export_id`, `package_hash`, actor, UTC time and outcome
(QL:620-622; PEX:118). Import stores the F snapshot it checked (QL:567, QL:629).

Fields [PROPOSED]: `event_id`, `type` (`bi.import` or `bi.start`), `outcome` (`APPLIED`, `STARTED`,
`REPLAYED` or `REFUSED`), `refusal_code`, `export_id`, `package_hash`, `binding_hash`, `bot_id`,
`actor`, `at_utc` (ISO-8601), `confirmation_id` (never the token), `f_snapshot`, `policy_hash_before`,
`policy_hash_after`, `bridge_settings_version_before`, `bridge_settings_version_after`, `pair_before`,
`pair_after`; for start also `deployment_id`, `previous_deployment_id`, `session_state_before`,
`session_state_after`. No secrets, webhook URLs, broker credentials or machine locations (QL:611).

Refused attempts [PROPOSED, OD-F11]: written in a separate short transaction after the rollback, with
`outcome:'REFUSED'`. No audit row is written on a Bot the actor does not own (QL:838-839); so
`NOT_FOUND` and `BOT_ACCESS_DENIED` write none. A refusal at 6.3 or 6.6 steps 1 and 2 (body, lock)
happens before the owner lookup of step 3, so its `export_id` may be foreign or absent: it writes no
audit row either [PROPOSED]. A refusal row therefore always names an export and Bot the actor owns.

### 6.8 Owner review UI [PROPOSED]

Carried: "The Bot Risk Manager page displays Bridge Settings separately from hard Policy limits and
Capital" (RM:2610); Pine-only source inputs shown separate from the Bridge pair (QL:595-596; RM:2652);
non-READY packages show status and codes only (QL:600-601, QL:607); EN and TH labels (QL:864; PEX:106);
an email review link opens review only (RM:2652; QL:637-638). CODE: the Risk manager page is
`<section data-page="risk">` with the policy form and limits table (`public/index.html:110-113`); PF-4
labels live in one named EN/TH block (`public/i18n.js:441-442`).

1. Bridge Settings panel on the Risk manager page, apart from the hard limits table and Capital: current
   pair and version (or `NOT_SET`), the active deployment pair, and while they differ the
   `BRIDGE_SETTINGS_NOT_DEPLOYED` notice as neutral information, not an error. The panel has no edit
   control (OD-F10 default (a)). Data comes only from the read route.
2. Review screen for an export, reached from the owner's export view or the authenticated email link.
   READY and lock open: the QL 7.1 review fields (QL:587-596); Pine-only source inputs listed apart
   from the Bridge pair; Bridge pair before and after; the statement that hard policy is unchanged with
   its `policy_hash`; consequences; the import order note of 6.6 (import before source registration).
3. Import control: shown only when the preview answered `allowed:true` with a token. It sends the token
   and the echoed pair. It is disabled after one press until the response; the server rule 6.4 stays
   the authority. Nothing submits without a press: no auto-submit on page load, link open or timer.
4. Lock closed, READY: the F09-03 panel shows the lock label and code only. No Bridge before/after
   diff, no token, no import or start control. The F09-01 READY read (QL 7.1) is unchanged.
5. Not READY (including STALE, fixture or multi-Pine): status, UTC times and codes only; no values, no
   control (QL:600-601, QL:607-610).
6. Start screen: target and previous deployment ids, the exit consequences (which open allocations stay
   exit-only), the fixed acknowledgement text with an explicit tick, a Paper badge and no mode
   selector. Start control shown only when the start preview answered `allowed:true`.
7. Refusals show the EN or TH label of the code and the code itself; never an internal message.
8. Every new label, code label and notice has EN and TH text in one named block, like PF-4
   (`public/i18n.js:441`). Thai text follows OD-F12.

## 7. Failure codes

Carried codes:

| Code | HTTP | Source |
| --- | --- | --- |
| `CONFIRMATION_REQUIRED` | 400 | QL:629; CODE `pf4-proposal-service.js:187` |
| `INVALID_FIELDS` | 400 | CODE `pf4-proposal-routes.js:15` |
| `METHOD_NOT_ALLOWED` | 405 (wrong method on any route, section 6) | CODE `pf4-proposal-routes.js:20` |
| `BOT_ACCESS_DENIED` | 403 | QL:623 |
| `NOT_FOUND` | 404 | QL:622 |
| `RISK_POLICY_FROZEN` | 409 | QL:629; RM:2610 |
| `STALE_POLICY_STATE` | 409 | QL:629 |
| `BI_NOT_READY` (with `codes`) | 409 | QL:629 |
| `BI_BRIDGE_PAIR_OUT_OF_BOUNDS` | 409 | QL:629, QL:475 |
| `BI_APPLY_VALUE_MISMATCH` | 409 | QL:629 |
| `BI_RISK_RELAXATION` | 409 | QL:629 |
| `REPLAY_MISMATCH`, F codes (inside `codes`) | n/a | QL:474, QL:565-569 |
| `BI_REPLAY_STATE_UNAVAILABLE` | 409 | QL:569-572 |
| `MULTI_PINE_REQUIRES_APP_3B` | 409 | CODE `pine-bridge-readiness.js:50` |
| `DEPLOYMENT_REPLACED` | 409 | CODE `pine-bridge-readiness.js:48` |
| `RISK_EXCEEDS_POLICY` | 400 as today | CODE `pine-bridge-readiness.js:53` |
| `QR4_APPLY_REFUSED` | per QR4 | QR4:721 |

New codes, all [PROPOSED]: `BI_IMPORT_LOCKED`, `BI_START_LOCKED`, `CONFIRMATION_MISMATCH`,
`CONFIRMATION_EXPIRED`, `BI_BRIDGE_SETTINGS_STALE`, `BI_IMPORT_NO_CHANGE`, `BI_IMPORT_UNAVAILABLE` (503),
`SERIALIZATION_CONFLICT`, `BI_START_IMPORT_REQUIRED`, `BI_START_ALREADY_DONE`,
`BI_START_SESSION_NOT_SETUP`, `BI_START_DEPLOYMENT_MISMATCH`, `BI_START_ALERT_ACK_REQUIRED`,
`BI_START_EXIT_OWNERSHIP_UNRESOLVED`, `BI_START_READINESS_BLOCKED`, `BI_START_CAPITAL_UNFUNDED`,
`BI_START_UNAVAILABLE` (503). Each matches `^[A-Z][A-Z0-9_]{1,63}$` (QL 11.1 item 15 rule) and has EN
and TH labels (QL:864; PEX criterion 1, PEX:106).

## 8. Best Inputs apply lock

Carried:
- AG:401-402: "No automatic optimizer/data-range loop, guard reset, Best Inputs apply or Live activation."
- The project's standing reading: no Best Inputs apply "without an explicit owner GO"
  (`docs/CLAUDE_LOCAL_TO_CLOUD_ROOT_HANDOFF_2026-10-21.md:141`).
- M5 review/apply interface "initially disabled until M7 passes" (RM:2641).
- No automatic apply or start, including after email receipt (QL:636-640; QL:674-675; PEX:118).

Rules:
1. The lock is closed by default. While closed, import commit refuses `BI_IMPORT_LOCKED`, start commit
   refuses `BI_START_LOCKED`, and previews return `allowed:false` with that code and no token.
   [PROPOSED]
2. An explicit owner-started import is permitted only if the owner decides so (OD-F1). This contract
   does not assume that decision. Without it, the import interface exists only as a locked design.
3. Start has its own lock and its own owner decision (OD-F3). Opening the import lock never opens start.
   [PROPOSED]
4. Opening a lock is an owner GO under the Roadmap gates; no workflow, agent, worker, scheduler, email
   handler, QR-4 selection or package build opens it or calls import or start (AG ultracode rules;
   QR4:721; QL:636-640). The mechanism and scope (environment, staging only) is OD-F2.
   Named preconditions before any GO to open a lock: the M7 exit gate has passed (M5 interface
   "initially disabled until M7 passes", RM:2641; M7 enables one-Pine review/apply and optional owner
   Bot start, RM:2643), which includes the QL-4C exit gate (RM:2623). Multi-Pine import or start also
   needs APP-3B (RM:2624). Recording that M7 passed is a Root and owner act, not this contract's.
5. Even with a lock open, READY must hold at commit; today it cannot (QL:77-87).
6. Nothing in this contract changes Risk Manager hard policy, Pine sources, guards or Live state.

## 9. Test plan

All tests use labelled fixtures, local only, isolated PostgreSQL where named (QL:774-777). A fixture
pass never counts as owner handoff evidence. Tests marked T-n are [PROPOSED].

Lock in tests: QL:776-777 forbids a test-only gate override. Tests that need an open lock open it only
through the OD-F2 mechanism, set in the test fixture configuration (for example the per-environment
server setting of OD-F2 option (a)). The import and start services have no test flag, no bypass
parameter and no environment check other than that mechanism. If OD-F2 picks another mechanism, the
tests follow it. T-20 runs with the default (closed) configuration.

### 9.1 Pure (Node, no database)

- T-1 Code shape: every new code matches `^[A-Z][A-Z0-9_]{1,63}$`; every code has EN and TH labels.
- T-2 Value equality: canonical decimal string compare; `2.0` vs `2` decided by the canonical rule only;
  a number instead of a string is `INVALID_FIELDS`.
- T-3 Refusal order: for each pair of simultaneous failures the first code in 6.3 or 6.6 order wins.
- T-4 Static guard: no module except the F09-03 route imports the import or start service (no worker,
  scheduler, email, QR-4 or builder caller), in the style of the existing importer guards.

### 9.2 Isolated PostgreSQL

- T-5 Session RUNNING: import `RISK_POLICY_FROZEN`; no Bridge Settings row; refusal audit row only.
- T-6 Session PAUSED: import `RISK_POLICY_FROZEN`; same checks. (Closes AUD:17; QL:855 tests RUNNING
  only.)
- T-7 Session STOPPED and SETUP: import allowed (subject to OD-F9).
- T-8 STALE: change source version after preview; commit `BI_NOT_READY` with `BI_SOURCE_VERSION_STALE`;
  nothing written (QL:854).
- T-9 REPLAY_MISMATCH: insert a replay event; commit `BI_NOT_READY` with `REPLAY_MISMATCH` first; revert
  F changes; still refused (QL:865-867). Unreadable replay state: `BI_REPLAY_STATE_UNAVAILABLE`.
- T-10 Race: a policy save commits between preview and import; `STALE_POLICY_STATE` from 6.3 step 7,
  before the READY step (QL:836-837 allows `STALE_POLICY_STATE` or `BI_NOT_READY`; this contract pins
  `STALE_POLICY_STATE`). The compared field is the token's bound `policy_hash` against the current
  `policyHash`.
- T-11 Bridge Settings changed between preview and commit: `BI_BRIDGE_SETTINGS_STALE`.
- T-12 Value mismatch: `BI_APPLY_VALUE_MISMATCH` (QL:855-856).
- T-13 Bounds: pair outside run domains or Bot bounds: `BI_BRIDGE_PAIR_OUT_OF_BOUNDS`.
- T-14 Invariant: valid import changes only the Bridge Settings record; policy hash, capital, counters,
  guards, deployments and session bytes identical before and after (QL:855-857). A forced invariant break
  gives `BI_RISK_RELAXATION` and rolls back.
- T-15 Token: expired gives `CONFIRMATION_EXPIRED`; other export or Bot gives `CONFIRMATION_MISMATCH`;
  absent gives `CONFIRMATION_REQUIRED`; a refused commit leaves the token usable until expiry.
- T-16 Double submit: replay returns `replayed:true` with one version and one `APPLIED` event; same token
  with a different body is refused; two concurrent commits give one version.
- T-17 Owner isolation: owner B importing or starting owner A's export gets `NOT_FOUND`; no audit row on
  owner A's Bot (QL:838-839).
- T-18 Multi-Pine: `MULTI_PINE_REQUIRES_APP_3B` for import and start; `EXPORT_INTERNAL` never READY.
- T-19 Fixture package: `BI_NOT_READY` (READY needs fixture false, QL:576).
- T-20 Lock closed (default): import `BI_IMPORT_LOCKED`, start `BI_START_LOCKED`; preview gives no token.
- T-21 Insert-only: update or delete of a Bridge Settings, confirmation or handoff result row refused `QR002`;
  write outside SERIALIZABLE refused `QR003`.
- T-22 Audit fields: every field of 6.7 present; no token value, secret or path in any row.
- T-22a Early refusal: a malformed body or a closed lock on a foreign or absent `export_id` writes no
  audit row (6.7).
- T-22b Serialization: a forced `40001` beyond the retry bound gives `SERIALIZATION_CONFLICT` and
  nothing written, for import and for start; any other forced failure gives `BI_IMPORT_UNAVAILABLE` or
  `BI_START_UNAVAILABLE` (503) with no internal message.
- T-22c Progress source: the progress (5.3), the replay answer (6.4) and start guards 6 and 7 give the
  same answer with refusal audit rows present or absent (OD-F11 (a) or (b)); they read the handoff
  result table only.
- T-22d Route methods: GET on a write route and POST on the read route give `METHOD_NOT_ALLOWED`.

### 9.3 Start

- T-23 Start before import: `BI_START_IMPORT_REQUIRED`. Second start: `BI_START_ALREADY_DONE`. A
  Bridge Settings version newer than the import result row: `BI_START_IMPORT_REQUIRED`.
- T-23a Exit check scope: an open allocation on an earlier `REVOKED` deployment that this start does not
  change does not block start; an open allocation on the previous READY deployment stays exit-only.
- T-24 Session RUNNING, PAUSED and STOPPED: `BI_START_SESSION_NOT_SETUP`; start never resets.
- T-25 Deployment pair, Pine hash or `exit_version` differs: `BI_START_DEPLOYMENT_MISMATCH`; REVOKED or
  EXIT_ONLY target: `DEPLOYMENT_REPLACED`.
- T-26 Wrong ack or wrong previous deployment echo: `BI_START_ALERT_ACK_REQUIRED`.
- T-27 Exits preserved: an open allocation on the previous deployment; after start the previous
  deployment is `EXIT_ONLY`, an EXIT event is accepted and a BUY is refused `BRIDGE_NOT_READY`
  (PEX:114; CODE `pine-bridge-receiver.js:15`).
- T-28 PF-1 blocked: `BI_START_READINESS_BLOCKED` with reasons; unfunded: `BI_START_CAPITAL_UNFUNDED`.
- T-29 After start: package reads STALE `BI_DEPLOYMENT_CHANGED`; no job, run, outbox row or Paper cycle
  is created (QL:639-640; `notification_outbox` and `quant_jobs` counts unchanged).
- T-30 Response and session state always Paper; no request field selects a mode.

### 9.3a API and UI (Node, local, no browser; QL 11.3 style, QL:849-867)

Pattern: the existing `test/*-ui.test.js` Node tests (for example `test/pf3-readiness-ui.test.js`).

- T-31 Risk manager Bridge Settings panel renders apart from the hard limits table and Capital; shows
  version or `NOT_SET`, both pairs, and the `BRIDGE_SETTINGS_NOT_DEPLOYED` notice only while they differ;
  has no edit control (6.8 item 1).
- T-32 READY review with lock open: QL 7.1 fields, Pine-only inputs apart from the Bridge pair, before
  and after pair, hard-policy-unchanged statement, import order note; import control present only with
  a token (6.8 items 2 and 3).
- T-33 Lock closed: lock label and code only; no Bridge diff, no token, no import or start control in
  JSON or HTML (6.8 item 4).
- T-34 Not READY, STALE, fixture and multi-Pine: status, UTC times and codes only; no values and no
  control in JSON or HTML (6.8 item 5).
- T-35 No auto-submit: rendering the review screen or opening the email link path sends no import or
  start request; the control is disabled after one press until the response (6.8 item 3).
- T-36 Start screen: acknowledgement tick required, Paper badge, no mode selector (6.8 item 6).
- T-37 EN and TH text exists for every new label, code and notice, in one named block whose pairs are
  unique and complete (6.8 item 8; QL:864).

### 9.4 Staging evidence (F09-03 target)

Needs a READY package, which cannot exist today (QL:77-87), OD-F1 and OD-F3 decided, a recorded owner GO
for the deployment, and an owner browser check of review, import and optional start against the 6.8
rules. Evidence records
commit, package hash, audit event ids, refusal codes and UTC stamps; no secrets or machine paths. Until
then T stays 0.

## 10. Owner decisions (open; none assumed)

| ID | Decision | Options | Draft default while open |
| --- | --- | --- | --- |
| OD-F1 | Is an explicit owner-started Best Inputs import permitted at all (AG:401-402)? | (a) Yes, only through this contract, after an owner GO per environment; (b) No, import stays locked | Locked. Contract proposes (a) for review only |
| OD-F2 | Lock mechanism and scope | (a) Server configuration per environment, staging only, changed under an owner GO; (b) per-Bot owner opt-in record; (c) both | Closed everywhere |
| OD-F3 | Is the start action permitted, and under its own lock? | (a) Separate lock and GO; (b) No start in F09-03, owner uses existing activation and run | Locked |
| OD-F4 | Meaning of "new Bot" (INV:383; QL:630) | (a) Same `bot_id`, new deployment version, new run; (b) new `bot_id` | None; (a) proposed |
| OD-F5 | Start shape | (a) Activation and run in one transaction; (b) activation only, owner presses RUN | None; (a) proposed |
| OD-F6 | Bot-level Bridge Settings record location (MP:203-204; OD-MP-6 MP:647) | (a) New insert-only per-Bot version table outside hard policy (4.2); (b) a field in the risk policy (conflicts with RM:2610, RM:2637); (c) defer to APP-3B | None; (a) proposed |
| OD-F7 | Source of "the Bot's permitted Bridge bounds" (QL:475, QL:629; none exists, `mp-package-store.js:166`) | (a) Frozen run domains only; (b) an owner-declared bounds record that may only tighten; (c) the validator ceiling (`source.js:93`) intersected with (a) | None; (c) proposed |
| OD-F8 | Confirm token lifetime | 5, 10 or 30 minutes | None; 10 proposed |
| OD-F9 | Import while session STOPPED | (a) Allowed; (b) SETUP only | None; (a) proposed |
| OD-F10 | Owner manual edit of Bridge Settings outside import | (a) Out of scope; (b) separate PF-4-style guarded edit | (a) |
| OD-F11 | Audit row for refused attempts | (a) Yes, except NOT_FOUND and 403; (b) applied only | None; (a) proposed |
| OD-F12 | Thai labels for new codes | Root drafts, owner approves (QR4 OD-S19 pattern, QR4:985) | Not drafted |

## 11. Out of scope

- Live trading, any broker other than Spot Paper, Futures, short, margin (QL:671-672; AG:400-402).
- Automatic import, apply or start; automatic optimizer loop or rerun; guard reset (QL:674-675).
- Multi-Pine owner review, import or start before APP-3B (QL:676; RM:2624).
- Email delivery mechanics (F09-02) and any import from an email link or QR-4 selection (QR4:721-722).
- Creating or inspecting TradingView alerts for the owner (PEX:102; QL:679).
- Post-export Paper acceptance cycle (RM:2623; QL:680).
- Changing hard Risk Policy, capital, counters, guards, Pine sources or source inputs through import
  (QL:629, QL:634-635).
- Package supersession or archive (QL:709, OD-17).
- Implementation, migration, deployment and route activation; each needs its own gates and GO.

## 12. Open questions and known risks

- Q1 Start and F: the package Pine carries edited input defaults (QL:761, RC-30). If registering the new
  `DRAFT` deployment needs a new source version or changes the effective-input hash, F changes before
  start and the package reads STALE, so start can never pass. Root must decide whether F at start is
  evaluated against the bound deployment state before activation, or whether the new deployment is
  excluded from F until activation. Q1 also hits import: registering the package Pine as a new source
  version before import changes F, and import refuses too (PEX:101). This draft proposes the order
  import, then source registration, then start (6.6); the Root ruling on F covers both halves.
- Q2 PF-1 passing status: the value that counts as "readiness passes" (QL:630) was not found by grep in
  `risk-readiness.js`; only `UNKNOWN`, `BLOCKED` and `REJECTED` appear. Confirm from the PF-1 contract.
- Q3 PF-4 says the server turns `40001` into 409 (`pf4-proposal-service.js:47-48`) while RC-26 retries
  (QL:757). This draft uses bounded retry then 409 for import and start; Root confirms.
- Q4 Bridge Settings outside F (4.2) is required so import does not stale its own package. Root confirms
  this does not weaken "current Bot/policy/source checks" (RM:2610).
- Q5 The relation between this record and the F11-01 member-set `bridge_pair` at APP-3B is open
  (MP:199-204).
- R1 READY cannot be reached today (QL:77-87); every F09-03 path is fixture-only engineering until a
  qualified run exists. V and T stay 0.
- R2 The alert acknowledgement is an owner statement the server cannot verify (PEX:102); a wrong
  statement can leave an old entry alert live. Mitigation: previous deployment goes `EXIT_ONLY`, so its
  BUY events are refused (CODE `pine-bridge-receiver.js:15`).
- R3 D credit for F09-03 is a Root ruling (SC4:1358; AUD:13). This draft is design input, not acceptance.
- R4 The handoff tables and the per-export lock need a Root RC amendment to RC-25 (4.2) before any
  implementation.

## 13. Review response (revision 1)

Review: `.qa-local/l3-f09-contracts-2026-11-06/f09-03-review.md`. All findings fixed; none declined.

| Finding | Action | Where |
| --- | --- | --- |
| P2-1 guard order vs T-10 | Fixed. Token-bound facts (policy hash, Bridge Settings version) now checked at step 7, before READY at step 8; the compared field is named (token `policy_hash`, equal to F `policy_hash`, QL:157, QL:174, OD-12 QL:704, against current `policyHash`). T-10 pins `STALE_POLICY_STATE` and notes that QL:836-837 allows either | 6.2, 6.3 steps 7-8, 4.2, T-10 |
| P2-2 review UI not specified | Fixed. New UI rules: Bridge Settings panel, review screen, controls, lock-closed and not-READY states, start screen, refusal labels, EN/TH; new Node UI tests T-31 to T-37; owner browser check tied to 6.8 | 6.8, 9.3a, 9.4, section 1 list |
| P3-1 QL:476 slip | Fixed to QL:474 | 6.5, section 7 table |
| P3-2 POST-only vs GET route | Fixed. POST only on the four write routes, GET only on the read route; test T-22d | section 6 intro, section 7 table |
| P3-3 start failure mapping | Fixed. `40001` retry then `SERIALIZATION_CONFLICT`, and `BI_START_UNAVAILABLE` (503), added to 6.6; test T-22b | 6.6, Q3 |
| P3-4 refusal audit before owner lookup | Fixed. Refusals at steps 1-2 write no audit row; test T-22a | 6.7 |
| P3-5 start guards on audit events | Fixed. New insert-only handoff result table with a one-start-per-export partial unique key; start guards 6-7, replay and progress read it only; test T-22c | 6.2, 5.3, 6.3 step 13, 6.4, 6.6 steps 6-7 and 16, T-21 |
| P3-6 step 12 blocks on old REVOKED allocations | Fixed. Check limited to deployments this transaction changes; test T-23a | 6.6 step 12 |
| P3-7 tests need the lock open | Fixed. Tests open it only through the OD-F2 mechanism in fixture configuration; no test flag or bypass (QL:776-777) | 9 intro |
| P3-8 name the M7 exit gate | Fixed. M7 exit (RM:2641, RM:2643), QL-4C exit (RM:2623) and APP-3B for multi-Pine (RM:2624) named | 8 rule 4 |
| P3-9 RC-25 amendment, RC-26 lock | Fixed. RC-25 amendment named as needed (R4); RC-26 per-export advisory lock carried with a fixed lock order and the reason the Bot row lock alone is not enough | 4.2, 6.3 step 3, 6.6 step 3, 12 R4 |
| Open question note (Q1 hits import) | Fixed. Proposed order import, then source registration, then start; folded into Q1 for the Root ruling | 6.6, 6.8 item 2, Q1 |

Interpretation note on P2-2: "locked ... shows no values" is read as the F09-03 panel only. The F09-01
READY read (QL 7.1, QL:587-596) is not narrowed by this contract, which keeps scope.

## Root acceptance (2026-11-06T07:40Z, ruling SB166)

Accepted as design revision 1. Review files: `.qa-local/l3-f09-contracts-2026-11-06/` (review, review-r2). Residual review notes, carried to implementation (P3, none blocking):

- A lock-closed preview returns the status and the lock code with no bridge_settings diff and no token (6.1, 8 rule 1, matching 6.8 item 4 and T-33).
- The per-export lock key robot:bi-handoff: is intended (no lock-order dependency on builder paths); SERIALIZABLE orders it against builder and replay writers, and the 40001 retry gives a concurrent loser its final answer (4.2).
- Start step 6 reads the latest IMPORT result row for the export and Bot; T-23 adds the A, B, A case (6.6).

Implementation needs its own packet, coder, tester, Opus audit and CI; any staging step needs its own owner GO. A scorecard D credit moves only in a successor scorecard that pins this file.
