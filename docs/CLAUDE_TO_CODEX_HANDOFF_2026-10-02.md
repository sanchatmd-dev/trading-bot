# Claude to Codex — staging prototype handoff, 2026-10-02

## Goal and authority

The owner's goal is unchanged: staging preview first, then all six functional
steps (AI chatbot Bridge; ten numeric inputs; Preflight with explainable Risk
settings; real TradingView signals with Paper execution; bounded Quant
optimizer; durable Quant Library with qualified strategy comparison). See the
[delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md) and the
[previous handoff](CODEX_TO_CLAUDE_PROTOTYPE_HANDOFF_2026-10-01.md).

Existing authority stays: staging downtime anytime; mode, database, grant and
admission effects accepted; continue the project and commit/push meaningful
checkpoints. Still excluded: Live, production changes, automatic apply, guard
reset, automatic optimizer loop and unbounded study.

On 2026-10-02 at about 08:20 UTC the owner asked Claude to check and record the
current state, stop all work at a checkpoint and hand off to Codex. Claude
stopped its two running children at safe points; no code change is pending.
Earlier that day the owner allowed the Step 5 chain to continue into Claude's
15–30% weekly usage band. That allowance applied to Claude usage only.

## Incoming commander

Read AGENTS.md, the Caveman skill, README, Context, Roadmap current status,
Time Management and this handoff. Then read the private handoff notes and the
root checkpoint in the ignored local directory (the handoff notes first). They
hold host facts, tool versions, receipts and evidence paths that do not belong
in tracked files. Re-verify Git, runtime and usage before dispatching.

## Git baseline

Branch `codex/app3a-market-wait-checkpoint`; HEAD equals upstream after this
documentation commit. Claude commits on 2026-10-02: `68a6268` (PF-4),
`b2f0bae` (docs), `eb9d0a8` (docs, PF-4 on staging), `f36181c` (QR-1 Research
Library, CI 9/9), `eab1402` (docs, QR-1 on staging) and this handoff. The
untracked owner files `docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png` and
`scripts/build-spt-exit-diagnostic.mjs` stay unstaged.

Two Claude Desktop sessions started by the owner from task suggestions run
independently: one hardens a timing-sensitive PF-3 UI test, the other fixes a
flaky MFA replay test at a TOTP step boundary. Nothing from them was on this
branch at handoff. Check their branches before integrating anything.

## Staging state (read-only check, 2026-10-02 08:24 UTC, all checks passed)

- The staging API and trading worker run release `f36181c` (PF-3, PF-4, the
  guided Bridge wizard and the QR-1 Research Library).
- The research worker runs release `3309d07` in FOUNDATION idle mode with
  research admission closed and its I/O limit kept.
- The database runs in FOUNDATION mode (schema 14, 66 tables, no foundation
  jobs). Staging Analytics and legacy backtest/optimize answer 409 by design.
  Health reports `PAPER_ONLY`.
- The market stream, fallback timer and production are unchanged.
- After a VPS reboot only the database starts automatically; the five staging
  writers still need a manual start.
- The current switch tool supports only checks and rollback to `b2f0bae`. The
  next release needs a new tool version with a new drop-in layer; earlier tool
  versions must not be reused.

## The six steps at handoff

| Step | State on staging | Next |
| --- | --- | --- |
| 1. AI chatbot Bridge | Runs with real-provider evidence; the owner generated a new draft on 2026-10-02. | Owner acceptance at P1-F. |
| 2. Ten numeric inputs | The wizard handles up to eight source inputs plus Bridge ATR/RR. An SPT deployment with an approved eight-input lock exists. | Use it for Step 5. |
| 3. Preflight and Risk settings | PF-3 readiness and PF-4 proposals run. PF-2 stays off (R7 gate), so Step 3 is visible but not accepted. | R7 after D6. |
| 4. TradingView signals with Paper | The owner is setting up the alert; no signal had arrived at handoff. | Bounded Paper observation. |
| 5. Quant optimizer | Not started. A design exists in the private notes. | See below. |
| 6. Research Library | QR-1 view and minimum comparison run; no qualified winner is possible yet. | Owner acceptance and Thai review at P1-F. |

## Step 5 design summary

The shortest path does not need B3 or W7: the optimizer reads verified Bridge
market bars, and an eligible READY SPT deployment with more than 7,000
contiguous verified bars after the previous run's dataset exists. Three gaps
block it:

- a Quant page flow to submit, poll and cancel one foundation research job
  (medium size; the old optimize form calls the legacy route, which answers
  409);
- a research-worker wrapper so Python steps do not write bytecode caches into
  a release or virtual environment (small operations change);
- an API admission drop-in that sets the four research admission variables
  (small operations change; a missing variable stops the API from starting).

Owner decisions are listed in the private design: which deployment and frozen
bot, the input lock, 6,600 or 7,200 bars, budget 25 or 21 with a fixed seed,
the Python environment, an optional B3 canary, closing admission after the run,
proving cancel locally, and a later deterministic redeploy so that a policy
refresh needs no AI call. Estimated cost on Claude's scale was 9–14 weekly
usage points.

## Owner requests of 2026-10-02 (not implemented)

1. **Chart jumps to 1D after compile.** The generated Pine has no timeframe
   argument and cannot change the chart timeframe; its guard stops the script
   on any chart other than the registered symbol and timeframe. Ask the owner
   for a screenshot. The current source computes an alternate resolution with
   look-ahead, which can repaint; advise turning that option off.
2. **Timeframe select from 1 minute to 1 day.** The owner chose the full list
   (1m, 3m, 5m, 15m, 30m, 1h, 2h, 4h, 6h, 8h, 12h, 1D). The Bridge receiver
   and market wait need verified bars of the chosen timeframe, and the market
   stream writes 1m only, so a non-1m entry would expire today. Decide the bar
   supply before shipping the select; Preflight and Quant research stay 1m
   only and the page must say so.
3. **Generate cost wording.** Remove the dollar estimate; state that each AI
   call has a cost and that the plan quota is limited. Add a per-plan quota
   hook that is enforced only when a limit is configured, for future
   subscription plans.
4. **News block.** Hide "Block during news" in the Risk manager and add a
   protected port for a future AI news feed. The owner chose a per-bot switch,
   hidden and on by default. During an active news window a switched-on bot
   rejects new entries, exits stay allowed, and trading resumes by itself
   after the window with the same bot and run, without Resume. Missing news
   data must no longer reject entries. Keep both evaluator implementations in
   parity and stop treating missing news data as a PF-3/PF-4 failure.

## Other open items

- The 24-hour check after Window 2 is due on 2026-10-03 at 03:47 UTC.
- P1-A: B3 (optional canary), W7 C1/C2 (after Step 5), D6 Linux p99 and R7.
- QR-1b: results are checked at read time but not yet frozen in the database.
- P1-F polish and owner acceptance, including the Thai label review.
- Owner cleanup decisions for local leftovers recorded in the private notes.

## Usage

At handoff Claude's 5-hour window was 34% used and its weekly window 70% used
(weekly reset 2026-10-07 09:00 UTC). Codex usage is separate: Codex applies its
own windows and the 15-point project reserve.
