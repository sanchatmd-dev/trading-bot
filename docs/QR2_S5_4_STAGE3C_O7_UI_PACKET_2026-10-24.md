# QR-2 S5-4 Stage 3C (O7): EN/TH coverage rendering and local rendered check

Status: **PREPARED; ROOT RULINGS RECORDED; PART A AND B2-B5 ADMITTED UNDER THE CONTINUOUS LOCAL GRANT; B1 HELD FOR OWNER GO; NOT IMPLEMENTED**. No implementation, test run, rendered check or acceptance has happened. Spot/Paper only. No deployment, route activation, target contact or production budget selection.

Review history: revision r1 was reviewed by an Opus 5.5 / high architecture auditor (FIXES_REQUIRED: 1 P1, 6 P2, 12 P3, ignored `.qa-local/claude-root-2026-10-24/qr2-o7/packet-review-r1.md`); revision r2 applied all of them. Revision r2 was re-reviewed by an independent Opus 5.5 / high architecture auditor (FIXES_REQUIRED: 0 P1, 2 P2, 8 P3, ignored `.qa-local/claude-root-2026-10-24/qr2-o7/packet-review-r2.md`); revision r3 applies both P2 findings and all eight P3 findings and records root's rulings R1 to R6. No finding was rejected. Where a finding offered a choice, r3 picks: for P3-8, the em dash assertion at test/qr2-performance-ui.test.js:160 is scoped to the report text outside the coverage section, because a C1 or C2 block also shows an em dash for its null `reason`, so C1 or C2 fixture coverage alone cannot keep that assertion meaningful. **The narrow re-check of revision r3 returned READY_FOR_IMPLEMENTATION with four wording items, which root applied (see Open questions).**

## Root rulings

Root's words, 24 October 2026 (Bangkok):

- **R1 Authority:** Option 2. Part A and the test-only or comment-only carry items B2-B5 are admitted under the owner's continuous local work grant: they consume fields O6 already publishes and change no server response validator or public contract. B1 (conditional mandatory market_coverage in validateOwnerResponse) is held for an explicit owner GO naming "QR-2 O7 B1"; keep the B1-only suggested GO line. Until B1 lands, an absent owner market_coverage shows the 'not supplied' notice (open question 4 answered for Option 2).
- **R2** The rendered check proceeds with the RC-Q35/36 event-loop bars deferred to C3 (amends O6 ruling 12 for the rendered check only); the T1 whole validateOwnerResponse timing observation and the A5 translateUI timing stay in O7.
- **R3 Time display:** every epoch-millisecond value shows the raw integer followed by its UTC ISO-8601 string from Date.prototype.toISOString (no locale, no time zone other than UTC, no relative time). Add the exact EN wording to the label table.
- **R4** The interval list is open by default when it has 10 or fewer intervals.
- **R5** A serialized mutation pass (Sonnet tester, after the tester and auditor, never in parallel with a test-running reviewer) covers the render class mapping, the client coverage check and the i18n collision test.
- **R6** The reader/allocation cutoff pin test is deferred to a separate backend carry packet owned by Root; Root records it in the Roadmap carry list.

These rulings answer all seven open questions of revision r2 (Q1 and Q4 by R1, Q2 by R2, Q3 by R3, Q5 by R4, Q6 by R5, Q7 by R6). The sections below apply them.

## Authority

O7 renders two public keys that O6 already publishes: `market_data.coverage` in the per-Bot body and `market_coverage` in the owner body (QR2_S5_4_STAGE3B_RESPONSE_WIRING_PACKET_2026-10-24.md, Public keys added). O7 adds no backend field, no route and no fetch change. Part B of this packet also edits two source comments and backend tests, and its held item B1 would edit one backend validator. The relevant records are:

- The owner's chat grant of 2026-10-24: the Roadmap records that the owner "granted continuous local work" (ROADMAP.md:3).
- Root's recorded interpretation of that grant: "Root adopted this slice under that authority, which covers bounded local engineering only. It does not cover the C3 or PostgreSQL runtime, target contact, or public response wiring." (QR2_S5_4_STAGE3A_PUBLIC_COVERAGE_PACKET_2026-10-24.md:3). These are root's words, not owner text.
- The same packet: "Wiring into the response validators and worker (O6) and the EN/TH UI with local rendering (O7) each need their own packet. Public response wiring is excluded from tonight's authority." (:15). It requires a packet for O7. Root's own wording there groups "Wiring into the response validators" with O6, so a change to a response validator sits close to the class root excluded. The UI itself is named separately from that class.
- The O6 GO scoped the optional rule as lasting until O7. The suggested decision the owner accepted reads in part: "with `market_coverage` optional in the owner validator until O7" (QR2_S5_4_STAGE3B_RESPONSE_WIRING_PACKET_2026-10-24.md:23). That text anticipates an O7 change but does not authorize it. The statement "O7 may make the key mandatory when it updates the fixtures" is root's ruling 2 of that packet (:169), not owner text.
- Precedent: S5-3 was a UI repair with EN/TH text, cache tokens and a root-run rendered check on the local stub. Root admitted it under the owner's continuous Roadmap authority of 2026-10-23, with no per-slice owner GO (QR2_S5_3_LOCAL_VERIFICATION_PACKET_2026-10-23.md:3, :24). S5-1, by contrast, needed an explicit owner GO because no continuous local grant existed then and it opened new UI scope (QR2_S5_1_LOCAL_UI_GO_PACKET_2026-10-22.md:3).
- AGENTS.md: "Root issues a GO only within explicit owner authority: the standing authority recorded in the active handoff and Roadmap", and "Do not infer authorization to complete every project phase unattended from this standing delegation policy."

### The conditional `market_coverage` presence rule

The O6 carry list says "make `market_coverage` mandatory in `validateOwnerResponse`". The rule is conditional, not absolute. O6 ruling 4 omits the key when the owner `resolved_range` is null, and a REFUSED owner body never carries it (QR2_S5_4_STAGE3B_RESPONSE_WIRING_PACKET_2026-10-24.md:36, :124-126). The O7 rule is therefore exactly:

- `status.status` is `REFUSED`: the key must be absent (unchanged).
- `resolved_range` is null: the key must be absent (unchanged).
- Otherwise: the key must be present and must pass the existing checks (new presence requirement).

This does not change a public contract. The O6 packet already defines the published owner body as "A non-REFUSED owner body with a non-null `resolved_range`, produced by the worker, always carries `market_coverage`" (:124). The composer attaches the key in exactly that case (src/portfolio/qr2-owner-response.js:96), and the worker post-check already fails any body that lacks it (O6 Worker wiring, step 5). The rule removes a validator looseness that O6 left on purpose until the UI fixtures were updated. Every body that the producer path can emit validates before and after the change. Only a body built outside the producer path, such as a test seam or a fake compute result, changes outcome: the owner route now answers 500 `QR2_RESPONSE_INVALID` for it instead of 200 (src/postgres/qr2-owner-route.js:43). No new field, key, code or limit is published.

### Determination (root ruling R1)

Revision r2 offered two equal options: Option 1 admitted the whole packet under the continuous local work grant; Option 2 held B1 for an explicit owner GO. Root chose **Option 2**.

