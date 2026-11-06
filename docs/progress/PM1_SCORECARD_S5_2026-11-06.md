# PM-1 scorecard S5, 2026-11-06 (UTC)

**Status: `COMPLETE_WITH_EXPLICIT_UNCERTAINTY`. Accepted by Claude root on 2026-11-06T18:29Z (UTC).** Root accepted the scorecard. Root checks at source commit 5be0968: the repo calculator CLI on this file verified 183 of 183 evidence hashes (E027, the inherited disk pin, hashed by the CLI on the full file), 54 rows, stored totals equal computed; the S2 independent verifier byte copy with the hook passed 7 of 7 on the full file; freeze-check 5 of 5 before acceptance (15 ruled stage moves in 13 rows, no other credit change, product tree equal to the CI-green 0fe7644). Results: project 20783/300 (69.28%) to 889/12 (74.08%), prototype 913/12 (76.08%) to 973/12 (81.08%). Prepared by an architecture auditor child (Opus 5.5, high effort). It changes no gate, GO, product acceptance or runtime state.

- Scorecard ID: `PM1-S5-2026-11-06`. Method PM-1, inventory PM1-I1 (sha256 `233f5fbea8435599`, unchanged), same weights, shares, targets and rules.
- Prior scorecard: PM1-S4-2026-11-05 ([JSON](PM1_SCORECARD_S4_2026-11-05.json), evidence E152), source commit `939045e`.
- Source commit: `5be0968` on `codex/fe2b-ci-local-fix`. Evidence window: tracked commits `939045e..5be0968`. Untracked Root rulings are context only and score nothing; each credit move cites a tracked record.
- Scored at 2026-11-06T18:25:53Z (Asia/Bangkok 2026-11-07 01:25).

## Result

| View | Lower | Upper | UNKNOWN weight |
| --- | ---: | ---: | ---: |
| Project | 69.28% (20783/300) | 74.08% (889/12) | 27.53 (413/15) |
| Prototype | 76.08% (913/12) | 81.08% (973/12) | 25.00 (25/1) |

Displayed whole percentages: project 69–74%, prototype 76–81% (S4: project 65–74%, prototype 73–81%). UNKNOWN credits remain in both views, so neither view has a single score. The bounds are engineering evidence bounds, not completion, and they grant no acceptance or GO.

## Change from S4

The series is comparable: inventory, weights, shares, targets and method did not change. Delta: project lower 239/60 (3.98 points), upper -1/3 (-0.33), UNKNOWN weight -113/6; prototype lower 10/3 (3.33), upper 0/1, UNKNOWN weight -20/1.

15 stage moves in 13 rows, exactly the set Root ruled. Each cites a tracked record pinned at `5be0968`:

| Row | Outcome | Stage | S4 | S5 | Root ruling |
| --- | --- | --- | --- | --- | --- |
| F05-01 | Supported source evaluator baseline | V | UNKNOWN | 1 | SB169 ruling 2 |
| F05-01 | Supported source evaluator baseline | T | UNKNOWN | 1 | SB169 ruling 2 |
| F09-02 | Export and matching email report delivery | D | UNKNOWN | 1 | SB166 ruling 1 |
| F09-03 | Explicit review, import and owner handoff | D | UNKNOWN | 1 | SB166 ruling 1 |
| F07-04 | Fresh R7 capacity measurement and qualification | D | UNKNOWN | 1 | SB182 ruling 2 |
| P05-02 | Current profile capacity and admission | D | UNKNOWN | 1 | SB182 ruling 2 |
| F09-01 | Qualified Best Inputs package and validation | I | 0 | 1 | SB176 ruling 10 and SB183 ruling 4 |
| F10-02 | QR-3 full fair comparison | I | 0 | 1 | SB188 ruling 1 (RR-7) |
| F08-01 | Owner-scoped Library storage and inspection | T | UNKNOWN | 1 | SB189 ruling 1 |
| P06-01 | Reopen and inspect preserved runs | T | UNKNOWN | 1 | SB189 ruling 1 |
| P06-03 | Minimal compatible comparison and qualification display | T | UNKNOWN | 1 | SB189 ruling 2 |
| F04-04 | PF-3 readiness report | T | UNKNOWN | 1 | SB189 ruling 3 |
| P03-02 | Readiness with honest historical status | T | UNKNOWN | 1 | SB189 ruling 3 |
| F01-03 | Shared UI and journey visibility | T | UNKNOWN | 0 | SB189 ruling 5 |
| F01-03 | Shared UI and journey visibility | V | 1 | 0 | SB192 ruling 1 |

What the moves rest on:

1. **F05-01 V and T** (E153): the Root-accepted evaluator closure carry for the frozen-policy scope. The closure product files are unchanged from the record revision `680039f` to the source commit (the builder checks this). Limitations are carried on the row.
2. **F09-02 D and F09-03 D** (E154, E155): Root-accepted design contracts, revision 1. Every owner decision is OPEN; nothing is implemented; the F09-03 apply lock stays closed.
3. **F07-04 D and P05-02 D** (E156): the EM3 design contract, DESIGN_ACCEPTED_NOT_A_GO. No epoch ran; step B is still required before any epoch GO.
4. **F09-01 I** (E157): the F09 one-Pine fixture build and attempt service builds one labelled fixture export from a stored v3 run and validates it to fixture EXPORT_VALIDATED; CI 9 of 9 on `f38048b`. Unwired; READY false.
5. **F10-02 I** (E158): QR-3 STANDARDIZED fair comparison (L8-A, L8-B, L8-C, L8-W) implemented and integrated locally behind two default-off flags; CI 9 of 9 on all four commits. RR-7: ACTUAL_BOT is not required for I. Not on staging.
6. **T moves from the L9 readback** (E159): F08-01, P06-01, P06-03, F04-04 and P03-02 move to 1, each with a recorded limitation. F01-03 moves to 0: the setup guide showed an inaccurate activate step for a Bot with no READY Bridge deployment. F04-02 T stays UNKNOWN (only the current state was observed).

