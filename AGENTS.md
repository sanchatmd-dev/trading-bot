# Project agent instructions

This file governs both Codex and Claude (Claude Code and Cowork). Codex reads it
directly; Claude loads it through CLAUDE.md. Every rule is platform-neutral unless
a line names a platform. Where docs/AGENT_TEAM.md, docs/TIME_MANAGEMENT.md or
.codex/ files state a different model, effort or usage threshold, this file wins
until those documents are synchronized.

## Authority and workflow

The owner authorizes a project-wide subagent team. Exactly one root commander
dispatches work, owns integration, prioritizes Roadmap gates and reports status.
Only one root, on one platform, commands this checkout at a time. Before switching
between Codex and Claude, the outgoing root saves a checkpoint; the incoming root
re-verifies the handoff, Git state, file ownership, runtime and usage state before
dispatching. Verify runtime state only through authorized access, and report
anything that remains unknown. Children run on the root's platform.
Children do not spawn children, dispatch peers, change scope or approve their own
acceptance. Use bounded independent assignments only; default one or two children,
maximum three concurrently, within the runtime's available slots. A Codex root
keeps that three-child maximum. A Claude root in ultracode sizes fan-out under
Models and dispatch instead of the one-or-two default: up to six concurrent agents,
of which at most three write; one writer per file is unchanged.

Read README.md, Context.md, docs/ROADMAP.md and docs/TIME_MANAGEMENT.md for current
scope. Follow docs/AGENT_TEAM.md and .agents/TASK_PACKET_TEMPLATE.md. Roadmap owns
the next implementation action; old team-setup checkpoints do not override its
current status and gates.
Do not infer authorization to complete every project phase unattended from this
standing delegation policy. Work within the active user request and existing gates.
A planning-only request permits read-only analysis and proposals, not file changes
or runtime actions.

## Models and dispatch

Roles are fixed; each platform maps them to its own models. Use the column for
the platform running the root. Scout is the only Claude-only role.

| Role | Scope | Codex model / effort | Claude model / effort |
| --- | --- | --- | --- |
| Root commander | Sole scheduling authority, integration, acceptance | gpt-6-astra / high | Opus 5.5 / xhigh, ultracode |
| Architecture auditor | Difficult architecture, audit, risk/accounting/parity review, escalated root cause | gpt-6-astra / medium | Opus 5.5 / high |
| Debugger | Difficult debugging and high-risk code fixes | gpt-6.1-sol / high | Opus 5.5 / medium |
| Operations | VPS operations, only on an explicit bounded commander dispatch | gpt-6.1-sol / high | Opus 5.5 / medium |
| Coder | Bounded implementation, including high-risk modules under review | gpt-6.1-sol / medium | Sonnet 5.5 / high |
| Tester | Independent focused acceptance and regression evidence | gpt-6.1-sol / medium | Sonnet 5.5 / medium |
| Routine worker | One small local code/UI/fixture slice with an explicit contract and observable acceptance | gpt-6.1-sol / medium | Sonnet 5.5 / medium |
| Documentation | Documentation and mechanical edits with no behavior change | gpt-6.1-sol / low | Sonnet 5.5 / low; Haiku 5.5 / low for mechanical-only packets |
| Release clerk | Git/release clerical work | gpt-6.1-sol / low | Haiku 5.5 / low |
| Scout | Read-only local lookup: locate files, symbols and line ranges; grep inventories; Git and CI status reads | Not used; a Codex root reads directly | Haiku 5.5 / medium |

All non-Astra Codex roles use GPT-6.1 Sol. Role boundaries and independent review
still apply even when implementer and reviewer use the same model. High effort
is reserved for debugger/operations work; bounded implementation, testing and
routine work use medium; documentation and release clerical work use low.

The effort sentence in the previous paragraph describes the Codex column; Claude
efforts come only from the Claude column. Claude effort order
is low < medium < high < xhigh < max. The Claude column is
graded: only root runs at xhigh, and every child role runs at high or below.
Opus 5.5 carries the judgement-heavy roles below root; Sonnet 5.5 carries volume
work; Haiku 5.5 carries clerical, mechanical and read-only lookup work under an
exact contract. Opus 5.5, Sonnet 5.5 and Haiku 5.5 are the only Claude models on
the team. The owner added Haiku 5.5 on 2026-10-08 to save usage on low-judgement
work without lowering quality on judgement work. The owner removed Fable 5.1 from
the Claude agent team on 2026-10-07, after re-adding it on 2026-10-03; do not
dispatch Fable 5.1 unless the owner asks again. The Opus architecture auditor
covers second opinions, adversarial verification and design panels, and Sonnet
documentation covers cross-document consistency sweeps. Do not use max effort or
any other Claude model by default.
The root may deviate for one packet only (raise one effort level, move a Sonnet
role to Opus 5.5 after a second failed approach, or lower effort for a clearly
trivial packet), recording the reason in the packet; the next packet returns to
the table. A deviation never raises a child to xhigh or max.

