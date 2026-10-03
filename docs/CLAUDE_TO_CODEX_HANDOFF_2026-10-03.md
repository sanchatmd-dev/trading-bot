# Claude to Codex — staging prototype handoff, 2026-10-03

## Goal and authority

The owner's goal is unchanged: a staging prototype of all six functional steps
(AI Bridge; ten numeric inputs; Preflight with explainable Risk settings; real
TradingView signals with Paper execution; one bounded optimizer run; Research
Library). See the [delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md) and the
[previous Claude handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-02.md).

Existing authority stays: staging downtime anytime; mode, database, grant and
admission effects accepted; continue the project and commit/push meaningful
checkpoints. Still excluded: Live, production changes, automatic apply, guard
reset, automatic optimizer loop and unbounded study.

At about 04:10 UTC on 2026-10-03 the owner asked Claude to hand off to Codex and
said that Codex will use its computer-use skill to handle TradingView. Claude
finished the scheduled 24-hour Window-2 check and the owner-authorized cleanup
move, then stopped. No child agent runs, no Claude scheduled task remains and no
code change is pending.

## Incoming commander

Read AGENTS.md, the Caveman skill, README, Context, Roadmap current status, Time
Management and this handoff. Then read the private handoff notes and the root
checkpoint in the ignored local directory, handoff notes first. They hold host
facts, tool versions, receipts and identifiers that do not belong in tracked
files. Re-verify Git, runtime and usage before dispatching.

## Git baseline

Branch `codex/app3a-market-wait-checkpoint`; HEAD equals upstream after this
documentation commit. Claude commits after the Codex handoff at `ea9b55e`:

- `7c85b33` docs: Step 5 bounded run and research bytecode cache.
- `34e8652` per-plan AI quota, neutral AI cost wording and news-window block (CI 9/9).
- `f21deff` Activate-for-Paper control with a read-only deployment list (CI 9/9).
- `2044b07` docs: owner-request commits, cleanup and Step 4 findings.
- This handoff.

The two code commits are not deployed. The untracked owner files
`docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png` and
`scripts/build-spt-exit-diagnostic.mjs` stay unstaged.

## Staging state (read-only check, 2026-10-03 04:03 UTC, all checks passed)

- The API and trading worker run release `c3fa9e5`; research admission is closed.
- The research worker runs release `3309d07` with the bytecode-cache wrapper in
  FOUNDATION idle mode. No job is active; three historical jobs exist (two
  `NO_VALID_CANDIDATE`, one failed and cancelled).
- The database kept the Window-2 postmaster start (2026-10-02 03:45:48 UTC) with
  no restart. It runs in FOUNDATION mode with schema 14 and 66 tables. Table
  privileges, the legacy privilege matrix and the append-only rule match the
  Window-2 post record. Database size is about 61 MB; the disk is 8% used.
- PostgreSQL logged three ERROR lines since Window 2. All three came from
  Claude's own read-only diagnostic queries (one operator type error, two
  unknown-column errors). There were no FATAL or PANIC lines.
- Health is 200 `PAPER_ONLY`. Service process IDs are unchanged since
  2026-10-02 17:45 UTC, the fallback collector's last run succeeded, the market
  stream is active and production is unchanged.
- The 23 failed user units are old diagnostic transient units, unchanged since
  the cleanup baseline.

## The six steps at handoff

| Step | State on staging | Next |
| --- | --- | --- |
| 1. AI Bridge | Runs with real-provider evidence. | Owner acceptance at P1-F. |
| 2. Ten numeric inputs | The approved ten-dimension lock was used by Step 5. | None. |
| 3. Preflight and Risk settings | PF-3 readiness and PF-4 proposals run; PF-2 stays off (R7 gate). | R7 after D6. |
| 4. TradingView signals with Paper | Not demonstrated; see the blocker below. | Owner chooses A or B. |
| 5. Quant optimizer | One bounded run completed with `NO_VALID_CANDIDATE` (21 evaluations, holdout unopened). | None for the prototype. |
| 6. Research Library | QR-1 runs; no run can qualify as a winner yet. | Owner acceptance at P1-F. |