- **Admitted under the continuous local work grant:** Part A and the carry items B2, B3, B4 and B5. Part A is local UI and test work that consumes fields already published under the owner's O6 GO; it matches the S5-3 precedent and is not response wiring. B2 and B3 are test-only; B4 and B5 are comment-only, with B4's scan test edit. None of them changes a server response validator or a public contract.
- **Held for an explicit owner GO:** B1, the conditional `market_coverage` presence rule in `validateOwnerResponse`. Root reads its recorded limit, which names response validators, as covering this edit. B1 is not dispatched until the owner gives a GO that names "QR-2 O7 B1". Until then `validateOwnerResponse` keeps the current optional rule; A1's test-local predicate checks the conditional presence rule on the fixtures, and acceptance of O7 records B1 as open.
- **Client check is not a response validator.** The structural coverage check in `public/paper-performance.js` (Failure handling) gates UI presentation only. It changes no server response, status code or public contract, and it is not a response validator in the sense of root's Stage 3A wording (QR2_S5_4_STAGE3A_PUBLIC_COVERAGE_PACKET_2026-10-24.md:15).
- **Absent owner key until B1 lands:** a non-REFUSED owner body with a non-null `resolved_range` and no `market_coverage` shows the "Bar coverage not supplied by this response." notice. Any later change to that UI branch after B1 lands is outside this packet and needs root's ruling together with the B1 GO.
- Every admitted effect stays local: routes stay disabled in every environment, nothing is deployed, and no PostgreSQL, C3 runtime or target is touched. Root alone performs the browser steps on a loopback stub with synthetic data.

Suggested owner decision for B1 only:

**GO QR-2 O7 B1: conditional market_coverage presence rule in validateOwnerResponse, with its tests; no other change.**

## Purpose and position

Contract section 11 requires bar gaps in the report range to be listed as intervals (QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md:493). Section 9 forbids a filled or interpolated gap and requires English and Thai text through `public/i18n.js`, with mobile and Thai checks on the local stub (:468, :470). Slice S5 is accepted only after a rendered desktop and mobile check on the local stub (:510).

O6 put coverage into both responses and hid the raw keys from the generic metadata view (public/paper-performance.js:155). The current UI therefore shows no coverage. The S5-4 design requires the UI to "distinguish completed inspection with gaps, no gaps in the inspected domain, empty inspection and unavailable inspection" and to explain "that only complete candles are inspected and partial boundary candles are excluded" (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:63, :17). O6 also requires O7 to explain the valuation scalars beside the coverage (QR2_S5_4_STAGE3B_RESPONSE_WIRING_PACKET_2026-10-24.md:110).

O7 delivers that rendering and the local rendered evidence. O7 earns no PM-1 credit by itself. Local S5 acceptance stays a separate root decision after the traceability review (QR2_S5_3_LOCAL_VERIFICATION_PACKET_2026-10-23.md:33). Combined performance (C3) stays open.

## Ownership

One coder (Sonnet 5.5 / high) does Part A and then the admitted Part B items B2 to B5, in that order, with a root checkpoint between them. Only B1 depends on the Part A fixtures; B2 to B5 are independent of them. They stay with the same coder in sequence to keep one writer per file and a small wave. B1 is not dispatched under this admission; after an owner GO that names "QR-2 O7 B1", root dispatches it as its own serial step on the same owned paths. One writer per file.

### Part A: UI

| Path | Change |
| --- | --- |
| `public/paper-performance.js` | Coverage render model and DOM for the per-Bot and owner sections. The generic metadata exclusion stays. No fetch, query or request change. |
| `public/paper-performance.css` | Layout rules for the coverage section only, under `#paperPerformance`. Only if needed. |
| `public/i18n.js` | New EN/TH pairs for the fixed coverage labels only, in one new named array `const qr2CoveragePairs=[...]` declared after the QR-2 `uiPairs.push(...)` block (public/i18n.js:875-906) and added with `uiPairs.push(...qr2CoveragePairs);` before the `uiTranslations` loop at :907, under the key rules in EN/TH text. Existing pairs are reused, never redefined, and never copied into `qr2CoveragePairs`. |
| `public/index.html` | Cache tokens only: `paper-performance.js?v=qr2o6` becomes `?v=qr2o7`; `i18n.js?v=qr2s53` becomes `?v=qr2o7`; `paper-performance.css?v=qr2s52` becomes `?v=qr2o7` only if the CSS changes. |
| `test/asset-cache-tokens.test.js` | The `PINNED` entries of the changed assets only: new token and new digest. |
| `test/bridge-wizard-ui.test.js`, `test/journey-ui.test.js`, `test/market-chart-ui.test.js`, `test/pf3-readiness-ui.test.js`, `test/quant-library-ui.test.js` | The `i18n.js?v=qr2s53` pin only, replaced by the new token (S5-3 precedent). |
| `test/fixtures/qr2-performance-ui/responses.json` | Add producer-built coverage to `bot`, `botPartial`, `botUnavailable`, `owner`, `ownerTHB` and `ownerUndeclared`. No other value changes. |
| `test/fixtures/qr2-performance-ui/coverage-responses.json` | New: producer-built per-Bot and owner bodies for every coverage state class (Tests, A1). |
| `test/qr2-performance-ui.test.js` | New cases A1 to A13, the named replacement A12 and the named scoping of the em dash assertion at :160 (Tests, after A13). Other existing assertions stay unchanged and must pass, including the one-currency assertion at :153 (the `ownerTHB` view contains no `USDT`). |
| an assigned ignored report directory | Author report, the EN-to-TH term table and raw local logs. |

`test/fixtures/qr2-performance-ui/symbol-responses.json` stays unchanged. Its bodies carry no coverage and exercise the "not supplied" branch.

The `ownerTHB` fixture account is `binance-th`, so its coverage entry is C5 with `market` null (src/portfolio/qr2-coverage.js:48). No fixed coverage label contains a currency, symbol or market token such as `USDT`, `THB` or `BTCUSDT`, so the :153 assertion holds without change. Raw market values appear only for `binance-global` coverage, which never occurs in a THB view.

### Part B: assigned O6 carry items

| Path | Change |
| --- | --- |
| `src/portfolio/qr2-owner-response.js` | **Held (R1).** B1 only, after the owner GO that names "QR-2 O7 B1": the conditional presence rule in `ownerCoverageOk`, and its two-line comment (:18-19) updated. Nothing else. Read-only until that GO. |
| `src/portfolio/qr2-coverage-public.js` | B4: the stale comment at :56 only. No code change. |
| `src/postgres/qr2-compute-worker.js` | B5: the header comment (:9-13) and the `executeQr2Job` JSDoc (:82-86) only. No code change. |
| `test/qr2-owner-response.test.js` | New case B2 now; new case B1 only under the B1 GO. Existing assertions stay unchanged. |
| `test/qr2-compute-pool.test.js` | New case B3. Existing assertions stay unchanged. |
| `test/qr2-coverage-public.test.js` | B4: the strip clause at :420 only. The 28 Stage 3A tests, the forbidden-word pattern and the scans at :418, :419 and :421 stay unchanged. |

