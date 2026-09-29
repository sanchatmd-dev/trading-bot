# QD/QS initial I/O binding checkpoint — 2026-09-29

## Scope and checkpoint

This local slice binds a diagnostic I/O operation to trusted initial counters before payload release. It does not establish cumulative enforcement, evaluator integration, or public V2 admission.

Step 1 reviewed 20 files and was committed and remotely verified as `d31b42a26b34572d375b58dc0f5612f870f88ad7` on `codex/app3a-market-wait-checkpoint`. Step 2 was developed locally on top of that commit. Its changed paths are `src/postgres/quant-io-runtime.js`, `src/quant-research/io-runtime-launcher.js`, `test/postgres/quant-io-runtime.test.mjs`, and new `test/quant-io-runtime-launcher.test.js`.

## Binding behavior

- Runtime accepts identity keys only for binding. The sampler reads the systemd `InvocationID` (32 hexadecimal characters), PID, process start time, cgroup membership and inode, device inode and device number, and kernel `io.stat`.
- Each diagnostic job permits only one operation and one intent. Canonical cgroup paths reject a nested owned unit. This does not claim multi-domain or all-device coverage.
- The birth baseline is zero, while actual bootstrap counters remain preserved. The database commits `ACTIVE` before the one-shot payload release.
- Fresh monotonic observations persist. A changed or exhausted final sample commits before stop or denial.
- Known overshoot remains charged at observed usage: a read of 40 against allowance 30 charges 40, including on cancellation.
- Missing counters, policy, identity, or lease deny payload and disable local release authority, then request owned-handle stop. Unresolved accounting and intent continue to hold the scheduler slot until trusted cancellation completes. Missing `io.stat` is never replaced with zero counters.
- Bound cancellation retains the inode. An unknown final sample charges the maximum observed usage or allowance, whichever is greater; state never becomes `SETTLED`.
- The launcher does not retry payload after commit ambiguity.

## Local evidence

Focused local checks passed: PostgreSQL 14/14 in approximately 5.16 seconds; launcher helpers and existing I/O controls 11/11 in approximately 1.20 seconds; syntax check passed. PostgreSQL checks used a synthetic trusted sampler. Helper tests do not prove the live Linux sampler.

The first audit found three defects: lost final sample, synthetic invocation ID, and unproven `DISJOINT`. These were corrected and checks rerun. Final Astra source and test review found no remaining blocker within the local single-child initial-binding scope. The reviewer did not rerun tests. Physical Linux positive counter reads, PROFILE execution, and final accounting remain unproved.

## Limits and next gates

There is no new staging or production deployment. The prior `d31b42a` cancellation-stage proof does not prove this binding. No scratch telemetry provisioning occurred. Live positive counter-read proof, an actual PROFILE worker, final counters, main/all-device coverage, stop-tail calibration, and the fault matrix remain gates.

Public 10K bars including warm-up, Spot/Paper, `BINANCE:BTCUSDT` Spot 1m, and independent holdout gates remain unchanged. Timed engineering total is unknown; no duration or speedup claim is made. Usage was 51% remaining at start and 47% at the integration checkpoint, with short-window data unknown. These shared account percentages are not model costs; 20 percentage points remain the project reserve.

After audit, the author verified the saved data-directory identity and process ID, stopped only that local PostgreSQL cluster and confirmed `no server running`. Data files remain. No test pass, deployment, or acceptance claim extends beyond the evidence above.
