# Roadmap

## Phase 0 - Migration Skeleton

- Local server on `127.0.0.1:5173`.
- Static cockpit UI.
- SQLite memory and tasks.
- OpenAI Realtime token boundary.
- Local fallback commands.
- Opt-in screen capture.
- Opt-in daily routine while cockpit is open.

## Phase 1 - Voice Reliability

- Realtime event mapping for transcripts and tool calls.
- Better connection recovery.
- Visible microphone permission states.
- Push-to-talk and wake/listen modes.

## Phase 1A - Agent Orchestration Kernel

See `docs/AGENT_ORCHESTRATION_EVOLUTION.md`.

- Persistent job store and timeline.
- Workspace locks.
- Central policy engine.
- Process supervisor with timeout and cancellation.
- Codex CLI adapter in read-only ask mode.
- UI confirmation before write or Git actions.

## Phase 2 - Memory

- Memory review inbox.
- User-editable memory categories.
- Search and recall ranking.
- Export/import JSON.

## Phase 3 - Tools

- Tool confirmation queue.
- Typed tool schemas for Realtime tool calling.
- Windows-safe local automations.
- Per-tool audit trail in the UI.

## Phase 4 - Daily Cockpit

- Calendar/task integrations behind explicit opt-in.
- Morning/evening routine templates.
- Local notification strategy.
