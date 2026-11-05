# PM-1 scorecard S4, 2026-11-05 (UTC)

**Status: `COMPLETE_WITH_EXPLICIT_UNCERTAINTY`. Accepted by Claude root on 2026-11-05T19:23Z (UTC).** Root accepted the scorecard. Root checks at source commit 939045e: the repo calculator CLI on this file verified 151 of 151 evidence hashes (E027, the inherited disk pin, hashed from a byte copy of the ignored artifact whose sha256 equals the S1 to S3 pin), 54 rows, stored totals equal computed totals; the S2 independent verifier byte copy passed 7 of 7 checks on the full file; the freeze check found 0 credit rows changed versus S3 and versus both r2 draft cases, results deep-equal, and the r2 files unchanged. Rule C3: no product path changed from 82fd96b to 939045e (docs only). Set B (S6-STAGING-SETB-1) is accepted (B2 attempt a02 and the owner browser check, 2026-11-05); its stops B0 a01 and B2 a01 were defects in local set B job tools, not in a scored product closure. Prepared by an architecture auditor child (Opus 5.5, high effort) at set B close. It changes no gate, GO, product acceptance or runtime state.

- Scorecard ID: `PM1-S4-2026-11-05`. Method PM-1, inventory PM1-I1 (sha256 `233f5fbea8435599`, unchanged), same weights, shares, targets and rules.
- Prior scorecard: PM1-S3-2026-10-30 ([JSON](PM1_SCORECARD_S3_2026-10-30.json), evidence E140), source commit `d22a6a7`.
- Source commit: `939045e` on `codex/fe2b-ci-local-fix`. Evidence window: tracked commits `d22a6a7..939045e` and the tracked set B result records. Untracked Root rulings are context only and score nothing.
- Scored at 2026-11-05T19:21:12Z (Asia/Bangkok 2026-11-06 02:21).

## Result

| View | Lower | Upper | UNKNOWN weight |
| --- | ---: | ---: | ---: |
| Project | 65.29% (4897/75) | 74.42% (893/12) | 46.37 (1391/30) |
| Prototype | 72.75% (291/4) | 81.08% (973/12) | 45.00 (45/1) |

Displayed whole percentages: project 65–74%, prototype 73–81%. UNKNOWN credits remain in both views, so neither view has a single score. The bounds are engineering evidence bounds, not completion, and they grant no acceptance or GO.

## Change from S3

The series is comparable: inventory, weights, shares, targets and method did not change. **No credit changed in any of the 54 rows.** Delta for both views: lower 0/1, upper 0/1, UNKNOWN weight 0/1 (project); lower 0/1, upper 0/1, UNKNOWN weight 0/1 (prototype).

What did change since S3, without moving a credit:

