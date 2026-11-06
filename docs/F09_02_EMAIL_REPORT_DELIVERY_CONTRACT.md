# F09-02 Email Report delivery contract

Status: ACCEPTED by Root as design revision 1 on 2026-11-06T07:40Z (ruling SB166), after an independent Opus review and a second review (READY_FOR_ROOT). Every owner decision in section 12 is OPEN; the safe default applies (E1 CLOSED, no Email Report enqueued). Not implemented. Nothing in this contract grants an email enqueue, a send, a production or staging change, a Bot action or a scorecard credit. Private acceptance: NOT RUN. READY: false. Spot/Paper only; no Live; no automatic optimizer loop, guard reset, Best Inputs apply or Live activation; Risk Manager and Pine are not altered by this contract.

Feature: F09-02. Target: staging (INV:372-373). Consumes the F09-01 READY predicate (QL:574-577) and
fills the two items QL defers to F09-02: the Email Report enqueue codes (QL:631 "Defined in F09-02") and
email delivery mechanics (QL:681).

## 0. Reading key

- Every carried requirement cites `file:line`. Paths are relative to the repository root.
- `(proposed)` marks a choice this draft makes. Root and the owner review each one. A proposed choice is
  not a requirement until accepted.
- `CODE:` marks a fact read from current code at the worktree HEAD. Code facts are not acceptance
  evidence.
- `OD-En` refers to an open owner decision in section 12.
- Short names:
  - QL = `docs/QL_4B_4C_QUALIFIED_PACKAGE_CONTRACT.md`
  - PEX = `docs/PINE_EXPORT.md`
  - RM = `docs/ROADMAP.md`
  - R0 = `docs/R0_BASELINE_2026-09-24.md`
  - SC4 = `docs/progress/PM1_SCORECARD_S4_2026-11-05.json`
  - INV = `docs/progress/PM1_INVENTORY_V1_2026-10-15.json`
  - MP = `docs/MULTI_PINE_CONTRACT.md`
  - QR4 = `docs/QR_4_QUALIFIED_SELECTION_CONTRACT.md`
  - CTX = `Context.md`
- "Report outbox" means the queue that holds Email Report delivery rows. Its table is OD-E15 (section
  7.4); the mechanics in sections 6 and 7 hold for either option.

Scope guard for every rule below: Spot/Paper only, BINANCE:BTCUSDT Spot 1m, no Live, no automatic
optimizer loop, no guard reset, no automatic Best Inputs apply, no automatic email enqueue (QL:29-31,
QL:674-675; AGENTS.md § Host and product safety).

## 1. Purpose and acceptance target

F09-02 acceptance: "The validated export and matching report pass the delivery/SMTP gates without
exposing an unqualified recommendation." Target: staging. (INV:372-373)

The scorecard gives F09-02 D UNKNOWN, I 0, V 0, T 0 (SC4:1307-1312). D rationale: "complete reviewed
delivery contract not established" (SC4:1313). Next action: "Validated package, SMTP 550 remediation,
matching report and confirmed owner receipt." (SC4:1326). Carry limitation: "Email failure does not
invalidate otherwise valid export; never infer export validity from email success." (SC4:1325). This
draft addresses the D gap only. I, V and T stay at 0 until implementation and evidence exist.

Phase placement:

- QL-4B: report drafting creates no outbox row (RM:2622, RM:2654; QL:66-67).
- QL-4C: enqueue the Email Report only when validation and the SMTP delivery gate pass (RM:2623).
- M6: owner-scoped draft generated from `export_id`; idempotent outbox and delivery tracking, enqueue
  gated on M7 validation and SMTP remediation/receipt; SMTP failure leaves a validated package available
  with a separate mail status (RM:2642).
- M7: outbox enqueue when the mail gate passes; one-Pine export status VALIDATED/READY before any email
  enqueue (RM:2643).

This contract defines:

1. The report identity (`report_id`) and the frozen report body.
2. The owner draft preview and the bound enqueue confirmation.
3. The enqueue preconditions, including the meaning of "confirmed owner receipt".
4. The stored email status field, its transitions and the report outbox row operations.
5. The owner actions, the notifier result, worker behavior and data records.
6. Handling of failed outbox rows and the historical backlog.
7. The per-environment SMTP delivery gate and the SMTP 550 remediation precondition, as operational
   steps outside code.
8. Failure codes, tests and open owner decisions.

### 1.1 Relation to F09-01 and F09-03

- F09-02 reads READY and `export_id` from F09-01 (QL:65-66). It never writes export status or package
  rows. Email status is a separate field owned by F09-02 (QL:514-516).
- F09-02 never imports, applies or starts anything. Those are F09-03 actions (QL:629-630). Email is a
  notification and review aid; it does not apply values to a Bot or start it (PEX:64; PEX:118).
- A QR-4 selection never enqueues email; only F09-02 does, per `export_id` (QR4:722; QR4:606).

### 1.2 Environment scope (proposed)

- Every F09-02 record and gate is per environment, that is per database: the system delivery gate E1,
  gate events, receipt confirmations, report rows, report outbox rows and the backlog account (section
  8). A staging record never opens, closes or satisfies a production gate, and the reverse.
