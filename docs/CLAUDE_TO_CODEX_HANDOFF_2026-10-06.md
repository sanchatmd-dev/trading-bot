# Claude to Codex — project handoff, 2026-10-06

## Read order and authority

At about 15:22 UTC (22:22 Bangkok) on 2026-10-06 the owner asked Claude to hand
the whole project and the latest work to Codex. Claude root stops. Codex becomes
the sole root. The previous handoff was Codex to Claude at `aedae35` on
2026-10-05 ([Codex to Claude](CODEX_TO_CLAUDE_HANDOFF_2026-10-05.md)); the
[earlier Claude to Codex handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-05.md) and the
[delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md) stay valid as history.

Read in this order. CLAUDE.md is Claude-only; Codex reads AGENTS.md and the
Caveman skill. Then read the private handoff in the ignored local directory
(`.qa-local/claude-to-codex-handoff-2026-10-06.md`) first, then this file, README,
Context, the top sections of the Roadmap and Time Management, and the newest
entries of `.qa-local/claude-root-current.md`. Host facts, release-tool namespaces
and pins, and identifiers live only in the private notes. This summary is not a
live-state certificate: re-verify Git, file ownership, usage and authorized runtime
before any dispatch.

Codex uses its own model column in AGENTS.md. Claude children are frozen and must
not be resumed. Fable roles are Claude-only. No Claude workflow, agent, timer or
cron runs.

Existing authority is unchanged: Spot/Paper only, no Live, no production change, no
automatic apply, no guard reset, no automatic optimizer or data-range loop. Closed
GOs are never replayed.

## Git baseline

Branch `codex/app3a-market-wait-checkpoint`. Claude added six commits after
`aedae35`, all docs-only, plus the commit that carries this handoff: `cee01dd`
(principal observation and group-write closure), `689e110` (finite worker limits),
`e879b06` (storage trust acceptance), `a325da5` (grants evidence), `b6ef2b2`
(research worker switch) and `f8d622e` (first BACKFILL and admission close).

CI: each docs-only commit passed the gate and scope checks, with the test,
container, PostgreSQL and quant jobs skipped as docs-only. The `a325da5` run was
repeated once after a GitHub outage and then passed.

Three owner files stay untracked and must never be staged:
`docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png` and
`scripts/build-spt-exit-diagnostic.mjs`. A `.claude/` directory (Claude app state)
appeared once in `git status`; never stage it.

## Staging state

Last read-only verification: 2026-10-06 about 15:18 UTC.

- API: release `5e398e7`. It restarted twice on 2026-10-06 for the admission
  (open and close) and has had no unplanned restart. All five
  research, profile and preflight flags are OFF and the temporary storage keys are
  absent, so the effective API environment equals the pre-admission baseline.
- Research worker: release `5e398e7` (a copy of the API served tree), no restarts
  since the switch. Finite limits are applied: CPU 50%, memory 512 MiB, swap 0,
  32 tasks. Worker research and foundation flags are ON as before. The old worker
  release `3309d07` stays on the host as the rollback path.
- Trading worker: release `f2bd332`, health 200 with PAPER_ONLY, queue empty.
- Datasets: the research store holds the earlier dataset and ATR14 entry plus the
  new BACKFILL page and final datasets (515 bars). They are raw only, not verified, and enrollment
  is not ready. Ledger entries: 0.
- Two READY deployments with the same owner: QL-3A SPT Custom Paper (slot 2) and
  SPT Prototype Paper 2026-10-03 (slot 3, `b45d9f9d`). QL-3A stays OPEN unchanged:
  the old 0.01181 BTC allocation stays open and its alert stays stopped.
- SQL activity counts rose from the 2026-10-04 reading (events, signals and pending
  163; entries and allocations 11). They are trading-side facts and were not
  reviewed.

## What Claude did, 2026-10-05 to 2026-10-06

All host steps were B3 work through one designated operations worker, with a
separate root GO for each step within owner approvals and no replayed GO. Evidence files are
under `docs/evidence/`.

1. Principal and group-write observation, closure of the group-write exposure:
   [evidence](evidence/B3_PRINCIPAL_GROUP_WRITE_2026-10-05.json), with the earlier
   [prerequisite observations](evidence/B3_PREREQUISITE_OBSERVATIONS_2026-10-05.json).
