# S6 local input lock — 2026-10-23

Status: **LOCAL FREEZE COMPLETE; NOT RUNTIME ADMITTED**. The owner explicitly authorized this local freeze after the [pre-freeze packet](S6_INPUT_REPLACEMENT_PRE_FREEZE_PACKET_2026-10-23.md). The historical packet and metadata evidence retain their original preparation-only scope. This record supersedes the pending local-freeze status only; it does not change any deployed selection or historical run.

## Frozen selection and identity

| Field | Result |
| --- | --- |
| New local lock SHA-256 | `8a25b8021c98d24f81913ea6386c6743d7b0f32fcb4df30b5ae95f5aa05604d8` |
| Preserved historical lock SHA-256 | `9db0f7723ecff6d05ce9c618b1a5798039d2081c83c698a8b3c9c51f3a1cb184` |
| Approved source SHA-256 | `0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a` |
| Slot 10 | `minRiskATRInput`, ID `13c15795e77cab5b058a991f` |
| Domain and baseline | min 0.50, max 2.50, step 0.50; baseline 0.50 |
| Grid | 0.50, 1.00, 1.50, 2.00, 2.50 |
| Fixed replacement | `confirmLookback=5` |
| Source inputs | Eight selected, 50 fixed; all 58 effective values unchanged |

The new lock is an additive ignored local artifact. Neither the archived source bundle, historical lock, earlier proposal nor historical runs were overwritten. Slots 3–9, their domains, both Bridge values and grids, signal mapping, risk policy and datasets remain unchanged. The baseline remains Custom with `useMTF=false`, `useSlowFilter=true`, `useRSIFilter=false`, `requireBOS=false`, `requireSweep=false`, `useSession=false`, `notifyEnabled=false` and source buffer 0.60. “Disabled filters” in the earlier packet does not mean that every filter is false.

## Verification

Before freeze, Root rechecked all archived private file hashes, source identity, 58 parsed input identities and metadata, historical snapshot and effective-map hashes, and instruction versions. The current parser, input-review and lock-contract code hashes were pinned. The existing lock was reproduced exactly with the unchanged lock function. The historical review record was preserved; no new owner-review timestamp or runtime attestation was manufactured.

The new lock passed canonical hash and JSON roundtrip checks. Its complete effective map matches the old lock. Self-coherence passes; comparing it with the old selection still refuses with `RESEARCH_SELECTION_MISMATCH`. Five focused existing unit tests passed with zero failures or skips, covering complete reviewed-input maps, invalid grids/bindings and selection coherence. These are local pure checks, not PostgreSQL or target evidence. Independent artifact review passed; [evidence](evidence/S6_INPUT_LOCAL_FREEZE_2026-10-23.json) records exact hashes, counts and limitations.

Independent admission review found an overly broad verdict substring check in the initial local script. Root replaced it with an exact, unique affirmative verdict before freeze; the original finding and successful recheck remain preserved. No product code or security guard changed. The C3/N9 resource gates remain unchanged; this static lock operation does not admit those workloads.

## Remaining gates

Current analysis-proposal membership and deployment selection remain **UNKNOWN_NOT_QUERIED**. Before generation or runtime use, a separately authorized packet must verify a successful analysis scoped to the owner, Bot, import and source version, its eligible-input allowlist, and deployment/selection applicability. Do not reuse the old deployed selection, bypass `INPUT_REVIEW_REQUIRED` or `RESEARCH_SELECTION_MISMATCH`, or treat this local lock as deployed.

Later S6 acceptance still needs separately bounded real-data effects and TradingView/evaluator parity on an authorized immutable development window. No holdout access, larger range, optimizer loop, source compilation, generation or provider call ran. Local freeze alone proves neither input effect nor profitability, a qualified winner, S6 completion or prototype completion.

Spot/Paper only; private source local, private acceptance NOT RUN, READY false and P13j/N1 HELD. No deployment, target route activation, shared/target migration, host/VPS work, native compilation, C3 process fixtures, PostgreSQL/C3 runtime, Live, guard reset or Best Inputs apply.
