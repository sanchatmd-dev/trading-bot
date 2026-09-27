# QL-3A varied source-input parity

Status: **baseline and 16 source-axis settings matched in TradingView; mixed
candidate and repaint gates remain open**, 2026-09-27.

The owner-approved eight numeric source slots are bound to the immutable SPT
Spot source and input lock. Seventeen private evidence scripts are prepared:
one reviewed Custom baseline and the minimum/maximum of each selected slot.
Each variant changes one source value. The other 57 source values remain at the
reviewed baseline; Bridge evidence records ATR 60 and RR 1.5.

The builder verifies all 58 default bindings and reconstructs the exact approved
source from the edited default spans. No original calculation, signal logic or
input declaration outside those defaults changes. The appended plots expose
native BUY/EXIT and source state, with case-specific column names to distinguish
them from existing chart indicators. These artifacts contain no execution Bridge,
capture token or added alert call. Original notifications default to disabled.
They must not be used to replace the running Paper alert.

## Reproduce privately

Run from the repository root with the approved private files. Use a new output
directory for each build; existing artifacts are never overwritten.

```powershell
node scripts/build-ql3a-input-parity.mjs `
  .qa-local/ql2a-source-private.json `
  .qa-local/ql3a-approved-input-lock-private.json `
  .qa-local/ql2a-spt-v4-state-trace.pine `
  .qa-local/ql3a-input-parity
```

## Evidence procedure

1. Compile a separate evidence script on standard BINANCE:BTCUSDT 1m. Review
   all effective inputs against its case manifest before exporting chart data.
2. Export at least 3,250 consecutive closed bars: at least 1,250 warm-up and
   2,000 measured bars. Exclude the realtime bar. Match every measured OHLCV
   against independent Binance Spot candles. Preserve the private CSV hash,
   artifact hash, case identity, reviewed input hash and export time.
3. Run the Custom evaluator with the exact variant. Require zero native
   BUY/EXIT mismatches, zero discrete-state mismatches and numeric state error
   at most 1e-7. Compare the applicable 14 state fields and verify the shadow
   SuperTrend mismatch flag remains zero.
4. Report cold-start comparison separately from any checkpoint comparison.
   A checkpoint may come only from the **same variant's** reviewed trace.
   Populate previous highs/lows using that variant's confirmation lookback;
   the fixed-profile five-bar restore helper alone is insufficient for changed
   confirmation lookback. Never reuse the baseline checkpoint for a variant.
5. If a truncated export produces EMA/state convergence errors, record the
   failure and obtain adequate preceding history. A minimum warm-up count does
   not guarantee the 1e-7 criterion. Do not replace cold-start acceptance with a
   passing checkpoint result.

Min/max axis cases demonstrate participation of all eight dimensions. They do
not certify all mixed combinations in the sampled candidate plan. Any selected
candidate still needs its own exact-input TradingView parity evidence before
owner delivery. Bridge/Paper execution parity and the Custom-specific
100-observation repaint check remain separate requirements.

No owner optimization has been submitted. QL-4B remains gated.

## Recorded TradingView result

[Sanitized evidence](evidence/QL_3A_CUSTOM_AXIS_PARITY_2026-09-27.json) records
17 effective settings: the baseline and both bounds of each selected input.
The operator saved and compiled `QL-3A parity Custom FastEMA30 evidence`, then
changed only its eight source input controls between exports. All other inputs
remained at the reviewed baseline. The Paper alert was not edited. The evidence
study was returned to baseline after the final comparison.

The initially pasted artifact had the first preparation's column names. The
operator updated its 17 appended plot titles through Pine Editor Find/Replace
to match the second preparation before compilation. Those titles keep the
`QL3A emaFastInput-min` prefix for all later GUI input variants. Case identity
comes from the reviewed effective-input hash, not that shared column prefix.
The evidence records the expected local trace artifact hash; the complete saved
TradingView source bytes were not retrieved or independently hashed.

All cases use the same **5,808 consecutive closed bars**, independently matched
against Binance Spot OHLCV with zero missing or differing candles. Cold-start
evaluation uses **3,250 preceding bars and 2,558 measured bars**. All native
BUY/EXIT flags and 14 state fields match within 1e-7; maximum numeric error is
5.093170329928398e-10. Same-variant checkpoint comparisons after 1,250 bars also
match, with the selected confirmation lookback used for the previous high/low
buffers. They are recorded separately from cold-start results.

Cold-start comparisons after only 1,250 bars failed the numeric Slow EMA
criterion despite matching native flags. Those failures remain in the evidence.
Use at least the measured 3,250-bar warm-up for this scoped follow-up, then
recheck convergence for the exact chosen candidate. The service's existing
1,250-bar minimum is an engineering lower bound; it does not establish accepted
source-state convergence or owner recommendation readiness.

