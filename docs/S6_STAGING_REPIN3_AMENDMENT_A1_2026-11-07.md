# REPIN-3 packet r0, amendment A1 (Root, 2026-11-07T19:38Z)

Source: Root ruling SB205 (set C packet r0 accepted as working packet, .qa-local/packets-2026-11-07/setc/packet-r0.md) and SB191 U4.

1. H7a (GO-QR3-B) and H7b (GO-QR3-M) in sections 0, 4 (QB, QM), 7, 9 and 10 are WITHDRAWN. The QR-3 tables (M9), the exposure register (M7) and their targeted grant move into the one set C window (GO-SETC-R0, GO-SETC-M, GO-SETC-R) with the QR-1b freeze and the guard hardening. Tool T3 (QB/QM) is not built for REPIN-3.
2. The REPIN-3 pin is no longer fixed at 816c656. Under SB205 RR-C-6 option (a) the set C grant product code (src/postgres/quant-comparison-grants.js, quant-comparison-grant-state.js, scripts/grant-quant-comparison-runtime.mjs) lands before the pin is set. Root names the pin at H1 time: the latest commit with CI 9 of 9 green that contains the accepted grant code; the A0 record is regenerated for that pin by the pin-parametric generator, and the H1 to H3 GO lines carry it.
3. Order unchanged otherwise: H1, H2, H3 (each its own owner GO with the owner awake and reachable); set C after H2 and H3 are accepted with the research worker stopped (U3); never overlapping GO-FLT-1; before H8 and H9.
4. Consequence: REPIN-3 RWR (research-worker rollback) becomes invalid after set C step SC-3 unless the set C MR-H rollback runs first (set C packet risk list).
