# QR-2 S5-4 Stage 3A: pure public coverage projection

Status: **PREPARED; ROOT-ADOPTED FOR LOCAL IMPLEMENTATION; NOT ACCEPTED**. On 2026-10-24 (Bangkok) the owner granted continuous local work and continuous GO in chat. Root adopted this slice under that authority, which covers bounded local engineering only. It does not cover the C3 or PostgreSQL runtime, target contact, or public response wiring. No implementation, test run or acceptance has happened yet.

## Purpose and position

Contract section 11 requires bar gaps in the report range to be listed as intervals (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:493). Section 9 forbids showing a filled or interpolated gap (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:470). The S5 slice is accepted only after a rendered desktop and mobile check on the local stub (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:510). The current response still exposes only a scalar market-data gap indicator (QR2_S5_UI_TRACEABILITY_2026-10-23.md:32).

The S5-4 design gives Stage 3 the job of publishing account coverage and the owner `market_coverage` object (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:59). Stage 3 needs exact packets and independent acceptance (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:63). Stage 2C deliberately built no public coverage objects (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:35).

Stage 3A is the pure first part of Stage 3. It adds a new module that projects an already-read coverage registry into frozen public object shapes, plus a closed validator for the owner envelope. The module stays unwired: no worker, composer, route, reader or UI imports it. The pattern follows the accepted Stage 1 and Stage 2A seams.

Stage 3A runs ahead of the Roadmap's next QR-2 step, the coupled C3 diagnostic harness (ROADMAP.md:40 in the current working copy). Root records the reason: the C3 runtime is closed. Native compilation, process fixtures, PostgreSQL and the C3 runtime stay closed until their own packet and admission pass (QR2_S5_4_STAGE2C_COMBINED_MEASUREMENT_PACKET_2026-10-23.md:151). Final coverage budgets may change after C3. All byte and count budgets therefore stay parameters taken from the existing lowering-only budget definition (src/portfolio/qr2-coverage-limits.js:4-5). This slice adds no new numeric constant.

Stage 3A adds no user-visible behavior and earns no PM-1 credit. It does not close full S5. Wiring into the response validators and worker (O6) and the EN/TH UI with local rendering (O7) each need their own packet. Public response wiring is excluded from tonight's authority.

## Ownership

One coder may write only:

- `src/portfolio/qr2-coverage-public.js` (new)
- `test/qr2-coverage-public.test.js` (new)
- an assigned ignored report directory

Root owns this packet, the evidence record, the Roadmap and Time Management notes, integration, Git and acceptance. Root writes those project notes only after the outgoing handoff's uncommitted paths are resolved.

Read-only for every role: `src/portfolio/qr2-coverage.js`, `src/portfolio/qr2-coverage-snapshot.js`, `src/portfolio/qr2-coverage-limits.js`, `src/market-gap-intervals.js`, `src/postgres/market-ohlcv.js`, `src/portfolio/qr2-response.js`, `src/portfolio/qr2-owner-response.js`, `src/postgres/qr2-compute-worker.js`, `src/postgres/qr2-coverage-reader.js`, `src/postgres/qr2-reader.js`, `src/postgres/qr2-owner-reader.js`, everything under `public/`, routes, schema and migrations, and every existing test and fixture.

## Input

The projection receives the Stage 2 registry and its independently authorized context:

- `registry`: the closed `qr2-coverage-snapshot-v1` object with `unions`, `windows`, `bindings` and `charges` (src/portfolio/qr2-coverage-snapshot.js:3, :152-156; QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:29).
- `context`: `{accounts, budgets}`, exactly the Stage 2C `input.coverage_context` (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:31, :100). Metadata comes from authorized admission records, never from the registry being validated.

Before projecting, the module runs `validateCoverageSnapshot(registry, context)` (src/portfolio/qr2-coverage-snapshot.js:163). The module therefore fails closed when used on its own. Error mapping is unchanged:

- invalid context: `QR2_INPUT_INVALID`
- corrupt or over-budget registry: `QR2_REPORT_FAILED` (src/portfolio/qr2-coverage-snapshot.js:176-181)

## Frozen public shapes

### Per-window coverage

Each unique registry window yields exactly one `qr2-bar-coverage-v1` object (src/portfolio/qr2-coverage.js:3). It has exactly the Stage 1 key set (src/portfolio/qr2-coverage.js:6; QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:27):

`version`, `source`, `market`, `resolved_range`, `inspected_window`, `excluded_edges`, `state`, `reason`, `complete`, `expected_minutes`, `stored_minutes`, `missing_minutes`, `interval_count`, `intervals`

Each object must pass `validateBarCoverage` (src/portfolio/qr2-coverage.js:91). It must deep-equal the Stage 1 builder output for the same window:

| Registry state | Equivalent Stage 1 call |
| --- | --- |
| `union_id` null | `NOT_NEEDED` fact |
| union fact `TABLE_ABSENT` | `TABLE_ABSENT` fact |
| union fact `COMPLETE` | `COMPLETE` fact whose timestamps are the union array from `start_index` (inclusive) to `end_index` (exclusive) |

