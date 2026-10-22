# QR-2 S5 local UI traceability

Status: **FULL S5 OPEN**. This inventory separates existing local evidence, new S5-3 work and unresolved contract coverage. It does not establish real authentication or target acceptance.

## Evidence sources

- [S5a book-equity evidence](evidence/PM1_QR2_S5A_RENDERED_LOCAL_2026-10-22.json): local currency grouping and book labels.
- [S5-1 evidence](evidence/PM1_QR2_S5_1_UI_LOCAL_2026-10-22.json): response display, owner eligibility, session guards, notices and synthetic component/application-shell rendering.
- [S5-2 evidence](evidence/PM1_QR2_S5_2_UI_LOCAL_2026-10-22.json): separately fetched current book equity beside historical marked equity, identity checks and explicit time limitations.
- [S5-3 packet](QR2_S5_3_LOCAL_VERIFICATION_PACKET_2026-10-23.md): nonempty symbol states and the late-recorded-price notice. [S5-3 evidence](evidence/PM1_QR2_S5_3_UI_LOCAL_2026-10-23.json) records bounded local acceptance and pending exact-revision CI.

The following U1–U9 identifiers index the clauses of [contract section 9](QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md#9-ui-rules-u1-u9) in order. They do not add requirements. Historical test counts overlap and must not be summed.

| Rule | Existing evidence and remaining boundary |
| --- | --- |
| U1: No portfolio claim before declaration | S5-1 `behavior`, `rendered` and `validation.independentReview` cover undeclared/ineligible owner models and absence of owner TWR/MWR. Real declarations and authentication are not proved. |
| U2: Overview and All Bots book labels per currency | S5a `verification` and `rootAcceptance` cover mixed, single and empty currency states. This preserves legacy grouping arithmetic, rather than claiming its removal. |
| U3: Book and marked equity separate | S5-2 `sourceQualification` and `checks.rendered` cover distinct exact strings, current book snapshot, unavailable book valuation time and historical marked range. No same-snapshot or reconciliation claim. |
| U4: No browser money arithmetic in the performance view | S5-1 mapping review and S5-2 decimal boundary checks preserve server strings. This is scoped to the performance view; S5a legacy grouping arithmetic is a separate accepted behavior. |
| U5: Null is an em dash with reason | S5-1/S5-2 cover account-level unavailable/refused values and missing or wrong-currency book data. S5-3 adds nonempty symbol null states; previously empty arrays do not prove them. |
| U6: Badges derive from API fields | S5-1 covers status, methods and range metadata. S5-3 addresses symbol price state, age, bar time and retrieval code. A top-level stale overlay alone is insufficient. |
| U7: English and Thai through i18n | S5-1/S5-2 record language/cache-token repairs and fixed notices. S5-3 addresses the specific human-readable late-recorded-price notice while retaining raw technical codes. |
| U8: Mobile and Thai local-stub checks | Existing matrices establish bounded desktop/mobile viewports in EN/TH. S5-3 records its separate 16-case cohort. Viewport checks are not physical-device or Safari acceptance. |
| U9: UI starts, changes or sizes no Bot | Existing source review and observed GET-only traffic cover this read-only view. S5-2 server journaling alone is not proof of all off-origin traffic. No declaration PUT or Bot control is included. |

## Price and time qualification

Synthetic S5-3 fixtures use the existing pure replay, price, return and response producers. A valid FRESH price has age at most 180000 ms. STALE remains usable through 900000 ms and may retain COMPLETE numeric wrappers with `PRICE_STALE`. Beyond carry and missing eligible rows yield unavailable numeric fields; only actual serialized reasons belong in UI fixtures. No old numeric placeholder or interpolation is allowed.

Symbol valuation is at `resolved_range.to`; `as_of` is request time. `price_bar_time` and `price_age_ms` remain server values. `RETRIEVED_AFTER_INSTANT` is informational and does not change valuation. Contract section 2.3 requires the human-readable “price recorded later” notice.

The current response exposes a scalar market-data gap indicator, not a list of gap intervals. Missing-price rendering is not interval reporting. **Full gap-interval coverage remains unresolved** and requires separate source/contract analysis before any backend work.

## Remaining prohibition inventory

Prior evidence covers currency separation, absence of owner returns for undeclared or independent-account models, no Buy & Hold chart, and fixed simulated-Paper-history and sizing notices. Those observations remain bounded to the local read-only view.

Targeted independent source review resolves four earlier summary-level inventory limits without counting new test passes:

- Unknown bases: `qr2-returns.js` rejects unavailable or nonpositive bases in `chain`, `twr` and `modifiedDietz`; existing portfolio-performance tests cover unavailable boundaries and nonpositive bases. The composer preserves null wrappers and the UI displays the reason and em dash. The browser does not recalculate the return or prove arbitrary forged server semantics.
- Net liquidation: the composer account field list and the UI metric map contain no hypothetical exit value or future disposal fee calculation. This is bounded source inspection, not a claim about every application page or arbitrary metadata.
- Ranking: the QR-2 view has no metric sorting, candidate selection or recommendation path. Supplied Bot labels and technical metadata remain literal text; the application does not implement a blanket word filter.
- PnL and notices: `ppNotice` is outside `ppResult` in the static shell. Invalidation and report rendering replace only result/status content, retaining the fixed Paper-history notice. Previous rendered evidence supports visible EN/TH notices. This source review is not a new browser run.

The ignored independent report retains exact assertion pointers and the inspected source identity. Final S5-3 candidate observations confirm the new notice and preserve these boundaries; independent evidence review passed.

Root must review that trace, the S5-3 results and the unresolved interval requirement before a full-S5 decision. Real authentication and target integration remain NOT RUN. Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment or target route activation.
