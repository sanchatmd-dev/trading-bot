# S6 API serving-process working directory read-only diagnostic packet

Packet ID: **S6-API-CWD-RO-1**. Status: **PREPARED FOR OWNER REVIEW; NOT RUN; NO EXECUTION GO**. A collector and runner exist as local-only build work done ahead of any owner GO; they have made no target contact.

> This packet proposes one read-only diagnostic on the owner's staging host. It opens no database connection and reads no environment of the service process; the collector reads only its own `HOME` value. It reads no file contents other than the guarded process argument vector, and no logs. The reviewed collector returns enum labels, booleans and linkage values only, never a path, PID or selector, and the local runner rejects the output and retains nothing from it if one appears. It grants no access by itself. Execution requires an owner GO that names **S6-API-CWD-RO-1** and Staging QL-P2 Prototype, a pinned collector and runner whose independent review is complete, and Root admission. A collector and runner were built and reviewed ahead of any owner GO, as local-only work with no target contact. Building them admitted nothing. No manifest, marker or job ID for this packet exists yet.

Prepared on 24 October 2026 (Bangkok) under the Claude root, for owner review only. This is revision 4 of the draft. Revision 2 applied the findings of the first adversarial draft review (verdict FIXES_REQUIRED: no P1, three P2 and eight P3 findings). After revision 2, a collector and runner were built and reviewed ahead of any owner GO, as local-only work: no target contact, no manifest, no marker and no job ID. Revision 3 applied the packet findings of the first build audit (no P1, three P2 and seven P3 findings). The build was then revised once, in build fix round 2, for the code findings of that audit: physical `realpath` through the native call (F1), canonical frame text (F4), strict manifest timestamps (F6), the reviewer probe tests copied into the author suite (F7) and a start-by recheck immediately before the marker (F8). A three-slot panel reviewed that rebuild on its round-2 pins. The independent tester returned PASS (author suite 97 of 97, independent suite 39 of 39, 30 mutants with 21 killed and every survivor equivalent or layered). The Opus architecture auditor returned GO WITH CONDITIONS (no P1, no P2, four P3). A separate Opus 5.5 second-opinion reviewer, the recorded substitute for the paused Fable 5.1, returned GO WITH CONDITIONS (no P1, one P2, ten P3). Revision 4 applies the text items of that panel and of the packet review of revision 3, as ruled by Root; the build stays at its round-2 pins. The build and its review are preparation only. They admitted nothing and are not an execution GO; an owner GO admits execution only. The build stays pinned by hash, and any change to it is a rebuild that needs a new review before admission. A text re-review of revision 4 returned two wording items (no P1 or P2), which Root applied and checked by diff; Root then recorded the preparation evidence.

## Why this packet exists

[S6-OWNER-ID-RO-2](S6_QL_P2_OWNER_ID_READONLY_RO2_PACKET_2026-10-24.md) ran once under its own owner GO. Its [result](S6_QL_P2_OWNER_ID_READONLY_RO2_RESULT_2026-10-24.md) is **STOP_UNKNOWN - API_REVISION_MISMATCH** at stage 3. The service guard passed (`active`/`running`, all five predicates). The check that fired is an exact string comparison: the kernel's answer for the working directory of the guarded main process differs from the frozen expected working directory. The comparison has no normalization, so the sanitized result cannot tell a benign difference from a blocking one. The independent result review recorded this as finding F2 and listed the candidate explanations:

- **Benign for identity:** the frozen path contains a symbolic link that the kernel resolves; the frozen value differs only in form (trailing slash, repeated or dot segments); the unit sets a different working directory, or none, so a user service starts in the home directory; or the application changes directory after start.
- **Blocking for association:** a different release is deployed; the release directory was removed or replaced after the start, so the kernel marks the path as deleted; the main PID is not the expected server process; the release directory was renamed, or a deployment link was swapped to a new release while the process stayed in the old directory (a renamed directory shows its new name, without the deleted suffix); or the frozen binding is stale.

That attempt, its job ID, its marker and its evidence are consumed and immutable. This packet is a new, narrowly scoped diagnostic with its own identifiers. It is not a retry, reset or continuation of S6-OWNER-ID-RO-2, and it does not read owner identity.

## Question and evidence boundary

The proposed read asks one question: **at a new observation of the exact bound API service, how does the working directory of its main process relate to the frozen expected working directory and to the release directory named by the frozen argument vector?**

The answer is a classification label and a fixed set of booleans and enums. It does not establish the historical cause of the RO-2 stop, because the process or the directories may have changed since. The result is a snapshot at attempt time with no continuity link to the process RO-2 observed. `EXACT_EQUAL` means only that the current kernel cwd equals the frozen value. It does not establish why RO-2 differed, because a restart, a move and a change since RO-2 cannot be separated. It does not establish the serving revision, artifact hashes, database channel, database identity, owner ID or applicability. Owner ID stays UNKNOWN and applicability UNKNOWN_NOT_QUERIED.

The classification cannot separate every candidate explanation. A bind mount or other alternate mount path, a directory change by the application after start, and a real directory whose name ends with the kernel's ` (deleted)` suffix all fall into one of the classes below without a distinguishing label. `realpath` does not resolve bind mounts. In particular, `OTHER` is not evidence of a different release.

The expected unit, fragment path, working directory, argument vector, node binary path and channel stay frozen in the ignored local RO-2 binding. This packet copies the needed fields by value into its own ignored binding. A frozen value is expected identity, not evidence of the current host state.

## Precondition

Root admits this packet only when all of the following hold:

1. The S6-OWNER-ID-RO-2 result record exists, its code is `API_REVISION_MISMATCH` at stage 3, and Root accepted it as a stop record.
2. Root knows of no owner report or later record that the service was stopped, restarted, reconfigured or redeployed after that result. If Root knows of one, Root reports it to the owner before dispatch. The owner decides whether this packet still answers a useful question.
3. The fields copied into the new binding are byte-equal to the RO-2 binding fields. Root checks this locally and records only the boolean result.