1. **Staging API pin.** REPIN-2 was accepted on 2026-11-01T20:34:21Z (E141): the staging API runs `75c7a5b`; the trading worker stays on `ba1a433`. The product diff `33e5a8c..75c7a5b` touches only the QR-2 read path (pathname- and flag-gated routes, the boundary record registry, the halt-reason field), the QR-2 panel, twelve added i18n.js lines and two cache tokens in index.html. Every fix that put T at UNKNOWN in S3 (`ba1a433`, `9b63d77`, `720b433`, `c066604`, `33e5a8c`) is an ancestor of `75c7a5b`. No readback of those rows' behaviour exists on the new pin, so their T stays UNKNOWN; the rationale of each such row names the new pin.
2. **QR-2 on staging.** The REPIN-2 owner browser check read back per-Bot reports: Bot 3 reconciles in Week, Month and All Time (24 fills and 12 lots, equal to the boundary read); Bot 2 stays RECONCILIATION_FAILED with EPOCH_UNKNOWN (class pre-E0), by the owner's choice. This is partial staging integration of QR-2. F10-01 stays 1/0/0/0 (see ambiguities A1 and A2).
3. **Committed product code since `d22a6a7`.** Only QR-2 files, the QR-2 panel, i18n additions, two cache tokens and the new set B capital-model grant and grant-state tools (`91ea49e`, `4d49659`), with their tests. Rule C3 of S3 applied: every hunk is class A (a QR-2 pathname and flag discriminator, or a new module that no scored closure imports) or class B (i18n additions, cache tokens, the boundary default constant, which changes only QR-2 reconciliation input). No row with V = 1 has a class D hunk. Since the r2 draft source `82fd96b`, only documentation changed.
4. **Set B closed.** Root accepted set B (ruling SB156, 2026-11-05T18:59Z; tracked records E149 and E150): B0 a03 compare (refreshed by a05), B0F, B1 a01 (fresh staging backup verified by a throwaway restore) and B2 a02 (M6 installed with the exact targeted runtime grant; API and trading worker stopped gracefully and restarted READY). The owner browser check observed the owner view answer 200 with total UNAVAILABLE (`CAPITAL_MODEL_NOT_DECLARED`) for USDT and 200 not declared for THB, Bot 3 COMPLETE with reconciliation OK, Bot 2 RECONCILIATION_FAILED with EPOCH_UNKNOWN, liveEnabled false and no declaration. RS and RB did not run. Nothing ran on production.

## Rows that set B touches

Set B is accepted, so the r2 two-case structure is collapsed to one case: PM-1 scores one evidence state, and the r2 candidates for "set B not accepted" and "set B accepted" were identical. No tracked set B record evidences a product defect inside a scored closure: the two set B stops (B0 a01, E143; B2 a01 gate stop, E150) were defects in sealed local set B host-job tools, which are not inventory deliverables and are outside every scored closure, and they changed no product code. Each row below keeps its r2 candidate and gains the set B result records (E142, E143, E149, E150) as evidence.

- **F01-01** (Owner authentication and tenant-scoped access, staging): The set B owner browser check (E150) used GET only on the owner's own views; no declaration was sent, so the declaration route step-up is not exercised (D3), and no cross-owner refusal was read back. Credit 1/1/1/U, equal to S3 and to both r2 candidates. Ambiguity: A6.
- **F03-03** (Worker transient faults, bounded rejection and systemic hold, staging): Set B job B2 (a02) stopped the staging trading worker (ba1a433) gracefully and it restarted READY, with immediate and delayed checks passed (E150). A clean restart is not a readback of transient-fault, bounded-rejection or systemic-hold behaviour. Credit 1/1/1/U, equal to S3 and to both r2 candidates. Ambiguity: A5.
- **F03-04** (Database transaction and runtime lease integrity, staging): Set B job B2 (a02) stopped and restarted the staging trading worker and API with immediate and delayed checks passed (heartbeat, production equal, research inactive, declaration rows 0) (E150). That is not a readback of late-SQL refusal, origin enforcement or failure retention. Credit 1/1/1/U, equal to S3 and to both r2 candidates. Ambiguity: A5.
- **F08-02** (QR-1b durable artifact freeze, staging): Set B job B1 (a01, P2_PASS) made one fresh staging backup verified by a restore into a throwaway cluster (E149), but the QR-1b freeze (set C) is not installed on staging, so it is not a freeze restore readback. Credit 1/1/1/0, equal to S3 and to both r2 candidates. Ambiguity: A7.
- **F10-01** (QR-2 actual Paper portfolio performance, staging): Set B job B2 (a02, B2_PASSED) installed M6 and the exact targeted runtime grant on staging. The owner browser check then observed the owner view answer 200 with total UNAVAILABLE (CAPITAL_MODEL_NOT_DECLARED) for USDT and 200 not declared for THB, instead of 503 before set B (E150). I stays 0 (full S5 open, ambiguity A1), so V and T cannot move under the cumulative rule; no complete portfolio view exists (no declaration, Bot 2 halts). Credit 1/0/0/0, equal to S3 and to both r2 candidates. Ambiguity: A1, A2, A4.
- **F12-03** (Customer security and launch operations, Paper beta): Set B job B1 backup and restore verification (E149) is single-owner staging evidence, not customer-scale security or operations acceptance (target Paper beta). Credit U/0/0/0, equal to S3 and to both r2 candidates. Ambiguity: A8.
- **P06-02** (Artifact durability and freeze, staging owner journey): Mirror of F08-02: set B job B1 (E149) is a backup and throwaway-restore check, not a QR-1b freeze restore readback on staging. Credit 1/1/1/0, equal to S3 and to both r2 candidates. Ambiguity: A7.

