# S6 API service mismatch read-only diagnostic packet

Packet ID: **S6-API-SERVICE-RO-1**. Status: **PREPARED FOR OWNER REVIEW; NOT RUN; NO EXECUTION GO**.

Preparation resumed on 24 October 2026 (Bangkok) at the owner's instruction, under the Claude root. Both corrections from the first independent review are applied: the property query carries explicit `--all --no-pager`, and timeout and termination checks use deterministic in-process simulation with injected transport and timer adapters, without opening the held process-fixture scope. The [preparation evidence](evidence/S6_API_SERVICE_MISMATCH_READONLY_PREPARATION_2026-10-24.json) pins the exact bytes of this packet and records the review history, including the narrow independent re-review of these corrections. This packet is for owner review only. It is not an execution GO and does not authorize building the collector or runner.

This packet prepares a new, narrowly scoped diagnostic for the owner to review. It grants no target access. No diagnostic collector or execution manifest exists yet. The consumed S6-OWNER-ID-RO-1 attempt remains immutable and must never be reset or rerun.

## Question and evidence boundary

The [previous attempt](S6_QL_P2_OWNER_ID_READONLY_RESULT_2026-10-24.md) stopped at `API_SERVICE_MISMATCH` before DB construction or SQL. Its sanitized receipt does not identify which part of the service guard failed. The five predicates below come from the pinned collector that produced that receipt.

The proposed read asks: **which of those five predicates fail at a new observation of the exact previously selected API service?** It does not establish the historical root cause. A service may have changed since the first attempt. Even one `systemctl show` response is not an atomic application or database snapshot.

Staging QL-P2 Prototype remains the owner's intended environment. The expected unit, fragment path, existing channel and selected historical four-field tuple are frozen in ignored local bindings. That expected selection is not evidence of current database association, owner identity, serving revision or applicability. No database association check is part of this packet.

## Proposed read

After a new explicit GO, reviewed implementation and Root admission, one designated operations worker may use one SSH session through the existing pinned channel. It may issue **one** `systemctl --user show` query for the exact bound service unit and only these seven properties:

`Id`, `LoadState`, `ActiveState`, `SubState`, `NeedDaemonReload`, `MainPID`, `FragmentPath`.

The conceptual argument vector is `systemctl`, followed by `--user`, `show`, `--all`, `--no-pager`, the exact private unit, and one `-p` argument for each property above. `show` omits properties with empty values by default; `--all` makes it print them, so an empty `FragmentPath` keeps its key and stays distinct from a missing property. `--no-pager` prevents any pager. Neither flag adds a property: the seven `-p` arguments still bound the output. The SSH remote command is the fixed wrapper `timeout --signal=TERM --kill-after=1s 20s bash -s`, and standard input carries one fixed script: the two user-bus exports described below, then `exec` of the property query wrapped in `timeout --signal=TERM --kill-after=1s 5s`. A remote shell is unavoidable over SSH, so the unit is the only interpolated value: it is inserted inside single quotes only after it passes a strict character-set check that admits no shell metacharacters. The full script text and SSH argument list are frozen and hashed in the ignored local manifest. The unit is a validated, single literal argument from the frozen binding; never a wildcard, template expansion, guessed alias or shell-interpolated value. The existing reviewed user-bus bootstrap may derive its runtime directory from the current SSH user's UID; it must not enumerate users, services or hosts, create a bus, or retain the UID. No other host inspection is authorized.

`Id` must equal the bound unit ID before any service diagnosis is accepted. An alias/canonical-ID difference is a stop, not permission to try another name. `LoadState` supplies context only; it does not relax or replace the old guard.

| Predicate | Exact comparison from the old guard | Retained diagnostic |
| --- | --- | --- |
| Active state | `ActiveState === 'active'` | PASS/FAIL; `active`, `inactive`, `failed`, or `OTHER` |
| Substate | `SubState === 'running'` | PASS/FAIL; `running`, `dead`, `failed`, or `OTHER` |
| Reload flag | `NeedDaemonReload === 'no'` | PASS/FAIL; `no` or `yes` |
| Main PID shape | `/^[1-9]\d*$/.test(MainPID)` | PASS/FAIL only; never the raw PID |
| Fragment identity | `FragmentPath === expectedFragmentPath` | PASS/FAIL and empty/nonempty flag; SHA-256 of the returned string in ignored local evidence only; never the raw path |

