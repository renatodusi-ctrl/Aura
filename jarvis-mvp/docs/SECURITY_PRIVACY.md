# Security and Privacy

## Local Boundary

AURA runs locally and stores memory in `data/aura.sqlite`. The database is ignored by Git.

## API Key

`OPENAI_API_KEY` belongs only in `.env` on the local machine. The browser never receives the real key. It receives only a short-lived Realtime client secret.

## Confirmation

Actions that delete data or request sensitive browser permissions require explicit user confirmation.

## Local API Protection

Sensitive local API routes, including local context and jobs, require:

- an allowed local origin;
- an `X-AURA-Session` token issued by `GET /api/session`.

Unexpected browser origins are rejected before sensitive endpoints run. The allowlist is fixed to `127.0.0.1`, `localhost`, and the configured bind host when it is not a wildcard host.

## Redaction

Job goals, job event messages, job event data, job metadata and tool run input/output are redacted before persistence. The baseline redactor masks token-like values, sensitive keys and `.env` paths.
The cockpit also redacts visible local messages, streaming transcripts and technical event payloads before rendering them in the browser, including attachment data URLs.

## Safe Terminal Diagnostics

The cockpit exposes a `Terminal seguro` tab for local CLI diagnostics.
AURA does not receive a free-form shell. The server accepts only allowlisted diagnostic IDs, executes them without a shell, applies a timeout and redacts terminal output before returning it to the browser.

The environment presence diagnostic reports only `configured` or `missing` for sensitive variables. It never returns API key or token values.

## Data Deletion

The user can delete individual memories, remove individual visual evidence artifacts, or use privacy purge controls to delete persisted memories and persisted `screen-evidence` summaries after explicit confirmation.
The purge API is protected by the local session token and accepts a constrained scope: `memories` or `screen-evidence`.

## Screen Capture

Screen capture uses the browser `getDisplayMedia` prompt. It is opt-in per session and can be stopped from the cockpit or browser controls.
The cockpit treats this as temporary perception: it shows an active indicator, purpose, countdown and immediate stop control. The session is held only in browser memory, expires automatically after the selected duration and is always off after refresh or restart.

Screen content becomes job evidence only after a second explicit action: `Anexar a demanda`.
AURA stores a redacted textual `screen-evidence` artifact with dimensions and consent metadata; the raw image frame is not persisted.
The artifact is visible in the demand artifacts tab and can be removed by the user with confirmation.

## Routine

The daily routine runs only while the cockpit is open and the toggle is enabled.