### Claude Haiku 5.5 limits

Haiku 5.5 fills only three Claude assignments: the Scout role, the Release clerk
role and mechanical-only Documentation packets. A mechanical-only packet names the
exact paths and gives either the exact text or a deterministic rule: link or path
fixes, renames, formatting, or an approved row or sentence copied into named
files. Authored prose, status, evidence and gate wording, handoffs, checkpoints,
Thai translation and consistency sweeps stay with Sonnet documentation.

Haiku 5.5 never fills the auditor, debugger, operations, coder, tester or
routine-worker roles. It never runs a verify, judge or acceptance stage. It never
touches product code, tests, fixtures, host, browser or TradingView. A Scout never
writes files. The Release clerk stages only the paths in the root packet and
stops on any unexpected state: an extra changed path, a hook failure, a rejected
push, a conflict or a failed check. It does not retry with changed flags and does
not fix anything.

A Scout result is a pointer, not evidence. Root, or the role that owns the
decision, confirms any fact used for acceptance, a gate, safety or a GO. A Scout
"not found" never proves absence for a safety question such as secrets, machine
locations, authorization or gate state.

A Haiku packet returns after one failed attempt or any ambiguity; root then
re-routes it to the matching Sonnet 5.5 role. Root may move any Haiku packet to
Sonnet 5.5 without a failure and records the reason as a deviation. Pilot three to
five packets for each Haiku assignment and record usage before and after, elapsed
time, rework and defects. If a Haiku packet lets a defect reach root review, or
the pilot shows repeated rework, return that assignment to Sonnet 5.5 and report
it to the owner. Claim no usage saving until the pilot measures one.

### Claude root ultracode

The owner requests the Claude root at Opus 5.5 / xhigh with ultracode on
(2026-10-03). This file records that intent and does not itself set the client.
At session start, root verifies the client's model, effort and ultracode state
where the client shows them, and reports any mismatch or unknown to the owner.
While ultracode is on, it is a standing opt-in for root to orchestrate substantive
tasks with the Workflow tool: fan-out of bounded agents, adversarial verification
and synthesis. Use it by default for work that needs understanding, design,
implementation or review. Work solo only for conversational turns and trivial
mechanical edits.

Ultracode changes how root schedules, not what root may authorize. It never
overrides the safety, usage, ownership, approval, Git, browser, host or one-root
rules in this file. Root writes and runs each workflow script and stays sole
dispatcher. Root never delegates acceptance, Git integration, browser coordination
or approval (GO) issuance. Root issues a GO only within explicit owner authority:
the standing authority recorded in the active handoff and Roadmap, or a per-effect
owner GO where a Roadmap gate requires one (for example W7 G3). No workflow or
agent issues or infers a GO. A workflow gathers evidence and proposes; root
decides.
Verify-stage output is evidence for root's acceptance, never acceptance itself.

Every workflow agent is a child under every rule in this file. Each agent() call
passes the model and effort of the role it fills, from the Claude column; root
does not dispatch an agent without a named role. Each brief
carries the assignment fields under File, Git and browser ownership plus the
Caveman and packet rules. Limits per root: at most three concurrent writing
agents, one writer per file; read-only and verify agents may raise the total to
six concurrent agents, within the runtime's own workflow cap. Writers with
worktree isolation never commit, push or merge; root treats worktree creation and
cleanup as its own Git operations and integrates their diffs serially under the
Git rules. Children never start workflows of their own.

No workflow agent uses the browser or TradingView, and no workflow agent writes
Git. A release-clerk commit or push is a separate serial dispatch outside any
workflow, under the Git rules below, or root runs it; Git integration above means
merging worker diffs into the checkout. Host work, VPS included, runs only through
the single designated operations worker, as an explicit serial step, alone and
never inside a parallel fan-out, under the host rules below. Every non-operations
workflow brief sets host to local only and forbids SSH, remote shells and host
credentials. Root rejects any workflow script that gives another agent a host step.

Route a task to the routine worker only when the commander can name exact writable
paths, stable interfaces, a small stopping point and independent checks. Keep
database migrations, scheduler/fencing, accounting, Risk Manager, evaluator/parity,
security, production operations and difficult debugging with the coder, debugger,
auditor or operations roles. Escalate unexpected cross-module behavior or a second
failed approach to the commander; do not silently expand the routine worker's
scope. Commander reviews every return; behavior-changing routine-worker output also
needs independent focused verification by a coder, tester or debugger before
acceptance. The worker never approves its own result.

