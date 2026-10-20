# QR-2 actual Paper portfolio performance contract

Status: owner decisions O1-O16, D4 and OD-Q1, OD-Q8, OD-Q9, OD-Q10, OD-Q13, OD-Q14, OD-Q15, OD-Q18 recorded 2026-10-19; root decided R-A to R-F, OD-Q6, OD-Q12 and OD-Q17 the same day. Root accepted the other rules after independent review. Root clarifications RC-Q1 to RC-Q27 from the QR-2 S0/S1 and S2 reviews are recorded in section 15 (2026-10-19); they change no owner decision. The S1 pure library (src/portfolio) and the S2 read-only reader (src/postgres/qr2-reader.js) are root-accepted as local engineering evidence; neither is wired into any route, worker or view. Root decided the S3 route design on 2026-10-20 (RC-Q28 to RC-Q34), and slice S3a (the per-Bot route, off by default) is root-accepted as local engineering evidence and enabled nowhere; slice S3b (the computation in a worker thread, RC-Q35 and RC-Q36) is root-accepted as local engineering evidence the same day, and the route stays off everywhere; sub-slices S4-1 (the capital-model declaration extension, RC-Q37) and S4-2 (the pure owner-total allocation module, RC-Q38) are root-accepted as local engineering evidence the same day, are provisional until the owner decides the S4 items, and nothing is installed or routed; owner item O-1 (which periods the plan history limit applies to) is open, and the stricter reading applies meanwhile. Nothing here changes the ledger, the Overview tile or any Bot.

This contract grants no capability, is not a GO and earns no PM-1 credit by itself. Commit, CI, deployment and acceptance are separate facts. The decisions are listed in the "Decisions" table in section 15.

Code base for the facts below: branch `codex/app3a-market-wait-checkpoint`, working tree as found on 2026-10-19. Line numbers are current and are given for learning interfaces only.

---

## 0. Reading key

- `[SRC: path § section]` marks a rule taken from a tracked source. `CODE:` marks a fact read from current code. A code fact is for learning interfaces; it is not acceptance evidence.
- `Ox` refers to an owner decision of OD § F. `D4` refers to OD § B. `OD-Qn` refers to an additional decision item. `R-x` refers to a root decision. All are recorded in section 15.
- Short names: ROADMAP = `docs/ROADMAP.md`; QRL = `docs/QUANT_RESEARCH_LIBRARY.md`; OD = `docs/OWNER_DECISIONS_2026-10-13.md`; INV / SC = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json` / `docs/progress/PM1_SCORECARD_S1_2026-10-15.json`; LEDGER = `src/postgres/ledger.js`; SCHEMA = `src/postgres/schema.sql`; BARS = `src/postgres/market-ohlcv.js` and table `pine_market_bars`; QL4 = `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md` (style and gate conventions only).
- Name collision: "O3" in OD § F is the QR-2 decision on unbacked configured equity. "O3" in the ledger evidence (`docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json`) is the exit-scale defect, whose fix form is OD § G D9. This contract writes "QR-2 O3" and "ledger fix O3 (D9)" to keep them apart.

Scope guard for every rule: Spot/Paper only; BINANCE:BTCUSDT Spot 1m is the only priced market; funded long BUY and reduce-only SELL/EXIT; no Live; no automatic optimizer loop; no guard reset; no automatic Best Inputs apply. Viewing a report never starts, changes or sizes a Bot. [SRC: AGENTS.md § Host and product safety; QRL § Strategy Comparison and Best Performance] Every QR-2 number is an engineering fact about a simulated Paper ledger. No QR-2 number is a profitability claim, a recommendation or qualified evidence, and the view says so.

---

## 1. Scope, acceptance and safety

### 1.1 Acceptance targets

PM-1 F10-01 acceptance: "A complete portfolio view reconciles actual Paper history, valuation and costs for the declared range." [SRC: INV § F10-01] SC gives D UNKNOWN, I 0, V 0, T 0. The D rationale says the approved design leaves allocation and versioned return details unresolved. The next action is to finalize the allocation, valuation and return contract, then implement QR-2. [SRC: SC § F10-01] This contract answers those gaps in section 4 (allocation), section 3 (versioned returns) and section 6 (reconciliation).

ROADMAP QR-2 gate, as testable rules: [SRC: ROADMAP § Approved extension, row QR-2]

- A1 Stale or missing prices are explicit states. No silent fallback to cost, to a later price or to another source.
- A2 Shared capital is never counted twice in any total.
- A3 Ledger and valuation reconcile under exact decimal rules; a mismatch is visible and blocks the affected numbers.
- A4 Historical simulation (research, Preflight, risk scenarios, PF-4 proposals) is never labelled actual Paper execution.

QRL binding requirements [SRC: QRL § Portfolio Performance]: actual Paper ledger and fills; strategy versions active at execution time; cash, reserved cash, available cash, open quantity, cost basis, marked market value, realized and unrealized PnL, fees, exposure and drawdown by Bot and asset; reserved cash is part of cash; an allocation model before Bot totals aggregate; as-of prices with age and availability flags; declared FX and timestamps; funding-aware returns; reporting valuation separate from worker book-equity sizing; open positions marked at the cutoff unless a separately labelled simulated liquidation is used.

Meaning of "complete": for one declared range, every number in the view either (a) derives from named ledger rows and named price rows by a versioned rule and passes every blocking check of section 6, or (b) is `null` with a stated reason. No number is estimated, interpolated, zero-filled or carried back from a later time.

### 1.2 Safety envelope

QR-2 reads the ledger. It never writes a ledger table, never feeds a value back into sizing and never blocks trading. Risk Manager, worker sizing, `recordExecution`, `recordFunding`, `paperAccount` and `exposure` are unchanged. The only writes QR-2 causes are audit rows after commit (6.7) and, in later optional slices, owner declarations and frozen reports in new tables.

A QR-2 read takes no `users` lock and never calls `bumpPaperLedgerFence` (CODE: LEDGER `bumpPaperLedgerFence`, lines 15-18). A read therefore never makes a fill or funding writer roll back through the F4 fence.

QR-2 does not need the F4, ledger fix O3 (D9), G1 or W1 fixes to be correct, because replay selects the ledger rule per fill (6.2). The deployment order of those fixes relative to QR-2 staging integration is decided by OD-Q17 (section 15).

### 1.3 Relation to F10-02 (QR-3) and F10-03 (QR-4)

- QR-2 is the QRL mode "Actual Bot performance". It keeps each Bot's own policy, inputs and capital, and it does not isolate strategy quality. [SRC: QRL § Strategy Comparison and Best Performance, mode 1]
- Every view publishes a machine-readable valuation context: contract version and every method id of 7.4; price source and age policy; drawdown grid id; ledger rule epochs met (6.2); fee source `RECORDED_ONLY`; requested and resolved range; currency and `fx: NONE`; capital-model declaration version. QR-3 compares two QR-2 views only when the contexts match field by field. [SRC basis: INV § F10-02, compatible contexts]
- QR-2 never feeds the QR-3 standardized evaluation mode. Actual history and simulation never mix in one comparison. [SRC: QRL § Strategy Comparison, mode 2; ROADMAP § row QR-2]
- QR-2 has no ranking, winner or "best" output. Every view carries `qualified_evidence: false`. QR-4 may cite a QR-2 view only as actual-history context. [SRC basis: INV § F10-03; SC § F10-03]
- QR-2 shows no Buy & Hold line; QR-3 owns benchmarks (OD-Q15). [SRC basis: QRL § Strategy Comparison, benchmark timing, costs and funding defined explicitly]

---

## 2. Valuation model and price source

### 2.1 Price at an instant

For a valuation instant T (UTC epoch ms): the stored bar for (`binance-global`, `BTCUSDT`, `'1'`) with the largest `bar_time <= T`. `bar_time` is the close time + 1, so the bar covers `[bar_time - 60000, bar_time)` and was final before T. [CODE: BARS time convention] Verify per use, with the existing helpers (CODE: `src/postgres/pine-bridge-market.js` `verifiedBar`; `src/pine-bridge/market-data.js` `INVALID_MARKET_BAR`):

- the bar parses;
- the bar rules hold (`low > 0`, `low <= open, close <= high`, `volume >= 0`);
- `content_hash` equals the hash of the canonical bar;
- `bar.time` agrees with `bar_time`.

A failure is `PRICE_INTEGRITY_FAILED`, and the price is unavailable. Nothing is substituted. The hash check stays per read: the runtime role cannot write the table, and both writers are insert-only, but no database trigger stops the writer role.

Price states and age (age = `T - bar_time` in ms): [SRC: OD § F, O1; BARS constants 180 s and 900 s]

| State | Rule | Effect |
| --- | --- | --- |
| `FRESH` | age `<= fresh_ms` (180 000) | Value used. |
| `STALE` | `fresh_ms` < age `<= carry_ms` (900 000) | Value used, flagged with age. Returns still computed (O1). |
| `UNAVAILABLE` | age `> carry_ms`, or no row | No market value at T. |
| `PRICE_INTEGRITY_FAILED` | a verification failure | No market value at T. |
| `UNSUPPORTED_MARKET` | any (broker, symbol) other than `binance-global` / `BTCUSDT` | Quantity and cost visible; market value and unrealized PnL null (O6). |
| `NO_POSITION` | quantity is zero at T | Market value exactly 0. No price needed. |

`carry_ms` (900 s) is the hard cutoff (O1). A price older than `carry_ms` is `UNAVAILABLE`, never carried.

Root clarification RC-Q17 (age first): the age test runs before the integrity verification of the bar. A bar older than `carry_ms` is `UNAVAILABLE` with the information reason `PRICE_OLDER_THAN_CARRY` and its integrity is reported unverified; it is not read as `PRICE_INTEGRITY_FAILED`.

Root clarification RC-Q9: a malformed `bar_time` in the candidate set is a conservative whole-set `PRICE_INTEGRITY_FAILED` (fail closed); no other bar is substituted.

### 2.2 What the bar provenance proves

Both writers store `provenance.retrieved_at`, the fetch time, taken before the INSERT and the commit. [CODE: `src/pine-bridge/market-data.js` lines 55, 75; `scripts/stream-pine-bars.mjs` line 47] `retrieved_at > T` proves the bar was not stored at T. `retrieved_at <= T` is a lower bound only. Older rows may lack the field.

### 2.3 Price availability rule (O15)

Method id `btcusdt-1m-close-asof-market-v1` (option M, decided): the price is the bar of 2.1 whatever its `retrieved_at`. Each resolved price carries the information field `retrieval`: `RETRIEVED_BY_INSTANT`, `RETRIEVED_AFTER_INSTANT` or `RETRIEVAL_TIME_UNKNOWN`. The field never changes the number. The UI shows "price recorded later" for `RETRIEVED_AFTER_INSTANT`.

Option R, method id `btcusdt-1m-close-asof-retrieved-v1` (not selected): only bars with `retrieved_at <= T` are candidates; a bar without `retrieved_at` is usable and labelled `HISTORICAL_RECOMPUTE`.

A change of option is a new method id and never rewrites a frozen report.

### 2.4 Clock and ordering states

`FUTURE_TIMESTAMP` (a ledger row stamped after the report read time) and `FILL_BEFORE_BAR` block the affected account. Root clarification RC-Q17: `FILL_BEFORE_BAR` is defined for slice S2 as `fills.received_at` earlier than the signal bar close; it is `FILL_BEFORE_BAR_UNCHECKED` (information) when the signal has no bar time. Until S2 it stays a todo. `ORDER_UNPROVEN` and `ORDER_AMBIGUOUS` are in 6.4.

### 2.5 Market value, NAV and exposure (identities)

For one account at instant t, every sum is over events with event time `< t` (2.6):

```text
F_cash(t) = Σ paper_funding.cash_delta            (both kinds)
J(t)      = Σ paper_cash_journal.cash_delta
cash(t)   = F_cash(t) + J(t)
MV(t)     = Σ_symbol round18(qty × price)  if qty > 0;  0 if flat;  null if price UNAVAILABLE,
            PRICE_INTEGRITY_FAILED or UNSUPPORTED_MARKET
