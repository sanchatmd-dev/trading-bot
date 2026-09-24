# Robot Trade — Pine → Bot → Quant → Owner Workflow

Status: proposed implementation plan, revised 2026-09-24. This document is the canonical plan for the new Pine Bridge → Bot → Quant → Export workflow. Earlier planning and phase history are preserved in [the archived roadmap](ROADMAP_ARCHIVE_2026-09-24.md). Nothing in this plan enables Live trading or changes production.

## Baseline and scope

The local checkout at the start of this review included documentation changes already in progress. Repository code has PostgreSQL schema 14, Paper API/worker, per-entry allocations, Bot lifecycle controls, Quant Lab UI and a local Python bridge. During R-0, the owner verified current release `ff5a9d1` and all four production components (API, Paper worker, PostgreSQL and Quant service) active. Public health remained v2.2.0/PAPER_ONLY, with the observed queue draining from one to zero. Direct schema/outbox access remains pending after database authentication failed. Worker journal counts show repeated SMTP 550 failures, so Email Report delivery requires a separate operational fix and receipt check. Local test results do not certify the deployed release.

The repository contains offline Quant reports and Pine export utilities, but the customer workflow specified here remains incomplete. The current optimize endpoint runs synthetic EMA on generated candles; its parameter contract does not optimize RR or arbitrary imported Pine logic. Bot ownership is checked for runs, but the server does not yet supply an immutable Bot policy/capital/source snapshot to the evaluator. There is no Pine import registry, authenticated export/import review flow or Quant Email Report. Treat historical phase test counts as historical evidence, not current acceptance.

The [R-0 evidence record](R0_BASELINE_2026-09-24.md) identifies the owner's untouched SPT Pro V4 source and a first isolated Pine/Bot fixture. It also records two pre-append changes in the older transport copy, current local test results and the remaining VPS follow-ups.

Production execution stays Paper-only. The worker remains authoritative for cash, reservations, limits, duplicate events and actual fills. Broker adapters and a Pine alert cannot claim VPS inventory.

## Five-step user workflow

| Step | User outcome | Gate |
| --- | --- | --- |
| 1. Connect Pine | Register an authorized indicator or strategy source, source hash, effective inputs, symbol/timeframe capability and Bot membership. | Ownership and source capability recorded. |
| 2. Build Bridge | Use a chatbot backed by a direct AI API to extend the Pine source with a versioned Bridge template and AI-facing integration guide. Receive a private integrated Pine copy and TradingView webhook setup guide. The Bridge owns independent ATR-for-SL and RR inputs. | Compile and matched-signal evidence before Webhook ready. |
| 3. Run Bot on Paper | Run the connected Pine through the Bot's Paper risk and execution flow; record sessions, decisions, fills and market data for research. | Accepted/capped/rejected outcomes and targeted reduce-only exits reconcile. |
| 4. Quant Lab optimization | Run one bounded Quant optimization job against the frozen Bot/capital/source/data snapshot, after baseline parity. Optimize according to the Pine count. | Produce one completed run with data, out-of-sample, sensitivity and cost-stress evidence, or report no eligible candidate. |
| 5. Export, owner review and optional new run | Deliver Best Inputs and Email Report. Owner reviews best Pine inputs and Bridge settings in Bot Risk Manager, then may apply reviewed values and start the Bot again. | Owner action is required. This workflow ends at the owner's decision/new Bot start; it does not return to Quant for another optimization or require a post-export Paper validation cycle. |

Workflow order describes the user journey. Paper activity before Quant supplies the research record. Quant optimization is one run for this workflow. Export and email do not change saved Bot settings or start a Bot; after reviewing both Pine inputs and Bot Risk Manager settings, the owner may explicitly apply eligible values and start the Bot again. That action ends this workflow.

## Binding and optimization contract

Bridge ATR Multiplier for SL defaults to 2.0 and Bridge RR defaults to 1.5. Each generated Bridge has its own namespaced variables. Similar variables in user Pine remain part of user logic and are never overwritten or rebound to the Bridge pair. The Bridge pair must affect the declared stop/target behavior and the Quant evaluator; a UI field with no effect is not an optimization dimension.

