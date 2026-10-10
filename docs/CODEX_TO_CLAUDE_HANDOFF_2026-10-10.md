# Codex to Claude: whole-project handoff, 2026-10-10

The owner requested a handoff covering the whole project and the latest work. Codex has stopped implementation and is preparing this transfer checkpoint. All child assignments are complete. No deployment, host action, new measurement epoch, commit or push occurred in this Codex continuation. Claude must revalidate the checkout and take sole command before resuming work.

## Read order and authority

1. Read the private `.qa-local/codex-to-claude-handoff-2026-10-10.md` first.
2. Read this document, then [the latest v3 evidence](evidence/R7B_LINUX_PG_V3_PORTS_LOCAL_2026-10-10.json).
3. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the current sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md), [Context](../Context.md) and [Agent Team](AGENT_TEAM.md).
4. Read the [incoming Claude handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-10.md) and immutable [EM-1 evidence](evidence/R7B_MEASURE_EM1_2026-10-10.json) for historical operational facts. Their open local correction/readiness tasks are superseded by the local results below. Their closed-window restrictions remain in force.

Roadmap owns implementation priority. This handoff transfers context; it does not issue a GO or authorize every remaining project phase. The next implementation action, once Claude resumes under owner authority, is a bounded local H-12b/H-13 slice.

## Whole-project status

The six owner steps describe the product journey. They do not replace the Roadmap phase sequence: R-0, APP-3A, QL-2A, QL-3A, QL-4B, QL-4C, APP-3B, APP-4 and APP-5.

| Owner step | Recorded progress | Remaining gate |
| --- | --- | --- |
| 1. AI chatbot and Bridge | Real-provider and Bridge workflow evidence; staging UI and source binding | Full authenticated journey and unsupported source adaptations; Claude provider adapter remains a separate candidate |
| 2. Ten numeric inputs | S1/S2/S3/S5 accepted; S7 local mechanical replay; selection and snapshot staging release | S4 runtime, S6 `confirmLookback` owner decision and complete Step 2 acceptance |
| 3. Preflight and Risk Manager | PF-3/PF-4 staging; scoped W7 and D6 evidence | R7 measurement, capacity policy and enrollment; PF-2 activation; Preflight remains OFF in the last observation; UI panel release deferred |
| 4. Signal and Paper execution | Natural QL-P2 Paper BUY and same-entry reduce-only EXIT evidenced on 2026-10-04 | Old QL-3A OPEN allocation remains unresolved; its old alert must remain stopped; no Live activation |
| 5. Quant optimizer | Bounded 21-candidate run returned `NO_VALID_CANDIDATE`; separate raw BACKFILL contains 515 bars | No qualified winner; no automatic retry, new campaign or holdout access |
| 6. Research Library and best strategy | Research Library and Quant History staged | Actionable best-strategy export requires a qualified candidate; complete end-to-end acceptance remains open |

Whole-project sources are the current Roadmap/Context, the [2026-10-08 overview](CODEX_TO_CLAUDE_HANDOFF_2026-10-08.md) and the incoming 2026-10-10 handoff. Earlier held CX-A/CX-B and evaluator A+D work was incorporated in S07 at `325d335`; do not treat those historical proposals as still unreleased. Current remote branch retention and hosted CI were not checked.

Other backlog remains: authenticated Create Bot walkthrough at 3/3 capacity, S6, s08 UI release, QL-P2 label, MD-1 before public/paid launch, database-principal separation, `tools/**` CI coverage, Astra Claude Chat real-key verification, worktree cleanup and release timing. Do not let these displace the active R7 gate without an owner decision. API-credit continuation requires a separate explicit owner instruction each time.

## Last known runtime and EM-1 outcome

Live runtime is **unknown at this handoff**. The latest inherited observation was around 07:15 UTC on 2026-10-10: staging `eb532ff`, API health 200/PAPER_ONLY, all five research/foundation/PROFILEv2/enrollment/Preflight admission flags zero, research worker stopped. Protected Trading remained active and untouched in that observation. Codex performed no fresh host or browser verification.

