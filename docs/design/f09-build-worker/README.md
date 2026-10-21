# F09 S4 build worker: compatibility and preparatory design

Status, 2026-10-22 (Bangkok): **preparation only; successful integration is blocked**. This note follows the [package contract](../../QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md), particularly RC-12, RC-14–18, RC-22–26 and RC-34–39. It adds no worker, route, schema, accepted contract version or deployment authority. The interface and scheduling choices below are proposals for a later implementation packet, not new contract rulings.

## Current compatibility result

The current one-Pine trace and qualification profiles have no successful intersection:

| Stored contract | Trace reproduction | B0/G7 | Successful S4 build |
| --- | --- | --- | --- |
| `ql3a-research-job-v1`, no `execution_backend` key | ACTIVE | `OWNER_RECOMMENDATION_NOT_READY` | Blocked |
| v1 with any `execution_backend` key, including null | Unsupported | G7 fails | Blocked |
| `ql3a-research-job-v2`, foundation backend | DEFERRED | G7 fails | Blocked |
| `ql3a-research-job-v3` placeholder | DEFERRED | G7 can pass only with the required completion reason | Blocked |
| `ql3a-research-job-multi-v1` | DEFERRED in the one-Pine trace module | Only the explicit internal multi-Pine exception exists | Separate F11 path; outside S4 |

Evidence: the literal tables in `src/quant-library/trace-reproduction.js`, the derivation in `src/quant-library/owner-recommendation.js`, and `evaluateBuildEligibility` in `src/quant-library/package-gates.js`. `fixture=true` exempts the missing episode gate; it does not exempt G7. A one-Pine `internal=true` request does not obtain the multi-Pine exception. The stored `owner_recommendation_ready` flag cannot manufacture a G7 pass.

Root accepts this source-level compatibility finding. It is an intentional dependency, not a defect to repair by weakening a gate. A passing v1 reproduction test and a passing v3 gate fixture are separate component evidence. They do not demonstrate an end-to-end build. Do not rewrite v1 contracts to v3, promote a profile, or inject a passing gate to claim integration.

The slice defining the next recommendation contract must supply a compatible ACTIVE trace profile with real fixture evidence. RC-35 assigns that slice its closure and requires the FE-2b release plan and owner GO for engine-file changes. FE-2b alone does not define that recommendation profile.

## Proposed isolated interface and lifecycle

A future fixture worker could expose `build({owner_id, run_id}, {signal})`, constructed with trusted database/read adapters, server time/IDs and the S3 evaluation ports. The request would not accept source bytes, contracts, results, trace records, integrity flags, hashes or a caller-selected fixture flag. The trusted operator supplies owner identity; this is not a public authorization API.

Reject invocation inside an existing transaction before issuing queries: `PostgresDatabase.transaction` reuses an outer transaction, which would bypass a new SERIALIZABLE boundary. Force fixture packages at birth; return metadata only, with READY false. Validation attempts and their evidence remain S6; owner routes remain S5.

The smallest proposed execution scope is one explicitly invoked worker instance with one active job and bounded in-memory single-flight by owner/run. It would not enqueue a `quant_jobs` row or create a new durable queue. Job states would be bookkeeping only, not proof of crash recovery. Multiple worker processes and restart/resume remain unsupported until a separately reviewed claim/ownership design exists. The unique export key prevents duplicate persisted exports; it does not prevent duplicate pre-insert evaluation by two processes.

Before implementation, root must fix the memory capacity, terminal-entry lifetime, cancellation semantics, commit retry count and cross-process exclusion. Do not implement an inert refusal-only worker merely to make the slice appear complete while its success prerequisite is absent.

## Trusted reads required

