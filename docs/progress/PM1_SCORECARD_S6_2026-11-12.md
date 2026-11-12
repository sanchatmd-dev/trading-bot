# PM-1 scorecard S6, 2026-11-12 (UTC)

**Status: `COMPLETE_WITH_EXPLICIT_UNCERTAINTY`. Accepted by Claude root on 2026-11-12T20:15Z (UTC).** Root accepted the scorecard. Root checks at source commit 5f05ade: the repo calculator CLI on this file (E027, the inherited disk pin, hashed by the CLI on the full file), 54 rows, stored totals equal computed; the S2 independent verifier byte copy with the hook passed 7 of 7; the freeze check passed 6 of 6 (2 ruled stage moves in 1 row, no other credit change, product tree equal to the CI-green e278721). Results: project 21083/300 (70.28%) to 303/4 (75.75%), prototype 913/12 (76.08%) to 973/12 (81.08%). It changes no gate, GO, product acceptance or runtime state. Prepared by an architecture auditor child (Opus 5.5, high effort). It changes no gate, GO, product acceptance or runtime state.

- Scorecard ID: `PM1-S6-2026-11-12`. Method PM-1, inventory PM1-I1 (sha256 `233f5fbea8435599`, unchanged), same weights, shares, targets and rules.
- Prior scorecard: PM1-S5-2026-11-06 ([JSON](PM1_SCORECARD_S5_2026-11-06.json), evidence E184), source commit `5be0968`.
- Source commit: `5f05ade` on `codex/fe2b-ci-local-fix`. Evidence window: tracked commits `5be0968..5f05ade`. Untracked Root rulings are context only and score nothing; each credit move cites a tracked record.
- Scored at 2026-11-12T20:02:01Z (Asia/Bangkok 2026-11-13 03:02).

## Result

| View | Lower | Upper | UNKNOWN weight |
| --- | ---: | ---: | ---: |
| Project | 70.28% (21083/300) | 75.75% (303/4) | 30.87 (463/15) |
| Prototype | 76.08% (913/12) | 81.08% (973/12) | 25.00 (25/1) |

Displayed whole percentages: project 70–76%, prototype 76–81% (S5: project 69–74%, prototype 76–81%). UNKNOWN credits remain in both views, so neither view has a single score. The bounds are engineering evidence bounds, not completion, and they grant no acceptance or GO.

## Change from S5

The series is comparable: inventory, weights, shares, targets and method did not change. Delta: project lower 1/1 (1.00 points), upper 5/3 (1.67), UNKNOWN weight 10/3 (3.33); prototype lower 0/1, upper 0/1, UNKNOWN weight 0/1 (F01-03 is a project-view row).

2 stage moves in 1 row, exactly the set Root ruled. Each cites a tracked record pinned at `5f05ade`:

| Row | Outcome | Stage | S5 | S6 | Root ruling |
| --- | --- | --- | --- | --- | --- |
| F01-03 | Shared UI and journey visibility | V | 0 | 1 | SB385 item 1 |
| F01-03 | Shared UI and journey visibility | T | 0 | UNKNOWN | SB385 item 2 |

What the moves rest on:

1. **F01-03 V, 0 to 1** (E185, E186, E189). The Root-accepted L13 record (SB193, revision `66550ec`) fixes the setup guide: the activate step is read per Bot from that Bot's readiness report, and analyze and draft carry a whole-account scope label in every state. Its acceptance lets a successor scorecard return V citing it with green CI. CI is 9 of 9 on `66550ec` and on `e278721`, whose product tree equals the source commit. The setup-guide file at the source commit is byte-equal to the pinned `66550ec` blob. Limits carried on the row: no fresh render of the new setup-guide bytes; phone width not checked; the scope label has no CSS rule; a READY deployment with a stale or failed snapshot counts as activated.
2. **F01-03 T, 0 to UNKNOWN** (E187). A T of 0 needs a known staging defect (S2 T rule, S3 precedent). The S5 zero rested on the defect read at API `75c7a5b` (E159). Staging now runs `ab1c1f1`, which contains `66550ec`, so the known defect no longer describes the running bytes, and no readback of the fixed release exists. The L13 sentence "T stays 0 until a staging readback" predates the release; the method rule governs. Readback O2 (served `setup-guide.js?v=sg3`, the activate step not Done for a Bot without a READY deployment, the whole-account label on analyze and draft, English and Thai, desktop and phone width) waits for the owner awake and signed in (SB384) and resolves T to 1 or 0 in a later scorecard.

No other credit changed. Rationale-only rows (credits unchanged): F01-01, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-03, F04-04, F06-01, F06-03, F08-01, F10-01, F10-02, F10-03, P01-01, P03-01, P03-02, P04-02, P05-01, P06-01, P06-03. They carry the L9 T carry (SB385 item 3), the staging pin note, the rule C3 notes for the window, the 816c656 identity re-pin and the refreshed F10-01, F10-02 and F10-03 status (SB385 item 4).

