# Codex to Claude: whole-project handoff, 2026-10-08

## Authority and read order

The owner explicitly requested: stop, save a checkpoint and hand the project to Claude to continue fixing it. Codex stops dispatching substantive work. Its three children have completed and are frozen; no Codex background host job or timer remains. Existing application services are not stopped by this handoff. Claude becomes the sole root only after re-verifying Git, ownership, its own usage and authorized runtime evidence.

Read `AGENTS.md` and the Caveman skill, then the ignored private handoff `.qa-local/codex-to-claude-handoff-2026-10-08.md` FIRST. It indexes exact tool identities, consumed attempts, the original host/pin handoff and diagnostic evidence. Then read this document, the current entries in README, Context, Roadmap and Time Management. Older chronological entries do not override this checkpoint. The prior Claude handoff's instruction to perform O1 is obsolete: O1 already ran and failed.

## Immediate problem and next action

The latest bounded read finished at **15:52:43 UTC (22:52:43 Bangkok)**. It stopped at `QUEUE_NOT_IDLE` because the new strict predicate counts **one ledger operation whose status is not `SETTLED`**. Its exact status has not been read. Do not call it `CRASHED`, a live process, or a new failure without evidence.

Source review established that global all-SETTLED is stricter than the product's terminal semantics. A valid historical `CRASHED` operation can have conservative charging and recorded stop confirmation; `CRASHED_UNCONFIRMED` lacks confirmed stop. Both quarantine that ledger's compute and neither proves measured final I/O. Consequently, do not simply restore the old SQL exclusion, ignore the row, reset its ledger or reopen its budget.

The next bounded task is a read-only diagnostic of the affected operation, with independent review before execution:

1. Aggregate statuses and affected-ledger counts in a bounded read-only transaction. Refuse an unexpectedly broad result.
2. Examine at most two affected ledgers with server-side state-size limits; validate actual product ledger structure, state hash, identities, charge formula and totals. Keep raw state private and out of output.
3. Bind each operation directly to its launch, job and stop evidence. Check lease/job state and distinguish measured settlement from conservatively charged unknown-final I/O.
4. Identify whether it belongs to O1. Keep O1's exact SETTLED requirement unchanged. Preserve fresh physical-idle, queue, process and manager checks.
5. Only then review a narrowly justified inactive-release gate amendment. Invalid, missing or unconfirmed proof remains a stop.

No diagnostic executor for this next task has been built or approved. The private accounting review provides the exact source references and proposed evidence fields.

## Observed staging state and limits

The 15:52 UTC read observed health `200 / PAPER_ONLY`, authentication guard OK, API and research processes running, four research/foundation/profile/enrollment flags ON and Preflight OFF. Manager jobs/reloads, other diagnostic payloads, queued/paused/running jobs, leases, open launches, invalid ledgers and legacy active work were zero. The new operations-open count was one. Both database readers reported the same expected database.

Baseline release-tree content verification completed. Later unit, environment-source and O1 subject gates did not run to completion after the idle refusal. This is **not a complete release-ready baseline**. API/research were last accepted on `325d335`; Trading remains on the previously accepted `f2bd332`, untouched by Codex. No deployment, service restart, flag change, ledger mutation, new research job or TradingView action occurred during this diagnostic continuation.

## Git, candidate and local acceptance

- Main branch: `codex/app3a-market-wait-checkpoint`. This handoff checkpoint follows pushed `f0e7aee`; obtain its final commit from Git. That earlier documentation checkpoint passed both hosted workflows.
- Release worktree branch: `codex-worker/combined-r7`, at pushed **`79c22b2db72d2a05512f96a3d065dbc980356138`**, with a clean tracked tree and full CI passing. It is not deployed.
- The candidate adds bounded, sanitized child diagnostics and parent error-code coverage. Parent proof/accounting remains authoritative. A test-only follow-up corrected the PostgreSQL expected log schema; runtime/dependency bytes are unchanged from the preceding diagnostic implementation.
- The exact candidate package is locally accepted: 653 source blobs plus 182 dependencies, and a 363-file installed-worker subset covering 81 engine files. Independent reconstruction and 31 negative refusals passed. Package acceptance is not release authority.
- Main's UI Preflight panel `0ff67ba` is still excluded from the release branch; the prior plan defers its integration/release until after R7.
- Preserve the three owner untracked files: `docs/target-system-current-2026-09-29.png`, `docs/target-system-current-2026-09-30.png`, and `scripts/build-spt-exit-diagnostic.mjs`. Do not stage them or copy an older main-checkout engine over the release worktree.

See [release preparation](R7_OBSERVABILITY_RELEASE_PLAN_2026-10-08.md), [native diagnostics evidence](evidence/R7_CHILD_DIAGNOSTICS_2026-10-08.json) and [package evidence](evidence/R7_INACTIVE_RELEASE_PREP_2026-10-08.json).

## What happened to O1

The owner submitted one marked enrollment. It finished CANCELLED on attempt one without a valid receipt. The earlier direct read proved a launch in STOP_PROVEN with MEASURED_FINAL_SETTLED, zero read bytes and 28,672 write bytes. The original error remains UNKNOWN. A missing receipt join does not prove a missing launch or policy mismatch.

