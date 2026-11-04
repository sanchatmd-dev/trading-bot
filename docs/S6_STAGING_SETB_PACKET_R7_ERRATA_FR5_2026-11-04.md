# S6 staging set B packet r7: erratum E-FR5 (read-only fetch job B0F)

Document ID: **S6-STAGING-SETB-1-R7-ERRATA-FR5**. Date: 2026-11-04. Status: **APPROVED by the owner on 2026-11-04 (about 14:53Z UTC)** (Root ruling SB122; decision Q5 is asked at the set B close). Author: documentation role (Sonnet 5.5 / low), child of "Root: astra-vps-trade-bot-v2".

## 0. What this document is

1. This erratum adds a new read-only job, B0F, to the set B packet r7 job list. It amends `docs/S6_STAGING_SETB_PACKET_R7_ERRATA_FR_2026-11-04.md` (E-FR1 to E-FR3) and E-FR4 only where they say how B0 record files reach Root. It does not change the packet r7 file. Everywhere else the packet r7 and E-FR1 to E-FR4 stand unchanged.
2. Nothing in this document is a GO. It issues no approval, starts no job and changes no gate. GO-B0F is a separate owner record and covers only what it names.
3. Basis: Root rulings SB112 and SB113 (`root-ruling-sb1.md`) and the design `g-b0-exp-design-2026-11-04.md`, kept in the local evidence folders, not in tracked files.

| Item | Short name | Ruling | Text amended |
| --- | --- | --- | --- |
| E-FR5 | Fetch job B0F; GO-B0F | SB112, SB113 items 1 to 5 | Packet r7 section 3 job table (one new row); B2 prep source wording |

## 1. Reason

1. B0 writes its private record files on the host and never sends them back. The packet has no removal step, so they stay there.
2. Root needs four of them locally: the a02 export (E-FR2 review, a03 COMPARE prep); and the a03 export, receipt and private file (B1 prep, B2 prep, E-FR3 layer binding). Without them the path stops at the a02 review.
3. No sealed set B tool brings these files back. A manual copy through an agent shell would put private bytes into a transcript. That is refused.

## 2. The new job B0F

1. B0F is a small sealed tool, not a lane job. It reads named B0 record files on the host and brings them to the local private evidence folder. Root seals it after this approval; sealing is not a GO.
2. Reads. For each target (one B0 attempt and job), it reads only files from a closed list of three: the export, the receipt and the private file. Paths are composed from the bound record root, attempt and job ids; nothing is listed or discovered.
3. Checks. The tool takes the real uid and process id from the running process. It checks exactly this:
   - Every component from the filesystem root to the record root is a real directory and never a link.
   - The record root is owned by the job user and has no group or other write.
   - The record directory is owned by the job user, mode 0700.
   - Each file is a regular file owned by the job user, mode 0600, with one link.
   - The file time lies in the B0 run window.
   - The record root and the record directory are checked again after the reads.
   - The file is read once and is stable. The ids inside match the target. The sha256 equals the bound pin when one is known.
   - Residual: ancestors above the record root are not owner-checked.
4. Local writes. Only after every file passes, the local runner writes each file once, with exclusive create, to its own execution folder under the ignored local evidence folder, with private names. The public runner receipt pins each file by sha256 and size.
5. Host writes: none by the tool's own program. The shell may create and remove its own temporary here-document file while it starts the program. This is the same as the attached AR-B job.
6. Output. Standard output and logs print only hashes, sizes, booleans and codes. No file content is printed anywhere.
7. Failure.
   - A host stop, a frame stop or a transport stop writes no fetched file.
   - The runner always writes its own marker, envelope, retained output and receipt.
   - Any end other than B0F_PASSED after the local write keeps the fetched files and names them in the receipt (a local tie stop is one case). Root does not use them.
   - A local write fault removes what it created and ends B0F_STOP_LOCAL_WRITE.

## 3. Authorization

1. B0F needs its own owner GO, GO-B0F, as every listed job does.
2. One GO record. Attempts: f01 for the a02 export; f02 for the a03 export, receipt and private file; spare f03 for a transport failure. Each attempt is spent once. The record covers nothing else.
3. Each run: one operations worker, serial and alone, no other set B admission in flight. A Root runner GO window opens each run. Root reviews the receipt.
4. Root writes the GO record only after the owner approves this erratum.

## 4. Integrity ties

