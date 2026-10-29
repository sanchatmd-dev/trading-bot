# S6 staging API re-pin attempt A1 a01: tree staged, layer name does not fit

Packet: [S6-STAGING-API-REPIN-1](S6_STAGING_API_REPIN_PACKET_2026-10-28.md) revision 7, phase A1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 29 October 2026 (Bangkok).

Evidence:
- [result record](evidence/S6_STAGING_API_REPIN_A1_A01_RESULT_2026-10-29.json);
- [build record](evidence/S6_STAGING_API_REPIN_BUILD_2026-10-28.json).

## Outcome

Root issued GO-A1 attempt a01 under the owner's standing authority of 28 October 2026. That authority covers GO-A1 and GO-A2 "when ready", with notAfter 2026-10-29T19:00:00Z. The authority makes GO-A2 depend on an A1 record whose layer-name boolean is true.

The job ran once, in one SSH session, from 06:50:47Z to 06:50:59Z (about 12 seconds). Its verdict is **A1_PASS**. The runner exited 0 and wrote nothing to stderr. The job is consumed; there is no retry.

Root verified the run's links:
- the receipt hash, job ID, manifest hash and nonce;
- the GO-consumed marker.

## What A1 did

- **Gate.** The gate passed: host health floors, no pending systemd job or reload, the production units equal to the recorded baseline, and the reference facts equal to the collector c1 export.
- **Transport and staging.** The tool received the package (4 files, framing and checksums correct). It staged the new API tree of the pin `33e5a8c` inert, next to the running tree:
  - 1660 files, every one matching the build;
  - the tree digest equal to the manifest;
  - all 145 Node syntax checks passed.
- **Records.** It wrote one record directory in the dedicated backup directory.
- **No unit changes.** It changed no unit:
  - the staging API, the trading worker and the market stream are the same processes as at the gate;
  - the research worker and the fallback collector service are inactive;
  - the collector timer is active;
  - production is unchanged.
- **Drop-ins.** It read the staging API drop-in layers inside the host process. It found both the P5a flag layer and the admission-off layer (18 live layers, none between them), and exported their digests privately. The drop-in list digest equals the c1 value.

## Why A2 stops here

The layer-name boolean `layerNameFits` is **false**.

- **The rule.** The packet's reviewed name rule tries 100 candidate names for the new re-pin layer. A candidate must sort after the P5a flag layer and before the admission-off layer.
- **Why nothing fits.** The two recorded layer names share one two-digit prefix. With the fixed name stem, no candidate sorts after the P5a flag layer, so no name fits between the two layers. This is a limit of the naming rule, not a host problem.
- **The other conditions.** Every other acceptance condition of the A1 record holds: both layers found, digests present, the P5a layer digest present exactly once, counts equal, the list digest equal to c1, the tree exact, and the end reading equal to the gate.

Packet section 5.2 says that a false boolean blocks the A2 request, and that the order rule changes only by a new Root ruling and packet revision. GO-A2 is therefore not requested.

The staged tree is accepted as staged. It is inert: no unit points to it.

## State now

Staging runs as before. The staging API and the trading worker are on `ba1a433` with the P5a flag layer, and the market stream and the collector timer are on. The new tree waits, unused, for a revised A2.

Scope stays Spot/Paper only, and Live is hard-locked. Private acceptance is not run; READY is false; P13j and N1 stay held.

## Next

1. A packet revision with a name rule that can place the re-pin layer between the two layers, and the matching tool change and review.
2. A new owner GO for A2.
