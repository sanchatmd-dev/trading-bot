# S6 staging API re-pin 2, A1 attempt a01: tree staged, layer name fits

Packet: [S6-STAGING-API-REPIN-2](S6_STAGING_API_REPIN_2_PACKET_2026-10-30.md) revision 1, section 5 (A1), with the AR reference of section 6.12. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 31 October 2026 (Bangkok), for a job run on 30 October 2026 (UTC).

Evidence:
- the process reference: [AR a01 result](S6_STAGING_API_REPIN_2_AR_A01_RESULT_2026-10-30.md);
- the revision 8 A1, which stopped on the layer name: [A1 a01 result (revision 8)](S6_STAGING_API_REPIN_A1_A01_RESULT_2026-10-29.md);
- the revision 8 switch that this packet repeats: [A2 a01 result (revision 8)](S6_STAGING_API_REPIN_A2_A01_RESULT_2026-10-29.md).

## Outcome

**A1 a01 is accepted for A2.** The verdict is **A1_PASS** with code `A1_STAGED`. The job ran once, is consumed, and had no retry. The new API tree of the pin `75c7a5b` is on the host, inert, next to the running tree. The layer-name boolean is **true**, so the A2 request can be prepared.

**A2 has not run.** Nothing was switched. The staging API still runs `ba1a433`.

## GO and authority

Root issued GO-A1 a01 under the owner's standing authority of 30 October 2026 (18:54Z), after it accepted AR a01. The authority covers GO-AR and GO-A1 only, runs once per job, and ends at 2026-10-31T18:00:00Z. The GO window opened at 19:59:48Z and lasted 120 seconds. Admission passed at 19:59:41Z with a start-by time of 20:08:41Z.

## Job

- **Job ID.** `s6-r2-a1-a01-d778ea90f123a3bb7c735b5f` (manifest `993ce395`, tool source hash `ade33b43`).
- **Host time.** About 20:00:04Z to 20:00:21Z.
- **End.** Verdict `A1_PASS`, code `A1_STAGED`. The job changed no unit.

## Acceptance checks

Root accepted at 20:00:52Z against section 5.1.

| Check | Result |
| --- | --- |
| Layer-name boolean `layerNameFits` | **true** |
| Admission-off layer found | true |
| P5a flag layer found | true |
| Admission-off digest present | true |
| P5a layer digest present exactly once | true |
| Live layer count equals counted layers | 18 = 18 |
| Drop-in list digest equal to c1 | true |
| Tree staged exactly | 1677 files, tree digest equal to the manifest, Node syntax checks 146 passed and 0 failed |
| End reading equal to the gate | staging API, trading worker and market stream are the same processes as at the gate |
| Archived layers | 1 (the revision 8 archive from RA(r8)) |
| Reference export equal to AR a01 | true |

Basis: Root read the receipt and compared each value with the manifest and with the AR a01 record, which this job uses as its process reference.

## Linkage

Root checked the hash chain: the receipt matches the job output and the manifest, and the GO-consumed marker is present. This job has no independent linkage reviewer in the packet.

## Deviations

None recorded for this job. The rule slips and the late RX tripwire of the day are listed in the [RA(r8) result](S6_STAGING_API_REPIN_2_RA_R8_A01_RESULT_2026-10-30.md).

After the acceptance, Root did the U-4 recheck (it passed) and a real A2 dry admission with this A1 record (all checks passed).

## State now

- **Staging API** on `ba1a433` with the P5a flag layer. The new tree is staged and no unit points to it.
- **Trading worker, market stream and collector timer** unchanged.
- **503 window.** Opened by RA(r8) between 19:48:33Z and 19:50:08Z on 30 October 2026. It stays open until Root accepts A2.
- **Scope:** Spot/Paper only, Live hard-locked. Private acceptance is NOT RUN; READY is false; P13j and N1 stay held.
- Product change (b) and the set B grant module are local and CI-green; they are NOT deployed.

## Next

1. The owner types GO-A2. Root sent the request (valid until 2026-10-31T18:00:00Z) at about 20:02Z on 30 October. The standing authority does not cover it.
2. If the owner gives GO-A2: A2 runs once; then the owner browser step (section 6.9) and A2M, and Root records each result.
3. **A2 has not run.** The 503 window stays open until it does.
