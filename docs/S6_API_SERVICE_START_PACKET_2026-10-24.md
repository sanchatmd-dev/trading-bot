# S6 API service start packet

Packet ID: **S6-API-SERVICE-START-1**. Status: **PREPARED FOR OWNER REVIEW; NOT RUN; NO EXECUTION GO**.

> **This packet is a service change on the owner's staging host.** It proposes to start one stopped user service. It is not a read-only diagnostic. Approval of this document, the S6-API-SERVICE-RO-1 GO, the S6-OWNER-ID-RO-1 GO or any standing authority does not authorize it. Execution requires a **new explicit owner GO that names S6-API-SERVICE-START-1** and Staging QL-P2 Prototype, with the owner's checklist answers described below, followed by the reviewed implementation and Root admission. No collector, runner, manifest or marker for this packet exists yet.

## Why this packet exists

[S6-OWNER-ID-RO-1](S6_QL_P2_OWNER_ID_READONLY_RESULT_2026-10-24.md) stopped at `API_SERVICE_MISMATCH` before any database work. The follow-up diagnostic [S6-API-SERVICE-RO-1](S6_API_SERVICE_MISMATCH_READONLY_PACKET_2026-10-24.md) then ran once under its own owner GO. Its [result](S6_API_SERVICE_MISMATCH_READONLY_RESULT_2026-10-24.md) and [result evidence](evidence/S6_API_SERVICE_MISMATCH_READONLY_RESULT_2026-10-24.json) (job `s6-api-ro1-e97c9d9dca9f6a66dcb391cc`, local start 2026-10-23T19:26:15Z, 24 October 02:26 Bangkok) show:

| Observation | Result |
| --- | --- |
| Unit identity (`Id` equals the bound unit) | match |
| `LoadState` | `loaded` |
| `NeedDaemonReload` | `no` (PASS) |
| Fragment identity | PASS, nonempty |
| `ActiveState` | `inactive` (FAIL) |
| `SubState` | `dead` (FAIL) |
| Main PID shape | FAIL (no running main process) |

Verdict: **SERVICE_GUARD_MISMATCH_OBSERVED_AT_NEW_SNAPSHOT**. The exact previously selected Staging QL-P2 API user service is installed and matches its frozen fragment, but it was not running at that observation. Root accepted that record as a diagnostic observation only.

That observation does not prove why the service is stopped, whether it was already stopped at the owner-ID attempt, or that starting it is safe. It only establishes that the owner-ID read cannot pass its service guard while the service stays stopped. This packet proposes the smallest change that could restore that precondition: one start of the same unit, with read-only checks immediately before and after.

## Scope in one sentence

One designated operations worker, in one SSH session through the existing frozen channel, reads the systemd version, the calling user's linger setting and the exact bound unit's state, dependency counts and start-step presence flags (P1), issues exactly one `systemctl --user start` of that unit if and only if every P1 gate passes (P2), and then observes the unit within a fixed bound (P3), with no retry, no stop, no logs and no other unit or host action by the runner.

## Phase P1: read-only pre-check

P1 is one framed phase of four read-only commands, run in this order. The remote environment fixes `LC_ALL=C` and `TZ=UTC` so that output and timestamps print in one parseable form. Each command has its own 5-second remote timeout.

1. **systemd version.** `systemctl --version`. The runner parses only the first line, which must match `systemd <integer>` optionally followed by a space and further text. It retains only the integer. All other text and lines are ignored and never retained. A missing or unparseable version is a P1 gap. A version below **235** stops with reason `SYSTEMD_VERSION_UNSUPPORTED`, because `NRestarts` and its reset behavior are not available before that version. The parser depends on the version only where this packet says so.
2. **Linger.** `loginctl show-user "$(id -u)" --property=Linger`. The remote shell resolves the SSH user's own numeric ID; the runner interpolates nothing into this command, enumerates no other user and never retains the ID. The runner retains only `yes`, `no` or `UNKNOWN`. Output other than exactly `Linger=yes` or `Linger=no`, a nonzero exit, nonempty stderr or a timeout is `UNKNOWN`.
3. **Unit properties.** One property query against the exact bound unit. The conceptual argument vector is `systemctl --user show --all --no-pager '<unit>'` followed by one `-p` argument for each property in the table below.
4. **Start-step presence.** A remote reduction that reports, for `ExecStartPre` and for `ExecStartPost` of the exact bound unit, only whether the property value is empty or nonempty, plus the exit status of each underlying query. The raw value, which can contain command lines and arguments, never crosses the channel. A nonzero query exit or any output other than the two framed flags is a P1 gap.

