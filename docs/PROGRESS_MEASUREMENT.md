# Project and prototype progress measurement

## Authority and baseline

Method PM-1, recorded 2026-10-15 (Asia/Bangkok) at the owner's request. Use this method for subsequent progress reviews. Roadmap continues to own scope, sequence and acceptance gates. This method grants no implementation, host, commit, push or deployment authority.

The first scored baseline is **NOT SCORED**. The weights below are planning judgments selected for consistent future comparison, not measured labor shares. Freeze the deliverable inventory and evidence before publishing the first calculated percentage. Do not choose scores or weights to reproduce a previous headline.

Two incompatible historical estimates exist:

- Chat reported project 70% (65–75%) and six-step prototype 85% (80–90%), referring to the 2026-10-06 handoff at `e43b755`. That handoff contains no percentage calculation or weighting table.
- Later Roadmap text reported project 60% (55–65%) and prototype 75% (70–80%). It also lacks a scored inventory that reconciles the difference.

Both remain historical, uncalibrated estimates. Neither is a PM-1 baseline or proof of a ten-percentage-point regression. Their ranges are not statistical confidence intervals. The first PM-1 result starts a new series; any comparison with these estimates must be labelled non-comparable.

## Two separate measures

Report **engineering progress** using the weighted formula below. Report **acceptance readiness** separately as the named required gates with PASS, OPEN, BLOCKED or UNKNOWN status and evidence. Do not turn a gate count into the engineering percentage. A high percentage never overrides a mandatory gate or owner GO.

Prototype scope is one owner, one Bot, one supported Pine, BINANCE:BTCUSDT Spot 1m and the existing 10K-bar limit. A correctly completed journey may report NO_VALID_CANDIDATE; profitability is not an acceptance condition. Full portfolio valuation, full export/email, broader multi-Pine, paid launch and Live are outside the minimal prototype.

Project scope covers the committed Paper product roadmap, including customer readiness. Optional Live is reported separately and excluded from this denominator unless the owner adds it through an explicit scope revision. These scopes follow the [prototype plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md) and [Roadmap](ROADMAP.md).

## Fixed category weights

### Whole Paper project

| ID | Capability and boundary | Weight |
| --- | --- | ---: |
| F01 | Owner identity, Bot lifecycle and shared Web UI | 10 |
| F02 | Single-Pine registry, AI Bridge, input binding and transport | 12 |
| F03 | Paper execution, Risk Manager, allocations and ledger correctness | 12 |
| F04 | Market ingestion, data provenance and historical Preflight including PF-3/PF-4 | 10 |
| F05 | Supported evaluator, selected-input parity and validation semantics | 12 |
| F06 | Bounded optimizer, immutable job snapshots, progress and cancellation | 10 |
| F07 | Recovery, scheduler isolation, resource accounting and R7 capacity qualification | 10 |
| F08 | Research Library, artifact durability and result freeze | 6 |
| F09 | Validated Best Inputs, export, email and explicit owner handoff | 6 |
| F10 | Portfolio performance, full fair comparison and qualified selection | 4 |
| F11 | Broader multi-Pine support and isolation | 4 |
| F12 | Production market-data scaling, customer security, entitlement and operational launch readiness | 4 |
| | **Total** | **100** |

### Six-step functional prototype

| ID | User outcome | Weight |
| --- | --- | ---: |
| P01 | Actual AI generation of the supported Bridge and guide | 15 |
| P02 | Eight selected source inputs plus ATR/RR with round-trip and supported effects | 15 |
| P03 | Historical Preflight and Risk proposals with policy provenance | 20 |
| P04 | Real TradingView transport and reconciled Paper BUY/targeted EXIT | 20 |
| P05 | One admitted bounded optimization with durable terminal outcome | 20 |
| P06 | Durable Library, compatible inspection/comparison and honest qualification status | 10 |
| | **Total** | **100** |

The two tables are different views and must never be added or averaged. Shared infrastructure may support several prototype steps, but does not become extra percentage points outside their fixed weights.

## Scoring and formula

Before scoring, divide each category into explicit deliverables with stable IDs, boundaries, target environment and acceptance criteria. Assign each deliverable a fixed share `q` of its category; shares within each category sum to 1. Do not score a broad category by intuition. Each deliverable belongs to exactly one category within each view. Reference a shared test or infrastructure deliverable instead of counting its implementation twice. Split cross-cutting work by distinct outcomes before assigning credit.

