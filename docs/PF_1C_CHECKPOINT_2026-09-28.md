# PF-1C — venue rules, shared costs and preview acceptance

Date: 2026-09-28. Engineering checkpoint on the working branch after PF-1B.
The requested implementation and isolated verification are complete for the
scope below. This is not activation of a new execution model on an existing
Bot, a production release, or a validated Quant recommendation.

## Delivered scope

- Binance Global BTCUSDT Spot MARKET Paper orders: retain complete public symbol
  and exchange filters in `binance-spot-filters-v1` snapshots. Validate quantity,
  market quantity, notional applicability, order counts, base position and supplied
  asset filters. Classify known inapplicable rules explicitly. Unknown fields,
  duplicate filters, malformed values, unsupported rules, stale references and
  model tick/step mismatches fail closed. MARKET orders have no submitted limit
  price; simulated protection levels are not exchange stop orders.
- Each snapshot has its own acquisition timestamp, content hash and 60-second
  freshness limit. Websocket bar timestamps do not renew metadata. Dynamic
  notional checks use sourced reference/average/last-trade prices with matching
  averaging periods; a modeled fill is never substituted for that reference.
- Acquisition uses a fixed official origin, no redirects, a 10-second absolute
  deadline and a 256-KiB response limit. Authenticated, Bot-scoped, CSRF-protected
  `POST /api/risk/venue-refresh` updates only public metadata, with a 15-second
  refresh coalescing interval. Existing readiness previews remain read-only for
  trading state. Normal authentication bookkeeping can still write.
- `paper-close-cost-v2` adds one shared finalizer for readiness and the execution
  worker. Percentage sizing may shrink for requested risk, policy limits, entry
  and conditional exit fees, adverse stop slippage, quantity rounding, cash and
  exposure. Explicit oversize orders reject. Known pending entry fees are
  reserved separately from notional and protected during withdrawals. Missing
  fee authority blocks V2 BUY and withdrawals. Worker rechecks venue evidence and
  stores the complete report in the order intent and fill record.
- `paper-close-v1` is preserved. New cost rules do not automatically upgrade old
  evidence or deployments. Existing preliminary risk rejection remains
  conservative: the finalizer never repairs a prior rejection. Ledger R retains
  price-distance accounting. Conditional stop loss is not a maximum gap loss.
- Draft scenarios use the same policy validator as policy saves, but write no
  policy or capital. They retain actual positions, reservations, daily counters,
  session state, ownership and global guards. The response additionally returns
  the actual saved-policy result/hash so a hypothetical higher loss limit cannot
  conceal the real entry pause. Draft and saved calculations remain distinct.
- UI adds Saved/Draft and Generic/Bridge modes, scoped deployment/bar/EXIT inputs,
  cost and venue diagnostics, cache refresh, and stale-result invalidation. Browser
  review found and corrected hidden-grid CSS, a malformed responsive CSS rule,
  stale asset versions and an inaccurate fee banner. Long evidence hashes wrap.
- A finite staging producer, `scripts/refresh-paper-venue.mjs`, supports one-shot
  refresh or supervised runs up to 600 seconds. It uses an independent metadata
  transaction, bounded attempts, job logs and cancellation. No permanent service
  was installed. Provider failure never extends old metadata freshness.
- Quant admission explicitly rejects V2 with
  `RESEARCH_EXECUTION_MODEL_PARITY_REQUIRED` before creating a job. The existing
  Python evaluator supports V1; V2 historical parity is a PF-2 prerequisite.

Filter interpretation follows the official
[Binance filters](https://developers.binance.com/en/docs/products/spot/filters)
and [market endpoint specification](https://github.com/binance/binance-spot-api-docs/blob/master/rest-api.md).
Public Paper validation does not certify an exchange account's Live permissions,
asset filters, balances or execution. The Paper adapter explicitly assumes no
account-specific asset restrictions; the validator reports missing evidence when
that assumption or supplied asset filters are absent.

## Verification

| Scope | Result |
| --- | --- |
| Full local Node suite, `npm test` | **281/281 passed**; 37.1 seconds in the final run. |
| Local PostgreSQL `phase2.test.mjs` | **13/13 passed**, including HTTP authorization, MFA, CSRF and tenant isolation. |
| Local PostgreSQL `risk-readiness.test.mjs` | **17/17 passed**, including V1/V2 preview-worker parity, costs/cash, stale/minimum venue rejection, fee reservations, crash rollback/recovery, draft and feature-enabled Bridge HTTP. |
| Local PostgreSQL `quant-research.test.mjs` | **8/8 passed**, including V2 admission rejection without a Quant job. |
| Isolated VPS staging, current source package | The same phase2/readiness suites passed **13 + 17 checks** on disposable databases. No deployed service or existing dataset was changed. |
| Real metadata producer on isolated staging | **7 successful refreshes, zero failures, 121,697 ms**, seven distinct snapshot hashes; exceeds two 60-second TTLs. Disposable producer database dropped. |
| Real Chrome with isolated local PostgreSQL/HTTP | Sign-in; saved Generic accepted; V2 Bridge capped with fee/stop-cost/venue evidence; Draft capital clearly hypothetical; invalid EXIT reference rejected and quantity cleared. 390-pixel viewport showed no horizontal document overflow; hidden mode panels verified. |
| Post-check health and cleanup | Existing production/staging/market-stream services remained active. Local browser fixture database removed, browser closed, viewport restored, local PostgreSQL stopped. No permanent job remains. |

Local automated total: **319 passed, zero failed**. The 30 staging checks repeat
part of that coverage; do not count them as additional distinct test cases.
Browser evidence is UI acceptance on synthetic fixtures, not new TradingView or
SPT source parity. Private logs and provider snapshots remain Git-ignored.

## Rollout boundary and next work

PF-1C closes the listed engineering gaps within the Paper/public-filter scope.
Active Bot rollout acceptance remains separate: review the diff, checkpoint the
code, then prepare a reviewed V2 deployment/evidence and supervised metadata
producer plan before changing an existing Bot. The current V1 collector and
research evidence are unchanged. No extra live-bar collection is needed merely
to checkpoint this implementation.

Successful hypothetical calculations still show `UNKNOWN`/“Not verified” for
Run readiness. Missing venue authority blocks execution; public filter success
does not clear unknown news, session guards or historical activity requirements.
PF-2 may use these contracts for bounded historical engineering, but cannot run
V2 optimization until evaluator/model parity is implemented and accepted. No
automatic research loop, guard reset, Best Inputs apply, mail delivery or Live
activation is introduced.

Reproduction: run `npm test`; use a disposable PostgreSQL connection for each
named integration file separately. For the producer, supply an explicitly
isolated Paper staging environment and run:

```sh
node scripts/refresh-paper-venue.mjs --duration-seconds=140 --interval-seconds=20
```

The default is one refresh. It does not install a service or schedule later work.
Checkpoint usage: 71% of the known weekly window remained; the short window was
unavailable. Preserve the project's 20-percentage-point reserve. These are shared
account readings, not measured task tokens. Full active engineering hours were
not captured; test runtime is not development duration.