## Proposed read

After a new explicit GO, reviewed implementation and Root admission, one designated operations worker makes one SSH session through the existing pinned channel. The SSH argument vector is the reviewed RO-2 vector, copied by value. The only permitted differences are two values: the known-hosts path points to this packet's copy of the public pin file, and the remote timeout is 20 seconds instead of 60 seconds. Every other element is byte-equal. The last element, the SSH remote command, is therefore the fixed wrapper `timeout --signal=TERM --kill-after=1s 20s bash -s`.

Standard input carries one fixed script: the reviewed user-bus exports, `export LC_ALL=C TZ=UTC`, then the frozen node binary running one fixed collector from a quoted heredoc. The collector performs these steps, in this order, and nothing else.

### Step 1. Service properties

One `systemctl --user show --all --no-pager` call for the exact bound unit, wrapped in a five-second timeout, with one `-p` argument for each of these eight properties:

`Id`, `LoadState`, `ActiveState`, `SubState`, `NeedDaemonReload`, `MainPID`, `FragmentPath`, `WorkingDirectory`.

The first seven are the S6-API-SERVICE-RO-1 set. `WorkingDirectory` is the only addition. It is a unit property from the same single query, not a file or log read. It is added because it directly separates "the unit sets the directory" from "the process is somewhere else". Reviewers may strike it; the rest of the packet still works without it, and the corresponding enum then reads `NOT_QUERIED`.

Parsing follows S6-API-SERVICE-RO-1 exactly: exactly the requested keys, each once; no missing, duplicate or unexpected key; strict UTF-8; no NUL or carriage return; byte bounds before interpretation. The checks run in this order: parsing, then `Id`, then the guard predicates, then the `WorkingDirectory` form. `Id` must equal the bound unit exactly, or the attempt stops with `ID_MISMATCH`. The five guard predicates are the reviewed RO-1 and RO-2 comparisons, unchanged. An empty `WorkingDirectory` value keeps its key. The `WorkingDirectory` form never stops the attempt; an unexpected or over-long form only sets its label (see Supporting fields).

If any guard predicate fails, the collector reads nothing under `/proc` and inspects no path, and the attempt ends with **SERVICE_GUARD_FAILED_AT_NEW_SNAPSHOT** and the full predicate vector. This is a valid diagnostic outcome, not a reason for further reads.

### Step 2. Kernel working directory and argument vector

With the guard passing, the collector uses the `MainPID` string from the same response:

- `readlink` of `/proc/<MainPID>/cwd`, once. Call the result the kernel cwd. Root confirmed from the RO-2 collector source that this is the same read RO-2 stage 3 made: `readlink` of the `MainPID` cwd link and an exact string comparison with the frozen value.
- One bounded read of `/proc/<MainPID>/cmdline` of at most 16,385 bytes. A read of more than 16,384 bytes stops as `ARGV_LIMIT`. Otherwise the bytes are decoded exactly as the RO-2 collector decodes them: non-fatal UTF-8 (an invalid byte sequence becomes U+FFFD), split on NUL, empty elements dropped. The live digest is the SHA-256 of the RO-2 canonical form `C(argv)`. Below the size limit, the argv boolean therefore predicts the RO-2 stage-3 argv check. `ARGV_LIMIT` does not predict the RO-2 result, because RO-2 read the vector without a size limit.

No other `/proc` entry is read. In particular there is no read of `environ`, `stat`, `status`, `maps`, `fd` or `root`. A `readlink` or read error stops the attempt with `CWD_UNREADABLE` or `ARGV_UNREADABLE` and the retained `errnoClass` (see Verdicts); it never falls through to a classification.

### Step 3. Path metadata

The collector performs exactly these operations in this step, and no others:

- `lstat`, `stat` and `realpath` of the frozen expected working directory;
- `lstat`, `stat` and `realpath` of the frozen release directory, derived locally before contact as described under "Frozen values in the script", unless it is `NOT_DERIVABLE`;
- `realpath` of the collector's own `HOME` value, when that value is set and nonempty. The SSH session user is the user of the user service, so a unit without `WorkingDirectory` starts there;
- `realpath` of the live release directory, derived from the live argument vector by the same rule as the frozen release directory, when exactly one live element qualifies.

The last two paths come from the host. `realpath` follows symbolic links in all four paths. Every `realpath` step resolves physically, as libc `realpath(3)` does: a symbolic link is resolved first, and a following `..` component then applies to the resolved directory. Lexical normalization is never applied before or during resolution, so `link/..` names the parent of the link target, not the directory that holds the link. The two host-derived paths are resolved, compared and discarded; they are never returned or retained. This step opens no regular file and lists no directory. Across the whole collector, the only regular-file read is the bounded read of `/proc/<MainPID>/cmdline`.

A metadata call on a hung network or user-space mount can block inside one synchronous system call. The collector's 10-second internal deadline is checked between steps and cannot interrupt such a call. Only the 20-second remote wrapper and the local SSH cutoff bound it, and the attempt then ends as a transport stop (see Residual risks).

### Step 4. Classification and stability recheck

All comparisons run on the remote side, inside the fixed collector. After classification, the collector repeats the `readlink` of the kernel cwd and the `cmdline` read once, with the same limits. If the link value or the `cmdline` bytes differ from the first read, the attempt stops with `PROCESS_CHANGED` and no classification is retained. The collector then prints one framed result and exits.

## Frozen values in the script

