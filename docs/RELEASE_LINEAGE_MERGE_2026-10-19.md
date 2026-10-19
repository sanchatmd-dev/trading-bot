# Release lineage merge, 2026-10-19

The owner chose to merge the staging release lineage (`325d335`, now `eb532ff`) into `codex/app3a-market-wait-checkpoint`. Before the merge, that release was not an ancestor of the branch, so a release from the branch would have lost the evaluator-binding refusals, the PF-2 runtime DELETE revoke, the one-active-PROFILE enrollment guard and the bounded child diagnostics. This note records the merge and the facts a later release must respect. Nothing was deployed, migrated or restarted, and no host was contacted.

## What changed on the branch

- `743f836` merges `eb532ff`. Product files merged automatically; only the import headers of three enrollment tests conflicted, and both sides' imports were kept.
- `c685398` adapts branch-only tests to the release: six PostgreSQL tests now substitute the grant script's `:'runtime_role'` variable; the QR-1b freeze test proves two layers (the runtime role now gets privilege error 42501 on DELETE of `quant_jobs` and `quant_research_chunks`, and a dedicated test role that holds DELETE still meets the freeze triggers); and `pf2-proof-gaps` moves to `test/postgres-isolation-none/`, which `npm run test:postgres` runs once with `--test-isolation=none` after the per-file run.
- `2ffcefa` brings the branch tip (`faa95e5`: D1 graceful-stop guards, the Library comparison fix and new tests) into the merge without conflicts. The working branch was then fast-forwarded to it.

## Verification

On the merged tree `2ffcefa`, on a Windows host with a local PostgreSQL 16.15 cluster that mirrors CI: `npm test` 1,554 passed, 0 failed, 6 skipped; `npm run test:postgres` 885 and 7 passed, 0 failed, 6 skipped; `quant_lab` pytest 319 passed. An independent architecture review confirmed that `src/postgres/quant-research-foundation.js` equals the base plus the release patch plus the D1 patch. A second-opinion review on another model found no lost or weakened protection; it corrected an earlier claim about engine identity, which the next section states accurately. Hosted CI runs on the pushed commit.

## Engine identity

Line-feed hashes, as a Linux host computes them, from `eb532ff` to `2ffcefa`:

| Closure | eb532ff | 2ffcefa |
| --- | --- | --- |
| FOUNDATION engine | `07b1eea8…` | `7c101354…` |
| INGESTION engine | `686e9552…` | `d5364563…` |
| PF-2 engine | `2120418a…` | `5bfd1bfa…` |
| LEGACY engine | `98817114…` | unchanged |
| PF-2 evaluator | `3fb2d465…` | unchanged |

The only cause is the D1 change in `src/postgres/quant-research-foundation.js`. The merged tree is therefore not identical to the release: on a host that runs `eb532ff`, queued foundation scheduler jobs (backfill, profile, research binding) are cancelled with `AUTHORIZATION_REVOKED`, research runs fail with `QUANT_ENGINE_CHANGED`, PREFLIGHT jobs fail with `PF2_ENGINE_HASH_MISMATCH`, and earlier profile enrollment tickets fail validation. Drain or finish that work before a release window, or accept the cancellations and resubmit afterwards. Windows working copies use CRLF and give different values (for example evaluator `57466db9…`); never put those values in a host policy.

## Facts a later release must respect

1. **Offline migrations the branch adds relative to `eb532ff`.** Stop the API, the trading worker and every research worker first. Each tool has a read-only `--inspect` mode. Rehearsed order (`docs/evidence/DB_GUARD_WINDOW_LOCAL_REHEARSAL_2026-10-13.json`): full backup; deploy the tree; core migrate (`scripts/migrate-postgres.mjs`, which creates the Paper ledger fence) and fence inspection; the three guard-hardening migrations (`migrate-bot-parent-hardening.mjs`, `migrate-quant-research-guard-hardening.mjs`, `migrate-quant-io-release-guard-hardening.mjs`); the result freeze (`migrate-quant-research-freeze.mjs --runtime-role=<role>`); the optional TEMP revoke (owner decision still open); the grant script; then start services. The order among the three guard migrations should be confirmed against the private window draft before a window packet is written.
2. **Same-window coupling.** After the I/O release-guard hardening, a tree without the two-state verifier (such as `eb532ff`) refuses the foundation migration with `QUANT_IO_SCHEMA_UNSUPPORTED`. A code rollback to `eb532ff` needs that hardening rolled back first, in reverse order. Only a full restore keeps the guards and the freeze.
3. **Grant script.** Run `psql -v ON_ERROR_STOP=1 -v runtime_role=<role> -f scripts/grant-postgres-runtime.sql` after the migrations and before service start. The variable has no default, so an old invocation fails closed. The script takes the exclusive maintenance lock and fails while a service holds its shared lock. An older copy of the script re-grants DELETE, so any rollback must reapply this one.
4. **Startup refusal.** With `QUANT_PROFILE_V2_ENROLLMENT_ENABLED=1` or `QUANT_PREFLIGHT_ENABLED=1`, the API and the research worker refuse to start with `CAPACITY_POLICY_EVALUATOR_MISMATCH` (503) unless the capacity policy's `scope.evaluator_hash` equals the tree's PF-2 evaluator hash. On a Linux checkout that is `3fb2d465215ea2473aaa5d5e458d18fcd526aea239348063a3372e661d630ada`, the same as `eb532ff`, so a policy valid for the release stays valid.
5. **New refusal.** A new PROFILE enrollment for a Bot that already has one queued, paused, running or stopping returns 409 `PROFILE_ENROLLMENT_ALREADY_ACTIVE`; the same idempotency key still returns its job.

A deployment from this branch needs a new release record, a staging migration plan and its own owner GO. Host state and the live staging tree were not checked for this note.