A strategy input parameter is an effective source input that influences the selected strategy signals or exits. User credentials, webhook transport settings, purely visual controls, funding and hard Bot limits are configuration, outside strategy optimization. Presets, dynamic dependencies, enums and conditional inputs require explicit effective-value and search-domain rules. Every strategy parameter must be accounted for; unsupported evaluation blocks a claim of complete optimization.

| Bot membership at the run snapshot | Search | Actionable Best Inputs export |
| --- | --- | --- |
| One connected Pine | Every strategy input parameter plus the independent Bridge ATR/RR pair. The earlier 10-parameter ceiling is retired. | Every optimized strategy input and both optimized Bridge values. |
| Two or more connected Pine scripts | All source inputs fixed at their recorded values; optimize one shared Bridge ATR/RR pair against combined signals and shared Bot limits. | Only the best shared Bridge ATR/RR pair. Preserve fixed source snapshots privately as provenance. |

Pine count is the number of registered script identities connected to the Bot, resolved on the server. It is not the number of indicators inside a script or a client-selected mode. Adding, removing or changing a connected script invalidates run/export evidence. A single Bot-level Bridge pair must be applied consistently to every member deployment in the multiple-Pine mode.

Optimize every parameter means every eligible strategy parameter participates in bounded search. It does not promise a global mathematical optimum or require each best value to differ from its original value. Record domains, algorithm, budget, seed, evaluated count, rejected count and completion reason. If the budget cannot cover the declared search adequately, label the evidence accordingly. Do not silently drop dimensions.

## Source, exit and validation rules

An indicator copy retains its original program body and appends a collision-safe Bridge block. Strategy-to-indicator conversion produces a separate copy and a semantic diff. Generate a reviewable draft first; declare it compile-verified and parity-verified only after independent checks. Strategy order-fill events require a separately validated strategy wrapper. Protected source can connect through exposed alerts when supported, but cannot be claimed optimization-supported without an authorized equivalent evaluator.

Version the Bridge ATR period, candle/timeframe source, entry-price reference, signal timing and same-bar SL/TP precedence. Freeze intended Bridge levels per logical entry. Define priority between native source exits and Bridge protection, prevent double exit, and carry a stable target reference. The server resolves that reference only within the authenticated Bot/deployment/allocation scope and uses actual remaining quantity. A rejected or capped BUY must not be assumed filled by Pine. Existing positions retain valid scoped reduce-only exits during alert replacement.

The evaluator must replay the actual connected source semantics or a proven equivalent. Synthetic EMA runs remain demos. Baseline comparison precedes any optimization; compare signal time, entry/exit identity, input values, stop/target and costs on matched market data. Record unsupported Pine constructs as blockers. Separate Webhook ready, Optimization supported, Export candidate and Export validated states.

## Identity and provenance

| Identity | Created | Purpose |
| --- | --- | --- |
| pine_import_id | Step 1/2 source registration | Stable private identity of one imported Pine source under its owner and Bot scope. |
| source_version and source_hash | Every source or binding change | Identify exact original logic, effective inputs and Bridge mapping. |
| run_id | Every Quant research run | Immutable membership, policy/capital/data snapshot, parameter domains and results. |
| export_id | Every Best Inputs package | Identify the selected candidate, alert source, files, checksums and email report. |
| deployment_id | Each TradingView alert replacement | Identify the specific script/settings/alert-source version emitting webhook events. |

A multiple-Pine run stores all participating pine_import_id/source_version pairs. Server-side Bot ownership is checked for every read, run, export and import. A content hash is never authorization. Store immutable policy version/hash, capital basis, funding cutoff, dataset hash/cutoff, broker/currency, cost model, dependency version and validation status. Changes to material inputs mark evidence stale.

The Bot Risk Manager page displays Bridge Settings separately from hard Policy limits and Capital. Importing a candidate requires authenticated review, current Bot/policy/source checks and an audit record. A RUNNING or PAUSED Bot's locked settings cannot be silently rewritten. Email delivery and package creation never mutate Bot policy or activate a Bot.

## Governing phase sequence