| Property | Use |
| --- | --- |
| `Id` | Must equal the bound unit exactly. |
| `LoadState` | Must be `loaded`. |
| `ActiveState` | Must be `inactive`. |
| `SubState` | Must be `dead`. |
| `UnitFileState` | Label only (`enabled`, `disabled`, `static`, `linked`, or `OTHER`). Not a gate. |
| `Result` | Must not be `start-limit-hit`. Label only otherwise (`success`, `exit-code`, `signal`, `core-dump`, `timeout`, `watchdog`, `resources`, or `OTHER`). |
| `ExecMainCode` | Small non-negative integer; retained as a diagnostic. |
| `ExecMainStatus` | Small non-negative integer; retained as a diagnostic. |
| `ExecMainStartTimestamp` | Empty or one strict UTC timestamp. |
| `ExecMainExitTimestamp` | Empty or one strict UTC timestamp. |
| `InactiveEnterTimestamp` | Empty or one strict UTC timestamp. |
| `NRestarts` | Non-negative integer; retained as a diagnostic only. It is not a baseline for P3 (see P3). |
| `NeedDaemonReload` | Must be `no`, so that the start never runs against a stale loaded definition. |
| `FragmentPath` | Must equal the frozen expected fragment exactly, so that the start never runs against a different definition. |
| `MainPID` | Must be `0` (no main process). Never retained. |
| `Requires` | Count of listed units only. Not a gate. |
| `Wants` | Count of listed units only. Not a gate. |
| `BindsTo` | Count of listed units only. Not a gate. |
| `Conflicts` | Count of listed units only. Not a gate. |
| `OnFailure` | Count of listed units only. Not a gate. |
| `OnSuccess` | Count of listed units only. Not a gate. Requested always; on systemd versions below 249, which lack this property, an absent key is expected and recorded as `NOT_AVAILABLE`. From version 249 on, an absent key is a gap. If an older host instead fails the whole query, that is a P1 gap and a stop. |

The first fifteen properties form the base pre-check list. `NeedDaemonReload`, `FragmentPath` and `MainPID` are included beyond the minimum because they repeat RO-1 predicates that must still hold before a start is safe to issue, and P3 needs them anyway. The six dependency properties are included so that the owner can see, as counts, whether the start may touch other units.

For each dependency property the value is a space-separated list of unit names. Each token must be a plausible unit name (strict unit-name character set, bounded length) and the list must stay within the per-value byte bound; otherwise it is a P1 gap. P1 retains only the count per property; names stay private and are never retained, hashed into tracked evidence or printed. Counts include systemd's implicit default dependencies, so a nonzero count is normal and is not by itself a finding. The counts and the two presence flags are diagnostics, not gates: the packet cannot judge private names. The owner's hard-gate confirmations under checklist items 2 and 3 are the gate for what these units and start steps do.

P1 parsing of the property query follows the RO-1 rules: exactly the requested keys, each once, except the version-dependent `OnSuccess` rule above; no missing, duplicate or unexpected keys; valid UTF-8; no NULs; per-value byte bounds; lowercase identifier tokens of at most 32 bytes for state labels; decimal integers of at most 20 digits for numbers; and a strict `Day YYYY-MM-DD HH:MM:SS UTC` form or the empty string for timestamps. For every P1 command, a nonzero exit (except where the linger rule maps it to `UNKNOWN`), nonempty stderr, timeout, transport failure or any parse gap is a gap.

**P1 stops the session without starting** when any of the following holds:

- the systemd version is unparseable or below 235;
- Linger is `no`: terminal verdict **NOT_STARTED_LINGER_OFF**;
- Linger is `UNKNOWN`: terminal verdict **NOT_STARTED_PRECHECK_STOP** with reason `LINGER_UNKNOWN`;
- `Id` differs from the bound unit, or the response is incomplete or malformed;
- `LoadState` is not `loaded`;
- the unit is already `active`, or is in any state other than `inactive`/`dead` (for example `activating`, `deactivating`, `reloading`, `failed`);
- `Result` is `start-limit-hit`;
- `NeedDaemonReload` is not `no`, or `FragmentPath` does not match the frozen expected value;
- `MainPID` is not `0`;
- any P1 gap as defined above, including a dependency count or presence flag gap.