Rationale-only rows (credits unchanged): F01-01, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-03, F05-03, F06-01, F06-03, F10-01, P01-01, P03-01, P04-02, P05-01. They carry rule C3 notes for the window, the freshened F10-01 implementation status (slice b-2 local, gate L-b HOLD, full S5 open) and an unchanged staging-pin note.

## Rule C3 for `939045e..5be0968`

The builder fails if any path outside `docs/` and `*.md` changed in the window and is not in this reviewed set (22 product paths and 32 test-only paths). It also fails if the product tree at the source commit differs from `0fe7644`, whose exact CI is 9 of 9 (E158). No path is unclassified. No hunk is class C or D.

| Path | Class | Rows whose closure it touches | Reason |
| --- | --- | --- | --- |
| `public/i18n.js` | B | F01-01, F01-03, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-04, F08-01, P01-01, P03-02, P04-02, P06-01, P06-03 | 187 lines appended after line 953 (the quant risk and research label pairs of 4dc9fbd and the QR-3 panel pairs of 32ec0d8); no existing line is changed or removed, so English output is unchanged; the translation tests keep the pairs unique and free of collisions. |
| `public/index.html` | A/B | F01-01, F01-03, F02-01, F02-03, F03-01, F03-03, F03-04, F04-02, F04-04, F08-01, P01-01, P03-02, P04-02, P06-01, P06-03 | Class B: cache tokens only (i18n.js qr2o10 to qr3i2, research-library.js rel20261007 to qr3l1). Class A: one added script tag for qr3-comparison.js, which builds only its own closed panel on the Quant page. |
| `public/qr3-comparison.js` | A | none with V or T credit (F10-02 I evidence) | New module. It appends its own closed panel to the Quant page and sends a request only when the owner opens that panel; the API behind it is off by default and a 404 shows as an unavailable release. No certified flow opens it. |
| `public/research-library.js` | B | F08-01, P06-01, P06-03 | Only the compare view and its error label change. The inspect and detail view is unchanged (F08-01, P06-01). For P06-03 the heading becomes "Same-source context check" with a verdict chip, a note and a library context key column; incompatible runs still show no metrics and the no-qualified-winner text stays, so the certified outcome is unchanged. The pinned UI test E104 changed in reviewed commit 32ec0d8 with its withholding and winner assertions kept. |
| `quant_lab/src/robot_quant/research_engine.py` | A/B | F05-03 (and the legacy and foundation engine identities) | Class A: ql3a-research-job-v3 joins the supported versions; a v1 request passes the same check and the evaluation path is unchanged. Class B: the file is in the legacy engine list, so the legacy identity rotates (988171... to a6be760..., tracked closure test E180). |
| `quant_lab/tests/test_research_engine.py` | TEST | F05-03 | 40 added test lines (v3 accepted, v1 unchanged); no product byte. |
| `src/portfolio/qr2-coverage-limits.js` | A | F10-01 only (I 0, no certified clause) | QR-2 coverage slice b-2 (chunk 8192 to 4096). Reached only through the QR-2 routes behind QR2_PERFORMANCE_ENABLED and the QR-2 pathnames. |
| `src/portfolio/qr2-coverage-snapshot.js` | A | F10-01 only (I 0, no certified clause) | QR-2 coverage slice b-2 (cooperative union check). Same QR-2 route and flag discriminator. |
| `src/postgres/qr2-coverage-reader.js` | A | F10-01 only (I 0, no certified clause) | QR-2 coverage slice b-2 (double setImmediate yield). Same QR-2 route and flag discriminator. |
| `src/postgres/bi-package-store.js` | A | none with V or T credit (F09-01 I evidence) | New module; imported by no runtime root, route, worker or service (static isolation test); only its tests import it. |
| `src/postgres/comparison-finalizer.js` | A/B | none with V or T credit (F10-02 I evidence) | New module; imported only by qr3-comparison-wiring.js, which acts only with the QR-3 flags on (class A). It joins the runtime manifest, which rotates identities only (class B). |
| `src/postgres/comparison-store.js` | A/B | none with V or T credit (F10-02 I evidence) | Two new exported functions (cancelComparison, failComparison); existing functions unchanged; importers are the flag-gated QR-3 modules only (class A). Runtime manifest entry rotates identities only (class B). |
| `src/postgres/qr3-comparison-wiring.js` | A/B | F04-03, P03-01, F06-01, P05-01 (worker root), F01-01, F04-04, P03-02, F06-03 (server root) | New module imported by server.js and quant-research-main.js; its top level declares constants only (class B for the import). It builds the API deps or the evaluation driver only when the QR-3 flags are exactly on (class A). |
| `src/postgres/qr3-participant-context.js` | A | none | New module; imported only by qr3-routes.js. |
| `src/postgres/qr3-routes.js` | A | F01-01, F04-04, P03-02, F06-03 (through server.js) | New module. qr3Routes returns false unless enabled is true and the path is /api/quant/comparisons or below, before any authentication, body read or deferred phase. |
| `src/postgres/quant-library.js` | A/B | F08-01, P06-01, P06-03 | Class A: familyOf also maps ql3a-research-job-v3 to LEGACY; v1 and v2 classify as before. Class B: familyOf is exported. |
| `src/postgres/quant-research-main.js` | A/B | F04-03, P03-01, F06-01, P05-01 | Class A: the QR-3 driver is built and started only when QUANT_FIXED_EVAL_ENABLED and QR3_COMPARISON_ENABLED are both exactly 1. Class B: the import, and an optional-chained stop that does nothing when no driver was built. |
| `src/postgres/quant-research.js` | A/B | F06-01, P05-01, F05-03, F01-01 | Class A: the optional contract_version selector, the capability check (refuses without a registered reader; production wires none) and the FOUNDATION-mode refusal apply only to v3. Class B: the v3 module import, a v1 version constant, a null capabilityReader field and an identical v1 contract branch; authorize and its order are unchanged, and a body without contract_version is handled as before. |
| `src/postgres/server.js` | A/B | F01-01, F04-04, P03-02, F06-03 | Class B: two imports and a flag constant. Class A: QR-3 deps only with QR3_COMPARISON_ENABLED=1; qr3Routes answers only its own pathname with the flag on, and only there sets res.phase2Deferred. |
| `src/quant-library/trace-reproduction.js` | A | none with V or T credit (F09-01 I evidence) | v3 becomes an ACTIVE trace profile and the ports are bound to a named closure. Imported only by bi-package-store.js (unwired) and tests; no scored V or T closure contains it. |
| `src/quant-research/research-contract-v3.js` | A/B | F06-01, P05-01, F05-03 (through quant-research.js) | New module; used only in the v3 branch of quant-research.js (class A). Runtime manifest entry rotates identities only (class B). |
| `src/quant-research/runtime-engine-files.js` | B | F04-03, P03-01, F04-04, P03-02, F06-01, P05-01 | Seven manifest entries added (QR-3 and v3 modules). They rotate the foundation, ingestion, pf2_engine, fixed_eval and mp-combined identities only; a rotated engine makes stored evidence HISTORICAL_ENGINE_CHANGED or refuses old-hash jobs, which is the certified behaviour (S4 precedent for F04-04). |

