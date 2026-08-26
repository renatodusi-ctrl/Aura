# Jobs

AURA jobs are the persistent unit of orchestration work. Every future Codex, Gemini, Grok, debate, voice or routine demand should become a job before any external CLI or sensitive tool runs.

## Tables

### `jobs`

| Column | Purpose |
| --- | --- |
| `id` | Local job identifier. |
| `goal` | User-facing objective. |
| `workspace` | Pinned working directory for the job. |
| `mode` | `ask`, `analyze` or `implement`. |
| `status` | `draft`, `awaiting_confirm`, `queued`, `running`, `needs_input`, `done`, `failed` or `cancelled`. |
| `requested_by` | Source such as `text`, `voice` or `routine`. |
| `policy_level` | `read`, `write`, `git`, `network`, `secrets` or `destructive`. |
| `requires_confirmation` | Boolean stored as `0` or `1`. |
| `timeout_ms` | Execution budget for future process supervision. |
| `error` | Human-readable failure reason. |
| `summary` | Final result summary. |
| `metadata` | JSON metadata for adapter-specific context. |
| `created_at`, `updated_at`, `started_at`, `finished_at` | Lifecycle timestamps. |

### `job_events`

Append-only timeline entries for each job.

| Column | Purpose |
| --- | --- |
| `id` | Local event identifier. |
| `job_id` | Parent job. |
| `type` | Event type such as `job.created` or `job.status_changed`. |
| `message` | Human-readable event text. |
| `data` | JSON event payload. |
| `created_at` | Event timestamp. |

## Rules

- Jobs must exist before external CLIs run.
- Status transitions should append `job_events`.
- New jobs start as `draft`.
- Terminal statuses `done`, `failed` and `cancelled` are final.
- Future writers must use workspace locks before running.
- Voice may create jobs, but must not confirm sensitive actions by itself.
- CLI output persisted into job artifacts or events must be redacted before storage.

## Local API

The job API is orchestration-only. It does not execute external CLIs.

| Route | Purpose |
| --- | --- |
| `GET /api/jobs?limit=50` | List recent jobs. |
| `POST /api/jobs` | Create a draft job. |
| `GET /api/jobs/:id` | Read one job with its events. |
| `GET /api/jobs/:id/events` | Read a job timeline. |
| `POST /api/jobs/:id/cancel` | Cancel a non-terminal job. |

Create payload:

```json
{
  "goal": "Review the AURA architecture",
  "workspace": "/path/to/workspace",
  "mode": "ask",
  "requestedBy": "text",
  "policyLevel": "read",
  "timeoutMs": 300000,
  "metadata": {}
}
```

If `workspace` is omitted, AURA uses its local project directory. `secrets` and `destructive` policy levels are blocked at creation until the central policy engine exists.
