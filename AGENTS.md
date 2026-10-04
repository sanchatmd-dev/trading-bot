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
the platform running the root.

| Role | Scope | Codex model / effort | Claude model / effort |
| --- | --- | --- | --- |
| Root commander | Sole scheduling authority, integration, acceptance | gpt-6-astra / high | Opus 5.5 / xhigh, ultracode |
| Architecture auditor | Difficult architecture, audit, risk/accounting/parity review, escalated root cause | gpt-6-astra / medium | Opus 5.5 / high |
| Debugger | Difficult debugging and high-risk code fixes | gpt-6.1-sol / high | Opus 5.5 / medium |
| Operations | VPS operations, only on an explicit bounded commander dispatch | gpt-6.1-sol / high | Opus 5.5 / medium |
| Coder | Bounded implementation, including high-risk modules under review | gpt-6.1-sol / medium | Sonnet 5.5 / high |
| Tester | Independent focused acceptance and regression evidence | gpt-6.1-sol / medium | Sonnet 5.5 / medium |
| Routine worker | One small local code/UI/fixture slice with an explicit contract and observable acceptance | gpt-6.1-sol / medium | Sonnet 5.5 / medium |
| Documentation | Documentation and mechanical edits with no behavior change | gpt-6.1-sol / low | Sonnet 5.5 / low |
| Release clerk | Git/release clerical work | gpt-6.1-sol / low | Sonnet 5.5 / low |

All non-Astra Codex roles use GPT-6.1 Sol. Role boundaries and independent review
still apply even when implementer and reviewer use the same model. High effort
is reserved for debugger/operations work; bounded implementation, testing and
routine work use medium; documentation and release clerical work use low.

The effort sentence in the previous paragraph describes the Codex column; Claude
efforts come only from the Claude column and the Fable table. Claude effort order
is low < medium < high < xhigh < max. The Claude column is
graded: only root runs at xhigh, and every child role runs at high or below.
Opus 5.5 carries the judgement-heavy roles below root; Sonnet 5.5 carries volume
work. Opus 5.5 and Sonnet 5.5 are the primary Claude models. Fable 5.1 is
supplemental only, in the Claude-only roles below, and never replaces a primary
role. Do not use max effort or any other Claude model by default.
The root may deviate for one packet only (raise one effort level, move a Sonnet
role to Opus 5.5 after a second failed approach, or lower effort for a clearly
trivial packet), recording the reason in the packet; the next packet returns to
the table. A deviation never raises a child to xhigh or max.

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
passes the model and effort of the role it fills, from the Claude column or the
Fable table; root does not dispatch an agent without a named role. Each brief
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

### Claude-only Fable 5.1 roles

The owner re-added Fable 5.1 as a supplemental model on 2026-10-03. A Codex root
skips these rows. Fable's list price per token is about 2.5 times Opus 5.5 and five
times Sonnet 5.5. Its value is an independent lens from a different model, so use
it only where that independence adds value; mechanical, searchable or volume work
stays with the Sonnet roles.

| Role | Scope | Claude model / effort |
| --- | --- | --- |
| Second-opinion reviewer | One extra independent review or adversarial verify in a workflow verify stage or review, such as an accounting, fencing, recovery, security, parity or design slice, beside an Opus or Sonnet reviewer | Fable 5.1 / high |
| Alternative designer | One independent draft in a design judge panel beside an Opus or Sonnet draft; an Opus auditor judges and root decides | Fable 5.1 / high |
| Consistency scout | Read-only sweep for drift between Roadmap, Time Management, README, Context, handoffs and evidence, where the drift needs reasoning across documents rather than a search | Fable 5.1 / medium |

Fable boundaries, which no packet may relax:
- Fable output is never sole acceptance evidence, and Fable is never the only
  tester or reviewer of a slice. Root or an Opus/Sonnet role confirms every Fable
  finding before anyone acts on it or counts it as blocking.
- Fable never writes product code or tests, including database migrations,
  scheduler/fencing, accounting, Risk Manager, evaluator/parity, security and
  production operations. The reviewer and designer write only their assigned
  report or design draft under `.qa-local/` or the session scratchpad; the scout
  returns a packet only.
- Fable never does host or VPS work, Git, GO issuance, browser steps, root duty
  or acceptance.
- Fable roles follow the architecture-auditor developer_instructions except its
  fix-edit permission; Fable makes no fix edits. Checkpoint and handoff drafts
  stay with the Sonnet documentation role and root.
- Brief Fable with goal, constraints, evidence paths, acceptance bar, budget and
  stop condition, not a step-by-step script, plus the reason an independent
  perspective is worth the cost. Never present another model's output as a Fable
  result, or a Fable result as a primary-model result.

Fable agents count as read-only or verify agents toward the limits above, because
they write only under `.qa-local/` or the session scratchpad; one writer per file
still applies to those files. Dispatch at most one Fable child per workflow stage
and at most two per root at any time.

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
other platform to bypass a stop. No exact token balance or guaranteed future task
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
Never automatically redeem reset credits, buy credits or switch accounts.

The bands bind Claude ultracode workflows. Above 30%, the reservation covers the
whole wave of agents. Above 15% up to 30%, run no fan-out: one tiny task with at
most one agent. At or below 15%, or with all usage unknown, start no workflow.
Unknown short-window data allows only small provisional waves, never long
unattended runs. Workflow scripts cannot read usage, so root admits a whole
workflow run on one fresh reading only when its estimated cost for every stage
fits the known remaining-minus-reserve budget; larger work runs as separate
workflows with a fresh reading before each. Root reads usage again after every
workflow and stops admitting at a band change.

Claude meters Fable 5.1 in its own weekly Fable bucket as well as the shared
windows. Before each Fable dispatch, read that bucket and apply the same bands and
reserve to it, in addition to the all-models windows. If the Fable bucket is at or
below 15% remaining, or unknown, dispatch no Fable role: substitute the matching
Opus or Sonnet role (architecture auditor for the reviewer and designer;
documentation for the scout, or tester when the drift concerns test evidence) and
record the substitution in the packet. A stage that planned a Fable agent still
runs, with the substitute. The Fable bucket gates Fable dispatch only; it never
admits or stops Opus or Sonnet work, which the shared windows govern.

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