- The F09-02 target is staging (INV:372-373). The T evidence in section 11.5 is staging evidence.
- The R0 SMTP 550 observations describe the production deployment (R0:12; R0:21-30 "Completed read-only
  production follow-up"). Whether staging has its own SMTP configuration, and whether it shares the
  production SMTP provider account, is not recorded in the docs read for this draft (section 14).
- A production remediation step is not a precondition of the staging T evidence unless the owner
  decides so (OD-E17). This contract authorizes no production step and no production config change
  (AGENTS.md § Host and product safety).

## 2. Current state

These facts limit what F09-02 can claim today.

1. No READY package can exist: no eligible candidate exists, G8 always fails and `QUALIFIED_TOTAL` is 0
   (QL:77-85). F09-02 therefore cannot send a real Email Report today.
2. SMTP delivery was failing on 2026-09-24 in production: 1,865 `Email notification failed` log
   occurrences in 24 hours, including 1,864 `SMTP rejected request (550)`; these are log counts, not
   distinct messages (R0:12). Outbox row counts at that time: SENT 2,946, FAILED 1,151, DISABLED 513
   (R0:21-30). SMTP 550 remediation and verified owner receipt remain pending (R0:32; RM:1382; RM:2618).
3. R0 instruction: keep Email Report delivery disabled until the SMTP 550 cause is resolved and an
   owner-confirmed delivery succeeds; account for failed outbox records; do not blindly resend the
   historical backlog (R0:12; R0:59).
4. An earlier owner-confirmed test receipt exists from 2026-09-18 (one plain-text test message sent from
   the VPS, owner confirmed inbox receipt) (CTX:1189). It predates the 550 failures in item 2 and is not
   current evidence.
5. CODE: `notification_outbox` has `id`, `user_id`, `subject`, `body` (plaintext `TEXT`), `attempts`,
   `next_attempt`, `status` (default `PENDING`, no CHECK), `lease_token`, `lease_until`
   (`src/postgres/schema.sql:47-50`, `:108-110`). Its ready index covers only `status='PENDING'`
   (`src/postgres/schema.sql:119`). It has no `report_id` or `export_id` column. The admin view groups
   it by `status` (`src/postgres/server.js:752`).
6. CODE: `MailWorker.deliver` serves only `security_mail` and `notification_outbox`
   (`src/postgres/worker.js:286`). It claims one `PENDING` row with `FOR UPDATE SKIP LOCKED` and a 60 s
   lease (`src/postgres/worker.js:289-291`), resolves the recipient as the Bot owner at send time, and
   sends only when the owner is `ACTIVE` and an SMTP host is set (`src/postgres/worker.js:295-297`). The
   row ends `SENT`, `FAILED` (after the fifth attempt or an inactive owner) or `DISABLED` (no SMTP host);
   otherwise it stays `PENDING` with exponential backoff (`src/postgres/worker.js:298-303`). Any SMTP
   error, 550 included, is retried.
7. CODE: `security_mail` stores an encrypted body (`encrypted_body`, `expires_at`)
   (`src/postgres/schema.sql:86-87`). The worker decrypts it with the keyring and context
   `security-mail:<user_id>` and deletes the row when done or expired (`src/postgres/worker.js:294`,
   `:296`, `:299-301`). The worker audits every finished `security_mail` row as `auth.recovery.sent` or
   `auth.recovery.delivery_failed` (`src/postgres/worker.js:301`). A password-reset request deletes every
   `security_mail` row of that user (`src/postgres/auth.js:198`).
8. CODE: a crash after SMTP acceptance and before the status update leaves the row `PENDING`; after the
   lease expires the row is claimed again and sent again. Delivery is therefore at least once today.
9. CODE: `EmailNotifier.send(to, subject, text)` catches every error, logs `error.message` and returns a
   boolean (`src/notifier.js:7-11`). The worker cannot tell a 4xx from a 5xx. `smtpSend` rejects with a
   text error `SMTP rejected request (<code>)` (`src/notifier.js:36`), `SMTP attempt timeout` after 20 s
   (`src/notifier.js:19`) or `SMTP connection closed` (`src/notifier.js:26`). It writes fixed headers
   only, with a random `Message-ID` per attempt (`src/notifier.js:64-66`). A duplicate delivery gets a
   new `Message-ID`. The 20 s deadline is below the 60 s lease.
10. CODE: `botOwner(id)` returns the parent user of a Bot, or the Bot user itself when it has no parent
    (`src/postgres/store.js:32-35`). No `users` column records email-address verification
    (`src/postgres/schema.sql:2`; grep for `email_verified` in `src` finds none).
11. CODE: the bootstrap first user has role `ADMIN` (`src/postgres/server.js:110-115`). ADMIN counts as a
    licensed owner in readiness checks (`src/postgres/pf3-readiness-service.js:65`;
    `src/postgres/risk-readiness.js:84`).
12. CODE: the accepted builder tables hold no report draft (`src/postgres/best-inputs-package-schema.sql`,
    tables at :45-251; grep for `report` finds none). The canonical package file set has no report file
    (QL:181-210). The "report draft" of PEX:117 and RM:2642 has no stored form today.
13. CODE: the PF-4 confirmed save checks an exact key set, SHA-256 string hashes and the literal confirm
    string `PF4_CONFIRM` before any write (`src/postgres/pf4-proposal-service.js:183-187`;
    `src/postgres/pf4-risk-proposals.js:17`). QL item 2.10 names this as the guard pattern (QL:108-111).
14. CODE: `hashToken` is an unsalted SHA-256 and `randomToken` returns 32 random bytes as hex
    (`src/security.js:5-6`). Password-reset tokens are stored only as `hashToken` (`src/postgres/auth.js:199`).

## 3. Report identity

- `export_id` identifies one immutable Best Inputs candidate and its report draft (QL:119-122; PEX:60;
  RM:2604).
- `report_id`: a random server UUID, one per `export_id`, created at enqueue, never derived from
  `export_id`, `run_id` or a hash, never reused (proposed). A database unique constraint on `export_id`
  enforces one report per export (proposed). This gives "one matching Email Report by export_id"
  (RM:2654).
- Every delivery of the report, duplicates and a resend included, carries the same `report_id` (PEX:60;
  RM:2654). The `report_id` appears in the subject line, in the first message line and in an
  `X-Astra-Report-Id` header (proposed; header and `Message-ID` handling in section 7.3 and OD-E5).
- `report_body_hash` = SHA-256 of the report content bytes (section 4.3), using the same canonical hash
  helper as `package_hash` (QL:134-140) (proposed). The content excludes `report_id`, so the owner
  preview and the enqueue render give the same hash.
- `message_hash` = SHA-256 of the frozen message text (the `report_id` line plus the content) (proposed).
- A `report_id` or hash is never an access token or authorization (QL:141; RM:2608).

## 4. Report body

### 4.1 Required fields

The body carries every field listed in PEX:62 and RM:2652. Source of each value (proposed mapping):

| Field | Required by | Source |
| --- | --- | --- |
| Recommended values (actual) | PEX:62; RM:2652 "Best Inputs" | `inputs.json` after-values (QL:221-226) |
| Pine-only source inputs, separate from the Bridge ATR/RR pair | PEX:62; RM:2652 | `inputs.json`; Bridge pair labelled "Bot Risk Manager Bridge Settings" (QL:595-597) |
| `bot_id` | PEX:62; RM:2652 | `bi_exports.bot_id` |
| `pine_import_id` (one Pine only) | PEX:62; RM:2652 | binding tuple (QL:144-178) |
| `run_id` | PEX:62 | `bi_exports.run_id` |
| `export_id` | PEX:62; RM:2652 | `bi_exports.export_id` |
| `report_id` | PEX:60; RM:2654 | section 3; message first line, not part of the content |
| Creation timestamp, ISO-8601 UTC | PEX:60 "ISO-8601 UTC creation timestamp", PEX:62; RM:2652 | package `created_at_utc` (proposed; deterministic, so preview and enqueue renders match). Enqueue time is stored in `email_reports.created_at_utc`, not in the content |
| Policy version and policy hash | PEX:62 | binding fields from the research contract (QL:704, OD-12) |
| Validation status and stale status | PEX:62; RM:2652 | READY read at render (QL:559-577) |
| Objective | PEX:62 | run record objective (proposed; source unconfirmed, section 14) |
| Train/validation/test scores | PEX:62; RM:2652 | `quant-data/metrics.json` (QL:245-247) |
| Trade and sample counts | PEX:62; RM:2652 | `metrics.json` |
| Maximum drawdown | PEX:62; RM:2652 | `metrics.json` |
| Win Rate | PEX:62; RM:2652; QL:246 | `metrics.json` |
| Profit Factor | PEX:62; RM:2652 | `metrics.json` |
| Fee and slippage assumptions | PEX:62; RM:2652 "costs" | `quant-data/manifest.json` cost assumptions (QL:242-244) |
| Authenticated review link | PEX:62; RM:2652 | section 4.2 |
| READY label "best within the selected scope" | QL:591-594 (OD-20) | fixed text |
| Notice: email applies nothing and starts nothing; validity is shown on the review page at reading time | PEX:64; QL:616; SC4:1325 | fixed text (proposed) |

Absent metrics stay absent; the body never fills a default (QL:247) (proposed: absent metric prints
"not available").

### 4.2 Review link

- The link is the public origin plus a route that names only `export_id` (proposed). It carries no
  session, bearer token, one-time login token or `report_id` query parameter (proposed). Opening it
  requires the owner's normal authenticated session; a foreign or absent `export_id` gives `NOT_FOUND`
  (404) (QL:620-623).
- The review page shows live READY and freshness (QL:559-572). The email is never the authority for
  validity (QL:616).
- Opening the link performs no write. No apply, import or start control acts on a GET (QL:636-640;
  RM:2610).

### 4.3 Report content, draft and frozen message

- The report draft is a pure deterministic rendering of the stored package, the validation record and
  the export row (proposed; OD-E10). The sources require that QL-4B creates no outbox row (QL:66-67;
  RM:2654; QL:858). That QL-4B also stores no draft row is this draft's proposal (OD-E10), not a cited
  requirement.
- Report content = the rendering of every 4.1 field except `report_id` (proposed). It contains no
  wall-clock time, random value or recipient data, so two renders of the same READY package give the
  same bytes.
- Owner preview (section 7.1) renders the content and returns `report_body_hash`. It writes nothing.
- At enqueue the server renders the content again, runs the match check and the secret scan (section 5,
  gate E4), checks the owner's bound hashes (gate E5), creates `report_id`, builds the message text
  (first line `Report ID: <report_id>`, a blank line, then the content), and stores the message text,
  `report_body_hash` and `message_hash` insert-only (proposed). Every delivery attempt, duplicate and
  resend sends these exact bytes. A duplicate is byte-identical (proposed).
- Match check: the content's `export_id`, `run_id`, `bot_id`, `package_hash` and policy hash equal the
  export row and binding; otherwise `ER_REPORT_MISMATCH` (RM:2642 "Draft report matches run/package").
- Format: `text/plain` UTF-8, as the current notifier sends (CODE, item 2.9). Language is OD-E6. Every
  new label has EN and TH strings (QL:864; PEX:106).
- No attachments; package files are downloaded only from the authenticated review page under the
  F09-01 download guards (QL:628) (proposed; OD-E11).

### 4.4 Never in the body

- Webhook URLs or secrets, broker credentials, machine locations (PEX:62; RM:2652; QL:611).
- Any value, metric or best/winner label of a package that is not READY (QL:607-608; INV:373).
- Fixture packages and multi-Pine packages (QL:609-610; MP:522; MP:629).
- Holdout performance of rejected candidates; universal best or global-optimum claims (QL:612-615).
- The recipient address of any user, the owner included (proposed).

## 5. Enqueue gates

Enqueue happens only from the explicit owner action in section 7.1, after the owner has seen the
preview. The request is evaluated in one SERIALIZABLE transaction (proposed, following QL:629 and QL
item 2.10 at QL:108-111) in this order (proposed):

1. Owner scope: foreign or absent `export_id` gives `NOT_FOUND` (404); foreign Bot gives
   `BOT_ACCESS_DENIED` (403) (QL:620-623).
2. Idempotent lookup, read-only: if a report already exists for this `export_id`, the server returns the
   existing `report_id` and current email status with `already_enqueued: true` (200). It evaluates no
   gate, writes nothing and creates no outbox row (section 6.3). This holds also when E1 is now closed or
   the package is now STALE.
3. Gates E0 to E5 below, in that order. The first failing gate decides the code; the response also lists
   the other failing gates (proposed). A failing gate writes no report row and no outbox row.

| Gate | Rule | Source | Refusal code |
| --- | --- | --- | --- |
| E0 READY | `status EXPORT_VALIDATED AND fresh AND mode ONE_PINE AND fixture false AND requester owns the Bot` | QL:576-577; QL:631; RM:2643 | `BI_NOT_READY` |
| E1 System delivery gate | The system SMTP delivery gate of this environment is OPEN (sections 1.2, 9) | RM:2654; R0:12; R0:59; PEX:60 | `ER_SMTP_GATE_CLOSED` (shown as `EMAIL_BLOCKED_SMTP`) |
| E2 Confirmed owner receipt | A current owner receipt confirmation exists for this owner and recipient address (section 5.1) | PEX:60; RM:2654; QL:631; R0:12 | `ER_OWNER_RECEIPT_MISSING` |
| E3 Verified recipient | Recipient rule in section 5.2 holds | PEX:62; RM:2652 | `ER_RECIPIENT_UNVERIFIED` |
| E4 Report integrity | Match check passes and the secret scan finds nothing | RM:2642; QL:611; QL:628 | `ER_REPORT_MISMATCH`, `ER_SECRET_DETECTED` |
| E5 Bound confirmation | Exact request keys `confirm`, `package_hash`, `report_body_hash`; `confirm` equals the literal `SEND_EMAIL_REPORT` (proposed); both hashes are SHA-256 strings and equal the server's export row and fresh render | QL:108-111; `src/postgres/pf4-proposal-service.js:183-187` pattern; PEX:117 and RM:2642 (owner-scoped draft) | `INVALID_FIELDS`, `CONFIRMATION_REQUIRED`, `ER_PREVIEW_STALE` |

E5 binds the enqueue to the draft the owner previewed. A changed package or render after the preview
gives `ER_PREVIEW_STALE`; the owner previews again (proposed).

### 5.1 Meaning of "confirmed owner receipt" (proposed; OD-E1)

The sources require "confirmed owner receipt" before enqueue (PEX:60; RM:2654; QL:631) and an
"owner-confirmed delivery" before enabling Email Report delivery (R0:12; R0:59). They do not say receipt
of what. This draft proposes:

- A receipt confirmation is an insert-only record that the owner received a gate-test message sent
  through this environment's mail path after this environment's gate E1 opened (section 1.2).
- The gate-test message carries no package value, metric or link to a package. It carries a one-time
  confirmation code: `randomToken(16)`, 128 random bits as hex (`src/security.js:6`), expiring after
  24 hours (proposed). High entropy makes the unsalted `hashToken` safe for the code, as for
  password-reset tokens (`src/postgres/auth.js:199`).
- The code is stored only as `hashToken(code)`. The gate-test message text is never stored in
  plaintext: it goes through an encrypted queue that is deleted after send (section 7.5). After send,
  no table, audit detail or log line holds the code in plaintext (proposed; test 11.4.4).
- The owner enters the code in an authenticated, CSRF-protected action. The record stores owner id, the
  recipient address HMAC (below), the gate event id, the SMTP configuration fingerprint, UTC time and
  the code hash. It never stores the code or the address.
- Address HMAC (proposed): HMAC-SHA-256 of the lower-cased address under a server key derived from the
  active keyring entry with context `mail-receipt-address`, stored with the key id. An unsalted hash of a
  known address could be guessed; the HMAC cannot without the key. A key rotation makes old
  confirmations not current (fail-safe; the owner confirms again).
- A confirmation is current only while all three hold (proposed; OD-E13): the HMAC of the owner's
  current address equals the stored HMAC; this environment's gate E1 has not closed since the
  confirmation; the SMTP configuration fingerprint (a hash of non-secret host, port and from fields) is
  unchanged.
- Receipt of a real Email Report by the owner is acceptance evidence for T (SC4:1316), not an enqueue
  precondition. A precondition cannot depend on the delivery it gates.

### 5.2 Verified-owner recipient rule (proposed)

The sources require sending "only to the verified Bot owner" (PEX:62) and "only to the verified owner"
(RM:2652). No address-verification field exists (item 2.10). This draft proposes a rule based on Bot
ownership, not on role:

- The recipient is the Bot owner resolved on the server, `botOwner(bot_id)` (item 2.10). Its id must
  equal `bi_exports.owner_id` and the requester. The request body never names a recipient.
- The owner account is `ACTIVE` and top-level (`parent_user_id IS NULL`). A sub-user is never a
  recipient, because `botOwner` resolves to the parent.
- Role is not a criterion. The bootstrap `ADMIN` user may own Bots and counts as a licensed owner
  (item 2.11), so an ADMIN-owned Bot is eligible. Any additional role exclusion, for example SUPPORT, is
  OD-E16; until decided, no role is excluded beyond the ownership rule.
- "Verified" means the address HMAC equals the HMAC whose receipt the owner confirmed in 5.1. The
  confirmation is the proof of address control.
- The worker rechecks the rule at every send attempt (section 7.2). A changed owner or address gives
  `ER_RECIPIENT_CHANGED` and `EMAIL_FAILED`.
- Before this environment's E1 opens, the operations step records the role and top-level state of the
  owner account that owns the target Bots, read through authorized access only (section 9, step 1).

## 6. Email status field, transitions and row operations

### 6.1 Field

- Email status is a separate field owned by F09-02 (QL:514-516). It is stored as append-only email
  status events keyed by `report_id` and `delivery_seq`; the current status is the last event
  (proposed, following QL:518). It is never written into export status events, and export status is
  never written into it.
- Values, taken from RM:2654 and PEX:117: `EMAIL_BLOCKED_SMTP`, `EMAIL_PENDING`, `EMAIL_SENT`,
  `EMAIL_FAILED`. They stay distinct from `NO_VALID_CANDIDATE`, `EXPORT_CANDIDATE` and
  `EXPORT_VALIDATED/READY` (PEX:117; RM:2654).
- No email record: the package has no email status. A READY package without an email record reads
  "Email Report not sent" (proposed; not a stored status).

| Status | Meaning | Stored? | Report outbox row `status` (proposed) |
| --- | --- | --- | --- |
| `EMAIL_BLOCKED_SMTP` | Package READY but this environment's E1 is closed. Before enqueue: derived on read, no row. After enqueue: stored hold state when E1 closed before the send | Derived before enqueue; stored after (proposed) | `HELD` (after enqueue) |
| `EMAIL_PENDING` | Enqueued; report outbox row waiting or retrying | Stored | `PENDING` |
| `EMAIL_SENT` | SMTP server accepted the message (250 after DATA). Not proof of owner receipt | Stored, terminal | `SENT` |
| `EMAIL_FAILED` | Delivery stopped with a code; the package is unaffected | Stored, terminal for this `delivery_seq` (resend OD-E4) | `FAILED` |

`EMAIL_SENT` means server acceptance only. The UI and API never show it as "received" or "confirmed"
(proposed).

### 6.2 Transitions

Every transition not listed is refused with `ER_TRANSITION_INVALID` (proposed, following QL:528):

```text
(no record), READY, E1 closed                           -> EMAIL_BLOCKED_SMTP (derived; no row)
(no record) --owner enqueue, E0-E5 pass                 -> EMAIL_PENDING (report row + outbox row, seq 1)
EMAIL_PENDING --SMTP 250 after DATA                     -> EMAIL_SENT
EMAIL_PENDING --transient failure, attempt < 5          -> EMAIL_PENDING (attempt event)
EMAIL_PENDING --transient failure on attempt 5          -> EMAIL_FAILED (ER_ATTEMPTS_EXHAUSTED)
EMAIL_PENDING --permanent SMTP 5xx                      -> EMAIL_FAILED (ER_SMTP_REJECTED)
EMAIL_PENDING --send-time READY recheck fails           -> EMAIL_FAILED (ER_EXPORT_NOT_READY_AT_SEND)
EMAIL_PENDING --send-time recipient recheck fails       -> EMAIL_FAILED (ER_RECIPIENT_CHANGED)
EMAIL_PENDING --SMTP host not configured                -> EMAIL_FAILED (ER_SMTP_NOT_CONFIGURED)
EMAIL_PENDING --E1 closed at claim                      -> EMAIL_BLOCKED_SMTP (stored hold)
EMAIL_BLOCKED_SMTP (stored) --owner resume, E0-E5 pass  -> EMAIL_PENDING (same row, same seq)
EMAIL_FAILED --owner resend, OD-E4 (b) only, E0-E5 pass -> EMAIL_PENDING (new outbox row, seq 2)
EMAIL_SENT                                              -> terminal
EMAIL_FAILED with seq at the OD-E4 limit                -> terminal
```

Rules (all proposed unless cited):

- Attempt limit 5 per `delivery_seq`, matching the current worker (item 2.6). Transient means reply
  class `4XX`, `TIMEOUT` or `CONNECTION` (section 7.3). Permanent means reply class `5XX`. A 5xx is never
  retried, because repeated 550 retries produced the R0 failure volume (R0:12).
- A stored `EMAIL_BLOCKED_SMTP` never resumes by itself when E1 reopens. Resume is an explicit owner
  action that rechecks every gate (no automatic enqueue: QL:674-675; never blindly resend: R0:59).
- Send-time READY recheck (OD-E9). The worker has no requester, so the send-time form replaces the
  requester term of QL:576-577: `READY_AT_SEND = status EXPORT_VALIDATED AND fresh AND mode ONE_PINE AND
  fixture false AND botOwner(bot_id).id = bi_exports.owner_id = email_reports.owner_id`. The worker sends
  only while `READY_AT_SEND` holds, so a stale package is never mailed as a recommendation (INV:373;
  QL:607-608).
- No email transition changes export status, freshness or READY (QL:514-516; SC4:1325).

### 6.3 Report outbox row operations (proposed)

| Operation | Actor | Row effect | Status event |
| --- | --- | --- | --- |
| Enqueue | Owner action | Insert one row: `report_id`, `delivery_seq` 1, `status` `PENDING`, `attempts` 0 | `EMAIL_PENDING` |
| Attempt, transient | Worker | Same row: `attempts` + 1, backoff, lease cleared | attempt event with reply class |
| Attempt, end | Worker | Same row: `SENT` or `FAILED` | `EMAIL_SENT` or `EMAIL_FAILED` |
| Hold | Worker, at claim, E1 closed | Same row: `status` `HELD`, `attempts` unchanged, lease cleared; no send | `EMAIL_BLOCKED_SMTP` |
| Resume | Owner action | Same row, guarded `WHERE status='HELD'`: `status` `PENDING`, `next_attempt` now, `attempts` unchanged | `EMAIL_PENDING` |
| Resend | Owner action, only if OD-E4 (b) | Insert a new row: same `report_id`, `delivery_seq` 2, same frozen message, `attempts` 0 | `EMAIL_PENDING` |

- The worker claims only `PENDING` rows (`src/postgres/worker.js:289`), so a `HELD` row is never
  reclaimed until an owner resume.
- The row status event and the outbox row change happen in one transaction.
- Uniqueness: `email_reports.export_id` is unique (one report per export). Report outbox rows are unique
  on `(report_id, delivery_seq)`, with `delivery_seq` between 1 and the OD-E4 limit (CHECK; 1 if OD-E4
  (a), 2 if OD-E4 (b) with one resend).
- `HELD` exists only on report rows. If OD-E15 (a) adds report columns to `notification_outbox`, a CHECK
  allows `HELD` only where `report_id` is not null, and historical rows never get it.

### 6.4 Delivery semantics

- Enqueue is idempotent by `export_id` (PEX:60; QL:631). A repeat enqueue for the same `export_id`
  returns the existing `report_id` and status and creates no outbox row (section 5, order step 2).
  Concurrent enqueue requests resolve through the unique constraints; exactly one report row and one
  `delivery_seq` 1 outbox row exist (proposed).
- SMTP delivery is at least once; duplicates carry the same report ID (PEX:60; RM:2654). The worker
  lease and the crash window in item 2.8 are the known duplicate source. Duplicates send the frozen bytes
  (4.3).
- `EMAIL_SENT` is written once per `delivery_seq`. A duplicate delivery after `EMAIL_SENT` cannot happen
  through the worker, because the worker claims only `PENDING` rows (item 2.6).

## 7. Interfaces

Every owner action is authenticated, CSRF-protected under the existing API rules, owner-scoped and
writes an audit event with `export_id`, `report_id`, `package_hash`, actor, UTC time and outcome
(QL:620-622, extended with `report_id` (proposed)). The preview and status reads write no audit row and
no other row (QL:636-640). Foreign or absent `export_id`: `NOT_FOUND` (404) (QL:622-623). Foreign Bot:
`BOT_ACCESS_DENIED` (403) (QL:623). Route paths are proposed; Root fixes them at implementation.

### 7.1 Owner actions

| Action | Allowed when | Guards | Codes |
| --- | --- | --- | --- |
| Read email status `GET /api/exports/{export_id}/email` | Any export of the owner | Owner scope; returns status, codes, `report_id`, `delivery_seq`, attempt count, UTC times; no values for a non-READY package | `NOT_FOUND` |
| Preview draft `GET /api/exports/{export_id}/email/preview` | READY | Owner scope; no write; renders the report content (4.3) and returns it with `report_body_hash`, `package_hash`, the confirm literal, a masked recipient hint (first character and domain only), and the current state of E1, E2 and E3 for display | `NOT_FOUND`, `BI_NOT_READY` (no content returned) |
| Enqueue Email Report `POST /api/exports/{export_id}/email` | READY | Order and gates in section 5; body `{confirm, package_hash, report_body_hash}`; SERIALIZABLE; idempotent by `export_id` | section 10 |
| Resume held report `POST /api/exports/{export_id}/email/resume` | Stored `EMAIL_BLOCKED_SMTP` | Gates E0-E5 again, with the same bound body; `report_body_hash` must equal the stored hash | section 10 |
| Resend failed report `POST /api/exports/{export_id}/email/resend` | `EMAIL_FAILED`, OD-E4 (b) only | Gates E0-E5 again, with the same bound body; `delivery_seq` below the limit | section 10, `ER_RESEND_LIMIT` |
| Request gate-test message `POST /api/me/mail-receipt/test` | E1 open | Owner `ACTIVE`, top-level; rate limit (proposed: 3 per 24 h) | `ER_SMTP_GATE_CLOSED`, `ER_RATE_LIMITED` |
| Confirm receipt `POST /api/me/mail-receipt/confirm` | Unexpired code | Code hash match; one use | `ER_RECEIPT_CODE_INVALID` |

There is no route that names a recipient, edits a body, enqueues for another owner, or enqueues
without an owner request. Until OD-E4 is decided, the resend route does not exist.

### 7.2 Worker

- Report outbox rows are served by `MailWorker` with the existing lease pattern (item 2.6). The table is
  OD-E15 (section 7.4). Trade and security mail rows keep today's behavior unchanged.
- For a report row, at each attempt the worker: checks E1 (closed: hold operation of 6.3, no send);
  rechecks `READY_AT_SEND` (6.2); rechecks the recipient rule (5.2); sends the frozen bytes through the
  report send method (7.3); writes the email status event and the outbox row change in one transaction
  (proposed).
- Gate-event writers (proposed; OD-E2 and OD-E3): only the operations step under an owner GO writes an
  E1 `OPEN` event. The worker may write only a `CLOSED` event, and only when OD-E3 is "yes" and a report
  attempt returns reply class `5XX`. That `CLOSED` event and the `EMAIL_FAILED` event are written in one
  transaction, with reason code `ER_SMTP_REJECTED` and the `report_id` as evidence reference. Closing is
  fail-safe. Reopening needs the operational step in section 9.
- The worker never creates a report outbox row, never changes a Bot, policy, session or package, and
  never starts research.

### 7.3 Notifier contract (proposed)

- Today `EmailNotifier.send(to, subject, text)` returns a boolean and loses the reply code (item 2.9).
  It stays unchanged, with the same arguments, result and log line, for trade and security mail.
- A new report send method takes `to`, `subject`, `text` and `headers` and returns
  `{ok, replyClass, replyCode}`. `replyClass` is one of `2XX`, `4XX`, `5XX`, `TIMEOUT`, `CONNECTION`
  (connection refused or closed, TLS failure). `replyCode` is the three-digit SMTP code or null. It never
  returns reply text, because reply text can hold addresses.
- `smtpSend` raises a typed error that carries the stage and the numeric code, instead of only the text
  `SMTP rejected request (<code>)` (`src/notifier.js:36`). The report method maps a code at any stage:
  4xx to `4XX` and 5xx to `5XX`. The 20 s deadline (`src/notifier.js:19`) maps to `TIMEOUT`. Socket and
  TLS errors map to `CONNECTION`. `ok` is true only for 250 after DATA.
- Allowed extra headers: `X-Astra-Report-Id: <report_id>` (UUID format checked), and, only if OD-E5
  (b) is chosen, `Message-ID: <report_id>.<delivery_seq>@<domain of the configured from address>`.
  Without OD-E5 (b), `Message-ID` stays random per attempt (`src/notifier.js:65`). Header values pass
  the existing CR/LF cleaning (`src/notifier.js:4`); no other header is accepted.
- The worker stores `replyClass` and `replyCode` in the status event (7.4), never reply text.

### 7.4 Records (proposed)

| Record | Kind | Key fields |
| --- | --- | --- |
| `email_reports` | Insert-only | `report_id` PK, `export_id` UNIQUE, `owner_id`, `bot_id`, `run_id`, `package_hash`, `policy_hash`, `report_body_hash`, `message_hash`, message text, `created_at_utc` |
| Report outbox | Mutable queue row (6.3) | `report_id`, `delivery_seq`, `status` (`PENDING`, `HELD`, `SENT`, `FAILED`), `attempts`, `next_attempt`, lease fields; UNIQUE `(report_id, delivery_seq)` |
| `email_report_status_events` | Insert-only | `report_id`, `delivery_seq`, seq, status, code, attempt number, `replyClass`, `replyCode` (no reply text), UTC time |
| `email_delivery_gate_events` | Insert-only | seq, `OPEN` or `CLOSED`, writer (`OPERATIONS` or `WORKER`), reason code, evidence reference (no secrets, no machine paths), UTC time |
| `mail_receipt_tests` | Encrypted queue row, deleted after send (7.5) | owner id, encrypted message, `expires_at`, attempts, `next_attempt`, status, lease fields |
| `mail_receipt_confirmations` | Insert-only | owner id, address HMAC and key id, gate event id, SMTP fingerprint hash, code hash, UTC time |

Insert-only tables follow the freeze pattern of QL:647-651; the SQLSTATE is Root's (QL:706, OD-14
pattern).

