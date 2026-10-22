# QR-2 S5-4: complete bar-gap interval reporting

Status: **PURE STAGE 1 ACCEPTED LOCALLY; EXACT CODE CI PENDING; LATER STAGES NOT ADMITTED**. The owner's continuous local Roadmap GO of 2026-10-23 authorizes this bounded continuation. Root records the decisions below after independent source qualification, BARS reuse investigation and adversarial design review. S5-3 code CI remains a separate exact-revision item. Full S5 is not accepted.

## Required outcome and source gap

Contract section 11 requires bar gaps in the report range as intervals, without backfill or independent changes to financial values. Current `qr2-reader.js` reads predecessor bars only at valuation instants. Those sparse rows cannot prove coverage between instants. Its scalar `market_data.gap` reports table absence, not a complete interval list. New interval reporting needs a separate bounded coverage read within the existing read-only repeatable-read snapshot.

The exported `assembleGaps` in `src/postgres/market-ohlcv.js` is reusable. Its chart reader is not: chart policy clips pre-history and ends at the newest stored bar. QR-2 must preserve the resolved range and expose leading/trailing missing data. BARS endpoints are inclusive candle-open times; the QR-2 representation below uses half-open physical intervals.

This feature is complete only after the pure adapter, bounded account and owner reads, both response contracts, cost qualification and local EN/TH rendering are verified. Stage 1 is a foundation, not an account-only substitute or full-S5 closure.

## Root clarification: inspection window

Let `M = 60000` and the existing resolved range be `[F,T)`. Inspect full closed candles with open times in `[L,U)`, where `L = ceil(F/M)*M` and `U = floor(T/M)*M`. The stored close-time predicate is `L < bar_time <= U`. A candle closing exactly at aligned `T` is included. Do not anchor either bound to stored history.

When `L < U`, expose the inspected window and the nonempty partial edges `[F,L)` and `[U,T)`. When `L >= U`, expose no inspected window and exactly one excluded edge covering `[F,T)`. Null resolved ranges have neither window nor edges. This explicitly clarifies partial-boundary treatment; it is not attributed to an earlier literal contract definition. The future UI must explain that only complete candles are inspected and partial boundary candles are excluded.

The existing resolver still owns the `T <= requestTime` invariant. The pure helper accepts an already resolved range; it does not infer the current time. Price predecessor lookup, FRESH/STALE/carry rules, option M and monetary calculation remain unchanged. Stored timestamp presence is not OHLCV integrity, price freshness or ledger completeness.

## Stage 1 closed contract

The pure builder receives a resolved range, an exact supported market identity or explicit unsupported identity (`null`), and a discriminated source fact. Supported identity is exactly `{broker: "binance-global", symbol: "BTCUSDT", timeframe: "1"}`. Account broker identity remains in the existing outer scope. Never fabricate BTCUSDT coverage for an unsupported broker.

Source facts are `NOT_NEEDED`, `TABLE_ABSENT`, or `COMPLETE` with a complete ordered numeric timestamp array. The later reader must certify that COMPLETE came from a completed admitted coverage read; sparse valuation rows are ineligible. Stage 1 fixtures can supply the fact but cannot prove a database scan. Contradictory facts are rejected.

The output has exactly these keys: `version`, `source`, `market`, `resolved_range`, `inspected_window`, `excluded_edges`, `state`, `reason`, `complete`, `expected_minutes`, `stored_minutes`, `missing_minutes`, `interval_count`, `intervals`. Version is `qr2-bar-coverage-v1`; source is `pine_market_bars` as the intended source, not proof it was queried. Windows use `{from,to}`; excluded edges use `{from,to,reason:"PARTIAL_CANDLE"}`; gap intervals use `{from,to,missing_minutes}`.

Validate input shape, safe nonnegative integer bounds and market identity before this precedence:

1. Unsupported market: `UNAVAILABLE/UNSUPPORTED_MARKET`, market null, complete false, null counts and intervals. Derive intended bounds and exclusions where possible. Only NOT_NEEDED is valid.
2. Supported null resolved range: `EMPTY/RANGE_UNRESOLVED`, no window or exclusions, complete true, zero counts and empty intervals. Only NOT_NEEDED is valid.
3. Supported range without a full candle: `EMPTY/NO_FULL_CANDLES`, no window, one full-range exclusion, complete true, zero counts and empty intervals. Only NOT_NEEDED is valid.
4. Supported nonempty window with TABLE_ABSENT: `UNAVAILABLE/MARKET_DATA_TABLE_ABSENT`, complete false, null counts and intervals. Table absence is not an observed empty table.
5. Supported nonempty window with COMPLETE facts: state COMPLETE, reason null, complete true and exact counts/list. A certified empty timestamp array produces one all-missing interval. COMPLETE means the inspection completed, not that no gap exists.

Source errors never become empty history or table absence. Strict timestamp facts are safe, nonnegative, aligned, increasing, unique and inside `(L,U]`; do not coerce, round, deduplicate or silently discard invalid rows. Bigint/text decoding before Number conversion belongs to the later reader seam.

