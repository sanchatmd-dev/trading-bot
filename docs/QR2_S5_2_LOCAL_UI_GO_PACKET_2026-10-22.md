# QR-2 S5-2 proposal: book equity beside marked equity

Status: **PROPOSED, NOT AUTHORIZED OR IMPLEMENTED**. Prepared under S8 documentation authority against `122b93d0a25796e3bad423f1df74943765473ada` on 2026-10-22 (Bangkok). This packet does not extend the existing implementation GO.

## Why this is the next bounded decision

The accepted [S5-1 packet](QR2_S5_1_LOCAL_UI_GO_PACKET_2026-10-22.md) ends with “Stop after this view and evidence.” Its component and actual-shell follow-up are locally accepted; the two boot/session regressions are fixed, focused tests passed 14/14, and exact code revision `735bf9f7c11955396550ec60cbad479f9c050197` passed both workflows. The subsequent documentation revision also passed scope-only CI. [S5-1 evidence](evidence/PM1_QR2_S5_1_UI_LOCAL_2026-10-22.json) retains the precise limits. No additional S5-1 defect or authorized implementation requirement was identified by this bounded scope review.

The [QR-2 contract, sections 8.5 and 9](QR_2_PORTFOLIO_PERFORMANCE_CONTRACT.md#9-ui-rules-u1-u9), requires book equity and marked equity in separate columns. The accepted view shows marked metrics plus a notice that the performance endpoint does not supply book equity. That satisfies the bounded S5-1 view, but does not establish the numeric side-by-side presentation required for full S5. Charts and capital-declaration PUT UI are not mandatory remainders of section 9.

## Source findings and mandatory first stop

Static source inspection identifies a candidate, not an approved integration contract:

- PostgreSQL `GET /api/me` returns `paperAccounts` with `bot_id`, broker, currency and `moneyFormat: decimal-string`. `paperAccount()` serializes `bookEquity` through `amount()` as a decimal string and labels its valuation `COST_BASIS_NOT_MARK_TO_MARKET`.
- `GET /api/overview` also returns per-Bot `paperAccounts`, under a read-only repeatable-read transaction. Its response deliberately has no clock value. Neither inspected account shape supplies a book-valuation timestamp that can be matched to a historical QR-2 report.
- Existing shell rendering of book equity does not prove that the account snapshot and selected QR-2 range describe the same time. HTTP receipt time, an ETag and Bot session times are not valuation timestamps. No account endpoint was called and no real or private input was read for this preparation.

Before any product edit, independently review the exact existing GET source, authentication/ownership path, Bot/broker/currency identity, decimal serialization, refresh/invalidation behavior and time semantics. Decide whether a clearly labelled current account snapshot with **valuation time unavailable** can safely sit beside a historical marked value. A receipt timestamp must never be represented as valuation time. Do not infer historical book equity. If that distinction cannot be made unambiguous using the existing contract, stop with a design gap and a separate proposal; do not add a backend field, route or flag implicitly.

## Proposed implementation after owner GO and source review

Deliver one local, synthetic, per-Bot presentation. Keep book equity labelled `BOOK_EQUITY_COST_BASIS`, “used for sizing; not portfolio value,” in a separate column from the server's marked equity and report range. Preserve exact decimal strings. Missing, invalid, mismatched or temporally ambiguous book data displays an em dash and reason. Never feed book equity into a QR-2 metric, combine currencies, calculate money in the browser or add an owner book-equity aggregate.

Keep the existing selection/session stale-response guards, pending gate and EN/TH Paper-history notices. A fresh GET must be tied to the selected owned Bot/broker/currency; changes and expired sessions clear both sides. Synthetic local fixtures only. No production account, private source or target route is needed.

Proposed writable product/test paths are `public/paper-performance.js`, `public/paper-performance.css`, `public/index.html`, `public/i18n.js`, `test/qr2-performance-ui.test.js` and `test/asset-cache-tokens.test.js`. Root may prepare a named synthetic harness under ignored `.qa-local/qr2-s5-2/`. Root owns evidence and README/Context/Roadmap/Time Management. All backend, accounting, Risk Manager, scheduler, route and guard files are read-only. Any additional product path requires a revised bounded packet before dispatch.

## Acceptance and stopping point

1. Source review resolves identity and time semantics before implementation. A failed prerequisite ends the slice with documented gaps, not a workaround.
2. Focused synthetic checks cover exact decimals, null/reason, wrong Bot/broker/currency, current-versus-historical labels, selection/session invalidation, pending and late responses. No browser money arithmetic or mutation request is permitted.
3. Root renders only the changed comparison states in desktop/mobile EN/TH against actual local assets and synthetic GET fixtures. Check labels, values and overflow. Do not repeat the complete accepted S5-1 matrix without a relevant change.
4. Independent mapping review and focused tests must pass; root records source identities and actual rendered results. Commit/push under the existing authorization and verify exact-revision CI, distinguishing runtime steps from documentation skips.
5. Stop after this bounded presentation and evidence. Full S5 remains open until its residual requirements are reviewed; real authentication and target integration remain unaccepted.

No implementation, runtime test or browser check was run to prepare this proposal. S8 preparation validation covers source/document references, evidence consistency and diff hygiene only.

## Excluded effects and suggested decision

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, migration, target measurement, native provisioning, host/VPS work, Live, guard reset or Best Inputs apply. No declaration PUT, Bot operation/sizing, charts, frozen reports, ranking, numeric-tolerance decision or private acceptance. S6/S7/S9 and other project phases remain separate.

Suggested decision: **GO QR-2 S5-2 as scoped here: qualify the existing read-only source first, implement only if independent review resolves its identity/time semantics, then focused synthetic tests/rendering, evidence and commit/push. Stop and report any source-contract gap; no backend or target effects.** This decision has not yet been given.
