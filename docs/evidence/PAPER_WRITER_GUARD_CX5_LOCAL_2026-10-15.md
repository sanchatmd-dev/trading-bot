# Paper writer source guard: CX5 local acceptance

Root accepted the test-only CX5 change on 2026-10-15 (Asia/Bangkok). The source guard now covers tracked JavaScript, MJS and SQL files recursively under `src/postgres` and `scripts`. An untracked owner diagnostic is excluded by the Git inventory. A Git error fails the test rather than falling back to reading untracked files.

The existing offline import has an exception for exactly its two known writer sites. The guard checks their maintenance lock, exclusive table lock and empty-target check ordering, rejects additional recognized writers, and retains the original funding and execution fence ordering checks. This is a structural source check, not a SQL parser, control-flow proof or runtime import safety certification.

Curated source exports without `.git` use a recursive inventory that excludes symlinks. Such exports cannot distinguish tracked files from diagnostics; their builder must provide the intended contents.

## Evidence

- Final test file: `test/paper-ledger-fence.test.js`, SHA256 `f0d058a37f97f0395c46e2c2320757fd5de0dc04e89a0edda12a9e4293dc6a45`.
- Root independently ran `node --test test/paper-ledger-fence.test.js` on those bytes: 10 tests, 10 passed, no failures or skips; 995.0864 ms on Windows.
- The run includes ten in-memory rejection cases for additional script, nested source, import and fence writers, and removal of the original funding fence call. A temporary export fixture verifies nested inventory and symlink exclusion.
- An independent architecture auditor reviewed the final diff, existing import structure and retained root test log: no actionable regression found. Root owns acceptance.
- Syntax and whitespace checks passed. No database or full suite was needed for this bounded test-only change. Cross-platform CI has not been run for this change.
- Private detailed evidence: `.qa-local/codex-cx5-2026-10-15/` and `.qa-local/codex-th2-cx5-review-2026-10-15/REPORT.md`.

This acceptance changes no product code, database state or deployed service. It does not close the separate per-connection replication-role follow-up or certify all possible dynamically constructed SQL.