Pinned row tests: unchanged, except E104 (`test/quant-library-ui.test.js`, P06-03), changed in reviewed commit `32ec0d8` without a weakened assertion (E183), and the engine identity pins in `test/mp-engine-closure.test.js` and `test/quant-engine-files.test.js`, updated in reviewed commits `faa3179` and `0fe7644` (E180). Test-only paths: `test/asset-cache-tokens.test.js`, `test/bi-package-store-static-isolation.test.js`, `test/bridge-wizard-ui.test.js`, `test/journey-ui.test.js`, `test/market-chart-ui.test.js`, `test/mp-engine-closure.test.js`, `test/pf3-readiness-ui.test.js`, `test/postgres/bi-package-build.test.mjs`, `test/postgres/bi-trace-reproduction.test.mjs`, `test/postgres/qr2-coverage-reader-chunked.test.mjs`, `test/postgres/qr3-end-to-end.test.mjs`, `test/postgres/qr3-finalizer.test.mjs`, `test/postgres/qr3-routes.test.mjs`, `test/postgres/quant-research-foundation.test.mjs`, `test/postgres/quant-research-v3.test.mjs`, `test/qr2-coverage-build-generator.test.js`, `test/qr2-coverage-reader-chunked.test.js`, `test/qr2-performance-ui.test.js`, `test/qr3-comparison-ui.test.js`, `test/qr3-finalizer-static.test.js`, `test/qr3-participant-context.test.js`, `test/qr3-routes.test.js`, `test/qr3-wiring-static.test.js`, `test/quant-engine-files.test.js`, `test/quant-library-compare-context.test.js`, `test/quant-library-derive.test.js`, `test/quant-library-package-gates.test.js`, `test/quant-library-trace-reproduction.test.js`, `test/quant-library-ui.test.js`, `test/quant-research-contract-v3.test.js`, `test/quant-risk-text-i18n.test.js`, `test/trace-reproduction-closure.test.js`.

## All 54 rows

Credits are D/I/V/T, with U for UNKNOWN. Evidence IDs E001 to E151 are the S1 to S4 pins (see the [S4 JSON](PM1_SCORECARD_S4_2026-11-05.json)); E152 to E183 are new in S5 (index below). Row rationale, source identity and limits are in the JSON.

| ID | Outcome | Target | S4 | S5 | Change | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F01-01 | Owner authentication and tenant-scoped access | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E001, E002, E003, E077, E116, E117, E132, E133, E141, E142, E143, E149, E150; new: E173, E177, E158 |
| F01-02 | Bot creation and lifecycle | staging | 1/1/1/0 | 1/1/1/0 | carried | E004, E005, E078 |
| F01-03 | Shared UI and journey visibility | staging | 1/1/1/U | 1/1/0/0 | credit moved | E006, E005, E004, E092, E106, E108, E110, E112, E141; new: E159 |
| F02-01 | Single-Pine registry, AI generation and guide | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E007, E008, E081, E141; new: E160 |
| F02-02 | Ten-input selection and round-trip | staging | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| F02-03 | Versioned authenticated transport and scoped targeting | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E011, E077, E141 |
| F03-01 | Paper risk decisions, allocation and targeted EXIT baseline | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E012, E011, E077, E141 |
| F03-02 | O3/G1/F4 accounting corrections | local integrated code | 1/1/1/1 | 1/1/1/1 | carried | E008, E013, E014 |
| F03-03 | Worker transient faults, bounded rejection and systemic hold | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E008, E014, E015, E109, E111, E141, E142, E143, E149, E150 |
| F03-04 | Database transaction and runtime lease integrity | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E016, E013, E057, E058, E062, E075, E099, E100, E109, E111, E141, E142, E143, E149, E150 |
| F03-05 | Tracked script and source writer guard | local test integration | 1/1/1/1 | 1/1/1/1 | carried | E017 |
| F04-01 | Spot ingestion and bounded BACKFILL provenance | staging | 1/1/1/1 | 1/1/1/1 | carried | E018 |
| F04-02 | Prototype charts and market-data diagnostics | staging | 1/1/1/U | 1/1/1/U | rationale refreshed | E011, E019, E004, E079, E141; new: E159 |
| F04-03 | PF-2 historical Preflight | staging | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131; new: E175, E178, E180, E158 |
| F04-04 | PF-3 readiness report | staging | 1/1/1/U | 1/1/1/1 | credit moved | E008, E004, E079, E081, E097, E118, E126, E133, E139, E141; new: E159, E175, E177, E158 |
| F04-05 | PF-4 deterministic Risk proposals | staging | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E079 |
| F05-01 | Supported source evaluator baseline | local validated engine | 1/1/U/U | 1/1/1/1 | credit moved | E012, E023; new: E153, E158 |
| F05-02 | Selected-input empirical parity and supported effects | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| F05-03 | Cost, chronological validation and holdout semantics | local validated engine | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E025, E012, E026, E076, E083; new: E173, E176, E180, E158, E161 |
| F06-01 | Immutable research jobs, progress and cancellation | staging | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131; new: E173, E175, E178, E180, E158 |
| F06-02 | Bounded optimizer execution and terminal outcome | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| F06-03 | Legacy optimize request and transaction containment | local integrated code | 1/1/1/1 | 1/1/1/1 | rationale refreshed | E027, E059, E060, E061, E062, E072, E073, E074, E116, E117, E124, E132, E133, E134; new: E177, E158 |
| F07-01 | W7 recovery and D6 diagnostic admission prerequisites | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E028, E029, E030, E008 |
| F07-02 | R7 J1-J4 scheduler and resource-accounting cases | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E031, E032 |
| F07-03 | EM2 measurement controller and recovery tooling | local accepted tooling | 1/1/1/1 | 1/1/1/1 | carried | E033, E034, E035, E036 |
| F07-04 | Fresh R7 capacity measurement and qualification | supervised staging | U/0/0/0 | 1/0/0/0 | credit moved | E037, E031; new: E156, E161 |
| F08-01 | Owner-scoped Library storage and inspection | staging | 1/1/1/U | 1/1/1/1 | credit moved | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137, E141; new: E159, E174, E179, E158 |
| F08-02 | QR-1b durable artifact freeze | staging | 1/1/1/0 | 1/1/1/0 | carried | E038, E040, E079, E083, E115, E109, E124, E138, E142, E143, E149, E150 |
| F09-01 | Qualified Best Inputs package and validation | staging | 1/0/0/0 | 1/1/0/0 | credit moved | E041, E008, E042, E086, E093; new: E157, E162, E163, E164, E165, E166, E167, E181, E182 |
| F09-02 | Export and matching email report delivery | staging | U/0/0/0 | 1/0/0/0 | credit moved | E041, E008, E043; new: E154 |
| F09-03 | Explicit review, import and owner handoff | staging | U/0/0/0 | 1/0/0/0 | credit moved | E041, E008; new: E155 |
| F10-01 | QR-2 actual Paper portfolio performance | staging | 1/0/0/0 | 1/0/0/0 | rationale refreshed | E042, E008, E087, E142, E143, E149, E150, E141, E146, E148; new: E161 |
| F10-02 | QR-3 full fair comparison | staging | 1/0/0/0 | 1/1/0/0 | credit moved | E042, E008, E094; new: E158, E168, E169, E170, E171, E172 |
| F10-03 | QR-4 qualified best-performance selection | staging | 1/0/0/0 | 1/0/0/0 | carried | E042, E008, E095, E094, E086 |
| F11-01 | Multi-Pine contracts and evaluator/package compatibility | isolated accepted fixture | U/0/0/0 | U/0/0/0 | carried | E041, E001, E008, E096, E086 |
| F11-02 | APP-3B multi-Pine Paper isolation and canary | staging | U/0/0/0 | U/0/0/0 | carried | E008, E044 |
| F12-01 | MD-1 production market-data scaling | production qualification | U/0/0/0 | U/0/0/0 | carried | E008 |
| F12-02 | Customer lifecycle, quotas and entitlement | Paper beta | U/0/0/0 | U/0/0/0 | carried | E045, E046, E008 |
| F12-03 | Customer security and launch operations | Paper beta | U/0/0/0 | U/0/0/0 | carried | E008, E045, E142, E143, E149, E150 |
| F12-04 | Reviewed Paper production rollout and observation | production | 1/0/0/0 | 1/0/0/0 | carried | E045, E008, E047, E048, E049, E050 |
| P01-01 | Generate the supported Bridge and guide | staging owner journey | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E007, E008, E081, E141; new: E160 |
| P02-01 | Ten-input round-trip and coherent selection | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| P02-02 | Effects and parity of the selected dimensions | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| P03-01 | Historical Preflight on an admitted supported profile | staging owner journey | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131; new: E175, E178, E180, E158 |
| P03-02 | Readiness with honest historical status | staging owner journey | 1/1/1/U | 1/1/1/1 | credit moved | E008, E004, E079, E081, E097, E118, E126, E133, E139, E141; new: E159, E175, E177, E158 |
| P03-03 | Policy-bound Risk preview and save | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E004, E079 |
| P04-01 | Real same-entry TradingView BUY and targeted EXIT | staging owner journey | 1/1/1/1 | 1/1/1/1 | carried | E006, E011 |
| P04-02 | Paper risk, isolation and ledger reconciliation | staging owner journey | 1/1/1/U | 1/1/1/U | rationale refreshed | E003, E012, E011, E077, E141 |
| P05-01 | Snapshot, progress, cancel and durable result controls | staging owner journey | 1/1/1/0 | 1/1/1/0 | rationale refreshed | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131; new: E173, E175, E178, E180, E158 |
| P05-02 | Current profile capacity and admission | supervised staging | U/0/0/0 | 1/0/0/0 | credit moved | E037, E031; new: E156, E161 |
| P05-03 | One bounded supported terminal run | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| P06-01 | Reopen and inspect preserved runs | staging owner journey | 1/1/1/U | 1/1/1/1 | credit moved | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137, E141; new: E159, E174, E179, E158 |
| P06-02 | Artifact durability and freeze | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E038, E040, E079, E083, E115, E109, E124, E138, E142, E143, E149, E150 |
| P06-03 | Minimal compatible comparison and qualification display | staging owner journey | 1/1/1/U | 1/1/1/1 | credit moved | E008, E004, E038, E079, E090, E092, E103, E104, E105, E114, E109, E112, E124, E135, E136, E141; new: E159, E174, E179, E183, E158 |

