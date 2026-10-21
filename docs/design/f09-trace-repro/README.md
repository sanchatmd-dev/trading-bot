# F09 builder S3 trace reproduction: design record

An Opus primary draft (`DRAFT_OPUS.md`) and an independent Fable draft (`DRAFT_FABLE.md`) were compared by an Opus judge (`JUDGEMENT.md`) on 2026-10-21 (Bangkok) in the Claude cloud root. The original local builder design D1 to D12 was not readable in the cloud, so the drafts restate it from the package contract.

Root ruling, 2026-10-21: the judgement's section 5.1 rulings R1 to R11 are adopted as recommended (R5: `decisions.csv` holds the replay decisions only). The proposed contract rows RC-34 to RC-39 (judgement section 4) are not yet in the package contract; they are recorded there after root accepts the S3 implementation (packet S3e).

Open owner question OQ-1 (holdout content in the trace files): until the owner answers, the S3 driver and module produce trace rows for every partition, each labelled with its `partition`, so that the render step can apply the owner's choice without changing S3. Nothing here ships a package or touches any host.
