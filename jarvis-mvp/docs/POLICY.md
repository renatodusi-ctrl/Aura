# Policy

AURA uses a central policy model for jobs and tools.

## Levels

| Level | Job behavior | Tool behavior |
| --- | --- | --- |
| `read` | Allowed, no confirmation, remains `draft`. | Allowed without confirmation. |
| `write` | Allowed, requires `ui_confirm`, moves to `awaiting_confirm`. | Requires confirmation. |
| `git` | Allowed, requires `ui_confirm`, moves to `awaiting_confirm`. | Requires confirmation. |
| `network` | Allowed, requires `ui_confirm`, moves to `awaiting_confirm`. | Requires confirmation. |
| `secrets` | Blocked until typed confirmation exists, moves to `failed`. | Requires typed confirmation. |
| `destructive` | Blocked until typed confirmation exists, moves to `failed`. | Requires typed confirmation. |

## Rules

- Voice can request a job, but must not confirm sensitive work by itself.
- Jobs that need visual confirmation use `awaiting_confirm`.
- Jobs blocked by missing typed confirmation are persisted as `failed` with a policy reason.
- `implement` jobs cannot remain `read`; the API escalates them to `write`.
- Current local tools still honor confirmation before sensitive actions.
