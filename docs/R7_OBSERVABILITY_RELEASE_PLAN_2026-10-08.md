# R7 terminal error observability and release preparation

Current candidate: `bb0327c` extends the earlier correction with `PROFILE_ENROLLMENT_DENIED` and `PROFILE_ENROLLMENT_TICKET_INVALID`. Author checks passed 11/11; independent checks passed 15/15. Root accepted and pushed the local change; CI passed. It supersedes `f1daede` release pins. New exact Git-blob identities are recorded in [parent diagnostic evidence](evidence/R7_PARENT_LOG_CORRECTION_2026-10-08.json). Existing preparation tools pinned to the earlier candidate remain historical and are not execution-ready.

## Diagnostic preparation update

Candidate `f1daede` CI completed successfully. Local actual-pipeline execution with synthetic 515-bar data passes, and the bounded stderr observer passes 14 author and 14 independent checks, including actual launcher parsing with controlled host seams. These are local module/protocol checks, not Linux readiness, physical I/O, marked enrollment or historical-cause evidence. The observer remains a private measurement-harness component; no product integration or deployment occurred. [Diagnostic evidence](evidence/R7_LOCAL_DIAGNOSTICS_2026-10-08.json).

A bounded read-only export of the failed job's immutable pipeline inputs completed at 12:47 UTC, before any calibration or release. The original payload hash and 515 bars were verified; runtime remained healthy and idle. Local reproduction using those exact private inputs passed, including an independent run using the production default clock. Both produced 15 processed bars, two frames and result SHA256 `6329a24d990d58cc12d11f58c46ebd339e47b1399b710ff1319cd4c8ee301fdb`. Contract, policy and raw bytes remained unchanged; local transport identities, store factory and a Windows directory-sync test allowance differ from staging. Child readiness/stdin, parent authority/ticket, Linux supervision and receipts remain outside this proof. Parent error-code coverage is now independently accepted. The explicitly typed bootstrap proposal validator is now locally accepted; it cannot authorize execution. Preserve exact manifest/chunk bytes and the contract/policy; attest the original payload hash on the host without exporting its storage path or lease-derived operation identity. Local transport identities and paths must be rebound and disclosed. Descriptor/path-race, bounded-marker and provenance corrections passed independent review (16/16 plus 17/17); root authorized exactly one read-only execution. No new enrollment is authorized by this diagnostic path.

The later measurement proposal uses an inert candidate and isolated scratch database/stores before a production pair switch. Its marked-admission fidelity, genuine input establishment, bootstrap policy semantics, cache coverage and setup/cleanup bounds remain unresolved. A proposed three-slot warm/cold-scratch/warm matrix is not an accepted calibration contract or proof of worst-case capacity. Existing test fixtures fake parts of authority and supervision and must not be promoted to host evidence.

## Accepted local correction

Commit `f1daede` on `codex-worker/combined-r7` adds `QUANT_IO_LAUNCH_UNCERTAIN` to the worker terminal-log allowlist. Unknown codes still become `UNKNOWN`; error messages, paths and stacks remain excluded. The actual worker catch is tested with measured, unknown-final and unconfirmed terminal proofs. The author passed 9 tests; independent review passed 13 tests including engine-closure checks. Root accepted the local correction only. [Evidence](evidence/R7_LOG_CORRECTION_2026-10-08.json).

This correction does not recover the failed job's cause, persist its missing database diagnostic, capture child stderr or change scheduler, accounting, enrollment or risk behavior. The historical job remains CANCELLED and immutable. No deployment or new enrollment has run. Runtime was last observed at 12:47 UTC on 2026-10-08; local checks are not fresh host verification.

## Release contents and identities

Keep this release isolated to the worker allowlist and focused tests, based on the combined release branch. The UI Preflight panel remains deferred until after R7. Both API and research-worker trees must match because API-created contracts bind engine identities. Do not copy the main checkout's older worker file over the combined tree.