## All 54 rows

Credits are D/I/V/T, with U for UNKNOWN. Evidence IDs E001 to E139 are the S3 pins (see the [S3 JSON](PM1_SCORECARD_S3_2026-10-30.json)); E140 to E151 are new in S4 (index below). Row rationale, source identity and limits are in the JSON.

| ID | Outcome | Target | S3 | S4 | Set B | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F01-01 | Owner authentication and tenant-scoped access | staging | 1/1/1/U | 1/1/1/U | set B closed; candidate kept | E001, E002, E003, E077, E116, E117, E132, E133; new: E141, E142, E143, E149, E150 |
| F01-02 | Bot creation and lifecycle | staging | 1/1/1/0 | 1/1/1/0 | carried | E004, E005, E078 |
| F01-03 | Shared UI and journey visibility | staging | 1/1/1/U | 1/1/1/U | carried | E006, E005, E004, E092, E106, E108, E110, E112; new: E141 |
| F02-01 | Single-Pine registry, AI generation and guide | staging | 1/1/1/U | 1/1/1/U | carried | E003, E007, E008, E081; new: E141 |
| F02-02 | Ten-input selection and round-trip | staging | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| F02-03 | Versioned authenticated transport and scoped targeting | staging | 1/1/1/U | 1/1/1/U | carried | E003, E011, E077; new: E141 |
| F03-01 | Paper risk decisions, allocation and targeted EXIT baseline | staging | 1/1/1/U | 1/1/1/U | carried | E003, E012, E011, E077; new: E141 |
| F03-02 | O3/G1/F4 accounting corrections | local integrated code | 1/1/1/1 | 1/1/1/1 | carried | E008, E013, E014 |
| F03-03 | Worker transient faults, bounded rejection and systemic hold | staging | 1/1/1/U | 1/1/1/U | set B closed; candidate kept | E008, E014, E015, E109, E111; new: E141, E142, E143, E149, E150 |
| F03-04 | Database transaction and runtime lease integrity | staging | 1/1/1/U | 1/1/1/U | set B closed; candidate kept | E016, E013, E057, E058, E062, E075, E099, E100, E109, E111; new: E141, E142, E143, E149, E150 |
| F03-05 | Tracked script and source writer guard | local test integration | 1/1/1/1 | 1/1/1/1 | carried | E017 |
| F04-01 | Spot ingestion and bounded BACKFILL provenance | staging | 1/1/1/1 | 1/1/1/1 | carried | E018 |
| F04-02 | Prototype charts and market-data diagnostics | staging | 1/1/1/U | 1/1/1/U | carried | E011, E019, E004, E079; new: E141 |
| F04-03 | PF-2 historical Preflight | staging | 1/1/1/0 | 1/1/1/0 | carried | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131 |
| F04-04 | PF-3 readiness report | staging | 1/1/1/U | 1/1/1/U | carried | E008, E004, E079, E081, E097, E118, E126, E133, E139; new: E141 |
| F04-05 | PF-4 deterministic Risk proposals | staging | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E079 |
| F05-01 | Supported source evaluator baseline | local validated engine | 1/1/U/U | 1/1/U/U | carried | E012, E023 |
| F05-02 | Selected-input empirical parity and supported effects | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| F05-03 | Cost, chronological validation and holdout semantics | local validated engine | 1/1/1/1 | 1/1/1/1 | carried | E025, E012, E026, E076, E083 |
| F06-01 | Immutable research jobs, progress and cancellation | staging | 1/1/1/0 | 1/1/1/0 | carried | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131 |
| F06-02 | Bounded optimizer execution and terminal outcome | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| F06-03 | Legacy optimize request and transaction containment | local integrated code | 1/1/1/1 | 1/1/1/1 | carried | E027, E059, E060, E061, E062, E072, E073, E074, E116, E117, E124, E132, E133, E134 |
| F07-01 | W7 recovery and D6 diagnostic admission prerequisites | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E028, E029, E030, E008 |
| F07-02 | R7 J1-J4 scheduler and resource-accounting cases | supervised staging | 1/1/1/1 | 1/1/1/1 | carried | E031, E032 |
| F07-03 | EM2 measurement controller and recovery tooling | local accepted tooling | 1/1/1/1 | 1/1/1/1 | carried | E033, E034, E035, E036 |
| F07-04 | Fresh R7 capacity measurement and qualification | supervised staging | U/0/0/0 | U/0/0/0 | carried | E037, E031 |
| F08-01 | Owner-scoped Library storage and inspection | staging | 1/1/1/U | 1/1/1/U | carried | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137; new: E141 |
| F08-02 | QR-1b durable artifact freeze | staging | 1/1/1/0 | 1/1/1/0 | set B closed; candidate kept | E038, E040, E079, E083, E115, E109, E124, E138; new: E142, E143, E149, E150 |
| F09-01 | Qualified Best Inputs package and validation | staging | 1/0/0/0 | 1/0/0/0 | carried | E041, E008, E042, E086, E093 |
| F09-02 | Export and matching email report delivery | staging | U/0/0/0 | U/0/0/0 | carried | E041, E008, E043 |
| F09-03 | Explicit review, import and owner handoff | staging | U/0/0/0 | U/0/0/0 | carried | E041, E008 |
| F10-01 | QR-2 actual Paper portfolio performance | staging | 1/0/0/0 | 1/0/0/0 | set B closed; candidate kept | E042, E008, E087; new: E142, E143, E149, E150, E141, E146, E148 |
| F10-02 | QR-3 full fair comparison | staging | 1/0/0/0 | 1/0/0/0 | carried | E042, E008, E094 |
| F10-03 | QR-4 qualified best-performance selection | staging | 1/0/0/0 | 1/0/0/0 | carried | E042, E008, E095, E094, E086 |
| F11-01 | Multi-Pine contracts and evaluator/package compatibility | isolated accepted fixture | U/0/0/0 | U/0/0/0 | carried | E041, E001, E008, E096, E086 |
| F11-02 | APP-3B multi-Pine Paper isolation and canary | staging | U/0/0/0 | U/0/0/0 | carried | E008, E044 |
| F12-01 | MD-1 production market-data scaling | production qualification | U/0/0/0 | U/0/0/0 | carried | E008 |
| F12-02 | Customer lifecycle, quotas and entitlement | Paper beta | U/0/0/0 | U/0/0/0 | carried | E045, E046, E008 |
| F12-03 | Customer security and launch operations | Paper beta | U/0/0/0 | U/0/0/0 | set B closed; candidate kept | E008, E045; new: E142, E143, E149, E150 |
| F12-04 | Reviewed Paper production rollout and observation | production | 1/0/0/0 | 1/0/0/0 | carried | E045, E008, E047, E048, E049, E050 |
| P01-01 | Generate the supported Bridge and guide | staging owner journey | 1/1/1/U | 1/1/1/U | carried | E003, E007, E008, E081; new: E141 |
| P02-01 | Ten-input round-trip and coherent selection | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E005, E009, E010, E078, E080, E098 |
| P02-02 | Effects and parity of the selected dimensions | staging qualification | 1/0/0/0 | 1/0/0/0 | carried | E005, E024 |
| P03-01 | Historical Preflight on an admitted supported profile | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E020, E021, E022, E080, E083, E113, E123, E124, E126, E127, E128, E129, E131 |
| P03-02 | Readiness with honest historical status | staging owner journey | 1/1/1/U | 1/1/1/U | carried | E008, E004, E079, E081, E097, E118, E126, E133, E139; new: E141 |
| P03-03 | Policy-bound Risk preview and save | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E008, E004, E004, E079 |
| P04-01 | Real same-entry TradingView BUY and targeted EXIT | staging owner journey | 1/1/1/1 | 1/1/1/1 | carried | E006, E011 |
| P04-02 | Paper risk, isolation and ledger reconciliation | staging owner journey | 1/1/1/U | 1/1/1/U | carried | E003, E012, E011, E077; new: E141 |
| P05-01 | Snapshot, progress, cancel and durable result controls | staging owner journey | 1/1/1/0 | 1/1/1/0 | carried | E001, E002, E026, E078, E082, E083, E088, E089, E113, E109, E123, E124, E128, E129, E130, E131 |
| P05-02 | Current profile capacity and admission | supervised staging | U/0/0/0 | U/0/0/0 | carried | E037, E031 |
| P05-03 | One bounded supported terminal run | staging admitted run | 1/1/1/1 | 1/1/1/1 | carried | E026, E008, E006 |
| P06-01 | Reopen and inspect preserved runs | staging owner journey | 1/1/1/U | 1/1/1/U | carried | E008, E004, E038, E039, E079, E090, E114, E124, E135, E136, E137; new: E141 |
| P06-02 | Artifact durability and freeze | staging owner journey | 1/1/1/0 | 1/1/1/0 | set B closed; candidate kept | E038, E040, E079, E083, E115, E109, E124, E138; new: E142, E143, E149, E150 |
| P06-03 | Minimal compatible comparison and qualification display | staging owner journey | 1/1/1/U | 1/1/1/U | carried | E008, E004, E038, E079, E090, E092, E103, E104, E105, E114, E109, E112, E124, E135, E136; new: E141 |

