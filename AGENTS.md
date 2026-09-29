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
maximum three concurrently, within the runtime's available slots.

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
| Root commander | Sole scheduling authority, integration, acceptance | gpt-6-astra / high | Opus 5.5 / xhigh |
| Architecture auditor | Difficult architecture, audit, risk/accounting/parity review, escalated root cause | gpt-6-astra / medium | Opus 5.5 / high |
| Debugger | Difficult debugging and high-risk code fixes | gpt-6-sol / high | Opus 5.5 / medium |
| Operations | VPS operations, only on an explicit bounded commander dispatch | gpt-6-sol / high | Opus 5.5 / medium |
| Coder | Bounded implementation, including high-risk modules under review | gpt-6-sol / medium | Sonnet 5.5 / high |
| Tester | Independent focused acceptance and regression evidence | gpt-6-sol / medium | Sonnet 5.5 / medium |
| Routine worker | One small local code/UI/fixture slice with an explicit contract and observable acceptance | gpt-6-luna / medium | Sonnet 5.5 / medium |
| Documentation | Documentation and mechanical edits with no behavior change | gpt-6-luna / low | Sonnet 5.5 / low |
| Release clerk | Git/release clerical work | gpt-6-sol / low | Sonnet 5.5 / low |

Claude effort order is low < medium < high < xhigh < max. Opus 5.5 carries the
judgement-heavy roles; Sonnet 5.5 carries volume work. Do not use max effort or
other Claude models by default. The root may deviate for one packet only (raise
one effort level, move a Sonnet role to Opus 5.5 after a second failed approach,
or lower effort for a clearly trivial packet), recording the reason in the packet;
the next packet returns to the table.

Route a task to the routine worker only when the commander can name exact writable
paths, stable interfaces, a small stopping point and independent checks. Keep
database migrations, scheduler/fencing, accounting, Risk Manager, evaluator/parity,
security, production operations and difficult debugging with the coder, debugger,
auditor or operations roles. Escalate unexpected cross-module behavior or a second
failed approach to the commander; do not silently expand the routine worker's
scope. Commander reviews every return; behavior-changing routine-worker output also
needs independent focused verification by a coder, tester or debugger before
acceptance. The worker never approves its own result.

Do not start a swarm by default. Use one routine worker first; add a second child
only for independent files with enough usage and integration margin. Retain the
existing maximum of three children and one writer per file. Pilot three to five
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