Evaluate all five predicates from the same validated response and retain every failed predicate. A valid FAIL is the intended diagnostic result; it must not discard the other results or trigger further reads. The comparisons stay unchanged. Do not normalize, resolve or inspect the fragment path, weaken a predicate or substitute another expected value.

## Parsing, privacy and verdicts

The eventual collector must validate output before interpretation or persistence:

- Require exactly the seven requested property keys, each once. Reject missing, duplicate or unexpected keys, malformed lines, invalid UTF-8, embedded NULs or oversized values. Empty `FragmentPath` is a present value, not a missing key. The collector's synthetic checks must show that the parser keeps a present empty key from fixture output and that a missing key still stops as `STOP_UNKNOWN`; they do not verify how the target's systemd formats its output.
- Compare `Id` exactly to the private binding. Retain its match result only. Bound its value to 128 UTF-8 bytes. A mismatch produces `STOP_UNKNOWN` without a service predicate conclusion.
- Bound `ActiveState`, `SubState` and `LoadState` to nonempty lowercase identifier tokens of at most 32 ASCII bytes (`[a-z][a-z0-9_-]*`). Keep only the labels in the table; other valid tokens become `OTHER`. For `LoadState`, retain only `loaded`, `not-found`, `masked`, or `OTHER`. These labels are diagnostics, not a health verdict. Malformed tokens produce `STOP_UNKNOWN`.
- Accept only `yes` or `no` for `NeedDaemonReload`. Accept one to twenty decimal digits for `MainPID`, then apply the original regex without numeric conversion or normalization. Thus PID `0` is a valid FAIL, distinct from malformed or missing PID data.
- Bound `FragmentPath` to 1,024 UTF-8 bytes, allowing an empty string. Compare the string exactly and hash that string only; do not read the file it names. Keep that digest in ignored local evidence, because a plain hash of a guessable path can be reversed. Raw IDs, PIDs, fragment paths, stdout and stderr must not be persisted or printed.
- A nonzero command exit, nonempty stderr, timeout, transport failure, output bound violation, identity mismatch or parsing gap produces a sanitized `STOP_UNKNOWN`. Record allowlisted reason codes and byte counts only; do not export raw error text.

With a complete validated response and matching `Id`, at least one failed predicate yields **SERVICE_GUARD_MISMATCH_OBSERVED_AT_NEW_SNAPSHOT**, with the complete failed-predicate list. Five passing predicates yield **NOT_REPRODUCED_AT_NEW_SNAPSHOT**. Both outcomes end the attempt. Neither permits the owner query or certifies health, historical cause, database identity, full revision or applicability. Malformed or unbound output remains **STOP_UNKNOWN** and cannot be converted to a valid mismatch.

The original failed predicate and underlying historical cause remain unknown unless separate evidence establishes them. A new mismatch is not proof that the same condition caused the earlier failure.

## Admission, limits and one-use execution

Before any target connection, Root must verify all of the following:

1. A new owner GO explicitly names **S6-API-SERVICE-RO-1** and Staging QL-P2 Prototype. Approval of this document or an older GO alone is insufficient.
2. The existing SSH endpoint, user, port, exact public host-key pin, existing identity-file selector, expected unit and expected fragment remain frozen and locally verifiable. Keep strict host-key checking, no config/alias/proxy/multiplex fallback and no credential search, key export, new tunnel or new channel. If the authorized channel is unavailable or ambiguous, stop before connection. Local binding is expected identity, not current service or DB attestation.
3. A new diagnostic collector and runner have been built locally and independently reviewed against this packet. They must not invoke the old collector or import a module that can trigger its host/DB path. No executable collector is delivered by this preparation.
4. Focused synthetic checks cover each individual predicate failure, multiple simultaneous failures, all-pass, PID zero versus malformed input, empty versus missing fragment, ID mismatch, duplicate/missing/extra keys, unknown labels, UTF-8/byte limits, sanitized errors, time linkage, consumed/expired attempts and absence of downstream actions. Use isolated fixtures, never target calls. Verify timeout, cutoff and termination handling with deterministic in-process simulation: the collector and runner accept injected transport and timer adapters, and the checks drive them with fake clocks and scripted transport events (late output, no exit, output overflow, termination confirmed, termination not confirmed). Passing pure parser or helper tests alone is insufficient; the runner's own timeout and cleanup paths must run through those adapters. These checks grant no subprocess, native or process-fixture testing, which stay held under the exclusions below. Real platform kill and reaping behavior therefore remains unverified, and the completion receipt and final report must say so. If Root judges that real termination qualification is required before execution, stop and request a separately reviewed scope and authority; this packet does not grant it. Root records that judgement in the admission record before dispatch.
5. Root refreshes usage and local runtime state, preserves the 3% usage reserve and dispatches only the designated operations worker, alone. Unknown all usage prohibits execution. No heavy local runtime is needed or authorized.
6. A new directory, collector/runner/command/binding hashes, owner GO reference, fresh job ID and immutable one-use manifest are ready. The start-by time is at most ten minutes after dispatch. Consume a new packet-specific exclusive marker before connection. Preserve the old consumed marker and all old evidence. An expired or consumed attempt is not reset or retried under the same GO.