## New evidence (pinned to Git blobs at `5be0968`)

| ID | Path | sha256 (first 12) | What it shows |
| --- | --- | --- | --- |
| E152 | [docs/progress/PM1_SCORECARD_S4_2026-11-05.json](../../docs/progress/PM1_SCORECARD_S4_2026-11-05.json) | `7a341f272baf` | Prior scorecard S4 JSON (accepted 2026-11-05, frozen in dc70a5f). Context pin. |
| E153 | [docs/evidence/PM1_F05_01_CLOSURE_CARRY_2026-11-06.json](../../docs/evidence/PM1_F05_01_CLOSURE_CARRY_2026-11-06.json) | `321e590a6700` | F05-01 evaluator closure carry, frozen-policy scope, Root-accepted (SB169): 16 pins; 138644c..680039f over the 24 closure files changes only __init__.py; current suites pytest 367 and 702 (2 skipped), Node 248 of 248; limitations listed in the record. |
| E154 | [docs/F09_02_EMAIL_REPORT_DELIVERY_CONTRACT.md](../../docs/F09_02_EMAIL_REPORT_DELIVERY_CONTRACT.md) | `9283310bf08d` | F09-02 Email Report delivery contract, Root-accepted design revision 1 (SB166); every owner decision OPEN; E1 closed; not implemented. |
| E155 | [docs/F09_03_REVIEW_IMPORT_HANDOFF_CONTRACT.md](../../docs/F09_03_REVIEW_IMPORT_HANDOFF_CONTRACT.md) | `6d7e0590f790` | F09-03 review, import and owner handoff contract, Root-accepted design revision 1 (SB166); every owner decision OPEN; apply lock closed; not implemented. |
| E156 | [docs/R7_FRESH_CAPACITY_EPOCH_DESIGN_EM3_2026-11-06.md](../../docs/R7_FRESH_CAPACITY_EPOCH_DESIGN_EM3_2026-11-06.md) | `207110eb7ee7` | EM3 fresh capacity epoch design contract, DESIGN_ACCEPTED_NOT_A_GO (SB182); executionReady, releaseAuthorized and ownerReviewed false; no epoch run. |
| E157 | [docs/evidence/PM1_F09_BUILDER_S4_FIXTURE_SERVICE_LOCAL_2026-11-06.json](../../docs/evidence/PM1_F09_BUILDER_S4_FIXTURE_SERVICE_LOCAL_2026-11-06.json) | `bac75316b539` | F09 one-Pine fixture build and attempt service (f38048b), Root-accepted local evidence (SB183): one labelled fixture export from a stored v3 run validated to fixture EXPORT_VALIDATED; refusal matrix; CI 9 of 9 on f38048b; unwired. |
| E158 | [docs/evidence/PM1_F10_02_QR3_LOCAL_INTEGRATION_2026-11-06.json](../../docs/evidence/PM1_F10_02_QR3_LOCAL_INTEGRATION_2026-11-06.json) | `2ea0bf8e5233` | QR-3 STANDARDIZED fair comparison, L8-A to L8-W, Root-accepted local integration behind default-off flags (SB174 to SB187); RR-7 (SB188); CI 9 of 9 on 0d51ed3, ce66c78, 32ec0d8 and 0fe7644; not on staging. |
| E159 | [docs/evidence/PM1_L9_STAGING_READBACK_2026-11-06.json](../../docs/evidence/PM1_L9_STAGING_READBACK_2026-11-06.json) | `206ae4bed818` | L9 page-driven staging readback (Root read-alongside in the owner signed-in session; pins as recorded) with Root T rulings SB189. |
| E160 | [docs/P1F_ACCEPTANCE_RECORD_2026-11-06.md](../../docs/P1F_ACCEPTANCE_RECORD_2026-11-06.md) | `7416d9a14c04` | P1-F acceptance record, DRAFT and not accepted (reading B). Context pin only. |
| E161 | [docs/ROADMAP.md](../../docs/ROADMAP.md) | `368bbbb2c79c` | Roadmap at the source commit: 2026-11-06 completion entry (L6, L7, L8, EM3, gate L-b HOLD, CI on 0d51ed3, 39c7ced and faa3179) and the QR-3 row. |
| E162 | [docs/evidence/PM1_F09_PACKAGE_RENDER_S1_LOCAL_2026-10-20.json](../../docs/evidence/PM1_F09_PACKAGE_RENDER_S1_LOCAL_2026-10-20.json) | `60d3f4e66d1c` | F09 builder slice S1, pure package renderer, Root-accepted local evidence. |
| E163 | [docs/evidence/PM1_F09_BUILDER_S2_LOCAL_2026-10-20.json](../../docs/evidence/PM1_F09_BUILDER_S2_LOCAL_2026-10-20.json) | `d8050b34e115` | F09 builder slice S2, bi_* tables and installer, local; not installed on staging. |
| E164 | [docs/evidence/PM1_F09_BUILDER_S3A_TRACE_DRIVER_LOCAL_2026-10-21.json](../../docs/evidence/PM1_F09_BUILDER_S3A_TRACE_DRIVER_LOCAL_2026-10-21.json) | `963684bf03fa` | F09 builder slice S3a, trace driver, local. |
| E165 | [docs/evidence/PM1_F09_BUILDER_S3B_TRACE_MODULE_LOCAL_2026-10-21.json](../../docs/evidence/PM1_F09_BUILDER_S3B_TRACE_MODULE_LOCAL_2026-10-21.json) | `da7f46c05caa` | F09 builder slice S3b, trace reproduction module, local. |
| E166 | [docs/evidence/PM1_F09_BUILDER_S3C_ACCEPTANCE_LOCAL_2026-10-21.json](../../docs/evidence/PM1_F09_BUILDER_S3C_ACCEPTANCE_LOCAL_2026-10-21.json) | `e24a605fe562` | Root acceptance of F09 builder slices S3a to S3c, local. |
| E167 | [docs/evidence/PM1_F09_GATE_C2_ANCHOR_LOCAL_2026-10-20.json](../../docs/evidence/PM1_F09_GATE_C2_ANCHOR_LOCAL_2026-10-20.json) | `9ea0ae7e3b00` | F09 package gate C2 anchor change, local. |
| E168 | [docs/evidence/PM1_QR3_S1_LOCAL_2026-10-19.json](../../docs/evidence/PM1_QR3_S1_LOCAL_2026-10-19.json) | `9ff10e343dcf` | QR-3 slice S1, pure comparison module, local. |
| E169 | [docs/evidence/PM1_QR3_S2A_LOCAL_2026-10-20.json](../../docs/evidence/PM1_QR3_S2A_LOCAL_2026-10-20.json) | `ca05bbba7c12` | QR-3 slice S2a, exposure register extension, local. |
| E170 | [docs/evidence/PM1_QR3_S2C1_LOCAL_2026-10-20.json](../../docs/evidence/PM1_QR3_S2C1_LOCAL_2026-10-20.json) | `5f5160333fb9` | QR-3 slice S2c-1, comparison spec, participant and status tables, local. |
| E171 | [docs/evidence/PM1_QR3_S2C2_LOCAL_2026-10-21.json](../../docs/evidence/PM1_QR3_S2C2_LOCAL_2026-10-21.json) | `ff0af8e6a3be` | QR-3 slice S2c-2, comparison result tables, local. |
| E172 | [docs/evidence/PM1_QR3_S3A_LOCAL_2026-10-24.json](../../docs/evidence/PM1_QR3_S3A_LOCAL_2026-10-24.json) | `7394ed53c460` | QR-3 slice S3a, pure evaluation record assembler, local. |
| E173 | [src/postgres/quant-research.js](../../src/postgres/quant-research.js) | `f298cbdbdb8f` | Rule C3 subject: v3 selector, capability check and FOUNDATION refusal (v3 only); identical v1 branch. |
| E174 | [src/postgres/quant-library.js](../../src/postgres/quant-library.js) | `8bc80457e8da` | Rule C3 subject: familyOf maps v3 to LEGACY and is exported. |
| E175 | [src/quant-research/runtime-engine-files.js](../../src/quant-research/runtime-engine-files.js) | `e38ed5d77feb` | Rule C3 subject: seven runtime manifest entries added (identity rotation only). |
| E176 | [quant_lab/src/robot_quant/research_engine.py](../../quant_lab/src/robot_quant/research_engine.py) | `c6d5f42c0ebd` | Rule C3 subject: v3 accepted; v1 path unchanged. |
| E177 | [src/postgres/server.js](../../src/postgres/server.js) | `9632f33d386e` | Rule C3 subject: QR-3 imports, flag constant, flag-gated deps and the qr3Routes call. |
| E178 | [src/postgres/quant-research-main.js](../../src/postgres/quant-research-main.js) | `677cb5ebd12b` | Rule C3 subject: QR-3 driver only with both flags exactly 1. |
| E179 | [public/research-library.js](../../public/research-library.js) | `e8478f663114` | Rule C3 subject: compare view wording, verdict chip and library context key column. |
| E180 | [test/mp-engine-closure.test.js](../../test/mp-engine-closure.test.js) | `78a696f524f1` | Tracked engine identity pins at the source commit with the L6 and L8-W rotation history (legacy, foundation, ingestion, pf2_engine, pf2_evaluator, fixed_eval, mp-combined, trace). |
| E181 | [src/quant-research/research-contract-v3.js](../../src/quant-research/research-contract-v3.js) | `56bac1421459` | L6 (faa3179, owner GO-L6-LOCAL): research contract v3 module, fixture only. |
| E182 | [src/quant-library/trace-reproduction.js](../../src/quant-library/trace-reproduction.js) | `8ebdac622a2c` | L6: ql3a-research-job-v3 is an ACTIVE trace profile against engineHash(false); ports bound to a named closure. |
| E183 | [test/quant-library-ui.test.js](../../test/quant-library-ui.test.js) | `1b6bd75238cd` | P06-03 pinned UI test (E104) at the source commit, changed in reviewed commit 32ec0d8. |