- Read the owner-scoped frozen `quant_jobs` contract/result, durable creation time and checkpoint ties; recompute integrity instead of trusting request flags. `QuantResearchService.get` returns a summary and is not this raw verified view.
- Derive binding values from the evaluated deployment/source revision, frozen policy and library record. Missing exit version, identity or source/input ties must refuse; no defaults may conceal missing provenance.
- Read earlier owner holdouts, same-source searched windows, the Bot boundary and exposure entries through the existing register reader. Preserve its run-creation cutoff. Unavailable, malformed, incomplete or over-budget reads are not empty histories.
- Read existing exports by the exact owner/run key, verifying stored identity and status before returning metadata. A foreign or absent run has the same not-found response. LOAD does not certify current freshness, replay availability or qualification. Returning an existing export must not replay HOLDOUT or rewrite its provenance merely because current engine bytes changed.

All transaction-time readers must use the same transaction handle. The package extension must already classify as INSTALLED; the worker must never install it.

## Future enabled sequence

Until compatibility is resolved, stop before evaluation and writes. Once a separately accepted profile exists:

1. Validate the request, owner and transaction boundary; check for an existing export before expensive work. Freeze export ID, time and build identities once.
2. Read and verify the finished run and dependencies. Refuse nonterminal/no-candidate runs, unsupported profiles and multi-Pine requests on this one-Pine path.
3. Reproduce once outside the write transaction using S3. This must precede final rendering because the renderer requires traces. S3 checks the run and trace closures before and after evaluation. Do not derive trace evidence from stored result digests.
4. Render, run B0 on the rendered binding, and re-render if limitation codes change, as RC-16 requires. Stop on a refusal without writing an export or blob.
5. Open SERIALIZABLE; recheck an existing winner, frozen run integrity, all binding dependencies, lookups and exposure state. Re-run B0 against the final binding and recheck the reproduced closure pins. Any mismatch rolls back; do not mix new live fields into old rendered bytes.
6. Insert the blobs, export, all twelve package paths, sequence-one `EXPORT_CANDIDATE` event, then exactly three trace reproduction rows in the same transaction. Each trace SHA must equal its package file SHA. No compile, validation-attempt or `ql4c_validation` rows belong to S4.

Use the ordinary exposure reader consistently with the SERIALIZABLE snapshot. `readExposuresLocked` requires its lock to be the first statement; it cannot be substituted after arbitrary reads without a redesigned transaction sequence.

## Retry and failure proposal

Only bounded transaction retries may reuse the already verified reproduction and final rendered bytes. Re-read lookups and B0 in each fresh snapshot. A serialization failure or an exact owner/run unique-key race must never invoke the evaluator again. An unrelated uniqueness error is not idempotent success. QR003 is an isolation failure; QR004 maps according to RC-25. Root must explicitly decide deadlock handling and the retry bound before implementation.

Do not automatically requeue after a trace-closure change, process failure, interruption, exhausted retries or an uncertain COMMIT. Inspect whether an export committed before considering a new operator request. Absence of an export does not prove that HOLDOUT was never evaluated. In-memory single-flight cannot establish once-only behavior across restart.

Preserve the S3 interpreter selection and process limits, code-only error boundary, 16 MiB package cap and immutable evidence. OQ-1/OD-21 remains open: RC-38's provisional test-partition trade/decision rows and equity-at-fills convention remains fixture-only. No production recommendation follows from a synthetic success.

## Implementation acceptance packet, still unrun

Require one real stored supported-profile run through S3, renderer, B0 and the transaction; independently verify all file/trace hashes and unchanged side-table digests. Add exact refusals for foreign owners, stale/missing bindings, malformed histories, unavailable register, profile mismatch, closure drift, oversized output and late insert failure. Prove rollback leaves no partial blobs/export/events/traces.

For concurrency, show one reproduction for two same-instance callers and one export under a final-transaction race. Count HOLDOUT invocations across every commit retry. Test cancellation and uncertain outcomes without claiming crash-safe admission. Retain existing package, trace and closure regression suites, then discover all importers of the actual changed files before committing.

This packet remains dependent work. There is no current successful S4 worker, no runtime wiring, no deployment and no change to N1, private acceptance, owner recommendation eligibility or Best Inputs apply authority.