NAV(t)    = cash(t) + MV(t)                 (reserved cash is inside cash, never added)
R(t)      = Σ realized PnL of exits < t
U(t)      = MV(t) - cost(t)                 (net of entry fees, gross of any future exit fee)
```

Market value is rounded once per position per instant to 18 places, half-even (decimal rules in 6.6).

Exposure (QRL requires it): `MV(t) / NAV(t)` when both exist and `NAV(t) > 0`. An account without a price shows `EXPOSURE_AT_COST = cost / (cash + cost)`, labelled.

Reserved and available cash: `available_cash = cash - reserved_notional - reserved_fees`, from `exposure()` at request time only. A historical end gives `null` with `RESERVATION_HISTORY_NOT_RECORDED`, because reservations are not stored as history. Flags `feeReservationUnknown` and `uncertain` give `PENDING_ORDER_UNCERTAIN` (check R15).

### 2.6 Event time and range boundaries

- Event time is `paper_funding.at`, `paper_cash_journal.at` or `fills.received_at`. These are ledger write times, not market or signal times. A late booking is valued at its booking time. Root clarification RC-Q15: a fill and its paired journal row are one event at `fills.received_at`; the journal row's own `at` is not used for ordering, and `inputs_hash` filters journal rows by the paired fill's `received_at`. Same millisecond (RC-Q17): a funding row sorts before a fill.
- State at instant t uses events with event time `< t`. Flows in a range are those in `[from, to)`.
- Reason: ROADMAP freezes UTC half-open intervals, and O9 sets an exclusive end at 00:00Z. [SRC: ROADMAP § Report range and research capacity contract; OD § F, O9] A flow window `(T0, T1]` would give a flow at exactly the next 00:00Z to two periods. The rule `[from, to)` counts a flow at `from` once and gives a flow at `to` to the next range.

---

## 3. Funding-aware returns

Flows are `paper_funding.cash_delta` of `kind = 'CONFIGURATION'` (O11). Unbacked configured equity (`Σ equity_delta - Σ cash_delta`) is outside NAV and shown on its own line (QR-2 O3). An equity-only `CONFIGURATION` change moves only that line, never NAV. No IRR (O4). Money precision is 80 digits, half-even; each return is rounded once at output to 12 places.

### 3.1 Money PnL (headline)

Method id `money-pnl-flow-v1`:

```text
money_pnl = NAV(to) - NAV(from) - Σ flows in [from, to)
```

It is always shown when both NAV values exist and the account is reconciled, with or without a TWR. It is null when either NAV is null. By 2.5 it equals `ΔR + ΔU`, which check RI verifies.

### 3.2 TWR `twr-flow-split-v1`

- Cut `[from, to)` at each distinct flow time `f_1 < … < f_n`. Flows at the same instant are summed.
- `V_start(f_k) = NAV(f_k) + flow_k`, where `NAV(f_k)` uses events before the flow (2.6).
- Sub-period return `r = V_end / V_start - 1`; `V_end` is the NAV just before the next cut, or at `to`.
- `TWR = Π(1 + r_k) - 1`.
- A null boundary NAV gives `TWR_BOUNDARY_UNVALUED`. No partial product is shown.
- Empty sub-period rule: a sub-period with start value zero is skipped only when it contains no fill and no position. Any other start value `<= 0` gives `NON_POSITIVE_BASE`. A first deposit into an empty account is valid.
- Same-millisecond flow and fill that cannot be ordered by 6.4 give `ORDER_AMBIGUOUS` for the affected sub-period only when the order changes the result.

### 3.3 Modified Dietz `mwr-modified-dietz-v1`

Labelled "Modified Dietz (approximation; secondary)":

```text
w_k = (to - t_k) / (to - from)
MD  = money_pnl / (NAV(from) + Σ w_k × flow_k)
```

It needs prices only at the range ends. A denominator `<= 0` gives `NON_POSITIVE_BASE`.

### 3.4 Drawdown

Drawdown is computed on the flow-neutral TWR index, so a withdrawal is not a drawdown. Grid `qr2-grid-daily-events-v1` (OD-Q13): resolved `from`, every 00:00Z inside the range, every fill and flow time, and `as_of`. The label says "sampled; intraday extremes between grid points are not included". Root clarification RC-Q17: the grid end is the resolved `to` (not `as_of`), and drawdown is a positive fraction of the peak. Any unvalued grid point while a position is open gives `DRAWDOWN_GRID_UNVALUED`; no gap is skipped. This drawdown is distinct from the analytics `REALIZED_FIFO_EXCLUDING_CASH_FLOWS` and from the PHASE0 realized drawdown; their labels never match. [SRC: docs/PHASE0.md; CODE `analyticsCapital`]

### 3.5 Period boundaries (O9) and coverage start

- UTC, exclusive end at 00:00:00.000Z. Day; ISO week from Monday 00:00Z, labelled "Week (Mon-Sun, UTC)"; calendar month; calendar year; custom `[from 00:00Z, to + 1 day 00:00Z)`. These are QR-2's own window functions; the analytics rolling 7 days must not share the label.
- All Time Registered "begins at registration with actual coverage". [SRC: ROADMAP § Report range; QRL § Periods and data admission] Resolved coverage starts at `max(from, users.created_at)` (CODE: SCHEMA `users.created_at BIGINT NOT NULL`) and the view reports `first_funding_at` beside it (OD-Q1). The first TWR sub-period with value zero before the first funding row is skipped by the empty sub-period rule, so returns equal a first-funding start. Legacy history before `S_cash` keeps its 6.3 state, so a legacy account is never silently shortened.
- A `to` later than the request time is resolved to the request time; the response shows the flag `RANGE_END_AT_REQUEST_TIME` and keeps the requested range in the header next to the resolved range (OD-Q18, owner, 2026-10-19). `to <= from` is refused `QR2_RANGE_INVALID`. A `from` before coverage start gives the requested and resolved intervals with `COVERAGE_STARTS_AFTER_REQUEST`. Shorter history never becomes a longer report through synthetic rows. [SRC: QRL § Periods and data admission] Root clarification RC-Q17: coverage starting at or after `to` gives resolved range `null` and `UNAVAILABLE` with `COVERAGE_STARTS_AFTER_REQUEST`. Root clarification RC-Q22 (period start instant): a range whose `from` equals the request time (a current period requested at its exact start) resolves to `null` with status `UNAVAILABLE` and reason `RANGE_EMPTY_AT_REQUEST_TIME`, without an exception; a range whose `from` is later than the request time stays refused `QR2_RANGE_INVALID`. Tests cover current Day, Week, Month, Year and a custom range with `to` after the request time, and both `from` cases of RC-Q22.
- The view reports `as_of` and `event_time_basis: LEDGER_WRITE_TIME`. The cutoff is never moved for a missing price; only the numbers that need the price become null.

### 3.6 Periods affected by legacy history or ledger violations

- A period that starts before the cash seed `S_cash` (6.3) has no return, `LEGACY_FUNDING_HISTORY_UNAVAILABLE`. Root clarification RC-Q17: a period starting exactly at `S_cash` also gets this label, and `nav_from = S_cash + 1` when an M2 row exists.
- A period that intersects a ledger-invariant violation span (6.5) has no return, `LEDGER_INVARIANT_VIOLATED` (O16). Money facts stay visible and labelled.

### 3.7 Never provided

IRR; annualized figures (OD-Q14); Sharpe-type ratios; a percentage over an unknown, legacy-tainted or non-positive base; a return on book equity or on R multiples.

---

## 4. Shared capital and aggregation (O2)

### 4.1 Fact

Each (Bot, broker) Paper account has its own funding, journal and positions. No pool, transfer or allocation record exists. The ledger cannot tell two independent 10 000 USDT balances from one pool counted twice. QRL forbids summing independent hypothetical balances as an actual owner portfolio. [SRC: QRL § Portfolio Performance] An owner set is the owner's own `users` row plus every row whose `parent_user_id` is the owner (CODE: SCHEMA `users`; confirmed by R-E).

### 4.2 V1 rule: capital-model declaration

| `capital_model` | Owner total |
| --- | --- |
| `INDEPENDENT_ACCOUNTS` | Per-currency arithmetic sum of NAV, flows, fees and money PnL, labelled `SUM_OF_INDEPENDENT_PAPER_ACCOUNTS` and "not an owner portfolio". No owner TWR or Modified Dietz (OD-Q8): `ALLOCATION_INDEPENDENT_NO_RETURN`. |
| `SHARED_HYPOTHETICAL` | None; per-Bot rows only, `NOT_AGGREGABLE_SHARED_CAPITAL`. |
| (no declaration) | None; `CAPITAL_MODEL_NOT_DECLARED`. |

Rules:

- The declaration, not any row invariant, prevents the double count. Row checks RX (6.6) detect duplicate or foreign rows.
- An owner total exists only when every member account is priced (`FRESH`, `STALE` or `NO_POSITION`) and reconciled. One null member makes the total null with the list of reasons. No partial total.
- Totals never cross currencies; a cross-currency total is refused `QR2_CURRENCY_MIX`.
- A declaration is versioned and append-only, covers one currency and one Bot set, and applies only from `effective_from` forward, never retroactively (OD-Q9). If the Bot set changes inside the range, a total exists only where the set equals the declaration; elsewhere `ALLOCATION_SET_CHANGED`. Missing Bot history is never zero-filled. [SRC: ROADMAP § Report range, without zero-filling missing history]
- Storage: one new table in S4 (7.2), written only through an owner route with step-up, audited.

### 4.3 Later option: declared pool with sleeves

A pool model with sleeves is optional slice S4b, started only if the owner chooses it under O2 option 2. A `pool_cash` variant belongs to the same S4b option; it is not a v1 rule.

### 4.4 Per-Bot first

S1-S3 are per-Bot and per-broker only. No QR-2 route and no UI change emits an owner total before S4 and a recorded declaration. Until a declaration exists, a multi-Bot owner gets per-Bot views only; that still meets the F10-01 sentence per Bot.

---

## 5. Current state

Nothing of QR-2 is implemented. The facts below are read from the current tree and from tracked sources.

- The Overview tile and `public/bots.js:129` still show book equity (cost basis based), and the tile sums `parseFloat(bookEquity)` across USDT and THB. This contract changes neither.
- CODE: `recordFunding` takes `SELECT id FROM users WHERE id=? FOR UPDATE` (LEDGER line 28), then bumps the fence on every call (line 30, D3), writes one `CONFIGURATION` row and one `FUNDING` snapshot per changed broker (lines 40-41), and skips zero deltas.
- CODE: `recordExecution` takes the same `users` lock (line 121) and the signal lock (line 122), then bumps the fence (line 127). Paper writes for one Bot are therefore serialized, and the commit-order argument of 6.4 holds.
- CODE: a BUY lot gets `position_id = 'pos_' + signal id + '_' + Date.now()` (line 153). The id cannot be reproduced from fills, so the stored lot rows remain the lot universe (6.2).
- CODE: a targeted SELL matches `entry_trade_id = target OR position_id = target` and throws when no lot is open (lines 172-181); a targeted overfill throws (lines 216-218). Lots are ordered by `opened_at` only (finding G5).
- CODE (G1 fix, 6ef8045): a FIFO SELL larger than the open lots, with lot cost above zero, charges the uncovered part at the average cost of the unlotted rest (lines 231-238). Zero-cost lots count as no lots.
- CODE (ledger fix O3, D9): a partial exit rounds removed cost once to 18 places; a full close removes the whole position cost (lines 222-239). At a full close with divergence above 1e-12 the ledger writes audit `ledger.cost_divergence` (line 227).
- CODE (D10): when removed cost exceeds position cost, cost becomes 0, removed becomes the prior cost, audit `ledger.cost_clamped` is written, and profit uses the removed amount (lines 241-249).
- CODE: the pre-fix rule at `b9d19e3` set `cost` to 0 on a negative result but computed profit with the unclamped `removed`. Under that rule a clamp breaks `cash + cost = F_cash + R` by the clamped amount.
- CODE: the response marker `ledgerRule` is `'paper-exit-cost-o3-v1'` at a577689 and `'paper-exit-cost-v2'` from 6ef8045 on (line 281). It is written into `signals.broker_response` by `complete()` only on calls that book a fill. A later booking call overwrites it, and a later zero-quantity status update writes the raw response without it. The marker is therefore per signal and can disappear; it cannot prove the rule of a fill.
- OD § G: the O3, W1, G1 and F4 fixes are committed and pushed to `codex/app3a-market-wait-checkpoint`, not main, and not deployed. From 40e3b6b on, the API and the worker refuse to start without the fence table. RO1 found no damage yet; production held 352 open lots for 4 owners, with symbols other than BTCUSDT. [SRC: OD § G; docs/evidence/PAPER_EXIT_SCALE_O3_LOCAL_2026-10-13.json § followUps RO1] RO2 later ran Q1-Q7. [SRC: docs/evidence/PAPER_LEDGER_RO2_READ_ONLY_2026-10-15.json]

Consequence: findings G1 (partial lot coverage), the silent clamp and the scale throw are fixed in code for new fills, but not deployed. History on staging and production was written by older code. The deployed code version was not compared (OD § G). Replay therefore needs per-fill rule epochs (6.2).

---

## 6. Ledger versus valuation reconciliation

### 6.1 Read consistency

Inside an API request the reader joins the request transaction (SERIALIZABLE for non-webhook requests, CODE: `src/postgres/request-dispatch.js` line 83) and runs `SET TRANSACTION READ ONLY` before its first read, as the overview does (CODE: `src/postgres/overview.js` lines 9-13). Standalone, it opens its own REPEATABLE READ, READ ONLY transaction. The view takes no `users` lock, never bumps the fence and writes nothing. The report records a ledger cutoff: max `paper_funding.id`, max `paper_snapshots.id`, per account the fill count, max `(received_at, signal_id, cumulative_quantity)` and the lot count.

### 6.2 Replay with rule epochs

Scope: one account (Bot `user_id`, broker), `account_id = broker + ':primary'`, `execution_mode = 'PAPER'`.

Inputs:

- Fills joined to `signals` (side, symbol, `trade_id`, payload), ordered by `(received_at, signal_id, cumulative_quantity)`; R3c verifies the order against commit order.
- Stored lots: every `ledger_position_allocations` row of the scope, using only fields that no code updates after INSERT (`position_id`, `entry_signal_id`, `entry_trade_id`, `filled_quantity`, `entry_price`, `opened_at`, `symbol`). Replay rebuilds `remaining_quantity` and `status` only.
- L1 binding (exact): per signal, BUY fills by `cumulative_quantity` bind pairwise to its lots by `(opened_at, position_id)`; a bound pair needs `filled_quantity = delta_quantity` and `entry_price = round18((quote_amount + fee_quote) / delta_quantity)`. Violations: `LOT_BINDING_MISMATCH`, `NO_LOT` (BUY strictly before the lot-table cutoff, not a failure), `ORPHAN_LOT` (a lot with no BUY fill).
- Root clarification RC-Q17 (L1 bind-to-last): `NO_LOT` applies only to BUY fills earlier than the account's earliest lot `opened_at`; a later unbound BUY is `LOT_BINDING_MISMATCH` (`SPLIT_NULL` for the symbol). Root clarification RC-Q18 (lost lot table): `cutoff = min(earliest lot opened_at, lotTableBoundary when recorded)`. An unbound BUY at or after the cutoff is `LOT_BINDING_MISMATCH` (`SPLIT_NULL`); only a BUY strictly before the cutoff may be `NO_LOT`. Tests: lots `[]` with `lotTableBoundary` 1000 and a BUY at 5000 gives `LOT_BINDING_MISMATCH`; a BUY exactly at the earliest lot `opened_at` gives `LOT_BINDING_MISMATCH`. The event note of a BUY classified `LOT_BINDING_MISMATCH` is `LOT_MISSING`, never `NO_LOT`.
- Root clarification RC-Q13 (lot `entry_price` epochs): lots opened before the recorded lot-fee boundary use the earlier formula `round18(quote_amount / delta_quantity)` (fee excluded, as written by 9a87ab6); lots at or after it use `round18((quote_amount + fee_quote) / delta_quantity)` (b74ba50). The boundary is an input parameter like the other epoch boundaries. If it is absent and a lot fails the current formula, report `LOT_EPOCH_UNKNOWN` and `SPLIT_NULL` for the symbol (fail closed, visible).

Rule epochs:

| Epoch | Lot method id | Rule source | Applies to |
| --- | --- | --- | --- |
| E0 | `ledger-stored-lots-target-fifo-fallback-v1` | the E0 SELL steps below, which mirror `b9d19e3` | fills booked before the first fix deployment on that environment |
| E1 | `paper-exit-cost-o3-v1` | a577689: ledger fix O3 rounding and full-close removal, no G1 term | only if root's deployment evidence shows a577689 code ran on that environment |
| E2 | `paper-exit-cost-v2` | current code: target or FIFO, G1 unlotted average cost, ledger fix O3 (D9), clamp with profit on removed (D10) | fills booked at or after the v2 deployment on that environment |

- The epoch of a fill is chosen by its `received_at` against a per-environment boundary that root records from deployment evidence (OD-Q6). The `ledgerRule` marker is corroboration only, because it is per signal and can be overwritten (section 5).
- A fill whose epoch is unknown, or whose replay under its epoch does not reconcile, makes the account `LEDGER_RULE_UNREPLAYABLE` from that fill onward. Replay never tries a different epoch to make a fill reconcile.
- Root clarification RC-Q17: `LEDGER_RULE_UNREPLAYABLE` means an unknown epoch, or a replay closure (RT) failure at that fill. R3c stays diagnostic and never sets it. Marker versus boundary: the boundary wins; a marker that `DISAGREES` is information and is counted.
- Root clarification RC-Q14 (E0 pre-lot fills): a fill before the recorded lot-table boundary replays with `targetTradeId` ignored, as the ledger booked it. If that boundary is absent, the current halt stays.
- Every future ledger-rule change must introduce a new marker value and a new epoch row.

E0 SELL steps (mirror `b9d19e3` LEDGER lines 145-230). Steps 1 to 5 are the same as the E2 steps below. Root clarification RC-Q17: E1 reuses `PARTIAL_LOT_COVERAGE` with the uncovered amount.

6. Removed cost: `allocated > 0` gives `removed = allocated`, not rounded; a FIFO exit with `still_to_close > 0` reports `PARTIAL_LOT_COVERAGE` with the uncovered quantity. `allocated = 0` reports `NO_LOT_FALLBACK`, and gives `removed = cost` when the new quantity is zero, else `round18(cost × q / old_quantity)`.
7. `cost -= removed`; if `cost < 0`, set `cost = 0` and report `COST_CLAMPED` with the amount. `removed` does not change, so profit uses the unclamped removed cost.
8. `quantity -= q`; realized PnL `+= quote - removed - fee`. Quantity zero with `cost > 0` is `RESIDUAL_COST_AT_FLAT`.
9. A replayed cost with more than 18 decimal places at a write point is `SCALE_DIVERGENCE`; the ledger wrote `exact(cost)` and would have thrown.

E2 SELL steps (mirror LEDGER lines 167-249):

1. `q > quantity` is `SELL_EXCEEDS_POSITION`.
2. Target from the stored payload: candidates are replay-open lots with `entry_trade_id = target OR position_id = target`; none is `TARGET_UNRESOLVED`. Without a target, all replay-open lots of the symbol.
3. Order by `opened_at`, ties by `position_id`; a tie that changes the outcome is `LOT_ORDER_AMBIGUOUS` (G5). Root clarification RC-Q17: a tie group consumed in part with different entry prices gives `SPLIT_NULL`; equal entry prices are information only, and R6 compares the group's summed remaining quantity.
4. Consume: `take = min(remaining, still_to_close)`; `allocated += take × entry_price` (unrounded).
5. A target with `still_to_close > 0` is `TARGET_OVERFILL`.
6. Removed cost: new quantity zero gives `removed = cost` (and `ledger.cost_divergence` is expected in the audit table when lot cost and position cost differ by more than 1e-12); FIFO with `still_to_close > 0` and `allocated > 0` gives `removed = round18(allocated + (cost - allocated) × still_to_close / (old_quantity - Σ taken))`, reported as `G1_UNLOTTED_CHARGED`; else `allocated > 0` gives `round18(allocated)`; else `round18(cost × q / old_quantity)`, reported as `NO_LOT_FALLBACK`.
7. `cost -= removed`; if `cost < 0`, set `cost = 0`, `removed = prior cost`, report `COST_CLAMPED` with the amount, and expect a `ledger.cost_clamped` audit row. Root clarification RC-Q6 (per cycle, OD-Q10): a replayed `COST_CLAMPED` finding carries the position-cycle bounds `{symbol, from: cycle open time, to: flat time or null while open}`. `SPLIT_NULL` applies only to ranges that intersect that cycle. Root clarification RC-Q6 (cumulative values, round 4): for a clamp cycle of a symbol, the cumulative realized PnL (`nav.realized` and any cumulative realized or cost balance of that symbol) is null at every instant at or after the cycle's `from` time, because it contains the clamped cycle's PnL. A range delta wholly after a closed cycle that does not need those cumulative values stays available. NAV, cash and returns are not affected. Tests: a range before, inside and after a clamped cycle; cumulative realized PnL null at and after the cycle start.
8. `quantity -= q`; realized PnL `+= quote - removed - fee`.

Under E0 a `COST_CLAMPED` event breaks the identity by the clamped amount; check RI records that amount as a labelled E0 difference instead of failing (section 5). Root clarification RC-Q4: parity is tested against frozen read-only copies of the `recordExecution` SELL branches of `b9d19e3` (E0) and `a577689` (E1), and against E2, with the same random-sequence method (section 13).

Replay is a pure function over decimal strings and is the reporting source of quantity, cost, realized PnL and fees at any instant. The analytics `fifoAnalytics` ignores targets; if its realized PnL differs, the view shows `REALIZED_METHOD_DIFFERS_FROM_ANALYTICS` with both values. NAV, money PnL and returns do not depend on the lot method.

### 6.3 Legacy accounts (O7)

Markers M1 (`legacy_float = 1`), M2 (`LEGACY_BASELINE` funding row), M3 (a fill without a journal row, or the reverse). Rule `legacy-two-seed-v1`:

- `S_cash` = the `at` of the last M2 row, else account start. NAV, TWR, N1 and N2 run only at or after `S_cash`. Before it: `RECONCILIATION_UNAVAILABLE_LEGACY`; R1 and R2 are information only.
- `S_cost` = the first instant at or after `S_cash`, and after the last M1 fill, at which every symbol's replayed quantity is exactly zero. Cost, realized and unrealized PnL, R5-R7, R13 and R3c run only after `S_cost`. Between the seeds: cash, quantity, NAV and returns are shown if R1, R2 and R4 hold; cost and PnL split are `COST_UNVERIFIED_LEGACY`.
- Any M3 marker at or after `S_cash` is `RECONCILIATION_FAILED`.
- Legacy dust: a nonzero replayed quantity where the ledger shows zero is `LEGACY_DUST` with the exact amount, and `S_cost` does not exist. No epsilon. Root clarification RC-Q7: `LEGACY_DUST` applies only when the account has an M1 fill (`has_m1`); otherwise the difference is a plain R4 quantity failure.
- Root clarification RC-Q17 (`nav_from`): `nav_from = S_cash + 1` when an M2 row exists. A fill without `quote_amount` and with `legacy_float = 1` uses `quantity × price` unrounded, labelled `QUOTE_FROM_PRICE_LEGACY`. A non-legacy fill without `quote_amount` is `QR2_INPUT_INVALID`.

No legacy tolerance such as 1e-12 is used. The alternative "every marked account `RECONCILIATION_UNAVAILABLE_LEGACY` for all numbers" is not selected (O7).

### 6.4 Commit order and R3c

Per Bot, both writers take the `users` lock before any insert (section 5), and `paper_snapshots.id` and `paper_funding.id` are identity values allocated after the lock. Snapshot id order is commit order. Each ledger event writes exactly one snapshot of its account. R3c compares each snapshot after `S_cost` with the replayed cash, book equity and position cost after the consumed events: `MATCH`, `FUNDING_SNAPSHOT_STALE` (the F4 signature), `FILL_SNAPSHOT_MISMATCH`, `ORDER_UNPROVEN`. Method id `commit-order-snapshot-id-v1`, with the single worker clock assumption.

Root clarification RC-Q17: R3c aligns snapshots to the replayed events by tail alignment and emits one `SNAPSHOT_COUNT_MISMATCH` when the counts differ. A funding snapshot mismatch without the F4 signature gets the new diagnostic code `FUNDING_SNAPSHOT_MISMATCH`. Root clarification RC-Q16: after a replay halt R3c returns `NOT_RUN` with reason `REPLAY_HALTED`.

R3c stays a diagnostic. A snapshot mismatch does not open a violation span: snapshots are not inputs to NAV or returns, and the harmful F4 effect is caught by N1 and N2. With the fence deployed, `FUNDING_SNAPSHOT_STALE` is expected only on pre-fence history.

### 6.5 Ledger-invariant gates N1, N2 and the F4 effect

N1 cash floor (replayed cash `>= 0` after every event) and N2 configured-equity floor (`Σ equity_delta + Σ journal cash_delta >= 0` after every `CONFIGURATION` row), both over commit order after `S_cash`. A failure makes the account `LEDGER_INVARIANT_VIOLATED`. The violation span runs from the violating event to the first later event after which N1 and N2 hold again; returns for periods that intersect it are null; NAV and facts stay visible (O16). QR-2 does not fix, lock, refuse or correct anything about F4.

Root clarification RC-Q1 (span rule): a span opens only at an event where N1 fires or N2 fires; N2 is evaluated only at `CONFIGURATION` rows. The span closes at the first later event after which `cash >= 0` and the equity floor `>= 0`. Test: cash-only `LEGACY_BASELINE` 150, then BUY 100, gives no span and no overlay. Root clarification RC-Q17: the span end is inclusive. Root clarification RC-Q1 extension (legacy baseline): in the N2 equity floor a `LEGACY_BASELINE` row adds its `(cash_delta - equity_delta)` as configured equity, so a cash-only legacy seed is not an invariant violation. Test: baseline 150/0, BUY 100 at 200, deposit 10/10 at 300 gives no span and no overlay.

### 6.6 Check table

Effects (graded):

- `RECONCILIATION_FAILED`: NAV, returns and every total that includes the account are null; facts visible.
- `LEDGER_INVARIANT_VIOLATED`: returns null over the span; NAV and facts visible.
- `SPLIT_NULL`: cost basis, realized and unrealized PnL are null for that symbol (or position cycle); cash, quantity, market value, NAV, money PnL and returns stay. Reason: NAV is `cash + qty × price` and does not depend on cost.
- `ACCOUNT_UNAVAILABLE`: an implementation fault; no number for the account.

Gates:

| Id | Check | Applies | Effect |
| --- | --- | --- | --- |
| R1 | Every fill has exactly one journal row with the same `(signal_id, cumulative_quantity)` and the reverse; rows belong to the account | after `S_cash` | `RECONCILIATION_FAILED` |
| R2 | Journal `cash_delta` = BUY `-(quote_amount + fee_quote)`, SELL `quote_amount - fee_quote` | after `S_cash` | `RECONCILIATION_FAILED` |
| R4 | Replayed quantity per symbol = `ledger_positions.quantity` at the cutoff; replayed cash = `paperAccount().cash` | always | `RECONCILIATION_FAILED`; `LEGACY_DUST` reported |
| R5 | Σ stored open lot remaining + replayed unlotted = `ledger_positions.quantity` | after `S_cost` | `SPLIT_NULL` |
| R6 | Replayed remaining and status per `position_id` = stored; L1 holds; no `ORPHAN_LOT`. RC-Q18 gate visibility: the `LOT_ORDER_AMBIGUOUS` `SPLIT_NULL` finding is appended to `gates.R6.failures` and `ok` is recomputed; when R6 is `NOT_RUN` with `S_COST_UNAVAILABLE`, the `replay.binding` `SPLIT_NULL` findings (`LOT_EPOCH_UNKNOWN`, `LOT_BINDING_MISMATCH`, `ORPHAN_LOT`) are still recorded as information findings | after `S_cost` | `SPLIT_NULL` |
| R7 | Replayed cost per symbol = `ledger_positions.cost_basis` (`COST_DRIFT`) | after `S_cost` | `SPLIT_NULL` |
| R11 | Σ `fee_quote` = replay fees; the analytics `fee_bps` overlay is excluded, and a caller that passes one is refused `QR2_FEE_OVERLAY_REFUSED` | after `S_cash` | `RECONCILIATION_FAILED` |
| RT | Replay closure: no `SELL_EXCEEDS_POSITION`, `TARGET_UNRESOLVED`, `TARGET_OVERFILL`, `SCALE_DIVERGENCE`, `LEDGER_RULE_UNREPLAYABLE` | always | `RECONCILIATION_FAILED` from that fill |
| RC | No `FUTURE_TIMESTAMP`, no `FILL_BEFORE_BAR` | always | `RECONCILIATION_FAILED` |
| RI | Replay self-check from `S_cost` (RC-Q5, RC-Q17: absolute from `S_cost`): identity `cash + cost = F_cash + R` after every replay event and at `from` and `to`; over the range `money_pnl = ΔR + ΔU + E0 clamp amount`; E0 clamp amounts recorded, not failed. A range identity break gives `QR2_IDENTITY_BROKEN` | after `S_cost` (cash part after `S_cash`) | `ACCOUNT_UNAVAILABLE` (`QR2_IDENTITY_BROKEN`) |
| RX | Each counted row belongs to that Bot and to `PAPER`; no signal, journal key, funding id or position key appears in two Bot views of one total; a total equals the exact per-currency sum of its parts | always (totals from S4) | total refused (`QR2_CROSS_BOT_ROW`, `QR2_TOTAL_MISMATCH`); RC-Q2: any counted row of another Bot refuses the whole view `QR2_CROSS_BOT_ROW` (fail closed, no number produced); `QR2_TOTAL_MISMATCH` stays S4; RC-Q19: a counted row without `user_id`, or without both `broker` and `account_id`, is refused `QR2_CROSS_BOT_ROW` with reason `SCOPE_FIELD_MISSING` (fail closed) |
| RP | No Live or non-Paper row enters any number | always | view refused (`QR2_NON_PAPER_ROW`) |
| N1 | Cash floor over commit order | after `S_cash` | `LEDGER_INVARIANT_VIOLATED` |
| N2 | Configured-equity floor over commit order | after `S_cash` | `LEDGER_INVARIANT_VIOLATED` |

Diagnostics and information (reported, audited when abnormal, never gating):

| Id | Check | Note |
| --- | --- | --- |
| R3c | Commit-order snapshot check (6.4) | `FUNDING_SNAPSHOT_STALE`, `FUNDING_SNAPSHOT_MISMATCH`, `FILL_SNAPSHOT_MISMATCH`, `ORDER_UNPROVEN`, `SNAPSHOT_COUNT_MISMATCH`; `NOT_RUN` with `REPLAY_HALTED` |
| R8 | `bookEquity - cash - positionCost = Σ equity_delta - Σ cash_delta` | unbacked configured equity line |
| R9 | NAV = cash + Σ rounded market values | library self-check; failure `REPORT_INTERNAL_ERROR` |
| R10 | NAV change = flows + realized + change in unrealized | library self-check, also covered by RI |
| R13 | Σ open `remaining × entry_price` versus `cost_basis` per symbol | stated bound `0.5e-18 × Σ filled_quantity` since the symbol was last flat |
| R14 (S2) | `ledger.cost_clamped` and `ledger.cost_divergence` audit rows in range, listed with their signals; each clamp cycle is `SPLIT_NULL` for that position cycle (OD-Q10) | NAV and returns kept |
| R15 (S2) | Pending orders at request time | `PENDING_ORDERS_PRESENT`; `UNKNOWN` or `feeReservationUnknown` gives `PENDING_ORDER_UNCERTAIN` |
| Events | `NO_LOT`, `NO_LOT_FALLBACK`, `G1_UNLOTTED_CHARGED`, `PARTIAL_LOT_COVERAGE` (E0), `RESIDUAL_COST_AT_FLAT` (E0), `COST_CLAMPED`, `LOT_ORDER_AMBIGUOUS`, `UNLOTTED_QUANTITY` | each with fill key and amount |

Decimal rules: inputs are NUMERIC(38,18) strings parsed with `D`; ledger quantities and cash are compared unrounded; only market value is rounded; no epsilon in any gate; the analytics near-flat normalisation is not used. Each failure returns the account, the first failing event and both compared values, so a tester can reproduce it from the tables.

Root clarifications RC-Q3, RC-Q8, RC-Q17 for the gates: `accountStatus` receives the range end and uses `reconciliationBlocks(effects, to)`. R1 duplicate fill or journal keys follow the `S_cash` information/failure split by row time (RC-Q8). Exposure is rounded to 12 places half-even. A number with a value and a gating label is `PARTIAL`; `PRICE_STALE` stays `COMPLETE` with its reason. NAV for `ORDER_AMBIGUOUS` is shown as a proxy. `UNLOTTED_QUANTITY` stays reported as implemented. Allocation item 11 and `QR2_TOTAL_MISMATCH` stay S4; R14 and R15 stay S2.

### 6.7 Findings and audit after commit

The reader returns findings and writes nothing. S3 adds a bounded after-commit hook to the request pipeline (R-B); the callback writes in its own short READ COMMITTED transaction through `store.audit`, with the dedup key `sha256(canonical([method_id, bot_id, broker, check_id, first_row_key]))` (R-A), an advisory lock per key, an existence check and at most 20 distinct keys per request. The read transaction stays READ ONLY. Repair stays under D6: no SQL repair, mark affected runs tainted, re-fund or re-send through normal routes. QR-2 adds no repair tool.

---

## 7. Data model, storage and migrations

### 7.1 No schema change in S1-S3

### 7.2 S4: capital-model declaration (versioned, OD-Q9)

```
paper_capital_models(
  owner_id       TEXT NOT NULL REFERENCES users(id),
  currency       TEXT NOT NULL CHECK (currency IN ('USDT','THB')),
  version        BIGINT NOT NULL,
  capital_model  TEXT NOT NULL CHECK (capital_model IN ('INDEPENDENT_ACCOUNTS','SHARED_HYPOTHETICAL')),
  bot_set        JSONB NOT NULL,
  effective_from BIGINT NOT NULL,
  declared_at    BIGINT NOT NULL,
  declared_by    TEXT NOT NULL REFERENCES users(id),
  PRIMARY KEY (owner_id, currency, version))
