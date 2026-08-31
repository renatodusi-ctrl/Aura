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

## Scoring Scale

- `0`: absent or misleading.
- `3`: exists only as a raw artifact or hidden technical state.
- `5`: usable when the operator knows the right click.
- `8`: present in conversation and HUD without artifact hunting.
- `10`: anticipates the next safe move and never lies about state.

## Current Target

The current wave targets 6.5/10 by improving:

- Conselho anti-hang and provider circuit breaker;
- progressive debate rounds;
- `/api/now` as a single source for the visible and speakable state;
- a persistent `Agora` HUD;
- tests for canceling a hanging analyst through the HTTP route.
