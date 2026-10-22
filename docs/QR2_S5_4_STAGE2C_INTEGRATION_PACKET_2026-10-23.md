# QR-2 S5-4 Stage 2C: internal reader and worker integration

Status: **BOUNDED CI FUNCTIONAL AND FINANCIAL DIFFERENTIAL PASS; PERFORMANCE PENDING**. The admission history below remains authoritative for each bounded slice.

## Objective and qualification envelope

Connect the accepted coverage seams to authorized account and owner snapshots, then validate the shared registry once in the actual computation worker. Preserve existing financial calculations, response bodies, scope checks and worker limits. Keep routes disabled in every environment. This packet grants no target or fixture-runtime action.

Proposed immutable-in-code **provisional local qualification maxima**, subject to root approval before implementation:

| Budget | Candidate maximum |
| --- | ---: |
| union_minutes | 43200 |
| timestamp_rows | 21600 |
| unique_windows | 20 |
| derivation_visits | 100000 |
| output_intervals | 4096 |
| coverage_input_bytes | 524288 |
| coverage_output_bytes | 1048576 |

These candidates reduce individual measured M2 dimensions: 43200 retained rows, 205200 visits and 14210 intervals were measured separately, not simultaneously with the complete financial snapshot. The byte maxima constrain conservative estimates, not guaranteed heap capacity. They are qualification choices, not accepted production defaults. Record that distinction in code comments and evidence until root selects final limits after combined checks.

The union-span candidate admits at most 30 days of inspected minutes. Otherwise legitimate historical or 31-day requests may be refused by resource admission. Root must explicitly accept that tradeoff when admitting these candidates; do not silently shorten requested/resolved ranges or change history quotas. Longer sparse ranges require a separately justified budget choice, not inference from M1's two-row long-span test.

Store coverage budgets separately from existing QR2_READ_LIMITS, owner counts and public reader metadata. `qr2-response.js` currently spreads reader limits/counts, while the owner validator has a closed count schema. Adding coverage counters there would accidentally publish Stage-3 fields. Use a dedicated frozen coverage-budget definition with lowering-only internal/test overrides; no route/query/environment override may raise or bypass it. Existing ledger/grid/audit/pending limits are unchanged.

## Internal snapshot and worker context

Retain the accepted registry shape: one root `snapshot.coverage` with unions, windows, bindings and charges; each member receives only `coverage_window_id`. Standalone snapshots have one registry and one member reference. Never copy a registry or union timestamp array into each owner member.

Add a separate internal `input.coverage_context` containing independently authorized account metadata and the effective coverage budgets. Metadata is exactly the Stage-2A accounts representation, derived from verified owner/Bot identity and resolved ranges. It is not reconstructed from the registry being validated. Validate its consistency with the surrounding account scope or owner admitted-member list. This context is plain clone-safe data and never appears in the response body, audit findings, public counts or error details.

`executeQr2Job` qualifies this context and calls validateCoverageSnapshot exactly once before financial computation or owner composition. It must reject missing, mismatched or corrupt registry/context through the existing fixed report-failure path. No legacy-success fallback for missing coverage is allowed in newly integrated reader jobs. Update hand-built worker fixtures accordingly. The worker must not import pg, db.js, store, routes or server modules; the existing import-graph test remains mandatory.

No public coverage objects or interval envelopes are built in Stage 2C. Do not return the raw registry or a new public field from the worker. Existing body/audit/result behavior remains unchanged. Stage 3 will add unique coverage-object construction/publication with its own allocation checks; Stage-2C measurements must not claim that future cost was measured merely because M2 measured a separate harness envelope.

## Account and owner admission order

Preserve the existing transaction guard and exact ledger counting definitions. Coverage operates in the same verified READ ONLY REPEATABLE READ snapshot, or an already-authorized stricter parent where the existing standalone reader permits it. It never starts a side transaction, cache or connection.

For standalone reads:

