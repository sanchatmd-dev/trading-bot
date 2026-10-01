# Codex to Claude — staging prototype handoff, 2026-10-01

## Goal and authority

Owner requests **staging preview first, then all six functional steps**:
AI chatbot Bridge; ten numeric inputs; Preflight with explainable Risk settings;
real TradingView signals with Paper execution; bounded Quant optimizer;
durable Quant Library with qualified strategy comparison.

Latest turn: prepare plan and handoff only. See
[delivery plan](STAGING_PROTOTYPE_PLAN_2026-10-01.md), indexed by Roadmap.
Existing authority: staging downtime anytime; accept mode/DB/grant/admission
effects; continue project and commit/push meaningful checkpoints. No repeated
downtime permission needed. Technical gates still apply. No Live, production
change, automatic apply, guard reset, automatic optimizer loop or unbounded study.

Owner explicitly requested Claude handoff. This is not an automatic platform
switch to evade usage limits. Claude must check its own usage and follow AGENTS;
Codex reserve remains unchanged. Do not redeem reset credits or switch accounts.

## Incoming commander

Read AGENTS.md, Caveman skill once per context, README, Context, Roadmap current
status, Time Management and this delivery plan. Use Caveman full for chat,
dispatch/returns and internal handoffs; retain clear full sentences when needed.

Exactly one root. Intended Claude root: Opus 5.5/xhigh, owner-selected in client;
configuration is not proof of the active model. Auditor Opus 5.5/high;
operations/debugger Opus 5.5/medium; coder Sonnet 5.5/high; tester/routine worker
Sonnet 5.5/medium; documentation/release Sonnet 5.5/low. No Fable or max effort.
Report unavailable settings; no silent substitutions. Children cannot dispatch.
Default one or two children, maximum three, one writer per file. Use
`.agents/TASK_PACKET_TEMPLATE.md`; exact writable paths required before dispatch.

## Git and jobs

Pre-handoff code/docs baseline: `9665cb0`, branch
`codex/app3a-market-wait-checkpoint`; upstream matched before this doc checkpoint.
This handoff and linked plan are added in the following documentation commit;
resolve actual HEAD/upstream at resume. W7 operational release stays pinned at
`28d6f7e`; do not confuse current Git HEAD with the dormant or active release.

Unrelated untracked files: `docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png`,
`scripts/build-spt-exit-diagnostic.mjs`. Preserve; do not stage them.

All three Codex children report completed: `w7_bootstrap_review`,
`w7_grants_fixture`, `w7_readonly_facts`. No new jobs/agents in this handoff turn.
Previous checkpoint reports no active owned SSH/test jobs. Host services are not
stopped merely because agents finished. Live runtime not reverified in this turn.
Claude establishes fresh ownership and runtime facts before dispatching.

## Accepted facts and open gates

- B1 accepted: research admission off, legacy research worker active/idle,
  physical 512 KiB/s read/write limits. Foundation/V2/enrollment/preflight off
  at last observation. Existing Bot stop state must be rechecked before any start.
- Four fallback definitions published; manager reloaded once. Independent
  reconciliation accepted file publication. Stop/start recovery not proved.
- Dormant W7 Linux artifact accepted: 714 files, 71 directories, 17 dependencies,
  four CJS/ESM imports, native process-group timeout and pre/post checks. No active
  release switch, migration, dataset creation or foundation startup from that proof.
- Grants v3 passed ten local real-schema checks; not applied on staging.
- PF-2 API/worker/enrollment wiring passed local tests. This is not Linux
  resource/latency proof or staging activation. PF-3/PF-4 and QR-1 remain work.
- Prior 100-candidate research result remains NO_VALID_CANDIDATE; holdout unopened.

**Next operations packet:** read-only confirmation of the five-minute fallback
timer/service's host source identity and effective DB target; extend recovery
coverage if a writer. It is a potential fifth writer, not yet confirmed from
host bytes. Four fallback definitions do not prove all-writer quiescence.
Then backup/restore validation, PostgreSQL lifecycle and final policy bindings;
review B2 offline and B2 startup separately.

PG durability settings ON and version-matched tools present do not prove backup,
restore or automatic restart. Temporary data-directory/session-scope observations
do not authorize moving or restarting the DB. Preserve RO3 partial READ_FAILED
and unrun follow-up evidence; do not overwrite or rerun frozen receipts.

After B2: B3 one bounded BACKFILL, W7 C1/C2 diagnostics once each, D6 Linux p99,
R7 durable enrollment/PF-2 staging activation. D6 blocks R7, not W7 diagnostics.
No current B2/B3/W7/D6/R7 execution acceptance or unconditional GO.

## Product priorities

Follow P0/P1 packets in the delivery plan. P0 exposes accepted capabilities on
a verified staging URL; pending steps are honest placeholders, not acceptance.
Root first checks whether an additive compatible UI preview can ship without
foundation/DB changes. If not, complete its relevant B2 prerequisites first.

P1 must exercise a real provider and real TradingView alerts, with Paper ledger
evidence. Ten inputs mean eight user-selected supported numeric source inputs
plus independent Bridge ATR/RR. Unsupported or fewer source inputs cannot be
hidden with filler fields. Revalidate all selected dimensions before optimization.
Library preserves failures and provenance; no qualified winner is valid. No
automatic settings apply, guard weakening or invented profitable result.

Exchange OHLCV supplies supported historical replay. TradingView UI remains for
compile, input/alert inspection and scoped parity/repaint evidence. Root alone
coordinates browser use. No continuous UI scraping or TradingView MCP dependency.

## Usage, evidence and resume

Latest observed Codex weekly usage: 86% used, 14% remaining; short window unknown;
reserve 15 percentage points. No reserve override granted. Codex admits only this
requested planning/checkpoint/handoff work. Claude usage unknown: refresh before
admitting work, apply all known windows and the same project reserve.

No implementation tests or runtime checks run for this documentation-only handoff.
Check Git diff, links, exact staged files and push result. No new delivery ETA;
re-estimate after P0 inventory from measured work, separate market wait.

Primary technical evidence: [B2/W7 checkpoint](PF2_W7_PREREQUISITE_CHECKPOINT_2026-10-01.md).
Private local resume details: `.qa-local/codex-root-current.md`,
`.qa-local/w7-b2-next-gate-review-2026-10-01.md`,
`.qa-local/w7-b2-recovery-readonly-2026-10-01.md`,
`.qa-local/w7-db-durability-readonly-2026-10-01.md`,
`.qa-local/w7-activation-tools-readonly-2026-10-01.md`.
These ignored files do not travel through Git; if absent, report missing facts
and reconstruct through authorized sanitized inspection. Never put raw secrets,
service environments or machine locations into tracked docs.

First actions: verify sole-root ownership; refresh Claude usage; inspect Git;
read latest B2 evidence; prepare bounded P0-A/P0-B packets. Save private current
memory and update Roadmap/Time Management at each accepted checkpoint.
