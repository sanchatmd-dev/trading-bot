# S6 staging API re-pin 2, A2 attempt a01: staging API switched to pin 75c7a5b and accepted

Packet: [S6-STAGING-API-REPIN-2](S6_STAGING_API_REPIN_2_PACKET_2026-10-30.md) revision 1, sections 6 (A2), 6.9 (owner browser step and A2M) and 6.10 (receipt facts). Environment: Staging QL-P2 Prototype. Recorded by the Claude root for a job run on 31 October 2026 (UTC), with the browser check and A2M on 1 November 2026 (UTC).

Evidence:
- the process references: [RA(r8) a01 result](S6_STAGING_API_REPIN_2_RA_R8_A01_RESULT_2026-10-30.md), [AR a01 result](S6_STAGING_API_REPIN_2_AR_A01_RESULT_2026-10-30.md) and [A1 a01 result](S6_STAGING_API_REPIN_2_A1_A01_RESULT_2026-10-30.md);
- the revision 8 switch that this packet repeats: [A2 a01 result (revision 8)](S6_STAGING_API_REPIN_A2_A01_RESULT_2026-10-29.md);
- the QR-2 boundary read that the parity check uses: `docs/evidence/S6_QR2_BOUNDARY_READ_1_A01_RESULT_2026-10-30.json`.

## Outcome

**A2 a01 is accepted.** The verdict is **A2_PASS** with code `A2_PASSED`. The job ran once, is consumed, and had no retry. The browser check, the timing record and A2M a01 (packet section 6.9, steps 2, 3 and 4) are all done and passed. Root accepted at 2026-11-01T20:34:21Z.

**REPIN-2 is complete.** Four jobs are accepted: RA(r8) a01, AR a01, A1 a01 and A2 a01 with A2M a01.

## Revisions

- **Staging API:** pin `75c7a5b336ca6653c0e748cf2b88e1e0ff3b4ac5`, with the P5a flag layer and the REPIN-2 layer. The QR-2 flag is effective 1.
- **Trading worker:** `ba1a433`, unchanged.
- The receipt names neither revision directly (it carries the pin only through the manifest hash). This record names both, as the linkage reviewer asked.

## GO and authority

- **GO-A2.** The owner typed GO-A2 in chat on 2026-10-31 at 01:51:24Z. The GO carries the A2 and A2M phases, attempt a01, the pin above, and a not-after time of 2026-10-31T18:00:00Z. Root used it for A2 a01 only. The GO window opened at 01:51:37Z and lasted 120 seconds.
- **After the not-after time.** The GO-A2 not-after time passed before the owner's browser check (the owner signed in on 1 November). A2M therefore did not run under GO-A2. It ran under a new read-only GO-A2M line that Root issued under the owner's standing A2M authority of 2026-11-01 (ruling RP20). That line grants A2M only and not a second A2.

## A2 job

- **Job ID.** `s6-r2-a2-a01-f97d8baedb76d5fe10dcd03b` (manifest `77f9769e`, receipt `729b949a`).
- **Host time.** 2026-10-31T01:51:55Z to 01:56:27Z, about 272 seconds including the delayed check (taken 265 seconds after readiness).
- **End.** Verdict `A2_PASS`, code `A2_PASSED`, end row **LL-n**.
- **Checks.** The immediate and delayed failed lists are both empty. The API process digest is the same at the immediate and delayed checks, and it differs from the old process, as a switch requires. Production is unchanged (production-equal true).
- **Memory (RC-Q36).** See the table below. No memory limit was set. Host available memory stayed far above the 384 MiB estimate.

## Linkage

An independent reviewer (architecture auditor role) read the receipt chain, the GO and the time rules. The verdict is **LINKED_OK**: no chain break, no time-rule break, no P1 and no P2. Three P3 findings, with Root's handling:

| Finding | Root's handling |
| --- | --- |
| P3-1: the receipt has no working-directory or argument digest fields (packet 6.10). | No binding update in this packet, so it does not block. Recorded here; Root maps the fields before any binding update uses this receipt. |
| P3-2: the receipt names no trading revision. | This record names the API pin and the trading worker `ba1a433`. |
| P3-3: one gate inventory digest (`3b10db70`) equals the live admission-off layer bytes. | Root found the same digest in the revision 8 A2 a01 gate inventory, accepted on 2026-10-29. It is an identical-bytes archive file and is recorded as a residual. |

The reviewer also noted five info items (for example the delayed check at 265 seconds against "about 300 seconds" in the packet, and clock skew of 5 ms). None breaks a rule.

## Owner browser check and timing record

Root took the readings on 2026-11-01 at about 20:29Z in its own tab of the owner's signed-in session, after the owner said ready and signed in. Root entered no credential and changed no setting. The language was switched to Thai to read the note and switched back to English.

