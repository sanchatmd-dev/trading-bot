# S6 Staging QL-P2 owner identity read-only packet, second attempt

Packet ID: **S6-OWNER-ID-RO-2**. Status: **PREPARED FOR OWNER REVIEW; NOT RUN; NO EXECUTION GO; PRECONDITION: S6-API-SERVICE-START-1 VERIFIED_RUNNING**.

> This packet is a read-only identity read on the owner's staging host and database. It writes nothing and changes no service. It grants no access by itself. Execution requires an owner GO that names **S6-OWNER-ID-RO-2** and Staging QL-P2 Prototype, a recorded **VERIFIED_RUNNING** result from S6-API-SERVICE-START-1, a newly built and independently reviewed collector and runner, and Root admission. No collector, runner, manifest, marker or job ID for this packet exists yet.

## Why this packet exists

[S6-OWNER-ID-RO-1](S6_QL_P2_OWNER_ID_READONLY_PACKET_2026-10-23.md) ran once under its own owner GO. Its [result](S6_QL_P2_OWNER_ID_READONLY_RESULT_2026-10-24.md) is **STOP_UNKNOWN - API_SERVICE_MISMATCH**: the service guard stopped the collector before any artifact check, database client construction, connection or SQL. That attempt, its job ID, its marker and its evidence are consumed and immutable.

The follow-up diagnostic [S6-API-SERVICE-RO-1](S6_API_SERVICE_MISMATCH_READONLY_RESULT_2026-10-24.md) then observed the exact bound API user service as `loaded` but `inactive`/`dead`, with a failing main-PID shape, a passing reload flag and a passing fragment identity. Root accepted that record as a diagnostic observation only.

[S6-API-SERVICE-START-1](S6_API_SERVICE_START_PACKET_2026-10-24.md) proposes one start of that unit. Its "What remains afterwards" section names a new, separate read-only owner-ID packet as the only next step after **VERIFIED_RUNNING**. This document is that packet. It is a new attempt with its own identifiers, not a retry, reset or continuation of S6-OWNER-ID-RO-1.

## Precondition

Root admits this packet only when all of the following hold:

1. **Start result recorded.** A tracked S6-API-SERVICE-START-1 result record exists, and its terminal verdict is **VERIFIED_RUNNING**.
2. **Start result reviewed and accepted.** An independent reviewer verified that record's receipt linkage, and Root accepted it as an observation record.
3. **No later contradicting fact.** Root knows of no owner report or later record that the service was stopped, restarted, reconfigured or redeployed after that result. If Root knows of one, Root stops and reports it before dispatch.

Any other START-1 outcome means the precondition fails and Root dispatches nothing under this packet. This includes NOT_RUNNING_AFTER_START, NOT_VERIFIED_WITHIN_BOUND, UNKNOWN, NOT_STARTED_LINGER_OFF and NOT_STARTED_PRECHECK_STOP.

One case needs an owner decision. START-1 says that if its pre-check finds the service already running, the next step is the owner-ID packet. This revision does not cover that case: its precondition names VERIFIED_RUNNING only. If that case occurs, Root reports it to the owner. Root dispatches only after an amended and reviewed revision of this packet and an owner GO that names it.

VERIFIED_RUNNING is an observation inside the START-1 session only. It does not attest that the service is still running when this packet runs. The service guard in this packet re-checks the service at that time and is the only service-state check. Stages 3 to 7 can also stop the read.

## Owner GO and the pre-authorization note

Root's ignored local record of the S6-API-SERVICE-RO-1 owner GO also records an owner statement to proceed to the next GO without waiting for a further owner turn. That recorded owner wording names S6-API-SERVICE-RO-1 only. It does not name **S6-OWNER-ID-RO-2**. The next GO after S6-API-SERVICE-RO-1 was S6-API-SERVICE-START-1, which needs its own explicit owner GO. The recorded statement is also older than the 24-hour freshness window at any realistic dispatch of this packet.

Therefore the recorded pre-authorization **does not authorize this packet and does not satisfy admission item 1**. Root's earlier interpretation of that statement, that the next read-only packet may be executed once it passes review and admission, does not apply to this packet. This document does not itself record a GO.

