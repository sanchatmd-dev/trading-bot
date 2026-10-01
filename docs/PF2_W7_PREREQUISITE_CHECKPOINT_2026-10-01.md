# PF-2 W7 prerequisite checkpoint — 2026-10-01

Status: B1 accepted on staging after one supervised run and read-only
reconciliation at 11:08 UTC. API research admission is off and the research
worker is active and idle with verified physical I/O limits. Foundation
bootstrap and W7 have not started. Earlier sections retain discovery evidence;
the B2-R acceptance section below owns the latest recovery-publication status.

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

## B1 review and current baseline

The independent B1 review requires seven corrections before execution:
effective unit/drop-in validation, effective database identity, complete worker
and child-stop proof, canonical path/absence checks, sanitized diagnostics with
deadlines, stable job-state fingerprints, and rollback for partial execution.
Preliminary local changes cover parts of four findings and pass five helper
assertions. None of the seven findings is accepted as closed. The draft refuses
stopped/rollback certification and requires an approved baseline; its historical
shell examples are not an executable packet.

A read-only host observation at 10:30:50–10:30:52 UTC captures effective settings
and process/cgroup identities for five baseline units. Their manager Environment
properties are empty. The proposed packet and drop-in targets are absent,
including symlinks. API and research effective database targets match and are
distinct from production. The staging research tables contain one job, 100
steps and no research-run rows; the fingerprint query succeeds. Seven staging
database clients include the diagnostic connection, and three shared maintenance
locks are present. Mapping every backend to its owning OS service remains open
before B2; these counts do not prove a complete lock-holder inventory.

Private evidence is retained in the B1 audit, draft, baseline and helper-test
records under `.qa-local/`. No host mutation or W7 attempt occurred. Next is the
phase/unit/cgroup checker and partial-phase rollback procedure, then independent
review and fresh root admission. Git publication does not authorize execution
or constitute runtime acceptance.

## B1 staging acceptance — 11:08 UTC

Independent review closed all seven original B1 findings for the frozen forward
path. The lifecycle review changed its terminal state to active/idle: a stopped
transient unit can lose its definition through garbage collection. A permanent
drop-in does not preserve that transient definition. B2 must have reviewed
recovery/replacement definitions before deliberate stops. This decision preserves
the requirement to prove physical I/O controls before migration and does not
claim stop proof. See the [systemd unit lifecycle documentation](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html).

Local verification passed 72 checker assertions and 12 focused runner/supervisor
tests. A frozen payload was uploaded to a new private directory; its bounded
direct preflight passed before the separate root execution dispatch. One
supervised forward invocation completed with exit0 at approximately
11:05:41–11:05:50 UTC. All five phase JSON records pass their evidence-hash chain
and preserve the same research-job fingerprint.

The resulting staging state is:

- API active with research admission disabled and Paper/capture preserved.
- Legacy research worker active and idle; foundation, V2, enrollment and
  preflight disabled; both controlled units use Restart=no.
- Actual worker device limits are 524288 bytes/second for both reads and writes.
- Production and trading process/cgroup identities remain unchanged, as do
  their raw I/O settings and the recorded source/configuration/dependency inputs.
- No active research jobs or pending manager jobs; no operational SQL writes, migration,
  BACKFILL, W7 case or application-release deployment occurred.

A supplemental observer failed after the successful runner because its hashing
helper received a JavaScript row object instead of bytes/string. The original
failure receipt is retained. A corrected read-only reconciliation at
11:08:22.950–11:08:23.272 UTC confirms current identities, owned-file metadata,
frozen hashes, queue0 and the unchanged fingerprint. Forward was not repeated.

Durable artifact identities, without private machine locations:

- Frozen payload manifest: `9e45e142d7df48950ec0ddb5a21efd36e02c0333e610e653fa298e8a459a2d05`.
- Successful upload/preflight receipt: `bf41c1422d3b28948953ebffffc149018054863791979b85f1fe281fafe3a0ba`.
- Successful post-run reconciliation: `290a4d971471757fab0f30c0fdb7c5f6a839a9959f20fcb821dbe02827fae2d2`.

Private audit, helper-test, runner-test, forward and reconciliation records are
retained under `.qa-local/`. The owned private payload and two drop-ins remain
in place; original environment files, service fragments and application roots
were not overwritten. The next root packet is B2 preparation: recoverable
definitions, all staging database consumers/locks, reviewed policies and an
offline foundation bootstrap without jobs. B1 acceptance does not admit B2,
B3, W7, D6, R7 or enrollment automatically.

## B2 preparation — database consumers and grants

A fresh read-only observation at 11:18 UTC reconfirmed the accepted B1 state,
Paper health, no active research jobs and the unchanged research fingerprint.
Unix socket peer identities map all seven observed runtime database connections
to the staging API, research worker and trading worker. Those three services
also hold the three shared maintenance locks.

A separate observation at 11:21 UTC identified a fourth staging writer: the
market-stream service targets the same database but its deployed code does not
acquire the shared maintenance lock. Its connection can disappear between
writes. Therefore neither an empty client snapshot nor an exclusive maintenance
lock alone proves that staging is offline. The B2 stop and recovery inventory
must include all four services and reject any additional unexplained consumer.
All four current service definitions are transient. No service was stopped or
changed during this investigation.

Independent design review separates B2 into recovery preparation, offline
installation and startup without jobs. The first packet prepares durable
fallback service definitions while retaining the running processes. It must
publish complete files atomically without replacing existing targets and verify
the candidate definitions directly: transient definitions have higher load
precedence, so unchanged properties after a manager reload would not prove that
the fallback was loaded. A later stop/start remains a separate acceptance step.

The real pinned schema fixture exposed limits of the earlier minimal grants
fixture. On 66 public tables, the frozen v2 grant artifact permits the runtime
role to delete five new extension version markers. It also fails to reject
column grants, TRUNCATE and a reachable owner role with inheritance disabled.
The fixture rolled back destructive probes and stopped its isolated database.
No staging privileges were changed, and v2 is not accepted for B2 execution.

A private v3 derivative preserves the original artifact and gives those five
markers SELECT-only access. In the same grant transaction it refuses surviving
column writes, TRUNCATE, unexpected role memberships, runtime ownership and
schema CREATE privileges. Independent static review and the focused real-schema
fixture passed: 10 tests, no failures, 32.286 seconds. Both non-superuser owner
and superuser administration succeeded; required row/table locks remained usable,
27 marker-write probes were denied, and all 13 refusal trials rolled back the
whole grant transaction. Root accepted this local artifact contract. It has not
been applied to staging. The production grant script and the
pinned release remain unchanged. The private artifact's SHA256 is
`54102ccabcbb64d45d8130ddc783010a6aef8958201f0cbe50d76977b207514d`.

B2 requires reviewed recovery, storage, resource-health and I/O policies.
Capacity and health-recovery policies can remain disabled while V2 and
preflight are off. Bind the empty dataset root before startup creates storage
reservations: even an idle foundation startup performs a bounded 4096-byte
I/O readiness write. No migration, foundation startup, BACKFILL or W7 attempt
has been admitted by this preparation checkpoint.

## B2-R recovery publication and read-only reconciliation

Root accepted the bounded publication outcome after independent audit and
focused reconciliation tests. One supervised run at 11:58:11–11:58:23 UTC
published four complete, hash-matched fallback definitions atomically without
replacement and performed one successful manager reload. Private native systemd
verification had passed before publication. The files have the reviewed owner,
0600 permissions and expected hardlink identities; their bytes remain immutable.

