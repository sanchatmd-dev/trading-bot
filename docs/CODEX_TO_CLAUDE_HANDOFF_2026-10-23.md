# Codex to Claude: project and latest-work handoff

Date: 2026-10-23, Asia/Bangkok. Repository: `sanchatmd-dev/trading-bot`.

## Authority and transfer state

The owner explicitly requested that Codex stop, checkpoint the entire project and latest work, and hand off to Claude. Codex has stopped implementation and dispatch. All three children are completed and frozen. The continuation heartbeat remains PAUSED. No pending CI or assigned runtime job remains in the outgoing checkpoint. Claude becomes the sole root only after verifying this handoff, current Git state, file ownership, runtime and its own account usage. Codex must not resume concurrently.

This is a local file handoff. No direct Claude session transport was available to the outgoing root; delivery and Claude acceptance are not claimed. The local entry point is `.qa-local/claude-handoff-2026-10-23/checkpoint.md`. It contains checkout locations, preservation details and the exact local continuation instructions. Ignored evidence is essential and is not available from a fresh cloud clone.

The owner previously authorized continuous bounded local Roadmap work, focused tests, independent review, evidence updates and periodic commit/push. The latest stop request takes precedence for the outgoing root. It does not waive any incoming platform, phase, runtime or target gate.

## Read order and authoritative sources

1. Read `AGENTS.md`, `CLAUDE.md` where applicable, and `.agents/skills/caveman/SKILL.md`. Use the Claude column of the role policy. Read `docs/AGENT_TEAM.md` and `.agents/TASK_PACKET_TEMPLATE.md` before dispatch.
2. Read the ignored handoff checkpoint, then the top notes and relevant sections of `README.md`, `Context.md`, `docs/ROADMAP.md` and `docs/TIME_MANAGEMENT.md`. Roadmap owns the next action. Historical notes do not override later acceptance or gates.
3. Read `docs/PROJECT_STATUS_2026-10-23.md` for project/prototype diagrams and `docs/progress/PM1_SCORECARD_S2_2026-10-19.md` for the last accepted numerical measurement.
4. For current work, read `docs/QR2_S5_4_STAGE2C_COMBINED_MEASUREMENT_PACKET_2026-10-23.md`, `docs/QR2_S5_4_STAGE2C_FUNCTIONAL_PACKET_2026-10-23.md` and `docs/evidence/PM1_QR2_S5_4_STAGE2C_LOCAL_2026-10-23.json`.
5. Read the current Windows launch draft and independent review under `.qa-local/qr2-s5-4-stage2c-diagnostic-runtime/` before proposing any implementation.

## Git and unfinished ownership

The active local branch is `codex/fe2b-ci-local-fix`. HEAD and the allowed remote branch were rechecked at `3727c262911e04cdb47e62cdd1e83f8ba1af6e27`. Push only to `origin/codex/app3a-market-wait-checkpoint-gwylmk`. Do not use `main`, merge WIP `a877733`, reset, drop stashes or overwrite unrelated work.

The original checkout remains separate and read-only, with nine preserved dirty paths. Both protected stashes remain intact:

- `ae7db28e0494ea502f37b4da806518518bcdef9d`
- `7a5f3f4c370cb424ed019d966060c242ba14e6ad`

Immediately before this handoff, the owner requested restoration of the previous Codex team. Fourteen reviewed files are modified but **not committed or pushed**:

- `.codex/agents/coder.toml`, `debugger.toml`, `documentation.toml`, `operations.toml`, `release-clerk.toml`, `routine-worker.toml`, `tester.toml`
- `.codex/config.toml`, `AGENTS.md`, `docs/AGENT_TEAM.md`
- `README.md`, `Context.md`, `docs/ROADMAP.md`, `docs/TIME_MANAGEMENT.md`

All fourteen changes belong to the outgoing root. This handoff additionally adds this document and a short handoff pointer in the four top-level status documents. Nothing is staged. No product code, tests or fixtures changed during team restoration or handoff.

The restored Codex mapping is Root Astra/high; architecture auditor Astra/medium; other roles GPT-6.1 Sol, with debugger/operations high, coder/tester/routine worker medium, and documentation/release clerk low. Seven role-file changes affect only `model`. Existing agents' actual models did not change. Validation and `git diff --check` passed; product tests were not run for configuration-only edits. See `.qa-local/agent-restoration-validation.json`.