E152 is a context pin that no row cites.

## Ambiguities and the value used

- **B1. F09-02 D and F09-03 D with every owner decision OPEN.** The method D bar is a Root-reviewed contract with boundaries, dependencies and observable checks; both contracts meet it, and Root ruled D = 1 (SB166). The earlier contract precedents (F09-01, F10-02) had decided owner decisions. Value used: **1**. The UNKNOWN reading gives project 20663/300 to 889/12.
- **B2. F09-01 I on unwired fixture evidence.** SB176 ruling 10 sets the I bar (a builder and an evaluator use the gate module on the labelled fixture path; no route or view is needed for I). E157 meets it with CI 9 of 9 on `f38048b`. Value used: **1**. V and T stay 0.
- **B3. F10-02 I without ACTUAL_BOT.** RR-7 (SB188): the contract's version 1 scope is STANDARDIZED and the owner placed ACTUAL_BOT after QR-2 S3 (OD-C20). Value used: **1**. The other reading gives project 20623/300 to 1471/20.
- **B4. F05-01 V and T.** E153 waives re-observation for the frozen-policy scope (SB169) and lists its limits; the closure product files are unchanged to the source commit. Value used: **1/1**. The S4 state gives project 20183/300 to 889/12.
- **B5. L9 page-driven readbacks.** Root operated the pages in the owner's signed-in session and captured only named fields (SB171, SB173); no GET names the API commit, so the pins are as recorded. Each T = 1 carries a limitation (exposure register not shown; compatible pair not run; AVAILABLE branches unreachable). If these reads were not counted, project would be 20483/300 to 889/12 and prototype 881/12 to 973/12.
- **B6. F01-03 V after the L9 defect (ruled: revoked).** The method says a newly discovered defect may revoke affected credit. The setup-guide defect is inside this row's closure, and the acceptance clause asks for accurate step states; the V evidence (E108) was a synthetic static render with owner-wide responses. Root ruling SB192 item 1 revokes it: **V = 0** in this scorecard (main position). Keeping V = 1 would give project 21083/300 to 901/12; V = UNKNOWN gives 20783/300 to 901/12. Prototype is unchanged in both.
- **B7. F04-02 T.** Only the current chart state was observed; stale and limited states cannot be forced by a GET, and local E079 is not substituted (SB189 ruling 4). **T = UNKNOWN**.
- **B8. Engine identity rotation.** Commits `faa3179` and `0fe7644` rotate the legacy, foundation, ingestion, pf2_engine, fixed_eval and mp-combined identities through manifest entries and the v3 version check. Under rule C3 a rotation alone is class B (S3 example; S4 precedent for F04-04). The source identities of F04-03, P03-01, F05-03, F06-01 and P05-01 now name pre-rotation values; the tracked closure test at the source commit pins the new ones (E180).
- **B9. CI evidence.** The Roadmap at the source commit says CI on `0fe7644` was pending when its entry was written; the tracked QR-3 record E158 says 9 of 9. The candidate relies on E158.
- **A1 (carried). F10-01 I.** Full QR-2 S5 is still open (E161); slice b-2 is local only and gate L-b closed as HOLD. **I = 0** kept.
- **A12 (carried). S3 and S4 judgements** (class C carry, F01-03 V on a synthetic render, T UNKNOWN rather than 0, E124, E027) carry unchanged except where a ruled move above replaces them.

