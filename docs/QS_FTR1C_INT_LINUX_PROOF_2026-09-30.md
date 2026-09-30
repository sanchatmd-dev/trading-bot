# QS-1 FTR-1c-INT Linux proof, hardening and PF-2 R2 checkpoint — 2026-09-30

## Scope

One owner-run Linux proof and four local code slices, pushed on branch
`codex/app3a-market-wait-checkpoint`:

- FTR-1c-INT: the Linux proof of the FTR-1c-C commit barrier and writeback drain
  plan, one owner-run case, no retry. Result PASS-MEASURED.
- `30620ec` (fix): FTR-1c-D hardening of the drained terminal before spawn and at
  commit.
- `dedf834` (feature): wiring step W1, the optional terminal block in the capacity
  policy.
- `f00053b` (fix): RC-1, the `QUANT_EXECUTOR_MODE_UNAVAILABLE` code on backtest and
  optimize.
- `07728ad` (feature): PF-2 R2, the preflight schema and migration hook.

The four slices are local only. Nothing is deployed, and no staging or production
service changed. The Linux proof ran a packet frozen from the FTR-1c-C blobs, so
it does not cover the four slices. Scope stays Spot/Paper only, BINANCE:BTCUSDT
Spot 1m, the 10K-bar ceiling including warm-up, independent holdout gates, no
production rollout and no Live.

## FTR-1c-INT: the Linux proof

### Setup

The code under test is the FTR-1c-C commit `f5616f2`. The packet was frozen from
its blobs before the hardening slice existed, so FTR-1c-D is not part of this
proof. The packet had an independent audit, one fix round (a quiet-window end
margin for coarse file timestamps, and a meaningful live-versus-frozen write
comparison) and an accepting re-audit before any host step. The owner ran setup
and launch on 2026-09-30; the launch was at 07:34:13 UTC. One case, no retry.

Host facts recorded by the packet: ext4 with a 30 s journal commit interval,
`data=ordered`, `dirty_expire` 30 s, `dirty_writeback` 5 s, no fast commits and no
swap. The host-required drain was 45,000 ms. The case ran 100 derived bars with
evaluator admission off.

### Results

| Measure | Result |
| --- | --- |
| Outcome | PASS-MEASURED |
| Final settlement | Measured: ledger `SETTLED`; charge equal to the frozen deltas (0 bytes read, 36,864 bytes written) |
| Commit barrier | 3 ms |
| Freeze | 11 ms |
| Drain | 2,580 ms over 6 polls |
| Terminal elapsed | 5,202 ms |
| Spawn to terminate | 1,801 ms |
| Spawn to terminal end | 7,207 ms |
| Stop | Proven; unit removed after exit |
| Recorded gates | Every recorded gate true; nothing flagged |
| Quiet terminal window | No file written; no inline-data or journal-data file attributes |
| Swap while frozen | All samples zero |

Postflight and a 10-minute recheck matched: the original services, Paper health,
the trading and quant queues (all 0), the prior evidence databases and artifacts,
the earlier FTR-1 case and the retention state were unchanged.

### What it proves and does not prove

This is the first Linux PROFILE case with measured settlement. The default commit
barrier ran on a real ext4 host, the drain plan fitted the host, and the frozen
counters were committed as the final charge instead of the unknown-final fallback
that every earlier Linux PROFILE case kept.

It does not prove the host-dependent parts of FTR-1c-D (the filesystem gate,
`MemorySwapMax`, the prepare-time sysctl gate and the commit age check timing),
product wiring (W2 to W7), other hosts (each needs its own drain plan) or
statistical behavior (one case). Nothing is deployed. Per the wiring plan, this
result allows a staging drain of 45,000 ms on this host once V2 wiring is enabled;
the W7 wiring proof is still required first.

## Retention check

The 24-hour readiness retention check ran after the pair aged, at 2026-09-30 06:54
UTC: the identity was unchanged, the writer was physically stopped, and the
maintenance dry run named exactly the aged pair. Nothing was deleted. The deletion
is a separate owner-run step, being prepared and audited now.

## The four commits

All four are local only and pushed. CI passed 9/9 on `07728ad`. Root checks: the
full unit suite ran 641 tests (639 pass, 2 skip, 0 fail) and nine PostgreSQL test
files passed 143/143.

### `30620ec`: FTR-1c-D hardening