Root owns this packet, the evidence record, the rendered-check harness and its observations under ignored `.qa-local/qr2-o7/`, the traceability record, the Roadmap and Time Management notes, README and Context review, integration, Git and acceptance.

### Read-only for every role

- every other file under `public/` and `src/`, including `src/portfolio/qr2-response.js`, `src/portfolio/qr2-labels.js`, `src/portfolio/qr2-coverage.js`, `src/portfolio/qr2-coverage-snapshot.js`, `src/portfolio/qr2-coverage-limits.js`, `src/market-gap-intervals.js`, the compute pool, readers and routes
- `test/fixtures/qr2-performance-ui/symbol-responses.json`
- every PostgreSQL test under `test/postgres/`
- schema, migrations, authentication, server flags and every other test

## Rendering contract

### Inputs and presence

The UI reads only `body.market_data.coverage` (per-Bot) and `body.market_coverage` (owner) from the response it already fetches. It sends no new request and changes no query parameter. The GET list a test observes is the same as today.

| Body | Coverage key | UI output |
| --- | --- | --- |
| REFUSED, any scope | ignored | Existing refusal message only. No coverage section and no coverage check (unchanged early return, public/paper-performance.js:246). |
| Per-Bot, not REFUSED, key present | `market_data.coverage` | Per-Bot coverage section. |
| Per-Bot, not REFUSED, key absent | none | Section with the notice "Bar coverage not supplied by this response." |
| Owner, `resolved_range` null, key absent | none | Section with the notice "No bar coverage: the report range is unresolved." |
| Owner, `resolved_range` not null, key present | `market_coverage` | Owner coverage section. |
| Owner, `resolved_range` not null, key absent | none | Section with the notice "Bar coverage not supplied by this response." |
| Owner, `resolved_range` null, key present | invalid | Whole report fails closed (see Failure handling). |

The "not supplied" branches keep older bodies and the symbol fixtures renderable. They never invent a state. A REFUSED body never reaches the coverage check, so coverage keys on it are neither rendered nor rejected by the UI; the server validator remains the authority for that case.

### Coverage state classes

The frozen `qr2-bar-coverage-v1` shape has exactly three `state` values: `COMPLETE`, `EMPTY` and `UNAVAILABLE` (src/portfolio/qr2-coverage.js:48-55, :70, :84; QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:29-35). It has no `PARTIAL` state. The report-level statuses `COMPLETE`, `PARTIAL` and `UNAVAILABLE` (contract section 10) are a different field and keep their existing rendering. Coverage `COMPLETE` means the inspection completed, not that no gap exists (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:35). The UI never shows coverage `COMPLETE` with the bare label "Complete".

The render model maps each coverage object to exactly one class. The raw `state` and `reason` codes are always shown beside the label as raw text.

| Class | `state` / `reason` | Extra condition | EN label |
| --- | --- | --- | --- |
| C1 | `COMPLETE` / null | `interval_count` greater than 0 | Inspection completed; gaps found. |
| C2 | `COMPLETE` / null | `interval_count` equal to 0 | Inspection completed; no stored candle is missing from the inspected window. |
| C3 | `EMPTY` / `RANGE_UNRESOLVED` | none | No inspection: the range for this coverage is unresolved. |
| C4 | `EMPTY` / `NO_FULL_CANDLES` | none | No inspection: the range holds no complete 1-minute candle. |
| C5 | `UNAVAILABLE` / `UNSUPPORTED_MARKET` | none | Inspection unavailable: bar coverage is reported only for the one supported Binance Global spot 1-minute market. |
| C6 | `UNAVAILABLE` / `MARKET_DATA_TABLE_ABSENT` | none | Inspection unavailable: the market data table is absent. This is not stored history with no bars. |

Any other combination fails closed. The class decision uses comparisons only, never arithmetic.

The C3 label does not refer to the report range. Member ranges can differ (src/postgres/qr2-owner-reader.js:59). A C3 entry under a resolved owner range is not produced by the owner reader, which admits only Bots created before the range end (:45), but such an entry passes the producers and validators (`projectPublicCoverage`, `validateOwnerResponse`), so the UI handles it. The fixture records that entry as producer-only.

### One coverage block

Each coverage section is one `section` element with the class `pp-coverage`; a report holds at most one. Tests scope "inside" and "outside the coverage section" by that element.

Each coverage object renders as one block with these rows, in this order. Labels are fixed text through `label()`, with the exact EN text of the label table (EN/TH text, IDs in brackets). Values are server values through `raw()`, so `translateUI` never rewrites them. An epoch-millisecond value is shown in the time form of Number and time formatting.

1. Row label "Inspection result" [L2], then the class label [K1 to K6], then sub-label "State code" [L3] with raw `state` and sub-label "Reason code" [L4] with raw `reason` (an em dash when `reason` is null).
2. Row label "Market" [R1], then sub-labels "Broker" [R2], "Symbol" [R3] and "Timeframe (minutes)" [L5], each with the raw `broker`, `symbol` or `timeframe` string. When `market` is null (C5), the row shows the row label and one em dash instead of the sub-labels; the class label in row 1 gives the reason.
3. Row label "Coverage range" [L6], then sub-labels "From" [R4] and "To" [R5] with `resolved_range.from` and `resolved_range.to`, or one em dash when `resolved_range` is null. This row lets two entries for the same market be told apart by their ranges.
4. Row label "Inspected window" [L7], then "From" [R4] and "To" [R5] with `inspected_window.from` and `inspected_window.to`, or one em dash when null.
5. Row label "Excluded partial candles" [L8], then one item per `excluded_edges` entry with "From" [R4], "To" [R5] and "Reason" [R6] and the raw `from`, `to` and `reason`, or the existing "None" label [R7] when the array is empty.
6. Four count rows, labelled "Expected minutes" [L9], "Stored minutes" [L10], "Missing minutes" [L11] and "Gap intervals" [L12], with the raw integers `expected_minutes`, `stored_minutes`, `missing_minutes` and `interval_count`. A null count shows an em dash followed by the raw `reason`, as contract section 9 requires for nulls.
7. Gap interval list (C1 only): see Interval list.

The block never shows `version`, `source`, an entry ID such as `coverage:0`, or the owner envelope version. The `source` value names the intended table, not proof of a query (QR2_S5_4_GAP_INTERVAL_PACKET_2026-10-23.md:27), so the UI does not present it.

### Section notices

Every coverage section (per-Bot and owner, including the "not supplied" and null-range branches) carries the fixed notices N1 to N5 of the label table once, at the top of the section, in that order, never repeated per block. Their sources: N1 contract sections 9 and 11; N2 O6 packet :110; N3 and N4 the S5-4 design (:17); N5 root ruling R3. The owner section adds N6 once, after N5. The branch notices N7 ("not supplied") and N8 (null owner range) follow the section notices when their branch applies (Inputs and presence).

### Per-Bot section

The heading L1, the section notices, and one coverage block for `market_data.coverage`. It sits after the metrics grid and before the "Server status, methods and range evidence" details element.

### Owner section

