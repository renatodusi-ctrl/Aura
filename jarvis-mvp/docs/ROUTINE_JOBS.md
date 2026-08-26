# Routine Jobs

The daily routine is opt-in and runs only while the cockpit is open.

## Draft Suggestions

Routine can create draft jobs through:

```text
POST /api/routine/jobs
```

Allowed modes:

- `ask`;
- `analyze`.

Routine cannot create `implement` jobs. Implementation work must be created by the user or voice intent and must still stop at visual confirmation.

Routine-created jobs use:

- `requestedBy=routine`;
- `policyLevel=read`;
- `status=draft`;
- metadata `routine.execution=manual`.

## User Control

In the cockpit the user can:

- edit the draft goal and mode;
- approve the draft into `queued`;
- discard the draft by cancelling it.

Approval does not execute Codex, Gemini or Grok. Execution remains a separate manual action.

## Retention and Export

The local status endpoint exposes:

- `jobHistoryRetentionDays`;
- `jobExportDir`.

Configure them with:

```text
JOB_HISTORY_RETENTION_DAYS=90
JOB_EXPORT_DIR=
```

Export automation is intentionally separate from routine execution.