Report outbox table, OD-E15:

- (a) Add `report_id` and `delivery_seq` columns to the shared `notification_outbox`. The message text
  then sits in the plaintext `body` column (item 2.5). The `HELD` value appears in the admin status
  count (`src/postgres/server.js:752`).
- (b) A separate `email_report_outbox` table with the same queue columns. `MailWorker.deliver` adds it
  to its allowlist (`src/postgres/worker.js:286`). Historical rows, trade mail behavior and the shared
  table stay apart. Draft recommendation: (b).
- Either option is a schema change. Schema changes require a protected backup and an isolated
  migration/restore rehearsal (RM:2645), and need their own gate.

### 7.5 Gate-test message path (proposed)

- The gate-test message never enters `notification_outbox`, whose `body` is plaintext and stays after
  send (item 2.5).
- It goes through `mail_receipt_tests`, an encrypted queue with the `security_mail` shape (item 2.7):
  the message is encrypted with the keyring under context `mail-receipt-test:<user_id>`, decrypted only
  in worker memory, and the row is deleted when sent, failed or expired. `expires_at` equals the code
  expiry. The worker audits it as `mail.receipt_test.sent` or `mail.receipt_test.delivery_failed`, with no
  code in the audit details.
- Reusing `security_mail` itself is the alternative. It is not proposed, because the worker labels
  every finished `security_mail` row as `auth.recovery.*` (`src/postgres/worker.js:301`) and a
  password-reset request deletes every pending `security_mail` row of the user
  (`src/postgres/auth.js:198`). Root chooses at implementation.