The prepared `.qa-local/release-agent-restoration.mjs` was **not executed**. Its old fourteen-path list excludes this handoff: do not run it unchanged. The incoming root must review the complete current diff and prepare a new exact-path release if appropriate. Preserve the user's existing commit/push authorization without treating commit, CI, deployment and acceptance as equivalent.

## Whole-project position

The project is a Spot/Paper trading and research system, not an accepted production launch. The existing system includes a UI/AI Bridge, market/chart ingestion, ten-input strategy binding, evaluator/parity checks, TradingView signals, Paper risk and ledger flows, optimization/research jobs, Library/freeze/comparison, fixed evaluation, portfolio reporting, and package/export preparation.

| Area | Established scope | Remaining acceptance |
| --- | --- | --- |
| AI Bridge, basic UI and market/chart flow | Historical local/staging baseline | Current complete owner journey and target reconciliation |
| Strategy inputs and evaluator parity | Local modules and bounded evidence | Current target parity/ten-input acceptance |
| TradingView BUY and targeted EXIT | Historical accepted Paper pair | Broader current risk/ledger integration and target journey |
| Research/optimizer, R7 and QS | Bounded local implementation and qualification | Full qualification, native/host capability and target gates |
| Library, freeze and comparison | Local fixes and module evidence | Complete pinned owner flow and current target acceptance |
| FE-2b fixed evaluation | Local lifecycle and CI repair accepted | Does not certify private or target acceptance |
| QR-2 portfolio reporting | S4 verification and S5-1/2/3 synthetic local UI accepted; S5-4 partially implemented | Combined costs/lifecycle, public interval rendering, full S5 and target integration |
| QR-3 comparison / QR-4 selection | Local modules | Complete end-to-end selection flow |
| Best Inputs, export and email | Local builder work | Validation, trace and SMTP/target acceptance; apply remains gated |
| APP-3B multi-Pine | Bounded local R6 work | Private acceptance NOT RUN, READY false |
| MD-1 scale, customer security/entitlements, operations | Planned or partial engineering | Production scale and release gates |
| Public/paid Paper launch and Live | Not accepted | Launch NOT RUN; Live held and outside progress denominator |

The minimal prototype is narrower: one owner, one Bot, one supported Pine, `BINANCE:BTCUSDT` Spot 1m and the existing 10K-bar profile. `docs/STAGING_PROTOTYPE_PLAN_2026-10-01.md` owns that journey; its early status table is historical. Full portfolio reporting, broad multi-Pine support, complete export/email, paid launch and Live are outside this denominator. A valid outcome may be `NO_VALID_CANDIDATE`; profitability is not required. The complete pinned owner journey is not accepted.

The latest accepted score remains PM-1 S2, measured at `ca6abb1` on 2026-10-20 Bangkok: whole project 64–73%, prototype 73–80%, with UNKNOWN weights 41.57% and 41.67%. These are historical engineering bounds, **not current percentages or target readiness**. Later engineering has no successor row scoring. Do not invent a new percentage from test counts or agent activity.

The English Understand Anything graph is complete for its historical snapshot `63d465f861ba3689558ce8ae84c44386b08207e3`: 1,312 eligible files, 4,066 nodes, 7,847 edges, ten layers and an eleven-step tour. It has 372 orphan warnings and extraction limits. `.ua/knowledge-graph.json`, fingerprints, exclusions and access token remain local and ignored. See `docs/evidence/PM1_CODEBASE_KNOWLEDGE_GRAPH_LOCAL_2026-10-23.json`. It is navigation evidence, not current product acceptance; later source changes are not automatically reflected.

## Recent accepted QR-2 work and exact CI

S5-1, S5-2 and S5-3 synthetic local desktop/mobile EN/TH verification is accepted within the evidence limits. Old notes saying browser use was disabled are historical. Real authentication and target integration remain NOT RUN. S5-2 qualified source/time before UI edits and displays book values without inventing a valuation timestamp. S5-3 has sixteen rendered cases, no measured overflow, 880 loopback GETs and no external HTTP in the recorded capture. Separate focused counts are not additive.