Confirmation Lookback 3, 5 and 7 produced identical BUY/EXIT vectors on the
complete 5,808-bar window with Confirmation Mode `Any`. This is a dataset-specific
finding, not a universal claim that the input has no effect. Keep the approved
input lock unchanged; review whether to fix or replace this slot before treating
it as a useful extra search dimension. The other seven selected inputs produced
different measured signal counts in at least one tested bound.

This verifies individual input axes. It does not accept arbitrary mixed
combinations, register customer Quant capability, satisfy the fresh Custom
100-observation repaint gate or create Best Inputs.

## Custom repaint capture preparation

Read-only session inventory at 2026-09-27 05:13:46 UTC found 1,350 native
observations for the approved Spot source, but their registered snapshot is
Daily/Swing. Other native sessions also reference Daily/Swing and, in some
cases, the previous source revision. None attests the reviewed Custom inputs.
The axis-parity study has no added capture alert and cannot supply those missing
recorded live observations.

A [separate Custom capture](evidence/QL_3A_CUSTOM_REPAINT_PREPARATION_2026-09-27.json)
is now prepared on a new DRAFT deployment linked to the existing Custom source
revision and 58-input snapshot. The existing Paper deployment, session, policy
and risk counters are preserved. The native-trace artifact preserves original
source bytes and has no executable Bridge events. Its original source defaults
still require complete TradingView input review before enabling the new alert.
The local Pine file and webhook bearer URL remain private.

The preparation was completed on 2026-09-27. The separate script
`QL-3A Custom native repaint CAPTURE ONLY 1m` was saved, compiled and added to
standard BINANCE:BTCUSDT 1m. All 58 effective source input values were read back
from the TradingView input dialog and matched the registered Custom snapshot.
The confirmed HTF filter and original notifications are off. Full saved
TradingView source bytes were not retrieved or independently hashed.

The new Alert uses `Any alert() function call`, the 1-minute chart interval,
24/7 webhook delivery and no other notification channels. The private webhook
URL was read back against the new capture session before creation. The Alert
and existing ATR60 Paper Alert were both confirmed Active. The conservative
collection start is **2026-09-27 05:29:08.236 UTC** (12:29:08.236 Asia/Bangkok).

At **05:31:19.605 UTC**, the staging receiver had accepted three native trace
observations with zero rejections. Two distinct closed bars are eligible after
the conservative start; the earlier 05:29 closed bar is excluded. The largest
delivery delay for those two eligible observations was 6,193 ms. This is genuine
TradingView delivery, not a synthetic POST or an execution event.

Status is **COLLECTING_CUSTOM_REPAINT**; the
[collection evidence](evidence/QL_3A_CUSTOM_REPAINT_COLLECTION_2026-09-27.json)
records identities, review hashes and receiver counts without credentials or
private source. Record at least 100 distinct eligible closed-bar observations,
then export later history with the exact same settings and compare BUY/EXIT
flags and close. No successful repaint comparison is claimed yet. Do not infer
readiness from elapsed time, old-session counts or market bars. The existing
Paper deployment and Alert remain in place; this capture has execution disabled.

## Custom repaint result

The scoped baseline check passed at **2026-09-27 07:21:50 UTC**. The operator
froze the first 100 eligible native observations after the conservative start,
then compared their snapshot-bound payloads with the later TradingView history
export. The CSV has uniquely named `QL3A Custom Repaint Native BUY flag` and
`QL3A Custom Repaint Native EXIT flag` columns; other studies' columns were not
used. Closed-bar time is CSV bar-open time plus 60,000 ms, and the realtime bar
is excluded. The frozen sample spans 05:30–07:09 UTC (12:30–14:09 Asia/Bangkok).

The existing `spt_repaint.repaint_comparison` verifier checked capture/source/
snapshot/artifact/chart-review provenance, event identities, unique timestamps,
boolean flags, delivery within five minutes and a history export after receipt.
All **100 observations** matched BUY, EXIT and decimal close exactly: **zero
changes, zero missing history rows and zero gaps**. Delivery delay was at most
9,832 ms, and the capture had zero rejections at freeze. The
[sanitized result](evidence/QL_3A_CUSTOM_REPAINT_RESULT_2026-09-27.json) retains
the frozen capture and CSV hashes; raw payloads and CSV remain private.

The sample contains **two positive BUY flags and zero positive EXIT flags**.
False EXIT flags matched on every bar, but this sample does not demonstrate
stability of a positive EXIT event. This satisfies the documented 100-observation
baseline gate for these exact reviewed Custom settings. It does not prove that
all settings never repaint, verify full saved TradingView source bytes, establish
candidate parity or close QL-3A's Paper trade-coverage gate. Capture and Paper
Alerts remain active; no execution policy or risk counters were changed.