Except for the linger `no` case, each stop ends with **NOT_STARTED_PRECHECK_STOP** and its reason code.

**Why linger is a gate.** A user service runs under the user's own service manager. Without linger, that manager can stop, and stop the service with it, after the last login session ends. A start made from an SSH session on a linger-off host could therefore be followed by an uncontrolled stop at logout, and a VERIFIED_RUNNING result would be misleading. A linger-off host would also explain the inactive state RO-1 observed, if the service was last started from a login session; this packet does not prove that cause. Enabling linger is a separate configuration change outside this packet: it needs its own owner action or its own reviewed packet and GO.

A `failed` state is deliberately a stop, not a start candidate: it differs from what RO-1 observed and needs a separate look. An already-running service is also a stop: the guard condition would be met without any change, and the next step is then the separate owner-ID packet, not a start.

P1 also derives one sanitized diagnostic that is useful for the earlier question: the relation of `InactiveEnterTimestamp` to the S6-OWNER-ID-RO-1 interval (local receipt 2026-10-23T17:28:09.149Z to 17:28:10.377Z, with a 5-second clock-skew allowance). With the second-precision timestamp `T`: **BEFORE** if `T + 5 s` is earlier than 2026-10-23T17:28:09Z; **AFTER** if `T - 5 s` is later than 2026-10-23T17:28:11Z; otherwise, or when `T` is empty, **UNKNOWN**. `BEFORE` is consistent with the service having been stopped at that attempt; it is not proof, because the unit may have started and stopped again in between. `ExecMainStartTimestamp`, `ExecMainExitTimestamp` and `NRestarts` are retained to help that reading, not to decide anything.

## Phase P2: one start

Only after every P1 gate passes, and only once per session, the runner sends one start command:

`systemctl --user start --no-ask-password --job-mode=fail '<unit>'`

wrapped in a remote `timeout --signal=TERM --kill-after=1s 20s`.

- `--no-ask-password` prevents any interactive authorization prompt.
- `--job-mode=fail` makes systemd refuse the start if it would reverse an already queued job (a pending stop into a start or the reverse), instead of replacing that job. It does not change what the unit does when it starts, and it does not prevent the start from stopping units the service conflicts with.

No `restart`, `try-restart`, `reload`, `stop`, `kill`, `reset-failed`, `daemon-reload`, `enable`, `disable`, `edit`, `set-property`, `set-environment` or `import-environment`. No other unit name, template expansion or wildcard. No configuration, environment-file, unit-file or linger change.

**When P2 counts as sent.** P2 is sent as soon as the first byte of the P2 phase command has been passed to the SSH process or channel. A transport loss, local cutoff or overall-limit breach before that point, including a connection failure before P1 begins, yields **NOT_STARTED_PRECHECK_STOP** with reason `TRANSPORT_FAILURE`, `LOCAL_CUTOFF` or `OVERALL_LIMIT`. Any such failure at or after that point, including during a partial write, yields **UNKNOWN**, and the start must be treated as possibly effective.

P2 retains: whether the command was sent, its exit status (`0`, a nonzero integer, or `TIMEOUT`), and the stderr byte count. Raw stderr is never retained or printed.

Two properties of `systemctl start` must be understood before GO:

1. **A timeout does not cancel the start.** Killing the local or remote `systemctl` client leaves the start job with systemd. The service may still come up, or fail, after the client gives up. P3 therefore always runs after P2 was sent, unless the transport is lost.
2. **A start can start or stop other units and run extra steps.** Units listed in `Requires=`, `Wants=` or `BindsTo=` are started as part of the same job. Units listed in `Conflicts=` are stopped as part of the same job, and `--job-mode=fail` does not prevent that. Units listed in `OnFailure=` or `OnSuccess=` are triggered later if the service fails or exits. `ExecStartPre=` and `ExecStartPost=` steps run additional commands around the main process. P1 retains only the counts and presence flags; names stay private. The owner must confirm what these are before GO (checklist items 2 and 3).

Whatever P2 returns, there is **no second start** under this GO: not after a nonzero exit, a timeout, a failed P3 or a transport loss.

## Phase P3: bounded post-start verification

P3 is read-only. It is start verification only; the later owner-ID read is its own packet. P3 reuses the RO-1 property query (`Id`, `LoadState`, `ActiveState`, `SubState`, `NeedDaemonReload`, `MainPID`, `FragmentPath`) plus `NRestarts` and `Result`, under the same parser and the same five unchanged guard predicates:

| Predicate | Comparison |
| --- | --- |
| Active state | `ActiveState === 'active'` |
| Substate | `SubState === 'running'` |
| Reload flag | `NeedDaemonReload === 'no'` |
| Main PID shape | `/^[1-9]\d*$/.test(MainPID)` |
| Fragment identity | `FragmentPath === expectedFragmentPath` |

**Polling bound.** The first poll starts at least 2 seconds after P2 returns. Each later poll starts at least 5 seconds after the previous poll started. The last poll starts no later than 25 seconds after P2 returns, and every poll completes no later than 30 seconds after P2 returns. Each poll is its own bounded query with a 5-second remote timeout. The cap is 6 polls; under these timings no more than five fit. Polling ends early only on VERIFIED_RUNNING or on a gap; the other verdicts are decided at the end of the bound.

**Restart detection.** On the systemd versions this packet accepts, an explicit start resets the unit's restart counter, so the P1 `NRestarts` value is not compared with P3. Any nonzero `NRestarts` at any P3 poll means at least one automatic restart after this start. If a host did not reset the counter, the rule would see a nonzero P1 value as a restart; that can only withhold VERIFIED_RUNNING, never grant it.

P3 verdicts:

- **VERIFIED_RUNNING**: two consecutive polls, at least 5 seconds apart, each with a matching `Id` and all five predicates passing, with the same main PID in both polls (compared in memory only, never retained) and `NRestarts` equal to `0` at every P3 poll so far. This is the only state in which the owner-ID guard is expected to pass.
- **NOT_RUNNING_AFTER_START**: every poll was complete and identity-matched, and at the end of the bound the last poll shows the unit not active (`inactive`, `failed` or `deactivating`). Retained pattern labels: `NEVER_ACTIVE`, `ACTIVE_THEN_EXITED`, `FAILED`.
- **NOT_VERIFIED_WITHIN_BOUND**: every poll was complete and identity-matched, but neither verdict above applies at the end of the bound. Retained pattern labels: `STILL_ACTIVATING_AT_BOUND` (for example a slow start that may still complete after the session), `RESTARTED` (nonzero `NRestarts` at any P3 poll, including a unit that restarted and then looked stable), `MAIN_PID_CHANGED`, and `RUNNING_NOT_CONFIRMED` (fewer than two consecutive passing polls). Root reports this verdict and its pattern to the owner as an unsettled state, not as a failure and not as running.
- **UNKNOWN**: any gap in P3 (identity mismatch, parse gap, query timeout, nonempty stderr, transport loss, local cutoff or overall limit) before one of the verdicts above is reached. UNKNOWN never upgrades to another verdict.

If P1 stopped, the session ends with **NOT_STARTED_LINGER_OFF** or **NOT_STARTED_PRECHECK_STOP** and its reason code. Transport and limit failures follow the P2 sent rule above.

No outcome triggers another start, a stop, a log read or any repair. VERIFIED_RUNNING is an observation inside this session only. It does not attest that the service stays up after the session ends, that it serves the expected revision, or that it is connected to the expected database.

## Session protocol, limits and privacy

**One session, locally controlled.** The runner opens one SSH session with the same frozen channel and hardened option set as RO-1 (strict host-key pin, no config file, no alias, proxy, multiplexing, forwarding or credential search). The remote command is a fixed `timeout --signal=TERM --kill-after=1s 90s bash -s`. The runner writes phase commands to standard input one at a time and decides locally, with the reviewed parser, whether to send the next one. The remote shell never decides whether to start.

Each phase command is built from a frozen template: the user-bus bootstrap exports from RO-1, then the phase body framed by begin and end marker lines that carry the per-attempt nonce and the phase name, with standard input redirected from `/dev/null` so no remote command can consume later input. Output without the exact framing for the current phase, or with a nonce mismatch, is a gap. Two values are interpolated: the unit name, which passes the RO-1 strict character-set check and is inserted only inside single quotes, and the per-attempt nonce, exactly 32 lowercase hexadecimal characters. The manifest hashes the phase templates; the ignored local receipt records the hashes of the instantiated commands.

**Proposed limits.** One attempt; one SSH session; one P1 phase of four read-only commands; at most one start command; at most six P3 queries; **120 seconds overall**, including local termination and evidence handling.

