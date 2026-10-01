# PF-2 W7 prerequisite checkpoint — 2026-10-01

Status: read-only staging discovery and local release preparation. W7 has not
started. No service, database, grant, configuration or deployment was changed.

## Owner authority and execution scope

The owner accepts staging downtime at any time and the effects of the staging
executor-mode change, database changes, runtime privileges and disabled API
admission. The owner then instructed Codex to resolve the technical questions,
continue according to the project documents and commit/push at important
checkpoints. These decisions replace the outstanding requests for those same
owner choices. They do not close technical acceptance gates.

The root may dispatch one designated operations agent for a bounded staging
packet. The earlier requirement that the owner personally type every host step
is superseded for this authorized continuation. Each operational packet still
needs exact targets, current health and isolation evidence, backups, stop and
recovery procedures, and an independent review where the existing procedure
changes. The W7 one-attempt-per-case rule remains. Production, Live, Pine/Risk
Manager changes, expanded capacity and new research campaigns remain outside
this continuation.

Root decisions: use the audited Git-blob export for release `28d6f7e`; keep
public research admission off after W7 until the Roadmap R7 packet. Do not
change the production grant script as part of this prerequisite work.

## Current observations

Bounded SSH observations between 09:48 and 09:52 UTC found:

- The three staging services are running. Their current configuration files
  identify a staging database distinct from production, and the read-only SQL
  session confirmed its staging target and runtime role. Both observed health
  endpoints returned HTTP 200 and PAPER_ONLY. File configuration has not yet
  been proved unchanged since the running processes started.
- Basic headroom satisfies the W7 thresholds in this observation: load below
  1.0, available memory above 4 GiB, free disk above 20 GiB, and no swap.
  PostgreSQL client 16, tmux and screen are available. Recheck before execution.
- Staging has schema 14 and legacy research tables, but no foundation, I/O,
  enrollment or preflight tables. It therefore has no eligible foundation
  SUCCEEDED BACKFILL. One READY deployment exists; its full W7 eligibility is
  not yet certified.
- The actual staging runtime role differs from the role hard-coded in the
  standard grant script. The packet must use reviewed grants for the actual
  staging role, not run the unmodified script against the wrong role.
- The API configuration files enable research admission and Pine capture. An
  API stop interrupts that staging capture route; the owner accepts downtime.
- The required policy environment settings are absent and the running research
  worker has no physical I/O limit in `io.max`. Controller delegation alone is
  not enforcement. Current configuration cannot satisfy W7 prerequisites.
- The API and research worker use one old release directory; the trading worker
  uses another application root. No common current-release symlink exists.
  Sample source hashes in the first directory differ from its named Git
  revision; the cause is not yet established. The trading worker samples match
  that revision. A single previous-release/rollback identity is not established.

Detailed identities and evidence are retained privately in
`.qa-local/w7-technical-preflight-2026-10-01.md`. Do not publish environment
contents, connection strings, host locations or private record identifiers.
Node loads environment files through command arguments; the process environment
did not expose those loaded values. Canonical environment-file isolation and
unchanged-since-start checks remain open. The existing units do not declare
systemd EnvironmentFile entries, so the old packet's override assumption also
needs review.

## Local release evidence

Git HEAD is `796f6c2a4cec8f1716a81b9ce8c742aa774740d0` on
`codex/app3a-market-wait-checkpoint`. On takeover it matched the local origin
reference, with no tracked edits; the owner's three untracked files were left
untouched. Public GitHub check runs were refreshed at 09:47 UTC: both HEAD and
the W7 release have nine successful checks.

Release `28d6f7e1b573811c621a43cb20cfdcf7d5f94b39` was exported locally from Git
blobs. All 532 files match their Git blob hashes. The release tree digest is
`6c43f183747b386ffe7013ec23f329d4053a4b665ecff8849ec1a84210ddca68`.
The product hash functions loaded from that exported release reproduce the
audited ingestion and foundation hashes:

- Ingestion: `d7097b8a6162cde1ed1d8ea20150f7d2adba5a300e440e9bfa9d9c5e474eebce`.
- Foundation: `d865692f5ed6685ba41ae9226baa005ab4c23b19006d0772816a0254300cd6b9`.

No artifact has been uploaded. Previous-release compatibility and host policy
digests remain open, so this is not a completed G1 release record.

## Next gate

Prepare and independently review a prerequisite packet before W7. It must
establish per-service rollback identities, the actual runtime role and grants,
reviewed resource policies and physical I/O controls, and a safe foundation
bootstrap followed by one bounded prerequisite BACKFILL if eligible. Do not
reinterpret legacy research data as a foundation BACKFILL or waive the live
I/O prerequisite. W7 must be re-admitted against the resulting evidence.

An independent architecture review accepts the need for a separate bootstrap
path, not a reordered execution of the old W7 packet. Its proposed checkpoints
are B0 (read-only per-service manifests, policy provenance and deployment
eligibility), B1 (physical I/O controls), B2 (foundation install and startup
without jobs), and B3 (one bounded prerequisite BACKFILL). Each is a separate
root admission decision; this review does not certify execution readiness.
Raw bytes remain authoritative even if line-ending normalization later
explains a source mismatch. Storage binding can leave a filesystem marker
outside a rolled-back SQL transaction; the B2 recovery plan must cover it.

The order remains: prerequisites, W7, D6 prepare+BEGIN p99 on Linux, durable
enrollment proof in Roadmap R7, then separately gated staging activation.
D6 does not block W7. No new local test suite was run for this read-only and
release-preparation checkpoint.

## B0 and private grant validation follow-up

Read-only B0 observations from 09:56:24 to 10:02:55 UTC captured 193 allowlisted
runtime/source files with their raw hashes. All 115 captured API/research files
match the named old revision after CRLF normalization; raw bytes are retained
as the rollback identity. Seven trading-root files differ in content. An
independent review found no additional incompatible old query within the
proposed bootstrap/W7 scope, subject to preserving each service's exact old
root, working directory and environment-file order.

Rollback after foundation installation requires a fully idle system and
restoring LEGACY mode before the old research worker starts. It must retain
the new executor-mode SELECT/UPDATE privileges required by the mode trigger,
as well as I/O table SELECT privileges. Restoring every old ACL indiscriminately
would remove these requirements. Shared staging dependencies must remain
untouched; new releases need isolated dependency installation. Full unit,
configuration, asset and dependency backup/provenance gates remain open.

Twelve pinned-release deployment checks pass on narrowly materialized real
staging records, including source/settings/evidence, current membership and
the full freshSnapshot capital comparison. This is read-only evidence, not
an enqueue or a complete service-authorization acceptance. The environment
file modification times precede service startup and their hashes were stable
across observations, but no claim is made about a direct live process.env read.

A private staging-role grant derivative was independently reviewed. Its second
revision fixes the search path, preserves the existing legacy version marker's
SELECT-only access and verifies effective privileges after applying grants.
The frozen artifact SHA256 is
`e67f1ccffaacfbc9bb09fd905629cb4db1e50735b767acf45227246d1d889885`.
An independent local PostgreSQL fixture passed ten scenarios within one Node
test in 16.251 seconds, covering expected privileges, protected markers,
wrong-target/role rejection, a busy maintenance lock, PUBLIC/inherited grants,
transaction rollback and an ambient shadow search path. An initial harness
timeout was corrected before the successful run; no SQL defect was reported.
Both disposable clusters were stopped and the shared local test cluster was
not modified. No staging grant was applied.

The fixture does not replace full-schema, actual owner/role, column ACL,
TRUNCATE/ownership, backup or operational identity checks. Private evidence is
retained in the B0, bootstrap-review and grant-test records under `.qa-local/`.
Next is completion and independent review of the bounded B1 physical-controls
packet; B2 migration and B3 BACKFILL remain separately gated. README and Context
were reviewed unchanged for this follow-up because the overall readiness and
product scope remain the same.