The governing delivery order for this revision is **R-0 → APP-3A → QL-2A → QL-3A → QL-4B → QL-4C → APP-3B → APP-4 → APP-5**. This is the phase sequence supplied for the revised plan. M0–M7 below are work packages within these phases, not replacement phase names. The [archived roadmap](ROADMAP_ARCHIVE_2026-09-24.md) retains the earlier, broader R-1/QL-1/QL-2/APP-3/QL-3/QL-4 naming and evidence; its older default delivery order does not override this sequence. R-1, QL-1 and QL-4A are historical foundations to verify or reuse, not new gates inserted into this revised order.

| Governing phase | Revised scope and work packages | Exit gate before the next phase |
| --- | --- | --- |
| **R-0** | M0: reconcile release/schema, Paper allocation, SMTP and candidate Pine source facts. | Scoped baseline and first Pine/Bot fixture recorded, with direct schema/outbox verification and SMTP 550 remediation named as operational follow-ups. |
| **APP-3A** | M1–M2: owner-scoped Bot/Pine identities, frozen policy/capital and membership; chatbot Bridge generation through a direct AI API with a versioned AI-facing template/guide, independent ATR/RR inputs and setup guide. No MCP connection is added to the Backend. This is the minimum application contract needed by Quant Lab. | Authenticated source and Bot snapshot plus a compile-checked Bridge candidate; unsupported conversion remains Draft. |
| **QL-2A** | M3: actual source/data replay, signal and Node/Paper risk parity, Bridge exit semantics and cost accounting. | Reproducible matched baseline; synthetic EMA remains demo-only. |
| **QL-3A** | M4: bounded research job. One Pine searches every effective strategy input and Bridge ATR/RR; multiple Pine scripts freeze source inputs and search one shared Bridge pair. | Recorded search coverage and out-of-sample, sensitivity and cost-stress evidence. |
| **QL-4B** | M5–M6: Best Inputs package, Bot Risk Manager review/import contract and owner-scoped Email Report. | Mode-correct files and report share one export identity; no automatic Bot policy change. |
| **QL-4C** | M7 validate the completed export package, source-specific Pine compilation evidence and owner review/import flow. No post-export Paper trading cycle is part of this workflow. | Package, Pine inputs and Bridge settings reconcile to the single completed run; owner can review before any new Bot start. |
| **APP-3B** | Operational hardening after the isolated proof: multi-indicator isolation, scoped allocations and exits, reservations, measured scaling, recovery and shared-symbol Paper canary. | Recorded workload and failure-recovery thresholds, with no cross-Bot or oversold exits. |
| **APP-4** | Customer lifecycle, quotas, security and paid Paper readiness. | Bounded customer Paper beta and operational acceptance. |
| **APP-5** | Optional broker-by-broker Live capability. | Separate broker reconciliation and explicit Live authorization. |

The APP-3A/APP-3B and QL-2A/QL-3A subdivisions above define their **revised scope** for this plan; they are not claims that those exact subphase definitions were previously implemented. APP-3B follows QL-4C for broader multi-indicator/shared-symbol operational hardening. Existing Paper service work can continue under its own acceptance and does not add a post-export feedback loop or claim that these new gates have passed.

## Work packages within the governing phases

