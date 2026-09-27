# PF-1B — PostgreSQL, Bridge preview and policy UI

Date: 2026-09-28. Local engineering checkpoint after pushed PF-1A `9c5f8f3`.
Full PF-1 acceptance remains pending. No deployment, policy change, collector
restart or new research run occurred. [Roadmap](ROADMAP.md) owns the next gate.

## Delivered

- Ran a real isolated PostgreSQL 16.15 cluster on local loopback. HTTP checks
  cover authentication, MFA, CSRF, Bot ownership and trading-state stability.
  The cluster was stopped after verification; fixtures/runtime remain ignored.
- Added real service-versus-worker acceptance, cap and rejection checks; verified
  coherent reads during an external committed funding/policy change, sibling
  target isolation, and RUNNING locked-policy selection.
- Added strict Bridge preview mode to `/api/risk/readiness`:
  `{bridge:{deployment_id,bar_time,event_type}}` for BUY; EXIT also requires
  `entry_ref` and `reason`. This mode requires the existing Bridge feature flag.
  Generic `{signal:...}` remains supported; the two modes are mutually exclusive.
- The read-only Bridge resolver uses scoped deployment/snapshot/evidence, verified
  closed bar, frozen ATR/RR, execution model and effective worker policy. It derives
  price, volatility, SL/TP, risk percent and target allocation on the server. It
  checks same-bar exit suppression and SL/TP/native priority without creating an
  event, queue item or order. News is never fabricated.
- Bridge sizing uses the worker's fee-adjusted BUY cash budget and quantity-step
  rounding. Costs show fee, cash debit/credit and conditional stop/target scenarios.
  These assume the exit-bar close equals the frozen trigger; actual gaps/exit-bar
  closes can increase loss. The worker does not enforce a cost-inclusive risk cap.
  A preview whose estimated loss exceeds that cap reports a configuration conflict;
  it does not alter the worker or silently reduce the requested risk policy.
- Policy review reports invalid limits, defaults, switches, symbol lists and
  funding relationships. Malformed saved policy produces a diagnostic rather
  than an unhandled evaluation error. Response includes policy hash/provenance
  and effective values. Capacity counts committed symbols (held plus pending
  entries), daily executions and reservations, not guaranteed future BUY slots.
- UI separates policy, capital and hypothetical order inputs. PostgreSQL preview
  sends only the proposed signal and uses server policy/capital. It supports
  BUY, reduce-only SELL, three sizing modes, target ID and explicit unknown guards.
  Preview edits do not mark policy dirty, remain usable while policy is locked,
  and immediately invalidate stale responses. Enter in preview cannot submit a
  policy save; preview validity cannot block the separately server-validated save.
  Policy conflicts and incomplete checks are displayed explicitly.

## Verification

| Evidence | Result |
| --- | --- |
| Focused risk, Bridge, policy, UI, security-UI and existing Pine-UI tests | **107/107 passed**, final combined local run. |
| Real PostgreSQL `test/postgres/phase2.test.mjs` | **13/13 passed**, including readiness HTTP authorization/CSRF and no trading-state mutation. |
| Real PostgreSQL `test/postgres/risk-readiness.test.mjs` | **9/9 passed**, including Bridge BUY/EXIT quantity, fee/cash parity and cost conflict. Rerun after integration fixes. |
| Review | Root integrated independent UI/test assignments. Astra reviewed root integration; malformed-policy and committed-symbol findings were corrected and checked. |
| Runtime cleanup | Owned local PostgreSQL cluster stopped successfully. No production/VPS runtime used. |

Combined evidence: **129 passed, zero failed**. Tests use synthetic isolated
fixtures, never the production trading database. UI verification is jsdom,
not a browser visual or staging acceptance run. Bridge integration tests call
the service directly; the HTTP Bridge feature-enabled path still needs coverage.

Reproduce the non-database checks:

```sh
node --test --test-isolation=none test/risk-readiness.test.js test/risk-policy-review.test.js test/risk-readiness-bridge.test.js test/risk.test.js test/risk-readiness-ui.test.js test/ui.test.js test/security-ui.test.js test/pine-bridge-ui.test.js
```

For PostgreSQL, set `TEST_DATABASE_URL` to a disposable local instance with
database-create permission, then run each file separately. The files create/drop
their own random test database. Never supply a production connection.

```sh
node --test test/postgres/phase2.test.mjs
node --test test/postgres/risk-readiness.test.mjs
```

The temporary PostgreSQL binary came from the official EDB Windows distribution
over HTTPS. Local provenance records its computed SHA256; no independently
published checksum match is claimed. No global installation or dependency change.

## Remaining PF-1 gates

1. Acquire complete, versioned venue filters with timestamp/hash and fail-closed
   unsupported rules. Existing verified data proves only identity, tick and step,
   not minimum notional, min/max quantity or all market-order constraints.
2. Decide/version shared enforcement of those filters, cost-inclusive risk and
   pending-fee reservations. Preserve previous evidence and existing worker behavior
   until a new model has parity/recovery evidence. Current preview must stay
   `UNKNOWN` or `BLOCKED`; a successful calculation is not Run approval.
3. Add a separately labelled hypothetical policy/funding scenario if exposed;
   client policy overrides remain rejected. Current UI previews proposed orders
   against saved/locked authority. Add Bridge preview selection/cost rendering to
   UI, feature-enabled HTTP tests and browser/staging acceptance with freshness
   recheck before closing PF-1.

PF-2 remains after PF-1. No additional live bars are needed for these engineering
gates. The existing `NO_VALID_CANDIDATE` research outcome remains unchanged.

Time Management records this local checkpoint. Full active work was not timed;
do not add overlapping worker durations or infer exact task cost from account usage.
