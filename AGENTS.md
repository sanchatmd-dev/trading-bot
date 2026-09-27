# Project agent instructions

## Authority and workflow

The owner authorizes a project-wide subagent team. Exactly one root commander
dispatches work, owns integration, prioritizes Roadmap gates and reports status.
Children do not spawn children, dispatch peers, change scope or approve their own
acceptance. Use bounded independent assignments only; default one or two children,
maximum three concurrently, within the runtime's available slots.

Read README.md, Context.md, docs/ROADMAP.md and docs/TIME_MANAGEMENT.md for current
scope. Follow docs/AGENT_TEAM.md and .agents/TASK_PACKET_TEMPLATE.md. Roadmap owns
the next implementation action; PF-1 is next at the team-setup checkpoint.
Do not infer authorization to complete every project phase unattended from this
standing delegation policy. Work within the active user request and existing gates.

## Models and dispatch

- Root commander: gpt-6-astra, high. This is the sole scheduling authority.
- Difficult architecture/audit: gpt-6-astra, medium.
- Coding/testing: gpt-6-sol, medium; debugging/high-risk code: gpt-6-sol, high.
- Documentation: gpt-6-luna, low; Git/release clerical work: gpt-6-sol, low.
- VPS operations: gpt-6-sol, high, only on an explicit bounded commander dispatch.

Project defaults/custom agents are in .codex/. Do not claim an active root model
changed just because a file changed. If the delegation tool has no role selector,
read the chosen role TOML and pass its model/effort and instructions explicitly.
Use a concise self-contained brief with an empty/partial history fork for model
overrides; do not copy the entire conversation to each worker. Report unavailable
models to the commander rather than silently substituting.

## Usage and checkpoint discipline

Before each dispatch wave, expensive tool/research operation and integration
checkpoint, the commander reads current account usage when the tool is available.
Compute remaining = clamp(100 - usedPercent); evaluate every relevant known window
and bucket. Missing windows/counters are unknown, never 100%. Account usage is shared.
No exact token balance or guaranteed future task cost can be inferred from percentages.

Reserve 20 percentage points as a project policy, not a platform guarantee. Above
30%, admit only short checkpointable slices with aggregate reservations below the
known remaining-minus-reserve budget. At 20–30%, one tiny task at a time; at <=20%,
save a safe checkpoint and start no new substantive task. Unknown short-window data
means provisional small slices, no long unattended runs or guaranteed completion.
Unknown all usage means local read-only planning/checkpoint only until refreshed.
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
