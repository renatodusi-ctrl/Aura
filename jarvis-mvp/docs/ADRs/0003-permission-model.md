# ADR 0003 - Permission Model

## Status

Accepted

## Context

AURA can touch sensitive areas such as local memory and screen capture.

## Decision

Sensitive or destructive tools require explicit confirmation. Browser-native prompts are used for microphone and screen capture.

## Consequences

- Lower accidental action risk.
- Tool execution needs confirmation-aware UI and API paths.
