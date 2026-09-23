# Risk Manager — next implementation scope

Status: planned after release `555d8a4`. This document does not change the Paper-only execution gate or activate an optimized strategy.

## Goal

Keep one authoritative Bot Risk Policy for execution while making the user interface easier to understand and making Quant Lab use the same recorded policy. A research candidate may request settings, but it cannot raise a Bot limit, change capital, bypass a guard, or activate a Bot.

## Closed-loop delivery: Indicator → Bot → Quant → Export

This Risk Manager work is the control boundary inside the product's five-step closed loop. The user keeps the original Indicator logic; Robot Trade adds a transport bridge, evaluates execution risk, records Paper evidence, and later exports only approved existing inputs.

| Step | User action | System responsibility | Gate before the next step |
| --- | --- | --- | --- |
| 1. Connect Indicator | Select an Indicator/Strategy and its existing inputs | Record source identity/version, supported symbols/timeframes and alert capability | Classify it as webhook-ready, optimization-supported or export-validated; these are separate states |
| 2. Map Bridge | Install a reviewed Universal Signal Bridge or configure an exposed alert message | Map BUY, reduce-only exit, TP/SL, event identity, signal time and optional allocation reference without editing original signal logic | Send a Paper test signal; reject unsupported short-to-Spot mappings and incomplete exit identity |
| 3. Run Bot | Select Bot, broker and Paper capital; save policy; start the Bot | Freeze the Bot policy/capital snapshot, run risk checks, create allocations and record fills/cash/audit events | Worker accepts/caps/rejects each signal against the frozen snapshot; exits remain reduce-only and allocation-scoped |
| 4. Research Quant | Choose the same Bot, source version, dataset cutoff and whitelisted existing inputs | Read Bot-scoped data and recorded policy/capital snapshot; prove baseline parity before search; store run provenance | Unsupported/protected source or missing baseline parity has no optimization result |
| 5. Export and validate | Choose `alert()` or order-fill export, review input changes and deploy a new alert manually | Generate `inputs.json`, input diff, setup guide and only where supported a private wrapper; retain checksums and validation evidence | Compile in TradingView and complete a separate Paper forward run for the chosen source/export mode |

Rules for the loop:

- Optimization can change only declared existing inputs. It cannot replace an Indicator's formulas, sessions, MTF logic, signal state, sizing authority or hard risk limits.
- A protected Indicator may be webhook-ready but is not optimization-supported unless an authorized equivalent evaluator and baseline parity evidence exist.
- The selected Bot policy, capital snapshot, source version, source data, optimization bounds and alert source form one validation record. Changing any of them marks the result/export stale.
- `alert()` and strategy order-fill events are separate export modes. An Indicator cannot gain native strategy order fills without a validated strategy wrapper that preserves its semantics.
- Export does not edit the live Bot policy or activate a Bot. The user reviews the artifact and replaces the TradingView alert deliberately.

## Current behavior to preserve

- Each Bot has its own risk policy, configured Paper funding, positions, limits and webhook secret.
- Numeric **Max Value** fields are execution ceilings. **Default** fields seed the UI and calculator only.
- The execution worker remains authoritative for balance, reservations, limits, duplicate/stale checks and reduce-only exits.
- A RUNNING or PAUSED Bot freezes its editable risk policy. Paper-only remains enforced.

## Required UI and policy changes

### 1. Make policy authority visible

Split the page into three clearly labelled areas:

| Area | Purpose | Persisted / enforced |
| --- | --- | --- |
| Bot Risk Policy | Limits and guards owned by the selected Bot | Saved policy; locked snapshot when the Bot runs |
| Capital | Cumulative funding and current ledger state | Funding events, cash, reservations and book equity |
| Order Preview | A temporary estimate for one proposed signal | Never saves policy or blocks Run |

Show a policy version, snapshot hash, Bot label, broker and currency wherever a policy is saved, locked or used by Quant Lab. Explain that **Default** is a suggested request and **Max Value** is the hard ceiling checked by the worker.

### 2. Separate capital and capacity

Show these values separately for the selected Bot and broker: configured funding, ledger cash, reserved cash, available cash, book equity and current position cost. A funding edit must show the proposed increase or decrease before saving; it must never look like a direct edit to current cash or PnL.

Show both capacity measures:

- unique symbols held / remaining unique-symbol limit;
- open entry allocations (P1, P2, …) / remaining entry-allocation limit.

Do not relabel the current symbol-position limit as a scale-in allocation limit. Add an explicit allocation limit only when the worker enforces it.

### 3. Improve preview without changing policy

Changing Preview inputs must not mark the Risk Policy as dirty or block the Run button. The preview must label its inputs as hypothetical and show the policy snapshot used.

Expand preview coverage before presenting it as parity guidance:

- BUY: Percent Equity, fixed notional and explicit quantity;
- targeted reduce-only SELL: selected allocation, requested/remaining quantity and oversell rejection;
- all active caps and reservations, including daily limits and entry allocation capacity when introduced;
- guard provenance: volatility/news values are either verified source data, supplied signal data, or unavailable. The preview must never silently present unavailable guards as passed.

### 4. Emergency control

Provide a distinct per-Bot **Pause entries** / kill-switch control that is usable while RUNNING or PAUSED. It pauses new entries immediately and continues to allow valid reduce-only exits. It is operational control, not a risk-policy edit, and needs audit history, actor, time and reason. The existing administrator global kill switch remains a separate all-Bot control.

### 5. Connect Quant Lab to the selected Bot

`POST /api/quant/optimize` and risk previews must resolve the selected Bot server-side and load its saved/locked policy snapshot, capital basis, broker and currency. The client must not supply an alternative policy object as authority.

Every research run stores the Bot ID, policy version/hash, capital snapshot, data cutoff, indicator/source version, parameter bounds, cost assumptions and result status. A policy, funding, source or parameter change marks associated validation/export evidence stale.

Optimization Bounds remain separate from Risk Policy. They may search only whitelisted existing Indicator inputs and compatible existing SL/TP/RR inputs. They cannot edit execution ceilings. For multi-indicator runs, the UI and bridge must agree exactly on whether SL and RR are optimizable; unsupported fields remain locked and are recorded as locked.

### 6. Exit semantics

For each strategy connection, require an explicit exit source: **Indicator-managed exits** or **approved Bot exit policy**. Do not create or optimize SL/TP/RR values unless the selected source already supports them. Targeted exits carry the server-owned allocation/position reference and remain reduce-only in Spot mode.

## Delivery order and acceptance

1. Fix dirty-state separation and add clear labels/capital/capacity presentation. Add UI tests for RUN, PAUSE and STOP states.
2. Add versioned Bot policy snapshots and server-side Quant policy resolution. Test Bot/tenant isolation, frozen-policy behavior, stale evidence and refusal of client policy overrides.
3. Add preview parity for sizing modes and targeted exits. Use shared Node fixtures for accepted, capped and rejected decisions.
4. Add the operational entry-pause control with audit history and worker enforcement.
5. Enable Optimization Bounds and Pine Export only for a source/exit combination that has passed baseline parity and Paper forward acceptance.

Done when a user can see which Bot policy applies, distinguish capital from current ledger state, preview a request without changing a draft, and trace every Quant result/export to a locked policy snapshot. The worker must produce the same accept/cap/reject decision as the supported preview fixture.