The heading L1, the section notices, then one coverage block per `market_coverage.entries` item, in server order. Under each block, the row "Accounts using this coverage" [L15] lists every `market_coverage.accounts` row whose single `coverage_ids` item equals that entry's `id`, one item per account with sub-labels "Bot" [R8] and "Broker" [R2] and the raw `bot_id` and `broker` text, in server order. The UI resolves IDs with an exact string lookup only. It does not sort, merge, count across entries or derive any total. `NO_ACCOUNT` rows in `body.accounts` get no coverage row.

The UI does not check that a per-Bot or owner market agrees with the account broker. The server producers and validators are the authority for that pairing. The existing test at test/qr2-performance-ui.test.js:328 clones `fixture.bot` into THB brokers; once `fixture.bot` carries supported-market coverage, that case renders a `binance-global` market under a THB broker, and that is expected UI behavior, not a defect. The case stays unchanged.

### Interval list

- Render every interval. Never truncate, sample or summarize the list. The server caps the list at 4096 intervals per body (QR2_COVERAGE_LIMITS.output_intervals, src/portfolio/qr2-coverage-limits.js:4).
- Put the list in a `details` element whose `summary` holds the label "Gap interval list, count:" [L13] followed by the raw `interval_count`. The element is open by default when `interval_count` is 10 or fewer and closed otherwise (root ruling R4). A closed list is still fully present in the DOM.
- Each interval is one list item holding exactly one `raw()` text node with the exact form `String(from) + ' (' + new Date(from).toISOString() + ') - ' + String(to) + ' (' + new Date(to).toISOString() + ') : ' + String(missing_minutes)`, for example `1790812800000 (2026-10-01T00:00:00.000Z) - 1790812860000 (2026-10-01T00:01:00.000Z) : 1`. No other element or text node sits inside the item. This keeps the 4096-item list at one text node per interval for `translateUI`, which walks every body text node on each DOM mutation (public/i18n.js:912-934, :949) while the overview ticker mutates the page every second (public/overview.js:186).
- One fixed caption [L14] above the list states the row form: "Each row: start - end : missing minutes. Start inclusive, end exclusive." The time form is stated once by the section notice N5.

### Number and time formatting

The existing UI shows server integers and decimal strings verbatim: range endpoints, `as_of` and `price_bar_time` appear as raw epoch milliseconds (public/paper-performance.js:18-23, :133-134). O7 keeps that rule for counts: integers are shown with `String(value)`, with no locale formatting, no thousands separator, no percentage and no derived duration. Null shows an em dash.

Time form (root ruling R3; root confirmed on 24 October 2026 that R3 applies to the coverage section only, and that the client check bounds every shown epoch-millisecond value to an absolute value of at most 8640000000000000 so `toISOString` cannot throw). Every epoch-millisecond value in the coverage section (the `from` and `to` of `resolved_range`, `inspected_window`, each `excluded_edges` item and each interval) is shown as the raw integer followed by its UTC ISO-8601 string from `Date.prototype.toISOString`: one `raw()` text node `String(value) + ' (' + new Date(value).toISOString() + ')'`, for example `1790812800000 (2026-10-01T00:00:00.000Z)`. The interval item embeds the same form (Interval list). No locale method, no time zone other than UTC and no relative time is used. The ISO string is a presentation of the same instant and is not client arithmetic on coverage. The section notice N5 states the form once in EN and TH. The existing non-coverage values (`as_of`, `price_bar_time` and the report range header) keep their current rendering in O7, because changing them would change existing assertions that this packet does not name.

### EN/TH text

#### Label table (the only EN source)

This table is the only source of fixed EN text for O7. It covers every heading, row label, sub-label, summary, caption and notice in the coverage section. The coder renders exactly these EN texts through `label()`. The tester's oracle and test A13 take EN text only from this table, never from the implementation. New entries go into `qr2CoveragePairs`; reused entries keep their existing pair and are not copied. No EN or TH text in this table contains an em dash, a currency, a symbol or a market token such as `USDT`, `THB` or `BTCUSDT`.

| ID | Use | Exact EN text | Pair |
| --- | --- | --- | --- |
| L1 | Section heading, per-Bot and owner | Market bar coverage | new |
| N1 | Section notice 1 | Bar gaps are listed as the server reports them. No gap is filled or interpolated. Only a gap at a needed valuation point changes a number. | new |
| N2 | Section notice 2 | The valuation check (market_data.checked and market_data.gap) covers only the bars needed at valuation points. Bar coverage covers every complete 1-minute candle in the range. The two can differ. | new |
| N3 | Section notice 3 | Only complete 1-minute candles are inspected. Partial candles at the range edges are excluded. | new |
| N4 | Section notice 4 | Inspection completed means every 1-minute slot in the inspected window was checked for a stored candle. Partial edge candles are outside this check. | new |
| N5 | Section notice 5, time form (R3) | Each time is shown as UTC epoch milliseconds followed by the same instant in ISO 8601 UTC in parentheses. | new |
| N6 | Owner section notice | Coverage is shown per market and range. Accounts with the same market and range share one coverage entry. Coverage is never summed across accounts. | new |
| N7 | Branch notice, key absent | Bar coverage not supplied by this response. | new |
| N8 | Branch notice, owner range null | No bar coverage: the report range is unresolved. | new |
| K1 | Class label C1 | Inspection completed; gaps found. | new |
| K2 | Class label C2 | Inspection completed; no stored candle is missing from the inspected window. | new |
| K3 | Class label C3 | No inspection: the range for this coverage is unresolved. | new |
| K4 | Class label C4 | No inspection: the range holds no complete 1-minute candle. | new |
| K5 | Class label C5 | Inspection unavailable: bar coverage is reported only for the one supported Binance Global spot 1-minute market. | new |
| K6 | Class label C6 | Inspection unavailable: the market data table is absent. This is not stored history with no bars. | new |
| L2 | Row 1 label | Inspection result | new |
| L3 | Row 1 sub-label for raw `state` | State code | new |
| L4 | Row 1 sub-label for raw `reason` | Reason code | new |
| R1 | Row 2 label | Market | reused, public/i18n.js:554 |
| R2 | Row 2 sub-label; owner account sub-label | Broker | reused, public/i18n.js:17 |
| R3 | Row 2 sub-label | Symbol | reused, public/i18n.js:10 |
| L5 | Row 2 sub-label | Timeframe (minutes) | new |
| L6 | Row 3 label | Coverage range | new |
| R4 | Rows 3, 4 and 5 sub-label | From | reused, public/i18n.js:62 |
| R5 | Rows 3, 4 and 5 sub-label | To | reused, public/i18n.js:62 |
| L7 | Row 4 label | Inspected window | new |
| L8 | Row 5 label | Excluded partial candles | new |
| R6 | Row 5 sub-label for an edge reason | Reason | reused, public/i18n.js:236 |
| R7 | Row 5 value for an empty array | None | reused, public/i18n.js:224 |
| L9 | Row 6 count label | Expected minutes | new |
| L10 | Row 6 count label | Stored minutes | new |
| L11 | Row 6 count label | Missing minutes | new |
| L12 | Row 6 count label | Gap intervals | new |
| L13 | Interval list `summary`, before the raw count | Gap interval list, count: | new |
| L14 | Interval list caption | Each row: start - end : missing minutes. Start inclusive, end exclusive. | new |
| L15 | Owner row under each block | Accounts using this coverage | new |
| R8 | Owner account sub-label | Bot | reused, public/i18n.js:715 |

