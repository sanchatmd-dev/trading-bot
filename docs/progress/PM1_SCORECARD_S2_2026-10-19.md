# PM-1 successor scorecard S2 — 2026-10-19

Scorecard PM1-S2-2026-10-19 rescores all 54 rows of the unchanged inventory PM1-I1 (same weights, shares, targets and rules). The prior scorecard is PM1-S1-2026-10-15, which stays unchanged. The declared source commit is `ca6abb1` on branch `codex/app3a-market-wait-checkpoint`. The evidence window covers tracked commits `7e6ccd1..ca6abb1`, including the 2026-10-19 PM-1 reconciliation records R0 to R6, the D1, F05 and F09 records, the release-lineage merge record and the QR-3, QR-4 and multi-Pine contracts. Root rulings P1 to P13 and root decisions Q1 to Q7 of 2026-10-19 (UTC) are applied as recorded decisions. Claude root accepted this scorecard on 2026-10-19 (UTC). This is engineering progress, not acceptance readiness, measured labor or a confidence interval. Scored at 2026-10-19T19:45:03Z (2026-10-20 02:45 Asia/Bangkok).

| View | Lower bound | Upper bound | Weight of rows containing UNKNOWN |
| --- | ---: | ---: | ---: |
| project | 64.29% | 72.79% | 41.57% |
| prototype | 72.75% | 80.42% | 41.67% |

Project progress lies between 64% and 73%. Prototype progress lies between 73% and 80%. No single percentage or midpoint is justified, because UNKNOWN credits remain in both views.

## Change from S1

The series is comparable: inventory, weights, shares, targets and method did not change.

| View | Lower bound | Upper bound | UNKNOWN weight |
| --- | --- | --- | --- |
| project | 50.17 to 64.29 (+14.1200) | 74.12 to 72.79 (−1.3333) | 69.23 to 41.57 (−27.6667) |
| prototype | 52.00 to 72.75 (+20.7500) | 82.42 to 80.42 (−2.0000) | 75.83 to 41.67 (−34.1667) |

Exact values: project lower 4822/75, upper 7279/100, UNKNOWN weight 1247/30; prototype lower 291/4, upper 965/12, UNKNOWN weight 125/3. Exact deltas: project +353/25, −4/3, −83/3; prototype +83/4, −2, −205/6.

The upper bounds fall because four rows now have a known T of 0 where S1 had T UNKNOWN: F01-03, F06-01, P05-01 and P06-03. In each case staging is known to serve bytes without behaviour that the row needs. This is an evidenced reduction of the upper bound, not lost progress.

Twenty-nine rows changed: 19 project rows and 10 prototype rows. Credits are written D/I/V/T, with U for UNKNOWN.

### Project rows