The local runner builds the script from the ignored binding. It uses the reviewed RO-2 embedding: one bound object, serialized with `JSON.stringify` and assigned to a global before the fixed collector source, inside one quoted heredoc. Every embedded value must first pass the check in the table below. The character-set checks keep each path value free of characters that JSON or the shell would need to escape, so the serialized object is the plain value. The quoted heredoc delimiter prevents shell expansion. The runner refuses with `PAYLOAD_DELIMITER` if the collector source or the serialized bound object contains the heredoc delimiter. Every refusal happens before marker consumption.

| Embedded value | Form in the script | Check before embedding |
| --- | --- | --- |
| Packet ID | string in the bound object | equals `S6-API-CWD-RO-1` |
| Unit | string in the bound object | the reviewed unit pattern, at most 128 bytes |
| Expected fragment path | string in the bound object | `^/[A-Za-z0-9_./@-]{0,1023}$` |
| Expected working directory | string in the bound object | `^/[A-Za-z0-9_./@-]{0,1023}$` |
| Frozen release directory | string in the bound object, or the fixed label `NOT_DERIVABLE` | same pattern |
| Argument vector | SHA-256 of `C(argv)`, as lowercase hex | each element nonempty, no NUL, at most 4,096 bytes, at most 64 elements; NUL-joined length with a trailing NUL per element at most 16,384 bytes, else `BINDING_ARGV_LIMIT`; digest `^[a-f0-9]{64}$` |
| Nonce | string in the bound object | `^[a-f0-9]{32}$` |
| Job ID | string in the bound object | `^[a-zA-Z0-9_-]{8,80}$` |
| Manifest hash | string in the bound object | `^[a-f0-9]{64}$` |
| Collector deadline | string in the bound object | strict `YYYY-MM-DDTHH:MM:SS.sssZ` |
| Node binary path | unquoted program path in the wrapper | `^/[A-Za-z0-9_./-]+$`, as in RO-2 |

The path character set admits no space, quote, backslash, dollar sign, backtick, tilde, newline or other shell or JavaScript metacharacter. It does admit repeated slashes, dot segments and a trailing slash, because those form differences are among the questions this packet answers. A frozen path outside the character set produces the refusal `BINDING_CHARSET`; it is never escaped, rewritten or normalized locally. A value that legitimately needs other characters requires a separately reviewed hash-based revision.

The frozen release directory has one derivation rule, which the collector also applies to the live argument vector. An element qualifies when it starts with `/` and ends with `/src/postgres/server.js`. The release directory is the qualifying element with that 23-byte suffix removed, as a plain string operation with no normalization; repeated slashes and dot segments stay as they are. That layout matches the RO-2 artifact names, which are relative to the working directory. If zero or several elements qualify, or the removal leaves an empty string, the frozen release directory is `NOT_DERIVABLE`, and every frozen release-directory field reports `NOT_DERIVABLE` or `null`. This is a recorded label, not a refusal. A derived release directory that fails the path character set produces the refusal `BINDING_CHARSET`.

## Retained output

The collector returns only the keys below. Each classification value is a boolean, `null` or a label from a fixed list. Linkage values must equal the manifest values exactly: packet ID, job ID, manifest hash and nonce. Timestamps must match the strict form `YYYY-MM-DDTHH:MM:SS.sssZ`. The local runner rejects any unexpected or missing key, any value outside its list or rule, and any `/` character in the decoded result body, and turns that into `STOP_UNKNOWN - OUTPUT_SHAPE`. On `OUTPUT_SHAPE` nothing from the result body is retained; only byte counts are kept. Retained output is the canonical serialization (`JSON.stringify`) of the validated object, never the received text. The received frame text must equal that canonical serialization byte for byte. A frame whose text is not canonical, for example one with a duplicate key, stops as `OUTPUT_SHAPE` with nothing retained. So a collector defect cannot carry a path, PID or selector into retained evidence through a checked key.

### Primary class

`cwdClass` takes the first matching label in this order. A `null` comparison never matches.

1. `EXACT_EQUAL`: the kernel cwd equals the frozen expected working directory, byte for byte.
2. `KERNEL_CWD_NOT_ABSOLUTE`: the kernel cwd does not start with `/` (for example an unreachable mount-namespace path).
3. `KERNEL_CWD_DELETED`: the kernel cwd ends with the kernel's ` (deleted)` suffix.
4. `EQUAL_AFTER_RESOLVING_EXPECTED`: `realpath` of the frozen expected working directory succeeds and equals the kernel cwd.
5. `EQUAL_TO_ARGV_RELEASE_DIR`: `realpath` of the frozen release directory succeeds and equals the kernel cwd.
6. `HOME_DIR`: `realpath` of the collector's `HOME` value succeeds and equals the kernel cwd.
7. `FILESYSTEM_ROOT`: the kernel cwd is `/`.
8. `OTHER`: none of the above.

### Supporting fields

These fields are reported for every classified attempt, so a reader never depends on the precedence order alone. Every derived boolean is `null` when any of its inputs is unresolved or `NOT_DERIVABLE`. A `false` value always means two resolved, unequal values.

