# Risk Manager — next implementation scope

Status: planned M1 risk-policy and Bridge-settings scope under [the revised roadmap](ROADMAP.md). Historical release references remain in the archived roadmap. This document does not change the Paper-only execution gate or activate an optimized strategy.

APP-3A staging acceptance passed on 2026-09-26; [the acceptance record](APP_3A_ACCEPTANCE_2026-09-26.md) selects a canary Paper model of fee 10 bps, slippage 1 bp and risk 1%. These test settings do not modify the owner's policy or production. A 10 bps slippage rehearsal was rejected because the BUY price exceeded frozen TP. QL-2A must reproduce that guard, sizing caps and costs; an optimizer cannot move protection levels or relax Bot limits to force acceptance.

QL-3A follow-up (local code, not deployed): the first fixed SPT run has zero validation trades. Paper `ledger_streak` persists through session reset, so an owner-reviewed re-arm endpoint/UI was added for one stopped, flat Paper account after pending orders are resolved and no trading/PnL activity remains on the current UTC day. It logs actor, reason, prior streak, locked-policy threshold/hash and session; it resets only the streak. Daily loss, risk policy, balances and historical trades remain unchanged. The owner must start a separate Paper session and collect new evidence; this control does not manufacture a Quant candidate. See [QL-3A](QL_3A_IMPLEMENTATION.md).

## Goal

Keep one authoritative Bot Risk Policy for execution while making the user interface easier to understand and making Quant Lab use the same recorded policy. A research candidate may request settings, but it cannot raise a Bot limit, change capital, bypass a guard, or activate a Bot.

## Delivery workflow: Pine → Paper → Quant → owner review

This Risk Manager work is the control boundary in the five-step workflow. The user keeps original Indicator logic. Robot Trade adds a Bridge with independent ATR-for-SL and RR defaults, runs the Bot on Paper, and records the evidence for Quant Lab. Quant Lab performs one optimization run and exports its result. The owner reviews Best Pine Inputs and the proposed Bot Risk Manager settings, then may explicitly apply eligible settings and start the Bot again. That action ends this workflow; it does not automatically feed the new Paper run back into another Quant optimization.

| Step | User action | System responsibility | Gate before the next step |
| --- | --- | --- | --- |
| 1. Connect Pine | Submit inspectable Pine v5/v6 indicator source; convert strategies externally first | Record source/version and separate Bridge/Quant capabilities; reject strategies before AI use | Unsupported Quant dependencies alone do not reject Bridge generation |
| 2. Build Bridge | Select 0–8 numeric variables, receive a draft and configure webhook | Add 2 mandatory Bridge slots (ATR SL 2.0/RR 1.5), preserve source calculations and track bounded AI job status | Total slots at most 10; pass Bridge-stage compile/binding/reference/webhook checks before isolated Paper use, without waiting for Quant samples/repaint |
| 3. Run Bot on Paper | Select Bot, broker and Paper capital; save policy; start the Bot | Freeze the Bot policy/capital snapshot, run risk checks, create allocations and record sessions, fills/cash/audit events and research data | Worker accepts/caps/rejects each signal against the frozen snapshot; exits remain reduce-only and allocation-scoped |
| 4. Quant Lab optimization | Select Bot, source membership and dataset cutoff | Resolve frozen policy/capital/source snapshots; prove baseline parity; execute one optimization run for the Pine-count mode | Unsupported source, missing baseline parity or incomplete required search produces no Best Inputs result |
| 5. Export and owner review | Review validated Best Pine Inputs and proposed Bot Risk Manager settings | QL-4B creates private package/report drafts; QL-4C validates before one-Pine owner review/apply. Enqueue mail only after validation and SMTP remediation; APP-3B additionally gates multi-Pine owner use. | Owner may apply eligible values and start the Bot, or finish. No post-export Paper/Quant loop. |

Workflow rules:

- With one Pine per Bot, optimize only 0–8 user-selected numeric inputs plus the 2 independent Bridge slots, total at most 10. All other inputs stay fixed and are labelled accordingly in the complete export snapshot. This replaces all-source-parameter optimization. With multiple Pine scripts all source inputs stay fixed and only the shared Bridge pair is searched. Preserve original formulas and hard limits; unsupported dependencies block the claimed capability.
- [PINE_BRIDGE_ADAPTER_API.md](PINE_BRIDGE_ADAPTER_API.md) separates Bridge structural scope from Quant evaluator coverage and numerical gates. Internal MTF/pivot/reference-symbol calculations may remain intact in a Bridge candidate; optimization requires their own evaluator/data-availability evidence. Each Bridge deployment executes only its selected chart symbol. Protected source is outside chatbot generation.
- The selected Bot policy, capital snapshot, source version, source data, optimization bounds and alert source form one validation record. Changing any of them marks the result/export stale. Each completed workflow is tied to one Quant `run_id` and one `export_id`.
- This indicator-only workflow exports `alert()` signals. Historical strategy order-fill utilities are outside its scope; the chatbot does not create strategy wrappers.
- Export and email do not edit Bot settings or activate a Bot. The owner reviews Best Pine Inputs and the Bot Risk Manager proposal; only an explicit apply-and-start action begins a new Bot session. That new run ends this workflow and does not trigger another Quant run automatically.

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

Show Bridge ATR/RR settings in a separate Bot Risk Manager area. These are strategy/Bridge settings, not hard Risk Policy ceilings. A saved Bridge value is a deployment proposal until the user creates a TradingView alert with the matching script/input snapshot. Show active and proposed deployment IDs separately; changing the web page does not update a running alert.

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

Optimization Bounds remain separate from Risk Policy. Bridge ATR Multiplier for SL and RR occupy 2 mandatory numeric slots, initialized to 2.0 and 1.5; their identities are fixed but their values remain optimizable. One Pine adds 0–8 user-selected numeric source slots; multiple Pine scripts permit only the shared pair. Unselected source inputs stay fixed. Never edit execution ceilings. Resolve membership server-side; membership/source/selection/domain/fixed-value changes invalidate evidence. Both ATR and RR must be implemented in the evaluator before enabling these modes.

### 6. Exit semantics

Use the versioned [bridge-exit-v1 contract](PINE_BRIDGE_ADAPTER_API.md#exit-semantics-bridge-exit-v1). The Bridge pair stays independent of source variables. Freeze SL/TP from entry signal-bar close and chart ATR(14); start protection at the next closed bar. Prioritize SL, TP, then native exit; both-touched bars choose SL, with at most one winning exit per entry/bar and no new BUY for that deployment on an exit-intent bar. Native exits target only that deployment's eligible entries.

The planned new Paper path and Quant replay share verified execution-bar close plus recorded adverse slippage/rounding/fees. Trigger levels are not fill promises; risk checks use the modeled fill and may reject an invalid stop. Rejected BUYs create no allocation, and capped BUY exits use only actual remaining quantity. Unknown target IDs never become symbol-wide exits. Existing sessions retain their recorded execution model. Bridge settings remain separate from hard policy limits and follow existing lock/version rules; this contract requires implementation before activation.

## Delivery order and acceptance

1. Fix dirty-state separation and add clear labels/capital/capacity presentation. Add UI tests for RUN, PAUSE and STOP states.
2. Add versioned Bot policy snapshots and server-side Quant policy resolution. Test Bot/tenant isolation, frozen-policy behavior, stale evidence and refusal of client policy overrides.
3. Add preview parity for sizing modes and targeted exits. Use shared Node fixtures for accepted, capped and rejected decisions.
4. Add the operational entry-pause control with audit history and worker enforcement.
5. Enable Optimization Bounds and Pine Export only for a source/exit combination that has passed baseline parity and the pre-optimization Paper run. Record Pine compilation/package checks in export review; do not require post-export Paper trading as another gate in this workflow.

Done when a user can see which Bot policy applies, distinguish capital from current ledger state, preview a request without changing a draft, and trace every Quant result/export to a locked policy snapshot. The worker must produce the same accept/cap/reject decision as the supported preview fixture.