| Limit | Value |
| --- | --- |
| Connection establishment | 5 s |
| P1 phase | 5 s remote timeout per command, 15 s for the whole phase |
| P2 start (remote timeout) | 20 s, plus 1 s forced-termination allowance |
| P3 window after P2 returns | last poll starts by 25 s, all polls complete by 30 s; at most 6 queries of 5 s each |
| Remote session deadline | 90 s, plus 1 s forced-termination allowance |
| Local SSH cutoff | 100 s |
| Local child termination wait | 5 s |
| Overall | 120 s |
| Start-by after dispatch | at most 10 minutes |
| Combined stdout and stderr per phase | 8 KiB |
| Sanitized output envelope | 8 KiB |
| Receipt metadata | 8 KiB |
| Clock-skew allowance for linkage | 5 s |

Overflow stops without retaining raw or truncated data. A local cutoff or overall-limit breach after P2 was sent yields UNKNOWN. Failure to confirm local child termination yields UNKNOWN cleanup and no follow-up target check. The runner never signals the API service or any remote process by PID.

**Privacy.** The RO-1 rules apply unchanged. Raw unit names, IDs, PIDs, user IDs, fragment paths, dependency unit names, raw systemctl and loginctl output text, the full systemd version line, stdout and stderr are never persisted or printed. Start-step command lines never cross the channel. Ignored local evidence may keep the fragment-path digest. Tracked evidence keeps only sanitized labels, the systemd version integer, the linger label, integer exit and restart counts, dependency counts, start-step presence flags, normalized UTC timestamps in ISO 8601 form (these are not private), the before/after/unknown relation to the owner-ID interval, the P2 status, the P3 poll count and pattern, the predicate vector and the verdict. Tracked evidence never contains a hash of raw stdout, stderr, `Id`, PID, fragment path, unit name, dependency name, or of any command or file that embeds a private selector; those hashes stay in ignored local evidence.

## Stop and rollback policy

**Do not stop the service afterwards unless the owner says so.** The reasons:

- Stopping is a second service change. This packet authorizes exactly one change, the start. A stop needs its own owner instruction.
- The purpose of the start is to restore the precondition for the separate owner-ID read. Stopping it automatically would return the host to the state RO-1 observed and make the start pointless.
- If the unit fails or crash-loops, its own systemd restart policy already governs it. Intervening from this packet would add an unreviewed action to an unreviewed failure.
- The service was observed `inactive`/`dead` with a passing fragment and no pending reload. Starting a stopped, installed unit does not itself edit configuration, so there is no configuration state to roll back, provided the service's own start steps make no such change (checklist item 2).

If the result is VERIFIED_RUNNING, the service is left running. If the result is NOT_RUNNING_AFTER_START, NOT_VERIFIED_WITHIN_BOUND or UNKNOWN, the service is left in whatever state systemd holds it, and Root reports that state to the owner at once. If a crash or restart loop is observed, Root recommends that the owner decide promptly whether to stop the unit, through the stopper the owner named under checklist item 9; Root does not stop it. Any later stop, restart, log read or repair needs a separately reviewed packet or a direct owner action.

## Risks

- **Crash or restart loop.** The service may fail at start or shortly after, possibly repeatedly under its restart policy. Each attempt may open database connections or write logs. The 30-second P3 window cannot rule out a later failure.
- **Database migrations not run.** This packet runs no migration, and the database schema may not match what the service expects. The service may fail, or may run against a mismatched schema. If the unit's own start steps ran migrations, the start itself would change the database; the owner must affirmatively confirm under checklist item 2, before dispatch and without waiver, that they do not.
- **Serving revision unknown.** The service will run whatever is installed on the host. This packet does not attest the serving revision, artifact hashes or configuration.
- **Database identity unknown.** This packet does not attest which database the service connects to, or that it is the intended staging database. The started service connects to its configured database; the runner and the operations worker do not.
- **Side effects of a running API.** Once running, the service may accept requests from whatever already routes to it, and may start its own background work (scheduled jobs, data capture, outbound calls or notifications). Starting the service is not intended as target route activation and creates no new route, but it makes the existing routes reachable again on staging. The owner must accept this in the GO.
- **Other units and start steps.** The start may start units the service requires, wants or binds to, stop units it conflicts with, and later trigger failure or success handler units. `ExecStartPre` and `ExecStartPost` steps may run additional commands. P1 retains only counts and presence flags; names stay private, so the packet cannot judge them, and the owner's confirmation under checklist items 2 and 3 is the control.
- **Session-bound user manager.** Without linger, the user's service manager may stop the service after the SSH session ends, even after VERIFIED_RUNNING. P1 stops before any start unless linger reads `yes`. P3 still cannot observe beyond the session.
- **Not persistent across reboot.** The packet does not enable the unit. If `UnitFileState` is not `enabled`, the service will not come back after a host reboot.
- **Timeout ambiguity.** A start that times out on the client may still complete or fail later in systemd.
- **Unknown cause.** The reason the service stopped is unknown. A linger-off user manager is one candidate (the P1 linger read shows the current setting, not the past cause), as are a host reboot, a deliberate stop or a crash. Starting the service does not diagnose or fix the cause, and the same cause may stop it again.
- **systemd version differences.** Restart-counter reset and property availability depend on the systemd version. P1 reads the version and stops below 235; the `OnSuccess` and `NRestarts` rules above are the only version-dependent parser rules.
- **Ordinary footprint.** One SSH login, access-log lines and normal service start-up load occur. This is not a zero-footprint operation.
- **Unqualified termination.** As with RO-1, real local kill and reaping behavior stays unverified; only deterministic in-process simulation covers the runner's timeout and cleanup paths.

