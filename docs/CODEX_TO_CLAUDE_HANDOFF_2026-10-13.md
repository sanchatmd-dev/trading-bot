# Codex to Claude — project handoff, 2026-10-13

The owner requested that Codex stop, save a checkpoint, and hand over the whole project and latest work to Claude. Implementation is stopped. All assigned children have returned; their test and diagnostic sessions are closed. No new host action is authorized by this handoff.

## Read order and takeover

1. Read `.qa-local/codex-to-claude-handoff-2026-10-13.md` first. It contains the current failure, exact evidence pins, ownership and resume instructions.
2. Read this summary, then `.qa-local/codex-r7b-j3r2-authority/CHECKPOINT.md` and the latest recovery diagnostic report linked in the private handoff.
3. Read `AGENTS.md` and `.agents/skills/caveman/SKILL.md`, then the current sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md). Historical paragraphs do not supersede the current checkpoint.
4. Recheck Git, file ownership, assigned jobs, the Claude client's model/effort/ultracode state, and Claude account usage before dispatch. Codex usage is a separate account meter. There must be only one commander.

This is a file handoff in the shared checkout. No Claude session was launched or messaged through a direct Claude connector. No commit, push, deployment, credit purchase, reset redemption or API-credit continuation occurred.

## Whole-project status

