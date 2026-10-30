# PM-1 successor scorecard S3 — 2026-10-30

Scorecard PM1-S3-2026-10-30 rescores all 54 rows of the unchanged inventory PM1-I1 (same weights, shares, targets and rules). The prior scorecard is PM1-S2-2026-10-19, which stays unchanged. The declared source commit is `d22a6a7` on branch `codex/fe2b-ci-local-fix`. The evidence window covers tracked commits `ca6abb1..d22a6a7`. Only committed content was scored; uncommitted work in the working tree, including the QR-2 edits and the 2026-10-30 Roadmap line, was not. Claude root accepted this scorecard on 2026-10-30 (UTC). This is engineering progress, not acceptance readiness, measured labor or a confidence interval. Scored at 2026-10-30T07:53:39Z (14:53 Asia/Bangkok).

| View | Lower bound | Upper bound | Weight of rows containing UNKNOWN |
| --- | ---: | ---: | ---: |
| project | 65.29% (4897/75) | 74.42% (893/12) | 46.37% (1391/30) |
| prototype | 72.75% (291/4) | 81.08% (973/12) | 45.00% (45) |

Project progress lies between 65% and 74%. Prototype progress lies between 73% and 81%. No single percentage or midpoint is justified, because UNKNOWN credits remain in both views. The bounds are engineering evidence bounds. They are not completion, and they grant no acceptance or GO.

## Change from S2

The series is comparable: inventory, weights, shares, targets and method did not change.

| View | Lower bound | Upper bound | UNKNOWN weight |
| --- | --- | --- | --- |
| project | 64.29 to 65.29 (+1.0000) | 72.79 to 74.42 (+1.6267) | 41.57 to 46.37 (+4.8000) |
| prototype | 72.75 to 72.75 (0) | 80.42 to 81.08 (+0.6667) | 41.67 to 45.00 (+3.3333) |

Exact values: project lower 4897/75, upper 893/12, UNKNOWN weight 1391/30; prototype lower 291/4, upper 973/12, UNKNOWN weight 45. Exact deltas: project +1, +122/75, +24/5; prototype 0, +2/3, +10/3.

The upper bounds move at four rows. In S2 each of them had a known T of 0 because staging was known to lack behaviour that the row needs. At `d22a6a7` the staging pair runs newer bytes (API `33e5a8c`, trading worker `ba1a433`, per the A2 and P4 records E109 to E112), which contain the fixes. No staging readback of that behaviour exists, so T becomes UNKNOWN rather than 1. This raises an upper bound only; it is not new verified work.

The project lower bound rises by one point from a single credit, F01-03 V (see below). The prototype lower bound does not change. The decreases that draft r1 showed in the lower bounds were reversed after the carry reconciliation: they came from unreconciled V carry on changed closures, not from a found defect or lost progress. The lower-bound change from S2 is that one credit, and it rests on existing render evidence, not on new product work.

Credits are written D/I/V/T, with U for UNKNOWN. Only four rows changed credits:

| Row (target) | S2 | S3 | Lower change | Upper change | Reason and evidence |
| --- | --- | --- | ---: | ---: | --- |
| F01-03 Shared UI and journey visibility (staging) | 1/1/U/0 | 1/1/1/U | +1.0000 | +0.6667 | V: the synthetic local render E108 closes the Q3 gap within its own limits. T: staging serves the fixed UI bytes (E110, E112); there is no journey or setup-guide readback. |
| F03-03 Worker transient faults (staging) | 1/1/1/0 | 1/1/1/U | 0 | +0.4800 | T: the staging trading worker runs `ba1a433`, which contains W1 (E109, E111). Transient-fault, bounded-rejection and systemic-hold behaviour was not read back. |
| F03-04 Transaction and lease integrity (staging) | 1/1/1/0 | 1/1/1/U | 0 | +0.4800 | T: the staging pair contains PO1 (`9b63d77`, `720b433`). Late-SQL refusal, origin enforcement and failure retention were not read back. |
| P06-03 Minimal comparison (staging journey) | 1/1/1/0 | 1/1/1/U | 0 | +0.6667 | T: the staging API at `33e5a8c` contains `c066604` (E112). No comparison readback. V carries under rule C3. |

These sum to the view deltas above. The other 50 rows carry their S2 credits unchanged.

## Rule C3: row-level carry reconciliation

Commits after `ca6abb1` changed files inside the pinned closures of several rows. Rule C3 decides, for each such row, whether its V credit carries. It applied to 13 rows: the 10 rows that draft r1 had moved from V 1 to UNKNOWN (F04-03, P03-01, F06-01, P05-01, F06-03, F08-01, P06-01, P06-03, F08-02, P06-02), plus F01-01, F04-04 and P03-02, which share changed files with them.

