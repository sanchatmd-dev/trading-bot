# Claude cloud root checkpoint, 2026-10-21

The first Claude cloud root ("Root: astra-vps-trade-bot-v2") wrote this checkpoint before the owner moved the root to a cloud environment used only for this project. The earlier cloud environment was shared with another project and carried that project's settings (a process-wide `NODE_OPTIONS` heap flag and cloud credentials this project does not use). Read [the local-to-cloud handoff](CLAUDE_LOCAL_TO_CLOUD_ROOT_HANDOFF_2026-10-21.md) first; its rulings and rules still apply. This file records only what changed after it.

## Git state

Branch `codex/app3a-market-wait-checkpoint-gwylmk`. The owner authorized the cloud root to commit and push verified slices to this branch, without force. Commits since the handoff commit `d9a6dce`:

- `296bd64` docs: the documentation fixes D1 to D7 (Bangkok dates, links, contract row dates, status split, Roadmap and contract wording, mutation and import-guard wording). CI passed.
- `ae546bf` test: the side session's change that bounds the server readiness waits by wall time (cherry-picked from `claude/readiness-wall-time-deadlines`, commit `71932a9`; its other commit was already on the branch). CI passed.
- `cf0dc83` feat: F11 RS-5, the internal fixture admission service (RD-MP-23, [evidence](evidence/PM1_F11_01_FIXTURE_ADMISSION_RS5_LOCAL_2026-10-21.json)). CI passed on every pushed commit through `6c78131`. Later commits are not yet checked here; check CI first.

The owner chose to redo RS-5 and D1 to D7 in the cloud; the local `stash@{1}` is not used. `stash@{0}` (the owner's protected files) stays untouched.

## Test environment recipe

The cloud container image had Node 22; the project needs Node 24. Each item below was done by hand in the old container and must be repeated (or put in the new environment's setup script):

1. Node 24: download `node-v24.22.0-linux-x64.tar.xz` from nodejs.org, check it against `SHASUMS256.txt`, unpack it and put its `bin` first on PATH.
2. `npm ci`, and in `quant_lab/`, `uv sync --locked --all-extras`.
3. Unset `NODE_OPTIONS` for test runs if the environment sets it: a `--max-old-space-size` flag overrides Worker `resourceLimits` and makes the QR2 heap-limit test time out.
4. PostgreSQL 16 test clusters: `initdb` refuses root, so create each cluster as the `postgres` user outside the scratch directory (the harness resets scratch to mode 0700, which kills a cluster inside it): `initdb -U robot_test -A scram-sha-256 -E UTF8 --locale=C`, start with `-p <port> -c max_connections=100`, create database `robot_test`, and set `TEST_DATABASE_URL=postgresql://robot_test:<password>@127.0.0.1:<port>/robot_test`, `PG_DUMP_PATH` and `PG_RESTORE_PATH` to the version 16 binaries. Give each concurrent tester its own port.

Baseline on `d9a6dce` in that container: the PostgreSQL suite passed 1327 of 1334 with 0 fail and 7 skipped. The cluster-restart readback test skips because `FREEZE_TEST_PG_BIN` needs a non-root `initdb`.

## Open items found in the cloud

- **PF-2 R4 real-process tests.** With the Python environment installed, three subtests of `test/preflight-runtime.test.js` fail in a container without a systemd user manager: on Linux the supervisor always launches through `systemd-run --user` and correctly refuses to confirm a stop it cannot prove (`QUANT_PROCESS_STOP_UNCONFIRMED`). CI never runs them (the unit job has no venv, and `quant-lab.yml` does not run this file), so the Linux real-process path of R4 has no automated evidence. The owner approved a test-only capability gate, now applied: the three subtests skip with a reason when `systemctl --user` is unavailable and still fail under `PF2_REQUIRE_PYTHON=1`; the supervisor is unchanged. Real evidence needs a host with user systemd and cgroup v2, which is an operations step under a fresh owner GO.
- **Heap flag in production.** No deploy file in the repository sets `--max-old-space-size`. The QR2 compute pool now fails closed: it refuses to start under such a process-wide flag (RC-Q40, four flags after `9842392`). Local engineering evidence only; not checked on any host.
- **RS-5 residuals** are listed in the evidence record and RD-MP-23. RD-MP-35 (`2b8d398`) later closed those two residuals by re-checking authorization and the key inside the transaction, and records one new fixture-only residual.

## Next work

RS-6 S1 and S2 have landed (R5, R11); RS-6 S3 is next (R7, R12). The F1 to F30 acceptance with the private source happens later in the owner's local checkout (RD-MP-34). The multi-Pine package slice needs R6; QR-3 S3 and QR-4 S3 need FE-2b; QR-2 S4-4 and S4-5 need the owner's OW1 to OW10 decisions. The N1 terminal-evidence line stays held. No host, VPS, browser or TradingView work from the cloud; Spot/Paper only. The other open owner items are unchanged from the local-to-cloud handoff, and F09 OQ-1 was added.

## After the checkpoint

Local engineering evidence only; nothing installed, no host step, no GO. Check CI first.

- `629bcb4` the QR-2 compute pool refuses to start under a process-wide heap flag (RC-Q40).
- `be8e02e` the PF-2 R4 real-supervisor tests skip without a systemd user manager.
- `7847a05` the All Bots card shows book equity per currency (RC-Q41; JSDOM only).
- `5f1f8aa` the combined evaluator and RS-6 rulings recorded (RD-MP-24 to RD-MP-34).
- `6c78131` the owner's answers on the acceptance machine and readings (RD-MP-34).
- `05e7a47` RS-6 S1 and S2, the combined Paper evaluator and its Node oracle.
- `9842392` the heap guard covers three more flags.
- `2b8d398` RS-5 residual hardening: authorization and key re-checked inside the transaction (RD-MP-35).
- `e38db9d` oracle count maps free of prototype keys.
- `8af42ab` non-finite admission input refused; T2 read order pinned.
- `8f2b364` the F09 builder S3 trace-reproduction design and root rulings R1 to R11; owner question OQ-1 open.
- `8b10102` container paths dropped from the F09 design judgement.

## Usage

The cloud root could not read account usage itself. At the handoff the owner reported 5h 11%, weekly 74% and Fable 17%; the owner allowed work down to 2% remaining (AGENTS.md sets the floor at 3%; the owner set 2% for named continuations on 2026-10-19 and restated it on 2026-10-21). Read usage before the next wave.