The runner returned exit 2 at its post check (`UNIT`) and its journal ends in
HOLD, not COMPLETE. This original evidence is retained unchanged. A separate
read-only observation at 11:59:53–11:59:57 UTC found eight changes, all involving
display order in `Requires`, `Before` or `After`. Their members were identical.
An offline derivative normalizes only those three unordered token lists and
rejects duplicates. All other fields retain strict comparison. Independent
testing passed 21 tests with no failures or skips: the captured snapshot passes
the corrected comparison and fails the original; dependency additions, removals,
replacements and duplicates fail, as do changes to ordered command/drop-in
fields, process identities, source hashes and feature flags.

All six observed staging/production processes retained their identities. B1
admission, I/O controls, health, empty queue and research fingerprint remained
unchanged. No service stopped or restarted; no migration, grant, release switch
or job ran. The original transient fragments still take precedence. This proves
publication and current invariants, not that fallback loading, subsequent
stop/start recovery or full stream dependency closure has been exercised.

Private evidence is retained under the B2-R forward, reconciliation, audit and
test records. The forward receipt SHA256 is
`f859f4cfacfbc0efa4ea59332a70fa95b2497b29280927141b71616da1fd7f2a`;
the read-only snapshot is
`202bcdec38676f206ea6b5f16a9c6a5830c4f2b6f4ac4b118993904706cfc97f`;
the corrected offline contract is
`b6d4b6a1314685e3ef1a4f712ef26adc2bf76009e381b320969ad9139b333ccd`.
The host payload, original checker and failed result were not rewritten.

Next: prepare and independently verify the pinned 17-package production
dependency bundle in a fresh local directory. Later Linux extraction/import
proof and exact release, storage, health and recovery bindings precede a
separately reviewed B2 offline packet. No B2 offline or foundation-start gate
is closed by this recovery-publication acceptance.

## B2 local dependency bundle

Root accepted the local production dependency artifact at 12:36 UTC. A fresh,
isolated install used the pinned release's unchanged package and lock files,
with scripts and development dependencies disabled, private configuration/cache
and an explicit environment allowlist. All 17 installed versions and downloaded
tarball SHA512 values matched the lock. No existing runtime dependency directory
was modified, and no install was repeated.

The initial verifier returned `RELATIVE_CLOSURE` after installation. Three
references point to absent fixtures in shipped dependency tests; four use
directory resolution that its conservative resolver did not implement. Audit
and a separate Node-resolution/AST verifier established the selected runtime
closure: 96 application source files, four dependency entrypoints, 45 reachable
dependency files and 84 edges, with no unknown or nonliteral imports. Four
independent tests confirmed zero parser diagnostics, exact Git blob identity
for all selected application files, and no evidence of selected application
use of the unsupported native PostgreSQL branch. The original failed receipt
and all shipped files were preserved.

A credential-free CJS/ESM probe passed PostgreSQL export checks, exact decimal
arithmetic and tokenizer encode/decode equivalence without application startup,
database connection or network calls. The final regular-file POSIX archive
contains 182 files, including shipped tests, data and licenses. Only npm's
generated hidden lock metadata is omitted under an explicit recorded rule.
Root independently parsed it with Python's standard tar reader and verified
the complete entry set, file types, modes, sizes and content hashes against the
original inventory. The archive is 23,338,496 bytes; SHA256:
`c0bd614e9cb3ad1d17e51ac14bab20c0d8b4258f888cc24855684e64566e1214`.
The per-file manifest SHA256 is
`54e3943a0fca2d747bb86511ca93b3fa5a1ccc21a3b1ae46881efc7919264895`.

This is local artifact acceptance on Windows Node 24.19.0, not deployment or
Linux Node 24.21.0 proof. Native PostgreSQL and custom Cloudflare conditions
remain unsupported in this selected path. The next bounded action verifies
host release/storage candidates, runtime health and consumer/activation facts
read-only. A separate exclusive extraction/import packet must pass before the
offline migration and foundation-start gates. No host service, database or
research job changed during this dependency preparation.
