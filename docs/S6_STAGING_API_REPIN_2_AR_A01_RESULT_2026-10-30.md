# S6 staging API re-pin 2, AR attempt a01: process reference recorded

Packet: [S6-STAGING-API-REPIN-2](S6_STAGING_API_REPIN_2_PACKET_2026-10-30.md) revision 1, section 6.12 (AR reference reading). Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 31 October 2026 (Bangkok), for a job run on 30 October 2026 (UTC).

Evidence:
- the job before it: [RA(r8) a01 result](S6_STAGING_API_REPIN_2_RA_R8_A01_RESULT_2026-10-30.md);
- the job after it: [A1 a01 result](S6_STAGING_API_REPIN_2_A1_A01_RESULT_2026-10-30.md).

## Outcome

**AR a01 is accepted.** The verdict is **AR_PASS** with code `AR_RECORDED`. The job is read only and changes nothing on the host. It ran once, is consumed, and had no retry. Its record is the process reference for A1 a01.

## GO and authority

Root issued GO-AR a01 under the owner's standing authority of 30 October 2026 (18:54Z). That authority covers GO-AR and GO-A1 of this packet only (Root ruling RP1, Q-A). Each job runs once, after Root accepts the RA(r8) receipt, and the authority ends at 2026-10-31T18:00:00Z. It does not cover GO-A2. Root issued GO-AR after it accepted RA(r8). The GO window opened at 19:58:36Z and lasted 120 seconds.

## Job

- **Job ID.** `s6-r2-ar-a01-e53c5f49f00a4c892bbeb05d` (manifest `ad7d663f`).
- **Host time.** 19:58:50.907Z to 19:58:52.103Z, about 1.2 seconds.
- **End.** Verdict `AR_PASS`, code `AR_RECORDED`.

## Acceptance checks

Root accepted at 19:59:29Z against section 6.12. Every condition holds:

| Condition | Result |
| --- | --- |
| Production units equal to the recorded baseline | true |
| Research worker stopped | true |
| Staging API, trading worker and market stream running | true |
| Collector timer active | true |
| Fallback collector service not failed | true |
| API configuration equal to the c1 value | true |
| API drop-in list equal to the c1 value | true |
| Trading worker configuration and drop-in list equal to the c1 values | true |
| Market stream configuration equal to the P4M a03 value | true |

Basis: Root read the receipt and compared the digests with the c1 and P4M references.

## Linkage

Root checked the hash chain itself: the receipt hash equals the job output, and the manifest hash and the retained-output hash match. This job is read only, so Root used no independent linkage reviewer.

## Deviations

None recorded for this job. The rule slips of the day are listed in the [RA(r8) result](S6_STAGING_API_REPIN_2_RA_R8_A01_RESULT_2026-10-30.md).

## State now

The job changed nothing. The staging API runs `ba1a433` with the P5a flag layer. The 503 window opened by RA(r8) is still open. Scope: Spot/Paper only, Live hard-locked. Private acceptance is NOT RUN; READY is false; P13j and N1 stay held.

## Next

A1 a01 followed under the standing authority; see its result. **A2 has not run** and needs the owner's GO-A2.