## Rationale

- **L9 staging T credits carried (SB385 item 3).** F04-04, P03-02, F08-01, P06-01 and P06-03 keep T = 1 by a documented carry. The L9 readback (E159) read API `75c7a5b`; staging now runs `ab1c1f1`. Every hunk in their closures from `75c7a5b` to `ab1c1f1` is class A or class B: `75c7a5b..939045e` touches QR-2 and grant files outside these closures; `939045e..5be0968` is classed in S5; `5be0968..ab1c1f1` changes `public/i18n.js`, `public/index.html`, `public/setup-guide.js`, `scripts/grant-quant-comparison-runtime.mjs`, `src/postgres/comparison-finalizer.js`, `src/postgres/qr3-comparison-wiring.js`, `src/postgres/qr3-independence.js`, `src/postgres/qr3-routes.js`, `src/postgres/quant-comparison-grant-state.js`, `src/postgres/quant-comparison-grants.js`, `src/postgres/quant-library.js`, all class A or B in the table below except `public/setup-guide.js`, which is in no L9 closure. `research-library.js` is unchanged to `ab1c1f1`. The optional readback O3 (served `research-library.js?v=qr3l1`, library inspect, an incompatible compare, the readiness report including the historical-evidence state after the `816c656` rotation) removes the carry.
- **Staging pin.** The staging API and trading worker run `ab1c1f1` since REPIN-3 A2, under their own owner GOs; the research worker stays stopped on the older pin; QR-3 and the five research flags are 0. The tracked statement is the Roadmap paragraph added in `4db161b` (E187), accepted by SB385 item 4; the A2 result record itself is untracked, and no GET names the API commit. The 9 other T UNKNOWN rows (F01-01, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, P01-01, P04-02) carry this note; none has a readback at `ab1c1f1`.
- **F10-01** (I 0). Slice b-2 is now on staging (`ab1c1f1` contains `39c7ced`). The REPIN-3 owner browser check read the per-Bot views; All Time answers 403 QR2_RANGE_ADMISSION_REFUSED under OD-S5-D, so the E141 All Time reading describes the earlier release only. Full S5 is still open.
- **F10-02** (I 1, V 0, T 0). Hardening slices A (`5a36143`) and B (`816c656`, owner GO OG-2) close the SB187 MUST-FIX items in code. No contract section 13 verification exists, so V stays 0. The QR-3 code is on staging with its flags off and the panel says "not available on this release", so T stays 0.
- **F10-03** (I 0). QR-4 slices Q4-A, Q4-B, Q4-C, Q4-D and Q4-S are local code, unwired or behind `QR4_SELECTION_ENABLED` (off); Q4-W is not built and needs owner GO OG-Q4-1; OD-S3 tolerances are unset, so every registration fails closed. The stale S5 words "implementation has not started" are replaced.
- **Engine identity rotation (`816c656`).** The QR-3 wiring and finalizer changes rotate foundation (`90439518...`), ingestion (`7410459b...`), pf2_engine (`6090066f...`), fixed_eval (`39c390de...`) and mp-combined (`b6deab3b...`); legacy, pf2_evaluator and trace are unchanged. Under rule C3 a rotation alone is class B. The E180 equivalent is re-pinned at the source commit (E188, with E195 for the trace closure test); the source identities of F04-03, P03-01, F06-01 and P05-01 name the new pins.
- **`3a4cb87`.** `test/phase1.test.js` now replays the exact enrollment code that `test/helpers.mjs` returns, instead of a recomputed code that could cross a 30-second step. The replay assertion is exact, not weakened (E194, F01-01).
- **Every other row** carries with its S5 rationale, including the staging T credits of earlier scorecards.

## Rule C3 for `5be0968..5f05ade`

The builder fails if any path outside `docs/` and `*.md` changed in the window and is not in this reviewed set (20 product paths and 34 test-only paths). It also fails if the product tree at the source commit differs from `e278721`, whose exact CI is 9 of 9 (E186). No path is unclassified. No hunk is class C. One path is class D: `public/setup-guide.js`, for F01-03 only, handled by the ruled V move and not by carry.

