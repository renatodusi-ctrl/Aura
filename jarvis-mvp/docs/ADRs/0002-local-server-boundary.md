# ADR 0002 - Local Server Boundary

## Status

Accepted

## Context

The browser must not hold long-lived credentials or directly mutate local files.

## Decision

Use a local Node server as the boundary for credentials, persistence and tools.

## Consequences

- Browser remains focused on UI and permissions.
- Server owns SQLite and OpenAI API key.
- Local-only operation remains possible.