Drained launches now check the host writeback plan and require an ext4 storage
root before any reservation or spawn, and the filesystem is re-checked before the
freeze. The bounded commit transaction checks its own age on the server after its
locks and before `COMMIT`. Drained units run with `MemorySwapMax=0`. New tests
cover a stop between the freeze and the barrier, full-length drains at the latest
permitted start, the transaction bound and the swap property. The architecture
audit returned ACCEPT with low follow-ups: a prepare-time refusal is quarantined
rather than cleanly cancelled; a pool checkout wait before `BEGIN` is not counted
in the age check; `MemorySwapMax` is unverified where swap accounting is absent.

### `dedf834`: W1, the terminal block in the capacity policy

The capacity policy gains an optional terminal block (runtime cap, drain and tail
margin) validated against the fixed terminal constants. Policies without the block
keep their hash. `io-terminal.js` joins the PF-2 engine file list. The slice
rotates the foundation, ingestion and PF-2 engine hashes (unreleased). The audit
accepted after root added the PF-2 list entry; its notes: the effective runtime
floor is 16,000 ms, and W2 must derive the launcher tail margin from the policy.

### `f00053b`: RC-1, the executor-mode code

Backtest and optimize now return 503 with the `QUANT_EXECUTOR_MODE_UNAVAILABLE`
code. The tester accepted; the legacy HTTP test is no longer a todo.

### `07728ad`: PF-2 R2, the preflight schema and migration hook

The slice adds the holdout boundary registry (write-once and minute-aligned) and
the preflight job table, which keeps exact canonical plan bytes under a SHA-256
`CHECK`; only the process-unit pair may change after insert, and rows are never
deleted. The audit accepted with low follow-ups. On staging, the migrate run that
installs these tables is the owner-authorized PF-2 operations packet.

## Owner decisions

PF-2 OD-1 to OD-5 were approved as recommended on 2026-09-30: staging waits for
trusted PROFILE v2 enrollment; the holdout boundary is owner-registered and
write-once; deployment freshness is checked at enqueue and at authorize; migration,
deploy and the first run form one owner-authorized operations packet; the API only
for now, with the UI in PF-3. PF-2 R3 (the service and holdout registry) is in
progress locally.

## Not yet proven

- The host-dependent parts of FTR-1c-D have not run on Linux: the filesystem gate,
  `MemorySwapMax`, the prepare-time sysctl gate and the commit age check timing.
  They are covered inside the W7 Linux proof.
- Product wiring W2 to W7 is not done; no product code enables the drain.
- The proof is one case on one host. Other hosts need their own drain plan, and no
  statistical claim is made.
- The retention deletion has not run; the dry run named the aged pair only.
- The W1 slice rotates the foundation, ingestion and PF-2 engine hashes;
  re-check hash-bound evidence before any deploy. Nothing is deployed.
- The PF-2 preflight tables exist locally only; the staging migrate run is a
  separate owner-authorized operations packet.

## Effort and usage

Measured intervals, all wall-clock UTC: the INT packet build, audit, fix round and
re-audit about 03:34-04:36; the hardening, W1, RC-1 and R2 wave about 04:33-06:24
(ten agents); root checks, four commits and push about 06:24-06:38, with CI green
by about 06:53; the INT window about 06:54-07:45 (retention check 06:54, preflight
06:58, upload 07:00, owner setup 07:33, owner launch 07:34, result 07:35,
postflight 07:36, recheck 07:44). The shared 5-hour usage window reset at 04:30
UTC and went from 0% to 19% used over the wave and to 24% by 07:46, when the next
wave had started; the weekly all-models counter went from 26% to 29%. Shared
counters do not attribute cost to an agent or a step. The agents ran under the
owner-approved temporary elevated tier. No engineering hours are booked and no
speedup is claimed.

## Next steps

1. Retention deletion of the aged readiness pair, owner-run, after its own audit.
2. PF-2 R3 (the service and holdout registry), then R4 to R6.
3. Wiring step W2 (the launcher tail margin derived from the policy), then W3 to
   W6 and the W7 Linux proof, which also carries the FTR-1c-D Linux coverage.
4. Heavy-path S3 (prepare-under-lease) and S3c before the heavy-path gate closes.

## Scope and status

Commit, acceptance and proof are separate facts: the four commits are pushed, were
accepted by independent reviewers and passed CI; the Linux proof passed for the
FTR-1c-C code only. Planned: the retention deletion, PF-2 R3 to R6, W2 to W7,
heavy-path S3/S3c. Local: the four commits. Linux host, isolated case (not a
staging deployment): the one FTR-1c-INT case and the retention check, both bounded
and supervised; no existing service, config or data changed. Production: nothing.
Nothing is deployed.
