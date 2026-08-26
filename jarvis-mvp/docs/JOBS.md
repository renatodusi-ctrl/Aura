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

### `job_artifacts`

Persisted outputs attached to one job.

| Column | Purpose |
| --- | --- |
| `id` | Local artifact identifier. |
| `job_id` | Parent job. |
| `kind` | Artifact class such as `diff`, `test-log`, `codex-log` or `changed-files`. |
| `label` | User-facing artifact name. |
| `content` | Redacted artifact body. |
| `metadata` | JSON metadata such as command, args, exit code or file list. |
| `created_at` | Artifact timestamp. |

## Rules

- Jobs must exist before external CLIs run.
- Status transitions should append `job_events`.
- Artifacts should be persisted for diffs, test logs and generated executor summaries.
- New jobs start as `draft`.
- Terminal statuses `done`, `failed` and `cancelled` are final.
- `write` and `git` jobs lock their workspace until they reach `done`, `failed` or `cancelled`.
- `read` jobs can coexist in the same workspace.
- Voice may create jobs, but must not confirm sensitive actions by itself.
- CLI output persisted into job artifacts or events must be redacted before storage.
- Job policy decisions are defined in `docs/POLICY.md`.

## Local API

The job API is orchestration-only. It does not execute external CLIs.

| Route | Purpose |
| --- | --- |
| `GET /api/jobs?limit=50` | List recent jobs. |
| `POST /api/jobs` | Create a draft job. |
| `GET /api/jobs/:id` | Read one job with its events and artifacts. |
| `GET /api/jobs/:id/events` | Read a job timeline. |
| `POST /api/jobs/:id/cancel` | Cancel a non-terminal job. |
| `PATCH /api/jobs/:id` | Edit a draft job. |
| `POST /api/jobs/:id/approve` | Approve a draft into `queued` without execution. |
| `POST /api/routine/jobs` | Create a routine-owned `ask` or `analyze` draft. |
| `POST /api/jobs/:id/analysts/preview` | Preview the shared evidence brief for an analyze job. |
| `POST /api/jobs/:id/analysts/run` | Run approved Gemini/Grok read-only analysts. |
| `POST /api/jobs/:id/debate/synthesize` | Persist consensus, dissent, risks and unverified items from analyst artifacts. |

When a `write` or `git` job already exists in a non-terminal state for a workspace, creating another `write` or `git` job in that same workspace returns `409` with a `lockedBy` summary.

Process execution is owned by `server/supervisor.js`. The supervisor records process start, stdout, stderr, timeout, cancellation and finish events on the parent job.

Codex execution is owned by `server/codexAdapter.js`.

- `ask` accepts `mode=ask` and `policy_level=read`, runs `codex exec` with `--sandbox read-only`, and records detection, stdout, stderr, exit status and final message on the job timeline.
- `implement` accepts only `mode=implement`, `policy_level=write`, `status=awaiting_confirm` and an explicit confirmation payload. It runs `codex exec` with `--sandbox workspace-write`, blocks push/reset/destructive intent, and persists diff, changed files, Codex logs, final message and optional test logs as artifacts.

Gemini and Grok analyst execution is owned by `server/analystAdapter.js`. It accepts only `mode=analyze` and `policy_level=read` jobs, requires destination consent, sends the same evidence brief to each selected analyst in plan/read-only mode, and normalizes responses into `findings`, `risks`, `open_questions`, `recommendation` and `confidence`.

Debate synthesis is owned by `server/debateSynthesizer.js`. It reads normalized analyst artifacts, separates consensus from dissent and unverified items, caps rounds by budget, requires explicit request or policy allowance, and marks later implementation as requiring a short plan plus confirmation.

Routine draft suggestions are owned by `/api/routine/jobs`. They can create only `ask` or `analyze` jobs with `requested_by=routine`, `policy_level=read` and `status=draft`. Users can edit, approve into `queued`, or discard these drafts. Routine never starts implementation.

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

If `workspace` is omitted, AURA uses its local project directory. Policy behavior is defined in `docs/POLICY.md`.
