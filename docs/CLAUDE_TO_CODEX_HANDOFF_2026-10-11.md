# Claude to Codex: whole-project handoff, 2026-10-11

The owner asked for a checkpoint and a handoff of the whole project and the latest work to Codex. Claude has stopped dispatching, and every child assignment is complete. Since the Codex handoff of 2026-10-10, Claude worked locally, and it made one read-only host contact: the capability capture of 2026-10-11, approved by the owner. No deployment, service change, measurement epoch, enrollment or Live action occurred. Codex must revalidate the checkout and take sole command before resuming work.

## Read order and authority

1. Read the private `.qa-local/claude-to-codex-handoff-2026-10-11.md` first. It holds the local artifact index, the host facts that cannot be tracked, and the step log.
2. Read this document, then the latest evidence:
   - [capability capture](evidence/R7B_LPG_CAP_2026-10-11.json);
   - [sealed package candidate 2](evidence/R7B_LPG_PACKAGE_RC2_LOCAL_2026-10-10.json);
   - [timestamp correction](evidence/R7B_TIMESTAMP_CORRECTION_2026-10-10.json).
3. Read `AGENTS.md`, `.agents/skills/caveman/SKILL.md`, `.agents/TASK_PACKET_TEMPLATE.md` and the current top sections of [Roadmap](ROADMAP.md), [Time Management](TIME_MANAGEMENT.md), [README](../README.md) and [Context](../Context.md).
4. For the whole-project status by owner step, the [Codex handoff of 2026-10-10](CODEX_TO_CLAUDE_HANDOFF_2026-10-10.md) is still current. No product code, release or runtime state changed since then.

Roadmap owns implementation priority. This handoff transfers context; it issues no GO. Two owner decisions are open and block J1 (see below).

## Whole-project status

The six owner steps and their gates are unchanged from the 2026-10-10 Codex handoff:
- Step 1 (chatbot and Bridge), Step 2 (inputs), Step 3 (Preflight and Risk Manager), Step 4 (signal and Paper execution), Step 5 (optimizer) and Step 6 (Research Library) are each at the state that handoff records.
- The active gate is still R7: measure capacity with a sealed, isolated PostgreSQL harness before any new measurement epoch.
- Spot/Paper-only holds. The old QL-3A OPEN allocation is unresolved, and its old alert must stay stopped.

## Work completed by Claude since the Codex handoff

Counts belong to separate suites and revisions; do not add them up.

| Checkpoint | Scope | Limits |
| --- | --- | --- |
| [Harness v4](evidence/R7B_LINUX_PG_V4_PRODUCER_LOCAL_2026-10-10.json) | H-12b and H-13 built (`9527d9c4`) | Injected simulation only |
| [Harness v5](evidence/R7B_LINUX_PG_V5_STATEFUL_H15_LOCAL_2026-10-10.json) | H-7b/c/d and H-15 built (`a9becea2`); all 19 legacy cases plus `startup-schema` now defined | Found the stop-proof Job defect in the measurement tool |
| [Tool v3 and harness v6](evidence/R7B_LINUX_PG_V6_TOOL_V3_LOCAL_2026-10-10.json) | The measurement tool expects the empty `Job=` line (`89cdc7c9`); the harness was re-pinned (`148a43ec`) | The capability capture later confirmed the empty line on the host |
| [Helpers on tool v3](evidence/R7B_HELPERS_TOOL_V3_LOCAL_2026-10-10.json) | Root helpers read tool v3; no helper code change | Local only |
| [Harness v7](evidence/R7B_LINUX_PG_V7_ACCOUNTING_LOCAL_2026-10-10.json) | Accounting review of H-1, H-4 and H-5 and fixes (`41f76f04`) | No PostgreSQL ran |
| [Package candidate 2](evidence/R7B_LPG_PACKAGE_RC2_LOCAL_2026-10-10.json) | Sealed 434-file package (`78e9e5a8`), harness v8.1 (`80379cac`), 13 adapter modules, integration contract, two Opus audits, two independent tester passes (21 of 21 safety mutations killed) | Nothing ran on Linux or PostgreSQL. Disk mechanism B is refused until its fixes land |
| [Capability capture](evidence/R7B_LPG_CAP_2026-10-11.json) | One read-only capture on the VPS, no host writes | J1 blocked; see below |

The package design, contract, audits and runbook are ignored local files, frozen with the candidate:
- `.qa-local/claude-r7b-lpg-pkg-rc2-78e9e5a8/`
- `.qa-local/claude-r7b-linux-pg-v8.1-checkpoint-80379cac/`
- `.qa-local/claude-r7b-lpg-cap-v1-checkpoint-36b3f815/`

A Git clone does not contain them. Use the existing workspace.