## Owner checklist before GO

The owner can check these directly on their own host and systems. This packet will not inspect them beyond the P1 counts, flags and linger read.

Items 2, 3, 5, 7 and 9 are **hard gates**: they need the owner's affirmative confirmation and can never be waived or accepted as risks. Items 1, 4, 6 and 8 may either be confirmed or explicitly accepted by the owner as named risks. If any hard-gate item is unconfirmed, or any other item is neither confirmed nor accepted, Root stops before dispatch.

1. **Why the service is stopped** (may be accepted as a named risk). Did the owner or another process stop it on purpose (for example after a host reboot, a maintenance step or a deliberate pause)? If it was stopped deliberately, do not GO until that reason is cleared.
2. **What the unit does at start** (hard gate). Read the unit's start steps, including any `ExecStartPre` and `ExecStartPost` steps, and confirm that they run no migration, schema change, data import, deployment or destructive step, and that any environment file points at the intended staging database, not production.
3. **Other units** (hard gate). Confirm which other units, if any, the unit requires, wants, binds to, conflicts with or names as failure or success handlers, and that starting, stopping or triggering them as described under P2 is acceptable. None of them may be a database, C3 runtime, capture, scheduler or other project service; if one is, there is no GO under this packet.
4. **Database readiness** (may be accepted as a named risk). Confirm that the staging database the service uses is up and that its schema matches the installed service.
5. **What the running service will do** (hard gate). Confirm that the running API starts no Live trading, order placement, guard reset, Best Inputs apply, optimizer run, notification or email, research job or external call that this project's gates hold. Spot/Paper-only must stay true.
6. **Exposure** (may be accepted as a named risk). Confirm that it is acceptable for any existing route, proxy or client to reach the service again once it runs.
7. **Session independence** (hard gate). Confirm that the user service manager stays alive after the SSH session ends (linger enabled for the service user), so that a started service is not stopped at logout. P1 also checks linger and stops unless it reads `yes`; the confirmation is required in addition.
8. **Host headroom and conflicts** (may be accepted as a named risk). Confirm sufficient memory and disk on the host, that no other copy of the API is bound to its port, and that no other host job is running or planned around the dispatch time (Root reports the dispatch time before the attempt).
9. **Who stops it, if needed** (hard gate). Name who stops the service if needed, confirm that person is reachable during and shortly after the window, and say whether you want the service stopped after the owner-ID read. This packet will not stop it.

## Admission items

Before any target connection, Root must verify all of the following. They mirror RO-1 and add the service-change items.

