# ADR 0004 - Memory SQLite

## Status

Accepted

## Context

AURA needs persistent local memory without external services.

## Decision

Use `node:sqlite` with a local database under `data/aura.sqlite`.

## Consequences

- Requires Node.js 22+.
- No npm database dependency.
- Data remains local and easy to export.
