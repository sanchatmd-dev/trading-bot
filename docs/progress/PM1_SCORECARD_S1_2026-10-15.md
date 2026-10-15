# PM-1 successor scorecard S1 — 2026-10-15

Scorecard PM1-S1-2026-10-15 rescores all 54 rows of the unchanged inventory PM1-I1 (same weights, shares, targets and rules). The prior scorecard is the baseline PM1-B1-2026-10-15, which stays unchanged. The evidence window covers tracked commits `faa32a4..7e6ccd1`, the evidence records added after the baseline, four uncommitted DP1-P records, and the 2026-10-15 Codex-to-Claude handoff. This is engineering progress, not acceptance readiness, measured labor or a confidence interval.

| View | Lower bound | Upper bound | Weight of rows containing UNKNOWN |
| --- | ---: | ---: | ---: |
| project | 50.17% | 74.12% | 69.23% |
| prototype | 52.00% | 82.42% | 75.83% |

Project progress lies between 50% and 74%. Prototype progress lies between 52% and 82%. No single percentage or midpoint is justified, because UNKNOWN credits remain in both views.

## Change from the baseline

The series is comparable: inventory, weights, shares, targets and method did not change.

| View | Lower bound | Upper bound | UNKNOWN weight |
| --- | --- | --- | --- |
| project | 46.12 to 50.17 (+4.0533) | 70.40 to 74.12 (+3.7200) | 72.57 to 69.23 (−3.3333) |
| prototype | 52.00 to 52.00 (0) | 82.42 to 82.42 (0) | 75.83 to 75.83 (0) |

Two project rows changed. No prototype row changed, because neither changed row is referenced by a prototype outcome.

| Row | Before | After | Lower change | Upper change | Reason and evidence |
| --- | --- | --- | ---: | ---: | --- |
| F03-04 Database transaction and runtime lease integrity (target staging) | 1/1/0/0 | 1/1/1/0 | +0.72 | +0.72 | The independent original six PO1 cases passed 6/6, and exact-commit CI on `9b63d77` passed all nine checks. Root closed the PO1 fixture integration gate on that basis. `db.js` bytes at HEAD equal the baseline source identity. T stays 0 because no build containing PO1 has reached staging. Evidence E057, E058, E062, E075. |
| F06-03 Legacy optimize request and transaction containment (target local integrated code) | U/0/0/0 | 1/1/1/1 | +3.3333 | +3.0000 | Root accepted the LO1 contract, which matches the narrow-containment option of the frozen design. Commit `6d8cf5d` implements it. Independent PostgreSQL verification passed 19 cases plus one actual disconnect case, independent source review accepted it, and 95 integrated pure tests passed. Exact-commit CI on `3a55976` passed 9/9. The declared target is local integrated code, so T is earned locally only. Evidence E059, E060, E061, E062, E072–E074. |

Retained limits for the changed rows: PO1 protects the checkout only, and privileged in-lease changes and raw-pool bypass stay outside its scope. LO1 bounds upstream waiting under normal scheduling, not total request time. Actual network lost-COMMIT acknowledgement was not tested. LO1 and PO1 are not backported into the DP1-P candidate and are not deployed anywhere. Preserved failures are the original PO1 incomplete-fixture and six-case failures, and the Windows Python fixture failure on `6d8cf5d`, whose actual cause remains UNKNOWN.

## Rows reviewed without a credit change

- F12-04 (production rollout) stays 1/0/0/0. The new DP1-P records are root-accepted local candidates (C3R packaging, C3R-2 runtime seam), a local model that is not wiring (CREDIT2 placement), a review paused by the owner (native observer), an inert Linux artifact qualification and scoped production discovery. Production watch-service identity remains UNKNOWN, runner wiring and transport are not done, and nothing is deployed to production. The derived CREDIT2 numbers are not approved quotas.
- F03-03 (W1 worker, target staging) stays 1/1/1/0. The staging switch and its immediate and 10-minute observations predate the baseline and were already counted as evidence. The 24-hour observation has not run.
- F03-02 stays 1/1/1/1. The PO1 integration failure noted in its baseline limitation is now closed.
- F04-04, F04-05, F05-01, F05-03 and F01-01 keep their UNKNOWN credits. The only changes touching them are test fixtures, a test-only Python startup bound, and optimize-path changes to `server.js` and `request-dispatch.js` with independent source review. A CI pass is not independent verification of those contracts. No credit is revoked.