The Stage 1 state precedence still applies (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:29-35). Each window's `expected_minutes`, `stored_minutes`, `missing_minutes` and `interval_count` must equal the registry window fields. The sum of interval counts must equal `charges.output_intervals`.

### Owner envelope

The owner envelope has exactly this shape. It matches the estimator skeleton in src/portfolio/qr2-coverage-snapshot.js:100 and the design in QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:59.

```
{market_coverage:{
  version:'qr2-owner-bar-coverage-v1',
  entries:[{id:'coverage:<N>', coverage:<qr2-bar-coverage-v1>}],
  accounts:[{bot_id, broker, coverage_ids:['coverage:<N>']}]
}}
```

- `entries` follows registry window order. Registry windows are deduplicated by equal market and range. They are sorted by market key (broker, symbol, timeframe; an unsupported null market first), then by numeric range with null ranges first (src/portfolio/qr2-coverage-snapshot.js:70-73).
- `<N>` is the registry window `id`, a decimal integer without padding: `coverage:0`, `coverage:1` and so on.
- `accounts` follows registry binding order: `bot_id`, then `broker`, by code-unit comparison (src/portfolio/qr2-coverage-snapshot.js:84).
- Each included `(bot_id, broker)` appears exactly once. Its `coverage_ids` holds exactly one ID that resolves to an entry.
- Every entry is referenced at least once.
- The set of `(bot_id, broker)` pairs must equal `context.accounts`.
- With zero accounts, both `entries` and `accounts` are empty.

Unresolved, duplicate, orphan or mismatched references are rejected (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:59). Members carry IDs only and never embed a duplicate coverage object.

### Single-account form

For one account, the module returns the same coverage object as that account's entry. The intended later location is `market_data.coverage`, which the byte estimator already sizes as a wrapper (src/portfolio/qr2-coverage-snapshot.js:103). Stage 3A does not add that key to `marketDataOf` (src/portfolio/qr2-response.js:192-195). That edit belongs to O6.

### Validator

The new closed validator for the owner envelope checks:

- exact key sets at every level
- the version string
- that each entry coverage passes `validateBarCoverage`
- contiguous ID order
- the mapping rules above, against `context.accounts`

It returns `{ok, errors}` in the same style as `validateBarCoverage`. Exported names are left to the coder. The packet freezes only the shapes and the behavior.

## Construction rules

1. **Index-derived intervals.** Derive each COMPLETE window's intervals by walking the union timestamp array between the registry's `start_index` and `end_index`. Do not slice, copy or sort the array. Reusing `assembleGaps` (src/market-gap-intervals.js) is allowed, with the same no-truncation capacity rule as Stage 1 (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:39). Build each unique window's coverage once (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:59).
2. **Byte bound before allocation.** Before building any coverage object, confirm that the registry's `charges.output_bytes_upper_bound` is at most `budgets.coverage_output_bytes`. `validateCoverageSnapshot` already enforces this; the module re-reads the value and does not recompute it.
3. **Actual size after build.** Measure the UTF-8 byte length of the JSON serialization of the owner envelope, and of each single-account `{market_data:{coverage}}` wrapper. Each length must be at most the registry's upper bound and at most the effective byte limit (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:61).
   - Actual size above the effective limit refuses the whole request with `QR2_RANGE_ADMISSION_REFUSED` (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:57).
   - Actual size above the estimate but within the limit is an estimator defect. It fails closed with `QR2_REPORT_FAILED`, and root treats it as a stop condition.
4. **No truncation, no partial success.** Never shorten an interval list, drop an entry or return a partial envelope. Any failure throws and returns nothing (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:57, :61).
5. **Refused-member rule.** The module takes no financial summary, ledger view or refusal status as input. Coverage for any account comes only from that admitted account's own registry window, which was read independently for the verified account. The module never infers COMPLETE from a refused member summary (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:61; QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:60). Whether a refused member publishes its coverage is decided by O6.
6. **No input mutation.** The registry, its timestamp arrays, the context and the budgets stay unchanged. Tests use deep-frozen inputs.
7. **Pure imports.** Allowed imports are `./qr2-coverage.js`, `./qr2-coverage-snapshot.js`, `./qr2-coverage-limits.js` and `../market-gap-intervals.js`, plus language globals. Imports of pg, `db.js`, store, server, routes, dispatcher or any `src/postgres/` module are forbidden. Keeping the module pure keeps the worker import-graph guard satisfiable for later wiring (test/qr2-compute-pool.test.js:505).
8. **No leakage.** Error objects carry fixed codes only, with no coverage data, account metadata or counts (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:62).
9. **Monetary neutrality.** Coverage never changes a price, valuation or financial field. Only a gap at a needed valuation point changes a number, and that stays with the existing resolver (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:493).

## Acceptance list

Every check is pure `node:test` with no PostgreSQL, network, browser, child process or worker pool, and a 90-second process bound.

