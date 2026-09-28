# QD-1 / QS-1 resource and profile work checkpoint

The owner authorized steps 2 and 4 in parallel after the verified ingestion Git
checkpoint `9d06ba0`. Two agents own separate resource-control and data-contract
files. This is an incomplete local engineering checkpoint, not phase acceptance.

## Confirmed constraints

A read-only host inspection found that the cgroup v2 root has the I/O controller,
but the ancestor of the user services does not delegate it. The Quant user-service
hierarchy has neither `io.max` nor `io.stat`. I/O pressure files alone do not prove
bandwidth enforcement. Earlier missing counters must remain unknown, never zero.
Filesystem partition identity also differs from the parent block device reported
by ancestor accounting; the reviewed limit must bind the actual accounting device.

Enabling I/O protection needs a host administrator's scoped delegation plan,
health checks, rollback and controller readback. A safe method that avoids
restarting existing services has not yet been established. No host configuration
was changed and no load job was started during this inspection.

Raw Binance datasets use UTC bar-open timestamps. The existing research profile
uses closed-bar timestamps, causal ATR14 and execution increments. Directly
enrolling a raw dataset would shift timestamps by one bar and omit ATR provenance.
Enrollment therefore requires explicit timestamp mapping, seed/continuation
evidence and source/settings capability evidence. Raw ingestion success cannot
satisfy those requirements by itself.

## Resource controls: local implementation

The opt-in `quant-io-v1` configuration binds a reviewed accounting device to
absolute read/write bytes-per-second limits for the main worker and evaluator.
Main-worker startup checks actual cgroup readback. The supervisor withholds the
evaluation payload until the child unit's limits and counters are verified.
Health checks reject missing or regressed counters and a changed cgroup identity.
Supervisor telemetry reads run one at a time; failed stop proof retains the slot.

These are bandwidth limits, not cumulative byte caps. Coverage of all writable
paths and backing devices has not been proved. Legacy operation does not claim
I/O enforcement. Capacity remains unchanged.

The calibration monitor and driver now share one absolute deadline. Missing I/O
measurements remain unknown. Thirteen focused local tests passed across I/O,
resource health, calibration deadlines and the local supervisor integration.
The private calibration helpers passed syntax checks only; no new host load run
or Linux cgroup enforcement test has been performed.

## Data/profile contracts: local implementation

The period API and UI expose explicit UTC ranges and planned stage budgets while
enforcing the existing 10K raw-data admission limit including warm-up. Unverified
`All Available` history is rejected. Metadata readiness is owner-scoped and does
not scan full data or claim content verification. Seventeen focused data tests
passed. Real local PostgreSQL HTTP and BACKFILL suites also passed after route
integration; those results do not certify the new PROFILE lifecycle.

The scheduled PROFILE path freezes server-owned deployment, source, effective
inputs, execution model and raw provenance. Conversion runs under the shared
worker lease. It uses 500 ATR seed bars, maps open times to closed times by one
minute and verifies OHLCV, ATR14 and content hashes. Derived metadata uses the
same half-open index convention as the research store. PROFILE has no partial
checkpoint: recovery restarts conversion from immutable raw input. Retention
tracks raw input and successful derived dataset/sidecar references.

A successful data-profile conversion is not evaluator admission. The result
keeps `evaluator_admission=false`; source/settings capability and parity remain
separate gates. Existing Quant research does not automatically consume the new
profile. The local PROFILE lifecycle now passes the checks below. The first run
found a result-binding schema mismatch, corrected before local acceptance.

## Integration evidence

- Final Node suite: **331/331 passed** in 54.565 seconds. PROFILE unit checks
  include exact final-bar closure and engine identity dependencies.
- Real disposable PostgreSQL: PROFILE **2/2**, data HTTP **2/2**, and BACKFILL
  **2/2** passed. PROFILE covers scheduled success, owner scope, idempotency,
  forbidden partial checkpoints, queued/running cancellation, retention and
  simulated offline recovery with the original deadline and stale-token fencing.
