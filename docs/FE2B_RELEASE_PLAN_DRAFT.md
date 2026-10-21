# FE-2b release-plan proposal

**Local implementation checkpoint, 2026-10-22 (Bangkok):** root accepted the cloud FE-2b implementation after independent review, full/focused regression and four serialized mutation kills. [Local evidence](evidence/PM1_FE2B_LOCAL_2026-10-22.json) records 2,902 passing Node tests and 391 passing PostgreSQL tests, the explicit skips/TODOs, actual Python execution and remaining native-supervisor gap. [Exact closure inventory](evidence/PM1_FE2B_CLOSURES_LOCAL_2026-10-22.json) compares the base `cfe0bc9` with the candidate. Foundation, ingestion, PF2 engine, fixed evaluation and multi change; legacy, PF2 evaluator and trace do not. No historical stored hash is rewritten.

The adopted cloud design and local evidence supersede the historical draft's pending implementation-GO language. Target release, admission drain/cancel policy, shared migration window and native QS/cgroup capability proof remain separate gates. The opt-in flag remains off and there is no customer route. The proposal below does not authorize operations.

**Owner GO update, 2026-10-22 (Bangkok):** the owner explicitly authorized FE-2b cloud implementation in the active Codex conversation. Root is preparing the bounded lifecycle/storage implementation design and independent verification. This supersedes the draft's pending implementation-GO statements below. Target execution, deployment, shared migrations and activation still require their separately scoped authorization; no target facts or release eligibility are established. The original draft remains a proposal until root records its design decisions.


**DRAFT — prepared for later root/owner decisions, 2026-10-22 (Bangkok). No owner GO, engine change, deployment authority or release eligibility is established.** Source baseline: d8a9c6f and current committed contracts. Preparation is source review only; no tests, engine-hash execution, host/network access or private-input work supports this proposal. Target revision, installed schemas, active jobs, health, capacity and rollback readiness are UNKNOWN. N1 is entirely outside this proposal.

## Root cloud implementation decisions, 2026-10-22

The implementation GO authorizes the internal shared fixed-evaluation class under QS-1. The following design is adopted for bounded implementation and independent verification, not as an acceptance or activation claim:

- Dispatch on `quant-foundation-fixed-eval-v1`, retaining scheduler kind `BACKTEST` and contract mode `FIXED_INPUT_EVAL`. Admission resolves persisted object/participant IDs; callers cannot supply an execution contract, editable policy, parameters or a search space.
- Reuse the existing research/foundation tables and immutable guards. A transaction-local admission writer composes with QR-4's exposure-first start transaction. Application atomic composition is the initial design; no new table or deployment migration is introduced merely for a new mode.
- QR-3 participant ID resolves the same-owner immutable parent run. New executable frozen participant records must include `freeze.context` with the complete C1–C16 context accepted by `src/comparison/context.js`; its normalized key must equal both stored participant and spec keys. Existing sparse S2 freezes remain readable but fail closed for admission as `FIXED_EVAL_AUTHORITY_UNAVAILABLE`. Missing context is never filled after freeze. Parent identity, policy, capital, selected inputs, source and terminal timing are independently checked; context hashes alone do not establish authority.
- Both purposes retain the frozen dataset digest in the comparison context or selection start. A dataset SHA is never compared to a bar-content digest. Admission pins verified closed-bar content separately; preparation must verify the published dataset identity against the frozen digest before evaluation can launch. The common QR-3 window includes the maximum required participant warm-up, under existing 10K-bar limits.
- Execute only `eval:base` and `eval:stress`, each a whole terminal-only supervised step. Reuse the global scheduler slot, lease fencing, budgets, process-stop proof and existing terminal I/O protocol. No research checkpoint loop or candidate search.
- Fixed-evaluation interruption is terminal. Cold recovery requires the existing exclusive offline supervisor proof and ends the interrupted fixed job safely; it does not resume a partial step or requeue a terminal research row. A new evaluation needs a newly admitted job. This conservative local policy adds no deployment or operations authority.
- Customer admission stays disabled by default. QR-3 ranking/benchmark orchestration and QR-4 owner tolerances remain their own slices. FE-2b never makes an evaluation a package, a G8 source or a library-qualified research run.

