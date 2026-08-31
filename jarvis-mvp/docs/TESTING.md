# Testing

## Static Verification

```powershell
scripts\verify.ps1
```

This checks JavaScript syntax with Node.

## Presence SLO

```powershell
npm run soak:presence
```

The presence soak starts AURA on a free local port, samples `/api/status` and `/api/now`, cancels a hanging local process, calculates p50/p95 latency, and writes `exports/presence-slo-report.json`.

The fast SLO gate also runs inside `npm run verify` with fewer samples. The P0 targets are:

- `/api/status` p95 <= 250 ms.
- `/api/now` p95 <= 250 ms.
- cancellation p95 <= 1500 ms.
- zero stuck local job processes after cancellation.
- zero inconsistent status/now snapshots.

## JARVIS Rubric Gate

```powershell
node scripts\verify-jarvis-rubric.mjs
```

The rubric gate scores AURA against six fixed scenarios: current-state briefing, Conselho briefing, decision/blocker/next-step intents, Conselho-to-implementation handoff, hanging-analysis cancellation and realtime status consistency.

It writes `exports/jarvis-rubric-report.json`. Read `score` for the current 0-10 score, `dimensions` for the weaker product areas and `blockers` for P0 regressions that stop the wave. `npm run verify` runs the short presence SLO first, then this gate, so reliability data is fresh.

## Manual Smoke Test

1. Run `scripts\run.ps1`.
2. Open `http://127.0.0.1:5173`.
3. Add a task.
4. Add a memory.
5. Send `bom dia` in the text composer.
6. Toggle routine on.
7. Try screen capture and stop it.
8. Open `/api/status` and confirm `voice.status` is `fallback`, `realtime`, or `configuration_error`; no API key may appear in the response.
9. Open `/api/voice/health` and confirm provider, model, voice, latency and fallback reason are visible.
10. Add either `OPENAI_API_KEY` with `VOICE_PROVIDER=openai` or `GEMINI_API_KEY` with `VOICE_PROVIDER=gemini` to `.env`.
11. Restart the server, click `Conectar voz`, allow microphone access in Chrome or Edge, say `Aura`, ask a short question, then say `ate logo Aura`.
12. Confirm the assistant speaks, returns to standby, and falls back to text with a clear reason if the provider rejects the session.
13. Keep `Silenciar narracao` active, move a demand to concluded, failed and cancelled states, and confirm AURA narrates at most two short sentences from the same next step shown in `Agora`.
14. Click `Silenciar narracao`, repeat a state change, and confirm no spoken narration is queued while the cockpit stays available.

## Advanced Voice Checklist

1. Start the cockpit with `VOICE_PROVIDER=gemini` or `VOICE_PROVIDER=openai` and connect voice.
2. Say `Aura, status das demandas` and confirm the `Voz` debug chips show capture and first-response latency.
3. While AURA is speaking, start talking again with `Aura, pare e resuma`; the current audio should stop and the next answer should be short.
4. Ask a longer exploratory question and confirm the turn-taking chip moves from `comando curto` to `conversa longa` or `conversa`.
5. Confirm AURA does not continue playing delayed audio after the interruption counter increments.
6. Say `ate logo Aura` and confirm the session returns to standby without overlapping speech.

## Future Automation

- Add Playwright smoke tests.
- Add API tests for task/memory CRUD.
- Add Realtime event fixture tests.