Execution of this packet requires a fresh owner GO with these properties:

- The owner wording names **S6-OWNER-ID-RO-2** (this packet) and Staging QL-P2 Prototype. A general instruction to continue, or a GO for another packet, does not name this packet.
- The owner may name S6-API-SERVICE-START-1 and S6-OWNER-ID-RO-2 in one message. In that case, RO-2 still waits for a recorded and accepted START-1 **VERIFIED_RUNNING** result, as described under Precondition. A combined message never turns a failed or unsettled START-1 outcome into a pass.
- GO freshness runs from the timestamp of the owner wording that names this packet, not from any earlier statement or from Root's record of it.
- The GO does not waive the build, the independent review, the synthetic checks, the manifest, the usage reserve or any admission item below.
- The S6-API-SERVICE-START-1 GO, the S6-API-SERVICE-RO-1 GO, the consumed S6-OWNER-ID-RO-1 GO and the recorded pre-authorization do not authorize this packet on their own.
- The GO covers this read-only attempt only. It never covers a start, restart, stop, repair, log read, applicability read or any write.

## Purpose and boundary

The purpose is unchanged from S6-OWNER-ID-RO-1. Discover the `owner_id` for the single deployment that the owner selected, and verify its relationship to the selected Bot, at one snapshot. This is a prerequisite to the [applicability readback](S6_APPLICABILITY_READBACK_PACKET_2026-10-23.md), not execution of it. A known owner is not a precondition of this discovery query. Matching database relationships do not establish that the operator is authorized; the owner GO authorizes this exact read separately.

The private binding record holds the complete four-field tuple (Bot, import, source version and deployment) for Staging QL-P2 / SPT Prototype Paper 2026-10-03. It must not identify old QL-3A or the earlier staging clone. The tuple is the same tuple that S6-OWNER-ID-RO-1 froze. The RO-2 binding is a new local copy in the RO-2 directory, and Root verifies that its four fields equal the RO-1 fields before admission. Keep identifiers and access selectors in ignored local storage only. Never select the latest deployment, infer an owner from another Bot, or combine snapshot identities with database row identities.

## Session stages

The stages and their order are unchanged from the reviewed S6-OWNER-ID-RO-1 collector. One designated operations worker runs the collector once, in one SSH session over the existing frozen channel.

1. **Binding check.** Validate the frozen four-field binding before any host read.
2. **Service guard.** One property query of the exact bound unit, evaluated with the five unchanged predicates below.
3. **Serving-process association.** Read-only checks that the main process of the guarded service runs from the frozen working directory with the frozen argument vector.
4. **Scoped artifact association.** Hash the expected artifact files and compare them with the frozen pins. This supports scoped artifact association only, not a full loaded-revision attestation.
5. **Database channel.** Obtain the existing database connection string from the guarded service's process environment or from its declared environment files, under the RO-1 rule that a declared file must not have changed after the process started. A declared environment file means an `--env-file=` argument in the frozen argument vector only, as in RO-1. The collector reads no systemd `EnvironmentFiles` property and no unit file. Hold the string in memory only and discard it after client construction. Discard means that the collector keeps no reference to the string and never persists it; it is not memory erasure. Never retain, print or hash it into evidence.
6. **Database identity and schema.** Connect, open the read-only transaction, check database identity against the frozen identity, and check the relevant tables, columns, types and primary keys.
7. **Stability re-check.** Confirm that the environment files, working directory, argument vector and artifact hashes did not change during the session.
8. **Identity read.** Run the one bounded business SELECT, validate the row, then roll back and close.

Stages 3 and 5 read the service process's metadata, environment and declared environment files in memory, exactly as the RO-1 scope reviewed and pinned. No other process, user, unit or host data is read. Any failure at any stage stops the attempt with a sanitized reason code. A later stage never runs after an earlier stage stops.

## Service guard

The five guard predicates are **unchanged** from the RO-1 collector and from the S6-API-SERVICE-RO-1 diagnostic:

| Predicate | Exact comparison |
| --- | --- |
| Active state | `ActiveState === 'active'` |
| Substate | `SubState === 'running'` |
| Reload flag | `NeedDaemonReload === 'no'` |
| Main PID shape | `/^[1-9]\d*$/.test(MainPID)` |
| Fragment identity | `FragmentPath === expectedFragmentPath` |

The comparisons are not normalized, relaxed or replaced. The guard passes only when all five predicates pass.

Two additions from the reviewed diagnostic and start packets can only stop the attempt, never let it pass:

- The property query carries `--all --no-pager`, so that an empty value keeps its key and a missing key stays distinct from an empty one.
- The query also requests `Id`, and `Id` must equal the bound unit exactly. A mismatch stops the attempt with `API_SERVICE_UNKNOWN`. It is never permission to try another name.

The query also keeps the RO-1 `ExecMainStartTimestamp` property, which stage 5 needs. The parser follows the S6-API-SERVICE-RO-1 rules: exactly the requested keys, each once; valid UTF-8; no NULs; per-value byte bounds; lowercase identifier tokens of at most 32 bytes for state labels; one to twenty decimal digits for the main PID. `ExecMainStartTimestamp` follows the strict S6-API-SERVICE-START-1 rule: either empty, or exactly the form `Day YYYY-MM-DD HH:MM:SS UTC`. The loose `Date.parse` that RO-1 used is not allowed. The remote environment fixes `LC_ALL=C` and `TZ=UTC` for the property query, as in S6-API-SERVICE-START-1, and the synthetic checks assert that the payload sets both. A non-UTC or empty value stops at stage 5 only and does not hide the guard vector. The value has second precision; the "declared file not changed after start" comparison keeps the conservative direction. A nonzero exit, nonempty stderr, timeout or parse gap stops with `API_SERVICE_UNKNOWN`.

**Predicate vector retention.** The RO-1 sanitized STOP did not say which predicate failed. This packet evaluates all five predicates from the same validated response and keeps the complete PASS/FAIL vector, plus the allowlisted state labels from the diagnostic packet, in the sanitized output. The raw PID, unit name and fragment path are never retained.

### What a NOT-running guard result means

If one or more guard predicates fail, the verdict is **STOP_UNKNOWN** with code **API_SERVICE_MISMATCH** and the complete failed-predicate list. The meaning is narrow:

- At this observation, the exact bound service was not in the state that the guard requires. The service may have stopped, failed or restarted after the START-1 session, or it may be in a transition.
- The collector stops at once. It builds no database client, opens no connection and runs no SQL. Rollback and close are recorded as `NOT_STARTED`.
- The attempt is consumed. There is no retry, second property read, reset or fallback under this GO.
- **No start.** This packet never starts, restarts, stops, reloads or repairs the service, and never reads logs or the journal. S6-API-SERVICE-START-1 is consumed and is not reused or re-run. Any further start needs its own new start packet and an owner GO that names it. Any further owner-ID attempt needs its own new packet and an owner GO that names it.
- The result does not change the recorded START-1 verdict. VERIFIED_RUNNING stays a valid observation of the START-1 session. It never attested later uptime.
- Root reports the failed-predicate list to the owner at once. If the pattern suggests that the service stopped again, Root reminds the owner of the stopper and session-independence answers given under START-1 checklist items 7 and 9.

Owner ID stays **UNKNOWN** and applicability stays **UNKNOWN_NOT_QUERIED** after this result.

## Collection limits

The limits are unchanged from S6-OWNER-ID-RO-1:

