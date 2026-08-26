# Security and Privacy

## Local Boundary

AURA runs locally and stores memory in `data/aura.sqlite`. The database is ignored by Git.

## API Key

`OPENAI_API_KEY` belongs only in `.env` on the local machine. The browser never receives the real key. It receives only a short-lived Realtime client secret.

## Confirmation

Actions that delete data or request sensitive browser permissions require explicit user confirmation.

## Screen Capture

Screen capture uses the browser `getDisplayMedia` prompt. It is opt-in per session and can be stopped from the cockpit or browser controls.

## Routine

The daily routine runs only while the cockpit is open and the toggle is enabled.
