# PF-2 Historical Preflight contract checkpoint

## Scope

Local engineering starts in parallel with QD-1/QS-1 runtime and I/O acceptance.
`src/quant-research/preflight-contract.js` validates and hashes one immutable
historical replay plan. It does not execute a replay, submit a job, resolve
ownership, verify artifact bytes, admit an evaluator or recommend Risk Manager
settings. No HTTP route or production capability is added.

The first contract uses the existing foundation V1 ceiling of 10,000 bars,
including warm-up, for BINANCE:BTCUSDT Spot 1m. The planned PF-2 maximum remains
50,000 bars, subject to QD-1/QS-1 capacity and evaluator acceptance. A planned
maximum must not silently raise current admission.

## Frozen plan

`historical-preflight-v1` contains the foundation request and a
`pf2-snapshot-v1` snapshot. Foundation kind is `PREFLIGHT`, with exactly one
candidate and one evaluation. Existing runtime, output and state limits apply.
The snapshot hash must match the foundation request and binds:

- Source and effective inputs, Bridge settings, Risk Manager policy and capital.
- Initial account/guard state, execution model and venue metadata references.
- The signal evaluator identity, or a bound signal CSV artifact and its replay
  evaluator identity. CSV mode does not enable source-input optimization.
- The declared development interval and holdout boundary.

All references are SHA-256 identities. Their shape does not prove that the
referenced data exists, is authorized or has passed parity. Those checks belong
to the future server-side resolver before scheduler admission.

Intervals use UTC millisecond timestamps and half-open minute boundaries. The
entire referenced dataset, including warm-up, must lie in the development
interval. Its end may equal the holdout start, but must never cross it. Passing
a full artifact containing holdout with a promise to slice later is rejected.
Dataset cutoff consistency is checked by the existing foundation validator;
the future resolver must also verify actual closed bars and trusted capture time.

`paper-close-cost-v2` is rejected with
`PREFLIGHT_EXECUTION_MODEL_PARITY_REQUIRED`. Existing V1 checks do not prove V2
cost-inclusive historical parity. Accepting the V1 plan shape alone also grants
no evaluator capability.

## Checks and remaining gates

Five focused Node tests passed: detached immutable hashing, bound CSV identity,
10K/model/market rejection, development/holdout boundaries, and denial of
optimization, extra fields and accessor-bearing input. Independent Sol review
found no blocking defect within this shape-only scope; the combined preflight
and existing capacity subset passed 13/13. These totals overlap and must not be
added. No backend state or external service was changed.

The future adapter must verify both the foundation release hash and signal
evaluator hash against the actual executables. They may identify different
layers of the release; a declared mapping or equality, as appropriate, must be
checked before execution. A pair of syntactically valid hashes is insufficient.

Next implementation must resolve authorized immutable references, use the
shared worker/evaluator and costs, preserve continuous account and guard state,
prove V2 historical parity separately, and run under scheduler/resource limits.
Result counters must distinguish signals, intents, accepted/capped/rejected
orders, fills and closed episodes. Persistent guard pauses must not produce a
finite collection ETA. Replay remains development-only and cannot reset guards,
apply settings, execute orders, inspect holdout or start another research run.