| Row (target) | S1 | S2 | Lower change | Upper change | Reason and evidence |
| --- | --- | --- | ---: | ---: | --- |
| F01-01 Owner isolation (staging) | 1/1/U/U | 1/1/1/U | +1.0000 | 0 | V: R0 independent auditor and tester, 13 new HTTP isolation tests, 12/12 independent mutations killed; closure unchanged since 43e17c1. E077. |
| F01-02 Bot lifecycle (staging) | 1/1/U/0 | 1/1/1/0 | +1.0000 | 0 | V: R2 independent reconciliation, 8 new lifecycle-gate tests on every earlier gap clause, 14/14 mutations killed. E078. |
| F01-03 Shared UI and journey visibility (staging) | 1/1/U/U | 1/1/U/0 | 0 | −0.6667 | T known 0: staging still serves UI bytes with the stale journey texts and Bridge-disabled setup-guide states that `ca11d99` and `eaa86d4` fix. V stays UNKNOWN (Q3): R6 reconciles labels and states with 228 Node UI tests but did not check rendered desktop or mobile layout in a browser. I is unchanged; at `ca6abb1` it includes the fixes `ca11d99` and `eaa86d4` (R6), and the staging bytes predate them. E092, E106. |
| F02-01 AI Bridge generation (staging) | 1/1/U/U | 1/1/1/U | +1.2000 | 0 | V: R5 core generation files byte-identical to accepted APP-3A source, 21 + 17 new tests through fake providers, independent mutations 15/15. E081. |
| F02-02 Ten-input selection and round-trip (staging) | 1/1/U/0 | 1/1/1/0 | +1.2000 | 0 | V: R2 selection-gate tests (13/14 mutations, survivor equivalent) and R4 owner decision O1 with its test (4/4, 7/8 mutations). Both records state independent roles. E078, E080, E098. |
| F02-03 Authenticated transport (staging) | 1/1/U/U | 1/1/1/U | +1.2000 | 0 | V: R0 route identical to accepted source, 8 refusal tests, 9/11 mutations killed, two equivalent survivors. E077. |
| F03-01 Paper risk and targeted EXIT (staging) | 1/1/U/U | 1/1/1/U | +0.7200 | 0 | V: R0 accepted APP-3A/QL-2A source identical, 19 cap and reject tests, 13/13 mutations killed. E077. |
| F04-02 Chart data states (staging) | 1/1/U/U | 1/1/1/U | +0.6000 | 0 | V: R3 no defect, 3 + 3 new tests, 14/14 mutations killed. E079. |
| F04-03 PF-2 historical Preflight (staging) | 1/1/U/0 | 1/1/1/0 | +0.6000 | 0 | V: R4 reconciles the PF-2 closure on the merged lineage (evaluator binding and runtime DELETE revoke present and tested, 21 planned commands). Source identity moves to pf2Engine `5bfd1bfa...` and pf2Evaluator `3fb2d465...`, recomputed from Git blobs at `ca6abb1`. T stays 0: PF-2 is disabled. E080, E083. |
| F04-04 PF-3 readiness report (staging) | 1/1/U/U | 1/1/1/U | +0.6000 | 0 | V: R3 no defect; commit `818a46b` adds the clause C5b test (3 pass, 4/4 independent mutations killed). E079, E081, E097. |
| F04-05 PF-4 saved policy (staging) | 1/1/U/0 | 1/1/1/0 | +0.6000 | 0 | V: R3 apply-versus-run race test, 8/10 mutations killed, survivors guard a different covered race. E079. |
| F05-03 Validation semantics (local validated engine) | 1/1/U/U | 1/1/1/1 | +2.0000 | 0 | V: root-accepted reconciliation, 22/22 independent, 19/19 mutations. T: the declared target is local; research PostgreSQL files and the merged-tree suites pass. E076, E083. |
| F06-01 Job snapshots, progress and cancellation (staging) | 1/1/U/U | 1/1/1/0 | +1.0000 | −0.6667 | V: R2, D1 graceful stop (7 tests, 8/8 mutations, independent review) and merge patch-id proof. T known 0: staging lacks the D1 stop guards that the amended contract needs. E078, E082, E083, E088, E089. |
| F08-01 Library storage and inspection (staging) | 1/1/U/U | 1/1/1/U | +0.9000 | 0 | V: R3 found and fixed the comparison defect (`c066604`), 5 + 7 new tests, 15/16 mutations killed. T stays UNKNOWN: the defect is outside this row's acceptance text. E079, E090. |
| F08-02 Result freeze (staging) | 1/1/U/0 | 1/1/1/0 | +0.9000 | 0 | V: R3 restart readback 18/18; merged freeze test proves the privilege layer and the triggers, reviewed. E079, E083. |
| F09-01 Qualified package and validation (staging) | U/0/0/0 | 1/0/0/0 | +0.2000 | 0 | D: package contract root-accepted, owner OD-1 to OD-19, root OD-20, root clarifications RC-1 to RC-11. I stays 0: the pure package-gate module (`ca6abb1`, 51 tests, root-accepted) is progress on one part of the row and is not wired into any builder, route or view. E086, E093. |
| F10-01 QR-2 portfolio performance (staging) | U/0/0/0 | 1/0/0/0 | +0.1333 | 0 | D: QR-2 contract root-accepted; it resolves the S1 gaps (allocation, versioned returns, reconciliation). E087. |
| F10-02 QR-3 fair comparison (staging) | U/0/0/0 | 1/0/0/0 | +0.1333 | 0 | D: QR-3 contract root-accepted on 2026-10-19 (UTC) after independent review (`2fd1b5b`), owner OD-C1 to OD-C22, root RD-1 to RD-10. E094. |
| F10-03 QR-4 qualified selection (staging) | U/0/0/0 | 1/0/0/0 | +0.1333 | 0 | D: QR-4 contract root-accepted on 2026-10-19 (UTC) after independent review (`2fd1b5b`), owner OD-S1 to OD-S20, root RO-1 to RO-12; meets the row and method D definition (see P7 and Q1). E095, E094, E086. |