1. Admission. The fetch admits only a B0 run that passed. For the a02 export it admits also a first read that completed, meaning end B0_STOP_DRIFT with the first read completed. The pinned runner receipt must equal the receipt hash printed by the B0 runner at its run, which Root records at the B0 review.
2. Path, owner, mode, link count and file time all fit the B0 run window. The B0 runner receipts are pinned by sha256 in the B0F manifest. The tool derives hostWindow, the private file size, the runner end code and the reference AR form from them.
3. The ids inside each file equal the B0 manifest.
4. The host hash equals the local hash over the pinned channel.
5. a02 export: its API and trading-worker AR-form members equal the a02 runner receipt members. A difference means a restart during the run, and Root does not adopt the export.
6. a03 files: the private file size equals the size the B0 runner receipt publishes. The export hash and size equal the fetched receipt pins. The private file hash and size equal the receipt private-file pin. The digest of the export AR form equals the receipt export digest. The receipt verdict is compared with the pinned runner code.
7. The B1 prep and B2 prep repeat the same ties.
8. Residual: the a02 export has no pin carried through the B0 output, so an actor with the job user's rights could craft one. The file change time must also lie in the run window. This narrows the residual but does not close it. A later B0 revision may add public file digests.
9. Residual: the receipt pin travels only after the fetch.
10. Residual: a B0 pass does not prove the record root owner and mode. Root checks them from accepted evidence before GO-B0F.

## 5. Effect on timing

1. The a02 first read does not wait for B0F. It runs on the sealed B0 r3h after E-FR4 approval, its GO and the tree owner check. Its export stays on the host until f01.
2. f02 runs right after a03.
3. The 6-hour rule binds the a03 export, which is the B2 reference. The span runs from the a03 export time to GO-B2 and holds f02, B1 prep, GO-B1 with the B1 run, B2 prep and GO-B2. The f01 fetch is outside every age window.

## 6. Privacy

1. Fetched files stay in the ignored local evidence folder with private names. They never enter tracked files, transcripts, logs or progress lines.
2. The workstation is Windows and does not enforce the file mode. Privacy there rests on the ignored folder, the user profile and the private-name rule that keeps agents out.
3. The B2 prep README source wording now reads: the files come from the sealed fetch job B0F under E-FR5 (pending owner approval), never from a manual copy.

## 7. Owner decisions needed

| Question | Options | Owner decision |
| --- | --- | --- |
| Q1 Approve E-FR5 | Approve job B0F as described, or change it | Approved 2026-11-04 |
| Q2 GO-B0F attempts | f01 (a02 export), f02 (a03 three files) and spare f03; or change | Approved 2026-11-04: f01, f02 and spare f03 |
| Q3 a02 now | Run the a02 first read now on B0 r3h, fetch its export later (proposed yes) | Approved 2026-11-04 |
| Q4 POSIX happy run | Where the real-uid POSIX happy run of B0F happens: a local Linux environment, or fake-world tests plus the first real run as the real-uid run | Approved 2026-11-04: fake-world tests plus the first real run (f01) |
| Q5 Retention | Keep the fetched private files after set B closes, or remove them by exact path at set B close | Open: kept until the set B close, then asked |
| Q6 Output cap | Approve the B0F output cap, which is above the packet section 11.1 output maximum for attached jobs (32 KiB); see section 8 | Approved 2026-11-04 |

## 8. Limits

| Limit | Value |
| --- | --- |
| File caps (three files) | Each equals the B0 writer cap: 4 MiB (4194304 bytes) |
| Output cap | Computed per run from the bound files: base64 of the caps plus 8 KiB; one target with all three files about 16 MiB (16785416 bytes); ceiling 32 MiB (33554432 bytes) |
| Envelope | 16384 bytes |
| Receipt | 65536 bytes |
| Payload script | 262144 bytes |
| Host bound | 120 s |
| Connect | 5 s |
| Kill after | 10 s |
| Local cutoff | 140 s |
| Termination wait | 5 s |
| Overall | 160 s |
| Start-by window | at most 600 s |
| Clock skew | 5 s |
| Local runner-receipt copy cap | 1 MiB (1048576 bytes) |
| Host deadline | start-by plus 150 s to start-by plus 160 s |

Timing inequality: host bound plus kill-after plus connect lies within the local cutoff; local cutoff plus termination wait lies within overall. Every manifest limit equals these values exactly. Only the output cap varies per run.

The output cap is above the packet section 11.1 output maximum for attached jobs (32 KiB). It needs the owner's explicit approval (owner decision Q6).

## 9. What this document does not approve

1. No GO: it does not open GO-B0F, GO-B0 or any other record, and starts no run.
2. It does not approve the B0F build, seal or any host step.
3. GO-B1, GO-B2, RS, RB, RBX, RBC and AR-B are excluded and need their own records.
4. The Spot/Paper-only scope, the packet r7 gates, E-FR1 to E-FR4 and the immutable-evidence and holdout rules are unchanged.