| Exact revision | Safety / Quant Lab runs | Evidence boundary |
| --- | --- | --- |
| `735bf9f7c11955396550ec60cbad479f9c050197` | [39807968713](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39807968713) / [39807968738](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39807968738) | S5-1 shell follow-up full CI passed |
| `09ecab3020ce6612183951968a5b86dae477cad2` | [39822914924](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39822914924) / [39822914467](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39822914467) | S5-2 repair full CI passed; original `819adaf` failed stale test tokens |
| `0ffc20011bbde1ec397f51bf344fe929557b054a` | [39841875708](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39841875708) / [39841875739](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39841875739) | S5-3 full CI passed |
| `a5d4db611b07062e0a302a05f5027e842c42a11b` | [39849193764](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39849193764) / [39849193796](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39849193796) | Stage 2A full CI passed |
| `d0acf931c2cf14cf330e69350d759599c2b503fe` | [39859557820](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39859557820) / [39859557826](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39859557826) | Stage 2C full CI passed; 21 selected named PostgreSQL PASS records |
| `2a89d1826902290ca54af3c8bf6be84c82267b47` | [39862387031](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39862387031) / [39862387010](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39862387010) | Full CI passed; 22 selected named PostgreSQL PASS records including financial differential |
| `3727c262911e04cdb47e62cdd1e83f8ba1af6e27` | [39877829949](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39877829949) / [39877829928](https://github.com/sanchatmd-dev/trading-bot/actions/runs/39877829928) | Documentation scope only: two scope steps and one gate passed; four runtime jobs skipped; zero new runtime tests |

Full CI above records nine successful jobs and sixteen actual substantive steps, not an inferred full-suite count. The selected PostgreSQL counts come from preserved named log records. The documentation HEAD is not new runtime evidence. Current raw closure is `.qa-local/qr2-s5-4-stage2c/p13f-documentation-ci-verified.json`; preserve its raw artifact and hash. Never rerun a collector that overwrites accepted raw evidence.

Stage 1 pure coverage passed 51 focused tests and 442 independent checks separately. Stage 2A final focused checks passed 29/29; an independent 409-check run preceded a narrow correction verified by 28 checks and audit. Stage 2B-M1 has twelve synthetic PostgreSQL cases including three refusals, preserved first import failure and verified cleanup. M2 has sixteen outcomes, fourteen successes and two refusals; all fourteen owner outputs were independently checked. Tiny-table plans and the measurement worker do not qualify production capacity or pool defaults.

Stage 2C now passes a bounded shared coverage registry from account/owner readers to the worker. Worker context/member validation precedes financial computation. Public routes, response fields, financial composers and pool guards remain unchanged. Removing an unused interior valuation bar preserved the financial response except established timers. Local Windows functional testing remains NOT RUN: the 21-test, six-file, eight-database packet requires fresh resource admission. Ubuntu CI does not prove Windows process lifecycle.

## Latest task: C3 diagnostic preparation, P13f design gap

Stage 2C combined measurement is preparation only. No native guardian, coupled measurement runtime or performance acceptance has been admitted. The evidence JSON currently records 200 previously verified source/artifact pins. Preserve immutable accepted originals before any revision.

Files below are under `.qa-local/qr2-s5-4-stage2c-diagnostic-runtime/`:

- `runner.mjs` is `INCOMPLETE_NON_EXECUTABLE`; its main/CLI always refuses with `C3_RUNNER_INCOMPLETE_NO_EFFECTS`. Nineteen pure/refusal groups passed. Shape checks are not authority, hashes or liveness proof.
- `workload.mjs` has four refusal checks and deferred real adapters. Parent callbacks remain absent.
- `supervisor-state.mjs` is a pure effect-description reducer, with no process, IPC, timer, filesystem or database effects. It models local monotonic deadlines, nested phases, durable ACK, terminal latch, cancellation versus verified exit, and independent cleanup.
- Its first twelve-group run had eleven PASS and one FAIL: trusted observations were not included in the aggregate message counter. Original source and findings remain preserved. The bounded correction passed fourteen groups, including two exhaustion/reservation groups. The limit is 32,768 admitted messages, with 32,766 ordinary slots and two terminal-observation slots. Exhaustion may leave cleanup UNKNOWN; it never means PASS. This does not exhaustively prove every valid phase or action ceiling.
- `windows-ownership-source-assessment.md`, pins and review distinguish retained process handles from PID lookup. Node/libuv global job behavior is not strict descendant containment; `TerminateProcess` requests are asynchronous and require exit verification. Source/version observations are not native binary provenance.
- `windows-launch-contract-draft.md` proposes a C# guardian with separate workload and PostgreSQL jobs, retained non-inheritable handles and suspended create/assign/verify/resume. It is a proposal only.
- `windows-launch-contract-review.md` finds a decisive **DESIGN_GAP**. No surviving inventory/stop executor is specified after JavaScript-supervisor death. Cleanup cancellation must not block the guardian's final deadline. Bootstrap, watched supervisor identity, lifetime origin and bounded relative deadline forwarding to the guardian's own monotonic clock remain unresolved. No deadline may renew an ancestor/global limit.

The next technical action, after incoming-root verification and admission, is one narrow amendment of that ownership/deadline contract followed by independent review. Do not start effectful implementation, native compilation, child-process fixtures or PostgreSQL merely because the design exists. The outgoing root found compiler command availability only, not compatibility or executed native proof.

The eventual measurement packet compares current inline execution with the unchanged actual default compute pool on the same synthetic fixture and clock. It specifies real loopback HTTP observations, independent clients, three warmups and twenty retained observations, nearest-rank statistics and preserved failures. The recovered historical 50.7 ms value is not a current baseline. Existing helper disposal suppresses close/DROP errors: a returned disposal call does not prove cleanup.

The analytical fixture has 5,000 owner rows, a heavy account at 4,990, 1,000 lots, 20,000 bars, 20,800 union minutes, 99,000 derivation visits and 4,000 intervals. The heavy-account at-limit gap remains explicit. The 1,339 producer operations are not a SQL count. Runtime budgets and analytical counts are provisional preparation, not observed combined performance.

## Runtime, usage and immutable gates

Handoff observation: Windows Node 24.19.0; free memory 943,544 KiB, below the unchanged 1 GiB admission floor; free disk 18,067,697,664 bytes; zero PostgreSQL processes. No runtime was started for handoff. Recheck before admission; disk floor is 2 GiB and competing PostgreSQL is disallowed. Do not free unrelated resources or lower guards to pass. Preserve the rejected cleanup directory and retained M1/M2 data identified in the ignored checkpoint.

The prior 2% Codex reserve-stop note is historical. The latest Codex reading has 99% weekly remaining, with the short window unknown. No reset credit was redeemed by this work. Claude usage is separate and UNKNOWN; verify it on Claude. Reserve 3% and apply every known window/bucket. Unknown all usage permits only local read-only planning/checkpoint work. Root model, effort and Claude ultracode state require client verification; file edits do not change running models.

Keep Spot/Paper only, `BINANCE:BTCUSDT` Spot 1m, reduce-only EXIT, immutable research evidence and independent holdout gates. Private source remains local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared/target migration, host/VPS work, Live, guard reset, Best Inputs apply, backfill or private-source upload is authorized by this handoff. Do not expand into a new phase merely to keep agents busy.

## Incoming root checklist

1. Confirm Codex is stopped and no other platform commands this checkout. Verify the exact active worktree from the ignored entry point; do not edit the original dirty checkout.
2. Verify Git HEAD/remote, unstaged ownership, both stashes, resource state and Claude usage. Record actual client model/effort/ultracode or UNKNOWN.
3. Preserve and review the unfinished team-restoration/handoff diff. If checkpointing it, stage exact reviewed paths only, push only the permitted branch and verify the resulting CI scope. Do not use the stale prepared release script unchanged.
4. Confirm the current Roadmap action against the complete prototype journey. The immediate C3 action is the bounded launch-contract amendment and independent review; its runtime gates remain closed.
5. Before dispatch, define explicit paths, acceptance, stop conditions and usage reservation. Children do not dispatch. Apply Claude roles and one-writer-per-file rules; root retains acceptance, browser coordination and Git integration.

Handoff validation is documentation/configuration verification only. No new product tests, runtime acceptance, deployment or numerical progress claim is made. Codex relinquishes command after saving this handoff; the project and prototype remain incomplete.
