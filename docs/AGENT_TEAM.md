# Project agent team and execution policy

Owner-requested setup, 2026-09-27. [Roadmap](ROADMAP.md) owns task sequence/gates;
[Time Management](TIME_MANAGEMENT.md) owns effort and waiting-time forecasts.
[AGENTS.md](../AGENTS.md) provides discoverable standing project instructions.
This team operates within the active authorized task; it does not start every phase
unattended or authorize a new research study merely because workers are available.

## One commander, reusable specialist roles

| Role | Model / effort | Responsibility | Boundary |
| --- | --- | --- | --- |
| Root commander | gpt-6-astra / high | Task selection, dependency gates, timeline, usage reservations, integration and final acceptance | Exactly one commander; never appoint a competing project manager |
| Architecture auditor | gpt-6-astra / medium | Independent difficult audit, risk/accounting/parity review, root-cause escalation | Advisory; no peer dispatch, approval of own fixes or independent operations |
| Routine worker | gpt-6.1-sol / medium | One small local code, UI or fixture slice with a stable contract and observable acceptance | No database migration, scheduler/fencing, accounting, Risk Manager, evaluator/parity, security, production operations or difficult debugging; escalate scope changes |
| Coder | gpt-6.1-sol / medium | Implement assigned code slice using established semantics | Exact file ownership; escalate complex failures |
| Debugger | gpt-6.1-sol / high | Reproduce and fix complex bugs/races | Root-defined scope; escalate after two failed approaches |
| Tester | gpt-6.1-sol / medium | Independent focused acceptance/regression evidence | Own test paths; application changes need reassignment |
| Documentation | gpt-6.1-sol / low | Synchronize docs, evidence summaries, links, arithmetic and handoffs | No invention of passing gates, time spent or technical decisions |
| Release clerk | gpt-6.1-sol / low | Execute reviewed Git checkpoint/push serially | Root handoff + actual user authority; no independent merge/deploy |
| Operations | gpt-6.1-sol / high | Designated executor of scoped local/VPS operational packets | Read-only default; mutations limited to existing user authority and readiness gates |

A Claude root uses the Claude column of [AGENTS.md](../AGENTS.md): Opus 5.5 /
xhigh root with ultracode (owner, 2026-10-03), graded Opus 5.5 and Sonnet 5.5
child roles only. The owner removed Fable 5.1 from the team again on 2026-10-07
(re-added 2026-10-03 after the 2026-10-01 removal). For a Claude root, the
ultracode concurrency and fan-out rules in AGENTS.md replace the
three-child maximum and the swarm-default sentences in the next paragraph and the
worker counts in the Usage admission table below (at most three concurrent
writers, one writer per file, at most six agents in total). The review,
independent-verification and pilot rules there still apply to every child.

The owner's "light" maps to supported effort `low`. Role profiles are in
`.codex/agents/`; root/default-child settings are in `.codex/config.toml`.
At most three children run concurrently with the root in this session. Usually
one or two are sufficient. Roles are reusable definitions, not permanently
running agents. Do not spawn a worker without useful independent work for it.
Start with one routine worker. Add a second child only for independent files
with enough shared usage and integration margin; a swarm is not the default.
Root reviews each return. Behavior-changing routine-worker output requires independent,
focused verification by a coder, tester or debugger before acceptance. Pilot
three to five comparable small slices, recording observed account usage,
elapsed time, rework and defects. Shared
usage percentages cannot identify exact per-agent cost.

Project config sets the requested root default to Astra High. It cannot prove or
hot-switch the model of an already active desktop turn. Verify the task's model
selection in the app; if it overrides project defaults, select Astra/High there.
Record requested/configured/observed model separately. No silent fallback when a
model is unavailable. The current collaboration API accepts explicit model/effort
and a task brief; it also exposes custom role selectors. Use a selector only when
its model and effort match AGENTS.md. If a loaded selector retains an older model,
read the current role profile and pass its instructions with explicit model/effort
using the default agent type and `fork_turns=none` or a small history fork.
A full-history fork does not support explicit model overrides here. Editing role
files does not prove that loaded selectors or running agents have changed.