2. Finite research worker limits:
   [evidence](evidence/B3_WORKER_LIMITS_2026-10-05.json).
3. Storage trust acceptance:
   [evidence](evidence/B3_STORAGE_ACCEPTANCE_2026-10-05.json).
4. Grants sufficient for the BACKFILL path:
   [evidence](evidence/B3_GRANTS_2026-10-05.json).
5. Research worker switched to the API release `5e398e7`: a first staging run
   stopped at its timing check, a reviewed resume run passed, one switch run
   restarted the worker, and the first delayed check stopped on a ctime-only change
   before the second passed. Both stops led to tool fixes: [evidence](evidence/B3_WORKER_SWITCH_2026-10-06.json).
6. Admission, first staging BACKFILL and close: the owner was present, one API
   restart opened the research flags temporarily with storage keys, the owner
   enqueued once through the UI for the bot SPT Prototype Paper 2026-10-03, the job
   succeeded on the first attempt, and a second restart closed the flags and
   removed the keys. The 515 bars (500 warm-up plus 15 evaluation) have opens from
   11:18 to 19:52 UTC on 2026-09-25 and end at holdout boundary E (exclusive). [evidence](evidence/B3_FIRST_BACKFILL_2026-10-06.json).

## Lessons for the next root

- A serialized host payload must not reference module-level bindings. Require an
  exact-payload execution test and a free-identifier scan before any live step.
- A root-level periodic host process changes file ctime once per new file at
  five-minute marks, from minutes to about two hours after creation. It is most
  likely the provider security scanner running as root, but this is not proven.
  Cross-run comparisons must exclude ctime.
- The API Node env file sets the research flag ON, but a drop-in (`90-w7-b1`) shadows
  it with OFF for all five flags. Never remove or reorder that drop-in without
  accounting for it. The app treats a flag as on only when its value is exactly `1`.
- Storage on the host was partly pre-existing. Do not assume an empty store; check
  what is already there before admission.
- Product readiness allows at most 3 s for evaluations, but a cold Python import on
  a new cache took 3.4 s (1.1 s warm). Carry this into W7 and PROFILE.
- The legacy Python evaluation path in `src/postgres/quant-research-worker.js`
  passes only `quant_lab/src` on the path and exits 64 under the wrapper. It is
  pre-existing and not on the BACKFILL path.
- The admission design said the environment count rises by 4; the real change is 2
  because the flag keys already existed. The tool and plan were corrected.

## Owner decisions open

- S6: slot 10 `confirmLookback` versus `minRiskATR` with a new lock and TradingView
  axis parity, or a documented exception. Also full S4 and S7.
- The old QL-3A OPEN 0.01181 BTC allocation (no forced close; alert stays stopped).
- The authenticated Create Bot journey at three of three deployments.
- QL-P2 sizing or rejection label.
- MD-1 (pre-launch) and R7 (deferred).
- Least-privilege database role split: the shared role still has broad excess grants.
- Authenticated acceptance, including the History and Create Bot views.
- Principal closure stays UNKNOWN from the 2026-10-05 observation (13 processes in
  non-initial user namespaces); root chose no rerun.

## Next work

BACKFILL is done. Next in Roadmap order: W7 (not started; needs a plan, an
independent review and an owner GO, and must use the same owner and bot as the
dataset), then D6, R7 and PF-2. Roadmap owns the next implementation action and its
gates; this list does not override it.

## Practical notes

- Staging UI is reachable only through the owner's own port forwarding in Chrome, and
  it drops often. Never open tunnels.
- Host work only through one designated operations worker, serial, with a job ID,
  budget and stop plan.
- The release tools are once-only per job id. The admission and BACKFILL tools have
  used their critical steps, so any new admission (for example W7) or new BACKFILL
  needs a new tool namespace built from the accepted version. Namespaces and pins
  are in the private handoff only.
- Claude Write and Edit tools were blocked by a broken plugin hook during the
  session. This is a Claude-only issue and does not affect Codex.

## Usage

Claude at 15:20 UTC on 2026-10-06: 5-hour window 4%, weekly all-models 40%, Fable
19%. Codex usage is separate and unknown to Claude; Codex reads its own before
dispatch and applies the AGENTS.md bands.