Timestamp correction: on 2026-10-10 Claude wrote estimated UTC times into six evidence files and the time log. They ran 0.9 to 4.4 hours ahead. The correction record gives the real times; the original files are unchanged. Read the clock before writing any time.

## Last known runtime (capability capture, 2026-10-11 02:26 to 02:29 UTC)

**Host:**
- Ubuntu 24.04, systemd 255, user lingering on.
- cgroup v2 with cpu, io, memory and pids delegated to the user manager; memory and pids peaks and `cgroup.kill` are present.
- 2 CPUs, 7.8 GiB memory (6.6 GiB available), load near zero, 88 GiB free disk, 2 SysV segments.

**Paper units:** all were in their expected states with no pending jobs, and the staging research worker stays stopped. The production and staging databases run as user units from a PostgreSQL 16 runtime in the service user's home. There is no system PostgreSQL unit or package.

**Job line:** systemd prints an empty `Job=` line with and without `--all`.

Health endpoints and flags were not checked in this capture.

## Open owner decisions (block J1)

1. **Disk cap and sandbox.** Unprivileged user namespaces are off (Ubuntu 24.04 AppArmor default). A user unit therefore gets neither the tmpfs disk cap (mechanism A) nor path hiding. Options:
   - **(a)** Use the owner's already-approved fallback B (disk watchdog plus IO limit, a recorded exception), finish its two audit items, and add a JS guard that lets the suite child connect only to the harness socket. The production database socket then stays reachable in principle. Claude recommends (a).
   - **(b)** The owner enables unprivileged user namespaces on the host, a host-wide security setting.
   - **(c)** Pause.
2. **Host tools.** The Node binary (version manager) and the PostgreSQL 16 runtime are owned by the service user, so the strict immutability rule refuses them. Options:
   - **(a)** A hash-pinned exception that uses the same binaries as the product, checked before and after each job. This needs a small harness change and an audit. Claude recommends (a).
   - **(b)** The owner installs root-owned Node 24 and PostgreSQL 16 binaries; the package must not create or start a cluster.

## Next bounded work

1. Recheck Git, file ownership, usage and the frozen snapshot hashes.
2. Build candidate 3 in a new namespace copy. Keep the candidate 2 snapshot immutable. Changes:
   - **Fix first, whatever the owner decides.** `createNodeIo` builds file metadata from bigint stat values and mixes BigInt with Number, so every real stat or lstat fails. Fakes hid it. Fix it and add a real-filesystem test, then rebuild the capability module on the new pin and give it the product PostgreSQL library dir.
   - **If 1(a) is chosen:**
     - the watchdog must fail closed (A1-04);
     - the controller creates `data/`, `socket/` and `tmp/` with recorded inodes and gains a root-ordered `prove --remove-runtime` (A1-08);
     - add the socket-connect guard and carry its counter through the harness, the driver capture and the pass-coherence check;
     - record the owner's exception id in the run packet;
     - then lift the controller's mechanism-B refusal.
   - **If 2(a) is chosen:** add a hash-pinned host-tool exception mode (harness v8.2, run binding, driver, capability evaluator).
   - **Low fixes:** A1R-01 to A1R-05 and a controller acknowledge command for a lock held after a failure.
3. Rebuild twice (reproducible), run an independent tester, run a focused audit, and update the runbook.
4. Ask the owner for a second capability capture, a new GO, to complete the Node and PostgreSQL facts.
5. Then ask for the J1 GO. Each job J1 to J4 needs its own owner GO.

All three execution locks remain: `LOCAL_CANDIDATE_NOT_RELEASED`, `ENABLED_CONFIG_AND_BUDGET_REVIEW_REQUIRED`, `HARNESS_VPS_PACKET_REQUIRED`. These still hold: BINANCE:BTCUSDT Spot 1m, reduce-only EXIT, immutable research evidence and independent holdout gates. Also in force:
- no guard reset, Best Inputs apply, optimizer or data-range loop, production configuration change or Live activation;
- no replay of closed GOs;
- the W7 C2 CRASHED record is never reset, reopened, edited or deleted.

## Checkout, ownership and transfer

**Branch and commits:**
- Branch `codex/app3a-market-wait-checkpoint`.
- HEAD `18ca8fc` (capability evidence), on `57e1ebe` (candidate 2 evidence and timestamp correction), both pushed. Hosted CI passed on `57e1ebe` (docs-only); `18ca8fc` was not checked.
- This handoff file is the only new tracked change.
- Two dated PNG files and `scripts/build-spt-exit-diagnostic.mjs` remain untouched owner files.

**Usage:** Claude usage at handoff was 57% weekly and 2% in the 5-hour window, with the 15-point reserve in place. Codex must read its own usage.

**State at hand-over:** no Claude agent, workflow, timer or host session is active. Existing services were not touched by the handoff. Once this checkpoint is saved, Claude yields command; no Codex session was launched or messaged automatically.