1. Validate independent arguments/boundary records/budgets, verify transaction isolation/read-only and owner scope, and resolve the range using the existing request time and coverage start.
2. Complete existing grid/ledger/audit/pending admission before the new coverage read. Extract only the necessary admission/detail seam; keep each count's existing meaning. A new pre-count must use the exact detail predicate and retain bounded detail-fetch/count consistency checks. Do not silently import owner-specific exposure counting into standalone ledger_rows.
3. Plan/read one coverage registry for that authorized account, independently of `needsPrice`. Supported nonempty ranges with no fills still need coverage. Unsupported/null/no-full-candle cases retain Stage-1 precedence and avoid unnecessary table probes.
4. Read the existing financial details and price predecessors without changing their predicates. Finish count/range consistency checks before returning the complete snapshot and coverage context. Any error returns no partial success.

For owner reads:

1. Preserve bounded owner/Bot discovery, declarations, pending-only exclusion and supported-broker mapping. Five Bots means at most five supported USDT accounts; the overall 20-account guard remains unchanged. Do not add accounts just to expose coverage.
2. Finish **all members'** existing aggregate admission before any detail, price or coverage timestamp materialization. Retain each member's independently resolved range in its admission record.
3. Invoke readCoverageSnapshot once for the full admitted metadata set. Its deduplicated windows and merged unions own the aggregate row/span/visit/interval/byte budgets. Nested supported windows require one union SELECT; no per-member coverage read.
4. Read each admitted account's financial details through an explicitly internal deferred-coverage seam. Do not expose a user-controlled bypass flag. Preserve scope/isolation checks and existing count-consistency verification, adding range/window consistency.
5. Return one owner registry/context after successful snapshot completion. Member snapshots contain only their references. No cross-request caching or copying of union arrays.

The dedicated reader seam must retain strict text decoding, numeric qualified ORDER BY, byte-clamped LIMIT plus sentinel, exact-budget completion and whole-request refusal on any overflow or later query failure. Table absence is explicit unavailability; an observed empty table is complete all-missing coverage. Price predecessor lookup and option-M semantics remain separate.

## Refusals and financial preservation

Thrown admission/source/infrastructure failures abort the whole request. A later computed ledger REFUSED view is different: preserve its current redaction and fixed reason. Coverage may remain internally available only because it was independently read for the verified authorized account, never derived from suspect rows or the refused financial summary. Stage 2C does not publish it.

Keep replay, accounting gates, lot handling, price age/carry thresholds, retrieval eligibility, range resolution, pending-history logic, owner allocation and monetary serialization unchanged. Preserve after-commit audit behavior: failed coverage/read/worker work schedules no new audit action. Do not introduce coverage data into error details or leak cross-account metadata.

## Proposed bounded file slices

Root must assign exact ownership and admit each slice; this list is a proposal, not a dispatch. Overlapping readers/fixtures have one writer, and reader/worker contract changes must integrate as one compatible checkpoint.

**C1 — budget and admission/registry plumbing.** Proposed writable files: new `src/portfolio/qr2-coverage-limits.js`; `src/postgres/qr2-reader.js`; `src/postgres/qr2-owner-reader.js`; affected fixture/assertion sections in `test/helpers/qr2-reader-fixture.mjs`, `test/postgres/qr2-reader.test.mjs`, `test/postgres/qr2-reader-facts.test.mjs` and `test/postgres/qr2-owner-independent.test.mjs`. Add one focused `test/qr2-coverage-limits.test.js` for lowering-only rules if needed. Stage-2A helper files stay read-only unless a concrete required seam change is separately reviewed and assigned.

**C2 — actual worker validation and regression.** Proposed writable files: `src/postgres/qr2-compute-worker.js`; `test/qr2-compute-pool.test.js`; `test/postgres/qr2-compute-http.test.mjs`; `test/postgres/qr2-owner-compute.test.mjs`. Reuse the real pool unchanged. Adapt manually constructed snapshots/context and injected failure fixtures explicitly. A missing registry must not become a permissive test-only production fallback. Existing financial response comparisons remain authoritative; compare stable bodies while excluding only established timing fields.

**C3 — combined local qualification and evidence.** No product change by default. Root first admits a separately bounded isolated synthetic database/measurement packet with sole runner, exact data directory, source pins, resource/deadline limits and verified cleanup. Harness/results stay in a newly assigned ignored directory. Reuse existing accepted financial fixture shapes rather than creating a new trading scenario. Test actual account/owner read and default compute-pool path. Stage-3 interval construction/output integration remains unmeasured here and must be called out.