- One attempt and one target session, at most five minutes overall; connection establishment at most five seconds. No retries or parallel target work.
- The reviewed RO-1 runner and collector limits are maxima for RO-2. A build may tighten them but never loosen them: local overall cutoff at most 70 seconds; a remote `timeout --signal=TERM --kill-after=1s` wrapper of at most 60 seconds around `bash -s`; a collector internal deadline of at most 45 seconds, checked before every query together with the runner-supplied deadline; and at most five seconds for each `systemctl` call and for the database connect, each query and the close. A local kill of the SSH client does not by itself bound the remote process or its database session; the remote wrapper and the collector deadline do.
- The SSH argument vector keeps every option of the reviewed RO-1 `sshArgs` vector, copied by value; the vector must be equal to it. No option is removed or relaxed. This includes `-F NUL`, `IdentitiesOnly=yes`, `PreferredAuthentications=publickey`, `BatchMode=yes`, `ConnectionAttempts=1`, `ConnectTimeout=5`, `StrictHostKeyChecking=yes`, `UpdateHostKeys=no`, `ControlMaster=no`, `ControlPath=none`, `ClearAllForwardings=yes`, `PermitLocalCommand=no`, `ProxyCommand=none`, `ProxyJump=none`, `GlobalKnownHostsFile=NUL`, the pinned `HostKeyAlgorithms` and `HostKeyAlias`, the pinned `UserKnownHostsFile`, and `ServerAliveInterval=10` with `ServerAliveCountMax=1`. The only permitted difference is that the known-hosts path points to the RO-2 copy of the pin file.
- One read-only, repeatable-read transaction. Statement timeout five seconds, lock timeout one second, idle-in-transaction timeout ten seconds. Always roll back and close, including after failure. Never kill another session to obtain access.
- One parameterized business SELECT, at most two returned rows as a defensive cap. The expected cardinality is exactly one. No follow-up discovery query after an empty or mismatched result.
- SQL result payload at most 8 KiB and total retained collector output at most 64 KiB. Each identity string at most 128 UTF-8 bytes and each status at most 32 bytes. Enforce byte limits before persistence. An exceeded bound stops and records only a sanitized error. No truncated output counts as evidence.
- Start-by time at most ten minutes after Root's dispatch. Clock-skew allowance for remote and local timestamp linkage is five seconds; this is not a claim of synchronized clocks.
- No `FOR UPDATE`, advisory lock, `EXPLAIN ANALYZE`, writes, stored procedure, source or snapshot read, analyze/generate/enqueue, provider call or application authentication flow. Ordinary database read locks and normal access logs may occur; this is not a claim of zero operational footprint.

## Reviewed query contract

The query contract is unchanged from S6-OWNER-ID-RO-1. Local schema reference: `src/postgres/schema.sql` and `src/postgres/pine-bridge-schema.sql` at revision `5e06d16ec6a1379f10f0c6cbd1e87276bbd6a620`. `users.id` and `pine_deployments.deployment_id` are TEXT primary keys, so the two user joins are single-row lookups. These local facts do not certify the target schema; stage 6 confirms compatible tables, columns and primary-key guarantees without altering them.

Parameters are the privately pinned `$1=deployment_id`, `$2=bot_id`, `$3=pine_import_id`, `$4=source_version`. No owner parameter is supplied or guessed. Source version is a positive integer. The identity parameters must equal the frozen four-field record exactly.

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

The SELECT uses driver parameters, never shell or SQL string interpolation. The collector checks the row before it treats the owner as a candidate:

- exactly one complete row;
- `transaction_read_only` is `on`;
- all four deployment fields equal the frozen parameters;
- `observed_bot_id` equals the selected Bot;
- `deployment_owner_id`, `bot_parent_user_id` and `observed_owner_id` are the same nonempty UUID;
- Bot role is `BOT`; owner and Bot statuses are `ACTIVE`;
- `owner_is_root` is true.

A null Bot parent is a stop for this selected child Bot, not permission to substitute a different ownership rule. UUID shape validation does not replace relation checks or authorization. Source ownership, exact revision existence and membership remain part of the later applicability checks.

An empty, duplicate, malformed, unauthorized, timed-out, transport-failed, schema-drifted or relation/status-mismatched result produces STOP_UNKNOWN or MISMATCH as appropriate. Do not widen predicates, retrieve other accounts, repair data, change permissions or try the application API as a fallback. The query does not read deployment state, source text, membership, analysis, snapshot, selections, job results, funding, trades, secrets or private research data.

## Lessons applied from the earlier attempts

These changes come from the S6-OWNER-ID-RO-1 result and the S6-API-SERVICE-RO-1 review and result. None of them widens the read.