The Inputs and presence table and the class table repeat some of these texts for reading; where they differ, this table wins. Raw values (codes, identifiers, integers and the time form) are never labels and never enter `uiPairs`.

#### Thai text rules

The coder writes the Thai text for the new entries under these rules:

- **Term table first.** Before writing any Thai string, the coder writes an EN-to-TH term table in the author report covering at least: coverage, inspection, inspected window, gap interval, complete candle, partial candle, inclusive, exclusive, epoch milliseconds, ISO 8601 UTC, never summed, unresolved and market data table. The table reuses the existing glossary terms in `public/i18n.js`, including the exclusive-end wording at :883, and keeps Paper, Bot and UTC in Latin script as the existing pairs do.
- **Reuse, never redefine.** `uiTranslations` is one global map keyed by both EN and TH text, in which the last set wins (public/i18n.js:907). A label marked "reused" in the label table keeps its existing pair and adds no entry. Every entry in `qr2CoveragePairs` has an EN text and a TH text that both differ from every EN text and every TH text of every other `uiPairs` entry, in both directions (a new EN must not equal an existing TH, and a new TH must not equal an existing EN). This is the rule that test A13 and the existing collision tests enforce.
- **Raw stays raw.** Raw codes, identifiers, integers and the time form stay untranslated in both languages.
- **Listed and checked.** The author report and the evidence record list every new Thai string beside its EN text. The tester checks each Thai string against the EN meaning, term-table consistency, and every negation ("no stored candle is missing", "not stored history", "never summed", "No gap is filled") and the inclusive/exclusive wording. Root reads the list before Part B starts.
- A language toggle after rendering swaps the labels without a new request.

### Safe text rendering

Coverage DOM is built only with `document.createElement`, `textContent` (through the existing `label()` and `raw()` helpers) and `append`/`replaceChildren`. No `innerHTML`, `outerHTML`, `insertAdjacentHTML`, `document.write`, `eval`, `Function` or attribute built from a server value. `bot_id` and `broker` are server strings and may contain markup characters; they render as text. A `bot_id` can be long (up to about 87,000 characters, src/portfolio/qr2-coverage-snapshot.js:43); it wraps inside `#ppResult`, which already sets `overflow-wrap:anywhere`.

### Failure handling

The UI runs a light structural check on the coverage keys before rendering. The check runs after the REFUSED early return (public/paper-performance.js:246) and after the `validNumbers` check (:250), and before the `/api/me` book request. It fails closed with the existing "Paper performance response unavailable." message and `QR2_RESPONSE_INVALID`, the same branch as a scope mismatch (public/paper-performance.js:243-244). A failed check issues no `/api/me` GET. The check gates UI presentation only: it changes no server response, status code or public contract and is not a response validator in the sense of root's Stage 3A wording (Authority, Determination). The check covers every field that the render dereferences, so no malformed coverage reaches the generic "Retry manually" branch:

- coverage `version` equals `qr2-bar-coverage-v1`, and the owner envelope `version` equals `qr2-owner-bar-coverage-v1`
- `market` is null or an object whose `broker`, `symbol` and `timeframe` are strings
- `resolved_range` and `inspected_window` are each null or an object with integer `from` and `to`
- `excluded_edges` is an array, and each item has integer `from` and `to` and a string `reason`
- the `state` and `reason` pair is one of the six classes
- the counts and `intervals` match the class exactly, per the table below
- each interval item has integer `from`, `to` and `missing_minutes`
- every epoch-millisecond value that the block shows (the `from` and `to` of `resolved_range`, `inspected_window`, each `excluded_edges` item and each interval) has an absolute value of at most 8640000000000000, so `toISOString` cannot throw
- owner `entries` and `accounts` are arrays; each entry `id` equals `'coverage:' + index` for its position in `entries`; each account has exactly one `coverage_ids` item that resolves to an entry `id`; every entry is referenced; no two accounts share the same `bot_id` and `broker` pair
- the owner key is absent when `resolved_range` is null

| Class | `expected_minutes`, `stored_minutes`, `missing_minutes` | `interval_count` | `intervals` |
| --- | --- | --- | --- |
| C1 | safe non-negative integers | safe integer greater than 0 | array whose length equals `interval_count` |
| C2 | safe non-negative integers | 0 | empty array |
| C3, C4 | each 0 | 0 | empty array |
| C5, C6 | each null | null | null |

This table follows the producer (src/portfolio/qr2-coverage.js:53-55, :82). The server validators remain the authority. The UI check repeats no count identity, minute arithmetic or ordering proof. A failed check leaves no earlier report on screen (existing `invalidate` and replace behavior).

### Unchanged behavior

- The generic metadata view keeps excluding `market_coverage` and `market_data.coverage` (public/paper-performance.js:155), so raw coverage never appears twice.
- `validNumbers`, `ownerAggregateAllowed`, `bookValue`, stale-response suppression, the book request and every financial number stay unchanged.
- The response body is never mutated.

## Part B: assigned O6 carry items

