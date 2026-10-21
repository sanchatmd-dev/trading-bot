# Claude cloud root checkpoint, 2026-10-21

The first Claude cloud root ("Root: astra-vps-trade-bot-v2") wrote this checkpoint before the owner moved the root to a cloud environment used only for this project. The earlier cloud environment was shared with another project and carried that project's settings (a process-wide `NODE_OPTIONS` heap flag and cloud credentials this project does not use). Read [the local-to-cloud handoff](CLAUDE_LOCAL_TO_CLOUD_ROOT_HANDOFF_2026-10-21.md) first; its rulings and rules still apply. This file records only what changed after it.

## Git state

Branch `codex/app3a-market-wait-checkpoint-gwylmk`. The owner authorized the cloud root to commit and push verified slices to this branch, without force. Commits since the handoff commit `d9a6dce`:

- `296bd64` docs: the documentation fixes D1 to D7 (Bangkok dates, links, contract row dates, status split, Roadmap and contract wording, mutation and import-guard wording). CI passed.
- `ae546bf` test: the side session's change that bounds the server readiness waits by wall time (cherry-picked from `claude/readiness-wall-time-deadlines`, commit `71932a9`; its other commit was already on the branch). CI passed.
- `cf0dc83` feat: F11 RS-5, the internal fixture admission service (RD-MP-23, [evidence](evidence/PM1_F11_01_FIXTURE_ADMISSION_RS5_LOCAL_2026-10-21.json)). CI was running when this checkpoint was written; check it first.

The owner chose to redo RS-5 and D1 to D7 in the cloud; the local `stash@{1}` is not used. `stash@{0}` (the owner's protected files) stays untouched.

## Test environment recipe

The cloud container image had Node 22; the project needs Node 24. Each item below was done by hand in the old container and must be repeated (or put in the new environment's setup script):

1. Node 24: download `node-v24.22.0-linux-x64.tar.xz` from nodejs.org, check it against `SHASUMS256.txt`, unpack it and put its `bin` first on PATH.
2. `npm ci`, and in `quant_lab/`, `uv sync --locked --all-extras`.
3. Unset `NODE_OPTIONS` for test runs if the environment sets it: a `--max-old-space-size` flag overrides Worker `resourceLimits` and makes the QR2 heap-limit test time out.
4. PostgreSQL 16 test clusters: `initdb` refuses root, so create each cluster as the `postgres` user outside the scratch directory (the harness resets scratch to mode 0700, which kills a cluster inside it): `initdb -U robot_test -A scram-sha-256 -E UTF8 --locale=C`, start with `-p <port> -c max_connections=100`, create database `robot_test`, and set `TEST_DATABASE_URL=postgresql://robot_test:<password>@127.0.0.1:<port>/robot_test`, `PG_DUMP_PATH` and `PG_RESTORE_PATH` to the version 16 binaries. Give each concurrent tester its own port.

Baseline on `d9a6dce` in that container: the PostgreSQL suite passed 1327 of 1334 with 0 fail and 7 skipped. The cluster-restart readback test skips because `FREEZE_TEST_PG_BIN` needs a non-root `initdb`.

## Open items found in the cloud

- **PF-2 R4 real-process tests.** With the Python environment installed, three subtests of `test/preflight-runtime.test.js` fail in a container without a systemd user manager: on Linux the supervisor always launches through `systemd-run --user` and correctly refuses to confirm a stop it cannot prove (`QUANT_PROCESS_STOP_UNCONFIRMED`). CI never runs them (the unit job has no venv, and `quant-lab.yml` does not run this file), so the Linux real-process path of R4 has no automated evidence. Proposed and not applied, owner decision: a test-only capability gate that skips with a reason when `systemctl --user` is unavailable and still fails under `PF2_REQUIRE_PYTHON=1`; real evidence needs a host with user systemd and cgroup v2, which is an operations step under a fresh owner GO.
- **Heap flag in production.** No deploy file in the repository sets `--max-old-space-size`. If the VPS ever starts node with it, the QR2 worker heap cap is silently disabled. Not checked on any host.
- **RS-5 residuals** are listed in the evidence record and RD-MP-23 (authorization checked once outside the transaction; a first-attempt same-key race can turn a LOAD into a check refusal).

## Next work

Unchanged from the handoff: RS-6 needs the combined Python evaluator and root items R5, R7, R11 and R12; the multi-Pine package slice needs R6; QR-3 S3 and QR-4 S3 need FE-2b; QR-2 S4-4 and S4-5 need the owner's OW1 to OW10 decisions. The N1 terminal-evidence line stays held. No host, VPS, browser or TradingView work from the cloud; Spot/Paper only.

## Usage

The cloud root could not read account usage itself. At the handoff the owner reported 5h 11%, weekly 74% and Fable 17%; the owner allowed work down to 2% remaining. Read usage before the next wave.