1. **Closure.** Take the row's S2-pinned closure: the files or identity named in the S2 `sourceIdentity`, plus the static relative-import closure of its entry modules and the injected services wired in `server.js` or `quant-research-main.js`.
2. **Diff.** List every file in that closure that changed in `ca6abb1..d22a6a7`, and read every hunk.
3. **Classify each hunk.**
   - **A, unreachable.** A discriminator that the certified flow never satisfies guards the hunk: another pathname, a new contract mode or version, or a flag that is off by default. Without the discriminator, every changed SQL predicate gives the old result.
   - **B, behaviour-identical.** The certified flow reaches the hunk, but the hunk does not change its outcome. Examples: a reset of a field that only another flow reads, a wrapper that returns the same value and rethrows the same error, an added engine-list entry that rotates an identity hash only, a comment, an import.
   - **C, fail-closed error path.** The hunk changes only what happens on a database error that carries a SQLSTATE. The error now propagates and the transaction rolls back, where before a fixed refusal came back. No success path or application refusal changes. Nothing is committed or published, and no database text reaches an outward answer.
   - **D, changes certified behaviour.** The hunk changes an outcome that the V clause certifies.
4. **Verdict.**
   - **V = 1** when every hunk is A, B or C. Each D hunk also needs a post-change, independent, root-accepted record that covers the clause. The pinned row tests are unchanged, or changed only by reviewed commits without a weakened assertion, and they pass after the change: in a recorded run, or in the exact-revision CI of a commit with the same product tree. For `33e5a8c` that CI is 9 of 9 (E124, now read by root); `33e5a8c..d22a6a7` touches only documentation, `README.md` and `Context.md`.
   - **V = UNKNOWN** when a D hunk has no covering post-change record, or a hunk cannot be classified.
   - **V = 0** when a hunk breaks the certified clause. That would be a defect and would cite it.
5. **T** follows the S2 T rule. T needs V. A local-integrated-code target needs integration plus exact CI on the applicable bytes.

**Root ruling on class C.** A class C hunk is not certified behaviour. It is still fail-closed, so a row whose only changes are class C, A and B hunks carries its V credit. The stricter reading (variant E below) stays recorded.

Result: no row gets V 0. All 10 V credits carry again, F06-03 T returns to 1 (a local integrated target, with the same product tree integrated and exact CI 9 of 9), and F01-01, F04-04 and P03-02 keep V 1 with a written reconciliation. In summary:

| Rows | Changed closure files (commits) | Hunk classes | Post-change evidence |
| --- | --- | --- | --- |
| F04-03, P03-01 | PF-2 engine file list (`15e7bbf`: 25 files added, none removed, evaluator unchanged), `quant-preflight.js`, enrollment migration, foundation, scheduler, recovery, process supervisor, runtime engine files | A: fixed-evaluation guards, SERIALIZABLE retry only with the default-off flag. B: added engine-list files, a supervisor module name. C: SQLSTATE propagation in `quant-preflight.js` and the enrollment migration; the resolver still turns every adapter throw into a fixed PF2 code. | FE-2b PostgreSQL stage 75 pass (E113); CI repair (E123); CI 9 of 9 at `33e5a8c` (E124) |
| F06-01, P05-01 | foundation, scheduler, recovery, research and data files (`15e7bbf`) | A: fixed-evaluation guards on every hunk, with a NULL mode keeping the old result. C: SQLSTATE propagation in authorize, which removes a spurious revoke and stays fail-closed. No hunk touches the D1 stop checks. | Pinned tests unchanged; FE-2b stage 138 pass, 1 skip (E113); E123 states the stop and release guards are unchanged; CI 9 of 9 |
| F06-03 | `request-dispatch.js`, `server.js`; optimize transport unchanged | A: the after-commit call and the declaration retry run only for QR-2 handlers and `PUT /api/paper-capital-model`; QR-2 routes return false for other paths or with the flag off. B: attempt reset and catch clear the new field; the deferred wrapper returns the same value. The optimize disconnect, outcome and no-retry lines are unchanged. | Transport test unchanged; CI 9 of 9. T = 1 (local integrated target) |
| F08-01, P06-01 | `quant-library.js`, `derive.js`, new exposure-register and owner-recommendation modules | A: fixed-evaluation exclusions. D: the G5 v2 register read on reopen adds qualification fields and fails closed on a read error; provenance, evaluation, limitations and completeness builders are unchanged. | QR-3 S2b (E114): independent auditor, mutations, sole-runner library tests pass |
| P06-03 | as F08-01 | Compatible-only: compare calls the same `load()`; no qualified winner (`QUALIFIED_WINNER` null, G8 always FAIL); G5 v2 only adds FAIL or NOT_CHECKED. | Compare-context test unchanged; E114 |
| F08-02, P06-02 | freeze migration (`4258ab4`, `1480385`), new runtime-role inspection | D: stricter classifier and install, refused unless run as the owner of `quant_jobs`. A: the `1480385` change applies only when `quant_jobs` is absent. Freeze SQL unchanged. | E115: independent auditor plus second-opinion review, mutations, sole-runner pass including the freeze restart readback |
| F01-01 | `request-dispatch.js`, `server.js`; auth and http unchanged | request-dispatch: A or B as for F06-03. server: D, three owner-data routes behind `QR2_PERFORMANCE_ENABLED`, after the actor and sensitive-action checks. | QR-2 S3a (E116) and S4.4/S4.5 (E117) independent review; pinned isolation test unchanged |
| F04-04, P03-02 | PF-3 closure is the imports of the readiness service and routes plus the injected preflight service; `quant-profile.js` is not a member at either revision | B: mechanical helper extraction in `market-ohlcv.js` (`5323511`, independently reviewed, E118). A or B in `request-dispatch.js`. C outside the preflight get and list calls. B in runtime engine files (a rotated engine gives the certified unavailable behaviour). | Pinned test unchanged; CI 9 of 9 |

