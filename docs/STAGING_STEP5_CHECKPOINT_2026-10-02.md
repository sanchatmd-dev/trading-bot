# Step 5 staging continuation — 2026-10-02

## Scope and authority

Codex received the [Claude handoff](CLAUDE_TO_CODEX_HANDOFF_2026-10-02.md), verified the checkout against the remote at `e57dbfc`, and resumed the six-step staging prototype at the owner's request. The owner explicitly reduced the usage reserve to two percentage points for this continuation. This does not authorize Live execution, production changes, automatic application of results, guard resets or repeated optimizer submissions.

The immediate deliverable is an owner-facing research-job panel, followed by a reviewed staging release and one bounded optimizer run. The research engine stays unchanged. PF-2 activation remains a separate acceptance gate; the research optimizer does not require B3, W7, D6 or R7 first.

## Verified starting state

Read-only staging checks at 08:46 and 08:49 UTC confirmed:

- API and trading worker on `f36181c`; research worker on `3309d07`, FOUNDATION idle, with admission closed.
- Health `PAPER_ONLY`, schema 14, 66 tables and no active research or foundation jobs.
- API and research worker have identical hashes for all 78 research engine files.
- The existing eligible SPT deployment is READY, with a fresh snapshot and the previously approved ten-dimension input lock.
- The declared dataset has 6,600 contiguous verified bars, with no invalid bar, metadata, profile or hash checks and no overlap with the earlier holdout.

These observations certify the starting checkpoint only. Deployment and job submission require fresh operational checks. Private receipts and host bindings remain in the ignored operations checkpoint.

## Declared run

Use the existing approved input domains and frozen Bot policy, capital and session. The dataset covers 2026-09-27 17:31 UTC through 2026-10-02 07:30 UTC, inclusive. Its 6,600 bars comprise 3,250 warm-up bars, 2,010 training bars, 670 validation bars and 670 holdout bars.

The candidate budget is 21, with seed `20261002` and a 900-second deadline. Reconstructing the approved lock produces 21 candidates covering all ten dimensions and at most 46 evaluations. The deadline is a limit, not a completion guarantee. Keep terminal failures, timeout, cancellation and `NO_VALID_CANDIDATE` as evidence; do not change ranges or submit another run automatically.

The optional B3 canary is deferred to the later W7 work. Close research admission after the run and verify worker cleanup separately from the research result's terminal status. A result remains research evidence; candidate recommendation and application retain their independent acceptance gates.

## Implementation and release status

The research-job UI passed independent local acceptance. It loads a preserved run's eight source inputs plus ATR/RR, requires an explicit UTC dataset, displays a readable frozen request, and supports explicit submission, idempotent retry, bounded polling, cancellation and access to the Research Library. A terminal job offers an explicit preparation action that checks admission again without submitting another job. The Prototype journey opens this panel and distinguishes its admission gate from PF-2 activation.

The initial independent UI/data regression run passed 61 tests. Browser testing found that the translation observer removed appended API error codes; a focused correction preserves them as inert text. The corrected snapshot passed 18 focused tests and 34 independent browser checks using isolated fixtures, including actual service projections and the real input-lock validator. Root reviewed the 1280-pixel English and 375-pixel Thai confirmation screenshots. No research engine or server file changed.

Independent review found two inherited switch-tool defects: failed systemd queries could be counted as zero jobs or zero reload needs. Their corrections passed independent verification with 11 fault probes and four helper cases. Unknown evidence now blocks restart and remains visible in recovery results. The accepted tool preserves the existing engine and supports rollback to `f36181c`.