EM-1 reached a successful second m0 baseline, then m1 failed API startup with `QUANT_STORAGE_LIMITS_REQUIRED`. The measurement tool omitted API storage-limits and dataset-root settings and could not converge the failed API unit. Owner-approved manual recovery restored the observed baseline after about eight minutes of API outage; webhooks during that gap may have been lost. The measurement window closed at 07:16:11 UTC. No enrollment submission, marked job or bootstrap measurement result was produced. Old GOs cannot be replayed.

The W7 C2 CRASHED operation is already identified by the B1 evidence; its identity is no longer a hypothesis. Preserve its full-allowance charge and immutable record. Do not reset, reopen, edit or delete it, or describe it as normal compute completion. O1's exact SETTLED requirement remains. The earlier O1 cancellation has no valid enrollment receipt and its root cause remains unknown.

## Work completed by Codex: local scope only

Counts below belong to separate suites and revisions. Do not add them into a unique whole-project test total.

| Checkpoint | Accepted local scope and checks | Limits |
| --- | --- | --- |
| [Measurement v2 correction](evidence/R7B_MEASURE_V2_LOCAL_2026-10-10.json) | Receipt/effect parsing, failed or inactive API stop proof, storage configuration, rollback and helper isolation; independent 162, helper 57 and AB/PB 14 passed | No successful host execution. Storage omission was a measurement-tool regression; relevant product startup files were unchanged between `325d335` and `eb532ff` |
| [Startup readiness](evidence/R7B_STARTUP_READINESS_LOCAL_2026-10-10.json) | Exact schema, full worker configuration, module closure, service access and phase/receipt plumbing; independent core/receipt/chain 81 and access 48 passed | Actual collector/FULL/m1 pre-effect chain still uses 27 historical pre-gate stubs. No real PostgreSQL, systemd or successful enabled startup |
| [Linux PostgreSQL foundation](evidence/R7B_LINUX_PG_FOUNDATION_LOCAL_2026-10-10.json) | Runner, inventory and first case definitions; independent 59 and focused audit 30 passed | Deadline and cleanup simulations do not prove OS resource enforcement or a sealed native dependency graph |
| [Linux PostgreSQL v2 ports](evidence/R7B_LINUX_PG_V2_PORTS_LOCAL_2026-10-10.json) | H-6/H-8/H-11 service and timer simulations; independent 15 and suite 20 passed | H-1/H-4/H-5 accounting candidates remain unverified as whole cases. Accounting architecture follow-up returned no result |
| [Latest Linux PostgreSQL v3 ports](evidence/R7B_LINUX_PG_V3_PORTS_LOCAL_2026-10-10.json) | H-7/H-9 close definitions and H-14 SQL response simulation; independent 32 and suite 20 passed; close author 8, producer author 14 | No SQL was executed. Native producer, complete donor/accounting flows, Linux runtime and filesystem cleanup effects remain unverified |

Latest frozen source: `.qa-local/codex-r7b-linux-pg-v3-checkpoint-5fe8e2b3`, aggregate SHA-256 `5fe8e2b354d678460437dd2516f67a0b105dd6333698594aab1ed1c2428924a5`. The v3 evidence records every source and result hash. It supersedes intermediate worker hashes.

There are **13 of 19 legacy case definitions**, plus `startup-schema`: H-1/H-2/H-3/H-4/H-5/H-6/H-7/H-8/H-9/H-10/H-11/H-12a/H-14. Six cases remain **NOT_BUILT**: H-12b, H-13, H-7b, H-7c, H-7d and H-15. Partial H-12b/H-13 helpers are deliberately excluded from suite dispatch. A definition does not establish a passing PostgreSQL case.

Root corrections after the producer worker returned include database/owned-temp binding before imports and allocation, admin attestation before allocation, refusing injected-to-native fallback, a null synthetic allowlist for H-14, preservation of primitive exceptions and cleanup errors, and strict SQL integer validation. The source-derived fixture advances its clock before enrollment instead of rewriting immutable creation times. Python/profile runtime construction remains omitted. H-9 uses a sanitized synthetic stopped-unit shape instead of scanning private release receipts.

