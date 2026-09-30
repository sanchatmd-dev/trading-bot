# Readiness retention correction — local checkpoint

## Latest isolated staging evidence

A genuine typed file/reservation pair was created through StorageBudget and
left by a physical SIGKILL on 2026-09-29. Exact writer stop and unchanged artifact
identities were verified. Pre-expiry maintenance rejected the young pair.
Earliest guarded cleanup was 2026-09-30 13:53:52 Asia/Bangkok; the actual
cleanup ran later that day (next section). This storage fixture does not replace
supervisor crash recovery. See the [closure progress record](QD_QS_CLOSURE_PROGRESS_2026-09-29.md).

## Guarded cleanup of the aged pair — 2026-09-30

On 2026-09-30 at 13:14:05 UTC (20:14 Asia/Bangkok) the owner ran the audited
apply step once, and it passed. Exactly the aged typed readiness pair (one
4,096-byte pending file and its reservation record) was deleted through
StorageBudget maintenance after about 30.3 hours of real age, with the writer
stopped and three exclusive proofs before and between the deletes. A read-only
postflight at about 13:15 UTC found storage accounting back to zero; only the
retention state hash changed, to the predicted value; the original services,
restart counts, Paper health, queues, failed units, protected evidence hashes and
the writer unit were unchanged. The storage retention gate is therefore closed for
this pair.

This cleanup does not prove actual supervisor crash recovery, a database-side
maintenance lock, dataset or ATR artifact retention, behavior under concurrent
writers, or full QD-1/QS-1 acceptance.

## Defect and correction

A main-process crash can leave a regular readiness file and its storage reservation.
Maintenance previously recognized pending dataset directories but skipped regular
readiness files, then removed their aged reservations. The orphan file continued
to consume storage quota.

Both readiness producers now record the purpose `quant-io-readiness-v1` with the
exact 4,096-byte disk/temp reservation. Maintenance recognizes only a correctly
typed pair, preserves the minimum 24-hour reservation and file ages, and verifies
file type, size and identity before removal. It removes the file before its
reservation. If cleanup stops between those steps, a later guarded pass can remove
the remaining reservation. Legacy untyped regular files retain their reservation
for audit; file size alone does not establish ownership.

## Verification and limits

Independent source audit found no blocking issue. The focused command
`node --test test/quant-storage-budget.test.js test/quant-io-controls.test.js`
passed 18/18, including an independent root run lasting 16.14 seconds. Coverage
includes aged full and partial files, interrupted cleanup and missing-file retry,
invalid reservation shape, legacy preservation, quota and lock behavior. An
earlier interruption assertion expected the file to remain after it had already
been unlinked; the corrected test verifies the actual interruption boundary.

This is local acceptance only. A physical staging crash, proof that all writers
and evaluators have stopped, and maintenance after genuine retention age remain
required. Local synthetic ages do not establish that staging gate. The external
offline guard and existing dataset retention rules remain required. No capacity,
production rollout, strategy or full QD-1/QS-1 acceptance follows from this fix.
