# QD/QS provisional PROFILE runtime â€” 2026-09-29

## Scope

The internal staging adapter connects the fixed Node child to the existing `buildProfileV2` pipeline. The parent derives a canonical payload from the persisted job contract and trusted storage and capacity settings. A reserved 4 KiB scratch write makes real Linux I/O telemetry available before payload release. The worker loads dataset modules only after release.

This follows the separate [Linux diagnostic binding proof](QD_QS_LINUX_BINDING_CHECKPOINT_2026-09-29.md). Neither checkpoint grants public V2 admission or closes QD-1/QS-1.

## Release and termination contract

The runtime commits the trusted identity and counters as `ACTIVE` before releasing the payload. It checks the lease, deadline, current authorization, health and counters under the established database locks. Changed counters are persisted before release is denied, including changes during authorization. During computation, serialized observations enforce the existing stop decision.

The child returns an exact acceptance receipt and a bounded, hashed PROFILE result. The result remains provisional with `evaluator_admission=false`. The adapter physically stops its owned child before attempting authorized cancellation. A successful scoped run ends as `CANCELLED` / `STOP_PROVEN` / `CRASHED`, with conservative unknown-final charging and null SQL result and checkpoint. It does not become `SUCCEEDED` or `SETTLED`. Failed authorization or uncertain stop leaves unresolved state for recovery; it cannot authorize forced cleanup.

## Local evidence

Focused child checks passed 3/3, including actual 600-bar V2 conversion with 500 warm-up bars and 100 derived bars. Launcher checks passed 5/5. Isolated PostgreSQL PROFILE checks passed 7/7; a subsequent focused regression passed 1/1 for counter growth during authorization. Earlier diagnostic PostgreSQL checks passed 16/16 after the initial integration. Syntax and diff checks passed. The owned local PostgreSQL process was stopped.

The PostgreSQL tests use synthetic telemetry. They establish local behavior only; a separate Linux run is required to prove the actual worker and counter binding together.

## Linux staging evidence and remaining gates

Independent source and staging-packet review found no remaining blocker within the single internal case. Review corrected the persistence of counter growth during authorization and the fixture scheduler authorization for HEARTBEAT. The reviewer did not rerun local checks. The Linux case is authorized under manifest SHA-256 `d2020da2e1147e20756a3e5288a53631f4a83f936cd68fc77ac33c6c4bd547ff` (29 source files and six scripts); one supervised Linux case passed.


Job `de673495-f4e2-4733-86a5-7d94ebd89638`, operation `profile-protocol-8e2f9c14`, ran the actual fixed Node worker over 600 immutable synthetic Spot 1m bars. An independent database connection recorded committed revision 2, `ACTIVE` accounting and `SPAWNED` launch state before approval and payload release. The kernel write counter was 4,096 bytes at binding. The resulting PROFILE contained 100 derived bars after 500 warm-up bars, with `evaluator_admission=false` and result hash `c77af8ab022a499c26eac268e6cd6bffa49f1ddceb3f82baaa69fccb8fd08f77`.

The last persisted observation was read 0 and write 36,864 bytes. This was sampled before physical stop; it is not a measured final counter. Accounting charged 2 MiB per direction conservatively. The job ended `CANCELLED`, launch `STOP_PROVEN`, ledger `CRASHED`, with null SQL result and checkpoint. Monitor status was `SUCCEEDED`; this is the monitor outcome, not PROFILE job completion. No retry occurred.

Delayed readback at 12:53:37 UTC found child, driver and monitor inactive with PID zero and empty groups, no pending jobs or active scheduler slot, clean scratch/reservations and unchanged artifact references. External checks at 12:53:47–54 found original process IDs and Paper health unchanged, prior diagnostic and cancellation evidence unchanged, and genuine retention file/reservation hashes preserved. Available memory was about 6,654 MiB, free disk 91.64 GiB and load 0.14. Actual production and staging trading signal queues were both zero at 12:55 UTC. The new isolated database and immutable artifacts (63,500 bytes) are retained.

The accepted marker was validated by the launcher and adapter; no separate receipt timestamp was recorded. The provisional result arrived at 12:53:05.673 UTC and cancellation completed at 12:53:05.678 UTC. Monitor completion was 12:53:12.609 UTC, with five baseline and eight impact samples; observed database p95 was 4.184 ms baseline and 1.170 ms during the case. This tiny sample is not a performance or capacity benchmark.

Private raw evidence is kept in ignored `.qa-local/profile-binding-evidence-v1/logs/`, with summary `.qa-local/profile-binding-case-summary.json`. No production rollout occurred.

The staging fixture uses a trusted constructor callback bound to its frozen owner, job, contract, policy, source, deployment and revocation state. Production owner/deployment resolution is not wired by this checkpoint. Positive physical reads, measured post-stop counters, cumulative-cap calibration, all-device coverage, resumable PROFILE progress, trusted enrollment and public V2 admission remain open. Production remains at 10K bars including warm-up, Spot/Paper, with independent holdout gates.
