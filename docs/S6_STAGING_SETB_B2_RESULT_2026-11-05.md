# S6 staging set B accepted: B2 attempt a02 and the owner browser check passed

Packet: [the set B packet r7](S6_STAGING_SETB_PACKET_R7_2026-11-03.md). Environment: Staging QL-P2 Prototype. Recorded by the Claude root for jobs run on 4 and 5 November 2026 (UTC). Earlier results: [B0 attempt a01](S6_STAGING_SETB_B0_A01_RESULT_2026-11-04.md) and [B0 a03 and B1 a01](S6_STAGING_SETB_B0_B1_RESULT_2026-11-04.md). The scope is staging, not production.

## What ran

- **B0 refresh a04, about 13:00Z, 5 November.** B0_PASS. The owner had renewed GO-B0 and GO-B0F. B0F attempt f04 fetched the files, and the a04 export equals the a02 reference.
- **B2 attempt a01, 13:07:32Z.** The owner typed GO-B2 at about 13:06Z. The job stopped at the gate in 495 ms with B2_STOP_DB_STATE. The effect phase was PRE: no host effect and no unit command. The API and the worker kept running, M6 stayed absent, and staging was unchanged.
- **B0 refresh a05, 16:10Z, and B0F attempt f05, 16:12Z.** The owner approved a new GO-B0 and GO-B0F after the tool fix. B0_PASS, and the a05 export equals the a02 reference. The B0 refresh is accepted with a05.
- **B2 attempt a02, 18:37:07Z to 18:42:31Z.** The owner typed GO-B2 at about 18:36Z. The job ended with B2_PASS (code B2_PASSED, receipt prefix c13a1389). Details are under Acceptance.

## The B2 a01 stop and the tool fix

The owner approved a read-only diagnostic through the host provider's web console at about 13:42Z. The schema, the fence and the queue were clean. The root cause was a wiring defect in the sealed set B tools: the real database adapter factory reads two config members that the set B bound object does not carry. Every real database check therefore threw, and the gate stopped. The local rehearsals had injected their own adapters, so they never ran the real factory. The affected tools were B2 r3e and RB r8; RS r5 was not exposed.

The fix is one helper that maps the set B connection to the adapter config. It changes no bound, manifest or mode. B2 was sealed as r3f and RB as r9, each after a debugger, a tester and an Opus audit. The B2 suite passed 282 of 282, and the new test fails on r3e and passes on r3f. B2 prep r6 and r7 were ready for the later attempt.

The jobs rehearsal was re-sealed as r5h2. On a throwaway local PostgreSQL, the real-adapter B2 chain passed (B2_PASSED) and the old r3e wiring stopped at the gate (B2_STOP_DB_STATE). The rehearsal now discriminates the defect.

Lesson: every sealed host tool needs one test that runs the real dependency builder and the real adapter factory with the real bound shape and no injected adapters. This is the second real-host-only defect of this class, after B0 attempt a01.

## Owner browser check

Root ran the five items of packet section 5 in the owner's Chrome at the owner's request, from about 18:48Z to 18:58Z. Every request was a GET. Root entered no credentials, and the owner confirmed identity personally for the admin page. Answers took 86 to 617 ms.

1. Owner view, USDT, Week and Month: 200, total UNAVAILABLE with CAPITAL_MODEL_NOT_DECLARED. PASS.
2. Owner view, THB, Week and Month: 200, not declared. PASS.
3. Per-Bot reports: Bot 3 COMPLETE with reconciliation OK; Bot 2 RECONCILIATION_FAILED with reason EPOCH_UNKNOWN and the note in English and Thai. PASS.
4. Admin health: liveEnabled false. PASS.
5. No declaration was sent. PASS.

## Acceptance

B2 attempt a02 (offline window): the API and the trading worker stopped gracefully and restarted READY. M6 is installed. The targeted runtime grant is EXACT: two statements, no EXECUTE. The immediate and delayed checks passed: heartbeat, production equal, same API and worker processes, research inactive, declaration rows 0. The post-window backup digest is equal, there is no drift, and the market stream was not restarted. The staging port answered 000 for about 30 seconds during the restart, then 200, and the owner session stayed signed in.

At 18:59Z Root accepted set B job B2 (attempt a02) and the whole of set B, S6-STAGING-SETB-1 (B0 a03 refreshed by a05; B1 a01; B2 a02).

## State after set B

- Staging has the M6 paper capital model with the exact runtime grant and no capital-model declaration. The owner view answers 200 with total UNAVAILABLE (CAPITAL_MODEL_NOT_DECLARED) instead of 503. Bot 2 still halts (RECONCILIATION_FAILED, EPOCH_UNKNOWN). Live stays locked.
- Nothing ran on production. No GO is open for B2, RS, RB, RBX, RBC or ARB. The spare GO-B0 a06 and GO-B0F f06 are unused, expire at 2026-11-06T12:00Z and are not needed.
- RB (r9) stays the undo path, under its own owner GO.
- Owner GOs used on 5 November: GO-B0 renewal (a04), GO-B2 (a01, gate stop, no effect), GO-B0 (a05), GO-B0F f05 and GO-B2 (a02, pass).

## Not done

- Scorecard S4 is not frozen. The prepared draft found no credit change at set B close under the current method. The freeze is a local step.
- The local commits from abd14c6 on are not pushed, because the credential helper is missing on this machine.
- Lane L still carries the wiring defect in r13. No RBX, RBC or ARB package is built before lane L r14.

## Scope

Staging only. Nothing ran on production. Spot/Paper only. Live locked. No guard reset, no Best Inputs apply, no optimizer, no capital-model declaration.
