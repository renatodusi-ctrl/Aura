# ADR 0001 - Voice Realtime WebRTC

## Status

Accepted

## Context

AURA needs low-latency voice in the browser.

## Decision

Use OpenAI Realtime over WebRTC in Chrome/Edge. The server mints client secrets and the browser negotiates a peer connection.

## Consequences

- Good browser-native media handling.
- Requires user microphone permission.
- Requires a valid `OPENAI_API_KEY` for real voice.