## New evidence (pinned to Git blobs at `939045e`)

| ID | Path | sha256 (first 12) | What it shows |
| --- | --- | --- | --- |
| E140 | [docs/progress/PM1_SCORECARD_S3_2026-10-30.json](../../docs/progress/PM1_SCORECARD_S3_2026-10-30.json) | `c4e3557a4f25` | Prior scorecard S3 JSON (accepted 2026-10-30, committed d3a5781). |
| E141 | [docs/S6_STAGING_API_REPIN_2_A2_A01_RESULT_2026-10-31.md](../../docs/S6_STAGING_API_REPIN_2_A2_A01_RESULT_2026-10-31.md) | `dbdf944ba155` | REPIN-2 A2 a01 accepted 2026-11-01T20:34:21Z: staging API pin 75c7a5b, trading worker ba1a433, QR-2 per-Bot readback (Bot 3 reconciles; Bot 2 EPOCH_UNKNOWN pre-E0), liveEnabled false. |
| E142 | [docs/S6_STAGING_SETB_PACKET_R7_2026-11-03.md](../../docs/S6_STAGING_SETB_PACKET_R7_2026-11-03.md) | `25e266821745` | Set B packet r7: M6 install, targeted grant, fresh backup; planned owner view after B2 is 200 UNAVAILABLE CAPITAL_MODEL_NOT_DECLARED; no declaration; RS and RB contingency jobs. |
| E143 | [docs/S6_STAGING_SETB_B0_A01_RESULT_2026-11-04.md](../../docs/S6_STAGING_SETB_B0_A01_RESULT_2026-11-04.md) | `035aac71e901` | Set B B0 a01 stop record (B0_STOP_TREE, sealed-tool defect, nothing accepted). |
| E144 | [docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR4_2026-11-04.md](../../docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR4_2026-11-04.md) | `26ba157a3f3f` | Errata E-FR4: a02 first read, a03 compare, a04 spare. |
| E145 | [docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR5_2026-11-04.md](../../docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR5_2026-11-04.md) | `48a435a547f5` | Errata E-FR5 (amended): read-only fetch job B0F. |
| E146 | [docs/ROADMAP.md](../../docs/ROADMAP.md) | `e209e9379f32` | Roadmap status at the source commit: QR-2 row (full S5 open), REPIN-2 complete, set B state, PM-1 S3 line. |
| E147 | [docs/P1F_ACCEPTANCE_RECORD_TEMPLATE_2026-11-02.md](../../docs/P1F_ACCEPTANCE_RECORD_TEMPLATE_2026-11-02.md) | `79b961b15504` | P1-F acceptance template: blank, every verdict NOT RUN; no owner journey walkthrough recorded. |
| E148 | [src/portfolio/qr2-boundary-records.js](../../src/portfolio/qr2-boundary-records.js) | `e20bf4bd858d` | QR-2 boundary record registry (5ac648b default, 75c7a5b staging record). |
| E149 | [docs/S6_STAGING_SETB_B0_B1_RESULT_2026-11-04.md](../../docs/S6_STAGING_SETB_B0_B1_RESULT_2026-11-04.md) | `35badee149c1` | Set B result record: B0 a03 compare B0_PASS, B0F f03, B1 a01 P2_PASS (fresh staging backup verified by a throwaway restore); B0 and B1 accepted; B2 held at that time. |
| E150 | [docs/S6_STAGING_SETB_B2_RESULT_2026-11-05.md](../../docs/S6_STAGING_SETB_B2_RESULT_2026-11-05.md) | `cd93b4da3254` | Set B result record: B2 a01 gate stop (B2_STOP_DB_STATE, no host effect; wiring defect in sealed local set B tools), B2 a02 B2_PASS, owner browser check (owner view 200 UNAVAILABLE CAPITAL_MODEL_NOT_DECLARED, Bot 3 COMPLETE, Bot 2 RECONCILIATION_FAILED EPOCH_UNKNOWN, liveEnabled false, no declaration), set B accepted. |
| E151 | [docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR_2026-11-04.md](../../docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR_2026-11-04.md) | `e82a91b2a2d1` | Errata E-FR1 to E-FR3: first-read rule and the Root review of a first read (E-FR2) that made the a02 export the compare reference. |

