# S6 staging deploy P2 result (attempt a01)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P2. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P2_A01_RESULT_2026-10-25.json); [build record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P2_BUILD_2026-10-25.json).

## Outcome

Under the owner's GO-P2 (full typed text, equal to the packet wording, pin `ba1a433`, QR-2 O7 included), Root admitted one attempt (a01). The designated operations worker ran it once at 2026-10-25T17:05:10.794Z: one SSH session, about 13 seconds, exit 0, no retry. Root verified the linkage. GO-P2 is consumed.

Verdict: **P2_PASS**, all 19 stages, no stop. Facts: FACT_DECRYPT_SKIPPED (one stored field with no ciphertext to check).

## What was checked

- Read-only gate: the ten roles' unit states and configurations equal the accepted P0a and P1 readings; the login manager does not kill user processes; the pin's 14 inspect tools and the ledger check equal the P0b reading; no production or staging heavy job; host load 0.08 per CPU; 7133 MiB available.
- Backup: one live logical backup of the 86 MiB staging database, 7981962 bytes in 1193 ms, mode 0600, in a new backup directory inside the dedicated protected backup directory that this attempt created (ruling D21). Both stay on the host.
- Restore verification in a throwaway cluster inside a transient unit with memory, CPU and task caps (mode CPU_CAP), reachable only through its own socket: restore in 2776 ms; every accounting table matches (10 tables); table, column, function, schema and default ACLs are equal; row counts equal in all 66 tables; 6 sequences equal; schema version 14; all 14 inspect states and the ledger check equal the source.
- Decryption (ruling D7): VERIFIED; 3 stored values decrypted, 0 failed, 1 skipped; no value was shown.
- Teardown: the throwaway cluster stopped, its unit is gone and its directory was removed after the exact-path proof (PROVEN). Unit states after the run equal those before it; production run state unchanged.

## Measured bounds

Dump time 1.2 s gives the GO-P3 API-gap bound of 123 s and the GO-P4 switch-gap bound of 303 s (ruling D19).

## What comes next

P3 (offline migration window) needs its own owner GO. Its tool and R3 passed their fix round; Root records the acceptance, builds the binding against the backup directory this attempt observed, and runs a dry admission before asking. P4 follows the accepted P3 result. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged; no deployment, migration, service change or staging database change took place.
