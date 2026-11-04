# S6 staging set B, B0 attempt a03 and B1 attempt a01 accepted, B2 held

Packet: [the set B packet r7](S6_STAGING_SETB_PACKET_R7_2026-11-03.md), jobs B0 (read-only preflight and reference record) and B1 (fresh backup). Environment: Staging QL-P2 Prototype. Recorded by the Claude root for jobs run on 4 November 2026 (UTC). The earlier stop of attempt a01 is in [the B0 a01 result](S6_STAGING_SETB_B0_A01_RESULT_2026-11-04.md). The scope is staging, not production.

## What ran

- **B0 attempt a02 (second first read).** Root reviewed its export at about 17:21Z (review E-FR2) and every point held: the export is complete; the trading drop-in digest is equal; the API process is the one that REPIN-2 A2 checked at its delayed check; the worker is the AR a01 process; the API drop-ins are the 18 files from before A2 plus the A2 layer file. The a02 export became the reference for a03.
- **B0 attempt a03 (compare), about 18:35Z.** It compared against the reviewed a02 export under GO-B0 v2. It ended with B0_PASS (code B0_PASSED): no drift of the API, the worker or the stream; anchors not drifted; production equal; M6 absent; the API running at the end.
- **B0F attempt f03, about 18:37Z.** The read-only fetch job brought the a03 export, the B0 receipt and the B0 private file into the local record. All ties held, and the a03 export equals the a02 reference.
- **B1 attempt a01, about 19:09Z.** The owner granted GO-B1 at about 19:07Z. The job ended with P2_PASS: one fresh backup of the staging database in the protected backup directory, verified by a restore into a throwaway cluster that was then removed, with teardown proven. The staging API and the trading worker got no command. No backup was deleted.

## Acceptance

Root accepts set B job B0 (attempt a03) and set B job B1 (attempt a01). GO-B0 and GO-B1 are used. This accepts these two jobs only; it does not close set B.

## Off the host path the same evening

- **B1 prep tool r2** is ready for Root. It uses the B0F file names, and the sealed hand-off from B0 to B1 is proven in the fake world.
- **Jobs rehearsal r5g2** is re-sealed. The r5f failure (a linked backup place) was a fault in a rehearsal check, not a defect in B2; the chain rerun passed. This is functional evidence only.
- **Scorecard S4** is a draft and is not frozen. It shows no credit change now or at set B close under the current method.
- **B2 input review.** An Opus auditor found a P1 before any host step: the trading-worker start values had been taken from the pre-P4 config. Root fixed them from the P4 layer rule, a re-audit said READY, and the derived worker config equals the live config digest that B0 read.

## B2 held

At about 19:43Z the owner typed GO-B2. The local B2 prep check then refused a false BASELINE_TIE on one protected unit. The cause is a known difference between two digest forms of the same config, not a change on the host. The owner then went to sleep, so owner checklist item 3 (a person who can stop staging is reachable during each job) is not met. B2 is HELD. No B2 host step happened and the GO-B2 was not used.

The a03 export passes the 6-hour GO-B2 limit at 2026-11-05T00:35Z. B2 therefore needs the spare a04 compare, a B0F fetch of its files and a newly typed GO-B2, with the owner awake. B2 prep tool round r4 (a Root-ruled exception for the baseline form) is in review.

## Not done

Set B is not closed. B2, the owner browser check and acceptance remain. Sealed is not accepted, and nothing here is a GO or an acceptance of B2.

## Scope

Spot/Paper only. No Live, no guard reset, no Best Inputs apply, no optimizer, no capital-model declaration.