| O6 carry item | Assignment |
| --- | --- |
| Make `market_coverage` mandatory in `validateOwnerResponse` with the UI fixtures (ruling 2) | **B1, held for an owner GO (R1).** Conditional as defined in the Authority section. Runs only after an explicit owner GO that names "QR-2 O7 B1", and only after the Part A fixtures validate under the new rule. Until then the UI shows the "not supplied" notice for an absent owner key. |
| Add a test that composes an owner response from a passed-in envelope with the snapshot coverage removed | **B2** in `test/qr2-owner-response.test.js`: delete `snapshot.coverage`, pass the precomputed envelope as the `coverage` option, and assert success and equality with the direct call. A missing registry would throw if the composer projected again, so success proves the single-validation path. |
| Add a worker-level null-range owner case with admitted members | **B3** in `test/qr2-compute-pool.test.js`: `executeQr2Job` on an owner snapshot with a null resolved range and at least one admitted member returns `ok:true`, the body has no `market_coverage`, and the projection still ran (a corrupt registry in the same shape gives `kind:'other'`). |
| Update the stale comment in `src/portfolio/qr2-coverage-public.js` with its Stage 3A scan test (ruling 9) | **B4**. The sentence "Unwired: no worker, route or UI imports it." in the JSDoc at :56 is replaced by exactly "Used by the compute worker and the owner response composer.", so the line reads "Pure projection of a Stage 2 registry into the public coverage shapes. Used by the compute worker and the owner response composer." The rest of that JSDoc stays. The same file is scanned with comments included by four assertions in test/qr2-coverage-public.test.js: :418 counts `\bimport\b` (a comment word "import" fails it), :419 forbids `import(`, `require(`, `process`, `fs`, `child_process`, `worker_threads` and `fetch`, :420 forbids `postgres`, `pg`, `db.js`, `store`, `server`, `route` or `routes` and `dispatcher` (case-insensitive), and :421 forbids `.slice(`, `.sort(`, `.concat(`, `.splice(`, `structuredClone`, `Array.from` and `[...`. The new comment must pass all four. The strip clause `source.replace(/^.*Unwired.*$/gm,'')` at :420 is removed, so the :420 scan covers the whole file. The forbidden patterns themselves stay unchanged. |
| Update the header and `kind:'qr2'` JSDoc of `src/postgres/qr2-compute-worker.js` | **B5**, comment-only. The header names the coverage modules among the pure imports. The JSDoc states that `kind:'qr2'` also carries the post-build coverage refusal `QR2_RANGE_ADMISSION_REFUSED` with no detail. The comments must not contain the text `validateCoverageSnapshot(`, `projectPublicCoverage(` or `projectPublicCoverageOutcome(`, because test/qr2-compute-pool.test.js counts those call sites in the worker source. No comment line may start with `import` or `export ... from`, or contain `import(`, because the import-graph scanners in test/qr2-compute-pool.test.js:491-494, test/mp-package-store-static-isolation.test.js:177 and test/mp-run-store-static-isolation.test.js:152 read comments too. |
| Pin the agreement between the reader's admission cutoff and the allocation cutoff with a test | **Deferred (R6)** to a separate backend carry packet owned by root. It touches reader and allocation tests outside the UI package, has no user-visible effect and is not needed for the rendered check. Root records it in the Roadmap carry list so it survives handoff. |
| Record digests that do not depend on working-tree line endings | **Root**, in the O7 evidence record: Git blob IDs or SHA-256 over LF-normalized bytes, the method in test/asset-cache-tokens.test.js:44. |
| O6 ruling 12: measure the rest of `validateOwnerResponse` and the event-loop bars before any rendered check | **Split (R2).** T1 measures the whole `validateOwnerResponse` on a maximum owner body, and A5 times one `translateUI` call (observations only); both stay in O7. The RC-Q35 and RC-Q36 event-loop bars need the route under load and the closed C3 runtime; they are **deferred** to the C3 combined measurement. Root's ruling R2 amends O6 ruling 12 for the rendered check only, so the rendered check, which uses a synthetic stub and no server route, proceeds without them. |

## Tests

All local tests are pure `node:test` with JSDOM. They use no PostgreSQL, network, browser, child process or server. One sole runner, 90-second process bound per file.

### Part A (`test/qr2-performance-ui.test.js`)

- **A1. Producer-grounded fixtures.** Every coverage object in both fixture files deep-equals a fresh `buildBarCoverage` result for documented facts recorded beside it in the fixture (range, market, fact kind, timestamps or a compact gap description). Every owner envelope deep-equals `projectPublicCoverage(buildCoverageSnapshot(...), context).owner.market_coverage` for a documented registry input. Per-Bot bodies pass `validateResponse`. Owner bodies pass `validateOwnerResponse` as it stands, and also pass a test-local presence predicate that encodes the conditional rule (key absent for REFUSED or null range, present otherwise). The predicate stays while B1 is held; only B1, under its owner GO, replaces it with the real validator. Per-Bot coverage `resolved_range` equals the header range, and the market is null exactly when the broker is not `binance-global`. `coverage-responses.json` covers C1 to C6, a C1 body with leading, internal and trailing gaps, a body at the 4096-interval maximum, an owner body with several entries where one entry is shared by two accounts, an owner body with an unsupported-market entry, an owner body with a null range, an owner body whose members have different ranges for the same market and one C3 entry under a resolved owner range (recorded in the fixture as producer-only: the owner reader does not produce it), and a body whose `bot_id` is long and holds markup characters.
- **A2. Per-Bot classes, EN and TH.** For each of C1 to C6: the exact class label, raw `state` and `reason`, every row label and sub-label of the label table that the class shows, the coverage range row in the time form, raw counts or an em dash with the reason, the fixed notices N1 to N5, and the interval rows for C1.
- **A3. Owner mapping.** Entries render in server order; each entry lists exactly its accounts in server order; a shared entry renders once; the unsupported entry renders C5; the C3 entry under a resolved owner range renders the C3 label and its own coverage range; `NO_ACCOUNT` rows get no coverage row. No-sum rule, stated structurally: the coverage section contains no element with a total or sum label, and each rendered count element's text equals `String` of that entry's own raw value. The fixed notice text "never summed" and the existing `SUM_OF_INDEPENDENT_PAPER_ACCOUNTS` label do not break this rule.
- **A4. Presence branches.** Per-Bot and owner "not supplied", owner null range, and REFUSED bodies with no section, including a REFUSED body that carries coverage keys (ignored, no check, no section). The symbol fixtures render with the "not supplied" notice: the existing symbol-fixture assertions (test/qr2-performance-ui.test.js:355-415, including the whole-text checks at :405-413) pass unchanged, no new Thai coverage notice contains the TH late-price notice text those checks exclude, and the coverage section holds only the heading L1, the section notices N1 to N5 and the notice N7.
- **A5. Maximum list.** The 4096-interval body renders exactly `interval_count` list items, each with exactly one text node; the details element is closed; and no text says "more" or omits a row. Record as observations only: the JSDOM render time, and the time of one `translateUI` call over the rendered page (the harness loads `public/i18n.js`, test/qr2-performance-ui.test.js:17).
- **A6. Safe text.** Reuse the existing attack pattern (test/qr2-performance-ui.test.js:198-203: `<img src=x onerror="window.qr2Unsafe=true">`, no `img` element in `#ppResult`, `window.qr2Unsafe` undefined) for owner `bot_id` and `broker` values, in EN and TH. A source scan of `public/paper-performance.js` finds none of the sinks listed under Safe text rendering.
- **A7. Fail closed.** Each failure in Failure handling, including each row of the per-class table, a duplicate or misnumbered entry `id`, a `market` that is neither null nor three strings, a non-integer `resolved_range` or `inspected_window` endpoint, an `excluded_edges` value that is not an array or holds an item without integer `from` and `to` and a string `reason`, and an epoch-millisecond value beyond 8640000000000000 in absolute value, gives the existing unavailable message with `QR2_RESPONSE_INVALID`, no earlier report value survives, and no `/api/me` GET is issued.
- **A8. Stale responses.** A selection change during a pending request with coverage, and a late coverage response after a change, never render coverage (existing sequence rule).
- **A9. Language toggle.** After render, switching EN to TH and back swaps every coverage label, keeps raw values identical and starts no request.
- **A10. No mutation, GET only.** The input bodies are unchanged after rendering; the request list equals the list without coverage; every request is GET; a body that fails the coverage check issues no `/api/me` GET.
- **A11. Formatting.** Counts appear exactly as `String(value)`. Every epoch-millisecond value in the coverage section appears exactly as `String(value) + ' (' + new Date(value).toISOString() + ')'`, and each interval item exactly in the Interval list form. No thousands separator, locale date string, non-UTC time, relative time or percentage appears in the coverage section.
- **A12. Named replacement.** The O6 case "O6 the generic metadata view shows no raw coverage between O6 and O7 and never mutates the body" (test/qr2-performance-ui.test.js:417-445) changes as follows. Its title drops "between O6 and O7". The synthetic `coverage` object with `COVERAGE_SENTINEL_STATE` is dropped, and so is that sentinel. The Bot view renders `fixture.bot` as it stands after Part A (valid producer-built coverage). The baseline renders a clone of `fixture.bot` with `market_data.coverage` deleted, which shows the "not supplied" notice. The assertion that the Bot view text equals the baseline text (:431) becomes: on both views, the report text outside the `pp-coverage` section is equal. The owner view renders `fixture.owner` as it stands after Part A. The scalar checks (:429-430) are scoped to the "Server status, methods and range evidence" details element: each of `checked`, `table_present`, `instants`, `bars` and `gap` equals the text of a `dt` element inside it, and `market_data` equals the text of a `dt` element inside it. They no longer search the whole view, because the coverage notices contain those words. The two source-count assertions (:443-444) are replaced by a behavioral assertion that the details element contains no `coverage` or `market_coverage` key. The bans on `qr2-bar-coverage-v1`, `qr2-owner-bar-coverage-v1`, `coverage:0`, `pine_market_bars` and `market_coverage` stay over the whole Bot and owner views, and the no-mutation checks stay.
- **A13. Translation table safety.** `public/i18n.js` is loaded once in JSDOM with `window.__pairs=uiPairs;window.__mine=qr2CoveragePairs;`, the pattern of the existing collision tests (test/journey-ui.test.js:295-309, test/quant-library-ui.test.js:430-447). With `mine=[...window.__mine]` and `others=window.__pairs.filter(pair=>!window.__mine.includes(pair))`, the test asserts: no duplicate EN and no duplicate TH inside `mine`; `en!==th` for every pair in `mine`; every EN and every TH text of `mine` is absent from every EN and every TH text of `others` (both directions); the EN texts of `mine` equal exactly the set of label-table entries marked "new"; every EN text of `mine` appears as a quoted literal in `public/paper-performance.js`; and no label-table entry marked "reused" is in `mine`. It needs no base-revision read, no child process and no file outside the owned paths. The existing collision tests in test/bridge-activate-ui.test.js, test/bridge-wizard-ui.test.js, test/journey-ui.test.js, test/market-chart-ui.test.js, test/overview-ui.test.js, test/pf3-readiness-ui.test.js (both pf3 and pf4 cases), test/preflight-runner-ui.test.js and test/quant-library-ui.test.js treat `qr2CoveragePairs` as part of "others" and must pass unchanged.