## Step 4 findings and TradingView work

- The READY SPT deployment (activated 2026-09-26 13:29 UTC) is the TradingView
  script `QL-3A SPT Custom ATR60 Paper 1m` with the execution alert
  `QL-3A SPT Custom ATR60 PAPER staging 1m`. Its last signal arrived
  2026-09-27 14:36 UTC.
- The alerts `SPT APP-3A native trace CAPTURE ONLY 1m`,
  `SPT APP-3A staging CAPTURE ONLY 1m` and `APP-3A transport CAPTURE ONLY 1m`
  are capture-only evidence alerts. They cannot place Paper orders.
- **Blocker.** The SPT Paper bot still holds one OPEN long from
  2026-09-27 00:34 UTC: entry 84,450.81, stop 83,626.98, target 85,454.52 and
  about 0.25 USDT cash left. The system closes an allocation only through an
  EXIT for that exact entry. The alert stopped, so that EXIT will not arrive, and
  the API has no manual close path (positions are read-only). If the alert
  restarts now, every BUY fails with `BELOW_QUANTITY_STEP` and every EXIT fails
  with `TARGET_NOT_OPEN`.
- Do not restart the ATR60 alert until the owner chooses one path:
  - A: an owner-confirmed "close Paper position" action. This is a
    ledger/accounting change: coder, independent audit, tests and a release.
  - B: a new SPT Paper bot with a fresh deployment, recorded execution evidence
    and a new execution alert. No code change, but TradingView compile and alert
    work.
- The ETRP Bridge stays DRAFT. It still lacks recorded execution evidence, a
  webhook secret and a Paper session.
- TradingView by computer use (owner's instruction): the owner signs in and
  enters webhook secrets and URLs. Never record a secret in a tracked file.
  Serialize TradingView steps.
- Some old capture-only alerts may still post to expired capture sessions. That
  is the likely source of about one "Request validation failed" error per
  minute; not yet confirmed. Stopping those alerts is the owner's choice.

## Release pending

`34e8652` and `f21deff` need a new switch tool version. The previous tool
assumes no engine change, but `quant_lab/src/robot_quant/risk_evaluator.py`
changed. At the switch, set `BLOCK_DURING_NEWS=true` so new profiles start with
the hidden news switch on. After deployment, PF-2 needs re-enrollment and a new
run, and the research worker needs a matching release and bytecode cache before
any further research job. Claude estimated 6–10 Claude usage points; Codex
re-estimates on its own scale.

## Owner decisions open

1. Step 4 path: A or B above.
2. When to release `34e8652` and `f21deff`.
3. The existing three bots' hidden news switch: keep it off (default, identical
   behavior without news windows) or turn it on (their Bridge snapshots become
   stale and need regeneration and recompile).

## Cleanup

- The labelled holding folder now holds 65 items with one manifest row each:
  62 moved on 2026-10-02 and 3 moved on 2026-10-03 after the 24-hour check (two
  old B2 backups and the inactive pre-relocation database copy, 408.7 MB).
  Nothing was deleted. Permanent deletion is the owner's action after the
  project.
- Kept: the Window-2 backup and release `f36181c` (rollback references), plus
  the 7 still-referenced items held on 2026-10-02.
- Risk: the market stream and fallback runtime directory lives under `/tmp`, so
  a reboot would remove it. After a reboot only PostgreSQL starts by itself.

## Other open items

- Bytecode cache: compile the symlinked modules into a new cache path and drop
  the named `sitecustomize` exception; add a cold page-cache readiness test.
- The Codex v6/W97 checks need a post-run adapter for the current job totals
  (3 jobs, 2 foundation jobs).
- Timeframe select 1m–1D needs a bar-supply decision; ask the owner for the
  timeframe-jump screenshot.
- P1-F polish and owner acceptance; D6 Linux p99; R7 PF-2 activation; W7 C1/C2;
  QR-1b result freeze.

## Usage

At handoff Claude's 5-hour window was 5% used and its weekly window 80% used
(weekly reset 2026-10-07 09:00 UTC). Codex usage is separate: Codex applies its
own windows and the 15-point project reserve.