| Path | Class | Rows whose closure it touches | Reason |
| --- | --- | --- | --- |
| `public/i18n.js` | B | F01-01, F01-03, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-04, F08-01, P01-01, P03-02, P04-02, P06-01, P06-03 | 199 lines added and none changed or removed: one scope-label pair inside overviewPairs (L13, 66550ec) and 198 lines after line 1141 (the QR-4 selection page pairs of 17e2bb9). English output of every existing key is unchanged. |
| `public/index.html` | A/B | F01-01, F01-03, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-04, F08-01, P01-01, P03-02, P04-02, P06-01, P06-03 | Class B: cache tokens only (setup-guide.js sg2 to sg3, i18n.js qr3i2 to qr3i3 to qr3i3q4, research-library.js qr3l1 to qr3l1q4). Class A: one added script tag for qr4-selection.js, which builds only its own panel under [data-page="quant"] and loads data only when the owner opens that panel. |
| `public/qr4-selection.js` | A | none with V or T credit (F10-03 I context) | New module (17e2bb9). It appends its own closed panel to the Quant page and requests data only on the panel toggle; the API behind it answers only with QR4_SELECTION_ENABLED=1, which is off. No certified flow opens it. |
| `public/research-library.js` | B | F08-01, P06-01, P06-03 | 17e2bb9 adds one display line, "Development scores, not a ranking." (OD-S20), above the winner line. List, inspect, detail and compare logic are unchanged; the "No qualified winner" text stays. Unchanged from 5be0968 to ab1c1f1. |
| `public/setup-guide.js` | D | F01-03 only | L13 fix 66550ec: the activate step is read per Bot from that Bot readiness report instead of owner-wide Bridge counts, and analyze and draft carry a whole-account scope label. This changes the certified step state of F01-03, so it is not a C3 carry: F01-03 V moves under Root ruling SB385 item 1 on the accepted L13 record (E185) and exact CI (E186). The file at the source commit is byte-equal to the 66550ec blob pinned in E185 (E189; the builder checks it). No other scored closure loads it. |
| `scripts/grant-quant-comparison-runtime.mjs` | A | none | New set C operator tool (ab1c1f1): the targeted runtime grant for the QR-3 comparison tables. Imported by no runtime root; it runs only when an operator invokes it under its own GO. |
| `src/postgres/comparison-finalizer.js` | B | F04-03, P03-01, F06-01, P05-01 (identity only) | Header comment edits only (816c656). The file is in the runtime engine manifest, so the edit rotates identities (class B; E188). |
| `src/postgres/qr3-comparison-wiring.js` | A/B | F04-03, P03-01, F06-01, P05-01 (worker root), F01-01, F04-04, P03-02, F06-03 (server root) | Hardening slices A and B (5a36143, 816c656, owner GO OG-2 for B). Class B: top-level imports and constants only (driver stop grace, admission bounds, the independence version, the replay-disable list); identity rotation through the manifest (E188). Class A: the independence mapping, bounded admission retries and the driver stop act only in the QR-3 deps and driver, which are built only when the QR-3 flags are exactly on. |
| `src/postgres/qr3-independence.js` | A | none | New module (5a36143); imported only by qr3-routes.js (QR-3 create). |
| `src/postgres/qr3-routes.js` | A | F01-01, F04-04, P03-02, F06-03 (through server.js) | QR-3 create freezes the independence facts and the G1 to G8 gate snapshot (5a36143). qr3Routes still returns false unless enabled is true and the path is /api/quant/comparisons or below, before any authentication or body read. |
| `src/postgres/qr4-routes.js` | A | F01-01, F04-04, P03-02, F06-03 (through server.js) | New module (d682b3f). qr4Routes returns false unless enabled is exactly true and the path is /api/quant/selections or below, before any authentication, body read or deferred phase; only there does it set res.phase2Deferred. Top level declares constants and functions only. |
| `src/postgres/quant-comparison-grant-state.js` | A | none | New module (ab1c1f1); imported only by the grant tool and quant-comparison-grants.js. |
| `src/postgres/quant-comparison-grants.js` | A | none | New module (ab1c1f1); imported only by the grant tool. |
| `src/postgres/quant-library.js` | A/B | F08-01, P06-01, P06-03 | Class A or B (5a36143): the new exported gateSnapshot is called only by the flag-gated QR-3 create. Class B (a488d50): checkedQuery refuses a rank-like query key with QR4_DEVELOPMENT_SCORE_NOT_RANKABLE before the INVALID_FIELDS check. Such a key was already refused with INVALID_FIELDS before any read, and the accepted keys limit, before, bot_id and run_id never match the rule (checked at build), so every certified request answers as before and only the code of an already-refused request changes. The class C reading is recorded under rootVariants. |
| `src/postgres/quant-selection-migration.js` | A | none (F10-03 context) | Q4-S guard and foreign-key names (33a3b0b). Imported only by scripts/migrate-quant-selection.mjs; nothing calls it from db.migrate; the QR-4 SQL is not installed. |
| `src/postgres/quant-selection.sql` | A | none (F10-03 context) | Q4-S: the quant_jobs foreign key and the QR004 start-job guard in the uninstalled QR-4 SQL file. |
| `src/postgres/selection-inputs.js` | A | none | New module (d682b3f); imported only by qr4-routes.js. |
| `src/postgres/server.js` | A/B | F01-01, F04-04, P03-02, F06-03 | Class B: one import and two flag constants. Class A: botPolicyReader is built only with QR4_SELECTION_ENABLED=1, and qr4Routes answers only its own pathname with the flag on. |
| `src/selection-eval/evaluation-adapter.js` | A | none | New module (f3f392d); imported only by selection-finalizer.js. |
| `src/selection-eval/selection-finalizer.js` | A | none | New module (f3f392d); nothing imports it (unwired). |