### Prototype rows

| Row (target) | S1 | S2 | Lower change | Upper change | Reason and evidence |
| --- | --- | --- | ---: | ---: | --- |
| P01-01 Actual AI generation (staging owner journey) | 1/1/U/U | 1/1/1/U | +4.5000 | 0 | Mirror of F02-01. E081. |
| P02-01 Ten-input round-trip (staging owner journey) | 1/1/U/0 | 1/1/1/0 | +2.2500 | 0 | Mirror of F02-02. E078, E080, E098. |
| P03-01 Historical Preflight (staging owner journey) | 1/1/U/0 | 1/1/1/0 | +2.0000 | 0 | Mirror of F04-03. E080, E083. |
| P03-02 Readiness with honest status (staging owner journey) | 1/1/U/U | 1/1/1/U | +2.0000 | 0 | Mirror of F04-04. E079, E081, E097. |
| P03-03 Risk proposals with provenance | 1/1/U/0 | 1/1/1/0 | +2.0000 | 0 | Mirror of F04-05. E079. |
| P04-02 Paper risk, isolation and ledger | 1/1/U/U | 1/1/1/U | +3.0000 | 0 | Mirror of F03-01, with the F02-03 duplicate and F01-01 isolation controls. E077. |
| P05-01 Snapshot, progress and cancel | 1/1/U/U | 1/1/1/0 | +2.0000 | −1.3333 | Mirror of F06-01, including T known 0. E078, E082, E083, E088, E089. |
| P06-01 Durable Library reopen | 1/1/U/U | 1/1/1/U | +1.0000 | 0 | Mirror of F08-01 (reopen only). E079, E090. |
| P06-02 Result freeze | 1/1/U/0 | 1/1/1/0 | +1.0000 | 0 | Mirror of F08-02. E079, E083. |
| P06-03 Minimal compatible comparison | 1/1/U/U | 1/1/1/0 | +1.0000 | −0.6667 | V: committed tests assert both clauses (no metrics for an incomparable pair in API and UI; qualification false, no ranking field and the fixed no-qualified-winner text). E103 and E104 are QR-1 author tests (`f36181c`); E105 is the fix author's test (`c066604`). Independence rests on the R3 reconciliation and its independent mutations of the comparison branch (E079) and the R6 claim check (E092), not on the tests (Q4). T known 0: the staging release eb532ff carries the R3 comparison defect: its compare API returns no market, dataset or cost fields, so the view would show an empty shared-context block (inferred from code identity, not observed on staging) (R3 defect, E079), so staging does not run the row's comparison behaviour; the fix `c066604` is absent from staging. E079, E090, E092, E103, E104, E105. |

T stays UNKNOWN where staging bytes differ from the verified closure but no staging defect is known (F01-01, F02-01, F02-03, F03-01, F04-02, F04-04, F08-01 and their mirrors). T becomes 0 only where staging is known to lack behaviour that the row needs. This follows the S1 precedent for F03-04.

Retained limits for the changed rows: no changed staging row has a staging readback in this window. The new tests use fake providers or isolated local PostgreSQL. F06-01 keeps the documented window in which a stop inside a running commit transaction cannot be undone. F04-03 keeps the O3 limit: a coherent rewrite of the published result that passes the validator is not detected by the database. The three D-only rows (F10-01, F10-02, F10-03) and F09-01 have no implementation credit.

## Rows reviewed without a credit change