Proposed limits are one attempt, one SSH session, one property query and **60 seconds overall**, including local termination and evidence handling. Connection establishment is limited to five seconds; the property query to five seconds. Use a remote 20-second deadline with a one-second forced-termination allowance, and a local SSH cutoff at 30 seconds; bounded reaping and receipt handling must finish within the overall limit. Failure to confirm local child termination produces UNKNOWN cleanup and no follow-up target check. Do not kill or signal the selected API service or any unrelated process.

Cap combined query stdout/stderr at 8 KiB before parsing. Cap combined SSH stdout/stderr at 8 KiB before retention, and the sanitized result envelope at 8 KiB. Receipt metadata is separately bounded to 8 KiB. Overflow stops without retaining raw or truncated data. Record actual UTC start/end and monotonic elapsed time; reject inconsistent linkage or elapsed limits. If remote timestamps are retained, enforce a declared maximum five-second clock-skew allowance without claiming synchronized clocks.

Ordinary access logs and bounded observation overhead may occur. This is not a claim of zero operational footprint.

## Explicit exclusions

No DB connection or SQL; no application API/authentication flow; no source, snapshot, private Pine or research data. No `/proc` reads, process arguments, environments, environment files, unit-file contents, artifact contents, `systemctl cat`, `systemctl status`, logs, journal, service discovery or host inventory. No alternate unit, user or endpoint and no second property read.

No restart, start, stop, reload, daemon-reload, enable/disable, repair, configuration or role change; no deployment, target route activation, migration, client installation or service creation. The diagnostic may not signal the API service using its observed PID. Do not run or retry S6-OWNER-ID-RO-1, continue applicability, change the local input lock or weaken any security guard.

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; P13j/N1 HELD. Native compilation, subprocess or process-fixture tests, database/C3 runtime start, Live, guard reset, Best Inputs apply, optimizer and holdout work remain outside scope.

## Evidence, acceptance and owner GO

A single completion receipt must bind this new packet/job, owner GO reference, manifest, collector, runner, command and binding hashes, start/end, monotonic elapsed time, transport and query exit, output byte counts, the hash of the sanitized output envelope, termination status, sanitized field labels, complete predicate vector and terminal verdict. Keep raw identity selectors only in ignored local bindings. Tracked evidence contains hashes, dates, counts and sanitized verdicts; no account identifiers or machine locations. It never contains a hash of raw stdout, stderr, `Id`, PID, fragment path, unit name, or any command or file that embeds a private selector; those hashes stay in ignored local evidence. Tracked hashes cover only sanitized or non-private bytes, such as this packet, the sanitized envelope and the local receipt.

An independent reviewer verifies the receipt linkage, parsing and predicate conclusions. Root accepts only the diagnostic observation or failure record. No worker grants acceptance or a new GO. After any outcome, stop and report; root-cause investigation or repair requires its own review and authority.

Preparation evidence: [S6 API service diagnostic preparation](evidence/S6_API_SERVICE_MISMATCH_READONLY_PREPARATION_2026-10-24.json). Owner ID remains UNKNOWN and applicability remains UNKNOWN_NOT_QUERIED.

Suggested future approval, after owner review:

> GO S6-API-SERVICE-RO-1 for the selected Staging QL-P2 Prototype only. Build and independently verify the diagnostic collector and runner before one read-only service-property attempt, maximum 60 seconds; real kill and reaping behavior stays unverified. Use the frozen existing channel and exact service unit. Stop after the complete bounded diagnostic or on a gap; no retry, DB/SQL, owner-query retry, applicability continuation, repair, deployment or target route activation. Keep all existing gates.

No such execution GO is recorded by this preparation.