Extract BARS `assembleGaps` mechanically into `src/market-gap-intervals.js`, preserving the original export, default cap 50, inclusive endpoints and legacy truncation semantics. QR-2 validation stays outside that helper. Its adapter derives all internal gap pairs, passes capacity `internalTotal + 2`, requires no truncation, and converts each final inclusive open endpoint by adding one minute. This capacity is not an admitted runtime resource budget.

The closed validator checks exact window/exclusion derivation, state/field combinations, interval containment/alignment/order, maximal coalescence and totals. Every derived timestamp and arithmetic result must remain a safe integer, including ceil-to-minute and inclusive-end conversion; reject overflow rather than rounding. Require `previous.to < next.from`; equality is an uncoalesced gap. Expected minus stored equals missing minutes, which equals the sum of interval lengths divided by M. Structural validation does not establish source completeness.

## Admitted Stage 1 ownership and acceptance

One Astra coder may write only `src/market-gap-intervals.js`, the extraction/re-export in `src/postgres/market-ohlcv.js`, `src/portfolio/qr2-coverage.js`, `test/qr2-coverage.test.js`, and extraction regressions in `test/market-ohlcv.test.js`. Root owns this packet, evidence, current project notes, integration and acceptance. No reader, route, worker, accounting or UI behavior change is admitted in Stage 1.

Focused checks must cover aligned/unaligned boundaries, exact-to close, one-minute/mixed/all/no gaps, null and short ranges, unsupported precedence, absent table versus no rows, contradictory facts, unsafe/off-grid/duplicate/unsorted/out-of-window timestamps, adjacent intervals, more than 50 complete gaps, and unchanged BARS default/explicit caps. Independently review the adapter and extraction. No numerical resource cap is introduced or certified by these tests.

Stop on ambiguous semantics, changes outside owned paths, BARS behavior drift or an inadequate source contract. Return evidence to root; no child dispatch, Git or browser work. Use a short checkpointable wave after fresh usage, preserving the 3% reserve.

## Later stages: required, not yet admitted

Stage 2 adds bounded account and owner coverage reads and local cost evidence. Group the same market's overlapping or touching windows in one snapshot; read each disjoint union once. Charge unique materialized timestamps once, but separately bound window derivation, interval amplification, structured-clone input and serialized output. Do not copy one large array into every member snapshot.

Use ordered parameterized timestamp reads with `LIMIT remainingBudget + 1`; exact-budget results are valid only after that query completes with no extra row. With zero remaining budget, another window still needs a one-row probe or an explicit whole-request refusal. A later failure cannot leave partially successful coverage. LIMIT alone does not prove scan cost: qualify indexed access, sparse/empty long spans and aggregate work with isolated synthetic local measurements before selecting budgets. The worker deadline begins after SQL and does not cover the read.

Exceeding a coverage budget must take the existing whole-request `QR2_RANGE_ADMISSION_REFUSED` path. Never silently shorten an authorized range, truncate a successful interval list or claim a resource-limited scan is complete. Malformed facts and query errors fail through existing report/input failure handling. Missing bars alone do not refuse a request. Existing ledger/grid/audit/pending limits and worker guards remain unchanged.

Stage 3 publishes account coverage and owner `market_coverage:{version,entries,accounts}` with version `qr2-owner-bar-coverage-v1`. Build each unique coverage entry once, avoiding repeated member composer work. Deduplicate equal market/range values; use deterministic broker/symbol/timeframe then numeric-range ordering with null ranges first. IDs are `coverage:0`, `coverage:1`, and so on. Each included `(bot_id,broker)` maps to exactly one coverage ID under current scope; zero accounts gives empty entries and mappings. Reject unresolved, duplicate or orphan references and mismatches with the existing account list.

For an independently refused ledger member, coverage may be attached only when independently obtained from that admitted account's qualified coverage read. Never infer COMPLETE from a refused member summary. If valid coverage cannot be obtained, retain whole-request failure rather than fabricate coverage. Coverage budget/source failures publish no successful owner object. Exact byte limits must be enforced before unsafe allocation, then checked against actual UTF-8 serialization.

Both response validators and EN/TH UI must distinguish completed inspection with gaps, no gaps in the inspected domain, empty inspection and unavailable inspection. Verify owner sharing, snapshot consistency, cap boundaries, option-M late arrival, and numerical noninterference for gaps away from valuation points. Root controls local synthetic desktop/mobile rendering. These later stages need exact packets and independent acceptance; their numerical budgets are not set by this document.

## Unchanged gates

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared/target migration, host/VPS work, Live, guard reset, Best Inputs apply or backfill. Real authentication and target integration remain NOT RUN. No prototype completion or new numerical progress claim follows from this design.

## Pure Stage 1 local outcome

Root accepts only the pure foundation after 51/51 focused Node tests, 442/442 independent oracle/schema/compatibility checks and independent architecture review. The separate check counts are not additive. [Evidence](evidence/PM1_QR2_S5_4_STAGE1_LOCAL_2026-10-23.json) records source pins, raw logs and unrun integration work. The original BARS export and cap behavior remain compatible. No reader, route, worker, response or UI is wired to the new module. Exact code CI remains pending. Next is a bounded local measurement/admission packet for Stage 2; numerical budgets and DB execution still require that admission. Full S5 remains open.