### Alternatives (exact project and prototype lower / upper / UNKNOWN weight)

| Alternative | Project | Prototype |
| --- | --- | --- |
| Candidate main position (exactly the Root-ruled moves) | 20783/300 / 889/12 / 413/15 | 913/12 / 973/12 / 25/1 |
| B6 kept reading: F01-03 V 1 despite the L9 setup-guide defect (not adopted; SB192 revoked it) | 21083/300 / 901/12 / 413/15 | 913/12 / 973/12 / 25/1 |
| B6 unreconciled reading: F01-03 V UNKNOWN (not adopted) | 20783/300 / 901/12 / 463/15 | 913/12 / 973/12 / 25/1 |
| B1 open owner decisions: F09-02 D and F09-03 D kept UNKNOWN (not adopted; SB166 ruled 1) | 20663/300 / 889/12 / 473/15 | 913/12 / 973/12 / 25/1 |
| B4 strict F05-01: V and T kept UNKNOWN as in S4 (not adopted; SB169 ruled 1) | 20183/300 / 889/12 / 473/15 | 913/12 / 973/12 / 25/1 |
| B3 RR-7 not adopted: F10-02 I 0 (ACTUAL_BOT required) | 20623/300 / 1471/20 / 413/15 | 913/12 / 973/12 / 25/1 |
| B5 L9 not counted: the five L9 T moves kept UNKNOWN (F01-03 T 0 kept) | 20483/300 / 889/12 / 488/15 | 881/12 / 973/12 / 115/3 |
| A1 option U carried: F10-01 I UNKNOWN instead of 0 (not adopted) | 20783/300 / 4477/60 / 433/15 | 913/12 / 973/12 / 25/1 |
| S3 variant E carried: class C not accepted (F04-03, P03-01, F06-01, P05-01 V UNKNOWN) | 20303/300 / 889/12 / 493/15 | 865/12 / 973/12 / 115/3 |
| S3 variant B carried: F01-03 V UNKNOWN (same edit as the B6 unreconciled reading) | 20783/300 / 901/12 / 463/15 | 913/12 / 973/12 / 25/1 |
| S3 variant C / A5 strict carried: F03-03 and F03-04 T 0 | 20783/300 / 21937/300 / 341/15 | 913/12 / 973/12 / 25/1 |