- A gate-test send uses the existing boolean `send` result only to finish the row; the gate-test
  outcome is the owner's confirmation, not the SMTP reply.

## 8. Failed outbox rows and historical backlog

Requirement: account for failed outbox records; never blindly resend the historical backlog (R0:59;
R0:12).

- F09-02 code never updates, resets, re-queues or deletes an existing `notification_outbox` row that is
  not a report row (proposed). No migration changes `status` of historical rows (proposed).
- Before E1 can open in an environment, an operations step records a read-only backlog account of that
  environment: counts by `status` and by age band of all `notification_outbox` rows, PENDING included,
  at one UTC time (proposed). The R0 counts (R0:21-30) are production history, not a current account.
- PENDING historical rows are a risk: today's worker sends them as soon as SMTP works (item 2.6). The
  account must state their count, and the owner decides their disposition before remediation is deployed
  in that environment (OD-E7).
- FAILED and DISABLED historical rows stay as they are unless the owner decides otherwise per class
  (OD-E7). Any resend of historical rows is a separate owner decision, never part of F09-02.
- An Email Report in `EMAIL_FAILED` is counted in the same account by `report_id` and `delivery_seq`.
  Resend follows OD-E4 only.

## 9. Delivery gate E1 and SMTP 550 remediation: operational precondition