- HTTP verifies PROFILE auth/CSRF, disabled capability, query scope and rejection
  of unfinished raw jobs. Follow-up acceptance below adds successful lifecycle
  through the actual application server.
- Independent static audit found two P2 issues: an unnecessary extra minute before
  enrollment and missing monetary/sidecar dependencies in engine identity. Both
  were fixed, regression checked and reviewed again with no residual finding in
  those diffs. The audit did not certify Linux resource enforcement.
- Initial browser verification was blocked: the preferred browser CLI was
  unavailable and the Codex browser failed with `failed to write kernel assets`.
  The follow-up below records the completed browser fallback.
- Test services were stopped and the disposable browser database removed. The
  local PostgreSQL cluster is stopped. No new VPS work or live collection ran.

The recovery test uses real PostgreSQL with a simulated offline service manager.
It is not a physical PROFILE process-kill/restart drill. Test evidence is in
`test/quant-profile.test.js`, `test/postgres/quant-profile.test.mjs`, and
`test/postgres/quant-data-http.test.mjs`; private runtime logs remain untracked.

## Follow-up: browser and PROFILE acceptance

The owner authorized completion of these local checks. Isolated Chrome through
the installed Playwright runtime tested the real application and PostgreSQL.
Desktop 1440×1000 and mobile 390×844 passed: UTC values remained UTC in an
Asia/Bangkok browser, 1W plus 20 warm-up bars showed 10,100 without truncation,
unverified All Available was rejected, Custom preview returned 140 bars, and
queue/cancel used real HTTP. The mobile layout had no horizontal overflow.

Final follow-up regression: Node **332/332 passed** in 53.857 seconds,
PostgreSQL PROFILE **3/3** in 4.030 seconds, and actual application HTTP
PROFILE **1/1** in 3.258 seconds with the private fixture enabled (zero skips).
The separate no-fixture check reported one explicit skip as intended.

The first browser run reproduced a stale period response overwriting an edited
warm-up value. The UI now invalidates both period results and errors on input
changes, including period selection, and ignores superseded requests. Six focused
DOM tests and the repeated browser interaction passed. Screenshots were visually
reviewed; private screenshots and the temporary browser runner remain untracked.

There were no JavaScript page errors or framework error overlays. Existing global
inline-style and external chart-script CSP warnings were observed and traced to
the preceding Git checkpoint. They are not a clean-console claim for the entire
application; the chart/CSP follow-up remains separate from Data acceptance. The
isolated fixture intentionally lacks the synthetic Quant engine (`/api/quant/health`
returns 503). The 400 response for All Available is the expected rejection.

The additional PostgreSQL revocation test disconnects membership while PROFILE
publication is held. The global slot stays occupied until conversion settles;
fenced completion fails, the job becomes CANCELLED and no result or checkpoint
is admitted. This verifies publication denial after authorization is revoked.

The successful HTTP lifecycle uses the actual server and supported source bytes
from an explicitly selected private fixture. Custom review metadata and market
bars are synthetic local test inputs. The test verifies create, status, cancel,
idempotency/conflict and foreign-owner scope while preserving
`data_profile_verified=true` and `evaluator_admission=false`. This is engineering
acceptance, not new TradingView review or evaluator parity. Without the private
fixture the test must explicitly skip; a skip is not acceptance.

## Remaining acceptance gates

Verify a physical PROFILE crash/restart in isolated staging. Prior physical
recovery evidence covers the previous ingestion/research paths, not PROFILE.

For resource controls, establish the administrator-owned delegation plan above,
then prove real Linux readback, cancellation/pause latency, physical stop and
Trading/Web/DB impact under a bounded workload. These host gates precede expanded
capacity and remain separate from local unit evidence.

The current admission limit remains 10,000 bars including warm-up for BTCUSDT
Spot 1m. Expanded capacity, production rollout and QD-1/QS-1 closure remain gated.
An earlier wave paused at the project's usage boundary. The resumed wave uses
small local integration slices; earlier checkpoint tests do not certify new
edits. No Git publication or deployment occurred in this work checkpoint.
