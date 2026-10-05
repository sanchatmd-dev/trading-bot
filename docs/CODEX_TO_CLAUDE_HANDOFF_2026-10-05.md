# Codex to Claude — whole-project handoff, 2026-10-05

## Read order and command transfer

The owner requests transfer of the whole project and latest work to Claude.
Codex saves this checkpoint and stops dispatching. Claude becomes the sole root
after verifying the handoff. Earlier statements that Codex is the active root
are historical. No Codex child, host command or operational session remains active.

Read `CLAUDE.md`, `AGENTS.md` and `.agents/skills/caveman/SKILL.md`; then read
the private `.qa-local/codex-to-claude-handoff-2026-10-05.md` before this file.
Continue with [README](../README.md), [Context](../Context.md), current
[Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md) and the newest
`.qa-local/codex-root-current.md`. Private notes preserve machine access,
tool pins and consumed journals. These notes are not a live-state certificate.

Before dispatch, verify Git, file ownership, authorized runtime and Claude's own
usage. Follow the current Claude role column and ultracode/Fable rules in
AGENTS.md; older handoff model rules do not override it. Verify client settings
rather than claiming a model change from a file. Do not resume Codex children or
assume browser bindings transfer. Use bounded [task packets](../.agents/TASK_PACKET_TEMPLATE.md).

## Git and publication

Branch: `codex/app3a-market-wait-checkpoint`. Before this handoff documentation,
HEAD and origin were `149febbb0bcb9fc68b4523aaef74efbf0ec56a40`, with tracked files
clean. The commit carrying this file is the new handoff checkpoint; resolve it
from Git and verify its CI separately. Baseline CI passed three checks, with
four checks skipped for documentation scope. Source release `5e398e7` passed
nine of nine checks.

Nine commits followed the incoming Claude checkpoint `df51a7c`. Product changes
preserve deployed input selection in research submissions, label source versus
Bridge-only research capabilities and AI omissions, and refresh changed asset
cache versions. Later commits record local S7 acceptance, release-tool readiness,
the accepted API deployment and B3 observations.

Preserve the three unrelated owner files without staging them:
`docs/target-system-current-2026-09-29.png`,
`docs/target-system-current-2026-09-30.png`,
`scripts/build-spt-exit-diagnostic.mjs`.
Private operational files remain ignored and are available in this checkout,
not in a fresh clone.

## Product and six-step prototype

Robot Trade bridges indicators into Pine, receives TradingView Spot/Paper
signals, applies Risk Manager rules and records a PostgreSQL Paper ledger.
Quant Lab evaluates preserved research inputs and stores results with provenance.
The owner prioritizes the visible staging prototype and acceptance of all six steps.

1. **AI Bridge:** real-provider draft generation and compiled TradingView Bridge
   evidence exist. A fresh authenticated end-to-end job on the current API remains
   a separate acceptance step; sending source to an AI provider must retain the
   existing authorization and provenance.
2. **Ten numeric inputs:** S1, S2, S3 and S5 are accepted within their recorded
   scopes. S4 code is deployed, but authenticated behavior and full S4 remain open.
   New research submissions preserve the selection in their READY deployment;
   mismatch rejects, while an exact immutable retry retains its prior behavior.
   S6 remains an owner decision about `confirmLookback`, a proposed `minRiskATR`
   replacement, a new input lock and TradingView axis parity. S7 passed nine local
   mechanical replay cases with Node/Python parity on the frozen development
   prefix. Multiplier changes affect targets and quantities; RR changes TP targets
   but did not change realized decisions in that prefix. Full Step 2 is not accepted.
3. **Preflight/Risk settings:** PF-1 engineering and PF-3/PF-4 staging panels exist.
   PF-2 historical runtime remains off. B3, W7, D6 and R7 remain prerequisites;
   previews and proposals do not automatically save policy or activate a bot.
4. **Real signals/Paper execution:** natural BUY 66 and same-entry EXIT 85, plus
   later round trips, were proved in the incoming handoff. Preserve that evidence.
   The old QL-3A allocation remains OPEN for 0.01181 BTC in the last SQL check.
   Keep its alert stopped until the allocation is resolved. QL-P2 cash-capped
   sizing explains some quantity-step rejections; do not weaken guards to obtain trades.
5. **Optimizer:** the preserved 21-candidate run ended `NO_VALID_CANDIDATE`, with
   zero validation trades in every candidate and holdout unopened. Aggregate
   rejection counters do not prove one partition-specific cause or that more
   bars solve it. No new campaign, guard reset or optimizer loop is approved.
6. **Research Library:** staged inspection and history exist, including failed
   and insufficient outcomes. No qualified winner exists. Qualification, comparison,
   recommendation and actionable Best Inputs/export remain separate gates.