E140, E144, E145, E147 and E151 are context pins that no row cites.

## Ambiguities and the value used

- **A1. F10-01 I (QR-2 implementation). Root rules.** The method defines I as "complete implementation for the defined scope, with source identity and author checks", and 0 as known not earned. The Roadmap QR-2 row at the source commit says full S5 remains open (E146); product change (b) is local only; gate L run R3-B was inconclusive, so the Month budgets are not raised; no capital model is declared. Set B installed committed M6 and grant code on staging; that is integration of part of the code, not completion of the scope. The candidate uses the method value **I = 0** (as S3). Option U (I = UNKNOWN) gives project 4897/75 to 1499/20; option 1 (I = 1) gives project 4937/75 to 1499/20. Prototype is 291/4 to 973/12 under every option (no prototype row maps to F10-01). The r2 drift note on the Roadmap phrase "No target route is activated" is closed: that phrase is absent from the Roadmap from `ee2c150` on.
- **A2. F10-01 T.** QR-2 per-Bot routes are integrated and read back on staging (E141), and after set B the owner view answers 200 UNAVAILABLE instead of 503 (E150). T stays **0** by the cumulative rule (T needs I and V), and the inventory clause needs a complete portfolio view, which set B does not deliver.
- **A3. F03-01 and P04-02 T (Paper risk, allocation, ledger reconciliation).** The QR-2 Bot 3 reconciliation readback reconciles 24 fills against the ledger on staging, but it does not read back capped, rejected or targeted EXIT accounting. Value: **T = UNKNOWN** (unchanged), not 1.
- **A4. RS and RB.** RS and RB did not run; RB r9 stays the undo path under its own owner GO. No PM-1 credit depends on them, and a later RB run would return the owner view to 503 without moving a credit.
- **A5. F03-03 and F03-04 T.** Set B B2 stopped and restarted the running trading worker and API cleanly. A clean restart is not a readback of transient-fault, bounded-rejection, systemic-hold, late-SQL-refusal, origin-enforcement or failure-retention behaviour. Value: **T = UNKNOWN**, not 1. The S3 variant C reading (T = 0) still applies and is shown below.
- **A6. F01-01 T.** The set B owner browser check used GET only on the owner's own views, and the declaration step-up is not exercised (decision D3: no declaration). No cross-owner refusal readback. **T = UNKNOWN** kept.
- **A7. F08-02 and P06-02 T.** B1 proves a fresh staging backup restores into a throwaway cluster, but the QR-1b freeze (set C) is not installed on staging. **T = 0** kept.
- **A8. F12-03.** B1 is single-owner staging backup and restore evidence; the row targets customer-scale Paper beta. **U/0/0/0** kept.
- **A9. Closure carry for F01-01 and F01-03.** `qr2-routes.js` and `qr2-owner-route.js` change only the default boundary constant, after the server.js actor and sensitive-action checks, which are unchanged; index.html changes only cache tokens of i18n.js and paper-performance.js; i18n.js only adds lines. Classified A or B; V carries.
- **A10. Untracked rulings.** Root rulings (for example SB156) are context. The tracked set B result records (E143, E149, E150) carry the facts that this candidate cites.
- **A11. E027.** The inherited disk pin E027 is an ignored local artifact. The candidate author did not hash it; the calculator and verifier runs here exclude it and say so. Root hashes it as in S3.
- **A12. S3 carried judgements.** S3 uncertain items (class C carry, F01-03 V on a synthetic render, T UNKNOWN rather than 0, holdoutWindow alignment, the PF-3 closure, E124) carry unchanged; no new evidence resolves them.

