# Migration Notes

This folder is the initial migrated MVP for AURA.

## Decisions

- Keep everything local-first.
- Use Node.js 22+ native SQLite.
- Keep OpenAI API keys server-side only.
- Make Realtime optional so the project works without credentials.
- Require explicit browser/user confirmation for screen capture and destructive local tools.

## Current State

The project is functional as a local cockpit and persistence layer. Realtime voice needs a valid OpenAI API key and a browser with microphone permission.

## Follow-Up

Next migration work should focus on robust Realtime tool-call handling and better parsing of local fallback commands.
