# S6 Staging QL-P2 owner identity read-only packet

Packet ID: **S6-OWNER-ID-RO-1**. Status: **PREPARED; NOT RUN; AWAITING OWNER GO**.

The owner selected Staging QL-P2 Prototype and requested this packet for review before any target connection. This preparation grants no access. A new GO for this packet is required; the earlier applicability GO and historical operations GOs do not authorize this attempt.

## Purpose and boundary

Discover the missing `owner_id` for the single explicitly selected deployment and verify its relationship to the selected Bot. This is a prerequisite to the [applicability packet](S6_APPLICABILITY_READBACK_PACKET_2026-10-23.md), not execution of that packet. A known owner is deliberately not a precondition of this discovery query. Matching database relationships does not establish the operator's authorization; the owner GO must separately authorize this exact identity read through the existing approved channel.

The private binding record contains the complete Bot, import, source version and deployment selected by the owner. It must identify Staging QL-P2 / SPT Prototype Paper 2026-10-03, not old QL-3A or the earlier staging clone. Keep identifiers and access selectors in ignored local storage. Never select the latest deployment, infer an owner from another Bot, or combine snapshot identities with database row identities.

Local historical evidence now supports the receipt's execution provenance: connection metadata pins the collector hash, the checkpoint pins the output hash, and timestamps agree. The collector checked owner-parent equality but omitted the owner UUID. This does not establish current target identity, schema, health or applicability.

## Before any connection

Root must have all of the following:

1. The owner's explicit GO naming this packet and the selected Staging QL-P2 environment. The exact four-field binding must be frozen in the ignored local record and its hash included in the GO execution manifest. No substitution or fallback is permitted.
2. One designated operations worker, running alone under Root's serial dispatch. Root retains acceptance and browser/Git coordination. Refresh usage and local runtime state; retain the 3% usage reserve. Unknown all usage forbids execution.
3. A reviewed, existing authorized read channel with a private environment selector. Historical access alone does not prove current capability. If the channel or its mapping to the selected staging database cannot be established, stop. Do not create a tunnel, install a client, search for credentials, change a role or grant, or start a database/service.
4. Reviewed collector bytes, query bytes, private parameter bindings and output validation, each hashed before dispatch. An implementation is not included in this document and no collector is executable yet. Root must review and freeze it before dispatch; it must stay within this packet. Any expansion requires owner review again.
5. A fresh one-use local job ID and an explicit start-by time no more than ten minutes after Root's dispatch. The attempt marker is consumed before connection. An expired or consumed attempt is not reset or retried under the same GO.

The eventual GO permits only bounded read-only environment preflight and the identity query below. Preflight may inspect the existing staging access selector, exact API service identity/active state, serving revision, and database/schema identity through that channel. Retain only their identifiers or hashes locally; never export connection strings, process environments or credentials. It must establish the channel maps to the selected staging database before reading business rows. Missing association, unhealthy service, unknown relevant schema or an incompatible revision stops the attempt. No general host inventory or unrelated database reads are included.

## Collection limits

- One attempt and one target session, at most five minutes overall; connection establishment at most five seconds. No retries or parallel target work.
- One read-only, repeatable-read transaction; five-second statement timeout, one-second lock timeout and ten-second idle-in-transaction timeout. Always roll back and close, including after failure. Never kill another session to obtain access.
- One parameterized business SELECT below, at most two returned rows as a defensive cap. The expected cardinality is exactly one. No follow-up discovery query after an empty/mismatched result.
- SQL result payload at most 8 KiB and total retained collector output at most 64 KiB. Each identity string at most 128 UTF-8 bytes and each status at most 32 bytes. Enforce byte limits before persistence; an exceeded bound stops and records only a sanitized error. No truncated output counts as evidence.
- No `FOR UPDATE`, advisory lock, `EXPLAIN ANALYZE`, writes, stored procedure, source/snapshot read, analyze/generate/enqueue, provider call or application authentication flow. Ordinary database read locks and normal access logs may occur; this is not a claim of zero operational footprint.

## Reviewed query contract

Local schema reference: `src/postgres/schema.sql` and `src/postgres/pine-bridge-schema.sql` at revision `5e06d16ec6a1379f10f0c6cbd1e87276bbd6a620`. `users.id` and `pine_deployments.deployment_id` are TEXT primary keys. The two user joins are therefore single-row lookups. Deployment owner and Bot fields reference `users.id`. These local facts do not certify target schema: preflight must confirm compatible tables, columns and primary-key guarantees without altering them.