Engineering estimates remain **60% for the whole project (55–65%)** and **75% for the staging prototype (70–80%)**. They are estimates across capabilities, not test-pass ratios. The [current Mermaid diagram](ROADMAP.md#target-system-diagram) uses green for the completed named scope, yellow for work or gates still open, and grey for planned work.

| Area | Evidence available | Work or gates still open |
| --- | --- | --- |
| Staging UI, chatbot and Pine Bridge | Scoped UI and APP-3A engineering baseline | Complete authenticated journey, source adaptations and the separate Claude adapter candidate |
| Ten numeric inputs / Create Bot | S1/S2/S3/S5 acceptance, S7 local replay and staged selection/snapshot work | S4 runtime, S6 confirmLookback decision and complete end-to-end acceptance |
| Signals and Paper | Natural same-entry BUY and reduce-only EXIT evidence; ledger and audit baseline | Previously recorded OPEN allocation issue; no Live activation |
| Market data and evaluator | Scoped chart/Spot ingestion and backfill; narrow 10K-bar/1m support | Varied-input parity, profile binding, broader data scale and operational qualification |
| Risk and Preflight | Risk Manager baseline, PF-3/PF-4 staging, scoped W7/D6 evidence | R7 measurement, enrollment/capacity, PF-2 activation, UI release and final Preflight |
| R7B isolated PostgreSQL harness | J1, J2, J3 and J4 individually accepted; 20 unique cases across recorded packages | Full R7 remains open; this is not one RC15 run of all 20 cases |
| EM2 local preparation | Planning helpers, native STAGE/FULL previews, release core, synthetic native chain, native recovery checks, persistent controller and read-only held-lock report accepted in their local scopes | Persistent-controller recovery matrix is incomplete; real adapter and measurement remain locked |
| Quant research and optimizer | Historical 21-candidate run returned NO_VALID_CANDIDATE; 515-bar backfill and retained A7 reproduction evidence | Qualified winner, independent holdout and settings/parity gates; no automatic campaign or optimizer loop |
| Research Library, comparison and reports | Library/History staged; compatible comparison and partial baseline | Immutable artifact restart/readback proof, complete fair comparison, qualified export, SMTP gates and end-to-end acceptance |
| Wider product | Scoped foundations above | Actual Paper portfolio performance, best-performance selection, broader multi-Pine support and operating capacity |

These are evidence scopes. Historical runtime observations are not current health checks.

## Completed during this Codex continuation

- **J2-R1 / RC11:** five cases passed on the isolated PostgreSQL job. [Evidence](evidence/R7B_J2R1_2026-10-13.json).
- **J3-R4 / RC15:** H-12b, H-14 and H-15 passed after preserving the earlier failed attempts and correcting the harness. The disclosed H15 audit-copy normalization and startup/synthetic-fact limitations remain. [Evidence](evidence/R7B_J3R4_2026-10-13.json).
- **J4-R1 / RC15:** H-13 passed SUCCEEDED, cancellation from QUEUED and cancellation after launch. Direct artifact hashes, recovery and strict postflight were accepted. [Evidence](evidence/R7B_J4R1_2026-10-13.json).
- **J1–J4 reconciliation:** 20 unique cases, common tool/product bytes, four changed harness files and 431 unchanged payload files support the recorded mixed-package carry. [Evidence](evidence/R7B_HARNESS_RECONCILIATION_2026-10-13.json).
- **EM2 local preparation:** source inventory, deterministic proposal compiler, native previews and release core were reviewed with synthetic data. The core holds after unknown transport or raw-retention failure. A7's reported digest matches its reference, but full result/frame bodies were not retained and the source inventory was taken after execution. [Preparation](evidence/R7B_EM2_LOCAL_PREPARATION_2026-10-13.json), [previews](evidence/R7B_EM2_NATIVE_PREVIEWS_2026-10-13.json), [core and A7](evidence/R7B_EM2_CORE_AND_A7_2026-10-13.json).
- **Native chain and recovery:** actual local M0 bytes feed the native FULL derivation and synthetic M1 admission. The native recovery fixture covers missing, malformed and correctly pinned expired operational allowlists. Later predecessor handoffs remain supplied synthetic fixtures. [Chain](evidence/R7B_EM2_NATIVE_CHAIN_2026-10-13.json), [native recovery](evidence/R7B_EM2_RECOVERY_LOCAL_2026-10-13.json).
- **Persistent controller:** under-lock claim history prevents delayed replay; FULL verifies its archived STAGE parent. Twelve injected persistence exceptions, an actual Windows junction and changed ownership retain conservative behavior. These do not prove process-kill or power-loss durability. [STAGE](evidence/R7B_EM2_CONTROLLER_STAGE_LOCAL_2026-10-13.json), [FULL](evidence/R7B_EM2_CONTROLLER_FULL_LOCAL_2026-10-13.json).
- **Read-only held-lock report:** final v11 passed independent retained-fixture, changing-read, bounded-JSON, FULL, artifact-limit and relinked-identity checks. It never unlocks, repairs, resets consumption, invokes transport or grants authority. Two matching reads establish observed stability only. [Evidence](evidence/R7B_EM2_HELD_REPORT_LOCAL_2026-10-13.json).

## Latest unfinished work: controller recovery

The latest candidate is `.qa-local/codex-r7b-em2-controller-recovery-v2/`. It changes only synthetic fixtures and their archive binding; the accepted controller and native core are unchanged.

| Cases | State |
| --- | --- |
| M4A: valid, missing, malformed and expired operational allowlist | 4 passed |
| M4B: the same four states | 4 passed |
| XS: valid and missing | 2 passed |
| XS: malformed | Refused with `CONTROLLER_REPARSE_PROOF_UNAVAILABLE`, before claim or fake transport |
| XS: expired | Not run |

The original archive retains its valid allowlist; the operational callback alone varies. Passed cases check durable event order and hashes, exactly one claim and fake transport, RELEASED and a fresh FREE inspection. This matrix has **not** been accepted independently or by root.

A single subsequent read-only snapshot of the failed XS archive passed. Its unchanged 5,000 ms Windows Attributes probe returned in 533.119 ms for 51 paths. The original failure's cause remains **unknown**: this is not proof of a timeout, a code fix, or a successful full XS retry. A diagnostic harness schema error occurred before that one probe and was corrected only in the diagnostic script. No retry followed the owner's stop instruction. [Checkpoint evidence](evidence/R7B_EM2_CONTROLLER_RECOVERY_CHECKPOINT_2026-10-13.json).

On takeover, the next bounded local action is to inspect the retained failure and diagnostic, then prepare a fresh isolated, instrumented XS/malformed controller case if the incoming root continues the authorized Roadmap work. Preserve all old attempts. Do not rerun scripts that write into frozen candidate directories. Keep the timeout and filesystem gates unchanged. XS/expired, replay/refusal coverage and independent verification follow only after that review.

## Authority, operating gates and Git

The owner's earlier instruction authorized reviewed fresh J3/J4 attempts until pass and subsequent Roadmap work. J3/J4 are complete. Their host windows are closed. Current host health was not rechecked for this handoff. The last accepted host evidence was Paper-only with research flags off; that is a historical observation.

Fresh measurement still needs a reviewed amendment/read scope, a quiet owner-present slot, M1 with named pre-armed recovery, immediate M2-submit approval, and final JF/Preflight gates. Real adapter/mainCLI remain locked. Preserve Spot/Paper-only, BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, immutable evidence and independent holdout. No automatic optimizer/range loop, Best Inputs apply, Live activation, guard reset or unapproved deployment.

Branch: `codex/app3a-market-wait-checkpoint`; HEAD: `b9d19e37691d2940257730dd8c2f6a124c36e67a`. All work since that revision is uncommitted. Root-owned changes are the four main project documents, the new handoff and 22 new public evidence JSON files. The exact stopped inventory and hashes are in the private handoff namespace. Preserve the owner's unrelated two diagram PNG files and `scripts/build-spt-exit-diagnostic.mjs`.

The private `.qa-local/` evidence is ignored and remains in this checkout; a Git-only transfer would omit it. Keep it available to Claude. Codex stops here and must not resume concurrently with the incoming commander.