Two notes on files outside the scored rows:

- `src/postgres/store.js` (the Bot-creation lock change) is outside every pinned closure. It is not scored.
- The `declarationRetry` hunk in `request-dispatch.js` affects only `PUT /api/paper-capital-model`, which no scored row cites.

### F01-03 notes

- V = 1 rests on E108 (`ACCEPTED_SYNTHETIC_LOCAL_RENDER_ONLY`). E108's own limits: static component and shared-style rendering only; `app.js` and authentication not exercised; synthetic responses; no claim of disabled navigation controls; no end-to-end journey.
- After the render revision `fed76e0`, `journey.js`, `setup-guide.js`, `styles-v2.css` and `app.js` are unchanged. `i18n.js` gains 35 QR-2 coverage-label lines and deletes none. `index.html` changes only the cache tokens of `i18n.js` and the paper-performance files. All `paper-performance.css` rules are scoped to `#paperPerformance`, and `paper-performance.js` is the QR-2 panel. None of these is an input to the journey or the setup guide.
- T = UNKNOWN. The X4 a02 immediate checks (E110) matched served assets 34 of 34 and auth routes 6 of 6, then a production-identity difference stopped the remaining checks. The A2 attempt (E112) later served the `33e5a8c` tree, and its immediate and delayed checks passed. There is no journey or setup-guide readback.

## Outcomes with uncertain credit

These stay open in the record.

1. **Class C as carry.** F04-03, P03-01, F06-01 and P05-01 rely on reading SQLSTATE propagation (fail-closed rollback instead of a fixed refusal) as not changing the certified clause. Root rules that it carries; variant E keeps these four at V UNKNOWN.
2. **F01-03 V = 1** rests on a synthetic static render, not on a reconciliation like R6. Variant B keeps it UNKNOWN.
3. **T UNKNOWN rather than 0** at F01-03, F03-03, F03-04 and P06-03: the staging bytes now contain the fixes, but no readback exists. Variant C keeps F03-03 and F03-04 at 0. For F08-01, P06-01 and P06-03 on staging, E114 notes that the detail and compare views fail closed without the exposure-register grants; the staging register state is not recorded here.
4. **`holdoutWindow` alignment (F08-01, P06-01).** It now returns null for a dataset start that is not on a minute boundary, so provenance `holdout_window` can change for such a run. v2 contracts require alignment; v1 was not checked.
5. **PF-3 closure** (F04-04, P03-02) is defined by static relative imports plus the `server.js` wiring. Dynamic use, if any, is not traced.
6. **F10-01 I = 0** relies on the Roadmap text that full S5 remains open.
7. **E124 closure.** CI 9 of 9 at `33e5a8c` was root-stated in the S6 re-pin packet and is now read by root. The FE-2b CI at `15e7bbf` failed 7 PostgreSQL tests (E125); the repair is E123.

### Alternatives not adopted

Each changes only the listed credits. The lower and upper bounds are the exact values.