SMTP 550 remediation is an operations step, not F09-02 code (RM:1382; RM:2618 "operational
follow-up"). F09-02 code only reads this environment's gate E1, and the worker may close it (7.2).

E1 is per environment (section 1.2). Order: staging first, for the F09-02 T evidence (INV:372-373).
Production follows only under OD-E17.

Preconditions to open E1 in one environment (proposed; each step needs its own owner GO under AGENTS.md
host rules and the single operations worker; read-only reads use authorized access only):

1. Read, read-only: whether the environment has its own SMTP configuration and provider account; the
   non-secret SMTP fingerprint; the role and top-level state of the owner account of the target Bots
   (5.2); the backlog account in section 8.
2. Diagnose the 550 cause on that environment's mail path. The production cause is not recorded in the
   docs read for this draft. If staging shares the production provider account, the diagnosis and any
   provider-side change are production-scoped and need OD-E17.
3. Apply the fix as an approved change in that environment, with backup and rollback (RM:2618; R0:59;
   RM:2645 for any schema part). A production change needs an explicit owner GO under OD-E17.
4. Record the owner's OD-E7 disposition for that environment.
5. Send one test message through the fixed path; record the SMTP 250 acceptance and the owner's inbox
   confirmation (R0:12 "owner-confirmed delivery").
6. Observe the worker journal for a window with zero new 550 on new sends (proposed window: OD-E12).
7. Write one `email_delivery_gate_events` OPEN row in that environment's database that references the
   evidence (section 7.4).

E1 is CLOSED by default and on any failed step. Until this section is complete in an environment, every
enqueue there reads `EMAIL_BLOCKED_SMTP`. This draft authorizes none of these steps, in staging or in
production.

## 10. Failure codes

All `ER_` codes are proposed; Root owns the namespace. Reused codes cite their source.

| Code | HTTP | When |
| --- | --- | --- |
| `NOT_FOUND` | 404 | Foreign or absent `export_id` (QL:622-623) |
| `BOT_ACCESS_DENIED` | 403 | Foreign Bot (QL:623) |
| `INVALID_FIELDS` | 400 | Request keys or hash formats wrong (`src/postgres/pf4-proposal-service.js:183-186` reuse) |
| `BI_NOT_READY` | 409 | E0 fails; preview of a non-READY package (QL:628 reuse) |
| `CONFIRMATION_REQUIRED` | 409 | E5 confirm literal missing or wrong (QL:629 reuse) |
| `ER_PREVIEW_STALE` | 409 | E5 bound hash differs from the server's export row or fresh render |
| `ER_SMTP_GATE_CLOSED` | 409 | E1 closed; status reads `EMAIL_BLOCKED_SMTP` |
| `ER_OWNER_RECEIPT_MISSING` | 409 | E2: no current receipt confirmation |
| `ER_RECIPIENT_UNVERIFIED` | 409 | E3 fails at enqueue |
| `ER_REPORT_MISMATCH` | 500 | E4 match check fails; no row written |
| `ER_SECRET_DETECTED` | 500 | E4 secret scan hit; no row written |
| `ER_TRANSITION_INVALID` | 409 | Unlisted email status transition |
| `ER_RESEND_LIMIT` | 409 | Resend at the OD-E4 `delivery_seq` limit |
| `ER_RATE_LIMITED` | 429 | Gate-test request limit |
| `ER_RECEIPT_CODE_INVALID` | 409 | Wrong, used or expired receipt code |
| `ER_EXPORT_NOT_READY_AT_SEND` | worker | `READY_AT_SEND` fails |
| `ER_RECIPIENT_CHANGED` | worker | Send-time recipient recheck fails |
| `ER_SMTP_REJECTED` | worker | Reply class `5XX`; class and code stored |
| `ER_SMTP_NOT_CONFIGURED` | worker | No SMTP host at send |
| `ER_ATTEMPTS_EXHAUSTED` | worker | Fifth transient failure |

A successful idempotent repeat is not an error (section 5, order step 2).

## 11. Test and evidence plan

### 11.1 Pure renderer (Node, no database)

1. Content contains every field in 4.1 for a READY fixture input marked as test data; Bridge pair is
   separate from Pine-only inputs.
2. Same inputs give the same content bytes and `report_body_hash`, across two renders at different wall
   times.
3. Absent metric renders "not available", never a default number.
4. Secret scan catches webhook URL, webhook secret, broker key and machine-path patterns.
5. Non-READY, fixture or multi-Pine input is refused before rendering.
6. Review link contains `export_id` only; no token, session or `report_id` parameter.
7. EN and TH strings exist for every new status and code label (QL:864).
8. Message text is `Report ID: <report_id>`, a blank line and the content; content holds no recipient
   address.

### 11.2 Isolated PostgreSQL (throwaway cluster)

1. Enqueue on READY with E1 open, current receipt and correct bound body writes one report row, one
   status event and one outbox row with `delivery_seq` 1.
2. Second and concurrent enqueue for the same `export_id`: one report row, one outbox row, same
   `report_id`.
3. Repeat enqueue after E1 closes or after the package turns STALE returns `already_enqueued: true` and
   the existing status, writes nothing.
4. Each gate E0-E5 failing gives its code and writes no report or outbox row; a changed package after
   preview gives `ER_PREVIEW_STALE`.
5. Insert-only tables refuse UPDATE and DELETE.
6. Export status events, freshness inputs, Bot policy, Risk Manager settings, session rows and package
   rows are byte-identical before and after preview, enqueue, every worker outcome and every failure
   (PEX:118; RM:2610; QL:636-639).
7. Historical outbox rows that are not report rows: counts by status unchanged after every F09-02 path.
8. Package validation completing to READY creates zero outbox rows (no automatic enqueue; QL:674-675;
   QL:858).
9. Unique `(report_id, delivery_seq)` refuses a second row with the same pair; the CHECK refuses a
   `delivery_seq` above the OD-E4 limit.
10. Preview writes no row in any table, audit included.

### 11.3 Worker with a fake notifier (no network)

1. The fake report send method returns each reply class `2XX`, `4XX`, `5XX`, `TIMEOUT`, `CONNECTION`;
   the worker stores class and code and no reply text.
2. A loopback-only fake SMTP listener inside the test process returns 250, 451, 550, a stall past the
   deadline and a closed socket; the real report method maps them to `2XX`, `4XX`, `5XX`, `TIMEOUT`,
   `CONNECTION`. The trade-mail `send` still returns the same boolean and log line.
3. `2XX`: `EMAIL_SENT`; owner never shown "received".
4. `4XX` four times then `2XX`: `EMAIL_SENT` with 5 attempts recorded; `4XX` five times: `EMAIL_FAILED`
   `ER_ATTEMPTS_EXHAUSTED`.
5. `5XX`: `EMAIL_FAILED` `ER_SMTP_REJECTED` after one attempt; E1 becomes CLOSED with writer `WORKER` in
   the same transaction (if OD-E3 accepts). The worker never writes an `OPEN` event.
6. Crash after acceptance, lease expiry, second delivery: both messages carry the same `report_id` and
   identical bytes; one `EMAIL_SENT` event.
7. Package turns STALE after enqueue: `ER_EXPORT_NOT_READY_AT_SEND`, no send.
8. Owner address changes after enqueue: `ER_RECIPIENT_CHANGED`, no send.
9. E1 closes while PENDING: row becomes `HELD`, attempts unchanged, stored `EMAIL_BLOCKED_SMTP`; further
   worker ticks never claim it; reopening E1 alone sends nothing; owner resume flips the same row to
   `PENDING` and the worker sends.
10. Resend (only if OD-E4 (b)): a new row with `delivery_seq` 2 and the same frozen bytes; a third
    attempt gives `ER_RESEND_LIMIT`.
11. `EMAIL_FAILED` leaves the export READY and downloadable (SC4:1325; RM:2642).
12. ADMIN-owned, top-level, ACTIVE Bot owner passes the recipient rule; a sub-user Bot resolves to its
    parent.
13. Headers: `X-Astra-Report-Id` present on report rows only; stable `Message-ID` only when OD-E5 (b) is
    configured; CR/LF in a header value is cleaned.

### 11.4 API and UI (Node, local, no browser)

1. Email status is a separate response object; no UI or API path derives READY, validity or freshness
   from email status (QL:616).
2. Non-READY packages show no email enqueue control, no preview content and no values.
3. QR-4 routes and multi-Pine packages cannot enqueue (QR4:606; QR4:722; MP:522).
4. Gate-test and receipt confirmation: after the gate-test send and after expiry, a scan of every text
   column of every table, the audit details and the captured log lines finds no plaintext code; the
   gate-test row is deleted; reuse and expiry are refused; `notification_outbox` gets no gate-test row.
5. No route accepts a recipient field.
6. Address HMAC: the stored value is not the plain SHA-256 of the address; a key rotation makes the
   confirmation not current.

### 11.5 Staging evidence (F09-02 target)

1. Engineering: with a fixture package, staging shows `BI_NOT_READY` on preview and enqueue, zero outbox
   rows and READY false. This is engineering evidence only.
2. Delivery: needs a real READY package (none exists, QL:77-85), section 9 complete in staging with
   staging E1 OPEN, a current staging owner receipt confirmation, one preview and one enqueue by the
   owner, `EMAIL_SENT`, and the owner's confirmation that the received report's `report_id` and
   `export_id` match the review page. This is the "confirmed owner receipt" T evidence (SC4:1316,
   SC4:1326).
3. Evidence files record environment, commit, `export_id`, `report_id`, `report_body_hash`,
   `message_hash`, gate event id, status events and UTC stamps; no addresses, secrets, machine paths or
   raw logs.

## 12. Owner decisions (all OPEN; none assumed)

Until each decision is made, the safe default applies: E1 stays CLOSED in every environment and no Email
Report is enqueued.

| ID | Question | Options | Draft recommendation |
| --- | --- | --- | --- |
| OD-E1 | Meaning of "confirmed owner receipt" (PEX:60; RM:2654; R0:12) | (a) per-owner gate-test message with one-time code (5.1); (b) one operator-level test receipt, as on 2026-09-18 (CTX:1189); (c) receipt of a first real report | (a) |
| OD-E2 | Mechanism of the system gate E1 | (a) insert-only gate events; `OPEN` written only by the operations step under owner GO; `CLOSED` also by the worker if OD-E3 is yes; (b) deploy config flag; (c) both | (a) |
| OD-E3 | Does an Email Report 5xx close E1 automatically (worker writes `CLOSED` only) | yes / no | yes (fail-safe; reopening needs section 9) |
| OD-E4 | Resend after `EMAIL_FAILED` | (a) none; report stays on the review page; (b) owner-explicit resend of the same `report_id` and bytes after all gates pass, as a new outbox row with the next `delivery_seq`, bounded count | (b), at most 1 resend (`delivery_seq` at most 2) |
| OD-E5 | Duplicate identification | (a) `X-Astra-Report-Id` header plus subject/body; (b) also a stable `Message-ID` per `report_id` and `delivery_seq` | (b) |
| OD-E6 | Body language | EN; TH; EN and TH in one body; owner preference | EN and TH in one body |
| OD-E7 | Historical backlog disposition (PENDING, FAILED, DISABLED rows), per environment | leave as is and account only; owner-selected archive per class; owner-selected resend per class | Account only; decide PENDING before section 9 step 3 |
| OD-E8 | Staging delivery test before a real READY package exists | (a) gate-test messages only; (b) a labelled FIXTURE report mail with no values | (a) |
| OD-E9 | Package STALE between enqueue and send | (a) fail with `ER_EXPORT_NOT_READY_AT_SEND`; (b) send with a STALE banner | (a) |
| OD-E10 | Report draft storage | (a) pure render, frozen at enqueue; (b) stored draft at QL-4B build (changes accepted S2 schema) | (a) |
| OD-E11 | Attachments | none, link only; package attached | none |
| OD-E12 | Zero-550 observation window before E1 opens | number of hours | owner chooses; draft suggests 24 h |
| OD-E13 | Receipt invalidation triggers | address change; E1 close; SMTP fingerprint change; time expiry | first three (plus HMAC key rotation, fail-safe) |
| OD-E15 | Report outbox table | (a) columns on shared `notification_outbox`; (b) separate `email_report_outbox` | (b) |
| OD-E16 | Recipient role exclusion beyond the ownership rule | none; exclude SUPPORT; exclude other named roles | none; ADMIN stays eligible |
| OD-E17 | Production remediation scope | (a) staging only for F09-02; production 550 fix is a separate owner-scoped operations item; (b) production fix is a precondition of staging T; (c) production E1 opens under this contract after staging T, with its own GOs | (a) |

OD-E14 is reserved and unused in this revision.

## 13. Out of scope

- Live, Futures, short, margin, any broker other than Spot Paper; markets other than BINANCE:BTCUSDT
  Spot 1m (QL:671-673).
- Automatic optimizer loop, automatic rerun, guard reset, automatic Best Inputs apply, automatic email
  enqueue (QL:674-675).
- Multi-Pine Email Report and outbox (MP:522; MP:629; RM:2654).
- Import, apply and Bot start (F09-03; QL:629-630, QL:681).
- The SMTP 550 fix itself, any production configuration or production step, and the historical backlog
  disposition (sections 1.2 and 9; OD-E7; OD-E17).
- Changes to Risk Manager, Pine, Bot policy, session state or package rows.
- Trade and security notification mail; their behavior, `send` result and log line are unchanged.
- Any claim of profitability, owner receipt or delivery from `EMAIL_SENT` alone.

## 14. Known risks and open questions

1. The historical PENDING queue may send old trade notifications as soon as SMTP works (item 2.6);
   current counts, PENDING included, are unknown in every environment (section 8).
2. "Verified owner" rests on the receipt confirmation, because no address-verification field exists
   (item 2.10). Root may prefer a general email-verification feature.
3. The report outbox and the new tables are schema changes and need a migration gate with a protected
   backup and isolated migration/restore rehearsal (RM:2645; OD-E15).
4. The objective field source in the run record is not confirmed by a code read in this draft.
5. Whether a 5xx is always permanent for this provider is unconfirmed; a 4xx/5xx split may need
   provider-specific review in section 9.
6. Evidence refs E041, E008 and E043 of SC4:1318-1322 were not opened for this draft or its review.
7. Whether staging has its own SMTP configuration or shares the production provider account is
   unknown; the environment of the 2026-09-18 receipt (CTX:1189) is the VPS, and whether that was
   production is not stated in the line read.
8. The role of the staging owner account that owns the target Bots is unknown; section 9 step 1 reads it
   through authorized access.

## 15. Review response (revision 1)

Answers `f09-02-review.md`. All findings accepted; none declined.

| Finding | Response | Changed sections |
| --- | --- | --- |
| P2-1 notifier interface | Fixed. Report send method with reply class and code; typed SMTP error; allowed headers; trade and security `send` unchanged; fake and loopback tests | 2.9, 6.2, 7.3, 7.4, 11.3.1-2, 11.3.13, 13 |
| P2-2 gate-test code in plaintext outbox | Fixed. Gate-test message goes through an encrypted queue deleted after send (`mail_receipt_tests`); `security_mail` reuse named as alternative with the two reasons against; high-entropy code; no-plaintext test | 2.7, 5.1, 7.4, 7.5, 11.4.4 |
| P2-3 no preview; unbound confirm | Fixed. Preview route; E5 binds literal confirm, `package_hash` and `report_body_hash`; `ER_PREVIEW_STALE`; content excludes `report_id` and uses the package creation time, so preview and enqueue hashes match | 2.13, 3, 4.1, 4.3, 5, 7.1, 10, 11.1.2, 11.2.4, 11.2.10 |
| P2-4 hold, resume, resend mechanics | Fixed. Outbox `HELD` status; row operations table; resume updates the same row; resend inserts `delivery_seq` 2; unique `(report_id, delivery_seq)` with CHECK | 6.1, 6.2, 6.3, 6.4, 7.1, 7.4, 11.2.9, 11.3.9-10, OD-E4 |
| P2-5 recipient rule excludes ADMIN | Fixed. Rule based on Bot ownership; ADMIN eligible; extra role exclusion is OD-E16; staging owner role read before E1 opens | 2.11, 5.2, 9 step 1, 11.3.12, OD-E16, 14.8 |
| P2-6 environment of E1 | Fixed. E1 and all records per environment; section 9 staging first; production scope is OD-E17; no production step authorized | 1.2, 2.2, 8, 9, 11.5, OD-E17, 13, 14.7 |
| P3-1 send-time READY term | Agreed, fixed. `READY_AT_SEND` defined | 6.2, 7.2, 10 |
| P3-2 gate order vs idempotent repeat | Agreed, fixed. Owner scope, then read-only idempotent lookup, then gates | 5, 6.4, 11.2.3 |
| P3-3 gate-event writer conflict | Agreed, fixed. Worker writes `CLOSED` only; `OPEN` only by operations under owner GO; writer column | 7.2, 7.4, 11.3.5, OD-E2, OD-E3 |
| P3-4 migration rule; table OD | Agreed, fixed. RM:2645 cited; OD-E15 added, recommending a separate table | 7.4, 9 step 3, 14.3, OD-E15 |
| P3-5 unsalted address hash | Agreed, fixed. Address HMAC with a keyring-derived key and key id | 5.1, 5.2, 7.4, 11.4.6, OD-E13 |
| Imprecision in 4.3 (draft row) | Agreed, fixed. "No draft row" marked as proposal under OD-E10 | 4.3 |
| Open items to carry | Kept or added | 14.1, 14.4, 14.5, 14.6 |

## Root acceptance (2026-11-06T07:40Z, ruling SB166)

Accepted as design revision 1. Review files: `.qa-local/l3-f09-contracts-2026-11-06/` (review, review-r2). Residual review notes, carried to implementation (P3, none blocking):

- mail_receipt_tests joins the MailWorker allowlist with its own decrypt context and audit names (7.5).
- The report send method logs only reply class, reply code and report_id, never SMTP reply text (7.3).
- Gate-test rows use the report send method and stop on 5xx, or the 5xx retry is stated as accepted (7.5).
- Resume requires a gate-test confirmation made after the latest E1 OPEN event (7.1).
- The receipt HMAC comparison uses the active key only; a stored key id that differs from the active id means not current (5.1).

Implementation needs its own packet, coder, tester, Opus audit and CI; any staging step needs its own owner GO. A scorecard D credit moves only in a successor scorecard that pins this file.