- F12-04 (production rollout) stays 1/0/0/0. The B2 KILL window is BEHAVIOUR_PASS for bounded probe cases only, with productionQualified false and actualContact UNKNOWN. N1 is out of scope (P11).
- F05-01 stays 1/1/U/U (P4). Its record now states that the auditor wrote the probe scripts and a separate tester ran them, but `quant_lab/src/robot_quant/__init__.py` changed after the probe, and the 92 decisions and 130 repaint observations were not re-observed.
- F03-04 stays 1/1/1/0 (P12). Commit `720b433` fixed a stale runtime-lock handler that could exit the process with code 1 after `close()`. The credited V rests on checkout origin enforcement, terminal failure latching and runtime-lock retention while running. None of these asserts a clean shutdown exit, and the fix keeps lock loss before or during the unlock fail-stop. The row's source note now records the new `db.js` blob (E099) and the fix tests (E100), which are author tests with exact CI, not independent verification.
- F03-03 stays 1/1/1/0. Gate G-DP1-24H is now PASS, but F03-03 T is 0 because staging `4d86822` predates the later W1 changes.
- F08-01 T stays UNKNOWN (P5); the comparison defect is scored under P06-03.
- F11-01 (multi-Pine contracts) stays U/0/0/0 (Q2). The multi-Pine contract was root-accepted on 2026-10-19 (UTC) after independent review (`10b340d`) and is pinned as E096, and the finalizer judged the row D definition met (P8). Root kept D UNKNOWN: the contract's RD-MP-8 and section 11.4 item 1 tie the D decision and the deferred root decisions RD-MP-1, 2, 3 and 6 to fixture acceptance, so awarding D now would overstate the evidence. D is scored at fixture acceptance.

All other rows carry their S1 credits unchanged.

## Root decisions applied

| ID | Decision |
| --- | --- |
| P1 | Source commit `ca6abb1` (pushed; exact CI 9/9 as stated by root). Every new or changed evidence entry is pinned to its Git blob at `ca6abb1`; S1 pins are kept. Inventory PM1-I1 and the method are unchanged. |
| P2 | Records R0 to R6 carry method and root-acceptance fields (`2a6554f`) and are treated as root-accepted. F02-02 and P02-01 V = 1. F04-03 and P03-01 V = 1, because R4 covers the row clauses on the merged lineage; the pf2Engine identity `5bfd1bfa...` was recomputed at `ca6abb1` and equals the R4 value. T stays 0. |
| P3 | F04-04 and P03-02 V = 1 from commit `818a46b`. |
| P4 | F05-01 stays PENDING_EVIDENCE. |
| P5 | F05-03 stays 1/1/1/1. F06-01 and P05-01 T = 0. F08-01 T stays UNKNOWN. |
| P6 | F09-01 D = 1, re-pinned to the package contract blob at `ca6abb1`. I stays 0; the pure package-gate module is named as progress. |
| P7 | F10-01 D = 1. F10-02 D = 1 (QR-3 contract root-accepted on 2026-10-19 (UTC)). F10-03 D = 1 (QR-4 contract root-accepted on 2026-10-19 (UTC); finalizer judgement accepted by Q1): the QR-4 contract registers a fixed lexicographic objective with filters and no weights, keeps development scores separate and unrankable, refuses unsupported rankings with named codes, lists hard dependencies, boundaries and an independent test plan mapped to the row text, and its dependencies QR-3 and the package contract are root-accepted. RO-10 is read as "the contract text does not award credit; the scorecard does under the method". Items left to implementation (SQLSTATE, read budget, mode relation, feasibility check, decimal method, tolerance values) are parameters inside defined rules. |
| P8 | Superseded by Q2. The finalizer judged F11-01 D met: the multi-Pine contract (root-accepted on 2026-10-19 (UTC)) defines membership, the shared Bridge pair, source-bound evaluation, package binding and gates, isolation, the internal-only path before APP-3B, fixture cases F1 to F30 with an acceptance bar and an independent test plan. |
| P9 | F01-03 T = 0. V stays UNKNOWN, because R6 does not cover the rendered desktop and mobile part of the clause (confirmed by Q3). |
| P10 | P06-03 T = 0. V = 1, because committed tests assert the compatible-only and no-qualified-winner clauses. |
| P11 | F12-04 stays NOT_JUSTIFIED (1/0/0/0). N1 stays out of scope. |
| P12 | Commit `720b433`: no credited V or T depended on graceful-shutdown exit behaviour. Recorded as a fix with no credit change. |
| P13 | Gates are copied from S1 except where evidence at or before `ca6abb1` changes them (G-DP1-24H). No host step occurred in this root session. |

