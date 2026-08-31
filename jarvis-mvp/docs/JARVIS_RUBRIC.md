# JARVIS Interaction Rubric

AURA is scored against a practical J.A.R.V.I.S.-style product target, not against movie fantasy. The target is a present, honest and safe local copilot that can explain what is happening now, suggest the next safe move, and execute only after confirmation.

## Dimensions

| Dimension | Weight | 10/10 means |
| --- | ---: | --- |
| Presence and voice | 20 | Realtime voice is natural, low-latency, interruptible and honest about fallback. |
| Continuity and memory | 15 | AURA remembers the current mission, recent decisions, preferences and useful project context. |
| Safe initiative | 10 | AURA proactively offers one safe next action for `done`, `needs_input` or blocked work, then stops. |
| Honest perception | 10 | Screen/status context is visible, consented and never implied when unavailable. |
| Council briefing | 15 | The Conselho produces a concise decision with consensus, dissent, risks, unknowns and next action. |
| Confirmable Codex execution | 15 | Implementation always passes visual confirmation, diff, critic gate and rollback guidance. |
| Now HUD | 10 | The cockpit always shows the current mission, blocker, decision, realtime state and CTA. |
| Reliability floor | 5 | No hanging jobs; cancel is fast; UI state matches `/api/status` and `/api/now`. |

Any hanging job in the scenario run caps the total score at 6.0, even if other dimensions look strong.

## Fixed Scenarios

1. Ask "o que esta acontecendo agora" with no job selected.
2. Run one Conselho analysis and verify spoken/visible briefing.
3. Ask for decision, blockers and next step through chat or voice intent.
4. Create an implementation from a Conselho decision and stop at `awaiting_confirm`.
5. Cancel a hanging analysis and verify no job remains `running`.
6. Compare realtime on/off state with `/api/status` and the cockpit chip.

## Automated Gate

The executable gate lives in `jarvisRubric.js` and runs through `scripts/verify-jarvis-rubric.mjs`.
It converts the fixed scenarios into evidence checks against code, smoke tests, the presence SLO report and product documentation.

The generated report is written to `exports/jarvis-rubric-report.json` with:

- `score`: current weighted score from 0 to 10.
- `target`: minimum score for this wave, currently `10`.
- `scenarios`: S1-S6 with missing evidence when a scenario regresses.
- `dimensions`: reliability, presence, action, memory, perception and fluency.
- `blockers`: P0 regressions that prevent the wave from advancing.

The gate fails when any P0 scenario or P0 criterion is missing, or when the weighted score is below target. This keeps progress tied to verifiable product behavior instead of a manual impression of the cockpit.
Non-P0 misses remain in the report as the next maturity gaps, so a passing wave can still show work left before the full product target.

## Scoring Scale

- `0`: absent or misleading.
- `3`: exists only as a raw artifact or hidden technical state.
- `5`: usable when the operator knows the right click.
- `8`: present in conversation and HUD without artifact hunting.
- `10`: anticipates the next safe move and never lies about state.

## Current Target

The current wave targets 10/10 by requiring every JARVIS scenario and maturity criterion to have executable evidence:

- reliable Conselho execution with cancellation, SLO and circuit breaker controls;
- natural voice presence with wake word, fallback honesty, barge-in and turn-taking telemetry;
- `/api/now` as the single visible and speakable source for mission, decision and CTA;
- Conselho-to-Codex implementation with visual confirmation, critic review and rollback guidance;
- SQLite memory, preferences and short session continuity;
- consented screen perception with expiration, stop controls and purgeable evidence;
- a repeatable operator demo that can be seeded, verified and recorded without exposing secrets.
