# Agent Dispatch and Return Templates

Use one commander for each task. Workers may not spawn agents or direct peers. A Git documentation agent may be assigned only by the commander, with an explicit reviewed file list and no other writers active. Never include secrets or account identifiers.

## Dispatch packet

- **Task ID / roadmap gate:** [ID; gate or milestone]
- **Objective:** [one concrete, bounded outcome]
- **Owner:** [role]; **model effort:** [model and effort]
- **Dependencies:** [inputs, prerequisites, or none]
- **Writable paths:** [exact paths; no others]
- **Read-only paths:** [exact paths]
- **Host:** [local or VPS; identify environment without credentials]
- **Allowed commands and state changes:** [specific commands/actions; list prohibited changes too]
- **External-action authority:** Git push, deploy, or any other external action requires explicit user authority. [State granted action and limits, or “none.”]
- **Acceptance evidence:** [observable facts, artifacts, or criteria needed to accept]
- **Stop / escalation:** [conditions to stop and who/what to report]
- **Maximum scope / retries:** [scope boundary and retry count]
- **Usage snapshot:** [captured at, source; every known window with used/remaining and reset time; unknown values marked “unknown”]
- **Budget / reserve / recheck boundary:** [task limit; protected reserve; when to recheck usage before continuing]
- **Checkpoint / handoff:** [reproducible safe checkpoint, commands/state, and exact handoff location; no credentials]

## Return packet

- **Task ID:** [ID]
- **Status:** [pass / fail / blocked / not run]
- **Outcome:** [concise result]
- **Facts:** [verified observations and their sources]
- **Estimates:** [clearly labeled estimates, assumptions, and uncertainty]
- **Provenance:** [source or input identity; commit/ref if applicable; artifact paths and how produced]
- **Files changed:** [exact paths and concise change summary; report none if unchanged]
- **Acceptance evidence:** [criterion-by-criterion evidence, or what is missing]
- **Commands / state changes:** [what ran or changed; report not run where applicable]
- **Usage / budget:** [freshness, known window values, unknowns, spend versus limit/reserve, and recheck point]
- **Checkpoint / handoff:** [safe reproducible state and instructions to resume]
- **Next action:** [single recommended action and owner; include escalation or stop reason when relevant]