UI checkpoint `7934265` was pushed. Its Quant CI passed; the Ubuntu unit job exposed two older Bridge and PF-3 tests that still expected the previous i18n/journey cache tokens. The assertions were updated without changing product files. Replacement checkpoint `c3fa9e5` passed [Safety checks](https://github.com/sanchatmd-dev/trading-bot/actions/runs/36991674853) and [Quant Lab CI](https://github.com/sanchatmd-dev/trading-bot/actions/runs/36991674939).

The immutable release contains 753 files: 571 source files and 182 dependencies. Local hash and archive checks passed. Windows filesystem permission mapping could not reproduce the extractor's Linux mode checks, so that failed local check remains recorded as a platform limitation. The unchanged extractor passed hash, type, permission, syntax and import checks on Linux before publishing an inactive release at 10:08 UTC.

Following fresh health and idle checks, staging API and trading worker switched to `c3fa9e5` at 10:13 UTC. The immediate postcheck passed at 10:13:59 UTC: all 12 served assets matched, five unauthenticated routes retained their guards, health remained `PAPER_ONLY`, and no active research or foundation job appeared. The research worker, database, market stream and production processes were preserved. The delayed postcheck passed at 10:24:42 UTC using the original switch attribution window; the same releases, guards, idle state and configuration hashes held. This verifies deployment; the owner's signed-in browser walkthrough remains separate.

The research worker switched to the verified isolated Python wrapper at the later 13:33 UTC checkpoint below. The sections below record the first submission's readiness failure, the bytecode-cache correction and the declared run's result.

Read-only Python discovery at 10:25–10:29 UTC found all seven required dependency distributions and confirmed the pinned operating-system interpreter is Python 3.12.3. The first probe stopped because the virtual environment uses `version_info` rather than `version`; the follow-up resolved that metadata-format difference. An editable-package path points to an older release outside staging. The reviewed copy helper excludes that pinned path and bytecode from the staging copy while preserving the source.

The full source inventory passed at 11:15 UTC. A separate bounded copy began at 11:18 UTC and stopped at 11:24 UTC because the import smoke reported `MODULE_ORIGIN_ESCAPE`. The partial environment was preserved and was not activated. Read-only reconciliation completed at 11:32 UTC: all 6,658 source entries matched the earlier manifest, the 6,026-entry target passed ten integrity checks, and neither the staging copy nor the research release contained bytecode. Health, admission and existing service identities passed the 11:29 UTC check.

The operating-system `sitecustomize.py` is a symlink to an exact reviewed file outside the original standard-library allowlist. A separate recovery verifier permits only that exact module name, raw path, resolved path, content hash and 155-byte size; all other module and native-library checks remain intact. Its first attempt stopped at `SMOKE_DIAGNOSTICS_BOUND`, which did not prove that the smoke passed. Read-only reconciliation again proved source and target unchanged at 11:53 UTC. A separate revision increased the bounded stdout report allowance and added output size/hash diagnostics; independent review passed nine focused checks.

Recovery verification passed at 12:00:47 UTC after 293 seconds. It retained the existing copy and verified 668 module origins, 100 raw and resolved native mappings, the pinned operating-system hook, staging prefixes, disabled bytecode and exact source/target/research-release/wrapper inventories before and after the smoke. Root independently checked the returned origins and found no unexpected module or canonical native path. The successful smoke report is 135,906 characters when compactly serialized, exceeding the earlier 131,072-character allowance. This successful attempt does not recover the discarded output from the earlier failure.

Final health and capacity checks passed at 12:01:16 UTC with no active test process or research job. Selected Python, loader and virtual-environment override keys were absent from both the existing worker process and user manager; values were not disclosed. That observation is not a proof of a future restarted worker or transient job environment. The isolated interpreter is accepted only for the declared import smoke; unexecuted imports, lazy loads, worker activation and a real optimizer run remain unproved. No configuration layer was added, no service restarted, and admission remained closed during this recovery.

## Verification limits

### Research-worker interpreter activation — 2026-10-02

The reviewed worker tool adds only an exact interpreter override, preserves the previous configuration layers and keeps API admission closed. Independent fault testing found that a restart timeout could lead to an automatic second restart during backout. The corrected tool stops on every activation failure, preserving the new configuration and evidence for named read-only reconciliation. Healthy explicit rollback is available; failed-worker or invalid-environment recovery requires a separately reviewed packet. That limitation was accepted for supervised idle staging work under the owner's downtime authority.

The first Linux precheck stopped before any configuration write because its environment probe read only the initial process environment. The actual interpreter came from Node's env file and had not changed. The corrected probe verifies the worker command against its pinned configuration, reads only those approved env files in order, then applies process-environment precedence. It passed 59 author checks and 11 independent checks, in addition to the earlier four independent stop-on-failure checks. Corrected Linux precheck passed at 13:28:04 UTC, including actual I/O limits, SQL idle state, effective environment and the prepared Python inventory.

Activation ran from 13:30:24 to 13:33:15 UTC. One configuration override, one user-manager reload and one research-worker restart selected the staged wrapper. The new worker logged successful startup and passed effective-environment, release, I/O, file-integrity and idle checks. API, trading, database, market and production process identities were preserved. The delayed check ran from 13:43:35 to 13:44:56 UTC and passed: the worker process and start identity were unchanged, its journal contained exactly one startup and no recorded errors since activation, and no test process or research job remained. Prepared files, configuration, I/O limits and closed admission were unchanged. No child Python research evaluation ran: worker configuration acceptance is separate from a real optimizer run and its process-isolation evidence.

The next slice is an independently reviewed API admission open/close path, followed by the single declared run through an authenticated owner session. Do not leave admission open while submission access is unavailable. The owner's current reserve is 4%, superseding the earlier continuation's 2% exception.

### First submission and readiness failure — 2026-10-02

A reviewed admission tool opened API research admission at 15:15:10 UTC. The owner submitted the declared request at about 15:23 UTC through an authenticated session. The job failed at 15:23:26 UTC with `QUANT_IO_GATE_FAILED` after one evaluation in the candidate phase; its foundation job was cancelled after 6,104 ms. Admission closed at 15:30:11 UTC. The terminal proof found no active research or foundation job, no research child unit, no open launch and no unsettled ledger operation. The research worker was not changed.

The research child must report readiness within 3,000 ms. The isolated interpreter runs with bytecode writing disabled, and neither the release sources nor the staged packages contain bytecode, so every child compiled its whole import closure. That took about 1.5 seconds of CPU, which under the child's 50% CPU quota is about 3 seconds of wall time, and the launcher stopped the unit at its deadline. The host has no swap and showed no input/output activity for the unit.

### Read-only bytecode cache — 2026-10-02

A reviewed tool built a separate bytecode tree once, inside a throttled transient unit. It compiled 2,011 source files from the release, the staged packages and the operating-system standard library with hash-checked invalidation, with no compile failures (38.2 MB in total). The files are read-only and a manifest hash pins the tree. A new wrapper differs from the accepted one only in pointing Python at that tree; bytecode writing stays disabled. A new worker override selects that wrapper and leaves the earlier layers in place.

Before activation, two import-only units with the research child's exact CPU, memory, task and input/output limits had to finish within 1,500 ms, with every imported Python module served from the cache. The first attempt measured 1,160 ms but stopped on coverage: 563 of 564 modules. The one module left over is the operating system's `sitecustomize`, a symbolic link that the builder skips. The tool was amended to accept exactly that named module and re-run, measuring 990 ms and 1,060 ms, with the cache and the release unchanged afterwards. Activation at 16:45:28 UTC used one override, one user-manager reload and one research-worker restart. The delayed check passed at 17:00:04 UTC.

The admission tool's first precheck after activation stopped because its closed-state baseline predated the new override. The corrected baseline was read back and verified, and the precheck passed at 17:05:06 UTC.

### Declared run result — 2026-10-02

The owner approved correcting the failure and repeating the same declared request once. Admission opened at 17:20:10 UTC after a read-only import warm-up of 610 ms, and the owner submitted once. The job ran from 17:25:29 to 17:28:50 UTC and finished `NO_VALID_CANDIDATE` in phase `COMPLETE` on its first attempt:
- 21 evaluations of 21 candidates from the approved lock, covering all ten dimensions;
- seed `20261002`;
- completion reason `NO_VALID_TRAIN_VALIDATION_CANDIDATE`.

The holdout was not evaluated, no candidate was selected and no owner recommendation is ready. The foundation job succeeded in 200,662 ms across one preparation chunk and 21 candidate chunks.

Admission closed at 17:45:11 UTC. The terminal proof at 17:45:39 UTC found no research child unit, no active research or foundation job, no open launch and no unsettled operation. The API returned to its closed configuration and the research worker kept the cache wrapper. This result is research evidence. Do not change ranges or submit another run automatically.

Open follow-ups:
- Compile symbolic-link modules into a new cache so the named exception can be removed.
- Measure readiness with a cold page cache, since the child reads at 512 KiB/s.
- Give the earlier worker checks a post-run adapter, because the job totals changed from two to three.

### Browser and research-result limits

The interactive browser and Computer Use runtimes failed during initialization before any UI action. The tester instead used installed Edge with a separate headless profile and intercepted synthetic fixture responses. These checks are not the owner's signed-in staging acceptance, a PostgreSQL integration run or a real worker run. The fixture failures involving an unavailable Chromium binary, an insecure origin and a translated-word assertion were recorded separately from product defects.

After deployment, automatic approval review blocked the command to start a local SSH tunnel before execution, without a more specific reason. No tunnel was created. Server deployment succeeded, but access through the local preview address has not been restored or verified.

Unknown submission recovery retains the frozen request and key in owner-scoped memory. A browser reload loses that memory; inspect the Research Library before preparing a new request after an uncertain submission. Seeding currently lists the most recent 20 preserved runs. The independent Claude peer worktrees remain outside this change.