| Alternative | Project lower / upper / UNKNOWN weight | Prototype lower / upper / UNKNOWN weight |
| --- | --- | --- |
| This scorecard (accepted) | 4897/75 = 65.2933 / 893/12 = 74.4167 / 1391/30 = 46.3667 | 291/4 = 72.7500 / 973/12 = 81.0833 / 45 |
| Pre-reconciliation position (10 V credits UNKNOWN, F06-03 T UNKNOWN) | 4517/75 = 60.2267 / 893/12 / 1741/30 = 58.0333 | 263/4 = 65.7500 / 973/12 / 185/3 = 61.6667 |
| E: class C not accepted as carry (F04-03, P03-01, F06-01, P05-01 V UNKNOWN) | 4777/75 = 63.6933 / 893/12 / 517/10 = 51.7000 | 275/4 = 68.7500 / 973/12 / 175/3 = 58.3333 |
| B: F01-03 V kept UNKNOWN | 4822/75 = 64.2933 / 893/12 / 1391/30 | unchanged |
| C: F03-03 and F03-04 T kept 0 | 4897/75 / 22037/300 = 73.4567 / 1247/30 = 41.5667 | unchanged |

## Rows reviewed without a credit change

F12-04 stays 1/0/0/0 (N1 out of scope; the B2 KILL window is bounded probe behaviour only). F05-01 stays 1/1/U/U (no re-observation after the `__init__.py` change). F11-01 stays U/0/0/0 (D is tied to fixture acceptance). F09-01, F10-01, F10-02 and F10-03 keep their S2 credits. F10-01 I stays 0 (see item 6). Uncommitted QR-2 work is not scored.

## Acceptance gates

Gate statuses are copied from S2 unchanged. They stay separate from the arithmetic and grant no GO. The project remains Spot/Paper only. Live is hard-locked. Private acceptance is NOT RUN, READY is false, and P13j and N1 are held.

| Gate | Status | Limitation |
| --- | --- | --- |
| G-DP1-24H | PASS | One dated sample, not continuous health; no positive O3-rule fill; service identity UNKNOWN. |
| G-PRODUCTION | BLOCKED | Production identity, runner wiring and transport, native capability, recovery, policy and release gates remain open. Nothing is deployed to production. |
| G-PO1-CI | PASS | Unchanged; staging release is separate. |
| G-LO1-LOCAL | PASS | Unchanged; local integrated code only. |
| G-BRIDGE | PASS | Unchanged; historical scope only. |
| G-INPUTS | OPEN | Authenticated S4 behavioural acceptance is still open. |
| G-PREFLIGHT | BLOCKED | PF-2 remains disabled. |
| G-R7 | OPEN | Unchanged. |
| G-FREEZE | OPEN | Unchanged. |
| G-LAUNCH | OPEN | Unchanged. |
| G-FRESH-HEALTH | UNKNOWN | One dated A2 staging sample is not continuous health. No host step in this scoring. |

## Reproduction

```powershell
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S3_2026-10-30.json
```

Root verified the calculator logic (`calculate()` and `verifyEvidence`) on this file: 139 of 139 evidence hashes match, 54 rows, and the stored totals equal the calculated totals. Exact results: project lower 4897/75, upper 893/12, UNKNOWN weight 1391/30; prototype lower 291/4, upper 973/12, UNKNOWN weight 45. Neither view has a single score.

E027 stays a disk pin to an ignored local artifact, as in S1 and S2. A checkout needs the local evidence folder to reproduce that one hash; without it, the calculator stops at E027. Root hashed it from a local copy of that artifact. An independent tester recomputed the totals and found them consistent. The S2 independent verifier was not run on S3, and no test suite was run during scoring.

Provenance: evidence E123 to E139 are new in S3 and are pinned to Git blobs at `d22a6a7`. The other entries keep their S1 and S2 pins. The JSON field `draftRepins` lists the eight S2 pins that changed between the S2 draft source and `ca6abb1`. Product files that changed in `ca6abb1..d22a6a7` are outside the scoring unless a row closure contains them, in which case rule C3 above applies. The Fable 5.1 consistency checker was paused by the owner; an Opus 5.5 auditor and a Sonnet 5.5 tester were substituted. No product tests, host access, browser, PostgreSQL, network, deployment or Git writes occurred during this measurement.

[Method](../PROGRESS_MEASUREMENT.md), [inventory](PM1_INVENTORY_V1_2026-10-15.json), [prior scorecard S2](PM1_SCORECARD_S2_2026-10-19.md), [scorecard JSON](PM1_SCORECARD_S3_2026-10-30.json).

## Root acceptance

Accepted by Claude root on 2026-10-30 (UTC) as the main position (not a variant). Root checks: repo calculator logic on 139 of 139 evidence hashes, 54 rows and equal stored totals; independent tester recompute consistent; CI read by root at `33e5a8c` (9 of 9). It changes no product acceptance, gate or runtime state.

Open owner-facing notes: none required.

Next review trigger: score QR-2 progress at a later scorecard, after the QR-2 working-tree changes are committed and reviewed.
