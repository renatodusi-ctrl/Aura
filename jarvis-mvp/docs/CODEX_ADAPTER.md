# Codex Adapter

`server/codexAdapter.js` is the first executable agent adapter in AURA.

## Scope

- `ask` mode only.
- `policyLevel=read` only.
- `codex exec --sandbox read-only`.
- pinned workspace through `--cd` and process `cwd`.
- transcript persisted through job events.
- no commits, pushes, package installs or write-mode execution.

## Local API

```text
POST /api/jobs/:id/codex/ask
```

Payload:

```json
{
  "prompt": "Explain the current architecture.",
  "timeoutMs": 120000
}
```

The route is protected by the local AURA session token.

## Failure Mode

If Codex CLI is absent, the adapter marks the job `failed`, records a `codex.detected` event, and does not retry silently.
