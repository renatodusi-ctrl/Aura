# Sprints

## Sprint 1 - Bootable MVP

Goal: make AURA boot locally and preserve data.

- Verify Node 22.
- Start cockpit at `127.0.0.1:5173`.
- Persist memories and tasks in SQLite.
- Keep fallback local usable.

## Sprint 2 - Realtime Tool Loop

Goal: let voice sessions request local tools safely.

- Add tool schema publishing to Realtime session config.
- Listen for function call events.
- Queue sensitive tool requests.
- Return tool outputs to Realtime.

## Sprint 3 - Daily Operator

Goal: make AURA useful every day.

- Build morning routine.
- Add memory review workflow.
- Add task prioritization.
- Add export/import.