```

A trigger refuses a child Bot as `owner_id`, `effective_from` earlier than `declared_at`, and any UPDATE or DELETE. Every change writes an audit row in the same transaction. Optional audit partial index from 6.7. S4b adds pool tables only under O2 option 2.

### 7.3 S6: frozen reports

`paper_performance_reports` is append-only with an `ENABLE ALWAYS` refusal trigger as in QR-1b, and stores code commit, contract, grid and declaration versions, requested and resolved range, and request time. Columns: report id, owner, scope (Bot and broker, or an owner total under a declaration), period, all method ids, ledger cutoff, market-data cutoff, gap list, result JSON as decimal strings, `inputs_hash`, `result_hash`, `created_at`.

`inputs_hash`: sha256 of the canonical JSON of the method ids, scope, period, and per account the ordered canonical row content (not only the keys) of `paper_funding`, `paper_cash_journal` and `fills` with the joined signal fields used, up to `to`; every price used as `(bar_time, content_hash)` or `'UNPRICED'`; and, when `to` equals the request time, the digests of positions and lots. Reason: a key-only recipe cannot detect an in-place `UPDATE fills.fee_quote`.

Recompute: equal hash and values; `PRICE_BACKFILLED_AFTER_SNAPSHOT` when a later bar now resolves an instant differently; `PRICE_SOURCE_CHANGED` when the same `bar_time` now has a different `content_hash`; `REPLAY_INPUT_CHANGED` when an input digest changed; `REPLAY_RESULT_MISMATCH` when equal inputs give different numbers. The stored report wins and is never edited; a recompute is a new record with a parent link. A report for a past period without a frozen record is `HISTORICAL_RECOMPUTE`.

Stated limit (D4): ledger input tables are not append-only guarded (O10, S7). Digests detect a later change but do not prevent it. A frozen report must not claim input immutability until S7 or the D4 seal table lands.

### 7.4 Method ids

Every response carries: `valuation_method` (per O15, with `fresh_ms`, `carry_ms`), `return_method` (`twr-flow-split-v1`, `mwr-modified-dietz-v1`, `money-pnl-flow-v1`), `lot_method` (the epochs met: `ledger-stored-lots-target-fifo-fallback-v1`, `paper-exit-cost-o3-v1`, `paper-exit-cost-v2`), `legacy_method` (`legacy-two-seed-v1`), `order_method` (`commit-order-snapshot-id-v1`), `period_method` (`utc-exclusive-isoweek-v1`), `drawdown_grid` (`qr2-grid-daily-events-v1`), `alloc_method` (`qr2-alloc-v1`, from S4), `rounding` (`market-value-18-half-even`, `return-12-half-even`). A change of any constant is a new id and a new golden-fixture set. A view never mixes two versions of one method.

### 7.5 Migration rules

Offline, maintenance lock, classified install (ABSENT, INSTALLED, PARTIAL; refuse unknown), rollback in its own transaction, qualified names, pinned `search_path`, temp-table shadowing test, grants reapplied, rollback refused with rows unless exported and count-confirmed (O12), staging restore rehearsal and its own GO. S7 needs its own audit, debugger review and owner GO.

---

## 8. API and labelling

### 8.1 Routes (S3; read-only)

`GET /api/paper-performance?bot_id=<id>&broker=<b>&period=<p>[&from&to]`, scoped by `ownsBot`; admin cross-owner reads need `analytics:any`, the sensitive-action check and an audit row; `user_id` is never a selector (`QR2_NOT_OWNER`). Bounds: custom windows at most 3660 days and not older than `quota.historyDays`. The legacy Quant gate is not applied (O8).

Read budget (OD-Q12): root fixes a maximum of ledger rows per account and grid points per view; measure replay cost in S2 and fix the numbers before S3 acceptance. A request over a limit is refused `QR2_RANGE_ADMISSION_REFUSED` and never truncated. Replay needs the full history of the account up to `to`, so the ledger-row limit applies to history, not to the range length. [SRC: ROADMAP § Report range, no silent truncation]

Response fields: per symbol: quantity, unlotted quantity, cost basis, price, price state, age, retrieval flag, market value, unrealized PnL; per account: cash, reserved, available, NAV, unbacked configured equity, realized PnL, fees, flows, money PnL, TWR, Modified Dietz, drawdown, reconciliation state, legacy seeds, findings, method ids, cutoffs, gaps, per-fill strategy tag (O14); exposure, `EXPOSURE_AT_COST`, available cash state, modeled slippage (information), audit findings (R14), ledger rule epochs, and the header below. Every number is serialized as `{value | null, status, reasons[]}`; money and returns are decimal strings; a null never renders as 0.

View header on every status: `requested_range`, `resolved_range`, `as_of`, `first_funding_at`, `event_time_basis`, price source and age policy, `fx: NONE`, currency, method, grid and contract ids, declaration version, ledger rule epochs met, `basis`, `execution`, `historical_simulation: false`, `qualified_evidence: false`.

Root clarification RC-Q11 (exact header key names, snake_case): the validator requires `price_policy` (`{fresh_ms, carry_ms}`), `contract_id`, `declaration_version`, `ledger_rule_epochs`, `lot_epochs`, `fee_source`, `alloc_method`, plus the fields above. Root clarification RC-Q21 (validator): a null or empty `contract_id` is refused; `ledger_rule_epochs` and `lot_epochs` must be arrays; `alloc_method` must equal the module constant; a null `declaration_version` stays allowed until S4. Root clarification RC-Q23 (resolved-range flags): the flags of the resolved range travel in the header key `range_flags`; the validator requires `range_flags` to contain `RANGE_END_AT_REQUEST_TIME` when the requested `to` is later than the resolved `to`. Root clarification RC-Q10: the header builder spreads method fields before the fixed label fields so a method can never override a label.

### 8.2 Label enforcement in code

Required `basis` argument (`'ACTUAL_PAPER_LEDGER'` only); `execution: 'PAPER_SIMULATED_FILLS'`; `historical_simulation: false`; a unit-tested response validator that refuses a missing, foreign or mixed basis; import-graph and no-query tests against research tables; UI badges from API fields.

### 8.3 Strategy attribution (O14)

Per-Bot reports plus a per-fill tag from the stored signal payload (`bridge.deployment_id`, else `WEBHOOK`, else `ATTRIBUTION_UNKNOWN`). Attribution never changes a number. No per-strategy returns before APP-3B.

### 8.4 Fees and slippage

Fees are `fills.fee_quote` only; entry fees are inside cost and exit fees inside realized PnL; the fee total is an information line and is never subtracted again. Paper fill prices already include modeled slippage and tick rounding. QR-2 shows `signals.slippage_bps` as "modeled slippage, already included", measured by the ledger against the order intent price (CODE: LEDGER line 279), and never deducts or re-models slippage. Where the intent price is not recorded the fill shows `SLIPPAGE_UNKNOWN`, never zero. Spot Paper has no funding payments, borrowing, leverage or liquidation; "funding" in QR-2 means Paper capital deposits and withdrawals only.

### 8.5 Never an authority for a QR-2 number

`ledger_daily.realized_r` and `fills.realized_r` (R multiples); `ledger_positions.cumulative_pnl` (resets at flat); `paperAccount().bookEquity` (shown only as `BOOK_EQUITY_COST_BASIS`, "used for sizing; not portfolio value"); the `bots.js` and Overview tiles; the analytics `fee_bps` overlay; run baselines in `bot_sessions` and `bot_session_archive` (information only; F4 showed a run baseline can be wrong). [SRC: docs/evidence/PAPER_FUNDING_RACE_F4_LOCAL_2026-10-13.json]

---

## 9. UI rules (U1-U9)

U1-U9 stand: no portfolio claim before a declaration; Overview tile and `public/bots.js:129` relabelled per currency (O2; the tile sums `parseFloat(bookEquity)` across USDT and THB); book equity and marked equity as separate columns; no browser money arithmetic; a null shows an em dash and the reason; badges from API fields; English and Thai through `public/i18n.js`; mobile and Thai checks on the local stub; nothing in the UI starts, changes or sizes a Bot.

Fixed notices in English and Thai: "Actual Paper ledger history of this Bot. Fills are simulated, not exchange executions. These are engineering facts, not a profitability claim, a strategy evaluation or a recommendation." and "Book equity used for sizing is a different number." Never shown: a filled or interpolated gap; a price older than `carry_ms`; a cross-currency sum; an undeclared or independent-account owner return; a percentage over an unknown base; a net-liquidation estimate (O13); a Buy & Hold line; a best, winner or ranking label; simulation labelled as actual Paper execution; the word "profit" without the notice.

---

## 10. Statuses

| Level | Value | Meaning |
| --- | --- | --- |
| Request | `REFUSED` | Invalid or unsafe request. No view. Codes: `QR2_RANGE_INVALID`, `QR2_NOT_OWNER`, `QR2_NON_PAPER_ROW`, `QR2_CURRENCY_MIX`, `QR2_RANGE_ADMISSION_REFUSED`, `QR2_FEE_OVERLAY_REFUSED`, `QR2_CROSS_BOT_ROW` (RC-Q2), `QR2_INPUT_INVALID` (RC-Q17). |
| View, account, number | `COMPLETE` | Every gate passed; every needed price `FRESH` or `STALE`; no unresolved legacy, rule epoch, coverage or pending-order reason. |
| | `PARTIAL` | Some numbers null with reasons (for example `UNSUPPORTED_MARKET`, `SPLIT_NULL`, `COST_UNVERIFIED_LEGACY`, a stale grid point). Shows count and share of valued grid points. |
| | `UNAVAILABLE` | `RECONCILIATION_FAILED`, `ACCOUNT_UNAVAILABLE`, no ledger rows, or every needed price missing. |
| Overlay | `LEDGER_INVARIANT_VIOLATED`, `RECONCILIATION_UNAVAILABLE_LEGACY` | Shown with any level; returns null across the span or before `S_cash`. |

Root clarification RC-Q3: a range that ends at or before the failing fill gives `PARTIAL` with the information reason `RECONCILIATION_FAILED_AFTER_RANGE`; a range that reaches the failing fill gives `UNAVAILABLE`. Root clarification RC-Q5: a range identity break gives `ACCOUNT_UNAVAILABLE` with `QR2_IDENTITY_BROKEN`.

The status rolls up from account to Bot (worst of its accounts) to owner total (worst of its Bots). The owner total is unavailable whenever the declaration is missing or refused. RO1 facts mean many real accounts are expected to be `PARTIAL`; that is the intended outcome, not a QR-2 defect.

---

## 11. Gaps

- Missing or stale prices follow 2.1. Missing ledger history (before coverage start, before `S_cash`, or not replayable) is a reason, never zero rows.
- Bar gaps in range are listed as intervals, reusing the BARS gap logic where possible. Only a gap that hits a needed valuation point changes a number. QR-2 never requests a backfill.
- Under option M a later catch-up bar restores a price for a past instant; only frozen reports keep what was shown earlier (K7).

---

## 12. Slice plan

Roles per AGENTS.md Claude column: Coder Sonnet 5.5 / high; Architecture auditor Opus 5.5 / high; Tester Sonnet 5.5 / medium; optional Fable 5.1 / high second-opinion reviewer on high-risk slices, never sole evidence. Root accepts. Each slice is its own wave on a fresh usage reading, one writer per file. Host: local only for S0-S8.

| Slice | Content | Stop point | Gate |
| --- | --- | --- | --- |
| S0 | Root accepts this contract; owner decisions recorded (section 15); root records rule-epoch boundaries per environment (OD-Q6) and the read budget (OD-Q12); optional read-only staging count as a separate serial operations dispatch (R-C) | decisions recorded | done for decisions; boundaries and budget pending |
| S1 | Pure library: price resolver, replay with epochs E0-E2, legacy seeds, commit-order checks, N1/N2, RI, checks, money PnL/TWR/MD, drawdown grid, periods, method ids, label validator, `inputs_hash`, dedup key | unit suite green; auditor review of replay parity per epoch, rounding and formulas | decisions O1, O3, O4, O7, O9, O11, O15, O16, OD-Q1, OD-Q6 (rules), OD-Q13, OD-Q14 recorded |
| S2 | PostgreSQL reader in one READ ONLY snapshot; cutoffs; findings; after-commit audit writer function | PostgreSQL suite green on a ledger written by the live code, including F4-effect, mismatch-injection and epoch cases | O6, O14, OD-Q10 recorded |
| S3 | Per-Bot GET route, scoping, bounds, admission, O8, labels; after-commit hook | HTTP tests green; security review of scoping and the pipeline hook; audit lookup cost and replay cost measured; SSI test of a SERIALIZABLE READ ONLY reader against SERIALIZABLE funding requests (R-F) | O8 recorded; read budget fixed |
| S4 | Capital-model declaration table, guard, owner PUT with step-up (`PUT /api/paper-capital-model`), owner-total route under 4.2 (`GET /api/paper-performance/owner?currency=<c>&period=...`) | classified migration tests green; restore rehearsal plan written | O2, O12, OD-Q8, OD-Q9 recorded |
| S4b | Optional pool with sleeves | as S4 | O2 option 2 only if the owner later chooses it |
| S5 | UI per section 9; S5a (tile relabel and `bots.js:129`) can follow S3 | rendered desktop and mobile check on the local stub | O2, OD-Q15 recorded |
| S6 | Optional frozen reports with row-content `inputs_hash` | as S4 | O5, O12, D4 (immutability claim only) |
| S7 | Optional append-only guards on ledger input tables | separate audit and GO | O10, D4 |
| S8 | Docs and evidence: Roadmap row, Time Management, README/Context notes, evidence JSON | wording does not overstate local scope | none |
| S9 | Staging rollout of accepted slices | owner/root GO per Roadmap gate | OD-Q17 (staging deployment of the F4, ledger fix O3, G1 and W1 fixes confirmed from deployment evidence), own GO |

Order: S1, then S2, then S3. S4 can start after S1 in parallel, because its files differ; its one `server.js` line waits for S3's writer. S6 after S2. S7 only on a separate owner decision.

---

## 13. Test and evidence plan

All tests run locally on isolated fixtures and a throwaway PostgreSQL cluster, one file per process, no host, network or browser. A tester who did not write the code runs them on the final bytes. Expected values are computed by hand in the fixture file, never by the code under test.

Unit (pure):

1. Replay set (L1 binding, Bridge EXIT by `position_id`, target equal to `entry_trade_id` with two lots, `TARGET_UNRESOLVED`, `TARGET_OVERFILL`, `NO_LOT_FALLBACK`, `COST_CLAMPED`, `LOT_ORDER_AMBIGUOUS`), run under E0 and E2. E0 also covers `PARTIAL_LOT_COVERAGE`, `RESIDUAL_COST_AT_FLAT`, `SCALE_DIVERGENCE`; E2 covers `G1_UNLOTTED_CHARGED`, zero-cost lots as no lots, ledger fix O3 rounding and the full-close removal.
2. Epoch selection: a fill before and after the boundary; a signal whose marker was overwritten by a zero-quantity status update is still assigned by the boundary; an unknown epoch gives `LEDGER_RULE_UNREPLAYABLE`; replay never retries another epoch.
3. Identity property test (1 000 random E2 sequences of BUY, partial SELL, full SELL, targeted SELL, G1 over-lot SELL, zero-cost lots, clamp): `cash + cost = F_cash + R` after every event. An E0 clamp records the expected difference. Root clarifications RC-Q4 and RC-Q12: the same random-sequence parity runs for E0 and E1 against frozen read-only copies of the `b9d19e3` and `a577689` SELL branches under `test/fixtures/qr2-ledger-epochs/` (header names the commit and states a frozen copy for parity only), as for E2; the E0 parity run must reach the `RESIDUAL_COST_AT_FLAT` branch (RC-Q20; add a generator case if needed); parity also compares the ledger `cumulative_pnl` per position cycle (reset at flat) and the journal `cash_delta`.
4. Legacy: `S_cash` and `S_cost` placement; negative pre-baseline cash does not trigger N1; `LEGACY_DUST` prevents `S_cost`; M3 after `S_cash` fails; a 1e-13 legacy quantity difference is `LEGACY_DUST`, not accepted.
5. Commit order: R3c `MATCH`; `FUNDING_SNAPSHOT_STALE` on the F4 row set; `ORDER_UNPROVEN` on equal `received_at`.
6. N1 and N2 on the F4 table (expect -20 and -20); a later SELL keeps the flags and the span.
7. Boundaries: a flow at exactly `from` counted once; a flow at exactly `to` excluded from the range and from `NAV(to)`; a deposit-only range gives money PnL 0 and TWR 0.
8. TWR and MD: same-instant flows summed; empty first sub-period skipped; `NON_POSITIVE_BASE`; `TWR_BOUNDARY_UNVALUED` with no partial product; MD exists when only interior prices are missing.
9. Price resolver (option M, and option R for the not-selected path), with `retrieved_at` absent, equal to T and after T; bars at `t`, `t-180000`, `t-180001`, `t-900000`, `t-900001`, `bar_time > t` and none; integrity failures (changed bar with old hash, `high < close`, `bar.time` mismatch) and no substitution; a flat account needs no price.
10. Ranges: exclusive 00:00Z end, ISO week from Monday, `to <= from` refused, `COVERAGE_STARTS_AFTER_REQUEST`.
11. Allocation: no declaration, no total; `INDEPENDENT_ACCOUNTS` exact sum line and no owner return; `SHARED_HYPOTHETICAL` no total; Bot added mid-range `ALLOCATION_SET_CHANGED`; USDT plus THB `QR2_CURRENCY_MIX`.
12. Response validator: missing basis, mixed basis, `historical_simulation: true`. A null never serializes as 0. Audit dedup key: same defect one key, new defect new key.

PostgreSQL:

13. Golden reconciliation through the real `recordFunding` and `recordExecution` (with the fence): partial fills, fees, deposit, withdrawal, Bridge targeted EXIT, FIFO exit to flat, G1 exit. Every gate and R3c `MATCH` at every snapshot; NAV, money PnL and fees equal hand values.
14. Injected faults, one per test, each made by the test and never by the product: `cost_basis` changed by `1e-18` (R7, `SPLIT_NULL`, NAV and returns unchanged); a journal row removed (R1); cash changed by `1e-18` (R4); the F4 false snapshot (R3c diagnostic, N1/N2 span); negative cash after `S_cash` (N1); an extra lot (`ORPHAN_LOT`, `SPLIT_NULL`); a cross-Bot fill (RX); a Live row (RP). Each gives the named code and never a corrected number. One audit row after commit per distinct defect; a second GET adds none; no ledger row changed.
15. F4 effect with a labelled direct test row set.
16. Separation: READ ONLY, an injected write fails; a concurrent fill commit never gets `40001` from the reader; `paper_ledger_fence.version` unchanged; one snapshot; a fetcher stub that throws proves no network call; the audit row appears only after commit; a rolled-back request writes none; the funding path SSI interaction is tested (R-F).
17. Unbacked equity excluded from NAV; a THB account and a non-BTCUSDT position unpriced and `PARTIAL`; a pending BUY and an `UNKNOWN` order give `PENDING_ORDER_UNCERTAIN`; a historical `to` gives `RESERVATION_HISTORY_NOT_RECORDED`; target exits where analytics FIFO differs show `REALIZED_METHOD_DIFFERS_FROM_ANALYTICS` with equal NAV and TWR.
18. Legacy account built with `legacy_float = 1` fills, a `LEGACY_BASELINE` row and a rewritten `cost_basis`: both seeds and labels.
19. Frozen reports (S6): identical inputs give identical digests; an in-place `UPDATE fills.fee_quote` gives `REPLAY_INPUT_CHANGED`; a backfilled bar gives `PRICE_BACKFILLED_AFTER_SNAPSHOT`; a changed hash for the same `bar_time` gives `PRICE_SOURCE_CHANGED`; the original is never overwritten.
20. Read budget: a request over the limit is refused, not truncated.
21. Owner scoping (owner A cannot read owner B's Bot; admin reads audited), route bounds, O8 behaviour, header fields on every status with `qualified_evidence: false`, English and Thai notices, tile relabelled per currency (O2).
22. Migrations (S4, S6): classified install, idempotent second install, refuse on PARTIAL or tampered state, rollback on empty, refused rollback with rows, temp-table shadowing attack fails.

Adversarial review targets: replay divergence per epoch against the real `recordExecution` (Fable second-opinion target), double count through a missing declaration, a payload changed after execution (G4), clock skew between processes, audit flooding through repeated GETs.

Roadmap gate to test mapping: stale or missing prices explicit: 9, 17; no double counting of shared capital: 7, 11, 14 (cross-Bot fill); ledger and valuation reconcile: 1-6, 13-15; historical simulation never labelled actual Paper execution: 12, 21.

Staging evidence: an explicit owner GO, the single operations worker, a read-only run, and a sanitized `docs/evidence/QR2_STAGING_READ_ONLY_<date>.json` with counts per status and reason code only, never owner values, secrets or machine locations. Bar for T: every account resolves to `COMPLETE`, `PARTIAL`, `UNAVAILABLE` or a flagged overlay with a documented reason, and zero `QR2_IDENTITY_BROKEN`.

PM-1 credits: D, root review and acceptance of this contract after independent review; root records the D credit in the PM-1 scorecard, not in this contract; I, implementation commit plus author checks; V, the independent tester on the final bytes plus an Opus auditor review of accounting and reconciliation, root accepts; T, staging integration plus the read-only staging record. [SRC: docs/PROGRESS_MEASUREMENT.md] Commit, CI, deployment and acceptance are separate facts.

---

## 14. Risks, unknowns and out of scope

Risks:

- K1 Live-path defects on undeployed history (E0 epoch, F4 before the fence) can make checks fail or flag on real data. That is correct behaviour.
- K2 Replay parity, per epoch. The E0 rule is reconstructed from `b9d19e3`; the deployed code was not compared (OD § G). If staging or production ran a different revision, E0 fills may not reconcile and give `LEDGER_RULE_UNREPLAYABLE`. Root's boundary evidence (OD-Q6) reduces this.
- K3 Commit-order assumption (one worker clock). K4 payload mutability and lot ties. K5 audit lookup cost. K6 the request-pipeline hook is shared code. K7 market-data coverage. K8 replay cost O(fills) per request, bounded by the read budget. K9 owner reading of two equity columns and unpriced accounts.
- K10 A ledger-rule change without a new marker and epoch breaks replay for new fills.
- K11 Booking time is not signal time; a worker backlog values a fill at its booking time.
- K12 A SERIALIZABLE READ ONLY reader inside the request pipeline follows the overview pattern. Writers that run SERIALIZABLE (API funding requests) can in principle see a serialization failure that involves a read-only transaction; fill writers run at READ COMMITTED and cannot. Test 16 covers both (R-F).

Unknowns: legacy marker counts, unlotted positions, negative-cash accounts and unbacked equity on staging; share of bars with `retrieved_at`; whether more than one worker host wrote fills; fill volume per account; which code revision wrote each environment's history.

Out of scope: Live, non-Paper execution, Futures, margin, shorts, funding payments, liquidation; other markets and FX (O6, QD-1); pooled capital (S4b); net liquidation (O13); per-strategy returns before APP-3B (O14); IRR, annualization and risk ratios; benchmarks, ranking and qualified labels (QR-3, QR-4); any ledger write, repair or rerun; changes to sizing, `paperAccount()`, Risk Manager, Pine, guards or Best Inputs; S7, the D4 seal table and day-close materializers (O5); historical simulation curves; email, export, apply and Bot start (F09).

---

## 15. Decisions

All dates 2026-10-19. "Owner" means the owner decided it as recommended. "Root" means root decided it. None is a GO.

| ID | Decision | Outcome | Decided by | Date |
| --- | --- | --- | --- | --- |
| O1 | Price age thresholds | `fresh_ms` 180 s, `carry_ms` 900 s; stale still gives values and returns with age; unavailable beyond 900 s. 900 s is a hard cutoff (also closes OD-Q5). | owner | 2026-10-19 |
| O2 | Shared-capital model and existing totals | V1 declaration `INDEPENDENT_ACCOUNTS` / `SHARED_HYPOTHETICAL`, no total until declared; relabel the Overview tile and fix `bots.js:129` now; pool with sleeves later as S4b only if chosen. | owner | 2026-10-19 |
| O3 | Unbacked configured equity | Excluded from NAV, own line, sizing unchanged (also closes OD-Q7: only `cash_delta` is a flow). | owner | 2026-10-19 |
| O4 | Return methods | TWR primary, Modified Dietz secondary and labelled, money PnL always, no IRR. | owner | 2026-10-19 |
| O5 | Persistence | Derive on read plus optional frozen reports (S6); no materializer in the trading worker. S6 hash uses row content (7.3). | owner | 2026-10-19 |
| O6 | Unsupported markets | THB brokers and non-BTCUSDT symbols shown unpriced `UNSUPPORTED_MARKET`, not hidden. | owner | 2026-10-19 |
| O7 | Legacy accounts | `legacy-two-seed-v1` (also closes OD-Q2). No 1e-12 legacy tolerance. | owner | 2026-10-19 |
| O8 | Legacy Quant gate on QR-2 routes | Do not apply. | owner | 2026-10-19 |
| O9 | Period definitions | Exclusive end 00:00Z, ISO week from Monday with a distinct label; half-open `[from, to)` flow windows (2.6). | owner | 2026-10-19 |
| O10 | Append-only guards on ledger input tables | Not now; separate slice S7 with its own audit and GO. | owner | 2026-10-19 |
| O11 | Every `CONFIGURATION` cash delta is an external flow for returns | Confirmed. | owner | 2026-10-19 |
| O12 | Retention and rollback for declarations and frozen reports | Keep; rollback refuses with rows unless exported and count-confirmed. | owner | 2026-10-19 |
| O13 | Net-liquidation estimate | Dropped; later only as a separately labelled simulated liquidation. | owner | 2026-10-19 |
| O14 | Strategy-version attribution | Per-Bot plus per-fill deployment tag; no per-strategy returns before APP-3B. | owner | 2026-10-19 |
| O15 | Price availability rule | Option M (market-time as-of with informational retrieval flag); closes OD-Q4. | owner | 2026-10-19 |
| O16 | Effect of a ledger-invariant violation (N1/N2) | `LEDGER_INVARIANT_VIOLATED`; null returns for periods that intersect the span; NAV and facts visible; findings audited. R3c stays diagnostic. | owner | 2026-10-19 |
| D4 | Append-only seal table before QR-2 (OD § B; merges OD-Q16) | Not required for derive-on-read S1-S5; required (D4 or S7) before a frozen report claims input immutability. | owner | 2026-10-19 |
| OD-Q1 | Registration instant for All Time Registered | Bot `users.created_at`, with `first_funding_at` reported; empty sub-period rule keeps returns equal; legacy history keeps its seed states. | owner | 2026-10-19 |
| OD-Q8 | Owner-level returns under `INDEPENDENT_ACCOUNTS` | Money sum line only; no owner TWR or Modified Dietz. | owner | 2026-10-19 |
| OD-Q9 | Declaration versioning and retroactivity | Versioned, append-only, one Bot set, forward only from `effective_from`. | owner | 2026-10-19 |
| OD-Q10 | QR-2 effect of a ledger cost clamp | Cost and PnL split null for that position cycle; NAV and returns kept. The ledger-side rule D10 is not reopened. | owner | 2026-10-19 |
| OD-Q13 | Drawdown grid | Daily 00:00Z plus every fill and flow time, labelled sampled, within the read budget. Grid id `qr2-grid-daily-events-v1`; the earlier design named `drawdown_grid` with no value, so no reconciliation is needed. Root confirmed. | owner | 2026-10-19 |
| OD-Q14 | Annualization of returns | None. | owner | 2026-10-19 |
| OD-Q15 | Buy & Hold line inside QR-2 | No; QR-3 owns benchmarks. | owner | 2026-10-19 |
| R-A | Audit dedup key | Per distinct defect `[method_id, bot_id, broker, check_id, first_row_key]` (also closes OD-Q11). | root | 2026-10-19 |
| R-B | After-commit hook in `src/postgres/request-dispatch.js` | One bounded callback per route after COMMIT, failure swallowed and counted, security review in S3. | root | 2026-10-19 |
| R-C | Read-only staging count | Dispatch as a separate serial operations step when useful; S1 does not wait. | root | 2026-10-19 |
| R-D | Design-rule changes (half-open boundary, rule epochs, graded effects, row-content hash, new checks RI/RX/RP/R14/R15, method id `money-pnl-flow-v1`, exposure, header, status ladder) | Accepted. | root | 2026-10-19 |
| R-E | Owner set | Owner row plus `parent_user_id` children only; confirmed. | root | 2026-10-19 |
| R-F | SSI interaction of a SERIALIZABLE READ ONLY reader with SERIALIZABLE funding requests | Add a test in S3. | root | 2026-10-19 |
| OD-Q6 | Ledger rule epoch boundaries per environment | Root records boundaries from deployment evidence: E0 for pre-fix fills, E1 only where a577689 ran, E2 from the v2 deployment; unknown or non-reconciling fill gives `LEDGER_RULE_UNREPLAYABLE`. Boundaries are needed before staging evidence (S9). | root | 2026-10-19 |
| OD-Q12 | Numeric read budget per view | Measure replay cost in S2, fix maximum ledger rows per account history and grid points per view before S3 acceptance; refuse `QR2_RANGE_ADMISSION_REFUSED`, never truncate. | root | 2026-10-19 |
| OD-Q17 | Staging deployment of the F4, ledger fix O3, G1 and W1 fixes before QR-2 staging integration | Required, confirmed from deployment evidence. QR-2 logic does not need the fixes (epochs), but the branch already carries 40e3b6b, whose API and worker refuse to start without the fence table. | root | 2026-10-19 |
| OD-Q18 | Requested `to` later than the request time | Resolved to the request time; flag `RANGE_END_AT_REQUEST_TIME`; the header keeps the requested range next to the resolved range. Supersedes the earlier refusal. | owner | 2026-10-19 |

### Root clarifications (2026-10-19)

Root rulings on the QR-2 S0/S1 review. They fix or clarify contract meaning, change no owner decision (O1-O16, D4, OD-Q rows) and are not a GO. The matching in-place edits are marked "Root clarification RC-Qn" in the named sections.

| ID | Clarification | Sections changed | Decided by | Date |
| --- | --- | --- | --- | --- |
| RC-Q1 | N2 span: opens only at an event where N1 or N2 fires; N2 evaluated only at CONFIGURATION rows; closes at the first later event with cash >= 0 and equity floor >= 0; cash-only LEGACY_BASELINE 150 then BUY 100 gives no span; a LEGACY_BASELINE row adds (cash_delta - equity_delta) as configured equity in N2. | 6.5 | root | 2026-10-19 |
| RC-Q2 | Any counted row of another Bot refuses the whole view with `QR2_CROSS_BOT_ROW` (fail closed, no number). | 6.6 RX, 10 | root | 2026-10-19 |
| RC-Q3 | `accountStatus` takes the range end and uses `reconciliationBlocks(effects, to)`: range ending at or before the failing fill is PARTIAL with `RECONCILIATION_FAILED_AFTER_RANGE`; reaching it is UNAVAILABLE. | 6.6, 10 | root | 2026-10-19 |
| RC-Q4 | Epoch oracles: frozen read-only fixtures of the b9d19e3 (E0) and a577689 (E1) SELL branches; same random-sequence parity as E2. | 6.2, 13 item 3 | root | 2026-10-19 |
| RC-Q5 | RI kept as a replay self-check from S_cost; a range identity break (money_pnl = dR + dU + E0 clamp) sets ACCOUNT_UNAVAILABLE `QR2_IDENTITY_BROKEN`. | 6.6 RI, 10 | root | 2026-10-19 |
| RC-Q6 | A replayed COST_CLAMPED sets SPLIT_NULL only for ranges intersecting the clamped position cycle (bounds on the finding); matches OD-Q10. Cumulative realized PnL (nav.realized and any cumulative realized or cost balance of that symbol) is null at and after the cycle start; a range delta wholly after a closed cycle that needs no cumulative value stays available; NAV, cash and returns unaffected. | 6.2 E2 step 7 | root | 2026-10-19 |
| RC-Q7 | LEGACY_DUST only when has_m1 is true; otherwise a plain R4 quantity failure. | 6.3 | root | 2026-10-19 |
| RC-Q8 | R1 duplicate fill or journal keys follow the S_cash information/failure split by row time. | 6.6 | root | 2026-10-19 |
| RC-Q9 | Malformed bar_time keeps the conservative whole-set integrity failure (fail closed). | 2.1 | root | 2026-10-19 |
| RC-Q18 | Lost lot table: bindLots cutoff = min(earliest lot opened_at, lotTableBoundary); unbound BUY at or after cutoff is LOT_BINDING_MISMATCH (SPLIT_NULL), event note LOT_MISSING; gate visibility of LOT_ORDER_AMBIGUOUS in R6 failures and information findings when R6 NOT_RUN. | 6.2, 6.6 R6 | root | 2026-10-19 |
| RC-Q19 | RX: a counted row without user_id, or without both broker and account_id, is refused QR2_CROSS_BOT_ROW with reason SCOPE_FIELD_MISSING. | 6.6 RX | root | 2026-10-19 |
| RC-Q20 | E0 parity must reach the RESIDUAL_COST_AT_FLAT branch. | 13 item 3 | root | 2026-10-19 |
| RC-Q21 | Header validator: non-empty contract_id, array epochs, alloc_method equals module constant; null declaration_version allowed until S4. | 8.1 | root | 2026-10-19 |
| RC-Q11 | Exact header keys: price_policy {fresh_ms, carry_ms}, contract_id, declaration_version, ledger_rule_epochs, lot_epochs, fee_source, alloc_method. Builder spreads method fields before fixed labels (Q10). | 8.1 | root | 2026-10-19 |
| RC-Q22 | Period start instant: from equal to request time resolves to null, UNAVAILABLE, RANGE_EMPTY_AT_REQUEST_TIME, no exception; from later than request time stays QR2_RANGE_INVALID. | 3.5 | root | 2026-10-19 |
| RC-Q23 | Header key range_flags carries the resolved-range flags; validator requires RANGE_END_AT_REQUEST_TIME in it when requested to is later than resolved to. | 8.1 | root | 2026-10-19 |
| RC-Q24 | S2 reader: one REPEATABLE READ, READ ONLY transaction with an isolation assertion; owner scope from the Bot user row; a budget pre-count runs before any row fetch; provisional ledger_rows limit 5000 until S3 optimises the replay (measured cost grows about quadratically) | 12 S2 | root | 2026-10-19 |
| RC-Q25 | Lot-fee, lot-table and epoch boundaries are a required reader argument; the product default is QR2_BOUNDARY_RECORD_UNRECORDED, which fails closed; boundary evidence is only a docs/evidence/*.json path or a 64-hex digest, anything else is QR2_BOUNDARY_RECORD_INVALID | 6.2, 12 S2 | root | 2026-10-19 |
| RC-Q26 | A refused view (QR2_CROSS_BOT_ROW and similar) returns only the refusal code, counts and own-scope identifiers, never another Bot or owner row, replay or value; audit rows for it use an opaque per-row key so distinct incidents stay distinct | 6.6, 12 S2 | root | 2026-10-19 |
| RC-Q27 | Price option R prefetches, per instant, the newest bar with bar_time and retrieved_at at or before the instant; a stored retrieved_at that is not a non-negative safe integer refuses option R with QR2_INPUT_INVALID detail RETRIEVED_AT; only the JSON parse failure of the exposure read is caught, every SQL or connection error propagates | 2.1, 12 S2 | root | 2026-10-19 |
| RC-Q28 | The per-Bot route reads in two phases. Phase 1, inside the request transaction, checks the session, own:read, the parameters, the Bot scope, the bounds and an admin step-up, and writes the admin audit row. Phase 2 runs after COMMIT as the standalone reader in its own REPEATABLE READ, READ ONLY transaction, and the computation runs outside any transaction. For this route this replaces the 6.1 sentence on joining the request transaction; the S3 SSI tests must show the reader never makes a funding request fail with a serialization error. | 6.1, 12 (S3) | root | 2026-10-20 |
| RC-Q29 | Scope: `bot_id` is required and `all` is refused. An owner reads only their own Bots. An admin reads another owner's Bot only with `analytics:any` and a recent step-up, and the admin audit row is written before any data is read. An absent Bot, a foreign Bot and any `user_id` parameter all return the same 404 `QR2_NOT_OWNER` body. | 12 (S3) | root | 2026-10-20 |
| RC-Q30 | Admission: one QR-2 computation slot per process; a second concurrent request gets 429 `QR2_RANGE_ADMISSION_REFUSED` with detail `concurrency` and is never queued or truncated. The provisional read budget is 5000 ledger rows, 5000 grid points, 2000 audit rows and 1000 pending rows; root fixes the final numbers from the S3 measurement before S3 acceptance (OD-Q12) and lowers the ledger-row limit if the p95 time at the limit exceeds 5 s. Replay speed-ups are a separate slice S3b. | 12 (S3), OD-Q12 | root | 2026-10-20 |
| RC-Q31 | Bounds: period `DAY`, `WEEK`, `MONTH`, `YEAR`, `ALL_TIME` or `CUSTOM` (inclusive dates, at most 3660 days); an unknown parameter gives `QR2_INPUT_INVALID` and a fee overlay `QR2_FEE_OVERLAY_REFUSED`. Until the owner decides O-1, the plan history limit applies to the start of every period. | 3.5, 12 (S3) | root | 2026-10-20 |
| RC-Q32 | A pure composer builds the header and the number fields of 8.1 and never returns ledger rows; an invalid response fails closed with 500 `QR2_RESPONSE_INVALID`; a refused view returns 200 with the header, status `REFUSED`, the code and counts only. The route sits behind `QR2_PERFORMANCE_ENABLED`, off by default (404). | 8.1, 12 (S3) | root | 2026-10-20 |
| RC-Q33 | After-commit hook: the request dispatcher runs at most one after-commit function after the answer is sent, outside any transaction, with errors caught and counted; it never runs after a rollback or a failed attempt and never attaches to the worker or the Paper ledger commit. A GET writes no Paper row, and the audit writer refuses to run inside a transaction. | 12 (S3) | root | 2026-10-20 |
| RC-Q34 | S3a result. Read budget (OD-Q12) fixed at 5000 ledger rows, 5000 grid points, 2000 audit rows and 1000 pending rows: the measured p95 at the highest reachable load is about 2.4 s, below 5 s. The computation is synchronous and blocks the event loop for up to about that long per request, so before `QR2_PERFORMANCE_ENABLED` is turned on in any environment, slice S3b must move it off the event loop or bound repeated requests, and the budget is measured again. The plan history limit counts from UTC midnight of the request day. Period values are exact upper case; the broker defaults to `binance-global` and the period to `MONTH`. The response `cutoffs` carry counts, not global serial ids. The per-fill strategy-tag and slippage lists of 8.1 come in a later row-capped slice; S3a returns counts and the per-symbol unlotted quantity. | 8.1, 12 (S3), OD-Q12 | root | 2026-10-20 |
| RC-Q35 | S3b design. Each server process keeps one long-lived worker thread, matching the single computation slot. The main thread still reads the snapshot in its own REPEATABLE READ, READ ONLY transaction; the worker receives only plain snapshot data (no database handle), computes the view and composes the response, and returns only the response body and the audit findings, never ledger rows. A computation that runs past a deadline (provisional 10000 ms, fixed from the S3b measurement) or exhausts its heap limit (provisional 256 MB) stops the worker, answers 503 `QR2_REPORT_FAILED` with Retry-After, and the next request starts a new worker; no retry and no queue. Error answers keep the S3a mapping and add no public code; the after-commit audit runs only after a successful computation. The read budget is unchanged. Acceptance needs a sole-runner measurement at the read limit with open lots: event-loop delay at most 100 ms (p99 at most 50 ms), a parallel cheap request p95 at most 100 ms, and the route p95 at most the S3a p95 plus 300 ms and below 5 s. Replay speed-ups stay an optional later slice. Turning the route on anywhere remains a separate decision after S3b acceptance, and needs a reading of the server's memory headroom first. | 12 (S3), OD-Q12 | root | 2026-10-20 |
| RC-Q36 | S3b result. The RC-Q35 design is implemented. The deadline stays 10000 ms and the worker limits are 256 MB old generation, 32 MB young generation and 4 MB stack. The worker starts with an empty environment and imports only the pure part of the reader and the response composer; a message that cannot be read ends the job as a crash, and shutdown waits until the worker thread has ended. Sole-runner measurement at the read limit with open lots (Node 24 on Windows, 3 warm-up and 20 measured runs per case; F1 713 round trips, F2 1000 buys and 320 sells): with the worker the longest event-loop delay was 38.5 ms (F1) and 42.6 and 46.2 ms (F2, two runs), p99 at most 30 ms, and a parallel cheap request p95 about 1.1 ms, where the inline computation of S3a stalled the loop for up to about 3.7 s. The route p95 bar for F2 (S3a inline p95 3937 ms plus 300 = 4237 ms) was met in one of two runs (3859 ms) and missed in the other (4443 ms); every run stayed below 5 s, so the bar is recorded as not reliably met on this machine. A 512 MB old-generation limit was about 2.3 times slower in two runs (cause not investigated), so 256 MB stays. With a short test deadline, a computation stuck in a loop answered 503 after about 1.1 s. Before the route is turned on anywhere, the target server is measured again and its memory headroom is read | 12 (S3), OD-Q12 | root | 2026-10-20 |
| RC-Q37 | S4 design and S4-1 result. Root took an Opus draft as primary beside a Fable alternative. The capital-model declaration is its own offline extension `paper-capital-model` (marker `paper_capital_model_schema` version 1; states ABSENT, INSTALLED and OTHER, where the PARTIAL of 7.5 is OTHER) with the table `paper_capital_models` (primary key owner, currency, version): insert-only (QR002), SERIALIZABLE only (QR003), `declared_at` stamped from the database clock, and QR004 guards `paper_capital_models_owner`, `_version`, `_clock` and `_bot_set`. A declaration is gapless per owner and currency (versions 1 to 1000), names the owner's full Bot set (1 to 5 Bot ids, ascending), takes effect at the next UTC midnight at or after its stamp and never before an earlier version's effective time; it applies from its stamp and is visible from its commit. Withdrawal is a new `SHARED_HYPOTHETICAL` version. The rollback refuses while any declaration exists, under an ACCESS EXCLUSIVE lock in the tool and in the SQL file; the classifier also checks the internal foreign-key triggers. Grants: the table insert-only, the marker read-only. Two SERIALIZABLE writers of the same next version give 40001 for the loser, so the PUT treats 40001 as a dispatcher retry and never as a conflict, and maps `paper_capital_models_effective_from_check` by constraint name. These rules are provisional until the owner decides the S4 items (effective time, full-set rule, withdrawal form, THB, caps). The O12 export, confirmed rollback and restore rehearsal (S4-3), the PUT (S4-4) and the owner route (S4-5) follow; nothing is installed or routed | 4.2, 7.2, 7.5, 12 (S4) | root | 2026-10-20 |
| RC-Q38 | S4-2 result. The pure module `src/portfolio/qr2-allocation.js` computes the 4.2 owner total from declarations, the owner Bot set and per-account summaries. The version that applies at an instant is the highest whose effective time is at or before it; no version at `from` gives `CAPITAL_MODEL_NOT_DECLARED` and a later version effective before `to` gives `ALLOCATION_DECLARATION_CHANGED`; `SHARED_HYPOTHETICAL` gives `NOT_AGGREGABLE_SHARED_CAPITAL`. Accounts of Bots created at or after `to` are dropped; the remaining owner set must equal the declared set with every Bot created at or before `from` (`ALLOCATION_SET_CHANGED`); a listed Bot with no account in the currency adds no number. RX disjointness of signal ids (including those named by journal keys), journal keys, funding ids and position ids refuses the whole view with counts only. A member without NAV at both ends, flows, fees, money PnL or reconciliation nulls the total, so there is no partial total. Sums are exact decimals with a per-member and an aggregate identity check (`QR2_TOTAL_MISMATCH`); owner TWR and Modified Dietz stay null. `allocation.reason` holds declaration-level reasons only. New codes: `ALLOCATION_DECLARATION_CHANGED`, `ALLOCATION_RANGE_MISMATCH`, `ALLOCATION_MEMBER_UNAVAILABLE`, `ALLOCATION_NO_MEMBER_ACCOUNT`. Fees are summed as the per-Bot view reports them; whether the 8.1 fees are cumulative or range fees stays open. Nothing is wired; the S4-5 adapter maps real views to the module input | 4.2, 6.6, 10 | root | 2026-10-20 |
| RC-Q12 | Parity also compares ledger cumulative_pnl per position cycle (reset at flat) and journal cash_delta. | 13 item 3 | root | 2026-10-19 |
| RC-Q13 | Lot entry_price epochs: before the lot-fee boundary round18(quote/delta); at or after it (notional + fee)/qty; absent boundary and a lot fails the current formula gives LOT_EPOCH_UNKNOWN and SPLIT_NULL for the symbol. | 6.2 | root | 2026-10-19 |
| RC-Q14 | E0 fill before the recorded lot-table boundary replays with targetTradeId ignored; absent boundary keeps the halt. | 6.2 | root | 2026-10-19 |
| RC-Q15 | A fill and its journal row are one event at fills.received_at; inputs_hash filters journal rows by the paired fill's received_at. | 2.6 | root | 2026-10-19 |
| RC-Q16 | R3c after a replay halt returns NOT_RUN with reason REPLAY_HALTED. | 6.4 | root | 2026-10-19 |
| RC-Q17 | Todo rulings: age first (PRICE_OLDER_THAN_CARRY); L1 bind-to-last and NO_LOT limit; E1 PARTIAL_LOT_COVERAGE; LEDGER_RULE_UNREPLAYABLE meaning; boundary beats marker; nav_from = S_cash + 1 and period at S_cash; QUOTE_FROM_PRICE_LEGACY and QR2_INPUT_INVALID; FUNDING_SNAPSHOT_MISMATCH; funding sorts before a fill in the same ms; LOT_ORDER_AMBIGUOUS split; RI absolute from S_cost; grid end = resolved to; drawdown positive fraction of peak; PARTIAL versus PRICE_STALE COMPLETE; exposure round12 half-even; R3c tail alignment and SNAPSHOT_COUNT_MISMATCH; NAV proxy for ORDER_AMBIGUOUS; inclusive span end; coverage start at or after to gives null range and COVERAGE_STARTS_AFTER_REQUEST. Out of S1, still todo: allocation item 11 and RX QR2_TOTAL_MISMATCH (S4), R14/R15 and FILL_BEFORE_BAR (S2; FILL_BEFORE_BAR_UNCHECKED information when no bar time). | 2.1, 2.4, 2.6, 3.4, 3.5, 3.6, 6.2, 6.3, 6.4, 6.5, 6.6, 10 | root | 2026-10-19 |

Items closed by other decisions: OD-Q2 (O7), OD-Q3 (6.4, refusal only when the order changes the result), OD-Q4 (O15), OD-Q5 (O1), OD-Q7 (O3 and O11), OD-Q11 (R-A and R-B), OD-Q16 (D4).
