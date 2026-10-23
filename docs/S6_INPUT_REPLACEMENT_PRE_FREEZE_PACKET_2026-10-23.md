# S6 input replacement: metadata and pre-freeze packet

Status: owner decision recorded; static metadata verified; input lock NOT FROZEN. This packet authorizes no target action, source change, research run or acceptance. The owner requested metadata inspection and preparation before any freeze on 2026-10-23 (Bangkok).

## Owner decision and preserved baseline

Replace only source slot 10 with `minRiskATRInput`: baseline 0.50, minimum 0.50, maximum 2.50, step 0.50. The proposed grid is `[0.50, 1.00, 1.50, 2.00, 2.50]`. Keep `confirmLookback=5` fixed. Slots 3–9, the Bridge pair and its existing grids/baselines, signal mapping, effective Custom settings, disabled filters, risk policy and datasets remain unchanged.

This decision supersedes the earlier unapproved proposal of 0.50–1.50 with step 0.25. That historical proposal is preserved. It does not supersede the existing frozen input lock, whose hash remains `9db0f7723ecff6d05ce9c618b1a5798039d2081c83c698a8b3c9c51f3a1cb184`.

## Static metadata evidence

The local inspection read the original private source bundle and historical approved snapshot without exporting Pine source. It used the existing static parser, verified 58 unique input identities, recomputed the historical effective-input and snapshot hashes, verified the existing lock hash, and checked all three private files were byte-identical before and after. This is an archived-source metadata check, not a fresh runtime attestation or private acceptance.

| Field | Verified value |
| --- | --- |
| Approved source SHA-256 | `0be2c64c85ea2c7ef15b00b3bc1d73df1b9ee140398ef2a23a7858209999f01a` |
| Replacement input ID | `13c15795e77cab5b058a991f` |
| Pine variable / type / eligibility | `minRiskATRInput` / `float` / eligible |
| Source default / historical effective value | 0.50 / 0.50 |
| Source-declared minimum / maximum / step | 0.05 / no declared maximum / 0.05 |
| Current evaluator contract bounds | 0.05–100.00 |
| Owner grid / count | 0.50–2.50, step 0.50 / five values |
| Grid increment relative to source step | 10 source increments |
| Retained input | `confirmLookback`, ID `be4f29f201a27c098a4a8345`, effective value 5 |
| Unchanged source buffer | `slAtrBufferInput`, effective value 0.60; its source default is 0.50 |
| Historical effective-input SHA-256 | `e571b4d9d1bd10704c2bc0e480221669987ef1c2bfab22ebd3da2189f0071ec2` |
| Historical snapshot SHA-256 | `1ddf2c2f3ec988a1231785d990e066d7f303ec7403d86c811a2ef4a56620cacc` |

The baseline and both grid endpoints align exactly. Five values preserve the old slot's cardinality; this does not authorize a larger search, optimizer or dataset. The source maximum is unspecified, rather than 100: the separate evaluator contract supplies that upper bound. The source default of the buffer must not replace its reviewed effective value.

## Before a separately authorized freeze

1. Root rechecks the exact source, parser and historical snapshot identities against this evidence. Any source or identity mismatch stops the packet; never infer the input ID from its name alone.
2. Preserve the complete reviewed 58-input baseline. Confirm that Custom/HTF-off, disabled filters, source buffer 0.60, `confirmLookback=5`, Bridge settings and slots 3–9 are unchanged. Do not manufacture a new owner-review timestamp from this static check.
3. If the owner separately authorizes a new local lock, move `minRiskATRInput` from fixed inputs into slot 10 and move `confirmLookback` into fixed inputs at 5. The counts remain eight selected source inputs and 50 fixed source inputs. Revalidate all bindings/domains and derive the new lock hash from the new selection and domains. Preserve the old lock and all historical runs; never overwrite or relabel them.
4. Record fresh analysis-proposal and deployment applicability separately before any generation or runtime use. Current `proposal.eligible_inputs` membership and current deployment selection are UNKNOWN in this packet. The successful analysis must match the authorized owner, Bot, import and source version. Static `eligible=true` is not proof of that proposal allowlist.
5. The old deployed selection and a future replacement lock differ. Existing `INPUT_REVIEW_REQUIRED` and `RESEARCH_SELECTION_MISMATCH` guards must continue refusing incompatible requests. No bypass, deployed-selection edit or stale-lock reuse is permitted.

The owner has approved the dimension and domain only, plus this metadata/preparation work. Freeze, generation, deployment, target inspection and runtime actions remain unperformed and outside this packet's authority.

## Later S6 verification, not admitted by this packet

The proposed input directly gates source BUY and native EXIT. A higher threshold is stricter at the same source state, but later state/cooldown can change; fewer total signals or safer exits are not guaranteed. Bridge protection and Risk Manager remain separate and unchanged.

Before S6 acceptance, a separately bounded packet must establish real-data effects and TradingView/evaluator axis parity on an authorized immutable development window. Preserve cold-start/warm-up rules; do not read or reopen holdout data, extend the data range automatically or search until an effect appears. If the declared grid shows no effect or insufficient samples, record that result and return for a decision. Synthetic reachability, parser success and grid arithmetic do not establish S6 completion, profitability, target readiness or a qualified winner. Mixed-candidate parity and other carried acceptance gates remain separate.

## Evidence, ownership and stop conditions

[Metadata evidence](evidence/S6_INPUT_METADATA_PRE_FREEZE_2026-10-23.json) records the sanitized result and local artifact hashes. Root alone owns integration and acceptance. Independent Astra review checks the script, sanitized metadata, packet and public guard paths; reviewers receive no private source. No runtime regression suite is needed for this documentation-only decision record.

Stop on source/hash/input identity mismatch, a baseline/domain discrepancy, unavailable required attestation, denied proposal membership or selection incoherence. Unknown target state stays unknown. A future freeze needs its own bounded owner instruction after this packet is reviewed; this document is not that instruction.

Spot/Paper only; private source remains local; private acceptance NOT RUN; READY false; P13j and N1 HELD. No native compilation, C3 process fixtures, PostgreSQL/C3 runtime, deployment, target route activation, shared/target migration, host/VPS work, Live, guard reset, Best Inputs apply, backfill or private-source upload.
