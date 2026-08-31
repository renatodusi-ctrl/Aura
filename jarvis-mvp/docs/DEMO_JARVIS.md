# JARVIS Demo

This demo is a repeatable path for showing AURA as a local voice cockpit: voice, Conselho, HUD, decision, implementation and verification.

## Setup

```powershell
npm install
npm run demo:seed
npm run verify
scripts\run.ps1
```

Open `http://127.0.0.1:5173` in Chrome or Edge. Configure either Gemini Live or OpenAI Realtime before the voice scene.

## Scenes

### 1. Voice Standby

Goal: prove AURA can stay quiet until called.

1. Click `Conectar voz`.
2. Allow microphone access.
3. Say a phrase without `Aura`; AURA should stay in standby.
4. Say `Aura, status das demandas`.

Success: the cockpit shows voice metrics for capture and first response, and AURA answers only after the wake word.

Recovery: if voice fails, open `Controle de Custos` and `Eventos tecnicos`, show the fallback reason, then continue by text.

### 2. Mission HUD

Goal: show first-glance state and one real action.

1. Use the seeded demand `AURA DEMO :: Implementar uma micro melhoria visual apos aprovacao`.
2. Confirm the top `Agora` card states what is happening.
3. Confirm the `Missao` decision card shows the next decision and one CTA.

Success: a viewer can say what is happening and what to do next without opening technical history.

Recovery: if another demand is active, use the operational queue to select the seeded demand.

### 3. Conselho Decision

Goal: show Gemini, Grok and OpenRouter as analysts while Codex waits for a decision.

1. Open the seeded Conselho demand.
2. Open the `Conselho` tab.
3. Show recommendation, confidence, consensus, dissent and risks.

Success: the decision is readable as an executive briefing and can become implementation work.

Recovery: if an analyst is unavailable, show the degraded provider state and continue with the available responses.

### 4. Confirmable Implementation

Goal: prove local writes require visual approval.

1. Select the seeded implementation demand.
2. Show the approval band and likely workspace.
3. Do not execute unless the presenter explicitly wants a live write.

Success: Codex cannot write before the operator approves.

Recovery: use `Pausar` or `Registrar critica` to show governance without touching files.

### 5. Privacy Controls

Goal: prove sensitive data is visible and reversible.

1. Open `Contexto local > Memoria`.
2. Show individual edit/delete controls and the `Apagar memorias` control.
3. Open `Conselho, captura e diagnosticos > Percepcao`.
4. Show active indicator, countdown and `Apagar evidencias`.

Success: memory and visual evidence have clear deletion controls, and raw frames are not persisted.

Recovery: if screen permission is blocked, use the browser permission prompt as the privacy proof and continue with existing evidence summaries.

### 6. Re-score

Goal: re-evaluate the JARVIS score after the demo.

```powershell
npm run verify
node scripts\verify-jarvis-rubric.mjs
```

Success: the rubric report is generated in `exports/jarvis-rubric-report.json`.

## Recording Checklist

- Browser zoom at 100%.
- No real API keys on screen.
- `.env` closed.
- Voice key configured only in local `.env`.
- Demo data created with `npm run demo:seed`.
- `npm run verify` completed before recording.
- A fallback path prepared for voice, analyst provider and Codex execution.
