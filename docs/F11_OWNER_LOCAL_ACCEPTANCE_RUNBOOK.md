# F11 owner-local acceptance preparation

Prepared on 2026-10-22 (Bangkok) from [RD-MP-34 and RD-MP-50](MULTI_PINE_CONTRACT.md), the [root handoff](CLAUDE_TO_CODEX_CLOUD_ROOT_HANDOFF_2026-10-22.md), and the [R6 engineering record](evidence/PM1_F11_01_R6_LOCAL_2026-10-22.json). This is an execution guide, not an acceptance result or a deployment GO. Private acceptance remains NOT RUN. The cloud root must never receive or execute the private files.

## Prerequisites the owner supplies locally

1. Use `codex/app3a-market-wait-checkpoint-gwylmk`, containing `d8a9c6f` or a reviewed successor, with a clean working tree. Record the exact revision used for the complete acceptance record.
2. **O1:** place `spt-spot-v4.pine`, `analysis-m1.json` and `analysis-m2.json` in one Git-ignored directory outside `test/fixtures`. Set `MP_PRIVATE_INPUTS_DIR` locally to its absolute path, because the Node preflight and Python P0 use different working directories. The directory and repository roots are resolved through real paths; linked files and oversized files are refused. Do not put these files in chat, tracked files, CI artifacts or shared logs.
3. **O2:** record the two analysis files' raw SHA-256 and effective-input hashes in `test/fixtures/mp-combined/private-inputs.manifest.json`, review that hash-only diff, and commit it locally before running. Never weaken the reviewed source pin to make a different source pass. Raw-byte line endings matter; a CRLF checkout can differ from committed LF bytes. The manifest and `src/quant-research/contract.js` must match HEAD.
4. **O3:** record whether both reviewed analyses carry the committed M1/M2 fixture values. Different values can produce different counts or `NO_VALID_CANDIDATE`; a failed check does not authorize calibration, a new search or a changed data range.
5. **O7:** explicitly decide whether fixture-labelled member-2 derived variants may run. Only after permission, set `MP_ACCEPTANCE_O7=yes`. Otherwise P7/P8 use synthetic fixtures and their SYN results do not establish private coverage.
6. Verify Node 24 and the locked `quant_lab` environment. Set `QUANT_RESEARCH_PYTHON` to that environment's interpreter if automatic `.venv` discovery is unsuitable. Do not use a bare Python missing the project packages.
7. Create a dedicated, disposable PostgreSQL 16 cluster with SCRAM authentication, at most 100 connections, and matching `pg_dump`/`pg_restore`. The test administrator must be able to create/drop fixture databases and roles and establish the required database log controls. Set `TEST_DATABASE_URL` locally, without publishing credentials. Set `MP_PRIVATE_FRESH_CLUSTER=1` only for a cluster created for this run whose data directory will be disposed of afterwards. An empty database in a shared cluster is insufficient.

Do not enable `MP_ACCEPTANCE_DRY_RUN` for private acceptance. Set `MP_REQUIRE_PRIVATE=1` so absent inputs fail instead of silently skipping. PX is optional and requires a separately chosen `MP_ACCEPTANCE_OPERATOR_PATH=1`; do not assume it ran.

## Run order and evidence boundaries

Run source-independent regression on the same reviewed revision first, with the private-input environment variables absent. `npm test`, the `quant_lab` suites, and `npm run test:postgres` cover the previously committed pure, oracle, isolation and one-Pine regression suites. Use a separate disposable synthetic cluster for the PostgreSQL regression, one test file per process as the npm script specifies. Never reuse that cluster for the private run. Existing CI evidence is useful but does not turn skipped private cases into passes.

Before P0, validate the owner-local inputs through the hardened Node reader and its existing pin/fresh-cluster preflight. This read-only preflight creates no acceptance result and no fixture database. From the repository root, with the prerequisites above set, run:

```sh
node --input-type=module <<'JS'
import {privateGate, repositoryFacts, assertCommittedPins} from './test/helpers/mp-private-inputs.mjs';
import {privateClusterPreflight} from './test/helpers/mp-acceptance-world.mjs';
const result = await privateGate(process.env, undefined, {
  beforeRead: async () => {
    assertCommittedPins(repositoryFacts());
    await privateClusterPreflight();
  }
});
if (result.state !== 'ready') {
  console.error('PRIVATE_PREFLIGHT_REFUSED');
  process.exitCode = 1;
} else {
  console.log('PRIVATE_PREFLIGHT_READY');
}
JS
```

The example uses a POSIX shell; on Windows use an equivalent local Node module. Do not proceed after a refusal. The preflight checks the cluster before reading private file bytes; database log controls are proved later, before the harness writes private bytes to its databases.

**P0:** run the Python private projection and HOLDOUT cases locally before the Node case flow. In `quant_lab`, using the already synchronized environment:

```sh
uv run --no-sync pytest tests/test_mp_combined_job.py -k private -q --tb=no --show-capture=no --no-summary
```

P0 has a separate Python input helper; it does not itself provide all Node harness pin/path/provenance controls. The preceding preflight is therefore required by this guide. The quiet pytest options reduce diagnostic output, but they are not a proof that arbitrary Python output is safe to share. Keep all raw output local; publish only reviewed counts, codes and digests. P0 uses fixture bars and does not connect to PostgreSQL. A failed P0 stops this acceptance attempt.

**Node case flow:** from the repository root, run the single ordered file:

```sh
node --test --test-reporter=tap --test-isolation=process --test-concurrency=1 test/postgres/mp-private-acceptance.test.mjs
```

The mapping is P1: F17/F27/F28/F23/F22; P2: F19; P3: F18; P4: F20; P5: F21; P6: F10/F11 package checks; P7: F24; P8: F29; P9: F30 QR-3 half. F1–F9, F12–F16, F25 and F26 retain their source-independent committed-suite evidence and SYN labels. The F30 QR-4 carry-over remains deferred. PX is the optional operator path. This file alone is not all F1–F30 acceptance.

The summary is written under the ignored `.qa-local/f11-private-acceptance/` directory. Inspect its exact case labels and statuses: `NOT_RUN` is not a pass, `SYN` is not private evidence, and `CHECKS_HELD` is not root acceptance. Decision remains `NONE`. Compile/parity records remain fixtures under RD-MP-41; neither this guide nor a successful run proves TradingView parity or permission to expose/apply a package.

## Completion and disposal

Review the exit status together with provenance, finished timestamp, end-tree cleanliness, all database/role drop outcomes and zero remaining object counts. Failed cleanup or a missing/unverified count fails the run. An interrupted process may leave resources; do not infer cleanup from an absent summary. Stop the dedicated cluster and dispose of its complete data directory through the owner's local procedure, even after successful database drops, because private bytes can remain in WAL. Do not target a shared or production cluster.

The owner-local reviewer prepares a hash-only result containing the exact revision, engine/member-set/package hashes, per-case PRIV/SYN labels, statuses, refusal codes, UTC timestamps, tester role, skip reasons and cleanup/disposal outcome. Compare this record with the contract's complete acceptance matrix before root acceptance. Do not copy raw source, analyses, paths, credentials, raw logs or holdout bars into tracked evidence. The Node sanitizer is a trusted-caller boundary, not arbitrary secret redaction.

No route/worker wiring, staging installation, deployment, migration to a shared environment, Live activation, guard reset or Best Inputs apply follows from these steps. READY remains false for these fixture packages. The held N1 terminal-evidence line is outside this runbook's scope.