Exact Git release blobs preserve the legacy and evaluator hashes. Foundation, ingestion and PF-2 engine hashes change only because `src/postgres/quant-research-foundation.js` changes. Full before/after values are in the evidence JSON. Windows working-tree CRLF bytes were checked and rejected as release-pin inputs; release tooling must use exact Git archive bytes.

## Capacity gate discovered during review

The accepted private `r7-envelope-v1` limits its scope to one marked enrollment on release `325d335`, using 515 raw bars and 15 processed bars. Its scope and reuse clauses explicitly exclude another release and require measured calibration and a new envelope. An unchanged evaluator hash does not override that condition. Earlier advice that policy replacement was only conditional on changed evaluator assumptions was incomplete and is superseded here.

A new envelope changes `calibration_sha256`, policy bytes and policy hash. The policy must then remain byte-identical from enrollment activation through the associated Preflight. Historical D6 acceptance remains valid for its measured release; it is not evidence for new runtime bytes. Any D6 applicability decision must be reviewed separately from I/O calibration.

## Later measurement preparation

Prepare a bounded measurement contract for candidate `bb0327c` and the existing 515-bar data class. It must bind release bytes, host controls, evaluator, terminal limits and cache conditions; collect measured read/write counters and terminal timing; and define stop, recovery and acceptance criteria before execution. The existing zero-read sample does not establish cold-cache coverage. Do not flush a shared host cache as an implicit test step. Sample count, duration and the permissible bootstrap measurement mechanism need technical review; existing receipts do not supply these answers. No measurement is authorized by this document.

After that contract is reviewed, the designated operations worker prepares a fresh tool namespace and release packet. Old consumed s07/R7 tools must remain frozen. The packet must cover:

1. Fresh read-only health, idle and settlement checks. A separately authorized R7 x1 can return the pair to the s07 flags-off state; post-O1 rollback requires fresh owner approval.
2. Inert upload/staging and a matched API/research-worker switch, with exact target, downtime scope, rollback target and automatic rollback limits. The old s07 x7 window is closed. Trading remains outside scope.
3. The reviewed measurement procedure, new envelope/policy and D6 applicability decision. Any required measurement execution needs its own explicit bounded authority.
4. New R7 activation and observation pins. Historical jobs stay preserved; the new activation epoch must distinguish the earlier failed attempt without weakening the one-marked-job condition.
5. A separately approved new enrollment with a new idempotency key. The existing key returns the old CANCELLED job. Only a new w1/v1 acceptance permits a2; permanent holdout and Preflight remain later owner gates.

This is a preparation plan, not an execution GO or a claim that the release package is ready. Root owns acceptance; the immediate local task is a genuine scratch admission input contract with bounded setup/cleanup; the measurement contract remains a later preparation gate.

## Bootstrap evidence semantics

Source review confirms that capacity validation delegates genuine evidence resolution to its caller. The previous engineering envelope also explicitly documented that its bounds were not freshly measured. A new, separately labeled measurement-bootstrap artifact is therefore a possible caller-side proposal, not completed calibration or inherited authority. Root accepts local proposal tooling only. The tool must always report `readyForExecution: false`, distinguish bootstrap from final enrollment evidence, bind the canonical policy projection without its calibration digest, then insert the artifact digest and retain unchanged product validators. Genuine parity applicability, engineering ceilings, scratch admission inputs, setup/cleanup bounds and owner-approved effects remain unresolved execution prerequisites. No executing adapter is authorized by this design decision.

The offline proposal resolver passed 9 author checks, 9 independent checks and six additional adversarial refusals after two review repairs. Arrays now reject properties omitted by canonical hashing, and dataset identity must equal the manifest digest. The resolver uses synthetic fixtures and unchanged product policy/evaluator validators. Its output is always unverified, proposal-only and non-executable; reference hashes do not authenticate parity, engineering approval or completed measurement. See [local diagnostic evidence](evidence/R7_LOCAL_DIAGNOSTICS_2026-10-08.json). Next is a genuine scratch admission input contract and independently justified setup/cleanup bounds, not a host run.