| Milestone | Build work | Required completion evidence |
| --- | --- | --- |
| M0 — Baseline | Reconcile local release/schema facts, existing Paper allocation contract, SMTP status and source capability. Keep historical phase evidence in the archive. | Current scoped inventory and a concrete supported first Pine/Bot fixture. |
| M1 — Identity and risk | Create owner-scoped Pine registry, source versions, Bot membership snapshots, immutable policy/capital resolution and stale evidence rules. Separate Bridge Settings from hard Risk Policy in the model and UI. | Tenant isolation, frozen policy and source-change behavior; no client policy override. |
| M2 — Bridge adapter | Build authenticated analyze/generate API. The chatbot calls an AI API directly with a versioned system prompt, Bridge code template and AI-facing integration guide; the Backend has no MCP connection. Validate the AI output with deterministic structural checks. Append independent ATR/RR, produce binding manifest, draft Pine and user setup guide. Support indicator first; allow strategy conversion only for proven constructs. | Versioned AI instruction pack and request/response contract, source diff, collision checks, TradingView compilation, matched-signal review and controlled Paper webhook. |
| M3 — Quant evaluator | Replace demo-only execution path for a supported source with actual market data and a parity-proven evaluator. Implement both Bridge ATR and RR, scoped exits, costs and account constraints. | Matched baseline signals and Node/Paper risk decisions; reproducible source/data hashes. |
| M4 — Research jobs | Run one-Pine/all-parameters or multiple-Pine/shared-pair search as a bounded background job. Add progress, cancel, restart recovery, chronological validation and candidate gates. | Every declared dimension evaluated within the recorded budget; no leakage or silently ignored RR. |
| M5 — Best Inputs and owner review | Generate mode-specific inputs.json, Pine, Setup Guide, manifest and validation evidence. Provide authenticated review of best Pine inputs and Bridge settings, with an explicit apply action. | Correct mode-specific values, ownership, freshness and policy lock; no automatic settings change or Bot start. |
| M6 — Email Report | Generate an owner-scoped report from export_id with bot_id, pine_import_id list, UTC timestamp, recommended values and key Quant metrics. Use an idempotent outbox enqueue and track independent delivery status. | Report matches the one completed Quant run and package, contains no credentials, and export remains available when SMTP fails. |
| M7 — Export readiness and owner handoff | Verify package integrity and source-specific Pine compilation/setup evidence; show the owner how to replace the TradingView alert if applying the new Pine inputs. End with owner review, optional apply and optional Bot start. | Evidence and review screen match the export. No mandatory post-export Paper run and no return to Quant optimization. |

M0–M2 may use private fixtures. M3 requires supported source/data semantics; M4 depends on M1 and M3; M5–M7 depend on the single eligible M4 result. APP-3B gates wider multi-indicator Paper rollout, not the owner's decision to start a Bot using reviewed settings. Schema changes require a protected backup and isolated migration/restore rehearsal. Node/risk/schema changes use relevant Node and isolated PostgreSQL checks; Quant changes use its own contract/parity checks. A production release uses immutable directories and atomic symlink switching.

## Step 5 deliverables

Step 5 delivers exactly two user-facing items:

1. **Best Inputs package:** inputs.json, supported Pine Script and Setup Guide. For one Pine it contains all optimized strategy inputs and the Bridge pair. For multiple Pine scripts, its actionable settings contain only the shared Bridge pair; unchanged source snapshots stay in private provenance. Include before/after values, scope, run/export/deployment IDs, checksums and source-specific validation evidence.
2. **Email Report:** summarize Best Inputs, bot_id, pine_import_id or the member list, export_id, UTC timestamp, train/validation/test results, trade/sample counts, drawdown, Win Rate, Profit Factor, costs and stale/validation status. Separate Pine-only source inputs from the Bridge pair displayed in Bot Risk Manager. Send only to the verified owner, with an authenticated review link and no webhook secret.

Report creation and outbox enqueue are idempotent by export_id. SMTP delivery remains at least once, so duplicate email deliveries carry the same report ID. Track NO_VALID_CANDIDATE, EXPORT_READY, EMAIL_PENDING, EMAIL_SENT and EMAIL_FAILED separately. A failed email does not invalidate an otherwise valid package.

A TradingView running alert snapshots its script and inputs at creation. If the owner chooses to use the exported Pine inputs, they must create a new deployment version and deliberately replace the alert before starting the Bot again. The guide must describe retiring the old entry route while maintaining permitted exits for existing allocations. This is an owner handoff at the end of the workflow, not a required Paper acceptance loop back to Quant.

## Parallel application roadmap

The existing Paper service, paid Paper readiness and optional Live execution remain separate streams. APP-4 customer lifecycle needs entitlement, independent security review, off-host recovery decision and bounded Paper beta. APP-5 Live needs broker-specific order state, uncertain-order reconciliation, sandbox acceptance and separate owner authorization. Neither stream changes this roadmap's PAPER_ONLY execution gate.

## Historical R-1 — Per-entry positions and targeted TP/SL

Per-entry allocation and targeted exit work is recorded in the [archived roadmap](ROADMAP_ARCHIVE_2026-09-24.md#r-1--per-entry-positions-and-targeted-tpsl). New Bridge and Quant work must reuse its server-owned allocation contract. The current release claim in Context.md is historical documentation; verify live service/schema state before a production change.