CI per product commit in the window (E186): 66550ec 9/9, 5a36143 7/9, 3a4cb87 9/9, 816c656 9/9, ab1c1f1 9/9, f3f392d 9/9, d682b3f 8/9, a488d50 9/9, 33a3b0b 9/9, 17e2bb9 9/9, e278721 9/9. `5a36143` failed the TOTP replay check, fixed test-only by `3a4cb87`; `d682b3f` had one PostgreSQL timing flake, fixed test-only by `e278721`.

Pinned row tests: changed only in cache-token strings, in the identity pins of `test/mp-engine-closure.test.js` (E188) and `test/trace-reproduction-closure.test.js` (E195), in `test/setup-guide-ui.test.js` (extended for the per-Bot fix, no assertion weakened) and in `test/phase1.test.js` (E194). Test-only paths: `test/asset-cache-tokens.test.js`, `test/bridge-wizard-ui.test.js`, `test/helpers.mjs`, `test/helpers/qr4-selection-fixture.mjs`, `test/helpers/quant-fixed-eval-fixture.mjs`, `test/journey-ui.test.js`, `test/market-chart-ui.test.js`, `test/mp-engine-closure.test.js`, `test/pf3-readiness-ui.test.js`, `test/phase1.test.js`, `test/postgres/qr3-end-to-end.test.mjs`, `test/postgres/qr3-routes.test.mjs`, `test/postgres/qr4-finalizer.test.mjs`, `test/postgres/qr4-routes.test.mjs`, `test/postgres/qr4-selection-inputs.test.mjs`, `test/postgres/quant-comparison-grants.test.mjs`, `test/postgres/quant-selection-recheck.test.mjs`, `test/postgres/quant-selection-register.test.mjs`, `test/postgres/quant-selection.test.mjs`, `test/qr2-performance-ui.test.js`, `test/qr3-comparison-ui.test.js`, `test/qr3-independence.test.js`, `test/qr3-routes.test.js`, `test/qr3-wiring-static.test.js`, `test/qr4-development-view.test.js`, `test/qr4-evaluation-adapter.test.js`, `test/qr4-finalizer-static.test.js`, `test/qr4-routes.test.js`, `test/qr4-selection-ui.test.js`, `test/quant-comparison-grants-static.test.js`, `test/quant-library-ui.test.js`, `test/setup-guide-per-bot.test.js`, `test/setup-guide-ui.test.js`, `test/trace-reproduction-closure.test.js`.

## All 54 rows

Credits are D/I/V/T, with U for UNKNOWN. Evidence IDs E001 to E183 are the S1 to S5 pins (see the [S5 JSON](PM1_SCORECARD_S5_2026-11-06.json)); E184 to E195 are new in S6 (index below). Row rationale, source identity and limits are in the JSON.

