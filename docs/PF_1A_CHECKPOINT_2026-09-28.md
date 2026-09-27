# PF-1A — local Risk Readiness backend checkpoint

Date: 2026-09-28. Status: **local implementation and focused tests passed; full
PF-1 acceptance pending**. No staging/production rollout, new research campaign,
policy save, guard reset or collection change was performed. The owner authorized
commit/push of this checkpoint; Git history and the remote revision record release
status separately from deployment. [Roadmap](ROADMAP.md) owns the remaining order.

## Delivered

`POST /api/risk/readiness?bot_id=<selected-bot>` is additive to the PostgreSQL
server. Existing authentication, origin/CSRF and selected-Bot authorization
apply; the service repeats ownership checks inside the transaction. Selecting
all Bots is unsupported. The existing calculator and UI are unchanged.

The only top-level request field is `signal`, using the existing raw generic
Spot signal contract. The signal requires an ID, broker, symbol, event and current
timestamp, plus appropriate price/sizing fields. Example application payload:

```js
{
  signal: {
    trade_id: "readiness-example",
    broker: "binance-global",
    symbol: "BINANCE:BTCUSDT",
    event: "BUY",
    timestamp: Date.now(),
    risk_mode: "PERCENT_EQUITY",
    risk_value: "1",
    entry: "60000",
    sl: "59000"
  }
}
```

These prices illustrate request shape only. Missing volatility/news evidence is
preserved and may reject under the saved policy. Input market values are caller
supplied, not verified live prices. Unknown fields, draft policy/capital, trusted
context overrides, `bridge` and `deployment_id` are rejected with HTTP 400.
Ownership denial is HTTP 403. A valid diagnostic returns HTTP 200 even when the
calculation is rejected; callers must inspect its outcome fields.

### Server state and outcomes

- Reads actual selected Bot and owner status, saved/locked policy, session,
  book equity, cash, reservations, daily guards, persistent loss streak and
  scoped position/target allocation. No client-proposed capital substitution.
- RUNNING uses its locked policy; a missing lock is explicitly reported as
  `SAVED_POLICY_FALLBACK`. Generic PAUSED requests use saved policy, matching
  the current worker. Bridge PAUSED semantics are outside this checkpoint.
- Reuses the PostgreSQL decimal risk engine for quantity, fixed-notional and
  percent-equity sizing. Oversized reduce-only exits cap to available scoped
  quantity; SELL cannot open Short. STOPPED rejects all; PAUSED permits only
  reduce-only exits. Unknown pending outcomes block.
- Returns `version`, ISO `asOf`, `botId`, scope, policy provenance, session,
  actual account plus `cashAvailable`, `calculation` and limitations.
- `calculation.status` is `ACCEPTED`, `CAPPED` or `REJECTED` for the generic
  Paper risk calculation. Rejections produce readiness `BLOCKED`. A successful
  calculation produces readiness **`UNKNOWN`, never `READY`**: venue filters,
  execution costs and Bridge preflight are not verified here.
- `asOf` is the evaluation time, not a reservation or executable quote. Reads
  use the API's existing SERIALIZABLE transaction; standalone service calls
  request REPEATABLE READ. Execution must always recheck current state.
- The service has no trading/policy mutation path. Authentication/session and
  rate-limit bookkeeping can still write; this is not a zero-database-write API.

## Evidence

| Check | Result / scope |
| --- | --- |
| `node --test test/risk-readiness.test.js test/risk.test.js` | **53 passed, 0 failed**: 40 new service tests plus 13 existing risk tests. |
| New service fixtures | Real PostgreSQL signal normalizer and decimal risk engine with mocked Store; actual capital, 18-decimal reservations, all sizing modes, lifecycle/policy, persistent guards, target caps, trusted-field rejection and timestamps. |
| Mutation checks | Mock write spies and scoped reads; not proof of real database concurrency. |
| Source audit | Astra Medium audit found no substantive blocker within the generic Spot/Paper scope. |
| Syntax | `node --check` passed for new service, server and modified PostgreSQL test file. |
| Diff | `git diff --check` passed; unrelated diagnostic builder preserved. |
| Real PostgreSQL/HTTP | Added assertions to `test/postgres/phase2.test.mjs` for response, trading-state stability, other-Bot/all-Bot rejection, trusted override, CSRF and authentication. **Not run**: local isolated PostgreSQL/`TEST_DATABASE_URL` unavailable. |

Team: root integration/documentation, Sol Medium implementation, Sol Medium
tests, Astra Medium independent audit. Root additionally checked decimal and
exit boundary fixtures. Usage was read before dispatch and integration: weekly
remaining 86% initially, 85% at integration and 84% at final checkpoint;
short-window allowance unavailable.
Reserve policy is 20 percentage points. These are account-wide snapshots, not
an exact attribution of this task's token cost or a completion guarantee.

## Remaining PF-1 gates and next action

1. Run isolated PostgreSQL HTTP assertions and add/run worker execution parity
   plus concurrent snapshot evidence. A stub transaction is not isolation proof.
2. Add a read-only Bridge context resolver and verified venue filters, fee/step/
   minimum-notional handling. Do not call the mutating Bridge execution preparer.
3. Complete static policy consistency checks, effective-value provenance and
   separate hypothetical draft scenarios without overriding actual ledger funds.
4. Integrate UI policy/capital/preview separation, freshness/recheck behavior and
   acceptance fixtures, then perform an authorized staging rollout and validation.

Continue **PF-1** next, before PF-2 Historical Preflight. No new live-bar wait is
needed for this backend checkpoint. This work does not change research outcome
`NO_VALID_CANDIDATE`, validation coverage, holdout status or future trade guarantees.

Full active-work timing was not instrumented; do not sum overlapping agent time
or deduct guessed hours from [Time Management](TIME_MANAGEMENT.md).