- **A1.** The new `test/qr2-coverage-public.test.js` covers:
  - unsupported market
  - null resolved range
  - range without a full candle
  - `TABLE_ABSENT`
  - COMPLETE with zero rows (one all-missing interval)
  - mixed internal, leading and trailing gaps
  - more than 50 gaps
  - equal and nested windows sharing one entry
  - different partial edges giving distinct entries
  - a five-member owner
  - zero accounts
  - duplicate, orphan and unresolved references
  - set mismatch with `context.accounts`
  - corrupt registry
  - byte limit exactly at the actual size, and at the actual size minus one
  - interval count consistency with `charges.output_intervals`
  - deterministic output across repeated runs
  - deep-frozen inputs
  - an import allowlist check on the new module
- **A2.** Regression: the existing `test/qr2-coverage.test.js`, `test/qr2-coverage-snapshot.test.js`, `test/qr2-coverage-limits.test.js` and `test/qr2-coverage-reader.test.js` pass unchanged. They use query fakes only; no database starts.
- **A3.** An independent tester oracle, kept in an ignored directory, compares every projected coverage object with the Stage 1 `buildBarCoverage` result for an explicit array slice. The comparison runs over seeded random registries built through `buildCoverageSnapshot`. The oracle also recomputes the owner mapping from `context.accounts`.
- **A4.** Independent architecture review covers:
  - shape freeze against the estimator skeleton
  - ID determinism
  - the byte rules and error codes
  - the refused-member rule
  - no array copies
  - the import allowlist
- **A5.** The diff touches only the two owned files, plus root documents.
- **A6.** After root's serial commit and push to the permitted branch `codex/app3a-market-wait-checkpoint-gwylmk`, exact-revision Safety checks and Quant Lab pass. Root inspects actual job and step results and infers no test counts.

Counts from separate checks are not added together. Functional acceptance of this pure seam is not performance acceptance. The Stage 3 public envelope cost on the real compute path stays unmeasured (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:90).

## Exclusions

This slice makes none of the following:

- edits to `qr2-response.js`, `qr2-owner-response.js`, the compute worker or pool, readers, routes, authentication, `public/` assets, i18n, schema, migrations or existing tests
- new public keys or counters. Coverage budgets stay separate from reader limits and the closed owner count schema (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:25).
- any PostgreSQL started locally, the local Windows functional packet, C3 diagnostic or combined measurement, native compilation or process fixtures
- target or host contact, VPS work, deployment, route activation, shared or target migration, Live, guard reset, Best Inputs apply or backfill
- production budget selection. That remains a separate root/owner decision after combined checks (QR2_S5_4_STAGE2C_INTEGRATION_PACKET_2026-10-23.md:86).

## Reviewer panel

Coverage feeds a future public financial response, so this slice is treated as high-risk logic.

| Role | Model / effort |
| --- | --- |
| Coder | Sonnet 5.5 / high |
| Tester (independent oracle, A3) | Sonnet 5.5 / medium |
| Architecture auditor (A4) | Opus 5.5 / high |

Fable is paused by the owner, and this is not a host or GO packet, so there is no Fable second opinion. A fix round re-verifies only the changed files, with one rerun of A1 and A2. Root alone accepts.

## Stop conditions

The coder stops and returns to root on any of:

- ambiguous shape or ordering semantics
- a needed change outside the owned paths
- a mismatch with the Stage 1 oracle
- an actual serialized size above the estimator bound
- a need to copy union arrays
- any import outside the allowlist
- any failing regression test

Original failures are preserved. No child dispatch, Git, browser or host work is allowed. Usage follows the AGENTS.md bands with the 3% reserve, as one short checkpointable wave.

## Root rulings, 2026-10-24

The packet author raised six questions. Root rules as follows before implementation:

1. **Mapping shape.** Keep the estimator's shape: `coverage_ids` is an array holding exactly one ID. A scalar field would change the byte estimator and is out of scope.
2. **Double validation.** The module calls `validateCoverageSnapshot` itself, so it fails closed when used alone. Whether wiring shares one validation pass is decided by O6.
3. **Effective byte limit seam.** The module accepts an optional lowering-only byte limit for the after-build check. The effective limit is the smaller of that value and `budgets.coverage_output_bytes`; it can never raise the budget. A value that is not a positive safe integer fails with `QR2_INPUT_INVALID`. Follow the existing lowering-only pattern in `src/portfolio/qr2-coverage-limits.js`. A1 uses this seam for the at-limit and limit-minus-one checks.
4. **Estimator defect.** An actual size above the estimate but within the effective limit fails closed with `QR2_REPORT_FAILED`, as rule 3 states, and is a stop condition for root. It is not an admission refusal.
5. **Account order.** `market_coverage.accounts` follows registry binding order (`bot_id`, then `broker`). O6 must reconcile it with the owner response's account order, as a set or by reordering.
6. **Roadmap citation.** The Roadmap line cited in the position section refers to the working copy at adoption time and may shift. The committed combined measurement packet citation is authoritative for the closed C3 runtime.

## Unchanged gates

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held; P13j held. Real authentication and target integration remain NOT RUN. Full S5, Stage 3 publication and rendering, combined performance and prototype completion remain OPEN. No deployment or target route activation.