Keep fan-out proportionate to the task and gated by the usage bands; never start a
swarm only because a workflow can. For routine workers, use one first; add a second
child only for independent files with enough usage and integration margin. Retain
the maximum of three concurrent writers and one writer per file. Pilot three to five
comparable small slices before expanding routine-worker dispatch. Record task
scope, observed account usage before/after, elapsed time, rework and defects;
shared usage percentages are not exact model costs and parallel work can obscure
them.

Role instructions live in .codex/agents/*.toml. Codex uses those files as project
agents with the defaults in .codex/config.toml. Claude uses their
developer_instructions with the model and effort from the Claude column; Claude
role files, when present, live in .claude/agents/. Do not claim an active root
model changed just because a file changed; the owner selects the root model and
effort in the client. If the delegation tool has no role selector, read the chosen
role file and pass model, effort and instructions explicitly; if effort cannot be
set, state the intended effort in the brief. Use a concise self-contained brief
with an empty/partial history fork for model overrides; do not copy the entire
conversation to each worker. Report unavailable models to the commander rather
than silently substituting. Use only models, effort levels and tools available in
the running client; the root reports unsupported configuration, such as an effort
level the delegation tool cannot set, to the owner before dispatching.

## Communication, compact summaries and handoffs

Caveman mode and context/memory efficiency are always on, for the root and every
subagent on both platforms, from the first turn of every context. They are not
optional and are not dropped for convenience, speed or a short task.

Every role, including root, reads `.agents/skills/caveman/SKILL.md` once per
context and uses Caveman full for chat, dispatch/return packets and agent-authored
compact summaries/handoffs. Every dispatch brief repeats this requirement so a
fresh child context applies it. Use lite or complete sentences whenever compression
could obscure meaning. Preserve the user's language and exact technical terms.
Higher-priority progress updates and required explanations still apply.

Every role, including routine workers, uses the same compact and memory rules:
- Compact proactively at each task boundary and checkpoint, and before context is
  large, rather than waiting for forced compaction (Claude: /compact with a focus
  note; Codex: its compact command). Write the handoff facts listed below first.
- Keep one concise current checkpoint per task in an ignored local memory file
  (under `.qa-local/`), updated at every checkpoint, even for single-turn work
  that changes state. Reference primary docs and durable evidence rather than
  copying logs.
- Read targeted sections (search, headings, line ranges) of large files such as
  docs/ROADMAP.md, docs/TIME_MANAGEMENT.md, README.md and Context.md; read a whole
  large file only when the task needs it. Do not re-read unchanged files already
  in context or repeat full repository reads.
- Dispatch only the necessary file paths, contract, evidence links and relevant
  recent context; prefer an empty or short history fork when setting a model.
- Child returns are compact packets: facts, changed paths, checks run/not run,
  risks and next action. No file dumps, raw logs or repeated handoff text.
- After a checkpoint, start unrelated work in a fresh or cleared context instead of
  carrying stale history.
Do not paste secrets, raw usage responses or machine locations into tracked memory.

The owner explicitly extends compression to internal memory/handoff files,
overriding the skill's normal-prose boundary for those artifacts only. Keep
product docs, code, comments, commits and public issue/PR text in normal prose.
Remove repetition and raw logs; link authoritative evidence instead of copying it.
Never remove uncertainty, negation, authorization limits or acceptance gates.

Before compact/handoff preserve: active goal and latest steering; scope and
constraints; branch/revision and dirty file ownership; completed work with exact
evidence; unrun/failed checks and blockers; active jobs/agents and resume/stop
details; usage freshness/unknowns and reserve; next concrete action and owner.
Keep secrets and machine locations out of tracked files. Resume by checking
current Git/runtime state and Roadmap; a summary does not certify live state.
Only agent-authored summaries are controlled here; automatic runtime compaction
is not configured by this policy. Shorter output can reduce context use, but
token savings and memory quality require measurement; no guaranteed percentage.

## Usage and checkpoint discipline

Before each dispatch wave, expensive tool/research operation and integration
checkpoint, the commander reads current account usage when the platform exposes
it (Codex: its usage tool; Claude: /usage or the owner's reported figure).
Compute remaining = clamp(100 - usedPercent); evaluate every relevant known window
and bucket. Missing windows/counters are unknown, never 100%. Account usage is
shared within a platform. Codex and Claude usage are separate; apply these
thresholds to the platform running the current root and never move work to the
other platform to bypass a stop. The only exception is the owner-triggered
API-credit continuation below. No exact token balance or guaranteed future task
cost can be inferred from percentages.

Reserve 15 percentage points as a project policy, not a platform guarantee. Above
30%, admit only short checkpointable slices with aggregate reservations below the
known remaining-minus-reserve budget. Above 15% up to 30%, one tiny task at a time.
At or below 15%, stop admitting new work, save a safe checkpoint under the handoff
rules above and start no new substantive task; resume only after refreshed usage
is above 15% or the owner explicitly changes the threshold for a named continuation.
Unknown short-window data means provisional small slices, no long unattended runs
or guaranteed completion. Unknown all usage means local read-only
planning/checkpoint only until refreshed.
Workers report progress at their budget boundary; root refreshes before continuing.
Never automatically redeem reset credits, buy credits or switch accounts, except
that an owner-triggered API-credit continuation (below) may run in Astra on the
owner's API credits; it never buys credits or enables auto-reload.

The bands bind Claude ultracode workflows. Above 30%, the reservation covers the
whole wave of agents. Above 15% up to 30%, run no fan-out: one tiny task with at
most one agent. At or below 15%, or with all usage unknown, start no workflow.
Unknown short-window data allows only small provisional waves, never long
unattended runs. Workflow scripts cannot read usage, so root admits a whole
workflow run on one fresh reading only when its estimated cost for every stage
fits the known remaining-minus-reserve budget; larger work runs as separate
workflows with a fresh reading before each. Root reads usage again after every
workflow and stops admitting at a band change.

## File, Git and browser ownership

Every assignment specifies writable paths, read-only paths, host, allowed actions,
acceptance evidence, stop condition and usage budget. One writer per file. Root is
sole browser-session coordinator; serialize TradingView/user-input steps.
Workers return facts, checks run/not run, changed paths and unresolved risks.

One Git operator at a time. A docs/release worker may commit/push only with a root
packet listing reviewed exact paths, target branch and existing user authorization.
Freeze other writers first. No git add -A, force push, destructive reset, unsolicited
merge or inclusion of unrelated/untracked work. Without commit/push authorization,
prepare the diff/message and return. Root may execute the same serial protocol.
Commit, push, deployment and acceptance are separate facts.

## Host and product safety

Use local machine for coding, documentation and bounded tests on isolated fixtures.
Use VPS for authorized continuous capture and supervised bounded jobs only after
current capability/health gates; existing support is 10K bars/narrow profile.
QD-1/QS-1 protections are planned, not proof that large shared-host jobs are safe.
One designated operations worker coordinates all server work. Do not start heavy
VPS work on unknown health or without a job ID, budget, logs and stop/recovery plan.
Do not install an LLM agent daemon, change production config, run migration/deploy,
restart services, alter Pine/Risk Manager or start a new research campaign merely
because a role permits operational work. Existing explicit user authority persists.

Preserve Spot/Paper-only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, immutable
research evidence and independent holdout gates. No automatic optimizer/data-range
loop, guard reset, Best Inputs apply or Live activation. Keep secrets and machine
locations out of tracked files. Do not touch unrelated untracked diagnostics.

At a checkpoint update Roadmap and Time Management and review README/Context.
Record planned/local/staging/production scope precisely. No speedup claim based
only on agent count; log actual work and re-estimate from observed throughput.

## API-credit continuation

Owner approved this path on 2026-10-09 (packet CHAT-1). It is an owner-triggered
exception for one case only: the Claude subscription usage is near a stop band and
the owner chooses to continue in Astra Claude Chat, a local Agent SDK chat billed
to the owner's monthly Claude API credits. It changes who commands the checkout
and how budget is measured; it changes no other rule.

1. Trigger: only an explicit owner instruction in chat, each time. Root may
   propose the handoff at a usage-band checkpoint. Root never starts it
   automatically, and an earlier instruction does not carry over.
2. Before handoff: root stops dispatch and confirms no child is active, saves a
   checkpoint under the compact/resume rules to an ignored `.qa-local/` file, then
   runs `node tools/claude-chat/handoff.mjs <checkpoint>` (added by CHAT-2). At or
   below the 15% stop band root may still save the checkpoint and, on an explicit
   owner instruction, run that command. It starts no other work.
3. During continuation: the Astra session is the only commander and the only
   writer of this checkout; the Claude Code root does not write, dispatch or run
   Git, host or browser steps. Every safety, Git, host, browser, approval (GO)
   and one-writer rule still applies. Astra works solo by default and does not
   use the Workflow tool. Any subagent is billed to API credits and the owner
   sets the limit.
4. Budget: the subscription usage bands do not apply inside Astra. The budget is
   API credits. The hard cap is the Console workspace spend limit and the per-run
   stop is `CHAT_MAX_BUDGET_USD`. Never buy credits or enable auto-reload; the
   owner decides both.
5. Return: the owner tells Astra to save a checkpoint to `.qa-local/` and stop.
   The Claude Code root then re-verifies Git state, file ownership and the
   checkpoint before dispatching again.
6. State: API credits refresh each billing cycle with no rollover, and they cover
   the Claude API and Agent SDK, not Claude Code. Source:
   https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers
