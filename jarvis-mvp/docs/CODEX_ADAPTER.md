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
- Local `critic-review` with a quality gate:
  - `pass` keeps the implementation `done`.
  - `review` moves the implementation to `needs_input` for a human decision when confidence is limited, such as missing tests or no diff content.
  - `block` moves the implementation to `needs_input` when Codex exits non-zero or automated verification fails.
- When the gate pauses in `needs_input`, AURA also persists:
  - `rollback-plan`: operator-safe instructions for reviewing, resuming or reverting only listed files.
  - `independent-critic-brief`: a read-only review brief that can be handed to Codex ask or an external analyst.
  - `independent-critic-review`: an attempted Codex read-only review of that brief, captured as an artifact without granting write access.

The adapter rejects implement requests that include blocked destructive intent such as `git push`, `git reset`, recursive destructive removal, or Windows recursive delete commands. It does not create commits or push changes.
