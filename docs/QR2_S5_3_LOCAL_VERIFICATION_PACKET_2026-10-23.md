# QR-2 S5-3: symbol valuation verification and UI traceability

Status: **BOUNDED LOCAL ACCEPTANCE RECORDED; EXACT-REVISION CI PENDING**. On 2026-10-23 (Bangkok), the owner authorized continuous Roadmap work and bounded local GOs while away. Root admits this slice after the S5 residual audit at `c159187`. The existing target and optional-feature gates remain unchanged.

## Purpose and source prerequisite

The accepted S5-1/S5-2 UI fixtures contain empty symbol arrays. They do not establish the rendering of symbol price, age, provenance or an unavailable price caused by missing data. This is an evidence gap, not proof of a financial calculation defect.

Before creating fixtures, independently qualify the existing resolver, response composer and validator against QR-2 contract sections 2, 8 and 9. Use only existing public response fields and codes. Distinguish resolver-internal reasons from reasons actually serialized by the composer. Do not add a backend field, infer a bar-gap interval or reinterpret response time as valuation time.

## Bounded work and ownership

- Add producer-grounded synthetic FRESH, allowed STALE, beyond-carry unavailable and missing-price cases in `test/fixtures/qr2-performance-ui/symbol-responses.json`. Tests must preserve exact decimal strings and the actual response contract.
- Add focused mapping checks in `test/qr2-performance-ui.test.js`. Prove null as an em dash with its reason, retained API status/age/time/provenance, no stale numeric placeholder, no interpolation and GET-only behavior.
- Root owns an isolated harness and observations under ignored `.qa-local/qr2-s5-3/`, this packet, the evidence record, the U1-U9 traceability record and README/Context/Roadmap/Time Management.
- Product assets and all backend, accounting, risk, scheduler, route and guard files are read-only in this initial packet. A reproduced presentation defect requires a specific root-recorded repair amendment and independent focused verification before any product edit.

Use Astra-only workers under AGENTS.md. One writer per path; root owns browser, Git and acceptance. No worker dispatches another worker.

## Source qualification and bounded repair amendment

Independent qualification passed for synthetic fixtures using the existing price resolver, return calculation and response composer. FRESH and STALE retain numeric values; STALE remains usable through 900000 ms. Beyond carry and missing eligible rows serialize unavailable values, not resolver-internal reason codes. Symbol valuation uses `resolved_range.to`; header `as_of` is request time. These timestamps must remain distinct.

Qualification confirmed one presentation gap against contract section 2.3: `RETRIEVED_AFTER_INSTANT` is displayed as a technical code without the required human-readable “price recorded later” notice. Root admits a narrow EN/TH notice repair in `public/paper-performance.js` and `public/i18n.js`, preserving the raw code and all values. No client price calculation or time inference is authorized. `public/index.html`, `test/asset-cache-tokens.test.js`, and the cache-token pins in `test/bridge-wizard-ui.test.js`, `test/journey-ui.test.js`, `test/market-chart-ui.test.js`, `test/pf3-readiness-ui.test.js` and `test/quant-library-ui.test.js` may change only as needed for asset invalidation. The same coder owns these paths, the symbol fixture and focused UI tests; root owns documentation and the separate rendering harness. Independent review is required.

The API does not expose a gap-interval list. Missing-price fixtures prove unavailable valuation rendering only. Full interval reporting remains an explicit contract/API gap and is not closed by this slice. No field or interval is invented.

## Acceptance and stopping point

1. Source/time qualification passes before fixtures are authored; an inadequate contract becomes a documented gap.
2. Focused producer/validator and UI mapping checks pass. Existing accepted currency, ownership and session evidence is reused unless an interface changes.
3. Render only the new symbol states in the actual local shell with synthetic GET fixtures at desktop/mobile sizes in English and Thai. Inspect visible reasons, age/provenance, overflow, fixed notices and the separation of book and marked snapshots.
4. An independent verifier checks the final changes and raw observations. Root records exact source identities, actual test counts and limits. Local S5 acceptance is a separate decision from completing this slice and requires the full traceability review.
5. Commit/push the reviewed paths under the owner's existing authorization, follow the exact revision through CI and distinguish executed runtime checks from documentation skips. Save a local checkpoint before selecting another Roadmap slice.

## Unchanged boundaries

Spot/Paper only; private source remains local; private acceptance NOT RUN; READY false; N1 held. No real account or private inputs are needed. No deployment, target route activation, shared/target migration, host/VPS work, Live, guard reset, Best Inputs apply, declaration PUT, Bot action, ranking or new financial calculation. Real authentication, target capacity and activation remain unaccepted. Optional S6/S7 and S9 retain their separate gates. No numerical progress credit is awarded by this packet.

## Local verification outcome

Root accepts this bounded slice after the historical-reservation fixture correction, independent review and the final 16-case synthetic rendering cohort. [Evidence](evidence/PM1_QR2_S5_3_UI_LOCAL_2026-10-23.json) records actual checks and capture identities. CI remains pending for the forthcoming implementation revision. Full S5 remains open; no gap-interval or target acceptance is inferred.