| ID | Outcome | Target | S5 | S6 | Change | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F01-01 | Owner authentication and tenant-scoped access | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E001, E002, E003, E077, E116, E117, E132, E133, E141, E142, E143, E149, E150, E173, E177, E158; new: E191, E194, E186, E187 |
| F01-02 | Bot creation and lifecycle | staging | 1/1/1/0 | 1/1/1/0 | carried | E004, E005, E078 |
| F01-03 | Shared UI and journey visibility | staging | 1/1/0/0 | 1/1/1/U | credit moved | E006, E005, E004, E092, E106, E108, E110, E112, E141, E159; new: E185, E186, E187, E189 |
| F02-01 | Single-Pine registry, AI generation and guide | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E007, E008, E081, E141, E160; new: E187 |
| F02-02 | Ten-input selection and round-trip | staging | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| F02-03 | Versioned authenticated transport and scoped targeting | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E011, E077, E141; new: E187 |
| F03-01 | Paper risk decisions, allocation and targeted EXIT baseline | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E012, E011, E077, E141; new: E187 |
| F03-02 | O3/G1/F4 accounting corrections | local integrated code | 1/1/1/1 | 1/1/1/1 | carried | E008, E013, E014 |
| F03-03 | Worker transient faults, bounded rejection and systemic hold | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E008, E014, E015, E109, E111, E141, E142, E143, E149, E150; new: E187 |
| F03-04 | Database transaction and runtime lease integrity | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E016, E013, E057, E058, E062, E075, E099, E100, E109, E111, E141, E142, E143, E149, E150; new: E187 |
| F03-05 | Tracked script and source writer guard | local test integration | 1/1/1/1 | 1/1/1/1 | carried | E017 |
| F04-01 | Spot ingestion and bounded BACKFILL provenance | staging | 1/1/1/1 | 1/1/1/1 | carried | E018 |
| F04-02 | Prototype charts and market-data diagnostics | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E011, E019, E004, E079, E141, E159; new: E187 |
| F04-03 | PF-2 historical Preflight | staging | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131, E175, E178, E180, E158; new: E188, E193, E186 |
| F04-04 | PF-3 readiness report | staging | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E008, E004, E079, E081, E097, E118, E126, E133, E139, E141, E159, E175, E177, E158; new: E187, E191, E188, E186 |
| F04-05 | PF-4 deterministic Risk proposals | staging | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E079 |
| F05-01 | Supported source evaluator baseline | local validated engine | 1/1/1/1 | 1/1/1/1 | carried | E012, E023, E153, E158 |
| F05-02 | Selected-input empirical parity and supported effects | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| F05-03 | Cost, chronological validation and holdout semantics | local validated engine | 1/1/1/1 | 1/1/1/1 | carried | E025, E012, E026, E076, E083, E173, E176, E180, E158, E161 |
| F06-01 | Immutable research jobs, progress and cancellation | staging | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131, E173, E175, E178, E180, E158; new: E188, E195, E186 |
| F06-02 | Bounded optimizer execution and terminal outcome | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| F06-03 | Legacy optimize request and transaction containment | local integrated code | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E027, E059, E060, E061, E062, E072, E073, E074, E116, E117, E124, E132, E133, E134, E177, E158; new: E191, E186 |
| F07-01 | W7 recovery and D6 diagnostic admission prerequisites | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E028, E029, E030, E008 |
| F07-02 | R7 J1-J4 scheduler and resource-accounting cases | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E031, E032 |
| F07-03 | EM2 measurement controller and recovery tooling | local accepted tooling | 1/1/1/1 | 1/1/1/1 | carried | E033, E034, E035, E036 |
| F07-04 | Fresh R7 capacity measurement and qualification | supervised staging | 1/0/0/0 | 1/0/0/0 | carried | E037, E031, E156, E161 |
| F08-01 | Owner-scoped Library storage and inspection | staging | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137, E141, E159, E174, E179, E158; new: E187, E190, E192, E186 |
| F08-02 | QR-1b durable artifact freeze | staging | 1/1/1/0 | 1/1/1/0 | carried | E038, E040, E079, E083, E115, E109, E124, E138, E142, E143, E149, E150 |
| F09-01 | Qualified Best Inputs package and validation | staging | 1/1/0/0 | 1/1/0/0 | carried | E041, E008, E042, E086, E093, E157, E162, E163, E164, E165, E166, E167, E181, E182 |
| F09-02 | Export and matching email report delivery | staging | 1/0/0/0 | 1/0/0/0 | carried | E041, E008, E043, E154 |
| F09-03 | Explicit review, import and owner handoff | staging | 1/0/0/0 | 1/0/0/0 | carried | E041, E008, E155 |
| F10-01 | QR-2 actual Paper portfolio performance | staging | 1/0/0/0 | 1/0/0/0 | rationale refreshed | E042, E008, E087, E142, E143, E149, E150, E141, E146, E148, E161; new: E187 |
| F10-02 | QR-3 full fair comparison | staging | 1/1/0/0 | 1/1/0/0 | rationale refreshed | E042, E008, E094, E158, E168, E169, E170, E171, E172; new: E186, E187, E193 |
| F10-03 | QR-4 qualified best-performance selection | staging | 1/0/0/0 | 1/0/0/0 | rationale refreshed | E042, E008, E095, E094, E086; new: E186, E187 |
| F11-01 | Multi-Pine contracts and evaluator/package compatibility | isolated accepted fixture | U/0/0/0 | U/0/0/0 | carried | E041, E001, E008, E096, E086 |
| F11-02 | APP-3B multi-Pine Paper isolation and canary | staging | U/0/0/0 | U/0/0/0 | carried | E008, E044 |
| F12-01 | MD-1 production market-data scaling | production qualification | U/0/0/0 | U/0/0/0 | carried | E008 |
| F12-02 | Customer lifecycle, quotas and entitlement | Paper beta | U/0/0/0 | U/0/0/0 | carried | E045, E046, E008 |
| F12-03 | Customer security and launch operations | Paper beta | U/0/0/0 | U/0/0/0 | carried | E008, E045, E142, E143, E149, E150 |
| F12-04 | Reviewed Paper production rollout and observation | production | 1/0/0/0 | 1/0/0/0 | carried | E045, E008, E047, E048, E049, E050 |
| P01-01 | Generate the supported Bridge and guide | staging owner journey | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E007, E008, E081, E141, E160; new: E187 |
| P02-01 | Ten-input round-trip and coherent selection | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| P02-02 | Effects and parity of the selected dimensions | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| P03-01 | Historical Preflight on an admitted supported profile | staging owner journey | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131, E175, E178, E180, E158; new: E188, E193, E186 |
| P03-02 | Readiness with honest historical status | staging owner journey | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E008, E004, E079, E081, E097, E118, E126, E133, E139, E141, E159, E175, E177, E158; new: E187, E191, E188, E186 |
| P03-03 | Policy-bound Risk preview and save | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E004, E079 |
| P04-01 | Real same-entry TradingView BUY and targeted EXIT | staging owner journey | 1/1/1/1 | 1/1/1/1 | carried | E006, E011 |
| P04-02 | Paper risk, isolation and ledger reconciliation | staging owner journey | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E012, E011, E077, E141; new: E187 |
| P05-01 | Snapshot, progress, cancel and durable result controls | staging owner journey | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131, E173, E175, E178, E180, E158; new: E188, E195, E186 |
| P05-02 | Current profile capacity and admission | supervised staging | 1/0/0/0 | 1/0/0/0 | carried | E037, E031, E156, E161 |
| P05-03 | One bounded supported terminal run | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| P06-01 | Reopen and inspect preserved runs | staging owner journey | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137, E141, E159, E174, E179, E158; new: E187, E190, E192, E186 |
| P06-02 | Artifact durability and freeze | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E038, E040, E079, E083, E115, E109, E124, E138, E142, E143, E149, E150 |
| P06-03 | Minimal compatible comparison and qualification display | staging owner journey | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E008, E004, E038, E079, E090, E092, E103, E104, E105, E114, E109, E112, E124, E135, E136, E141, E159, E174, E179, E183, E158; new: E187, E190, E192, E186 |