1. **Owner GO.** A new explicit owner GO names **S6-API-SERVICE-START-1** and Staging QL-P2 Prototype and acknowledges that it is a service start. It lists the confirmed items and any of items 1, 4, 6 or 8 accepted as named risks, and carries the database and route statements from the suggested approval below. No earlier GO, job ID or consumed marker is reused. The RO-1 and owner-ID markers and evidence stay preserved.
2. **Owner checklist.** Root records the owner's affirmative confirmation of hard-gate items 2, 3, 5, 7 and 9, and for items 1, 4, 6 and 8 either a confirmation or an explicit acceptance as a named risk. A blanket acceptance of unchecked items does not satisfy a hard gate. Otherwise Root stops before dispatch.
3. **GO freshness.** One GO covers both the build and review and the later execution. If more than 24 hours pass between the GO and dispatch, Root asks the owner to re-confirm the checklist before dispatch.
4. **RO-1 record.** The RO-1 [result](S6_API_SERVICE_MISMATCH_READONLY_RESULT_2026-10-24.md) is recorded and accepted as a diagnostic observation only. The P1 gate is designed against that observed state.
5. **Frozen channel and binding.** The existing SSH endpoint, user, port, host-key pin, identity-file selector, expected unit and expected fragment remain frozen and locally verifiable. Strict host-key checking stays on. No config, alias, proxy, multiplex or credential fallback; no new tunnel or channel. If the channel is unavailable or ambiguous, stop before connection.
6. **New collector and runner variant.** A new collector and runner are built locally in a new directory for this packet. They may copy reviewed RO-1 helpers but must not import or invoke the RO-1 or owner-ID runners, and must not modify any RO-1 or owner-ID file. The P2 start command string appears exactly once in the code, and the runner's state machine cannot send it twice or send any other mutating command.
7. **Independent review.** The variant is reviewed by the implementation review panel described below.
8. **Synthetic checks.** Isolated fixtures and injected transport and timer adapters, never target calls, cover at least: each P1 stop reason; P1 all-pass; systemd version parse, below 235, and the `OnSuccess` rule below and from 249; linger `yes`, `no` and `UNKNOWN` (including nonzero exit and unexpected text); dependency counts, including malformed tokens and overflow; start-step presence `empty`, `nonempty` and gap; P2 exit zero, nonzero and timeout; connection failure before P1 and transport loss between the P1 end marker and the first P2 byte (NOT_STARTED_PRECHECK_STOP); transport loss with the P2 command partially written and after it is fully written (UNKNOWN); P3 stable running; never active; active then exited; failed; still activating at the bound; main PID change; nonzero `NRestarts`, including restarted then stable; poll timing at the 25-second and 30-second limits; identity mismatch mid-poll; parse gap; nonce or framing mismatch; output overflow; local cutoff and overall limit before and after P2 is sent; owner-ID interval relation at each boundary; termination confirmed and not confirmed; consumed and expired attempts; absence of a second start, stop, restart, linger change, log read or downstream action. Real kill and reaping behavior stays unverified and the receipt says so.
9. **Manifest.** An immutable one-use manifest pins this packet, the collector, the runner, the binding, the SSH arguments, each frozen phase template and the limits. It carries the owner GO reference, a fresh job ID, dispatch time and a start-by time at most 10 minutes later. The manifest's execution directory must resolve to the directory the runner runs in.
10. **Marker and nonce.** The runner consumes a new packet-specific exclusive marker before connection, and generates a fresh 16-byte nonce per attempt for phase framing. A consumed or expired attempt is never reset or retried under the same GO.
11. **Id gate.** `Id` must equal the bound unit at P1 and at every P3 poll. A mismatch is a stop or UNKNOWN, never permission to try another name.
12. **Usage and runtime.** Root refreshes usage and local runtime state, preserves the 3% usage reserve and dispatches only the designated operations worker, alone, outside any parallel fan-out. Unknown all usage prohibits execution.

## Review panel

**Packet preparation.** An adversarial review of the first draft by an Opus architecture auditor returned FIXES_REQUIRED with eleven findings, covering checklist waivers, unnamed start side effects, the linger gate, the P2 sent boundary, GO wording, restart-counter semantics, nonce interpolation, the tracked hash rule, poll timing and the interval relation, the activating-at-bound verdict and the status line. This revision applies them under Root's rulings. Before a GO is requested, Root records a preparation evidence record that pins this packet's exact bytes and its review history, as RO-1 did.

**Implementation, after GO and before admission.** Because this is a host-adjacent GO packet, the collector and runner are reviewed by an independent tester and an Opus architecture auditor, plus a second-opinion reviewer. Second-opinion slot: Fable 5.1 is paused by the owner, so an Opus or Sonnet substitute fills it, and the review record names the substitute model. No reviewer grants acceptance.

## Explicit exclusions

No database connection or SQL by the runner or the operations worker; no application API call or authentication flow; no source, snapshot, private Pine or research data. No `/proc` reads, process arguments, environments, environment files, unit-file contents, `systemctl cat`, `systemctl status`, logs, journal, service discovery or host inventory. No alternate unit, user or endpoint. No `loginctl` call other than the one linger read for the SSH user itself; no `enable-linger` or `disable-linger`.