Read-only boundaries for all slices: routes/authentication, public composers/UI/i18n, schema/migrations, replay/price/return/allocation modules, compute-pool limits and heap guards, existing evidence and unrelated diagnostics. If route/error wiring or another existing consumer test requires change, stop and request root's exact path amendment; do not silently expand.

## Focused acceptance evidence

Before any implementation acceptance, independently verify:

- All-member pre-admission order and one shared registry read; no coverage/detail query after an earlier failed member admission. Equal/nested windows share timestamp storage, while different partial edges preserve unique window identity. Five supported members and unsupported/empty owner cases retain existing discovery guards.
- Exact candidate resource boundaries and +1 whole refusal, byte-limited query sentinel, exhausted budget then another union, absent/empty table, malformed timestamps, late read error and same-snapshot late arrival. Only representative affected integration cases need DB execution; pure boundary arithmetic remains in existing focused suites.
- Registry/context mismatch, missing reference, corrupted count, oversized payload and wrong account association fail closed before financial computation. Clone safety and worker import graph remain intact. Existing pool deadline/heap/busy/no-queue/recovery behavior is unchanged.
- Full raw financial result/body equivalence for accepted fixtures. An interior gap away from valuation points changes only internal coverage. A needed-price gap follows existing resolver behavior. Unsupported/null/refused financial states do not acquire invented values or coverage assertions. No public key, count, limit or private error detail is added.
- One combined synthetic job near the admitted row/visit envelope with substantial interval amplification and existing admitted ledger/open-lot workload. Derive its charges analytically and record attained values; do not claim all cap combinations were saturated. Run through the real pool with unchanged 256/32/4 MiB resources and 10000 ms deadline. Measure complete read/clone/validation/financial compute, actual response bytes and memory observations, including existing financial payload cost.

Keep functional and performance acceptance separate. RC-Q35/36 requirements remain: event-loop maximum at most 100 ms, p99 at most 50 ms, parallel cheap-request p95 at most 100 ms, report p95 below 5 s and within matched baseline plus 300 ms. Use the established method and a same-host baseline; short smoke observations do not certify percentiles. If that measurement is not admitted or a bar is unmet, record **COMBINED PERFORMANCE OPEN** and retain provisional local/off scope. No automatic cap/heap increase follows. Final immutable budget selection and target enablement are separate root/owner-gated decisions.

## Open qualification points and stops

Current evidence lacks actual owner pre-admission integration, combined financial snapshot/worker cost and Stage-3 public envelope cost. M1 long sparse results do not qualify long populated-table scans. Request/valuation time semantics stay authoritative; no new clock read may redefine a resolved window. Source presence remains distinct from OHLCV integrity and financial history completeness.

Stop on ambiguous count definitions, changes outside assigned paths, lost scope/redaction, repeated union reads, registry copies per member, silent range truncation, underestimated bytes, financial drift, worker failures, unmet measurement bar or unknown cleanup. Preserve failures and return to root. Functional local acceptance may precede performance qualification only with the open bar and disabled gates stated explicitly; it is not full Stage 2 or S5 completion.

Root owns future dispatch, integration and acceptance. Spot/Paper only; private source local; private acceptance NOT RUN; READY false; N1 held. No deployment, target route activation, shared/target migration, host/VPS, Live, guard reset, Best Inputs apply or backfill. Preparation usage: 60% weekly remaining, short window unknown, 3% reserve; refresh before any dispatch/runtime step.

## Root C1 admission

After M2 independent closure and interface review, root admits C1 only under the owner's continuous local GO. The table above is accepted solely as an immutable-in-code provisional local qualification envelope. The explicit tradeoff is that a 31-day inspected union or populated range above the row/aggregate limits may receive whole-request QR2_RANGE_ADMISSION_REFUSED; requested/resolved bounds and financial history quotas are never shortened. This does not select production defaults or enable any environment. Combined performance remains OPEN.

The stable handoff is snapshot.coverage plus top-level input.coverage_context={accounts,budgets}. A standalone snapshot has coverage_window_id. An owner snapshot has one registry/context and its members have only coverage_window_id; they never carry duplicate full registries or contexts. Context metadata originates in independently authorized admission records, checked against member scope/range, never reconstructed from registry bindings. Existing routes pass the full snapshot/input objects, so no route change is needed. C2 must validate this context and registry before actual worker computation. Direct readQr2Account/computeQr2View checks are separate from worker acceptance. C1 alone does not establish full integration.