## Next bounded work and operational gates

1. Recheck local Git, file ownership, usage and snapshot hashes. Start from the frozen v3 source in a new writable namespace; preserve accepted snapshots and evidence.
2. Complete H-12b RUNNING same-bot guard, foreign bot/owner scope, since-anchor counts and actual m2b `KEY_FOREIGN`. Complete H-13 product terminal SUCCEEDED/CANCELLED replay with no extra insert, plus the complete marked-read m2b path. Extend the product fixture deliberately; do not substitute fabricated m2b acceptance or mutate immutable timestamps.
3. Complete stateful H-7b/H-7c/H-7d recovery/stop paths and H-15 m0/FULL/m1 drift and pre-effect chain. Retain explicit historical stubs and separate local acceptance from runtime acceptance.
4. Obtain independent accounting review and whole-case evidence, including H-4 to H-5. Finish native dependency sealing and the real Linux adapter: immutable export/dependency inputs, explicit Unix socket environment, nested resolution refusal, external supervisor, resource limits, bounded logs and stop/recovery proof.
5. Prepare a concrete capability/health packet and obtain its fresh owner GO. Only a designated operations worker may perform the authorized host step. Then obtain a separate GO for the isolated PostgreSQL job. Real PostgreSQL harness work belongs on the VPS under that reviewed packet, not on this local machine.
6. Only after those gates, prepare a fresh measurement epoch with new pins, allowlist, policy filename and per-effect owner GOs. Do not reuse EM-1 approvals.

The runner's proposed limits are 300 seconds of work plus 30 seconds cleanup, 512 MiB memory, one CPU core at 100%, 32 processes, 1 GiB disk, 1 MiB output and 12 PostgreSQL connections. These are proposed bounds, not measured capacity or proven OS enforcement. Split jobs if necessary; do not silently increase limits.

All three execution locks remain: `LOCAL_CANDIDATE_NOT_RELEASED`, `ENABLED_CONFIG_AND_BUDGET_REVIEW_REQUIRED`, `HARNESS_VPS_PACKET_REQUIRED`. Preserve Spot/Paper-only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, immutable research evidence and independent holdout gates. No guard reset, Best Inputs apply, optimizer/data-range loop, production configuration change or Live activation is authorized by this handoff.

## Checkout, ownership and transfer

Local branch is `codex/app3a-market-wait-checkpoint`; HEAD is `c7bae374b5150f608d6b7f5940b706947be17071`. Root-owned pending changes are README, Context, Roadmap, Time Management, this handoff and the five local evidence JSON files linked above. No commit or push was made. Two unrelated dated PNG files and `scripts/build-spt-exit-diagnostic.mjs` remain untouched; exact inventory is in the private handoff.

Local refs confirmed: `claude-worker/enroll-guard` at `eb532ff`, `claude-worker/pine-anthropic-adapter` at `9abee46`, `claude-worker/s08-ui` at `5f3732c`, `claude-worker/s08-ui-r7b` at `e840814` and `codex-worker/combined-r7` at `79c22b2`. The provider adapter was reported unmerged with historical CI 9/9 by the incoming handoff. Local refs do not verify current hosted CI or deployment.

**The implementation artifacts are ignored under `.qa-local/`; a Git clone does not contain them.** Use the existing workspace and verify the private artifact index. Do not reconstruct missing private authority from public documentation. Failed rehearsal temporary directories remain after an earlier automatic approval review rejected their deletion; no cleanup bypass was attempted.

Codex usage at the final handoff reading was 55% used, 45% remaining in the weekly window; the short window is unknown and the 15-point reserve remains. These are shared account observations, not per-agent costs. Claude must read its own usage and verify its client model/effort/ultracode state. No completion or speedup estimate is established for the remaining gates.

All children, including the read-only whole-project handoff reviewer, are complete. No tool job or shell session remains active from this work. Existing services were not stopped by the handoff. Once this checkpoint is saved, Codex yields command; no Claude session has been launched or messaged automatically.
