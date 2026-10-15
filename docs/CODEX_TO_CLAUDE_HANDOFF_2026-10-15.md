# Codex to Claude whole project handoff — 2026-10-15

Owner requested review of all returned work, a stop checkpoint, then this whole-project handoff to Claude. Implementation and dispatch are stopped. All three Codex worktree tasks completed; their final artifacts were reviewed and copied into the root checkout's ignored evidence area. No GO or host job is open. This handoff transfers context, not permission to resume implementation or execute host effects.

## Takeover and authority

Read in this order:

1. Private `.qa-local/codex-to-claude-handoff-2026-10-15.md`, then `.qa-local/codex-dp1p-current-2026-10-15.md`. These contain exact local artifact locations, checkpoint history and worktree ownership.
2. [AGENTS.md](../AGENTS.md), `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and [Agent Team](AGENT_TEAM.md). AGENTS wins over conflicting model, effort or usage instructions elsewhere.
3. Current top entries of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md). Older paragraphs describe historical states; do not reopen completed fixture work from them.
4. [Closing evidence](evidence/DP1P_WORKTREE_CLOSE_CHECKPOINT_2026-10-15.json), [PM-1 baseline](progress/PM1_BASELINE_2026-10-15.md) and [owner decisions](OWNER_DECISIONS_2026-10-13.md).

Before dispatch, verify Git, file ownership, active jobs, runtime and fresh Claude usage. Runtime/host verification must use authorized access; unknown is not healthy. Claude becomes the only commander only after takeover; Codex must not keep dispatching. Children use the root's platform. Do not resume the old Codex Chats as parallel commanders.

Claude configuration intent is Opus 5.5 / xhigh with ultracode, with the graded Claude roles in AGENTS. Verify actual client settings; a document does not configure them. Read Claude shared windows and the separate Fable bucket before applicable dispatch. The prior 2% reserve exception belonged to the stopped Codex continuation; do not infer it authorizes a new Claude run. Use current owner authority and AGENTS thresholds. No credit redemption, purchase or account switch is authorized.

The owner previously authorized bounded Root GOs, serial reviewed commit/push and worktree delegation for the Codex continuation. The later stop remains controlling. No consumed or expired GO may be reused. Owner-policy decisions and owner-present research gates were never replaced by broad continuation authority.

## Git and ownership

Reviewed work checkpoint: `13f85151b105abeeb4cfcf9dd549005561144bf0`, pushed to `codex/app3a-market-wait-checkpoint`, not main. This handoff is a later documentation-only change; resolve current HEAD and origin during takeover rather than expecting HEAD to remain at the work checkpoint.

Before this handoff edit, tracked files were clean. Only these owner files were untracked; never read, edit or stage them incidentally:

- `docs/target-system-current-2026-09-29.png`
- `docs/target-system-current-2026-09-30.png`
- `scripts/build-spt-exit-diagnostic.mjs`

Root is the sole Git operator. Retain the three worktrees and all ignored evidence; no archive or cleanup is needed for takeover. Some frozen source files live only in ignored local evidence, not in the tracked repository. The private index identifies root copies. A fresh clone alone is insufficient to reproduce those packets.

Two automatic completion messages failed with `thread not found` although the Root ID matched the environment and app listing. The owner forwarded the reports; Root directly retrieved and reviewed all artifacts. Delivery reliability is unresolved. Do not equate a send attempt with confirmed receipt or ask the owner to resend already preserved evidence.

## Whole-project scope and state

The product remains Spot/Paper only, using the supported BINANCE:BTCUSDT Spot 1m profile and reduce-only EXIT. Minimal prototype means one owner, one Bot, one supported Pine and the existing 10K-bar limit. A valid research journey may finish with `NO_VALID_CANDIDATE`; profit is not an acceptance condition. Live is outside the current progress denominator and is not authorized.

| Area | Current position | Remaining boundary |
| --- | --- | --- |
| Owner access, UI and Bot lifecycle | Existing scoped staging implementation | Current authenticated lifecycle and complete evidence reconciliation |
| Single-Pine AI Bridge and ten inputs | Implementation and retained generation/transport evidence | Ten-input round-trip, coherent selection and empirical effects/parity; owner dimension decisions |
| Paper execution, Risk Manager and accounting | O3/G1/F4/W1 corrections, transaction and lease protections developed and verified within recorded scopes | Provisional policy decisions, target release compatibility and production rollout |
| Market data and Preflight | Spot ingestion and one bounded BACKFILL accepted; PF-3/PF-4 implementation exists | PF-2 activation, current R7 capacity and authenticated policy journey |
| Evaluator and validation | Supported engine, cost/holdout implementation and partial parity evidence | Exact current-source carry and selected-input empirical parity |
| Optimizer and durable jobs | Bounded terminal run accepted; snapshot/progress/cancel implementation; LO1 containment closed locally | Fresh admission and complete current journey/target acceptance |
| Recovery and resource accounting | W7, J1–J4 and EM2 local tooling accepted in their stated scopes | Fresh owner-present measurement epoch and final R7 qualification |
| Research Library and freeze | Library implementation; QR-1b/hardening local code | Owner decisions, restore rehearsal, privileges and target migration |
| Best Inputs, export and email | Qualified end-to-end delivery not complete | Eligible evidence, package validation, SMTP/delivery and explicit owner review |
| Portfolio and full comparison | QR-2/QR-3/QR-4 remain future full outcomes | Portfolio valuation, common-context comparison and qualified selection |
| Multi-Pine and customer scale | APP-3B, MD-1 and customer Paper beta remain future main implementation | Isolation, capacity, data rights, security, quota and entitlement contracts |
| Deployment | Staging worker switch and immediate/10-minute observations passed; production candidate prepared | Staging 24-hour acceptance, production identity, packaging, recovery and owner gates |

Prototype stages are Bridge generation; eight source inputs plus ATR/RR; Preflight/Risk; TradingView/Paper; bounded optimization; Library/inspection/comparison. Real same-entry BUY/targeted EXIT and one bounded terminal run are accepted sub-outcomes. None of that closes every acceptance item across the six-stage journey.

## Progress measurement

Frozen inventory PM1-I1 contains 40 project and 14 prototype deliverables. Baseline PM1-B1-2026-10-15 gives project **46.12–70.40%** and prototype **52.00–82.42%**. These are engineering bounds under explicit UNKNOWN credits, not confidence intervals or readiness percentages. No single score or midpoint is justified.

Per deliverable: `0.10D + 0.40I + 0.30V + 0.20T`, then apply frozen category weights and shares. Stages are cumulative. [Method](PROGRESS_MEASUREMENT.md), [inventory](progress/PM1_INVENTORY_V1_2026-10-15.json), [scorecard and evidence pins](progress/PM1_BASELINE_2026-10-15.json). Replay with `node scripts/calculate-pm1-progress.mjs docs/progress/PM1_BASELINE_2026-10-15.json`.

New PO1/LO1/DP1 evidence has not yet been mapped into a successor scorecard. Keep the baseline immutable; create a separately reviewed revision when reconciling credits. Historical 70%/85% and 60%/75% estimates are non-comparable. UNKNOWN-weight figures 72.57%/75.83% are not unfinished-work percentages. Diagram color counts are not the formula.

## Code integration and exact CI completed during Codex continuation

| Work | Accepted evidence | Limits |
| --- | --- | --- |
| CX1–CX3, TH2 and FCL2 | Integration through `48bd05a`; exact CI on `837a953` passed all nine checks | Original cleanup failure and focused correction retained; not deployment |
| CX5 writer inventory guard | Tracked source/script inventory and independent local checks | Structural source guard, not a SQL parser or general runtime proof |
| PO1 runtime lease and fixtures | Independent original six cases passed 6/6; `9b63d77` exact CI passed 9/9 | Checkout-only protection; privileged in-lease changes and raw-pool bypass outside scope |
| LO1 legacy optimize containment | Ten-second monotonic upstream deadline, stream settlement and truthful outcomes; 20 independent PostgreSQL cases and 95 pure tests; `3a55976` exact CI 9/9 | Actual network lost-COMMIT acknowledgement remains untested; no transaction-boundary or database-timeout change |
| DP1-P application candidate | `70ea7f92a4547845291d32d836d3c740a0e7f1b7`, exact CI 9/9 | Candidate unchanged, not deployed; PO1/LO1 not backported into it |
| Exact inert dependency artifact on Linux | Carrier `6fe7a9ec6bcc7b28a061049715deccc48bfd9907`, all ten checks successful; 182 source files, 145 dependency files, 15 packages, both module probes, 12 syntax checks and 23 negative controls | Qualification of exact inert bytes on recorded Ubuntu runner, not installed production dependencies or application execution |

Primary records: [integration](evidence/INT_R7_FCL_LOCAL_INTEGRATION_2026-10-15.json), [integration CI](evidence/INT_R7_FCL_EXACT_CI_2026-10-15.json), [CX5](evidence/PAPER_WRITER_GUARD_CX5_LOCAL_2026-10-15.md), [PO1 CI](evidence/PO1_FIXTURE_EXACT_CI_2026-10-15.json), [LO1 CI](evidence/LO1_EXACT_CI_2026-10-15.json), [application CI](evidence/DP1P_APPLICATION_EXACT_CI_2026-10-15.json), [Linux artifact](evidence/DP1P_LINUX_EXACT_ARTIFACT_2026-10-15.json).

The last work checkpoint `13f8515` passed two scope checks and one gate check; four product suites were skipped because it changed documentation only. This does not replace the exact code CI results above.

## Actual staging and production observations

RO2 read-only observations on October 15 Bangkok found staging exposure 0 and production O3 exposure 352, with no reported findings or stall signature. Production also had one unlotted-quantity informational result. These are dated facts, not current balances or continuous health. [RO2 evidence](evidence/PAPER_LEDGER_RO2_READ_ONLY_2026-10-15.json).

The staging trading worker switched to `4d8682203ae19b68d0cad3252bdb5200d90f2e51` at **2026-10-15 05:17:53.400 Bangkok**. S3, immediate post-check and the 10-minute observation passed. The latter retained the same worker process, unchanged watched units, zero restarts and Paper-only observations. No positive new O3-rule fill was observed. The informational unknown-running count remained one. Production was unchanged. [Switch](evidence/DP1S_C02_STAGING_SWITCH_2026-10-15.json), [10-minute observation](evidence/DP1S_C02_POST10M_2026-10-15.json).

The staging 24-hour observation is **not before 2026-10-16 05:17:53.400 Bangkok** (`2026-10-15T22:17:53.400Z`). It still needs a fresh authorized observation and Root acceptance; elapsed time alone never passes it.

Latest scoped production discovery completed at **2026-10-15 13:48:25.593 Bangkok**. WORKER/API process identities were observed, with sampled shared-symlink agreement. Both bound watch services still omitted `EnvironmentFiles` despite `--all`: 28 properties present, loaded/active, but full identity UNKNOWN. WATCH_3/4 were unbound. Environment/package/lock sizes were 766/980/25392 bytes, metadata only; no package content hashes were obtained. Current typed values, installed busctl capability and loaded-code identity remain unproven. [Property observation](evidence/DP1P_PROPERTY_OBSERVATION_2026-10-15.json).

Upstream systemd v252 can omit an empty EnvironmentFiles array from printed output; that explains a possible mechanism, not the installed host's actual cause. Never synthesize missing as empty. Even a future typed-empty diagnostic leaves identity UNKNOWN.

## Latest local DP1 prerequisites and blockers

| Packet | Root decision and evidence | Remaining boundary |
| --- | --- | --- |
| Directory helper R2 | 39 author + 23 independent controls accepted | Paired sampled mapping evidence; no atomic/no-ABA or loaded-code proof |
| Composer C1 | 13 copied + 12 independent controls; three mutations detected | Caller config semantics, mutable output Buffer and operational same-buffer pinning remain external |
| CREDIT2 ledger | 36 copied, 15 mutations and eight additional controls accepted | Accounting only; no approved production quota or effect authority |
| Directory/process bridge C2 | 16 copied + 15 independent controls, six mutations accepted | Injected reader only; actual reader/runner/output integration unverified |
| Typed-empty parser | 27 copied + 13 independent controls, five plus six mutations | Complete trusted capture only; nonempty/error stays UNKNOWN |
| Injected typed observer P3 | 44 copied + 16 independent controls, six plus three mutations | Two fixed calls, original 22-second deadline; no native capability/transport proof |
| Native capture normalizer | Root independent replay: 16 copied + nine independent tests, three mutations; 18 fixed local child calls | Windows Node only; caller authentic capture/unclipped bytes/options required; no Linux/busctl/production shared-clock proof |
| C3 packaging | Independent four-test reproduction of 50,767-byte witness against 49,152-byte cap; unchanged composer returns PAYLOAD_CAP | Exact draft/witness blocked by 1,615 bytes; not proof all layouts fail. Runtime draft incomplete. No cap increase, stripping, compression or narrower selector scope approved |
| CREDIT2 placement | Static model reviewed; ten input pins verified | Normal S3 11, unknown post seven, reachable stable combined 20. Fixed reserve 11 requires total at least 22 in that model; none is an approved quota |

[Directory helper](evidence/DP1P_DIRECTORY_GUARD_LOCAL_2026-10-15.json), [composer and retained failures](evidence/DP1P_PARALLEL_DESIGN_REVIEW_2026-10-15.json), [ledger](evidence/DP1P_RECOVERY_LEDGER_LOCAL_2026-10-15.json), [bridge](evidence/DP1P_DIRECTORY_BRIDGE_LOCAL_2026-10-15.json), [parser](evidence/DP1P_TYPED_EMPTY_PARSER_LOCAL_2026-10-15.json), [observer](evidence/DP1P_TYPED_OBSERVER_LOCAL_2026-10-15.json), [native capture, packaging and placement close record](evidence/DP1P_WORKTREE_CLOSE_CHECKPOINT_2026-10-15.json).

CREDIT2 allows one fresh recovery entry after normal reserve refusal, without resetting spent credits or original time. Drift/UNKNOWN, clock failure and guard overrun remain fatal. Guarded config-only cleanup therefore cannot continue after a fatal failure. Do not bypass the latch in catch/TERM/unwind. Alias-independent restoration would require its own exact-ownership/byte proof and reviewed authority.

One C2-backed logical guard has one helper invocation, at most eight logical process samples and at most 136 directory API calls. These counters are distinct and exclude reader-internal syscalls. Full duration and phase-specific process requirements remain undefined; a stopped worker cannot reuse active-worker evidence. Never reset the discovery 22-second clock to insert this bridge into S3. Bounded readiness, shared deadline, exact restoration proof and independent trace coverage remain prerequisites.

## Retained failures and overclaim traps

- PO1's first fixture lacked 24 Quant inputs; the original failure remains. The later complete fixture and six cases close that specific gate.
- The original Windows Python fixture CI failure cause remains UNKNOWN; a slow startup reproduced its symptom, and the test-only 60-second bound passed later exact CI.
- DP1-P combined synthetic run remains 136 passes plus one failed inherited PORT fixture. Separate corrected controls passed 5/5; do not claim one 137/137 green run.
- CREDIT1 originally blocked recovery after normal reserve refusal. CREDIT2 corrects the Root contract; it does not authorize fatal recovery.
- The first independent C2 run used invalid lowercase fixture IDs; its failure is retained. Only fixture IDs changed.
- A P3 mutation probe initially survived because the parser still rejected the second incomplete reply. The probe moved to the first reply; no candidate behavior or negative expectation weakened.
- D4-P1's report incorrectly claimed fixture cleanup; inert synthetic fixtures remain. They are not live jobs.
- An expired discovery GO was refused locally before SSH. A fresh admission and separate E02 GO succeeded; freshness limits were not relaxed. Never replay consumed namespaces or wx-writing helpers.

## Open gates and next work after explicit resume

No new packet is assigned by this handoff. On owner resume, revalidate state and follow current Roadmap. The next bounded local decisions are:

1. Choose a revised C3 packaging contract from the retained measurements. Preserve caps and frozen modules unless a specific reviewed change is authorized. Complete actual clock/reader/projection tests before runner wiring.
2. Define CREDIT2 phase-specific evidence, full guard budget, bounded readiness and fatal-cleanup authority. Build an injected adapter/trace model and independently test it before production integration. Do not adopt 22 credits as an approved setting.
3. Review native observer/capture packaging, executable provenance, options and original shared deadline. Installed capability needs its own bounded observation; local Windows tests grant no host GO.
4. When eligible and authorized, run the staging 24-hour observation. Continue production release preparation only after relevant identity, dependency, recovery and policy gates close.
5. Reconcile new evidence into a successor PM-1 scorecard using unchanged inventory/weights; preserve the original baseline.

Owner decisions still include G1 D11 lots-first/unlotted policy; W1 D7–D11/D13/D14 retry/hold rules; QR-1b D1–D4 and TEMP/privilege/seal/restore-window choices; and R7/EM2 Q1–Q19 with owner-reviewed/execution-ready gates still open. Historical decision-list wording about uncommitted changes may be stale; use newer evidence and actual Git for completion, without treating technical completion as policy approval.

Deploying the current branch is different from deploying the older candidate. From `40e3b6b`, API/worker startup requires the ledger fence table: an applicable release needs its separately authorized offline migration/inspection window. Do not deploy HEAD, backport PO1/LO1, migrate, change grants, restart services, repair SQL, open research flags or run a new campaign by inference.

Preserve immutable research evidence and independent holdout gates. No automatic optimization/data-range loop, guard reset, Best Inputs apply or Live activation. Host steps remain serial through one designated operations worker with exact scope, fresh bounded GO, health/admission evidence, budget, logs and stop/recovery plan.