Custom profiles persist in the repository; running child sessions are task-scoped
and can finish. Ending a chat does not leave a permanent team daemon running on
the local PC or VPS. This setup creates no recurring automation or new app tasks.

## Dispatch, review and release cycle

1. Root reads current scope and chooses the next eligible bounded slice.
2. Refresh usage and reserve integration/checkpoint capacity before spawning work.
3. Use [task packet](../.agents/TASK_PACKET_TEMPLATE.md): objective, model, exact
   file ownership, host, allowed actions, acceptance, evidence and stopping point.
4. Routine worker or coder owns assigned source. Tester may prepare fixtures after interfaces stabilize;
   only run against a declared stable snapshot, never a partly written shared file.
5. Root reviews returned facts and invokes Astra audit for difficult/high-impact
   changes. A worker cannot certify its own fix as independent acceptance.
6. Documentation updates only assigned files after root resolves facts. Freeze
   writers before giving the release clerk the exact reviewed paths and branch.
7. If commit/push is authorized, release clerk inspects staged diff, commits/pushes
   serially and verifies revision. Otherwise it returns a prepared checkpoint.
8. Root records status, remaining work, usage and next action. Deploy has its own
   applicable authorization, backup/health/rollback gates and operations packet.

Root alone coordinates browser focus, TradingView edits and user paste/confirmation
steps. Avoid duplicate expensive test runs, repeated full repository reads and
unnecessary model escalation. Shared source/lockfile/Git index ownership is exclusive.
All roles, including the routine worker, follow AGENTS.md Caveman full and compact
memory/handoff rules. Give workers only the necessary files, contract and evidence
links; use a short or empty history fork for model overrides. Store a concise
current checkpoint in ignored local memory when work spans turns, and verify live
Git/runtime state on resume.

## Usage admission policy

This is a conservative workflow policy, not a billing meter or guaranteed quota
lock. The account's allowance is shared with other tasks; usage can change while
this team runs. Different models need not consume it at the same rate.

Read usage before a dispatch wave, an expensive new operation and each checkpoint;
also refresh after an unexpectedly long/debug-heavy slice. Batch routine reads
inside the admitted slice rather than calling the usage tool for every file read.
Capture timestamps, bucket/window duration, remaining percentage and reset time.
Never store account IDs, reset-credit IDs or raw account responses in Git.

For each relevant known window `R = clamp(100 - usedPercent, 0, 100)`; use the most
restrictive relevant known window. Missing windows remain unknown. Token balance
cannot be calculated from percentages without provider capacity data. Percent
changes are account-wide observations, not exact per-agent billing.

| Remaining known allowance | Admission behavior |
| --- | --- |
| Above 30% | Short checkpointable work; default 1–2 workers. Third worker only for independent useful work within aggregate budget. |
| Above 15%, at most 30% | One tiny task; preserve integration/handoff margin. |
| At most 15% | Stop admitting work; no new substantive task; finish the smallest safe checkpoint and yield. |
| Short window unavailable | Mark unknown, permit only provisional small slices; no long unattended model work or promised completion. |
| All usage unavailable or refresh fails | Save checkpoint / local read-only planning; retry visibility before substantive dispatch. |

Protect a planning reserve of 15 percentage points in each known relevant window.
The same reserve applies on Codex and Claude; each platform's usage is tracked
separately against its own account.
Before launch, check `sum(active reservations) + next reservation < R - 15`.
Provisional reservations: 3 points for a short mapping/docs slice, 5 for a bounded
implementation/test slice, 10 for a difficult audit/debug slice. These are cautious
allowances, not measured prices. Split larger tasks; if no safe reservation fits,
defer. Calibrate from observed task history while noting concurrent account use.
Check partial progress before granting any extension; never use up the reserve
just because a worker is close to finishing. No automatic reset credit redemption,
credit purchase or account change. A reservation cannot prevent outside consumption
or a platform interruption; maintain resumable task packets and local checkpoints.

Usage snapshots belong in ignored `.qa-local/agent-team-usage.json` or the user
status message. Project docs record the policy and task outcomes, not mutable
personal account telemetry. Model usage, Gemini API billing and VPS CPU/disk are
separate budgets; visibility into one does not establish the others.

