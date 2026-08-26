# Architecture

## Boundary

AURA has a hard local boundary:

- Browser: UI, microphone permission, WebRTC peer connection, opt-in screen capture.
- Node server: static files, local API, OpenAI credential boundary, SQLite memory.
- SQLite: persistent memories, tasks and tool audit rows.

## Runtime

The app uses Node.js 22+ because memory is implemented with `node:sqlite`.

No npm runtime dependencies are required in the MVP. This keeps setup small and avoids a package manager as a boot blocker.

## Realtime

The browser requests `/api/realtime/token`. The local server calls OpenAI `POST /v1/realtime/client_secrets` with the real API key and returns the short-lived client secret. The browser then posts its SDP offer to OpenAI `POST /v1/realtime/calls` using that ephemeral value.

## Local Fallback

When `OPENAI_API_KEY` is absent, the app still serves the cockpit and supports:

- memory creation;
- task creation and completion;
- simple local text commands;
- opt-in routine summary.

## Tools

Tools are registered in `server/tools.js`. Destructive or sensitive actions are marked `requiresConfirmation` and only run when a confirmed request is sent.