The C1 writer may edit only its exact file slice and ignored report directory. Pure/syntax/query-fake checks are allowed; PostgreSQL startup, larger measurements, C2 changes and public response changes require separate root dispatch. Initial implementation budget is one short checkpoint, with 59% weekly remaining, unknown short window and 3% reserve. Root retains acceptance and serial Git authority.

## Root C2 admission

C1's reader/context interface is frozen for C2. Focused pure checks passed 36/36 before an independent P2 finding: a validated non-enumerable lowering value was lost by object spread. The narrow correction copies validated descriptor values; eight affected tests and all twelve independent grouped checks passed afterward. Original failed evidence is preserved. A separate source audit passed with limitations. PostgreSQL predicate/fixture behavior and C1 runtime acceptance remain unproved.

Root admits C2's exact worker/test file slice under the existing local GO. Follow the independent worker design: verify metadata association against independently supplied financial scope, qualify complete lowering-only budgets, and validate the registry once before account/owner computation. Missing or inconsistent coverage must fail through the existing fixed report-failure path. No new public field, duplicate member registry or permissive fixture bypass is allowed. Routes, the compute pool, heap/deadline guards and financial composers remain read-only.

Allow syntax and narrowly named unit/actual-worker tests for parity, clone safety, job failure mapping, bad-snapshot recovery, lazy/unref behavior, import graph and new coverage checks. Exclude heap-exhaustion stress and unrelated pool lifecycle suites from this slice. Bound the test process to 90 seconds with no PostgreSQL, network or browser fixture. Initial headroom was 828354560 bytes free physical memory; account usage was 55% weekly remaining, short window unknown, 3% reserve. C2 must freeze and return its focused evidence for independent review. Database execution, combined performance and Stage 3 remain separate admissions.

## Reviewed implementation checkpoint

C1 and C2 are implemented with provisional local/off limits. Independent review closed non-enumerable lowering-value loss, preserved original refusal details and bounded metadata before identity allocation. Original failures remain in the evidence. This checkpoint does not accept real PostgreSQL behavior: the separately reviewed functional packet is held below its 1 GiB headroom gate, so its 21 selected tests remain NOT RUN. Combined performance and Stage 3 remain open. No public field, route, production setting or security guard changed.

## Root functional differential admission

The independent CI scope review identified one unexecuted assertion in the broader functional bar: a price-bearing account must retain its complete financial response when an interior coverage bar unused by valuation is removed. Root admits exactly one new regression file, `test/postgres/qr2-coverage-financial.test.mjs`, plus its ignored author/review reports. Use existing isolated fixture producers and the default worker pool; retain literal financial values and compare the whole response with only the two existing reader timing fields normalized. Prove the deleted timestamp is internal to the full-candle range and absent from every selected valuation predecessor; require changed coverage with identical valuation rows and unchanged ledger digests. Keep synthetic reporting clocks explicit and funding/fill chronology coherent. No product source, shared fixture, pool, route or guard change is admitted.

Preparation permits syntax and source review only. The local six-file/21-test packet and its 1 GiB headroom gate remain unchanged and NOT RUN; this added regression is a separate functional follow-up, not an undisclosed extension of that runtime packet. Root will follow its committed exact revision through existing authorized CI and inspect actual raw test output before acceptance. CI evidence is separate from local Windows lifecycle/resource evidence. Full Stage2C/C3 and Stage3 remain open.

## Current CI qualification scope

Exact revision d0acf931c2cf14cf330e69350d759599c2b503fe passed both workflows. Root verified nine successful jobs, sixteen actual substantive steps and all twenty-one selected functional PASS records in the raw PostgreSQL log. The checkout hash ties those observations to the reviewed source. This accepts only that bounded Ubuntu CI semantic scope; the earlier local Windows packet remains NOT RUN, with no headroom or lifecycle claim. The separate priced-account interior-gap differential subsequently passed on exact revision 2a89d1826902290ca54af3c8bf6be84c82267b47. Both workflows succeeded; raw logs verify 22 selected named tests (the earlier 21 plus this one), nine jobs and sixteen substantive steps, with independent verification. This closes the bounded differential only. The combined measurement, broader functional scope and local Windows packet remain incomplete; full Stage 2C and Stage 3 remain open.
