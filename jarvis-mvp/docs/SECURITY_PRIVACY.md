# Security and Privacy

## Local Boundary

AURA runs locally and stores memory in `data/aura.sqlite`. The database is ignored by Git.

## API Key

`OPENAI_API_KEY` belongs only in `.env` on the local machine. The browser never receives the real key. It receives only a short-lived Realtime client secret.

## Confirmation

Actions that delete data or request sensitive browser permissions require explicit user confirmation.

## Local API Protection

Sensitive local API routes require:

- an allowed local origin;
- an `X-AURA-Session` token issued by `GET /api/session`.

Unexpected browser origins are rejected before sensitive endpoints run.

## Redaction

Job events, job metadata and tool run input/output are redacted before persistence. The baseline redactor masks token-like values, sensitive keys and `.env` paths.

## Screen Capture

Screen capture uses the browser `getDisplayMedia` prompt. It is opt-in per session and can be stopped from the cockpit or browser controls.

## Routine

The daily routine runs only while the cockpit is open and the toggle is enabled.
