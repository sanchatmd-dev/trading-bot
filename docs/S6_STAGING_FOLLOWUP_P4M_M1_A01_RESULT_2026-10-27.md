# S6 staging follow-up P4M m1 attempt a01: gate stop on the collector timer

Packet: [S6-STAGING-PROTO-FOLLOWUP-1](S6_STAGING_PROTOTYPE_FOLLOWUP_PACKET_2026-10-26.md), phase P4M, job m1. Environment: Staging QL-P2 Prototype. Recorded by the Claude root on 27 October 2026 (Bangkok). Evidence: [result record](evidence/S6_STAGING_FOLLOWUP_P4M_M1_A01_RESULT_2026-10-27.json).

## Outcome

Under the owner's GO, the job ran once at 20:16:31Z and stopped at its gate before any effect: verdict **P4M_STOP_PRE**, code PRE_MARKET_TIMER. No unit was started, no record directory was made, and staging is unchanged. The GO is consumed (no retry).

## Gate

Every item before the timer passed: host health, systemd 255, clock synchronised, the login manager does not kill user processes, production identity equal to the baseline, the staging API and trading worker unchanged since the P5a record, the research worker stopped, and the market units' configuration digests, unit types, stop timeouts, hooks and links. The fallback collector timer reported no monotonic trigger; since systemd loads no timer without a trigger, its trigger is a calendar trigger, which the gate refused by design.

## Next

Ruling D38 lets the gate accept a calendar trigger (checked for form only, first run within 900 seconds of timer readiness), and ruling D39 corrects the GO wording (packet revision 7). Both tools were re-verified and re-pinned. The retry is attempt a02 and needs a new owner GO.