Each deliverable earns four evidence-based credits:

| Credit | Fraction | Evidence required |
| --- | ---: | --- |
| D — Definition | 0.10 | Root-reviewed contract, boundaries, dependencies and observable checks |
| I — Implementation | 0.40 | Complete implementation for the defined scope, with source identity and author checks |
| V — Independent verification | 0.30 | Independent review/checks on the applicable final bytes, and root acceptance within that scope |
| T — Target integration | 0.20 | Integration and readback in the environment declared before scoring, with retained evidence |

Each credit is 1 (earned), 0 (known not earned), or UNKNOWN (evidence not yet reconciled). No fractional credit inside a stage: split a large deliverable into bounded outcomes instead. Credits are cumulative: V requires D and I; T requires D, I and V. Separate known completion from unverified historical claims.

```text
s_i = 0.10*D_i + 0.40*I_i + 0.30*V_i + 0.20*T_i
E_view = sum over categories c [ W_c * sum over deliverables i in c (q_i * s_i) ]
sum(W_c) = 100; sum(q_i within c) = 1
```

`E_view` is already in percentage points. Example only: a deliverable with effective weight 10 and D/I/V earned but T open contributes `10 * 0.80 = 8` points. This is not a current project score.

Target integration is scope-specific. A local-only diagnostic can complete locally if that was its original contract; a staging feature needs staging evidence; a production release needs production evidence. Never relabel the environment after work finishes to obtain credit. Commit, CI, deployment and acceptance are separate facts. Old evidence may carry forward only with documented source and contract equivalence; it is not a fresh runtime-health claim.

For UNKNOWN credits, calculate lower and upper bounds using the lowest and highest values consistent with known credits and prerequisites. Keep unknown items in the denominator. Publish the bound interval and total effective weight of deliverables containing unknown credits; do not silently replace UNKNOWN with 0 or 1, drop it, or invent a midpoint. Publish a single score only after every credit is determined. Round displayed scores to whole percentages; retain unrounded arithmetic for deltas. Do not attach an arbitrary plus/minus range.

## Review record

Retain one dated, immutable scorecard per review, linked from Roadmap and Time Management. Record:

- Date and timezone, method version, inventory version, branch/commit and any relevant uncommitted file hashes.
- Both scope definitions and exclusions, fixed category weights and deliverable shares.
- For every deliverable: ID, category, description, target environment, D/I/V/T values, evidence links, verifier/root decision, open gates and next action.
- Calculated scores or bounds, unknown weight and named acceptance gates. No fabricated historical scores.
- Prior scorecard, changed rows, signed percentage-point contributions and reasons. Preserve superseded evidence and failed runs.

Suggested row format:

| ID | View/category | Share q | Outcome / target | D | I | V | T | Evidence / source | Open gate / next action |
| --- | --- | ---: | --- | --- | --- | --- | --- | --- | --- |
| To be inventoried | — | — | — | UNKNOWN | UNKNOWN | UNKNOWN | UNKNOWN | — | First baseline pending |

## Comparison and scope changes

For unchanged scope and weights, report `delta = E_current - E_previous` and explain changed deliverables. Fixing a defect restores or earns the affected credit; it does not create a bonus category. A newly discovered defect may revoke affected credit, with evidence and impact recorded. Repeated tests and additional agents earn no extra credit by themselves.

If scope, weights, shares, target environments or scoring rules change, increment the inventory or method version. Preserve the old scorecard. Where evidence permits, recalculate the previous and current snapshots under the new basis and show separately (1) the basis-change effect and (2) progress under the same basis. If that reconstruction is unavailable, mark the series non-comparable. Never describe an unexplained change of denominator as lost progress, and never freeze a score merely to prevent an evidenced decrease.

Diagram colors describe the labelled outcome, not an arithmetic input: green means completion proved for that exact scope; yellow means started/partial or an open gate; grey means planned and not started. A green local component does not make its parent release green. UNKNOWN must be written explicitly, not hidden as grey.

## Next review

Root inventories deliverables and evidence under these weights, freezes the initial scorecard, checks arithmetic and source applicability, then publishes the first PM-1 result alongside the open gates. Current method adoption changes no product acceptance or runtime state. Host evidence is collected only under the existing per-step owner GO rules; missing host evidence stays UNKNOWN or an explicitly unrun stage.