Root decisions after the finalizer packet, the tester checks and the consistency findings, all on 2026-10-19 (UTC):

| ID | Decision |
| --- | --- |
| Q1 | F10-03 D = 1: the finalizer P7 judgement is accepted. |
| Q2 | F11-01 D stays UNKNOWN. The multi-Pine contract's RD-MP-8 and section 11.4 item 1 tie the D decision and the deferred root decisions to fixture acceptance, so awarding D now would overstate. The scorecard uses the finalizer's P8 variant totals. |
| Q3 | F01-03 V stays UNKNOWN, because the rendered desktop and mobile layout was not checked in a browser. T = 0. The I rationale records that `ca6abb1` includes the fixes `ca11d99` and `eaa86d4` (R6, E092) and that the staging bytes predate them. |
| Q4 | P06-03 V = 1 kept. E103 and E104 are QR-1 author tests and E105 is the fix author's test; independence rests on R3 and its independent mutations (E079) and the R6 claim check (E092), not on the tests. T = 0, because the staging release eb532ff carries the R3 comparison defect: its compare API returns no market, dataset or cost fields, so the view would show an empty shared-context block (inferred from code identity, not observed on staging). |
| Q5 | "(UTC)" is added after the acceptance dates of F10-02, F10-03 and F11-01 and in the P7 and P8 text. |
| Q6 | A separate S2 verifier is added (see Reproduction). |
| Q7 | Root acceptance is recorded (see the end of this page). |

### Alternatives not adopted

Root considered these alternatives and did not adopt them. Each changes only the listed credits. The prototype view is unchanged in all of them.

| Alternative | Project lower / upper / UNKNOWN weight |
| --- | --- |
| This scorecard (accepted) | 64.2933 / 72.7900 / 41.5667 |
| F11-01 D = 1 (finalizer P8 judgement; not adopted under Q2) | 64.4933 / 72.7900 / 39.5667 |
| F10-03 D kept UNKNOWN (not adopted under Q1) | 64.1600 / 72.7900 / 42.9000 |
| F01-03 V = 1, reading R6 as covering desktop and mobile (not adopted under Q3) | 65.2933 / 72.7900 / 38.2333 |

## Acceptance gates

Gate statuses stay separate from the arithmetic and grant no GO.

| Gate | Status | Change and limitation |
| --- | --- | --- |
| G-DP1-24H | PASS (was OPEN) | Root accepted the read-only staging observation on 2026-10-16T09:53:22Z: POST_PASS 127,781,220 ms after the switch receipt, worker unchanged, zero restarts, health HTTP 200, queues and Live zero, 205 independent assertions. One dated sample, not continuous health; no positive O3-rule fill; service identity UNKNOWN. Evidence E101, E102. |
| G-PRODUCTION | BLOCKED | Production identity (watch-service identity UNKNOWN), runner wiring and transport, native capability, recovery, policy and release gates remain open. The B2 supervision probe windows are bounded behaviour records with productionQualified false. Nothing is deployed to production. |
| G-PO1-CI | PASS | Unchanged. `db.js` changed after PO1 only by the `720b433` close() fix; exact CI on `ca6abb1` passed 9/9 as stated by root. Staging release is separate. |
| G-LO1-LOCAL | PASS | Unchanged; local integrated code only. |
| G-BRIDGE | PASS | Unchanged; historical scope only. |
| G-INPUTS | OPEN | Unchanged. Owner decision O1 is recorded, but authenticated S4 behavioural acceptance is still open. |
| G-PREFLIGHT | BLOCKED | Unchanged; PF-2 remains disabled. |
| G-R7 | OPEN | Unchanged. |
| G-FREEZE | OPEN | Unchanged. |
| G-LAUNCH | OPEN | Unchanged. |
| G-FRESH-HEALTH | UNKNOWN | No host step in this root session. |

## Reproduction