### Alternatives (exact project and prototype lower / upper / UNKNOWN weight)

| Alternative | Project | Prototype |
| --- | --- | --- |
| Candidate main position (set B closed; F10-01 I 0) | 4897/75 / 893/12 / 1391/30 | 291/4 / 973/12 / 45/1 |
| A1 option U: F10-01 I UNKNOWN instead of 0 (not adopted; Root rules) | 4897/75 / 1499/20 / 477/10 | 291/4 / 973/12 / 45/1 |
| A1 option 1: F10-01 I 1 (not adopted; Root rules; method text does not support it) | 4937/75 / 1499/20 / 1391/30 | 291/4 / 973/12 / 45/1 |
| S3 variant E carried: class C not accepted (F04-03, P03-01, F06-01, P05-01 V UNKNOWN) | 4777/75 / 893/12 / 517/10 | 275/4 / 973/12 / 175/3 |
| S3 variant B carried: F01-03 V UNKNOWN | 4822/75 / 893/12 / 1391/30 | 291/4 / 973/12 / 45/1 |
| S3 variant C / A5 strict: F03-03 and F03-04 T 0 | 4897/75 / 22037/300 / 1247/30 | 291/4 / 973/12 / 45/1 |

The S3 variants recompute to the same values as in S3, which cross-checks the arithmetic.

