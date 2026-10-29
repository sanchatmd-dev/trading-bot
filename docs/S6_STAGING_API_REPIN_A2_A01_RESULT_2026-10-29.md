# S6 staging API re-pin attempt A2 a01: API switched and accepted

Packet: [S6-STAGING-API-REPIN-1](S6_STAGING_API_REPIN_PACKET_2026-10-28.md) revision 8, phases A2 and A2M. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 29 October 2026 (Bangkok).

Evidence:
- [result record](evidence/S6_STAGING_API_REPIN_A2_A01_RESULT_2026-10-29.json);
- [build record](evidence/S6_STAGING_API_REPIN_BUILD_R8_2026-10-29.json);
- the A1 job: [A1 a01 result](S6_STAGING_API_REPIN_A1_A01_RESULT_2026-10-29.md).

## Outcome

The owner typed GO-A2 in chat in reply to Root's request of the revision 8 GO-A2 line, which covers A2 and the A2M clause:
- the named risks are E, 2, 4, 6 and 8, as Root proposed;
- notAfter is 2026-10-30T09:00:00Z, set by Root under the 24-hour precedent.

**A2 is accepted** under packet section 6.9. A2 passed, the owner browser step passed, and A2M passed. Both jobs ran once, are consumed, and had no retry.

## A2: the switch

- **Run.** A2 ran from 09:26:02Z to 09:30:34Z with verdict **A2_PASS** (code `A2_PASSED`).
- **Switch.** It switched the staging API from the `ba1a433` tree to the tree of pin `33e5a8c` that A1 staged, with one re-pin layer named by the revision 8 rule.
- **Checks.** The immediate checks and the delayed check about five minutes later all passed.
- **Unit states.** The trading worker, market stream and collector timer stay running. The research worker and the collector service stay inactive.
- **Production** is unchanged.

## Owner browser step

At the owner's request, Root timed the per-Bot reports and read the panel texts in its own tab of the owner's logged-in session, through the owner's port forwarding. The owner confirmed identity for the admin health page, and Root entered no credential.

- **The new tree is served.** The pages load with the pin's cache token.
- **Week:** each request answers 200 in about 100 to 150 ms. Bar coverage is **complete**: 4907 of 4907 minutes, none missing.
- **Month and All Time:** each request answers 200 in about 110 to 150 ms, and the report comes back. Bar coverage shows **"not checked"**, because the range is over the coverage check budget.
  - Before A2, Main Bot's Month answered 503.
- **Texts.** The coverage texts read correctly in English and in Thai.
- **Admin health:** `liveEnabled` is **false**.

## A2M: memory after the requests

- **Run.** A2M ran at 09:56:43Z with verdict **A2M_PASS**.
- **Same process.** The API is the same process as at A2's immediate and delayed checks; it has not restarted.
- **QR-2 worker thread.** It now exists.

API resident memory (contract RC-Q36), against Root's 384 MB estimate for newly computing ranges:

| Reading | API resident memory | Host available memory |
| --- | --- | --- |
| Before the switch | 183 MiB | about 6.9 GB |
| Immediate check | 96 MiB | about 6.9 GB |
| Delayed check | 89 MiB | about 6.9 GB |
| After the report requests | 176 MiB | about 6.9 GB |

The API has no memory limit.

## Observation

Bots 2 and 3, the Bots with Paper fills, report status UNAVAILABLE with reason `RECONCILIATION_FAILED`.

- **Cause.** The replay check finds `LEDGER_RULE_UNREPLAYABLE` from one early-October fill (QR-2 contract, check RT).
- **Not caused by the re-pin.** The re-pin changed no ledger or reconciliation code, so this predates A2.
- **Effect.** Their facts and bar coverage are shown, and their financial totals are null.

## State now

- **The staging API** runs the pin `33e5a8c` (the QR-2 range fixes, the 422 hint and the long-range "not checked" result), with the P5a flag layer.
- **The trading worker** stays on `ba1a433`.
- **The market stream and the collector timer** stay on.
- **Rollback** is RA, under its own GO-RA.
- **Scope:** Spot/Paper only, and Live is hard-locked. Private acceptance is not run; READY is false; P13j and N1 stay held.
