# S6 staging API re-pin attempt A2 a01: API switched, acceptance pending

Packet: [S6-STAGING-API-REPIN-1](S6_STAGING_API_REPIN_PACKET_2026-10-28.md) revision 8, phase A2. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 29 October 2026 (Bangkok).

Evidence:
- [result record](evidence/S6_STAGING_API_REPIN_A2_A01_RESULT_2026-10-29.json);
- [build record](evidence/S6_STAGING_API_REPIN_BUILD_R8_2026-10-29.json);
- the A1 job: [A1 a01 result](S6_STAGING_API_REPIN_A1_A01_RESULT_2026-10-29.md).

## Outcome

The owner typed GO-A2 in chat in reply to Root's request of the revision 8 GO-A2 line:
- the named risks are E, 2, 4, 6 and 8, as Root proposed;
- notAfter is 2026-10-30T09:00:00Z, set by Root under the 24-hour precedent, because the owner gave no time.

The job ran once, in one SSH session, from 09:26:02Z to 09:30:34Z. Its verdict is **A2_PASS**, with code `A2_PASSED`. The runner exited 0 and wrote nothing to stderr. The job is consumed; there is no retry. Root verified the run's links: the receipt hash, job ID, manifest hash and nonce.

## What A2 did

- **Switch.** It switched the staging API from the `ba1a433` tree to the tree of pin `33e5a8c` that A1 staged, with one re-pin layer named by the revision 8 rule.
- **Checks.** The immediate checks and the delayed check about five minutes later all passed.
- **Unit states.** The trading worker, market stream and collector timer stay running. The research worker and the collector service stay inactive.
- **Production** is unchanged, and the trading worker's heartbeat is fresh.
- **API resident memory** (contract RC-Q36): 183 MiB before the switch, 96 MiB at the immediate check and 89 MiB at the delayed check. The host had about 6.9 GB of available memory throughout. The API has no memory limit.

## State now

- **The staging API** runs the pin `33e5a8c`. This brings the QR-2 range fixes, the 422 hint and the long-range bar-coverage "not checked" result.
- **The trading worker** stays on `ba1a433`.
- **The market stream and the collector timer** stay on.
- **Scope:** Spot/Paper only, and Live is hard-locked. Private acceptance is not run; READY is false; P13j and N1 stay held.

## Pending before acceptance (packet section 6.9)

1. **The owner's browser check:** Week, Month and All Time in English and in Thai, and admin health showing `liveEnabled` false.
2. **Root's record of those requests:** range label, status code and durations only.
3. **The read-only memory job A2M** under the same GO.

The owner's port forwarding to staging dropped after the switch, and these steps wait for it.