```powershell
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S2_2026-10-19.json
node docs/progress/PM1_INDEPENDENT_VERIFIER_S2_2026-10-19.mjs docs/progress/PM1_SCORECARD_S2_2026-10-19.json
```

The calculator exits 0. It verified 107 evidence hashes and 54 rows and confirmed that the stored totals equal the calculated totals. Exact results: project lower 4822/75, upper 7279/100, UNKNOWN weight 1247/30; prototype lower 291/4, upper 965/12, UNKNOWN weight 125/3. Neither view has a single score.

| Verifier file | SHA-256 | Result on this scorecard |
| --- | --- | --- |
| `docs/progress/PM1_INDEPENDENT_VERIFIER_2026-10-15.mjs` (S1, unchanged) | `4adf94770ae2942323262413b6be6fcb3f47d951f99c819245e4c7421399c845` | Its exact rational recomputation agrees with the stored totals. Its pin check, written for S1, requires every Git pin to equal the declared source commit. S2 keeps the S1 pins at `7e6ccd1` under ruling P1, so that one assertion fails by design. |
| `docs/progress/PM1_INDEPENDENT_VERIFIER_S2_2026-10-19.mjs` (S2, Q6) | `cad1b7412780053ca6110fc9aecfe72b97aec116f13d408a87f09f918cfdec76` | Passes every check: all 81 credit combinations, exact fractions for 54 rows and 18 category totals in both views, 107 evidence hashes, all row references and 11 gate path bindings, and every committed evidence pin is an ancestor of `ca6abb1`. |

The S2 verifier is a copy of the S1 verifier. Only the pin rule changed: each evidence pin commit must be an ancestor of the declared source commit (`git merge-base --is-ancestor`) instead of equal to it, and the matching pass message says so. Its header comment records the date, the change and the reason. A control card with one pin moved to the later commit `93c1027` was rejected with "Evidence pin E107 is not an ancestor of the declared snapshot". Each verifier writes `final-results.json` beside itself, so both were run from byte-identical copies at the same directory depth outside `docs/progress`, as in S1. The JSON field `reproduction` records both verifier files, the calculator and their SHA-256.

Provenance: 70 of 107 evidence entries keep their S1 pins at `7e6ccd1`. 36 entries are pinned to Git blobs at `ca6abb1`: E067 to E070 (moved from S1 disk pins, identical SHA-256), E076 to E091 (new in the S2 draft) and E092 to E107 (new here). Eight draft entries changed content between the draft source `eb9c893` and `ca6abb1`: E076 to E082 gained root-acceptance fields, E076 and E080 to E082 also a method field, and E081 the F04-04 entry, and E086 gained OD-19, OD-20 and RC-1 to RC-11. The JSON field `draftRepins` lists them. E027 stays a disk pin to an ignored local artifact, as in S1, so another checkout needs that artifact to reproduce the replay. The test hashes cited in R4 and R5 equal the pinned blobs. Product code changed between `eb9c893` and `ca6abb1` only in `src/postgres/db.js` (`720b433`) and the new unwired `src/quant-library/package-gates.js`. Work that is not committed at `ca6abb1` is not scored. This includes the QR-2 working-tree changes and `src/comparison`, and commit `93c1027` (QR-2 S1 pure portfolio library), which landed on the branch after the source commit while this scorecard was being built. No product tests, host access, browser, PostgreSQL, network, deployment or Git writes occurred during this measurement.

[Method](../PROGRESS_MEASUREMENT.md), [inventory](PM1_INVENTORY_V1_2026-10-15.json), [prior scorecard S1](PM1_SCORECARD_S1_2026-10-15.md), [scorecard JSON](PM1_SCORECARD_S2_2026-10-19.json).

## Root acceptance

Accepted by Claude root on 2026-10-19 (UTC). Root reviewed the finalizer packet, the independent arithmetic and provenance checks and the consistency findings, and accepted this scorecard. It changes no product acceptance, gate or runtime state.

Open owner-facing notes: none required.

Next review trigger: score F10-01 and F10-02 I progress at a later scorecard. Commit `93c1027` (QR-2 S1 pure portfolio library) and the QR-3 S1 comparison module are after the source commit `ca6abb1` and are not scored here.