## New evidence (pinned to Git blobs at `5f05ade`)

| ID | Path | sha256 (first 12) | What it shows |
| --- | --- | --- | --- |
| E184 | [docs/progress/PM1_SCORECARD_S5_2026-11-06.json](../../docs/progress/PM1_SCORECARD_S5_2026-11-06.json) | `5374190f71e5` | Prior scorecard S5 JSON (accepted 2026-11-06, frozen in d357cfa). Context pin. |
| E185 | [docs/evidence/PM1_F01_03_L13_SETUP_GUIDE_LOCAL_2026-11-06.json](../../docs/evidence/PM1_F01_03_L13_SETUP_GUIDE_LOCAL_2026-11-06.json) | `94a06e6b66e7` | L13 per-Bot setup-guide fix at 66550ec, Root-accepted local evidence (SB193): tester 220 of 220 with 5 mutants caught, Opus re-audit READY, CI 9 of 9 on 66550ec; its rootAcceptance allows a successor scorecard to return F01-03 V from 0 to 1 citing it with green CI; limits listed in the record. |
| E186 | [docs/evidence/PM1_S6_CI_READ_2026-11-12.json](../../docs/evidence/PM1_S6_CI_READ_2026-11-12.json) | `ad3ff6860550` | Root REST read of the GitHub check runs of every product commit in the S6 window (read 2026-11-12T20:01:05Z, committed in 5f05ade): 9 of 9 on 66550ec, 3a4cb87, 816c656, ab1c1f1, f3f392d, a488d50, 33a3b0b, 17e2bb9 and e278721; 5a36143 7 of 9 (TOTP replay flake, fixed test-only by 3a4cb87) and d682b3f 8 of 9 (PostgreSQL timing flake, fixed test-only by e278721). |
| E187 | [docs/ROADMAP.md](../../docs/ROADMAP.md) | `c129edf554be` | Roadmap at the source commit. The REPIN-3 A2 paragraph (added in 4db161b, accepted by SB385 item 4 as the tracked statement of the pin): staging API and trading worker run ab1c1f1, the research worker stays stopped on the older pin, QR-3 and the five research flags 0; the owner browser check (QR-2 All Time 403 QR2_RANGE_ADMISSION_REFUSED under OD-S5-D, QR-3 panel "not available on this release"). Also the 2026-11-07 OG-2 entry and the 2026-11-08 local build-day entry (QR-4 state). |
| E188 | [test/mp-engine-closure.test.js](../../test/mp-engine-closure.test.js) | `7dc7a0326672` | Tracked engine identity pins at the source commit with the 816c656 rotation (QR-3 hardening slice B, owner GO OG-2): foundation, ingestion, pf2_engine, fixed_eval and mp-combined rotated; legacy, pf2_evaluator, trace and mp-package-trace unchanged. Successor of E180. |
| E189 | [public/setup-guide.js](../../public/setup-guide.js) | `4544142df6e1` | Rule C3 subject (class D, F01-03 only): the L13 per-Bot setup guide, byte-equal to the 66550ec blob pinned in E185. |
| E190 | [src/postgres/quant-library.js](../../src/postgres/quant-library.js) | `648aee884af3` | Rule C3 subject: gateSnapshot (flag-gated QR-3 caller only) and the rank-like query-key refusal of a488d50 (class B). |
| E191 | [src/postgres/server.js](../../src/postgres/server.js) | `14137e71a93a` | Rule C3 subject: the QR-4 import, flag constants, the flag-gated botPolicyReader and the qr4Routes call. |
| E192 | [public/research-library.js](../../public/research-library.js) | `c536ad66b81b` | Rule C3 subject: the added "Development scores, not a ranking." line (display only). |
| E193 | [src/postgres/qr3-comparison-wiring.js](../../src/postgres/qr3-comparison-wiring.js) | `c5a20a3f6c8a` | Rule C3 subject: QR-3 hardening slices A and B in the wiring module (flag-gated; identity rotation). |
| E194 | [test/phase1.test.js](../../test/phase1.test.js) | `f8d1ea97cfb0` | Pinned replay test after 3a4cb87: the MFA replay check now replays the exact enrollment code (test/helpers.mjs returns it), not a recomputed one; the assertion is not weakened. |
| E195 | [test/trace-reproduction-closure.test.js](../../test/trace-reproduction-closure.test.js) | `861008a79bc0` | Tracked FOUNDATION and FIXED_EVAL pins at the source commit after the 816c656 rotation; LEGACY and the trace closure unchanged. |

