# QR-2 coverage admission fix: long ranges answer 422 with the limit

Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [fix record](evidence/QR2_COVERAGE_ADMISSION_FIX_2026-10-27.json). Status: local fix accepted, **not deployed**.

## Problem

On staging the QR-2 per-Bot performance panel answered 503 QR2_REPORT_FAILED for long report ranges. The cause was the coverage read limits: a range holding more than 21,600 stored bars, or spanning more than 30 days, was refused by the coverage code with a plain error, which the routes answer as 503. The [contract](QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md) (section 8.1) refuses a request over a read limit with 422 `QR2_RANGE_ADMISSION_REFUSED` and the limit in the detail.

## Change

On the reader path only, a coverage read-limit refusal now becomes a request refusal: 422 `QR2_RANGE_ADMISSION_REFUSED` with detail `{limit, value, max}`, on both the per-Bot and owner routes. The worker path keeps its mapping (503 for an overflow on a context the reader already admitted). A database result over its own LIMIT is treated as a corrupt result and answers 503. No limit value, response shape, worker, route or UI file changed.

Files: `src/portfolio/qr2-coverage-snapshot.js` (an optional detail on the coverage error) and `src/postgres/qr2-coverage-reader.js` (the reader boundary), with new tests in `test/qr2-coverage-admission.test.js` and `test/postgres/qr2-coverage-admission.test.mjs`.

## Amendment to the Stage 3B packet, row 221 (by reference)

The [Stage 3B packet](QR2_S5_4_STAGE3B_RESPONSE_WIRING_PACKET_2026-10-24.md) stays unchanged, because its evidence pins its hash. Row 221 now applies only to a `planCoverage` overflow inside the worker, on a context the reader already admitted (a corrupt context: 503 on both routes). A new reader-path row applies to a range over a coverage read limit at the reader: 422 `QR2_RANGE_ADMISSION_REFUSED` with the limit detail on both routes; the worker is not reached.

## Verification

- Root ran `test/qr2-*.test.js` under the machine lock: 372 tests, 370 pass, 0 fail.
- The coder ran the whole non-PostgreSQL suite (3,120 tests, 0 fail) and the 14 QR-2 PostgreSQL test files on a throwaway cluster (111 of 111).
- The tester passed both rounds with independent tests and mutants (8 of 8 killed).
- The Opus auditor gave GO WITH CONDITIONS with no P1 or P2. Round 2 fixed two of its minor items: corrupt driver results stay 503, and tests were added for every named limit and for All Time.
- CI on the pushed commit is the independent PostgreSQL check.

## What it does not fix

The panel still refuses Month and long Custom ranges, now with a clear 422 and the limit, and All Time for Bots older than 30 days. A budget analysis shows that Month fits after raising four budgets, but only after a new measurement and a staging re-measure under an owner GO. All Time needs a coverage design change or degrading coverage to "unavailable", which is a contract decision for the owner. Staging still runs the pinned pair ba1a433; deploying this fix needs a new pin and its own packet and owner GO.