The fixture validation case at :49-54 keeps its assertions. The one-currency assertion at :153 stays unchanged and passes. The cache token test passes with the new tokens and digests.

Named scoping at :160 (review r2 P3-8). The case "missing owner declaration, PARTIAL overlays and UNAVAILABLE numbers remain explicit" asserts that `p.text()` includes an em dash for `ownerUndeclared`, `botPartial` and `botUnavailable`. After Part A those fixtures carry coverage, and a coverage block can add em dashes (a null `reason` in C1 or C2, a null market or range), which would hide a missing metric dash. That one assertion changes to search the report text outside the `pp-coverage` section. Every other assertion of the case stays unchanged.

### Part B

- **B1, held (R1); runs only under the owner GO that names "QR-2 O7 B1"** (`test/qr2-owner-response.test.js`): a composed non-REFUSED owner body with a non-null range and the key deleted fails; the same body with the key passes; REFUSED and null-range bodies keep their current results; every UI owner fixture passes. In `test/qr2-performance-ui.test.js`, A1's test-local presence predicate is replaced by `validateOwnerResponse`.
- **B2** and **B3** as assigned above.
- **B4**: the Stage 3A scans at test/qr2-coverage-public.test.js:418-421 pass on the whole file with the strip clause removed.

### Timing observation

- **T1.** Whole `validateOwnerResponse` on a maximum owner body (20 accounts, 20 entries, 4096 intervals in total): median and maximum over 50 runs, recorded beside the O6 observation (median 5.2 ms, maximum 9.5 ms for `validateOwnerCoverageShape` alone). Observation only; no bar is set or claimed.

### Independent oracle (tester)

In an ignored directory, the tester builds seeded random coverage objects with `buildBarCoverage` (all six classes, random gap layouts, partial edges) and owner envelopes with `buildCoverageSnapshot` and `projectPublicCoverage`. For each, the oracle computes the expected class, the expected EN labels copied only from this packet's label table, the expected TH labels looked up from `public/i18n.js` by that EN text, the expected raw values in row order (epoch-millisecond values in the time form), the expected interval rows in the exact row form and the expected account-to-entry lists. It compares them with the JSDOM output of the real `public/paper-performance.js`. The oracle shares no code with the render model and does not take EN labels from the implementation table. The tester also checks every Thai string against its EN meaning and the term table.

### Regression

Root runs, in one sole-runner pass, every unit test that imports a changed module (found with `git grep`): at least `test/qr2-performance-ui.test.js`, `test/asset-cache-tokens.test.js`, the five cache-pin UI tests, the other UI tests with an i18n collision case (`test/bridge-activate-ui.test.js`, `test/overview-ui.test.js`, `test/preflight-runner-ui.test.js`), `test/qr2-owner-response.test.js`, `test/qr2-owner-independent.test.js`, `test/qr2-compute-pool.test.js` and `test/qr2-coverage-public.test.js`. Root then runs the full `npm test` unit suite once. Local PostgreSQL is not started. The PostgreSQL suites that call `validateOwnerResponse` (`test/postgres/qr2-owner-compute.test.mjs`, `test/postgres/qr2-coverage-integration.test.mjs`) and `test/postgres/qr2-owner-route.test.mjs` run unchanged in exact-revision CI; if any needs a change, the coder stops.

## Local rendered check (root only)

Root performs every browser step. No agent uses a browser. Under root ruling R2 the check proceeds with the RC-Q35 and RC-Q36 event-loop bars deferred to C3. The harness follows the accepted S5-3 method: the actual local shell with the candidate `public/` assets, synthetic GET fixtures served from a loopback stub, an explicit session refresh before report selection, and CSS viewport screenshots (docs/evidence/PM1_QR2_S5_3_UI_LOCAL_2026-10-23.json). Viewports are 1440 and 390 CSS pixels wide. Mobile means viewport testing, not a physical device or Safari.

Cases, from `coverage-responses.json` and the updated `responses.json`:

1. Per-Bot C1 with leading, internal and trailing gaps
2. Per-Bot C2
3. Per-Bot C5 (Binance TH)
4. Per-Bot C6
5. Per-Bot C4
6. Owner with several entries, one shared
7. Owner with a null range
8. Owner at the 4096-interval maximum, list closed and then opened
9. Owner with different member ranges and one C3 entry under a resolved owner range
10. Per-Bot "not supplied" (a symbol fixture body)
11. Owner with a long `bot_id` holding markup characters

Minimum matrix: cases 1 to 8 in EN at 1440 and in TH at 390; cases 1 and 6 also in TH at 1440 and EN at 390; cases 9, 10 and 11 in EN at 390. That is 23 captures. One language toggle is observed on case 1 and one on case 8.