Whole-project progress is estimated at 65% (roughly 60–70%); prototype functionality
at 80–85%. These are judgment estimates, not a weighted completion calculation or
six-step acceptance. Operational observations have not closed the remaining large gates.

## Latest staging and local evidence

The API-only release `5e398e7` activated at 08:28:50.871 UTC. Its delayed check
passed at 08:40:29.836 UTC, 698.965 seconds later; root accepted the release at
08:41:52 UTC. Trading `f2bd332` and research `3309d07` were unchanged. Normal
rollback is now `2919f9b`, with a fresh reviewed GO required. The next API layer
must sort after the accepted `s05` layer; do not reuse it.
See [release evidence](evidence/STEP2_S4_STAGING_RELEASE_2026-10-05.json) and
[S4 continuation](STEP2_S4_CONTINUATION_2026-10-05.md#api-only-staging-release-checkpoint).

Last SQL observation was 09:27 UTC: research jobs, leases, launches, operations
and active AI/signals were zero; activity counts were 98/98/98/9/9 and the old
OPEN allocation was preserved. Resource observations at 09:57 and 10:08 UTC
did not refresh SQL. No fresh VPS probe was issued merely to prepare this handoff.

The worker used 64,782,336 bytes of memory, zero swap, one process and 11 threads.
CPU, memory and swap limits were unlimited; effective TasksMax was 9,483.
Observed OOM and task-limit event counters were zero. A proposed idle trial of
50% CPU, 512 MiB RAM, zero swap and 16 tasks passed local plan review; it has no
host executor and has not been applied or accepted as BACKFILL capacity.

Two shared configuration ancestors were group-writable. A bounded capability
read found Python xattr support and ENODATA for their access/default ACLs.
NSS uses files plus systemd; membership closure and mount semantics remain unknown.
This does not prove an untrusted writer exists or authorize shared-parent chmod.
Dataset storage was outside this latest capability read and remains independently
unproved. See [B3 evidence](evidence/B3_PREREQUISITE_OBSERVATIONS_2026-10-05.json).

The first resource collector stopped at PARENT_CHAIN; its consumed journal was
preserved. A separate corrected collector passed 73 local checks and independent
review, then returned observations. The capability collector passed 32 checks
and independent review before one observation. Root accepted observations only.
Do not replay consumed collectors, reset journals or promote their minimal envelope
validation into a mutation gate. Private reviews record remaining limitations.

Fresh browser reload around 09:53 UTC returned ERR_CONNECTION_REFUSED on the
owner's staging access channel. Previously visible content was cached and is not
current acceptance evidence. The owner restores their existing access channel;
agents must not open a tunnel. TradingView was untouched in this Codex continuation.

## Resume order, decisions and wider backlog

After incoming verification, choose one bounded B3 slice: scoped grant/executable
closure preparation, or targeted filesystem/principal trust evidence. Do not
repeat broad capped scans. A shared-permission change needs a concrete effect
proposal within owner authority. Finite worker limits require trust, preserved
old configuration bytes, an independently reviewed executor, fresh SQL/health
and separate immediate/delayed acceptance. B2 is complete and must not be rerun.

B3 BACKFILL runs in the main Node worker; W7 Python PROFILE calibration is a
distinct gate. W7 still lacks six measured physical I/O bounds; D6 actual Linux
contention and R7's owner-approved write-once boundary remain separate. An absent
new registry boundary does not erase historical holdout constraints.

Owner-dependent work remains: S6 input lock/TradingView parity, authenticated
Create Bot success at full 3/3 capacity or a specifically authorized test arrangement,
R7 boundary, old QL-3A OPEN resolution, and staging browser access. Do not delete
bots, expand licenses or force an EXIT to manufacture acceptance. Optional daily
chart parity and QL-P2 sizing/labels remain recorded choices.

The wider Roadmap still includes QD-1 expanded data admission, QS-1 recovery and
capacity proofs, actual market-valued Paper portfolio reporting, compatible
strategy comparisons, QR-4 validation-gated recommendations, Best Inputs and
Email Report, application/tenant acceptance and pre-launch MD-1 scale/legal gates.
Foundation/local wiring and one narrow measurement do not certify those phases.

Existing owner staging continuation, Computer Use and reviewed commit/push authority
persist. Preserve Spot/Paper-only, BINANCE:BTCUSDT Spot 1m, targeted reduce-only EXIT,
immutable evidence and independent holdout gates. No Live/production rollout,
automatic apply, guard reset or optimizer/data-range loop follows from this handoff.
TradingView uses Computer Use; the owner handles sign-in and webhook secrets.
Never put secrets or machine locations in tracked files.

Codex weekly remaining was 48% at 11:14 UTC; its short window is unknown.
Claude usage is separate and unverified. Refresh every relevant Claude window
and Fable bucket before dispatch; AGENTS.md's bands and 15-point reserve govern.
Do not transfer Codex percentages or historical floor exceptions between platforms.
