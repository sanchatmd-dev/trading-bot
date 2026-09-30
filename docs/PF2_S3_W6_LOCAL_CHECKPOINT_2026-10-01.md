# PF-2 research preparation and offline installation checkpoint

## Local scope

These changes continue the owner-authorized staging API objective. They do not
enable PF-2, change the 10,000-bar admission limit, deploy code or certify native
Linux behavior. No commit or push is included in this checkpoint.

## Research preparation

FOUNDATION research enqueue now stores a V2 contract with the requested range
and ordered content digest. It performs one database aggregate and writes no
dataset files. After claim, the worker prepares the dataset under its lease and
heartbeat, verifies the frozen digest, and publishes a write-once binding using
the existing scheduler and research-row fences.

Stored V2 identity remains authoritative for authorization and chunk identity.
The evaluator receives the derived V1 contract shape. The fixed V1 parity golden
is unchanged; LEGACY and PF-2 engine identities were unchanged by this slice.
Foundation and ingestion identities change and require the normal deployment
gates. Existing managed V1 queued work is refused without blocking the queue.

Retention traces valid bindings in every job status. Missing binding is accepted
only for a pending run with no chunks, completed steps or evaluations. Successful
or previously evaluated work without binding refuses maintenance. Malformed
bindings, misplaced PREPARE records and unknown managed versions also refuse
maintenance before deletion begins.

Independent source review found no blocker. PostgreSQL HTTP verification then
caught an off-grid timestamp that still satisfied aggregate count and endpoints.
The SQL invalid-row filter now checks the minute grid without excluding rows
from the aggregate. Existing HTTP rejection expectations were retained; the
recheck passes 4/4. Independent S3c now passes twelve checks on a frozen test snapshot and detects all eight mutation variants across seven design categories. The mutations cover both lease fences, stored contract identity, execution-contract misuse, retention, digest comparison and NULL-safe intake validation. Product source hashes remain unchanged across mutation testing.

## W6 offline installation and observation

The foundation installer now installs the optional I/O ledger and runtime
schemas inside its maintenance-locked transaction. A complete existing W2 schema
is accepted unchanged. Partial or altered schemas are refused; guards are never
silently repaired. Validation covers columns, constraints, unique indexes,
trigger bindings and function bodies. Active jobs and unresolved I/O block
installation. Unrecognized catalog definitions require explicit review.

The read-only idle command reports active executors, unresolved launches and
operations, malformed state and queued V2 policy counts using a consistent
snapshot. All operational reads use the public schema. This is an observation,
not a lock against subsequent admission; deployment still needs offline
coordination. Output contains fixed codes and policy identities, not raw errors.

Independent review found and corrected unqualified idle queries that could read
shadow tables. A real PostgreSQL shadow-schema regression now verifies refusal.
The installer also rejects row-security and partition drift from the supported
ordinary-table schema.

## Evidence and remaining gates

- W3 runtime: 43 passed; PROFILE authority and stale-engine queue: five passed.
- W6 migration: nine passed, including idempotence, exact W2 adoption, corruption,
  runtime exclusion, rollback and shadow-schema cases.
- Retention: nine passed, including aged-file apply that preserves bound artifacts
  and removes an unbound orphan. Publication fixtures needed a larger isolated
  test budget; product limits did not change.
- S3 pure contract tests: 30 passed, including the unchanged V1 golden.
- Final research foundation: 22 passed, one skipped; research HTTP: four passed;
  research service: eight passed; LEGACY HTTP: seven passed; recovery: 46 passed;
  foundation storage: one passed; PROFILE runtime: 43 passed.
- Full Node suite: 731 passed, three skipped, zero failed in 247.7 seconds.
- Independent S3c baseline: twelve passed in 73.224 seconds; eight mutation
  variants detected by the intended behavioral checks. The earlier eight-test
  baseline also passed. Fixture errors and late test edits from earlier attempts
  were corrected before the accepted frozen runs; no timeout or harness failure
  counts as mutation evidence.

S3c local acceptance is complete, using a synthetic evaluator and fake operating
system manager. Private Python and native Linux evidence remain separate.
R5 worker/recovery and E1 enrollment admission are now in progress with separate
file ownership; R6 API wiring is also in progress. W4 executable closure,
measured enrollment completion and owner-run Linux proof remain gates.
Provisional CANCELLED PROFILE output is not enrollment.