## Acceptance gates (statuses unchanged from S3)

Gate statuses stay separate from the arithmetic and grant no GO. The project remains Spot/Paper only; Live is hard-locked; private acceptance is NOT RUN; READY is false; P13j and N1 are held. G-FRESH-HEALTH stays UNKNOWN: the REPIN-2 A2 record and the set B job records are dated samples, not continuous health.

| Gate | Status | Limitation or next step (S3) | S4 note |
| --- | --- | --- | --- |
| G-BRIDGE | PASS | Not current host health or arbitrary Pine support. | Unchanged from S3. |
| G-INPUTS | OPEN | Close S4 behavioral and remaining S6/S7 acceptance within the frozen selection contract. | Unchanged from S3. |
| G-PREFLIGHT | BLOCKED | Close capacity/enrollment and the separately authorized measurement/activation gates. | Unchanged from S3. |
| G-R7 | OPEN | Review amendment and obtain the required successful runtime measurement; J1-J4 prerequisite success is narrower. | Unchanged from S3. |
| G-PO1-CI | PASS | Closed for local integration scope: independent six cases 6/6 and exact CI 9b63d77 9/9. Staging release containing PO1 remains a separate gate. S2: db.js changed after PO1 only by the 720b433 close() fix; exact CI on ca6abb1 passed 9/9 per root ruling P1. | Unchanged from S3. |
| G-DP1-24H | PASS | Root accepted 2026-10-16T09:53:22.756Z: POST_PASS, 127,781,220 ms after the switch receipt, worker unchanged, zero restarts, health HTTP 200, queues and Live zero, 205 independent assertions. One dated sample, not continuous health; no positive O3-rule fill; service identity UNKNOWN. | Unchanged from S3. |
| G-PRODUCTION | BLOCKED | Staging 24-hour observation now accepted as one dated sample (G-DP1-24H). Still open: production identity (watch-service identity UNKNOWN), runner wiring and transport, native capability, recovery, policy and release gates before any authorized deployment. The B2 supervision probe windows are bounded behaviour records with productionQualified false. Nothing deployed to production. | S4: set B ran on staging only; nothing ran on production. Status unchanged. |
| G-FREEZE | OPEN | Resolve the required policy and target integration gates; local evidence does not prove staging migration. | S4: set B job B1 is a fresh backup with a throwaway restore (E149); it is not the QR-1b freeze target migration, which set C carries. Status unchanged. |
| G-LAUNCH | OPEN | Implement and accept the declared remaining product and launch outcomes. Optional Live remains excluded. | Unchanged from S3. |
| G-FRESH-HEALTH | UNKNOWN | No host step in this root session; historical observations are dated evidence only. | S4: stays UNKNOWN. The REPIN-2 A2 record (E141) and the set B jobs B0 a03, B0 refreshes, B1 a01 and B2 a02 with its owner browser check (E149, E150) are dated samples on staging, not continuous host health. |
| G-LO1-LOCAL | PASS | Local only; lost-COMMIT acknowledgement untested; not deployed or backported to the DP1-P candidate. | Unchanged from S3. |

## Scope words

Local, staging and production are different targets. Staging evidence is not production evidence; nothing in this scorecard is deployed to production. A sealed tool is not an accepted job. A first read is not a compare pass. A planned item is not done. Commit, CI, deployment and acceptance are separate facts.

## Reproduction

From the repository root:

```text
node .qa-local/s6-progress-s4-prep-2026-11-04/freeze-2026-11-05/build-s4-freeze.mjs --commit=939045e --scored-at=2026-11-05T19:21:12Z
node .qa-local/s6-progress-s4-prep-2026-11-04/freeze-2026-11-05/build-s4-freeze-md.mjs
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S4_2026-11-05.json
```

The calculator command names the target path, valid after Root moves the file. E027 is not hashed by the candidate author. Root freeze run: 151 of 151 evidence hashes on the full file (150 of 151 on the verify copy without E027); S2 verifier 7 of 7 PASS. The S2 independent verifier ran as a byte copy on the verify copy; see the freeze run files beside the candidate.