No restart, stop, reload, daemon-reload, enable or disable, reset-failed, repair, configuration or role change; no deployment, target route activation, migration, client installation or service creation. No second start. Do not run or retry S6-OWNER-ID-RO-1 or S6-API-SERVICE-RO-1, continue applicability, change the local input lock or weaken any security guard.

Spot/Paper only; private source local; private acceptance NOT RUN; READY false; P13j/N1 HELD. Native compilation, subprocess or process-fixture tests, database or C3 runtime start (including through unit dependencies), Live, guard reset, Best Inputs apply, optimizer and holdout work remain outside scope.

## Evidence and acceptance

A single completion receipt, kept as ignored local evidence, binds this packet and job, the owner GO reference, the manifest, collector, runner, binding and instantiated command hashes, start and end times, monotonic elapsed time, the transport exit, each phase's exit and byte counts, the P1 labels, counts, flags and gate result, the P2 sent and exit status, the P3 poll count, predicate vectors and pattern, the hash of the sanitized output envelope, termination status and the terminal verdict. The tracked result record follows the privacy rules above and pins only the receipt hash, not the command hashes it contains.

An independent reviewer verifies the receipt linkage, the parsing and the verdict. Root accepts only the observation or failure record. No worker grants acceptance or a new GO. After any outcome, stop and report.

## What remains afterwards for the prototype path

Whatever the outcome, Owner ID stays **UNKNOWN** and applicability stays **UNKNOWN_NOT_QUERIED** after this packet.

- **After VERIFIED_RUNNING.** The next step is a **new, separate read-only owner-ID packet** (for example S6-OWNER-ID-RO-2), with its own reviewed collector version, manifest, marker and fresh owner GO. It must not reuse the consumed S6-OWNER-ID-RO-1 attempt, its job ID or its marker. Its own service guard re-checks the service at that time; a service that stopped again after this packet is a new stop, not a reason to start it again. Its artifact checks supply only scoped artifact association, not a full revision attestation. Only after a successful owner-ID read can the [applicability readback](S6_APPLICABILITY_READBACK_PACKET_2026-10-23.md) be finalized and proposed for its own GO. Private acceptance, READY and the P13j/N1 hold are unchanged.
- **After NOT_RUNNING_AFTER_START.** The prototype path stays blocked at the service. Finding the cause needs either the owner's own inspection on the host or a separately reviewed diagnostic packet. A log or journal read would be a new scope with its own privacy review, because logs may contain secrets or private data. No second start without a new packet and GO.
- **After NOT_VERIFIED_WITHIN_BOUND.** The service state is unsettled at the end of the bound. Report the pattern to the owner. Any further contact, including a read-only re-check, needs its own packet and GO. No second start without a new packet and GO.
- **After UNKNOWN.** Treat the start as possibly effective and the service state as unknown. Report to the owner. Any further contact, including a read-only re-check, needs its own packet and GO.
- **After NOT_STARTED_LINGER_OFF.** Report it. Enabling linger is a separate configuration change by the owner or under its own reviewed packet and GO; a start can be proposed again only after that.
- **After NOT_STARTED_PRECHECK_STOP.** Report the reason. If the service was found already running, the next step is the separate owner-ID packet above. A transport or limit stop before the start was sent changed nothing on the host, but the attempt is consumed; another attempt needs a new owner GO. Otherwise the changed state needs a new look before any start is proposed again.

## Suggested owner approval

> GO S6-API-SERVICE-START-1 for the selected Staging QL-P2 Prototype only. I accept that this starts the existing stopped API user service on the staging host. I confirm checklist items 2, 3, 5, 7 and 9 as answered: [answers or reference]. I confirm items [list] and accept items [list] as named risks. No database access by the runner or operations worker; I accept that the started service connects to its staging database. No database, C3 runtime, capture or scheduler unit is started, stopped or triggered through unit dependencies. I accept that starting the existing service makes its existing routes reachable again on staging; no new route is activated. Build and independently review the start collector and runner first. Then make one attempt in one session over the frozen channel, maximum 120 seconds: one pre-check including the linger gate, at most one start of the exact unit, and bounded post-start checks. If more than 24 hours pass between this GO and dispatch, ask me to re-confirm the checklist first. No retry, restart, stop, reload, enable, linger change, log read, configuration change, migration, deployment, owner-ID read or applicability continuation. Leave the service as it is afterwards unless I say otherwise. Keep all existing gates.

No such GO is recorded by this preparation.
