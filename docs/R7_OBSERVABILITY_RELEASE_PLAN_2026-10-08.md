# R7 terminal error observability and release preparation

## Accepted local correction

Commit `f1daede` on `codex-worker/combined-r7` adds `QUANT_IO_LAUNCH_UNCERTAIN` to the worker terminal-log allowlist. Unknown codes still become `UNKNOWN`; error messages, paths and stacks remain excluded. The actual worker catch is tested with measured, unknown-final and unconfirmed terminal proofs. The author passed 9 tests; independent review passed 13 tests including engine-closure checks. Root accepted the local correction only. [Evidence](evidence/R7_LOG_CORRECTION_2026-10-08.json).

This correction does not recover the failed job's cause, persist its missing database diagnostic, capture child stderr or change scheduler, accounting, enrollment or risk behavior. The historical job remains CANCELLED and immutable. No deployment or new enrollment has run. Runtime was last observed at 11:18 UTC on 2026-10-08; local checks are not fresh host verification.

## Release contents and identities

Keep this release isolated to the worker allowlist and focused tests, based on the combined release branch. The UI Preflight panel remains deferred until after R7. Both API and research-worker trees must match because API-created contracts bind engine identities. Do not copy the main checkout's older worker file over the combined tree.

Exact Git release blobs preserve the legacy and evaluator hashes. Foundation, ingestion and PF-2 engine hashes change only because `src/postgres/quant-research-foundation.js` changes. Full before/after values are in the evidence JSON. Windows working-tree CRLF bytes were checked and rejected as release-pin inputs; release tooling must use exact Git archive bytes.

## Capacity gate discovered during review

The accepted private `r7-envelope-v1` limits its scope to one marked enrollment on release `325d335`, using 515 raw bars and 15 processed bars. Its scope and reuse clauses explicitly exclude another release and require measured calibration and a new envelope. An unchanged evaluator hash does not override that condition. Earlier advice that policy replacement was only conditional on changed evaluator assumptions was incomplete and is superseded here.

A new envelope changes `calibration_sha256`, policy bytes and policy hash. The policy must then remain byte-identical from enrollment activation through the associated Preflight. Historical D6 acceptance remains valid for its measured release; it is not evidence for new runtime bytes. Any D6 applicability decision must be reviewed separately from I/O calibration.

## Concrete next packet

Prepare a bounded measurement contract for candidate `f1daede` and the existing 515-bar data class. It must bind release bytes, host controls, evaluator, terminal limits and cache conditions; collect measured read/write counters and terminal timing; and define stop, recovery and acceptance criteria before execution. The existing zero-read sample does not establish cold-cache coverage. Do not flush a shared host cache as an implicit test step. Sample count, duration and the permissible bootstrap measurement mechanism need technical review; existing receipts do not supply these answers. No measurement is authorized by this document.

After that contract is reviewed, the designated operations worker prepares a fresh tool namespace and release packet. Old consumed s07/R7 tools must remain frozen. The packet must cover:

1. Fresh read-only health, idle and settlement checks. A separately authorized R7 x1 can return the pair to the s07 flags-off state; post-O1 rollback requires fresh owner approval.
2. Inert upload/staging and a matched API/research-worker switch, with exact target, downtime scope, rollback target and automatic rollback limits. The old s07 x7 window is closed. Trading remains outside scope.
3. The reviewed measurement procedure, new envelope/policy and D6 applicability decision. Any required measurement execution needs its own explicit bounded authority.
4. New R7 activation and observation pins. Historical jobs stay preserved; the new activation epoch must distinguish the earlier failed attempt without weakening the one-marked-job condition.
5. A separately approved new enrollment with a new idempotency key. The existing key returns the old CANCELLED job. Only a new w1/v1 acceptance permits a2; permanent holdout and Preflight remain later owner gates.

This is a preparation plan, not an execution GO or a claim that the release package is ready. Root owns acceptance; the next local task is the bounded measurement-contract design and independent review.
