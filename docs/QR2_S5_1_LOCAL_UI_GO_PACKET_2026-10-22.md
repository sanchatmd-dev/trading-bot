# QR-2 S5-1 local UI scope decision

Prepared on 2026-10-22 (Bangkok) against `34fabf6c46c23408bec99471b1bbc39a3ddf08c2`. Preparation status was proposal only. The owner explicitly approved this bounded S5-1 packet on 2026-10-22; implementation, focused verification, evidence updates and periodic commit/push are now authorized. Deployment and route activation on a target remain excluded.

## Why another scope decision is needed

The existing owner GO names FE-2b and QR-2 S4-4/S4-5, including independent verification and periodic commit/push. Those slices, their identified CI repairs and the two additional HTTP/owner-worker verification slices have accepted local evidence. Exact-revision CI is green on `e6db022`; the later documentation checkpoint is green with tests skipped by scope. A bounded root and architecture review found no confirmed remaining local implementation requirement or defect in those authorized slices. This is not a claim that every possible defect has been excluded.

The [cloud-to-local handoff, section 7](CODEX_CLOUD_TO_LOCAL_ROOT_HANDOFF_2026-10-22.md#7-remaining-project-work-and-decisions) keeps full S5 separate from the S4 GO. The [QR-2 contract](QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md), sections 9 and 12, defines the UI requirements and local rendered acceptance. Its S8 documentation/evidence slice has no additional gate; this packet and the scope checkpoint are documentation work only. The previously accepted S5a currency labels do not establish full S5 acceptance.

FE-2b native QS/systemd/cgroup and physical-stop evidence is still open. The local Windows capability check found that WSL is not installed. No Linux environment was provisioned and no native test, service, host or VPS action was attempted. Native proof cannot be substituted with another Windows fixture. Named-target work still needs the effects, budget, stop plan and operator authority in the [FE-2b release plan](FE2B_RELEASE_PLAN_DRAFT.md#target-release-and-rollback-proposal--no-commands).

## Recommended next GO: S5-1 read-only local performance view

Authorize one bounded implementation wave for a read-only QR-2 performance view using existing response contracts. This would extend implementation scope; it would not repeat the already granted S4 decisions or commit/push permission.

- Select an owned Bot and broker, or an owner view with one currency. Select a supported reporting period and custom dates where applicable.
- Consume the existing per-Bot and owner GET responses. Do not add a backend route, change response contracts, change server flags or weaken admission/authentication.
- Display server-provided decimal strings, statuses, reasons, method labels, badges/overlays and requested/resolved ranges. Do not calculate financial totals or returns in the browser. Null remains an em dash with its reason. Owner context uses the API's allocation labels and notices; do not describe an owner total as a single Bot.
- Preserve separate currencies and book equity versus marked equity. An unavailable declaration keeps owner aggregates unavailable. No owner TWR/MWR, cross-currency total, ranking, Buy & Hold line or recommendation is introduced.
- Include the English and Thai Paper-history and book-equity notices required by contract section 9. Handle unavailable endpoints, refused requests and retry responses without presenting stale values as a fresh result.
- Use synthetic fixtures and a loopback stub for local desktop/mobile rendering. No real account or private source is required.
- Do not add charts, interpolation, price repair or valuation fallbacks in S5-1. Those are not required to deliver this bounded read-only view.

Proposed writable paths for the implementation packet are `public/paper-performance.js`, `public/paper-performance.css`, `public/index.html`, `public/i18n.js`, `test/qr2-performance-ui.test.js`, and a named synthetic fixture under `test/fixtures/qr2-performance-ui/`. Root owns the evidence and four checkpoint documents. Before dispatch, confirm the mounting and asset-loading interfaces; any additional product path needs a revised bounded packet. Existing accounting, readers, scheduler, guards and backend routes are read-only dependencies.

## Acceptance and stopping point

1. Focused UI tests cover Bot/owner and currency/range selection, pending/refused/unavailable responses, null/reason and status rendering, missing declaration, safe text rendering, and stale-response suppression after a selection change. Existing Overview/Bot label tests run only if their shared interface changes.
2. Render the real candidate assets against a synthetic loopback stub at desktop and mobile sizes in English and Thai. Inspect the relevant states for correct notices, visible reasons, no cross-currency sum, no horizontal overflow and no unintended external requests.
3. Independently review the response-to-view mapping and the absence of browser financial arithmetic or Bot mutations. Record actual results, skipped checks and source/artifact identities. Root owns acceptance.
4. Commit/push the reviewed slice under the existing Git authorization and read back exact-revision CI. Stop after this view and evidence. Do not claim completion of all S5, authenticated target integration or deployment.

No new runtime test was run to prepare this packet. Preparation validation covers documentation links, evidence structure and diff hygiene only.

## Effects excluded from this proposed GO

No capital-declaration PUT UI, declaration creation, Bot start/stop/reset or sizing change; no deployment, migration, route activation, target measurement, native host provisioning or VPS work. No private acceptance, source upload, TradingView operation, frozen-report persistence, QR-3 ranking or QR-4 tolerance decision. Spot/Paper only; private source remains local; READY remains false and N1 remains held. Live, guard reset and Best Inputs apply retain their explicit gates.

Suggested owner decision: **GO QR-2 S5-1 local read-only UI as scoped in this packet, with focused tests, rendered synthetic evidence and periodic commit/push; all excluded effects remain held.** The owner has now given this decision. It authorizes only the bounded view and local verification described above; all excluded effects remain held.