## Local PC and VPS execution

| Work | Preferred host | Conditions |
| --- | --- | --- |
| Code/docs/diff review, focused unit/UI checks | Local PC | Assigned files, isolated fixtures; serialize browser and shared files |
| PostgreSQL integration tests | Local isolated instance, or explicitly assigned isolated staging | Never production DB; identified create/drop scope and resource budget |
| Existing authorized continuous market/Paper capture | VPS | Preserve exact snapshot and gates; supervised service, observable logs and recovery |
| Historical fetch/replay/optimizer | VPS only if explicitly admitted; local alternative when feasible | Current capability, measured health, one heavy operation, bounded CPU/RAM/disk and stop/recovery plan |
| Production migration/deploy/restart | Designated operations role | User-authorized concrete change with existing release/backup/rollback gates |

The VPS is shared production hardware, not spare unrestricted compute. Follow
[capacity contracts](QUANT_CAPACITY_AND_INFRASTRUCTURE.md): current 10K/narrow
profile remains; QD-1/QS-1 and large-data controls are planned. Generic team setup
does not authorize 100K–1M runs now. Unknown health blocks heavy VPS work.
LLM inference is provided by the configured service; assigning a VPS task means
running project commands there, not installing or hosting the language model.

Before starting a continuous authorized job, record ID, source/input/policy hashes,
limits, checkpoint/log locations, termination condition and resume instructions in
private operational records. A running supervised collector can outlive a model turn,
but ongoing supervision/notifications must not be promised without an actual monitor.
Do not create overlapping collectors or restart sessions to manufacture samples.

## Skills by relevance

Use installed skills when the assigned task benefits; read the specific SKILL.md
and obey its scope. Do not load all skills into every worker or install plugins
merely to fill a role. Suggested routes:

- OpenAI Docs: Codex/model/agent configuration, with official product documentation.
- Supabase Postgres best practices: applicable SQL/index/transaction review only;
  the project remains self-managed PostgreSQL, no Supabase migration implied.
- Browser skill plus frontend debugging: concrete UI/TradingView verification with
  the root coordinating the active session and tool availability.
- Analyze data quality / validate data: dataset gaps/provenance/report arithmetic;
  do not bypass the project's parity/holdout contracts.
- Caveman: required for every role's chat, packets, agent-authored compact summaries
  and handoffs. Read the project skill once per context. AGENTS.md defines the
  owner's exception for compressed internal memory/handoff files. Use full by
  default, lite when clarity requires; product/public docs and code remain normal
  prose. Preserve constraints, uncertainty, evidence, live-job state and next action.
  This does not configure automatic runtime compaction or guarantee token savings.

## Setup checkpoint and next work

Three bounded workers were actually dispatched for setup: Astra Medium team audit,
Sol Medium PF-1 code map and Luna Low task-template creation. No PF-1 implementation,
VPS job, deployment or new collection was started by this setup.

PF-1 mapping identifies `src/postgres/server.js` preview, worker/risk/ledger and
`pine-bridge-execution.js` as core paths, plus `public/app.js`/`index.html` and
focused Node/PostgreSQL tests. Before implementation, root resolves saved/locked
policy versus draft semantics, missing dependency inputs, and capped versus rejected
oversized reduce-only exits against worker behavior. See Roadmap for the gate.

The 410–720-hour forecast is not divided by agent count. Track active work, elapsed
time, rework and machine waits separately; revise after observed throughput.

## Configuration sources and verification boundary

The current official [Subagents documentation](https://learn.chatgpt.com/docs/agent-configuration/subagents)
describes standalone project agent TOML files and per-agent model settings. The
[configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference)
describes project settings. Availability/current-turn overrides must still be
verified on the installed host; syntax validation alone is not proof of runtime routing.

Setup checks: all eight TOML files parse; the four `[agents]` keys used here exist
in the official config schema; installed `codex features list` exits successfully.
Project document link targets and whitespace checks pass. These checks do not
establish the currently active root model or enforce a billing reserve.