E184 is a context pin that no row cites. Inherited pins E001 to E183 keep their S5 bindings and rules; E027 stays a disk pin to an ignored local artifact that the candidate author does not hash.

## Ambiguities and the value used

- **B1. F01-03 V without a fresh render.** The new setup-guide bytes have jsdom tests, an audit and CI, but no render and no phone-width check (the S2 Q3 rendered-layout argument). SB385 item 1 rules **V = 1** with the limits carried on the row. The UNKNOWN reading gives project 20783/300 to 303/4 (69.28% to 75.75%), UNKNOWN 463/15.
- **B2. F01-03 T after the release.** The E185 sentence keeps T at 0 until a readback; the method rule keeps 0 only for a known staging defect. SB385 item 2 rules **T = UNKNOWN**. The literal reading gives project 21083/300 to 901/12 (70.28% to 75.08%), UNKNOWN 413/15.
- **B3. L9 T carry across the re-pin.** S5 scored T on staging bytes that differed from the V closure only by class A or B hunks; S6 applies the same class rule across the `75c7a5b` to `ab1c1f1` re-pin. SB385 item 3 rules the carry: **T = 1** for the five rows. The strict reading gives project 20783/300 to 303/4 (69.28% to 75.75%), UNKNOWN 538/15 and prototype 881/12 to 973/12 (73.42% to 81.08%), UNKNOWN 115/3.
- **B4. `a488d50` rank-like refusal in `quant-library.js`.** Not flag-gated. A rank-like query key was refused before any read with INVALID_FIELDS and is now refused before any read with QR4_DEVELOPMENT_SCORE_NOT_RANKABLE; the accepted keys never match (checked at build). The candidate reads it as class B (no certified answer changes). If Root reads it as class C and does not accept it as carry, F08-01, P06-01 and P06-03 V and T go to UNKNOWN: project 20633/300 to 303/4 (68.78% to 75.75%), UNKNOWN 508/15, prototype 291/4 to 973/12 (72.75% to 81.08%), UNKNOWN 95/3.
- **B5. Staging pin record.** The pin rests on the Roadmap paragraph added in `4db161b` (E187), which SB385 item 4 accepts as the tracked statement; the A2 result record is untracked.
- **Carried.** A1 (F10-01 I = 0), the S3 class C carry (variant E), F01-03 V on a render (variant B, now B1) and the S3 variant C reading carry unchanged.

### Alternatives (exact project and prototype lower / upper / UNKNOWN weight)

| Alternative | Project | Prototype |
| --- | --- | --- |
| Candidate main position (exactly the Root-ruled moves) | 21083/300 / 303/4 / 463/15 | 913/12 / 973/12 / 25/1 |
| S5 position kept: F01-03 V 0 and T 0 (no move; not adopted) | 20783/300 / 889/12 / 413/15 | 913/12 / 973/12 / 25/1 |
| B1 render reading: F01-03 V UNKNOWN until the new setup-guide bytes are rendered (S2 Q3 argument; not adopted, SB385 item 1) | 20783/300 / 303/4 / 463/15 | 913/12 / 973/12 / 25/1 |
| B2 literal reading: F01-03 T 0 per the E185 sentence (not adopted, SB385 item 2) | 21083/300 / 901/12 / 413/15 | 913/12 / 973/12 / 25/1 |
| B3 strict L9 reading: the five L9 T credits UNKNOWN (readback at 75c7a5b not carried; not adopted, SB385 item 3) | 20783/300 / 303/4 / 538/15 | 881/12 / 973/12 / 115/3 |
| B4 a488d50 class C reading: F08-01, P06-01 and P06-03 V and T UNKNOWN (not adopted) | 20633/300 / 303/4 / 508/15 | 291/4 / 973/12 / 95/3 |
| A1 option U carried: F10-01 I UNKNOWN instead of 0 (not adopted) | 21083/300 / 4577/60 / 161/5 | 913/12 / 973/12 / 25/1 |
| S3 variant E carried: class C not accepted (F04-03, P03-01, F06-01, P05-01 V UNKNOWN) | 20603/300 / 303/4 / 181/5 | 865/12 / 973/12 / 115/3 |
| S3 variant C / A5 strict carried: F03-03 and F03-04 T 0 | 21083/300 / 7479/100 / 391/15 | 913/12 / 973/12 / 25/1 |

