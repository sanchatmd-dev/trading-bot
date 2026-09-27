# Quant Research Library and Best Performance — specification

Owner-approved design, 2026-09-27; **planned, not a released capability**.
[Roadmap](ROADMAP.md#approved-extension--quant-research-library-and-best-performance)
owns QD-1 / QR-1 through QR-4, ordering, progress, limits and change history.
[README](../README.md) and [Context](../Context.md) are the project explanations.
Existing durable runs/offline reports are foundations, not this complete feature.

## Research record and storage

Create an owner-scoped immutable research record for every completed or terminal
job. Retain failed, cancelled and insufficient-data results with completeness
flags; absence of a metric must never become zero. Separate engineering
capability, execution status, evaluation validity and export eligibility.

Record at least:

- Identity: owner, Bot, run, optional parent run, mode, strategy revision, Pine
  membership/version list, source and effective-input hashes; export identity
  only when an export exists. A comparison has its own ID and participant list.
- Inputs: selected/fixed parameters, Bridge settings, bounds, seed/budget,
  all evaluated candidates and reason codes, source dependency/capability version.
- Account assumptions: policy/version, capital basis, initial cash/inventory,
  funding events, reservations/counters as applicable, execution/fee/slippage
  model, venue increments and valuation currency/method.
- Data: venue/symbol/timeframe(s), resolved interval, timezone, closed-bar
  convention, warm-up, gaps/coverage, partitions, dataset references and hashes,
  collection/cutoff timestamps and historical-versus-observed provenance.
- Reproduction: engine/dependency versions and retained artifacts. Inputs alone
  cannot reproduce signals; retain the supported evaluator and original data.
- Results: metrics, timestamped equity/drawdown, fills/trades, allocations,
  completed position episodes, decisions/rejections, guard pauses and open
  positions. Preserve costs and requested/applied quantities.
- Validation: parity/repaint scope, independent evaluation periods, sensitivity,
  cost stress, sample adequacy, exposure of previous holdout, acceptance reasons
  and evidence freshness. Report unsuccessful trials, not just winning settings.

Keep job metadata in PostgreSQL and large immutable market/signal/equity artifacts
in protected versioned storage with references/checksums. Storage access checks
owner authorization on every read/export; hashes are not access tokens. Use
decimal strings and documented units for monetary interchange, UTC timestamps
and versioned schemas. Missing/deleted archived data must explicitly disable
exact reproduction rather than silently use replacement candles.

## Quant Data in the Best Inputs package

Step 5 retains two deliverables: Best Inputs package and Email Report.
The package gains an owner-downloadable data folder:

```text
inputs.json
strategy.pine
setup-guide.md
quant-data/
  manifest.json
  metrics.json
  equity.csv
  trades.csv
  decisions.csv
  validation.json
```

The manifest contains artifact schemas/checksums, dataset and engine references,
IDs, inputs/policy/cost assumptions, periods and limitations. Large OHLCV/signal
datasets may be a separately authorized optional download; references alone do
not promise portable replay when data or evaluator artifacts are unavailable.
Include how to distinguish native signals, intents, fills and position episodes.

Unsuccessful runs may export a clearly labelled diagnostic bundle, never an
actionable Best Inputs package or a simulated winner. Partial jobs label missing
files/metrics explicitly. No credentials, webhook bearer URLs or machine-specific
locations are included. Multiple-Pine manifests retain reproducibility metadata
under owner access; actionable settings still export only the shared Bridge pair.

## Portfolio Performance

Use actual Paper ledger/fills and strategy versions active at execution time.
Show cash, reserved cash, available cash, open quantity, cost basis, marked
market value, realized/unrealized PnL, fees, exposure and drawdown by Bot/asset.
Reserved cash is part of cash, not additional portfolio value; reconcile cash
and inventory once. Shared capital must have an allocation model before Bot
totals can be aggregated. Independent hypothetical balances must not be summed
as an actual owner portfolio.

Market valuation needs as-of prices and explicit price-age/availability flags.
Historical valuations use prices available at each historical point, not the
latest price applied retrospectively. Declare quote/FX conversion and timestamps.
Compute funding-aware returns (for example, a versioned time-weighted method)
so deposits/withdrawals cannot appear as strategy profit. Keep this reporting
valuation separate from current worker book-equity sizing. Open positions stay
marked at the cutoff unless a separately labelled simulated liquidation is used.

## Strategy Comparison and Best Performance

Offer two explicit modes:

1. Actual Bot performance: preserve each Bot's historical policy/inputs/capital
   and expose differences. This does not isolate strategy quality.
2. Standardized strategy evaluation: same asset/venue, common evaluation window,
   capital, policy, costs, execution/valuation conventions and declared comparison
   objective. Supported different signal timeframes need an explicit common
   pricing/valuation basis; incompatible runs are grouped separately or rejected.

Use compatible out-of-sample evidence. Comparing selected winners is itself a
selection step: record prior searches, exposed periods and all participants.
Previously used holdout cannot be reused as independent proof after new tuning.
Register the objective and risk/sample filters before ranking. Report net return,
Buy & Hold on the same price/cost basis, drawdown, costs, exposure, completed
episodes, rejected intents and robustness/uncertainty. Define benchmark trade
timing/costs and funding treatment explicitly.

Only qualified results may receive a best-in-scope label. Allow ties, inadequate
evidence and no qualifying strategy. A fixed weighted score is not assumed or
invented after viewing results. Reports state asset, dates, risk profile, costs,
coverage and evaluation basis. Viewing a report never starts or changes a Bot.

## Periods and data admission

Use the [Roadmap range contract](ROADMAP.md#report-range-and-50000-bar-contract)
for 1W/1M/3M/6M/1Y/YTD/All Time Registered/Custom. The approved target is 50,000
primary bars including evaluator-specific warm-up for each supported timeframe;
the currently implemented limit is still 10,000 with the existing narrow profile.
Do not expose a period/timeframe as supported solely because it fits the count.

Check limits before fetching/queuing, then verify actual coverage before replay.
Use paged exchange fetch/cache and incremental computation while carrying state
across chunks. Bound secondary timeframe dependencies and total memory/bytes/CPU,
candidate work and multi-asset requests separately. Never reset an Indicator or
risk counter at a pagination boundary. No silent truncation or resampling.

All Registered is each Bot's actual registration interval. Shorter Bot history
cannot become a longer actual performance report by adding synthetic fills.
Exchange history before registration is usable only as labelled simulation.
Account-ledger reporting has separate paging/retention limits; price capacity
does not authorize deleting/truncating accounting history.

## Explicit follow-up jobs

- Replay: reproduce the original data/settings/execution version; compare with
  the prior result and report mismatches. Verify availability and admission first.
- Backtest another period: fixed strategy/inputs on a newly frozen dataset.
- Optimize again: a new bounded research workflow with explicit owner request,
  source/input bounds, dataset roles, budget/seed and fresh validation plan.

Assign a new run ID and parent-run link, never overwrite the original. Imported
bundles are untrusted data: validate schema/checksums, owner/source capability and
artifact references; never execute an uploaded evaluator or accept credentials
from a bundle. A comparison references several runs through its participant
list, not a misleading single-parent chain. No scheduled/automatic retraining,
automatic winner deployment, guard reset or email enqueue is implied.
