# Task: Implement Trading Control Panel & Risk Guard UI

## Scope and evidence

Prepared from repository source on 2026-09-23. Last reported deployment: c56724f; this handoff does not re-verify the live VPS. Requested frontendskill was not found in local skills or installed plugin cache. No UI implementation or deployment is included in this handoff.

## Current UI

- Vanilla HTML/CSS/JavaScript, dark navy theme with cyan accents; English/Thai language switching. Existing sidebar, bot selector, Bot Manager, Overview, Risk manager and Analytics.
- public/bots.js renders small lifecycle buttons mixed with Save, Copy webhook and Open. Only legal actions are visible: SETUP Run; RUNNING Pause/Stop; PAUSED Run/Stop; STOPPED Reset. Session state is fetched separately for every bot.
- Risk manager contains default/max risk limits, switches, configured funding and an order preview calculator. It does not currently disable policy inputs according to session state or gate Run on a validated, saved form. Empty numeric strings may be coerced to zero; validate before serialization.
- Current cash and book equity appear as small ledger rows, rather than prominent updating account cards. /api/me supplies paperAccounts and botSession.
- Lifecycle routes support bot_id and ownership checks. Backend PUT /api/risk rejects RUNNING and PAUSED. Worker uses frozen policy in RUNNING; its PAUSED policy fallback needs review against intended freeze semantics.
- STOPPED currently rejects all signals, including exits; Stop is not a close-position action. Reset archives session metadata and returns to SETUP; it does not clear balances, trades or open positions.
- Existing verification for c56724f covered syntax, published asset and service health. PostgreSQL tests were not completed because local TEST_DATABASE_URL was absent. Do not claim end-to-end lifecycle acceptance from those checks.

## Visual direction

Use a focused trading dashboard consistent with the existing navy/cyan palette. Place the selected bot name, state badge and Paper / Live locked indicator above a shared Trading Control Panel, adjacent to Risk manager. Keep utility actions visually secondary.

Show four large, consistently positioned buttons at all times: Run (primary cyan/green), Pause (amber), Stop (red outline), Reset (neutral). Use icons plus text, 44px minimum targets, clear focus rings and disabled explanations. Disabled actions remain visible. Desktop uses a four-column row; narrow screens use a 2x2 grid without overflow.

Below controls, show two large account cards: Equity and Balance, with currency, broker and last-update status. Organize Risk manager into readable sections: Capital, Per-trade risk, Daily limits and Position limits. Retain existing settings and preview functionality. Use inline errors and a concise readiness message beside Run.

## Required behavior

1. Run requires required policy fields to be present, valid and successfully saved for the selected bot. Apply existing server ranges and cross-field funding rules. Distinguish blank from valid zero; boolean false is valid. Optional symbol filters and preview-only fields must not prevent Run. Do not require positive funding for unused brokers. Define enabled-broker funding requirements explicitly.
2. Track unsaved edits. Disable Run while dirty, invalid, saving, loading, stale or transitioning; explain why. Provide Save settings, then enable Run after server acknowledgement. Never silently discard drafts on refresh or bot switching.
3. Freeze policy and funding inputs when RUNNING. Preserve the existing PAUSED freeze too; expose frozen session settings consistently. Keep them locked through STOPPED until Reset as the proposed UI workflow, while documenting that backend currently permits STOPPED edits. If enforcing this lifecycle contract server-side, add matching checks and tests. Keep emergency controls separate from locked policy inputs.
4. Show all four actions with availability derived from server state: SETUP Run (when valid); RUNNING Pause/Stop; PAUSED Run/Stop; STOPPED Reset. Disable all during a request and reconcile from the server after success or failure. All Bots scope is read-only; require a concrete owned bot.
5. Explain before Stop that it blocks protective exit signals and does not liquidate positions. Confirm Stop/Reset with the bot name and consequences. Reset archives the session; never describe it as erasing trades or resetting funds.
6. Use server paperAccounts values: Equity = bookEquity, Balance = cash. Label their accounting basis; do not imply market-valued equity. Separate brokers/currencies, never sum USDT and THB. Preserve decimal-string precision.
7. While Running, refresh account/session data with bounded polling (suggest 3–5 seconds), no overlapping requests, and cleanup on logout, bot switch or hidden tab. Refresh immediately on return. Ignore late responses for a previous bot. Mark stale/error values honestly.
8. Animate only actual numeric changes with a short highlight/count transition, approximately 250–400ms. Respect prefers-reduced-motion. Keep authoritative decimal values intact; show timestamp or connection state independently. Avoid flashing, fake ticks or fabricated PnL.
9. Server validation must also reject invalid Run requests and policy writes that violate lifecycle locks. Validate/snapshot policy under the same bot lock/transaction used for transition to avoid save/run races. UI disabling is not an authorization boundary.

## Implementation targets

- public/index.html: shared control panel, account cards, risk field grouping and accessible status region.
- public/bots.js: scoped lifecycle state and action handling; prevent duplicate submissions and stale responses.
- public/app.js: required-field validation, draft tracking, policy locks and account updates without overwriting inputs.
- public/styles-v2.css: hierarchy, controls, responsive layout, states and reduced-motion rules. Inspect existing NUL/mixed-encoding content before editing.
- public/i18n.js: complete EN/TH labels, error messages and confirmation copy.
- src/postgres/server.js and store.js: validate Run and enforce atomic policy snapshot/transition where needed. Review worker policy handling while Paused.
- Update asset version references to invalidate stale browser caches.

## Acceptance and handoff evidence

- Verify desktop and narrow mobile layouts in EN and TH, keyboard focus, disabled reasons and reduced motion.
- Check blank/invalid/unsaved settings block Run; valid saved settings enable it; direct invalid API calls also fail.
- Check Run freezes inputs, Pause preserves frozen policy, resume preserves run_id, Stop/Reset confirmations describe actual behavior, and Reset returns to editable setup.
- Verify actions target the selected bot; another tenant and All Bots cannot mutate it. Switching bots during requests must not apply stale state.
- Verify displayed balances match server ledger by broker/currency; animate changes only; stale/network error states are visible.
- Run relevant UI and real PostgreSQL HTTP/lifecycle tests on an isolated database, including the save/run race. Do not exercise transitions on customer production bots as a test.
- Deploy an auditable release after checks, verify published assets and authenticated UI, API/worker health, schema compatibility and PAPER_ONLY. Record exact test results and any limitations.
