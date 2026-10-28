# QR-2 option D: long ranges return the report with bar coverage "not checked"

Recorded by the Claude root on 28 October 2026 (Bangkok). Evidence: [record](evidence/QR2_COVERAGE_DEGRADE_D_2026-10-28.json). Owner decision OD-S5-D (2026-10-28). Status: local change accepted, **not deployed**.

## Problem

The QR-2 performance report refused a whole request when its bar-coverage check would exceed a coverage budget. Month, the panel's default period, failed from about day 16 of each month; Year and All Time failed for Bots older than about 15 to 30 days. Staging answers 503; the local fix of 27 October ([F](QR2_COVERAGE_ADMISSION_FIX_2026-10-27.md)) answers 422 with the limit.

## Change

When the bar-coverage check of a request would exceed one of the degradable coverage budgets, the report is still returned, and bar coverage for the whole request is shown as UNAVAILABLE with the reason `COVERAGE_BUDGET_EXCEEDED` (panel class C7, in English and Thai). No budget value changes, and no financial number or status changes.

- Degradable: `union_minutes` (decided before any query) and the data-time stops of `timestamp_rows`, `derivation_visits`, `output_intervals` and `coverage_output_bytes`.
- Not degradable, unchanged: `unique_windows`, `coverage_input_bytes`, plan-time byte refusals (422 with detail), unnamed overflow, the post-build lowered-limit refusal and every financial limit. The plan history limit stays 403 and the computation slot 429.
- The worker accepts a data-time claim only when the planned windows alone make it possible; any other claim is a corrupt registry (503).
- The panel shows C7 with a plain explanation; the 422 hint keeps only its generic text. Cache tokens for `i18n.js` and `paper-performance.js` move to `qr2o9`.
- The [contract](QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md) records OD-S5-D (new section 11.1, sentences in 8.1 and 10, an amended-by-reference table for the hash-pinned packets).

## Verification

- Root ran the whole non-PostgreSQL suite, one file per process: 3163 tests, 3145 pass, 8 skipped, 9 todo, and one failure that is a harness artefact: `test/pf2-worker-test-seam.test.js` requires the repository's `--test-isolation=none` mode, passes 2 of 2 when run that way, and is not touched by this change.
- The tester passed with independent tests; the QR-2 PostgreSQL files passed on a throwaway cluster (14 of 14, then the four changed files again after the fix round), including a degraded ALL_TIME request over HTTP that answers 200 with C7 and a financial-equality check under a lowered budget.
- 27 targeted mutants: every non-equivalent one is killed after the fix round.
- The Opus auditor gave GO WITH CONDITIONS with no P1; both P2 items were fixed in round 2.
- CI on the pushed commit is the independent check.

## What it does not do

Month still shows bar coverage "not checked" from about day 16; raising the coverage budgets (option A, approved in principle) follows only after the local gate L measurement and a staging re-measure. Run-length coverage for Year and All Time (option B) is deferred. Staging still runs the pinned pair ba1a433; this change reaches staging through the API-only re-pin packet S6-STAGING-API-REPIN-1 and its owner GOs.