1. **New one-use identifiers.** RO-2 uses a new execution directory under `.qa-local/`, a new job ID, a new packet-specific exclusive marker, a new one-use manifest and a fresh random 16-byte nonce for the attempt. The manifest's execution directory must resolve to the directory the runner runs in, and the runner refuses to start otherwise. The runner consumes the marker with an exclusive create before any connection.
2. **No reuse of the consumed attempt.** The RO-1 directory, its consumed marker, job ID, manifest, receipt and output are never reused, reset, renamed, moved or deleted. The same holds for the S6-API-SERVICE-RO-1 and S6-API-SERVICE-START-1 files. Reviewed RO-1 helper code may be copied by value into the RO-2 directory and reviewed there. The public known-hosts pin file is also copied by value into the RO-2 directory, and the manifest pins the hash of that copy. The RO-2 runner and collector must not import, spawn or read any file under the RO-1 or diagnostic directories, code or data. A static test checks this.
3. **Receipt-hash privacy.** Tracked evidence never contains a hash of selector-bearing data. That includes the private binding file, the four-field tuple, the owner, Bot or deployment IDs, the retained raw output, the SQL parameter values, the database identity row, the unit name, fragment path, working directory, argument vector, environment-file paths and contents, the host-key file, and any collector, payload or command that embeds a selector. Those hashes stay in ignored local evidence. Tracked hashes cover only non-private bytes: this packet, the sanitized output envelope and the local receipt. The receipt may be hashed in tracked evidence only because it carries the secret per-attempt nonce, so its hash cannot serve as a guessing oracle. The sanitized envelope carries no plain selector digests. The RO-1 result record pinned the hashes of its binding file and its retained output; that record stays unchanged as history, and RO-2 does not repeat that pattern.

   This argument holds only while the nonce stays secret. The nonce appears only in the ignored manifest, the ignored receipt, the payload sent to the collector and the ignored retained raw output. It never appears in the sanitized envelope, the runner's console line, any tracked record, a commit or a chat report. The synthetic checks assert that the nonce is absent from the sanitized envelope and from the console line.
4. **Stream error listeners.** The runner attaches error listeners to the SSH child and to its stdin, stdout and stderr streams before it writes the payload. The RO-1 runner attached them to the child and stdin only. A stream error settles once into a sanitized STOP_UNKNOWN with an allowlisted transport reason, never into an unhandled exception. One settlement function handles every terminal path, clears the timer and ignores late events.
5. **Post-marker STOP receipt.** After the marker is consumed, every exit path writes exactly one sanitized receipt bound to the job ID, manifest hash and nonce before the runner exits. This covers spawn failure, a thrown exception, an output or retention limit, a local cutoff, an overall-limit breach and a failed output write. In the RO-1 runner, a failure between marker creation and receipt write could exit without a receipt. If the receipt write itself fails, the runner prints one fixed sanitized line and Root treats the attempt as UNKNOWN. The marker is never removed.
6. **Reviewed collector build after GO.** The collector and runner are built only after an owner GO that names this packet, in the new RO-2 directory, and are reviewed before admission. No collector exists at preparation. Building does not admit execution; dispatch also needs the precondition and every admission item.
7. **Simulated termination checks.** Timeout, cutoff and termination paths are checked by deterministic in-process simulation with injected transport and timer adapters, as in S6-API-SERVICE-RO-1. There is no subprocess, native or process-fixture testing. Real local kill and reaping behavior stays unverified, and the receipt and report say so.

## Admission items

Before any target connection, Root verifies all of the following:

1. **Owner GO.** A fresh owner GO, in owner wording, names **S6-OWNER-ID-RO-2** and Staging QL-P2 Prototype. The recorded pre-authorization given with the S6-API-SERVICE-RO-1 GO does not satisfy this item. No earlier GO, job ID or consumed marker is reused.
2. **Precondition.** The START-1 VERIFIED_RUNNING record exists and is accepted, as described under Precondition. This holds also when the owner named START-1 and RO-2 in one message.
3. **GO freshness.** Freshness runs from the timestamp of the owner wording that names this packet. If more than 24 hours pass between that wording and dispatch, Root asks the owner to re-confirm before dispatch.
4. **Frozen channel and binding.** The existing SSH endpoint, user, port, host-key pin, identity-file selector, expected unit, expected fragment, working directory, argument vector, artifact pins and database identity remain frozen and locally verifiable. Strict host-key checking stays on. The SSH argument vector and the limits match the Collection limits section. No config, alias, proxy, multiplexing, forwarding or credential fallback; no new tunnel or channel; no credential search. If the channel is unavailable or ambiguous, stop before connection.
5. **New collector and runner.** Built in the new RO-2 directory and reviewed by the panel below. They contain no write statement and no service-control command.
6. **Synthetic checks.** Isolated fixtures and injected adapters, never target calls, cover at least: each guard predicate failing alone and together; `Id` mismatch; missing, duplicate and extra keys; empty versus missing values; each later stage's stop code; row validation cases (empty, two rows, field mismatch, owner relation mismatch, null Bot parent, wrong role or status, read-only flag not `on`); byte limits; stream errors on each of stdin, stdout and stderr; every post-marker exit path writing exactly one receipt; a failed receipt write; consumed, expired and wrong-directory attempts; nonce or framing mismatch; nonce absence from the sanitized envelope and the console line; a non-UTC or empty `ExecMainStartTimestamp`; no mismatched row in retained output; the SSH argument vector equal to the RO-1 vector except the known-hosts path; no read of any file under the RO-1 or diagnostic directories; and absence of any write, retry, start, stop or downstream action.
7. **Manifest.** An immutable one-use manifest pins this packet, the collector, the runner, the binding, the known-hosts pin copy, the SSH arguments, the query bytes and the limits. It carries the owner GO reference, the precondition record reference, the job ID, the dispatch time and a start-by time at most ten minutes later.
8. **Usage and runtime.** Root refreshes usage and local runtime state, keeps the 3% usage reserve and dispatches only the designated operations worker, alone, outside any parallel fan-out. Unknown all usage prohibits execution.
9. **Single RO-2 attempt.** The exclusive marker is per directory, so Root also checks that no other manifest or marker naming S6-OWNER-ID-RO-2 exists anywhere under `.qa-local/`. If one exists, Root stops and reports it. Under one owner GO there is at most one RO-2 directory and one attempt.

## Review panel

This is a host-adjacent GO packet. Before an owner GO is requested, an adversarial review of this draft runs and Root records a preparation evidence record that pins this packet's exact bytes and its review history.

After the GO and before admission, the collector and runner are reviewed by an independent tester and an Opus architecture auditor, plus a second-opinion reviewer. Fable 5.1 is paused by the owner, so an Opus or Sonnet substitute fills the second-opinion slot, and the review record names the substitute model. After the attempt, an independent reviewer verifies the receipt linkage, the stage reached, the guard vector and the row relations. No reviewer grants acceptance; Root decides.

## Outcomes

| Outcome | Meaning | Next step |
| --- | --- | --- |
| OWNER_IDENTITY_OBSERVED_AT_ONE_SNAPSHOT | One valid row; all relation and status checks passed. | Report. The applicability readback must be reconciled with the observed tuple and proposed for its own GO. Do not continue automatically. |
| MISMATCH | A complete row failed a relation or status check. | Stop and report. No widened or follow-up query. |
| STOP_UNKNOWN - API_SERVICE_MISMATCH | Guard failed; service not in the required state. | Stop. No start. See the guard section above. |
| STOP_UNKNOWN - other code | Any other stage gap, transport failure, limit or parse gap. | Stop and report the sanitized code. No retry. |
| UNKNOWN | Receipt missing or unwritable, or termination not confirmed. | Treat the target state as unknown; any further contact needs its own packet and GO. |

A successful result means only that the owner identity was observed at one snapshot. It does not prove that the requesting human owns the database account, and it authorizes no account access beyond this GO. Proposal, membership, generate-provenance and selection applicability checks stay **UNKNOWN_NOT_QUERIED**.

## Evidence and acceptance

Before the attempt, Root preserves the local manifest. One completion receipt, kept as ignored local evidence, binds:

- the packet hash, job ID, nonce and owner GO reference;
- the precondition record reference;
- the manifest, collector, runner, query, binding and payload hashes;
- the UTC start and end times and monotonic elapsed time;
- the transport exit, stream-error flags and output byte counts;
- the stage reached, the guard predicate vector and labels;
- the environment, revision-association and schema attestation results;
- the transaction and rollback status and the row count;
- the hash of the retained output and of the sanitized envelope;
- the termination status and the terminal verdict.

Keep the full tuple and raw identity result in ignored local evidence only. A mismatched row is never retained, in ignored or tracked evidence. As in RO-1, the retained output keeps no row on any failure, including MISMATCH; it keeps only the sanitized stop or mismatch code. The tracked result record follows the receipt-hash privacy rule above. It may contain dates, counts, the guard vector, sanitized labels and verdicts, the packet hash, the sanitized envelope hash and the receipt hash. It never contains account IDs, machine locations or hashes of selector-bearing data. Hash linkage supports the recorded local execution chain, not cryptographic remote attestation. No worker accepts its own result.

## Residual risks

These risks remain after every control in this packet. They are accepted and named, not removed.

- **Database client module.** The collector loads the `pg` module from the guarded service's working directory, as in RO-1. The artifact pins cover the expected artifact files only, not that module. The "cannot write the database" claim therefore covers the collector's fixed statements inside a READ ONLY transaction, on the condition that the loaded module is the same benign code that the service runs.
- **Connection string in memory.** After client construction, the `pg` client keeps the connection string internally. The collector keeps no reference and persists nothing, but the string stays in process memory until the remote process ends.
- **SSH session and logout.** RO-2 opens and closes its own SSH session. The claim that RO-2 cannot change the service depends on user lingering staying enabled, as recorded under START-1 checklist item 7, so that logout does not stop the user manager. RO-2 does not re-read the linger setting, by design.
- **No re-confirmation of guard state at stage 7.** Stage 7 re-reads the environment files, working directory, argument vector and artifact hashes, but not MainPID or the guard predicates, as in RO-1. That re-read gives only partial protection against a restart during the session. No second property read is added.
- **Real termination behavior.** Real local kill and reaping behavior stays unverified, as stated under Lessons item 7.

## Explicit exclusions

- No database writes, DDL, role or grant change, data repair or second business query.
- No start, restart, stop, reload, daemon-reload, enable, disable, reset-failed, linger change or service repair. The service is left in whatever state it is in. A stop after this read, if the owner wants one, is the owner's own action through the stopper named under START-1 checklist item 9, outside this packet.
- No logs, journal, `systemctl status`, `systemctl cat`, unit-file contents, service discovery or host inventory. No process reads beyond the stage 3 and stage 5 reads of the guarded main process.
- No application API call or authentication flow. No source, snapshot, private Pine or research data.
- Do not run, retry or reset S6-OWNER-ID-RO-1, S6-API-SERVICE-RO-1 or S6-API-SERVICE-START-1. Do not continue into applicability. Do not change the local input lock or weaken any security guard.

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; P13j/N1 HELD. No deployment, target route activation, migrations, service, config or role changes, native compilation, process fixtures, database or C3 runtime start, Live, guard reset, Best Inputs apply, optimizer, holdout or new research phase.

## Suggested owner approval

> GO S6-OWNER-ID-RO-2 for the selected Staging QL-P2 Prototype four-field binding only, after S6-API-SERVICE-START-1 has a recorded and accepted VERIFIED_RUNNING result. Build and independently review a new collector and runner first; real kill and reaping behavior stays unverified. Then make one read-only attempt in one session over the frozen channel, maximum five minutes: the unchanged service guard, the reviewed association and schema checks, and one bounded owner identity SELECT in a read-only transaction that is rolled back. If the service guard fails, stop; do not start or touch the service. No retry, write, log read, applicability continuation or service change. Do not reuse the consumed S6-OWNER-ID-RO-1 attempt. Keep all existing gates.

This wording may be sent alone or in the same message as a GO for S6-API-SERVICE-START-1. In either case, freshness runs from this wording's timestamp, and RO-2 waits for the accepted START-1 VERIFIED_RUNNING result. The earlier recorded pre-authorization does not replace this wording.

No such GO is recorded by this preparation.
