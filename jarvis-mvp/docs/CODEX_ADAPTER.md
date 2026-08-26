# Codex Adapter

`server/codexAdapter.js` is the first executable agent adapter in AURA.

## Scope

- `ask` mode with `policyLevel=read`.
- `implement` mode with `policyLevel=write` and explicit cockpit confirmation.
- `codex exec --sandbox read-only` for ask.
- `codex exec --sandbox workspace-write` for confirmed implement.
- pinned workspace through `--cd` and process `cwd`.
- transcript persisted through job events.
- no commits, pushes, resets or destructive commands in early phases.

## Local API

```text
POST /api/jobs/:id/codex/ask
POST /api/jobs/:id/codex/implement
```

Payload:

```json
{
  "prompt": "Explain the current architecture.",
  "timeoutMs": 120000
}
```

Implement payload:

```json
{
  "confirmed": true,
  "prompt": "Apply the approved plan.",
  "timeoutMs": 300000,
  "testCommand": {
    "command": "npm",
    "args": ["run", "verify"],
    "timeoutMs": 120000
  }
}
```

The route is protected by the local AURA session token.

## Failure Mode

If Codex CLI is absent, the adapter marks the job `failed`, records a `codex.detected` event, and does not retry silently.

## Implement Artifacts

Confirmed implement jobs persist artifacts for cockpit review:

- Codex stdout/stderr logs.
- Codex final message from `--output-last-message`.
- `git diff --`.
- `git diff --name-only --` as changed files.
- Optional test log. If no `testCommand` is supplied and the workspace has `package.json`, AURA runs `npm run verify`.

The adapter rejects implement requests that include blocked destructive intent such as `git push`, `git reset`, recursive destructive removal, or Windows recursive delete commands. It does not create commits or push changes.
