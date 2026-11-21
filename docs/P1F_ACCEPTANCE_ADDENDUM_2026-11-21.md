# Prototype walkthrough evidence update, 2026-11-21

The owner selected Reading B for the six-step Paper walkthrough. Codex root reviewed the dated observations below against the original clauses. Each ruling applies only to the environment and date shown. Overall P1-F acceptance remains open. [Original walkthrough record](P1F_ACCEPTANCE_RECORD_2026-11-06.md)

| Clause | Evidence | Root ruling |
| --- | --- | --- |
| 2.4. Ten slots and stored snapshot | On November 6 the authenticated readiness read showed no READY deployment for Main Bot. The hash check needs a stored deployment snapshot. The earlier draft held seven slots. [Staging read](evidence/PM1_P1F_2_4_AND_SIZING_STAGING_READ_2026-11-06.json) | **RECORDED GAP.** The authorized read was completed. Evidence for all ten slots and a matching deployment snapshot is still missing. |
| 3.7. Enter values and rerun sizing preview | On November 6 the owner delegated the choice of example values to root. The first preview reported missing volatility. After entering volatility and rerunning, the preview showed quantity 0.005517271819. At entry 90624.59 and stop 88812.10 that corresponds to risk 10 and notional 500.0005, within display rounding. The operator used the preview only. [Staging read](evidence/PM1_P1F_2_4_AND_SIZING_STAGING_READ_2026-11-06.json) | **PASS for the November 6 desktop observation**, on the recorded staging pin. This closes the outstanding request for sizing numbers. Clause 3.4 still requires evidence from the separate proposal view. |
| 6.4. Compatible and incompatible Library pairs | On November 21 the Library showed an unranked shared-context pair. It withheld metrics for a different-context pair. The transcript retained the outcome but did not identify the particular field the UI reported as different. [UI readback](evidence/PM1_STAGING_UI_READBACK_2026-11-21.json) | Both comparison paths were exercised. Verification of the displayed mismatch reason remains open. |

## Other open items from the November 6 draft

- The November 21 setup guide matched the selected Bot's readiness in English and Thai at desktop and phone width. The phone-width check covered the guide in a browser emulator. The full owner phone walkthrough remains open. [UI readback](evidence/PM1_STAGING_UI_READBACK_2026-11-21.json)
- The owner approved the 48 Thai wording pairs in the local fix at revision `4dc9fbd` under ruling SB178. Verification of the original Quant Lab, Risk manager and Analytics gaps on staging remains open.
- The owner chose to stop the obsolete SPT staging capture alert. The operator recorded its status as “Stopped manually” on November 6 at 10:37 UTC under ruling SB165. That historical decision is closed.
- The ten-slot demonstration still requires evidence from eight eligible numeric source inputs and the two Bridge inputs. The fixed-symbol comparison warning remains a recorded product backlog item. [Original walkthrough record](P1F_ACCEPTANCE_RECORD_2026-11-06.md)

## Engineering score

S6 remains the accepted PM-1 scorecard. Its prototype evidence range is 76.08–81.08% and its whole-project range is 70.28–75.75%. The setup-guide staging evidence addresses project row F01-03. The prototype Library comparison row P06-03 already held target credit in S6. Publishing this walkthrough update does not change either score. [S6 scorecard](progress/PM1_SCORECARD_S6_2026-11-12.md)