All other rows carry their baseline credits and evidence unchanged.

## Acceptance gates

Gate statuses stay separate from the arithmetic and grant no GO.

| Gate | Status | Change and limitation |
| --- | --- | --- |
| G-PO1-CI | PASS (was BLOCKED) | Local integration closed by the six-case proof and exact CI on `9b63d77`. Staging release is separate. |
| G-LO1-LOCAL | PASS (new record) | Local integrated code only; not deployed. |
| G-DP1-24H | OPEN | Not before 2026-10-16 05:17:53.400 Asia/Bangkok (`2026-10-15T22:17:53.400Z`). Not run at scoring time; needs a fresh authorized observation and root acceptance. |
| G-PRODUCTION | BLOCKED | Needs the staging 24-hour observation, production identity, runner wiring and transport, native capability, recovery, policy and release gates. Nothing deployed to production. |
| G-BRIDGE | PASS | Unchanged; historical scope only. |
| G-INPUTS | OPEN | Unchanged. |
| G-PREFLIGHT | BLOCKED | Unchanged. |
| G-R7 | OPEN | Unchanged. |
| G-FREEZE | OPEN | Unchanged. |
| G-LAUNCH | OPEN | Unchanged. |
| G-FRESH-HEALTH | UNKNOWN | No host access in this measurement. |

## Reproduction

```powershell
node scripts/calculate-pm1-progress.mjs docs/progress/PM1_SCORECARD_S1_2026-10-15.json
```

The calculator verified 75 evidence hashes and 54 rows, and confirmed that the stored totals equal the calculated totals. Exact results: project lower 3763/75, upper 22237/300, UNKNOWN weight 2077/30; prototype lower 52/1, upper 989/12, UNKNOWN weight 455/6. The baseline replay still passes unchanged.

Provenance: 70 of 75 evidence entries are pinned to Git blobs at the declared source commit `7e6ccd1`. Of these, 49 baseline entries have blobs unchanged since `faa32a4` (identical SHA-256), and E054–E056 are tracked files with the same hash as their earlier working-tree pins. E008 (`docs/ROADMAP.md`), E045 (`README.md`) and E046 (`Context.md`) are re-pinned to their `7e6ccd1` blobs. Each `faa32a4..7e6ccd1` diff adds 30 lines at the top and removes none. The 26 distinct rows that cite these files (30 citations) were checked, and no statement they rely on was removed or contradicted. The JSON field `evidenceRepins` records this check, and the baseline keeps its `faa32a4` pins unchanged. Five entries are hashed from disk: E067–E070 are uncommitted working-tree files absent from `7e6ccd1`, and E027 is an ignored local artifact. The replay fails if those files change or are absent, so commit E067–E070 unchanged before relying on this replay elsewhere. Gate G-DP1-24H now lists both evidence paths (E050, E063). The unmodified independent verifier passes on this scorecard; it was run from a byte-identical copy outside `docs/progress` because it writes `final-results.json` beside itself. No product tests, host access, browser, deployment or Git writes occurred during this measurement.

[Method](../PROGRESS_MEASUREMENT.md), [inventory](PM1_INVENTORY_V1_2026-10-15.json), [baseline](PM1_BASELINE_2026-10-15.md), [scorecard JSON](PM1_SCORECARD_S1_2026-10-15.json).

Root acceptance: Claude root accepted this scorecard on 2026-10-15T13:20:30Z after the unmodified independent verifier (run from a byte-identical copy so its result file stays out of docs/progress) and the calculator both passed. Acceptance concerns the scoring only; it changes no product, gate or runtime state.