- **Served page (item 3a).** Hard reload; the served script and style versions are the expected ones (`qr2o10`, `qr2o10`, `qr2o7`). PASS.
- **Timings.** 9 of 9 report requests returned 200. Total time 101 to 167 ms (revision 8 A2 was about 100 to 150 ms). No request took 5000 ms or more, and there was no 503. A first cold request after sign-in (Bot 3, All Time) took 930 ms and is not part of the table.

| Bot | Range | Status | Total ms | Read ms | Compute ms |
| --- | --- | --- | --- | --- | --- |
| Bot 3 | Week | 200 | 167 | 83 | 7 |
| Bot 3 | Month | 200 | 142 | 38 | 7 |
| Bot 3 | All Time | 200 | 137 | 53 | 13 |
| Bot 2 | Week | 200 | 125 | 47 | 1 |
| Bot 2 | Month | 200 | 112 | 38 | 1 |
| Bot 2 | All Time | 200 | 116 | 41 | 1 |
| Main Bot | Week | 200 | 139 | 66 | 1 |
| Main Bot | Month | 200 | 110 | 36 | 1 |
| Main Bot | All Time | 200 | 101 | 27 | 1 |

- **Per-Bot outcome.**
  - Bot 3 reconciles in Week, Month and All Time.
  - Bot 2 shows RECONCILIATION_FAILED with finding LEDGER_RULE_UNREPLAYABLE and reason EPOCH_UNKNOWN. The failure is not whole-account, the failed-from time is set, and its class is **pre-E0**. This is the fail-closed result the owner chose (condition b: PASS).
  - Main Bot reconciles in all three ranges with no fills.
- **Parity with the boundary read.**
  - Bot 3 shows 24 fills and 12 lots, equal to the boundary read. All 24 marker cells are ABSENT and none DISAGREES; the marker counts add up to the fill count. Nothing is cost-clamped and findings are not capped. PASS.
  - Bot 2 shows 3 fills and 2 lots, equal to the boundary read. The failed-from time equals the first fill and is before the E0 boundary; no marker cell sits before it, and the marker counts are 0 as expected. PASS at class pre-E0.
- **Note (item 3d).** The Bot 2 "Why reconciliation failed" note shows in English and in Thai, with the reason code EPOCH_UNKNOWN verbatim.
- **Main Bot (item 3e).** The Month answer is 200 (no 503). Week coverage is complete (9869 of 9869 minutes) and Month coverage is complete (1229 of 1229 minutes). All Time coverage is unavailable by the coverage budget and was not checked further.
- **Live flag.** `liveEnabled` is false (Root read the admin health answer, view only).

## A2M

- **Authority.** GO-A2M issued by Root under the owner's standing A2M authority of 2026-11-01 (ruling RP20), because the GO-A2 not-after time had passed.
- **Job ID.** `s6-r2-a2m-a01-05d8b1d8ac60801f354b361b` (manifest `aeeb0cc9`, receipt `9d9110d6`).
- **Host time.** 2026-11-01T20:33:24.601Z to 20:33:24.705Z, about 0.1 seconds. Code `A2M_RETURNED`, verdict **A2M_PASS**.
- **Result.** The API process digest is the same as at the A2 delayed check (same API process; the API class is RUNNING). The QR-2 worker thread is present.

## Memory readings (RC-Q36)

| Reading | API resident MiB | Host available MiB |
| --- | --- | --- |
| A2 gate, before the switch | 100 | 6939 |
| A2 immediate check | 95 | 6886 |
| A2 delayed check, after the switch | 88 | 6904 |
| A2M, after the owner's requests, worker thread present | 176 | 6652 |

Headroom is fine: no limit was set and available memory stayed far above the 384 MiB estimate.

## Acceptance

Root accepted at **2026-11-01T20:34:21Z** (packet 6.9 steps 2, 3 and 4 done), on the receipt, the linkage review, the timing record and the A2M receipt. The review and the timing record are evidence for Root; Root decided.

**The 503 window is closed at this acceptance** (packet item F). It opened with the RA(r8) API start between 19:48:33Z and 19:50:08Z on 2026-10-30. The Main Bot Month answered 200 at the first read after A2 (2026-11-01T20:29Z); no answer between the A2 API start on 2026-10-31 and that read was observed.

## State now

- **Staging API** on pin `75c7a5b` with the P5a flag layer and the REPIN-2 layer, carrying the QR-2 boundary record. QR-2 flag effective 1.
- **Trading worker** `ba1a433`, market stream and collector timer unchanged. Production unchanged.
- **Scope:** Spot/Paper only, Live hard-locked. Private acceptance is NOT RUN; READY is false; P13j and N1 stay held.
- Product change (b) and the set B grant module are local and CI-green; they are NOT deployed.

## Still open

- **REPIN-2 layer rules.** The layer is live. No GO-R5a, GO-R4, GO-R4H or GO-RX may be issued before a GO-RA, and the RX tripwire stands.
- **Binding re-freeze.** A Root note only; no consumer needs it yet.
- **Owner items.** Set B decisions D1-D7, gate L-b question Q3 and Q3-a, the Pine Bridge alert check and the P1-F walkthrough.