Main position in percent: project 69.28 to 74.08, prototype 76.08 to 81.08.

## Acceptance gates (statuses unchanged from S4)

Gate statuses stay separate from the arithmetic and grant no GO. The project remains Spot/Paper only; Live is hard-locked; private acceptance is NOT RUN; READY is false; P13j and N1 are held.

| Gate | Status | Limitation or next step | S5 note |
| --- | --- | --- | --- |
| G-BRIDGE | PASS | Not current host health or arbitrary Pine support. | Unchanged from S4. |
| G-INPUTS | OPEN | Close S4 behavioral and remaining S6/S7 acceptance within the frozen selection contract. | Unchanged from S4. |
| G-PREFLIGHT | BLOCKED | Close capacity/enrollment and the separately authorized measurement/activation gates. | Unchanged from S4. |
| G-R7 | OPEN | Review amendment and obtain the required successful runtime measurement; J1-J4 prerequisite success is narrower. | S5: the EM3 design contract is accepted as design only (E156, DESIGN_ACCEPTED_NOT_A_GO); no epoch ran and step B is still required before any epoch GO. Status unchanged. |
| G-PO1-CI | PASS | Closed for local integration scope: independent six cases 6/6 and exact CI 9b63d77 9/9. Staging release containing PO1 remains a separate gate. S2: db.js changed after PO1 only by the 720b433 close() fix; exact CI on ca6abb1 passed 9/9 per root ruling P1. | Unchanged from S4. |
| G-DP1-24H | PASS | Root accepted 2026-10-16T09:53:22.756Z: POST_PASS, 127,781,220 ms after the switch receipt, worker unchanged, zero restarts, health HTTP 200, queues and Live zero, 205 independent assertions. One dated sample, not continuous health; no positive O3-rule fill; service identity UNKNOWN. | Unchanged from S4. |
| G-PRODUCTION | BLOCKED | Staging 24-hour observation now accepted as one dated sample (G-DP1-24H). Still open: production identity (watch-service identity UNKNOWN), runner wiring and transport, native capability, recovery, policy and release gates before any authorized deployment. The B2 supervision probe windows are bounded behaviour records with productionQualified false. Nothing deployed to production. | S5: every product change in the window is local only; nothing ran on production. Status unchanged. |
| G-FREEZE | OPEN | Resolve the required policy and target integration gates; local evidence does not prove staging migration. | Unchanged from S4. |
| G-LAUNCH | OPEN | Implement and accept the declared remaining product and launch outcomes. Optional Live remains excluded. | Unchanged from S4. |
| G-FRESH-HEALTH | UNKNOWN | No host step in this root session; historical observations are dated evidence only. | S5: stays UNKNOWN. The L9 readback (E159) is a dated page-driven sample on staging, not continuous host health. |
| G-LO1-LOCAL | PASS | Local only; lost-COMMIT acknowledgement untested; not deployed or backported to the DP1-P candidate. | Unchanged from S4. |

## Scope words

Local, staging and production are different targets. Every product change in this window is local only; the staging pins are unchanged since S4 (API `75c7a5b`, trading worker `ba1a433`, as recorded). A design acceptance is not a GO. Local evidence is not staging evidence, and staging evidence is not production evidence. Commit, CI, deployment and acceptance are separate facts.

## Reproduction

From the repository root:

```text
node .qa-local/s5-freeze-2026-11-06/build-s5-freeze.mjs --commit=5be0968 --scored-at=2026-11-06T18:25:53Z
node .qa-local/s5-freeze-2026-11-06/build-s5-freeze-md.mjs
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S5_2026-11-06.json
```

The calculator command names the target path, valid after Root moves the file. E027 is not hashed by the candidate author. The scored-at value is passed by Root at run time; the builder reads no clock. Root freeze run: 183 of 183 evidence hashes on the full file (182 of 183 on the verify copy without E027); S2 verifier 7 of 7 PASS. The S2 independent verifier ran as a byte copy on the verify copy; see the freeze run files beside the candidate.