Parameters are the privately pinned `$1=deployment_id`, `$2=bot_id`, `$3=pine_import_id`, `$4=source_version`. No owner parameter is supplied or guessed. Source version is a positive integer; identity parameters must equal the frozen four-field record exactly.

```sql
BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '10s';

SELECT
    transaction_timestamp() AS observed_at,
    current_setting('transaction_read_only') AS transaction_read_only,
    d.deployment_id,
    d.bot_id,
    d.pine_import_id,
    d.source_version,
    d.owner_id AS deployment_owner_id,
    b.id AS observed_bot_id,
    b.parent_user_id AS bot_parent_user_id,
    b.role AS bot_role,
    b.status AS bot_status,
    o.id AS observed_owner_id,
    o.status AS owner_status,
    (o.parent_user_id IS NULL) AS owner_is_root
FROM public.pine_deployments AS d
LEFT JOIN public.users AS b ON b.id = d.bot_id
LEFT JOIN public.users AS o ON o.id = d.owner_id
WHERE d.deployment_id = $1::text
  AND d.bot_id = $2::text
  AND d.pine_import_id = $3::text
  AND d.source_version = $4::integer
LIMIT 2;

ROLLBACK;
```

The SELECT must use driver parameters, never shell or SQL string interpolation. The collector checks the row before treating the owner as a candidate: exactly one complete row; transaction read-only is `on`; all four deployment fields equal the frozen parameters; `observed_bot_id` equals the selected Bot; `deployment_owner_id`, `bot_parent_user_id` and `observed_owner_id` are the same nonempty UUID; Bot role is `BOT`; owner and Bot statuses are `ACTIVE`; `owner_is_root` is true. A null Bot parent is a stop for this selected child Bot, not permission to substitute a different ownership rule. UUID shape validation does not replace relation checks or authorization. Source ownership, exact revision existence and membership remain part of later applicability checks, outside this minimal owner discovery query.

Empty, duplicate, malformed, unauthorized, timeout, transport failure, schema drift or relationship/status mismatch produces STOP/UNKNOWN or MISMATCH as appropriate. Do not widen predicates, retrieve other accounts, repair data, change permissions or try the application API as a fallback. The query intentionally does not read deployment state, source text, membership, analysis, snapshot, selections, job results, funding, trades, secrets or private research data.

## Evidence and acceptance

Before the attempt, preserve a local manifest containing packet version/hash, collector/query hashes, private binding hash, owner GO reference, one-use job ID, dispatch/start-by time, limits and the designated operations worker. A single completion receipt must bind that same job ID, collector/query/binding hashes, environment attestation, observed target revision/schema, UTC start/end, transport exit, transaction completion/rollback status, row count, exact retained output SHA-256 and validation verdict. Record failure without raw credentials or unbounded stderr. This closes the historical split-record provenance weakness without claiming cryptographic proof of remote execution.

Keep the full tuple and raw identity result in ignored local evidence only. Tracked evidence may contain hashes, dates, counts and sanitized verdicts, never account IDs or machine locations. An independent reviewer checks the manifest/receipt/output linkage and row relations; Root decides acceptance. No worker accepts its own result.

A successful result is **OWNER_IDENTITY_OBSERVED_AT_ONE_SNAPSHOT** only. It neither proves the requesting human owns the database account nor authorizes account access beyond this GO. It does not run proposal, membership, generate-provenance or selection applicability checks. Those remain `UNKNOWN_NOT_QUERIED`; the existing applicability packet must be reconciled with the observed tuple and applicable authority before any later execution. Do not continue automatically to that packet under this GO.

## Owner review and GO wording

Suggested approval after reviewing this packet:

> GO S6-OWNER-ID-RO-1 for the selected Staging QL-P2 Prototype four-field binding, using only the existing authorized channel. One bounded read-only environment preflight and owner identity query; one attempt, maximum five minutes. Stop on any gap or mismatch. Do not continue into applicability or change the target. Keep all existing gates.

This approval would permit the bounded attempt only after the pre-dispatch checks above pass. It does not waive an unavailable channel or unresolved target binding. No GO is recorded by this document.

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; P13j/N1 HELD. No deployment, target route activation, migrations, service/config/role changes, native compilation, process fixtures, database/C3 runtime start, Live, guard reset, Best Inputs apply, optimizer, holdout or new research phase. The accepted local input lock remains unchanged.