The initial QR-3 adapter resolves RD-2/RD-3 only for this supported fixed-evaluation profile. C8 is `{fill_model:'paper-close-v1', exit_semantics_version:'bridge-exit-v2'}`, bound to the existing Bridge replay and Paper evaluator. C6 uses FE-2a's verified closed-bar timestamp semantics. C12 is the verified parent's exact independent historical flat-ledger initialization text. C11 hashes canonical `{policy:projected_parent_policy, risk_percent:decimal_parent_risk_percent}`; it is distinct from the fixed contract's policy-only hash. C10 maps parent cash to initial cash, inventory zero and USDT; this initial QR-3 profile requires parent sizing equity to equal cash because C10 has no separate equity field. Other profiles refuse rather than omit a material sizing difference.

C16 hashes canonical `{rules:{adequacy:spec.adequacy, risk_filter:spec.risk_filter, sensitivity_max_drop_percentage_points:decimal_parent_rule, cost_stress:'ENGINE_DEFINED_2X_FEE_AND_SLIPPAGE'}, ledger_initialization:parent.ledger_initialization, evaluation_contract_version:'fixed-eval-job-v1'}`. These adapter definitions require independent review and boundary tests before acceptance. They change no ranking threshold, parent policy, evaluator algorithm or existing frozen record. QR-3 bar-open reporting times and FE-2a closed-bar execution times must be translated explicitly; matching integer fields alone is insufficient.

Root captured the eight closure-family hashes and every member digest before engine edits at work-branch baseline `681769c` (closure bytes equal the preceding `8e0c8cf` baseline). Final implementation evidence must record the changed closures, independent tests and compatibility failures. No old contract hash may be rewritten. The proposed target drain policy below remains a separate rollout choice.

Cancellation uses the existing contracts' SERIALIZABLE logical ordering. Fixed claim, execution and commit fences run as fresh SERIALIZABLE transactions with whole-transaction serialization/deadlock retry. If an object cancellation commits before a fence begins, that fence must refuse. An overlapping fence may serialize before cancellation; this does not promise a physical stop or a prohibition on result commit after the cancellation response. Later fences recheck eligibility, and terminal comparison/selection guards still prevent outcome promotion. Runtime roles have no UPDATE privilege on the immutable object tables, so implementation must not rely on SELECT FOR UPDATE there. No grant, schema or advisory-lock protocol expansion is adopted for this boundary. Independent tests must exercise the actual runtime grants and distinguish non-overlapping refusal from overlapping logical ordering.

The remainder is the original release proposal; its pending implementation-GO language is superseded by the update and decisions above. Target facts and target execution remain unestablished.

## Purpose and boundary

FE-2a already supplies the pure fixed-input contract, fixed evaluation closure and terminal-envelope Python job. It does not supply worker admission, runtime dispatch, cancellation or recovery. Those are FE-2b, explicitly held for a release plan and owner GO (docs/evidence/PM1_FE2A_LOCAL_2026-10-19.json:5–6,25–29; docs/CLAUDE_TO_CODEX_CLOUD_ROOT_HANDOFF_2026-10-22.md:117,126).

The proposed result is a separately admitted, zero-search fixed-input evaluation under QS-1 for QR3_COMPARISON or QR4_SELECTION, preserving immutable parent lineage. It is not a new optimizer, package qualification path or owner recommendation. Existing contract identifiers in src/quant-research/fixed-eval-contract.js:19–27 are recorded facts, not newly selected versions. Any change to these identifiers requires its own reviewed decision.

Two release milestones must remain distinct:

1. A locally reviewed FE-2b implementation with isolated fixture evidence and a measured closure-impact inventory.
2. A named target release, migration/grant window and bounded capability proof under an explicit owner GO and the designated operations worker.

This draft permits neither milestone automatically. While the gate is held, cloud work can prepare design, dependency inventories and test specifications outside runtime closures. Root should obtain a scoped owner decision before dispatching engine-affecting implementation or runtime wiring; general overnight continuation does not silently satisfy the handoff gate.

## Prerequisites and design decisions

Root design packet must resolve:

- **Admission and job ownership:** one shared QS-1 job class for QR-3/QR-4, run_id/parent_run_id lineage, frozen parent inputs, owner/market/window checks and no candidate search (QR3 contract:640–645,911; QR4:1001–1002). Existing FE-2a supplies exactly eval:base and eval:stress, not an optimization loop (fixed-eval-contract.js:23–27).
- **Storage/transition integration:** identify the exact new writer/worker branch, schema constraints and recovery state transitions required. Do not assume the existing research kind/status constraints accept FIXED_INPUT_EVAL. Specify immutable contract/result identities and idempotent retries before coding.
- **Exposure order:** shared exposure register must exist before evaluation becomes reachable (FE2A evidence:27). For QR-4 the recheck and guarded step share one SERIALIZABLE transaction; first successful start writes exposure, a refused first start writes none; retry rechecks from the start (QR4 contract:225–237,1006). QR-3 writers use the same SERIALIZABLE exposure rules. No implicit exposure rollback after evaluation occurred.
- **Cancellation/recovery:** preserve current stop semantics. Foundation graceful interruption is terminal; it must not inherit legacy resumability accidentally (Roadmap:27; quant-research-foundation.js:273,301,321,495). Specify lease/fence ownership, process stop proof, retryable failures and restoration from each durable phase.
- **Metrics:** emit FE-1 fill grid, fees, exposure, rejected intents and completed flat-to-flat episodes under a versioned closure before V8 can pass. FE-1 availability alone is insufficient (QR3:909; QR4:1002).

Owner decisions still required for downstream rollout include QR-3 OPEN-1/OPEN-2, QR-4 OD-S3, staging fixture owner and deletion semantics for insert-only owner rows (handoff:126; QR3:955–959,989–991). Retain current fail-closed behavior while unresolved. Do not bundle QR-2 S4 owner decisions into FE-2b or enable those routes.

## Closure impact and old-job compatibility

The release candidate must include a before/after identity manifest derived from the exact release bytes, covering every following family. Values are deliberately not calculated or invented in this draft.

| Family | Source authority | Proposed review requirement |
| --- | --- | --- |
| Legacy research | src/postgres/quant-research.js:19–36 | Explicit file list includes quant-research-worker.js and shared Python evaluators. A worker edit can rotate legacy identity too; do not repeat the older three-family impact claim as exhaustive. |
| Foundation research | same file:20–32 | Includes legacy list plus foundation modules and QUANT_RUNTIME_ENGINE_FILES. |
| Ingestion | src/postgres/quant-data.js:12,28–31 | Includes runtime manifest; shared runtime changes propagate. |
| PF-2 engine/evaluator | src/quant-research/preflight-resolver.js:35–54,190–199 | Report the two identities separately; evaluator unchanged must be demonstrated, not assumed. |
| Fixed evaluation | src/postgres/quant-fixed-eval-engine.js:12–25 | Runtime manifest plus four FE-2a files; every transitive execution dependency must be covered. |
| Multi-Pine | src/multi-pine/engine-closure.js:19–51 | Runtime manifest plus combined-specific files; shared runtime edits can invalidate old internal fixture runs. |
| One-Pine trace reproduction | src/quant-library/trace-reproduction.js:39–52 | Contains legacy closure; legacy edits propagate to trace identity and build reproducibility. |

A source change outside this initial list can still affect imported code. Require closure completeness tests and a final exact candidate manifest rather than relying on this table alone. Keep engine versions, hashes and code revisions as distinct facts.

Old research rows bind their original engine_hash. Legacy worker checks live identity at run entry, before evaluation and before checkpoint commit (quant-research-worker.js:75,92,103); foundation checks at :203; ingestion checks contract identity at quant-data.js:105. A new worker must never rewrite old contracts/hashes or resume an old checkpoint under new semantics merely because it parses.

**Recommended deployment policy, subject to owner choice:** stop new admission for affected classes and let existing work settle on its original immutable release before switching. If the owner chooses cancellation instead, require the existing cancellation/stop-proof protocol and record affected runs, never classify them as successfully completed. Retain old immutable artifacts needed for reproduction. Do not promise that restoring the old executable makes new-hash jobs runnable. Existing terminal evidence remains immutable; exact replay may be unavailable when its original engine artifact is unavailable (QR3:635–639; package RC-17 at :748).

## Separate F09 compatibility gate

FE-2b is not a shortcut to a successful one-Pine package build. Current trace reproduction supports only legacy v1 without execution_backend (trace-reproduction.js:68–79). G7 accepts only the v3 placeholder (owner-recommendation.js:13–19). Fixture=true skips the episode gate, not G7 (package-gates.js:364–368). The internal exception is multi-v1 only.

Consequently there is no currently supported one-Pine profile that both reproduces and passes B0. A future recommendation contract and its ACTIVE trace profile need a separately reviewed definition/closure; RC-35 assigns that work to the owning slice (package contract:766). Neither rewriting v1 to v3 nor feeding fixed-evaluation output into a research-package route is permitted. QR-3 evaluation runs explicitly never become packages, G8 sources or library-qualified runs (QR3:644–645). A completed FE-2b release can unblock QR3/QR4 engineering while F09 recommendation eligibility remains closed.