Main position in percent: project 70.28 to 75.75, prototype 76.08 to 81.08.

## Acceptance gates (statuses unchanged from S5)

Gate statuses stay separate from the arithmetic and grant no GO. The project remains Spot/Paper only; Live is hard-locked; private acceptance is NOT RUN; READY is false; P13j and N1 are held.

| Gate | Status | Limitation or next step | S6 note |
| --- | --- | --- | --- |
| G-BRIDGE | PASS | Not current host health or arbitrary Pine support. | Unchanged from S5. |
| G-INPUTS | OPEN | Close S4 behavioral and remaining S6/S7 acceptance within the frozen selection contract. | Unchanged from S5. |
| G-PREFLIGHT | BLOCKED | Close capacity/enrollment and the separately authorized measurement/activation gates. | Unchanged from S5. |
| G-R7 | OPEN | Review amendment and obtain the required successful runtime measurement; J1-J4 prerequisite success is narrower. | S6: no capacity epoch ran in the window (Roadmap at the source commit, E187). Status unchanged. |
| G-PO1-CI | PASS | Closed for local integration scope: independent six cases 6/6 and exact CI 9b63d77 9/9. Staging release containing PO1 remains a separate gate. S2: db.js changed after PO1 only by the 720b433 close() fix; exact CI on ca6abb1 passed 9/9 per root ruling P1. | Unchanged from S5. |
| G-DP1-24H | PASS | Root accepted 2026-10-16T09:53:22.756Z: POST_PASS, 127,781,220 ms after the switch receipt, worker unchanged, zero restarts, health HTTP 200, queues and Live zero, 205 independent assertions. One dated sample, not continuous health; no positive O3-rule fill; service identity UNKNOWN. | Unchanged from S5. |
| G-PRODUCTION | BLOCKED | Staging 24-hour observation now accepted as one dated sample (G-DP1-24H). Still open: production identity (watch-service identity UNKNOWN), runner wiring and transport, native capability, recovery, policy and release gates before any authorized deployment. The B2 supervision probe windows are bounded behaviour records with productionQualified false. Nothing deployed to production. | S6: staging moved to ab1c1f1 under its own owner GOs; nothing ran on production. Status unchanged. |
| G-FREEZE | OPEN | Resolve the required policy and target integration gates; local evidence does not prove staging migration. | Unchanged from S5. |
| G-LAUNCH | OPEN | Implement and accept the declared remaining product and launch outcomes. Optional Live remains excluded. | Unchanged from S5. |
| G-FRESH-HEALTH | UNKNOWN | No host step in this root session; historical observations are dated evidence only. | S6: stays UNKNOWN. The REPIN-3 A2 release checks at ab1c1f1 (immediate and 5-minute delayed checks, A2M read-only probe; E187) are dated release checks, not continuous host health. |
| G-LO1-LOCAL | PASS | Local only; lost-COMMIT acknowledgement untested; not deployed or backported to the DP1-P candidate. | Unchanged from S5. |

## Local, staging and production

Local, staging and production are different targets. Staging moved from API `75c7a5b` and trading worker `ba1a433` to `ab1c1f1` (REPIN-3 A2, under its own owner GOs); the research worker stays stopped on the older pin, and QR-3 and the five research flags are 0 on staging. `ab1c1f1` contains the L13 fix and QR-3 hardening slices A and B. Every QR-4 commit (`f3f392d`, `d682b3f`, `a488d50`, `33a3b0b`, `17e2bb9`) and `e278721` are local only. No staging readback was made at `ab1c1f1` for any scored row; the S6 moves rest on local evidence and CI (F01-03 V) and on the method rule (F01-03 T). Nothing ran on production. A design acceptance is not a GO. Local evidence is not staging evidence, and staging evidence is not production evidence. Commit, CI, deployment and acceptance are separate facts.

## Reproduction

From the repository root:

```text
node .qa-local/s6-freeze-2026-11-12/build-s6-freeze.mjs --commit=5f05ade --scored-at=2026-11-12T20:02:01Z
node .qa-local/s6-freeze-2026-11-12/build-s6-freeze-md.mjs
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S6_2026-11-12.json
```

The calculator command names the target path, valid after Root moves the file. E027 is not hashed by the candidate author. The scored-at value is passed by Root at run time; the builder reads no clock. Root freeze run: the CLI on the full file (E027 hashed); the verify copy without E027 gave 194 of 194; S2 verifier 7 of 7 PASS. The S2 independent verifier ran as a byte copy on the verify copy; see the run files beside the candidate.