- `eqExact`, `eqResolvedExpected`, `eqResolvedReleaseDir`, `eqHome`, `eqRoot`, `deletedSuffix`: the individual comparisons behind the class. `eqExact`, `eqRoot` and `deletedSuffix` are always booleans. `eqResolvedExpected` is `null` when the expected directory does not resolve; `eqResolvedReleaseDir` is `null` when the release directory is `NOT_DERIVABLE` or does not resolve; `eqHome` is `null` unless `homeState` is `RESOLVED`.
- `expectedState`: `DIRECTORY`, `SYMLINK_TO_DIRECTORY`, `SYMLINK_DANGLING`, `SYMLINK_LOOP`, `NOT_DIRECTORY`, `NOT_FOUND`, `ACCESS_DENIED` or `STAT_ERROR`. `ELOOP` from any call gives `SYMLINK_LOOP`; `ENOENT` from `lstat` gives `NOT_FOUND`, and from `stat` after a successful `lstat` of a link gives `SYMLINK_DANGLING`; `EACCES` or `EPERM` gives `ACCESS_DENIED`; any other error gives `STAT_ERROR`. `expectedIsSymlink` is the `lstat` symlink bit of the final component, or `null` when `lstat` fails.
- `expectedLexicallyCanonical`: the frozen value equals its own POSIX normal form with no trailing slash. A `false` value marks a form-only difference. This is a lexical test and is always a boolean.
- `expectedResolvesToItself`: `realpath` of the frozen value equals the frozen value; `null` when `realpath` fails. A `false` value with `expectedLexicallyCanonical` true means some component is a symbolic link.
- `releaseDirState`: the same labels as `expectedState`, or `NOT_DERIVABLE`. `releaseDirResolvedEqualsExpectedResolved`: both frozen paths resolve to the same directory; `null` when either does not resolve or the release directory is `NOT_DERIVABLE`. A `false` value means the two frozen values resolve to different directories, so the RO-2 assumption that the working directory is the release root does not hold for the binding.
- `homeState`: `RESOLVED`, `UNSET` (the collector's `HOME` is unset or empty) or `NOT_RESOLVABLE`.
- `deletedBaseEqualsExpected`, `deletedBaseEqualsExpectedResolved`: for a deleted kernel cwd only, whether the path before the suffix equals the frozen value, or what the frozen value resolves to now. Both are `null` for a kernel cwd without the suffix; the second is also `null` when the expected directory does not resolve.
- `relationToExpectedResolved`: the relation of the kernel cwd to the resolved expected directory, compared component by component after splitting both on `/` and dropping empty components. For a deleted kernel cwd the comparison uses the path before the suffix. The labels, in this order, are `SAME` (equal component lists), `ANCESTOR` (the kernel cwd components are a proper prefix of the expected components), `DESCENDANT` (the expected components are a proper prefix of the kernel cwd components), `SIBLING` (both have at least one component, the same parent and different last components) and `UNRELATED`. A plain string prefix test is not permitted, so `/a/b` and `/a/bc` are `SIBLING`, not `ANCESTOR`. The value is `null` when the expected directory does not resolve or the kernel cwd is not absolute.
- `argvEqualFrozen`: the live digest from Step 2 equals the frozen digest.
- `liveReleaseDir`: `EQUAL_KERNEL_CWD`, `NOT_EQUAL_KERNEL_CWD`, `NO_ABSOLUTE_SERVER_SCRIPT_ARG`, `SEVERAL_SERVER_SCRIPT_ARGS`, `NOT_DERIVABLE` (the suffix removal leaves an empty string) or `NOT_RESOLVABLE`. The comparison uses `realpath` of the live release directory and the raw kernel cwd.
- `unitWorkingDirectory`: `UNSET` (empty), `HOME_SPECIFIER` (`~`), `EQUAL_EXPECTED`, `EQUAL_KERNEL_CWD`, `OTHER`, `MALFORMED` or `NOT_QUERIED`. The accepted forms are empty, `~`, an absolute path, and an absolute path with one leading `!` (the systemd "missing is fine" prefix). `unitWorkingDirectoryMissingOk` records the `!` prefix, which is removed once before comparison, and is `null` for the empty and `~` forms. For an absolute path, `EQUAL_EXPECTED` is tested before `EQUAL_KERNEL_CWD`, so the `EXACT_EQUAL` case reads `EQUAL_EXPECTED`. Both tests are raw string comparisons, so a `WorkingDirectory` that names the serving directory through a symbolic link reads `OTHER`. Any other form, including `!~`, `!` alone, a relative path or a value over 1,024 bytes, gives `MALFORMED` and does not stop the attempt. systemd displays a missing-ok home directory (`WorkingDirectory=-~` in the unit file) as `!~`, and this build labels that form `MALFORMED`. The label is supplementary and never affects `cwdClass`, so `MALFORMED` together with `HOME_DIR` may be this form. The result record notes this interpretation. The synthetic checks cover these forms from fixtures only; they do not verify how the target's systemd prints the property.
- The guard predicate vector and the RO-1 labels for `LoadState`, `ActiveState`, `SubState` and `NeedDaemonReload`.

The result also carries the packet ID, job ID, manifest hash and nonce for linkage, and remote UTC start and end times. These linkage values stay in the ignored retained output and receipt and never appear in the sanitized envelope.

## Verdicts

- **CWD_CLASSIFIED_AT_NEW_SNAPSHOT**: the guard passed, `Id` matched, both reads succeeded, the stability recheck matched and the output passed shape validation. The envelope carries `cwdClass` and the supporting fields.
- **SERVICE_GUARD_FAILED_AT_NEW_SNAPSHOT**: `Id` matched and at least one guard predicate failed. No `/proc` read and no path inspection took place.
- **STOP_UNKNOWN** with exactly one code from this list. Raw error text is never retained.
  - Transport and framing, set by the local runner: `TRANSPORT_SPAWN`, `TRANSPORT_CHILD`, `TRANSPORT_STDIN`, `TRANSPORT_STDOUT`, `TRANSPORT_STDERR`, `TRANSPORT_EXIT` (any nonzero exit, including the remote wrapper timeout), `STDERR_NONEMPTY`, `LOCAL_CUTOFF`, `OUTPUT_LIMIT`, `FRAMING_MISMATCH`, `NONCE_MISMATCH`.
  - Collection, set by the collector inside a valid frame: `DEADLINE`, `QUERY_TIMEOUT`, `QUERY_EXIT_NONZERO`, `MALFORMED_ENCODING`, `MALFORMED_LINE`, `MISSING_KEY`, `DUPLICATE_KEY`, `UNEXPECTED_KEY`, `VALUE_LIMIT`, `MALFORMED_TOKEN`, `MALFORMED_PID`, `ID_MISMATCH`, `CWD_UNREADABLE`, `ARGV_UNREADABLE`, `ARGV_LIMIT`, `PROCESS_CHANGED`.
  - Validation, set by the local runner: `OUTPUT_SHAPE`, `CLOCK_ASSOCIATION`, `OVERALL_LIMIT`.
  - Either side: `COLLECTION_UNKNOWN` (any path not named above). The collector may emit it inside a valid frame, for example for an unmapped error, and the local runner may set it for a local path. The receipt has no separate emitting-side field. The side is derived from the receipt: the collector emitted it only when the observed code is `COLLECTION_UNKNOWN` and the observed `stageReached` is a stage number. In every other case, including a diagnostic decision whose envelope or retained-output write failed, the runner set it. The result record states the side derived this way.
  - With `CWD_UNREADABLE` or `ARGV_UNREADABLE`, the retained key `errnoClass` is `ACCESS_DENIED` (`EACCES`, `EPERM`), `NOT_FOUND` (`ENOENT`, `ESRCH`) or `OTHER_ERROR`; with any other code it is `null`. `NOT_FOUND` does not prove that the process is gone, because a mount namespace or a restricted `/proc` can hide an entry.
- **UNKNOWN** with one code: `RECEIPT_UNWRITABLE`, `RECEIPT_LIMIT` or `TERMINATION_UNCONFIRMED`.

Pre-marker refusals are not verdicts of an attempt. They make no target contact and consume no marker: `ARGS_INVALID`, `MANIFEST_UNREADABLE`, `MANIFEST_HASH`, `MANIFEST_PINS`, `MANIFEST_SCOPE` (including the execution-directory check), `MANIFEST_GO`, `MANIFEST_PRECONDITION`, `MANIFEST_JOB`, `MANIFEST_LIMITS`, `MANIFEST_FRESHNESS`, `PIN_MISMATCH`, `BINDING_UNREADABLE`, `BINDING_SHAPE`, `BINDING_UNIT`, `BINDING_CHARSET`, `BINDING_ARGV_LIMIT`, `HOSTKEY_PIN`, `IDENTITY_SELECTOR`, `SSH_VECTOR`, `PAYLOAD_DELIMITER`, `ADMISSION_SCAN`, `MARKER_EXISTS` and `MARKER_WRITE`.

Every verdict ends the attempt. None of them permits an owner query, certifies service health or establishes a historical cause.

## Limits

- One attempt, one SSH session, one property query, **60 seconds overall** from runner start, including admission, local termination and evidence handling. No retry and no parallel target work. The overall clock starts before admission, so the admission scan counts toward the limit. A slow scan that ends before the start-by time leaves less time after the marker, and it can end a consumed attempt as `OVERALL_LIMIT`.
- Connection establishment at most five seconds. Property query at most five seconds. Remote wrapper 20 seconds with a one-second forced-termination allowance. Collector internal deadline 10 seconds, checked before each step; it cannot interrupt a blocked system call. Local SSH cutoff 30 seconds; termination wait five seconds.
- `cmdline` read at most 16,385 bytes; more than 16,384 bytes stops as `ARGV_LIMIT` without retaining any part.
- Combined SSH stdout and stderr at most 8 KiB before parsing; the sanitized envelope at most 8 KiB; receipt metadata at most 16 KiB. Overflow stops without retaining raw or truncated data.
- Start-by time at most ten minutes after Root's dispatch. Clock-skew allowance five seconds for remote and local timestamp linkage; this is not a claim of synchronized clocks.
- Do not kill or signal the API service or any process found by PID. Local termination applies to the SSH client only.

Ordinary SSH access logs, node startup file reads and bounded observation overhead may occur. This is not a claim of zero operational footprint.

## One-use admission and identifiers

1. **New identifiers.** A new execution directory under `.qa-local/`, a fresh job ID, a fresh random 16-byte nonce, a new packet-specific exclusive marker and a new immutable one-use manifest. The collector and runner were built in that directory ahead of any owner GO, with no manifest, marker or job ID; the build consumed nothing. Before the manifest is created, test and mutant copies are kept outside the execution directory; the review copies have been moved to a separate review directory. The job ID, nonce, manifest and marker are created only after the GO. The manifest's execution directory must resolve to the directory the runner runs in, and the runner refuses to start otherwise.
2. **Marker.** The runner consumes the marker with an exclusive create before any connection. Immediately before that create, after every other admission check, the runner checks again that the current time is not after the start-by time (now <= start-by time); a failure is `MANIFEST_FRESHNESS` and consumes no marker. The lower bound (dispatch time <= now) is checked once, at manifest validation, and is not repeated at this recheck. The marker is never removed, renamed or reset. A consumed or expired attempt is not retried under the same GO.
3. **Single attempt.** Root checks that no other manifest or marker naming S6-API-CWD-RO-1 exists anywhere under `.qa-local/` of the main checkout or of any worktree of the repository, not only this checkout. The runner's own scan covers only the checkout that contains the runner. If one exists, Root stops and reports it.
4. **Pre-marker refusal.** A refusal before the marker is consumed makes no target contact and uses one of the pre-marker codes listed under Verdicts. Root stops and reports it to the owner; a new admission under the same GO needs the owner's decision.
5. **Post-marker receipt.** After the marker is consumed, every exit path writes exactly one sanitized receipt bound to the job ID, manifest hash and nonce, as in RO-2. If the receipt write fails, the runner prints one fixed sanitized line and Root treats the attempt as UNKNOWN.
6. **Isolation from earlier attempts.** The runner and collector do not import, spawn or read any file in the RO-1, RO-2, S6-API-SERVICE-RO-1 or S6-API-SERVICE-START-1 directories. Reviewed helper code and the public known-hosts pin file may be copied by value into the new directory and reviewed there. A static test checks this.
7. **Stream errors.** Error listeners are attached to the SSH child and to its stdin, stdout and stderr before the payload is written. One settlement function handles every terminal path.

## Privacy

- The values that cross the channel to the host are the frozen values and the argument-vector digest listed above, which were derived for this host and may be stale, plus the linkage values (packet ID, nonce, job ID, manifest hash) and the collector deadline. Only labels, booleans, linkage values and timestamps cross back.
- The nonce appears only in the ignored manifest, the payload, the ignored retained output and the ignored receipt. It never appears in the sanitized envelope, the runner's console line, a tracked record, a commit or a chat report.
- Tracked evidence never contains a hash of selector-bearing data. That includes the binding file, the unit, fragment path, working directory, release directory, home directory, argument vector and its digest, node path, the collector source with embedded values, the payload and the SSH argument list. Those hashes stay in ignored local evidence. Tracked hashes cover only non-private bytes: this packet, the sanitized envelope and the receipt, whose hash is safe only because the receipt carries the secret nonce.
- Tracked records contain dates, counts, sanitized labels, booleans and verdicts only. No account identifiers, machine locations, unit names, PIDs or paths.

## Admission items

Before any target connection, Root verifies all of the following:

1. **Owner GO.** A fresh owner GO, in owner wording, names **S6-API-CWD-RO-1** and Staging QL-P2 Prototype. Approval of this document, or any earlier GO, does not satisfy this item. Freshness runs from the timestamp of that wording; after 24 hours Root asks the owner to re-confirm before dispatch.
2. **Precondition.** As described under Precondition.
3. **Frozen channel.** The existing SSH endpoint, user, port, host-key pin and identity-file selector remain frozen and locally verifiable. Strict host-key checking stays on. No config, alias, proxy, multiplexing, forwarding or credential fallback; no new tunnel or channel; no credential search. If the channel is unavailable or ambiguous, stop before connection.
4. **New collector and runner.** Built in the new directory ahead of the owner GO, as local-only work with no target contact, and reviewed by the panel below. Building did not admit anything; the GO admits execution only. The manifest pins the reviewed bytes. Any change to the collector or runner is a rebuild that needs a new review by the full panel before admission. They contain no write, no service-control command, no database client and no operation other than those listed under Proposed read.
5. **Synthetic checks.** Isolated fixtures and injected adapters, never target calls, cover at least:
   - the SSH argument vector compared element by element with the reviewed RO-2 vector, with differences allowed at exactly two positions (the known-hosts path value and the remote timeout value), and a refusal for any other difference;
   - each `cwdClass` label and the precedence between overlapping labels, including `null` comparisons that never match;
   - each `expectedState` and `releaseDirState` label, including `SYMLINK_LOOP` from `ELOOP`; each `homeState` label;
   - every derived boolean reading `null`, not `false`, when an input does not resolve or is `NOT_DERIVABLE`;
   - a trailing slash, repeated slash and dot segment in the frozen value; a symlinked final component and a symlinked parent; a dangling symlink; a `..` component after a symlinked component, resolved physically;
   - the ` (deleted)` suffix with and without an equal base;
   - a non-absolute kernel cwd;
   - each `relationToExpectedResolved` label, its direction, the `/a/b` and `/a/bc` case, the deleted case and the `null` cases;
   - the release-directory rule for zero, one and several qualifying elements, an element equal to the bare suffix (empty result), and repeated slashes kept as they are, for both the frozen and the live vector;
   - argv equal, different, empty-element and invalid-UTF-8 cases decoded as in RO-2; a live read of exactly 16,384 bytes and of 16,385 bytes; a frozen vector over the 16,384-byte bound refused as `BINDING_ARGV_LIMIT`;
   - each `unitWorkingDirectory` form, including the `!` prefix, the order of `EQUAL_EXPECTED` before `EQUAL_KERNEL_CWD`, and the `MALFORMED` forms without a stop;
   - the check order of parsing, `Id`, guard and `WorkingDirectory` form;
   - each guard predicate failing alone and together, with no `/proc` read and no path inspection afterwards;
   - `Id` mismatch; missing, duplicate and extra keys;
   - readlink and read errors for each `errnoClass`; a changed second read;
   - every stop and refusal code listed under Verdicts, and no code outside those lists; `COLLECTION_UNKNOWN` from each side, with the emitting side derived;
   - output shape rejection, including a `/` in any value, an unexpected key, a duplicate key, other non-canonical frame text, a linkage value that differs from the manifest and a timestamp in a non-strict form, with only byte counts retained;
   - the character-set refusal for every embedded path value, including quote, space, backslash, dollar, backtick and newline; the `PAYLOAD_DELIMITER` refusal for the source and for the serialized bound object;
   - nonce absence from the envelope and console line;
   - every post-marker exit path writing exactly one receipt;
   - consumed, expired and wrong-directory attempts; a manifest timestamp in a non-strict form; a start-by time that passes during admission, refused before the marker; no read of earlier attempt directories;
   - a metadata call that blocks past the collector deadline, ending through the simulated remote wrapper timeout or local cutoff;
   - and absence of any write, retry, signal, start, stop or downstream action.

   Timeout, cutoff and termination paths use deterministic in-process simulation with injected transport and timer adapters, as in S6-API-SERVICE-RO-1. There is no subprocess, native or process-fixture testing, so real local kill and reaping behavior stays unverified, and the receipt and report say so.
6. **Manifest.** The immutable one-use manifest pins this packet, the collector, the runner, the binding, the known-hosts pin copy, the SSH arguments, the payload bytes and the limits. It carries the owner GO reference, the precondition record reference, the job ID, the dispatch time, the start-by time and the collector deadline. All three timestamps use strict UTC form with milliseconds, `YYYY-MM-DDTHH:MM:SS.sssZ`; any other form is refused before the marker as `MANIFEST_FRESHNESS`.
7. **Usage and runtime.** Root refreshes usage and local runtime state, keeps the 3% usage reserve and dispatches only the designated operations worker, alone, outside any parallel fan-out. Unknown all usage prohibits execution.

## Review panel

This is a host-adjacent GO packet. Before an owner GO is requested, an adversarial review of this draft runs, and Root records a preparation evidence record that pins this packet's exact bytes and its review history. The first draft review returned FIXES_REQUIRED, and revision 2 applied its findings. Revision 3 applied the packet findings of the first build audit. The packet review of revision 3 returned FIXES_REQUIRED for text-only items (no P1, no P2, four P3). Revision 4 applies those items and the text items of the build review panel, as ruled by Root. A text re-review of revision 4 returned two wording items (no P1 or P2), which Root applied and checked by diff. Root then recorded the preparation evidence record.

Before admission, the collector and runner are reviewed by a panel with three separate slots: an independent tester, an Opus architecture auditor and a separate second-opinion reviewer. Fable 5.1 is paused by the owner, so an Opus substitute fills the second-opinion slot, and the review record names the substitute model. The architecture auditor does not fill the second-opinion slot, and no agent fills more than one slot. This build review may run ahead of the GO; it admits nothing, and a rebuild repeats it. For the build fix round 2 (F1 physical `realpath` through the native call, F4 canonical frame text, F6 strict timestamps, F7 probe tests, F8 recheck before the marker), the three slots ran separately on the round-2 pins. The independent tester returned PASS (author suite 97 of 97, independent suite 39 of 39, 30 mutants with 21 killed and every survivor equivalent or layered). The Opus architecture auditor returned GO WITH CONDITIONS (no P1, no P2, four P3). A separate Opus 5.5 second-opinion reviewer, the recorded substitute for the paused Fable 5.1, returned GO WITH CONDITIONS (no P1, one P2, ten P3). Root ruled on the second-opinion P2 with a text boundary instead of a rebuild (see Question and evidence boundary). These verdicts are review evidence, not acceptance. After the attempt, an independent reviewer verifies the receipt linkage, the verdict and the consistency of the class with its supporting fields. No reviewer grants acceptance; Root decides.

## Outcomes and what they mean for a later owner-ID packet

Any later owner-ID read is a new packet (for example S6-OWNER-ID-RO-3) with its own review and owner GO. This packet only informs its design. Every row below also requires `argvEqualFrozen` to be `true` before a later packet can pass the RO-2 stage-3 argv check; a `false` value blocks the later packet regardless of the class, until the argument difference is explained. An `ARGV_LIMIT` stop gives no prediction either way.

| Result | Meaning | Consequence for a later owner-ID packet |
| --- | --- | --- |
| `EXACT_EQUAL` | The kernel cwd now equals the frozen value, and nothing more. The RO-2 stop is not reproduced. The result is a snapshot with no continuity link to the process RO-2 observed, so it does not establish why RO-2 differed: a restart, a move or another change since RO-2 cannot be separated. | The frozen value can stay. The RO-2 cause stays unknown, and the later packet must say so and keep the exact comparison. |
| `EQUAL_AFTER_RESOLVING_EXPECTED` | The frozen path names the serving directory through a symbolic link or a form difference. `expectedLexicallyCanonical` and `expectedResolvesToItself` say which. | Supports re-freezing the expected working directory to the resolved path under a reviewed binding update. The resolved path does not come from this packet, which never returns it. It must come from the owner, or from a separately reviewed derivation, and the later packet's exact comparison then confirms it. Re-freezing to the resolved release path also pins one release directory, so a later link change shows up as a stop instead of silently moving the artifact reads. Changing the comparison rule to "resolve, then compare" is an alternative that needs its own design review. |
| `KERNEL_CWD_DELETED` | The serving process sits in a directory that was removed or replaced after it started, or, less likely, in a real directory whose name ends with the deleted suffix. The base-equality fields say whether the base was the expected path. | Blocking. Artifact reads at the expected path would hash files that the process may not be running. No owner-ID packet until the owner decides on a restart or redeployment under its own reviewed packet. This packet authorizes neither. |
| `EQUAL_TO_ARGV_RELEASE_DIR` | The process runs in the release directory named by the frozen argument vector, but the frozen working directory does not resolve to that directory. The RO-2 assumption that the frozen working directory is the release root does not hold for the binding. | Supports re-freezing the expected working directory to that release directory under a reviewed binding update, with the same rule on the source of the value as above. The later packet's artifact pins then verify content. |
| `HOME_DIR` or `FILESYSTEM_ROOT` | The process runs in the home or root directory, which usually means the unit sets no working directory and the server starts from an absolute script path. `unitWorkingDirectory` and `liveReleaseDir` support or contradict this. | Do not re-freeze the working directory to the home or root directory. The RO-2 design assumed that the working directory is the release root: it reads artifacts and loads the database client module relative to it. A later packet needs a reviewed design change that derives the release root from the frozen script path instead. |
| `KERNEL_CWD_NOT_ABSOLUTE` or `OTHER` | Unexplained. A bind or alternate mount path, or a directory change after start, can produce either label. `relationToExpectedResolved` of `SIBLING`, together with `liveReleaseDir` of `EQUAL_KERNEL_CWD`, suggests a different release next to the expected one; it does not prove it. `OTHER` alone is not evidence of a different release. A link-swap deployment, in which the process stayed in the old directory, has this signature: `OTHER`, relation `SIBLING`, `expectedIsSymlink` true, `expectedResolvesToItself` false, `liveReleaseDir` `NOT_EQUAL_KERNEL_CWD` and `argvEqualFrozen` true. A plain rename differs: with a new real directory at the expected path, `expectedIsSymlink` is false and `expectedResolvesToItself` true; with nothing there, `expectedState` is `NOT_FOUND` and the relation is null. | Blocking. No owner-ID packet until the owner explains the layout or a further reviewed diagnostic does. With the link-swap or rename signature, the next step is an owner decision about a service restart under its own reviewed packet, not a re-freeze. |
| `SERVICE_GUARD_FAILED_AT_NEW_SNAPSHOT` | The service changed state since RO-2. | No owner-ID packet. The service state must be resolved first, under its own packet and GO. |
| `STOP_UNKNOWN` or `UNKNOWN` | No valid classification. | Stop and report the sanitized code. No retry under this GO. Any further contact needs its own packet and GO. |

`expectedState` of `NOT_FOUND`, `SYMLINK_DANGLING` or `SYMLINK_LOOP` points to a stale or broken frozen value regardless of the class. A `false` value of `releaseDirResolvedEqualsExpectedResolved` means the two frozen values resolve to different directories, so the binding update must reconcile both frozen values, not only the working directory. A `null` value gives no information about the binding.

## Evidence and acceptance

One completion receipt, kept as ignored local evidence, binds the packet hash, job ID, nonce, owner GO reference, precondition reference, the manifest, collector, runner, binding and payload hashes, the UTC start and end times, the monotonic elapsed time, the transport exit, stream-error flags, output byte counts, the hash of the retained output and of the sanitized envelope, the termination status and the terminal verdict. It states that real local kill and reaping behavior is unverified.

The tracked result record follows the Privacy section. It may contain the date, the verdict, `cwdClass`, the supporting labels and booleans, the guard vector, the emitting side of a `COLLECTION_UNKNOWN` code as derived from `stageReached`, the packet hash, the sanitized envelope hash and the receipt hash. Hash linkage supports the recorded local execution chain, not cryptographic remote attestation. No worker accepts its own result. Root accepts only the diagnostic observation or stop record.

## Residual risks

- **PID race.** The `MainPID` value comes from the property response and the `/proc` reads follow it. A restart between the two would need to happen within milliseconds. The stability recheck repeats the `/proc` reads but not the property query, so it gives partial protection only.
- **Symbolic link moves.** The classification describes one moment. A link that changes after the read changes the answer, and nothing in this packet detects that afterwards.
- **Blocking metadata call.** A `lstat`, `stat` or `realpath` call on a hung mount can block past the collector deadline. Only the remote wrapper and the local cutoff bound it, and the attempt then stops as `TRANSPORT_EXIT` or `LOCAL_CUTOFF` with no classification. A call blocked in uninterruptible sleep on a hung mount can outlive the kill, so a node process may remain on the host after the stop.
- **No continuity link.** The result is a snapshot at attempt time. It has no link to the process RO-2 observed, so `EXACT_EQUAL` means only that the current kernel cwd equals the frozen value, and no class separates a restart, a move or another change since RO-2.
- **Overall limit includes admission.** The 60-second clock starts before admission. A slow admission scan can leave too little time after the marker and end a consumed attempt as `OVERALL_LIMIT`.
- **Inherited session environment.** The remote node process inherits the SSH session environment, for example `NODE_OPTIONS`. This is the same exposure as in RO-2.
- **Inseparable candidates.** A bind or alternate mount path, a directory change after start, and a directory named with the deleted suffix fall into existing classes without a distinguishing label. `OTHER` is not evidence of a different release.
- **Home directory source.** `HOME_DIR` compares with the collector's `HOME` value from the SSH session, which equals the user manager's default only when both belong to the same user, as the frozen channel intends.
- **Structural hints.** The relation and state labels reveal coarse layout facts, such as whether a symbolic link is involved. They reveal no path, name or identifier.
- **Real termination behavior.** Real local kill and reaping behavior stays unverified.

## Explicit exclusions

- No database connection, database client module load or SQL. No application API call or authentication flow.
- No read of `/proc/<pid>/environ` or any `/proc` entry other than the main process `cwd` link and `cmdline`. No environment-file, artifact, unit-file or other regular file contents. No directory listing.
- No logs, journal, `systemctl status`, `systemctl cat`, service discovery, process listing or host inventory. No alternate unit, user or endpoint and no second property query.
- No start, restart, stop, reload, daemon-reload, enable, disable, reset-failed, linger change, signal or repair. No binding update; a binding update is a separate reviewed step.
- Do not run, retry or reset S6-OWNER-ID-RO-1, S6-OWNER-ID-RO-2, S6-API-SERVICE-RO-1 or S6-API-SERVICE-START-1. Do not continue into the owner query or applicability. Do not change the local input lock or weaken any security guard.

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; P13j/N1 HELD. No deployment, target route activation, migrations, service, config or role changes, native compilation, process fixtures, database or C3 runtime start, Live, guard reset, Best Inputs apply, optimizer, holdout or new research phase.

## Suggested owner approval

> GO S6-API-CWD-RO-1 for the selected Staging QL-P2 Prototype API service only. Use only the collector and runner built ahead of this GO and pinned after their completed independent review; any rebuild needs a new review first. Real kill and reaping behavior stays unverified. Then make one read-only attempt in one session over the frozen channel, maximum 60 seconds: one property query of the exact bound unit, the working-directory link and argument vector of its main process, and path metadata of the frozen expected paths, the session home directory and the live release directory, returning labels and booleans only. No database, service-environment, file-content or log read; no retry, signal, service change, binding update or owner query. Do not reuse any consumed attempt. Keep all existing gates.

No such GO is recorded by this preparation.
