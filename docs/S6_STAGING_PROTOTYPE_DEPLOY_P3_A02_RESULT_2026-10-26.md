# S6 staging deploy P3 result (attempt a02)

Packet: [S6-STAGING-PROTO-DEPLOY-1](S6_STAGING_PROTOTYPE_DEPLOY_PACKET_2026-10-24.md), phase P3. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 26 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P3_A02_RESULT_2026-10-26.json); [build record, round 2](evidence/S6_STAGING_PROTOTYPE_DEPLOY_P3_BUILD_R2_2026-10-26.json); [attempt a01](S6_STAGING_PROTOTYPE_DEPLOY_P3_A01_RESULT_2026-10-26.md).

## Outcome

Under the owner's new GO-P3 (full typed text, equal to the packet wording with the D23 gap clause), Root admitted attempt a02, which lists a01 as its prior attempt. The designated operations worker ran it once at 2026-10-25T18:51:36.517Z: one SSH session, about 27 seconds, exit 0, no retry. Root verified the linkage. GO-P3 is consumed.

Verdict: **P3_PASS**, all 16 stages. Migration set A (the Paper ledger fence, M1) is installed on the staging database and committed.

## What happened on staging

- Fresh gate: only the staging API was running; every other staging writer was proved stopped; production identities, unit configurations and the staged tree were unchanged; the login manager does not kill user processes; the API journal was readable; no P2 throwaway copy was left; the API stop timeout fits the stop budget; the health answer was the expected Paper-only 503 while the trading worker is stopped.
- Window: the staging API stopped; no other database session remained; a window backup (7984233 bytes) was taken and nothing wrote in between; the fence migration ran from the staged tree in 113 ms; the inspect after it shows the fence installed, the rest of the catalog unchanged and the fence table empty; the API's database role has the expected fence privileges.
- Restart: the staging API started again on its current code, ready, stable, listening and with no refusal lines in its journal; the API gap was 19.0 seconds. A live post-migration backup (7985923 bytes) followed. The trading worker, market stream, fallback collector and research worker stay stopped.
- Facts for P4: no queued or processing work, no rows waiting for the market, no live-mode rows, no execution heartbeat rows, no foreign sessions and no foundation work.

## What comes next

P4 (pair activation of the API and the trading worker on the pinned revision) follows its own reviewed tool round, a dry admission and a separate owner GO-P4. R3 (fence rollback or logical restore) stays available under its own owner GO. Spot/Paper only, private source local, private acceptance NOT RUN, READY false and P13j/N1 held remain unchanged.