The original diagnostic write could be lost because cancellation preceded a catch path requiring RUNNING status and a lease. The current candidate improves future bounded logging; it does not recover the original cause. Local replay of the exact private 515-bar input passed and produced 15 processed bars, but does not prove Linux launch, parent ticket, database receipt or enrollment success. No retry, new key, a2, holdout or Preflight submit is authorized by this failure.

## Reader fixes and lessons to preserve

All executed tool IDs are consumed; source namespaces and receipts are immutable. A new attempt needs a fresh reviewed tool/identity and source-bound root read authorization. Never copy acceptance or consumption records into a new namespace.

- Baseline metadata checked all 1,195 release files successfully. Subsequent content verification also completed.
- API, research, Trading and the protected market-stream unit fragments have two links. A dedicated exact unit/role/path/content reader now permits positive integer link counts only for these four pinned fragments. Ownership, mode, size, hash, no-follow traversal and stability remain checked. Generic environment, drop-in, release and policy/control reads still require one link. No fragment was modified.
- A hardcoded `0644` check incorrectly rejected a real `0600` pin. Actual-pin fixtures now cover the controlled and protected fragment paths; do not substitute empty protected-service fixtures.
- Local reproduction showed that a metadata role containing a prohibited label fails redaction; the actual discarded live output does not establish its trigger. Fixed `CFG_000` through `CFG_050` identifiers and a private mapping solved the composition problem without weakening redaction. Test the complete producer output through the real driver and real leak list, not an empty success fixture.
- Pseudo-file over-reservation was corrected only for proven cgroup readers: 16 KiB selected leaves, 64 KiB overlapping process-list reads, original defaults elsewhere. The 80,000,000-byte explicit-read ceiling remains. It is not a total physical I/O ceiling.
- Latest reader passed 172 focused independent checks plus three independent negatives, then reached the live idle gate without budget refusal. Synthetic descriptor/body/digest/transport seams remain explicit; test counts never replace live evidence.

## Whole-project prototype status

These are milestone summaries, not a claim that the entire six-step journey is accepted.

| Owner's step | Delivered evidence | Still open |
| --- | --- | --- |
| 1. AI chatbot bridging | Real-provider and Bridge workflow evidence exists; staging UI and source-binding work delivered. | Full authenticated journey acceptance and unsupported source adaptations remain scoped gates. |
| 2. Ten numeric inputs | S1, S2, S3 and S5 accepted; S7 mechanical replay accepted locally. Selection/snapshot code and staging releases exist. | Full S4 runtime acceptance, S6 `confirmLookback` decision and whole Step 2 acceptance. |
| 3. Preflight and Risk Manager | Static/risk proposal features exist. W7 and D6 were accepted; D6 observed 1,100/1,100 samples. | O1 failed; R7 and PF-2 remain open. Preflight OFF. UI panel not released. |
| 4. Real signal transport and execution | New QL-P2 natural Paper BUY and same-entry reduce-only EXIT were evidenced on 2026-10-04. | This is Paper, not Live. Old QL-3A allocation remains unresolved; its stopped alert must stay stopped. |
| 5. Quant Lab optimizer | One bounded 21-candidate run completed with NO_VALID_CANDIDATE; raw BACKFILL of 515 bars completed separately. | No validated winner; no automatic new campaign, retry loop or holdout access. |
| 6. Quant library and best-strategy selection | Research Library and Quant History delivered on staging. | Actionable best-strategy export requires a qualified candidate; full end-to-end acceptance is open. |

Other owner decisions remain: S6, old QL-3A OPEN position, authenticated Create Bot with 3/3 capacity, QL-P2 label, MD-1, database-principal separation, final release timing and the authenticated walkthrough. Consult the current Roadmap for each gate; this continuation did not close them.

## Release proposal and authority boundary

The selected proposal is an **inactive observability release**, separate from calibration. Under a future concrete, reviewed owner effects approval: close admission on the old API first, verify denial and idle state, stop/settle research, install the matched candidate targets, and run only the candidate API with all five relevant flags OFF. Research remains STOPPED with the candidate installed target. Trading is outside mutation scope.

The proposed rollback restores API and installed research targets to `325d335` while retaining admission OFF and research STOPPED. It must not reopen enrollment or restart research. No reviewed mutation executor or fresh post-O1 owner effects approval exists. Old s07/R7 rollback tools cannot be reused by assumption.

The historical capacity envelope authorizes one marked job on the old release, not new workload on this candidate. Bootstrap measurement, a final measured policy, a distinct final enrollment, permanent holdout registration and Preflight activation remain separate gates. Do not change limits, flush shared caches, reset guards, apply Best Inputs or activate Live automatically.

## Team, usage and handoff completion

Operations, Debugger and Architecture auditor are completed/frozen. No child may resume under Codex after transfer. The owner explicitly stopped this run; do not interpret unfinished work as a request for Codex to keep dispatching.

Codex's last observed weekly remaining usage was 48%; the short window was unavailable. Claude must check its own separate usage and client model/effort/ultracode state under `AGENTS.md`. Historical owner thresholds are not a current guaranteed balance. The private handoff records exact evidence, source pins, consumed IDs and the concrete next diagnostic contract.