Root inspects and records for each capture: the class label and raw codes, all fixed notices shown once per section, the coverage range row, each epoch-millisecond value followed by its ISO 8601 UTC string, em dashes with reasons, interval rows and the units caption, account lists, no sum across accounts, no horizontal page overflow (`scrollWidth` at most `clientWidth`), no console error, and no request outside loopback. On case 8 at 390 px, root records the observed render time and the long tasks over 10 seconds of idle and over one language toggle (Long Tasks API or performance trace). Repeated long tasks above 50 ms while case 8 sits idle are a stop to root before acceptance, not a pass. Screenshots, network and console logs stay under `.qa-local/qr2-o7/` with their digests in the evidence record.

If a capture shows a defect that needs a product change, root stops the check and records it. The coder runs a fix round on the owned paths, the reviewer panel re-reviews only the changed files with one rerun of the affected suites, and root re-captures every affected case. A defect outside the owned paths returns to root as a stop.

## Exclusions

O7 does not include:

- any backend field, key, code, counter, limit or budget; any producer change in `qr2-response.js`, the composers' attach logic, the worker code, the pool, readers or routes
- B1 until an explicit owner GO that names "QR-2 O7 B1" (R1); until then `validateOwnerResponse` stays unchanged
- a per-Bot validator presence rule; `validateResponse` stays unchanged
- any change to the rendering of the non-coverage values `as_of`, `price_bar_time` and the report range header
- a UI check that the coverage market agrees with the account broker
- any fetch, query, request or authentication change; any new endpoint
- charts, client arithmetic on coverage, interval merging, gap filling, interpolation, price repair or valuation fallback
- the deferred cutoff test and the RC-Q35 and RC-Q36 measurements
- PostgreSQL started locally, the C3 diagnostic or combined measurement, or any performance claim
- target or host contact, VPS work, deployment, route activation, shared or target migration, Live, guard reset, Best Inputs apply, declaration PUT, Bot action or backfill

## Reviewer panel

Part A is presentation logic for a financial view, and B1, when its owner GO is given, narrows a public response validator. Root treats the slice as high-risk logic.

| Role | Model / effort | Scope |
| --- | --- | --- |
| Coder | Sonnet 5.5 / high | Part A, then B2 to B5, with tests A1 to A13, B2 to B4 and T1; B1 and its tests only in the separate dispatch after the B1 owner GO |
| Tester | Sonnet 5.5 / medium | Independent render-model oracle, Thai meaning and term-table check, regression pass |
| Architecture auditor | Opus 5.5 / high | Class mapping against the frozen shapes, contract neutrality of the admitted items (and the presence rule when B1 runs), safe text rendering, no client arithmetic, no request change, translation key safety, carry-item assignments, cache-token completeness |
| Mutation tester (R5) | Sonnet 5.5 / medium | One serialized mutation pass after the tester and the auditor have returned, over the render class mapping, the client coverage check and the A13 i18n collision test |

Mutation pass (root ruling R5). The mutation tester runs alone: never in parallel with the tester, the auditor or any other agent that runs tests on the same checkout. It temporarily edits only `public/paper-performance.js` (class mapping and client coverage check) and `public/i18n.js` (for example a `qr2CoveragePairs` entry whose EN or TH text equals an existing pair's text, in each direction), records for each mutant whether a named test fails, restores each file and confirms its SHA-256 equals the pre-pass value before returning. A surviving mutant is a finding for root, not a pass. The mutation report and logs stay in the assigned ignored report directory.

Fable 5.1 is paused by the owner. Part A and B2 to B5 are admitted under the continuous local grant and get no second opinion. When B1 runs under its owner GO, a second independent Opus 5.5 / high architecture auditor substitutes for the Fable second opinion on the B1 diff, and root records the substitution. A fix round re-verifies only the changed files, with one rerun of the affected suites. The tester never runs tests in parallel with another test-running agent on the same checkout. Root alone accepts.

## Stop conditions

The coder stops and returns to root on any of:

- a needed change outside the owned paths, including any backend producer, route or the symbol fixture
- an existing assertion that must change but is not named in this packet, including the one-currency assertion at test/qr2-performance-ui.test.js:153
- a coverage state, reason or shape not covered by the six classes or the per-class count table
- a fixture that cannot be built by the producers
- any client arithmetic, sorting or aggregation that the render seems to need
- a need for a new request, query parameter or response field
- any B1 edit or B1 test before an owner GO that names "QR-2 O7 B1"
- B1, under its GO, making any producer-built body fail, or any existing owner test fail
- an existing collision test in a UI test file (the list under A13) failing
- a B4 or B5 comment that trips a scan at test/qr2-coverage-public.test.js:418-421 or the call-site count
- an existing assertion of test/qr2-performance-ui.test.js other than those named in A12 and at :160 that fails once the fixtures carry coverage
- an interval list that cannot render in full, or an interval item that needs more than one text node
- a Thai string whose meaning the coder cannot match to the EN text
- a needed fixed label whose EN text is not in the label table
- a new `qr2CoveragePairs` entry whose EN or TH text equals any EN or TH text of another `uiPairs` entry, or a reused label copied into `qr2CoveragePairs`

Original failures are preserved. No child dispatch, Git, browser or host work is allowed. Usage follows the AGENTS.md bands with the 3% reserve, as short checkpointable waves after a fresh reading: Part A, B2 to B5, review, the mutation pass, then root's rendered check. B1 is a later separate wave after its owner GO.

## Open questions for root

None. Root rulings R1 to R6 answer all seven questions of revision r2. The narrow re-check of revision r3 (Opus 5.5 / high, ignored `.qa-local/claude-root-2026-10-24/qr2-o7/packet-review-r3.md`) returned READY_FOR_IMPLEMENTATION with four wording items (0 P1, 0 P2, 4 P3), which root applied and checked by diff, including root's confirmation of the R3 scope.

## Implementation review rulings (root, 24 October 2026)

- Part A and B2-B5 were implemented under ruling R1; B1 stays held for the owner GO naming "QR-2 O7 B1".
- The first mutation pass left twelve test gaps and one hang-only kill; a test-only fix round closed all of them, and a serialized recheck killed every non-equivalent survivor by assertion. The i18n collision check (A13) now runs as a static test before any render, so a colliding pair fails by assertion; a hang that a colliding pair can still cause in an unrelated suite is accepted as a residual, because A13 blocks such a pair first.
- A per-Bot body whose `market_data` is null shows the "not supplied" notice, as the presence rule gives; it is not refused.
- A null count shows an em dash followed by a separate raw node with the reason code; root accepts this form.
- Thai wording rulings: K2 and the last sentence of N6 use the root's wording (N6 says coverage is never summed across accounts).
- The audit's wording items (A12 title, B3 comment, worker header, synthetic per-Bot header note, A9 on a per-Bot fixture) were applied in the fix round.

## Unchanged gates

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held; P13j held. Real authentication and target integration remain NOT RUN. Full S5, combined performance and prototype completion remain OPEN. No deployment or target route activation.