## Required validation before requesting target execution

Evidence should be tied to the same candidate bytes and reviewed independently:

1. **Admission/refusal and lineage:** correct parent/owner/market/window; unrecognized purpose, malformed binding, search dimension, changed parent policy and stale source refuse. Existing FE-2a Node/Python checks remain green; no new runtime branch silently broadens their contract.
2. **True job lifecycle:** isolated PostgreSQL fixture exercises admission through base/stress and terminal immutable result, cancellation before start/during step/at final commit, lost lease, crash/restart, timeout, duplicate delivery and partial output. Assert budget, single heavy executor and no order/Bot mutations. Mock runner tests alone are insufficient for the process path.
3. **Exposure races:** competing QR3/QR4 starts and late exposure insertion; serialization retries rerun checks; failed first start writes no exposure; outcome cannot race past a changed window. Immutable outcomes and lineage hashes verified from store readers.
4. **Engine compatibility matrix:** old-hash queued/running/checkpointed jobs against the new release refuse or follow the explicitly approved drain/cancel policy; no hash rewriting. New candidate succeeds on its own closure; one changed/missing closure member fails closed. Legacy/foundation/ingestion/PF2/multi/trace importer suites rerun according to actual changed files.
5. **Metrics/parity and limits:** FE-1 versus QR3 valuation parity, terminal envelope integrity, exact decimal/accounting, bounded output, no leakage, 10K-bar supported profile. This establishes local behavior only; target resource headroom remains unmeasured until the separately authorized proof.

Record unsuccessful cases and skips honestly. Passing CI, pure fixtures or schema inspection alone does not authorize target activation or satisfy private/TradingView acceptance.

## Target release and rollback proposal — no commands

A later owner GO must name the target, exact release revision/closure manifest, operators, allowed effects, window, admission policy, resource budget, logs and stop conditions. Before that GO, operations supplies fresh read-only evidence of installed schemas, permissions, active jobs, disk/memory headroom and protected backup/restore readiness. All are unknown here.

Proposed order after that authorization:

1. Preserve the prior immutable release and obtain the reviewed job-state/backup record. Apply the approved admission drain/cancel policy.
2. Perform only reviewed migrations/grant changes and inspect each extension. QR3 RC-C36 (contract:978) requires one later data-model window after local S3/S4 acceptance, covering QR-1b freeze, register, comparison tables and grant reapply, with restore rehearsal. FE-2b code readiness does not waive that dependency or authorize an early partial production install.
3. Switch to the exact immutable release using the established release mechanism. Keep customer admission disabled while an authorized labelled fixture capability proof runs under QS-1 limits. Verify terminal rows, exposure accounting, cancellation/recovery, closure identity and unchanged Paper safety behavior.
4. Enable only the scope expressly named in the GO after root reviews that evidence. If any prerequisite or invariant fails, stop; do not tune parameters or retry into a new scope.

Rollback is release- and data-state-dependent. Before new rows exist, an approved reversible code switch may be sufficient if schema compatibility is proven. After fixed-evaluation/exposure/insert-only rows exist, reverting the executable is not data rollback: preserve evidence and use a pre-reviewed compatible-old-code or forward-fix route. Never delete exposure history, drop nonempty extensions or rewrite frozen jobs to make rollback appear clean. Restore from backup only under its own explicit authority and after reconciling post-backup writes. The final release plan must prove which option applies; none is established now.

## Decision packet to root/owner

Request decisions only after a concrete implementation/release scope is prepared:

- Root: accept or revise this draft and the FE-2b lifecycle/storage design; identify the exact engine-affecting implementation packet and unresolved owner items.
- Owner: explicitly authorize that bounded engine/runtime scope and, separately, target execution; choose drain versus cancel for affected old jobs and acceptable interruption behavior.
- Root + operations: establish target facts, protected restore evidence, exact closure impact and eligibility of required schema window before requesting final GO.
- Owner: resolve downstream comparison/selection policy questions before exposing paths that depend on them; no silent defaults beyond existing fail-closed rules.

This draft creates no GO and selects no new accepted contract version. Private-source, owner recommendation, TradingView, Live, automatic apply, optimizer loops and N1 remain outside scope. Root owns the later implementation and release decisions. This document records preparation, not acceptance of a release.
