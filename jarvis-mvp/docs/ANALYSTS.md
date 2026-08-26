# Analyst Adapters

Gemini and Grok are read-only external analysts for AURA jobs.

## Evidence Brief

Both analysts receive the same evidence brief:

- job id, objective, workspace, mode and policy;
- constraints;
- relevant files;
- current findings;
- already attempted work;
- required response schema.

The required response schema is:

```json
{
  "findings": [],
  "risks": [],
  "open_questions": [],
  "recommendation": "",
  "confidence": "low"
}
```

`confidence` should be `low`, `medium` or `high`.

## Execution

```text
POST /api/jobs/:id/analysts/preview
POST /api/jobs/:id/analysts/run
```

Run payload:

```json
{
  "consent": {
    "gemini": true,
    "grok": true
  },
  "context": {
    "constraints": ["Read-only analysis."],
    "files": ["server/analystAdapter.js"],
    "findings": [],
    "attempted": []
  }
}
```

Gemini runs with `--approval-mode plan`.

Grok runs with `--permission-mode plan`, `--disable-web-search`, `--no-subagents` and `--max-turns 1`.

The adapter records the shared evidence brief and each analyst response as job artifacts.

## Safety

- Analyst jobs require `mode=analyze` and `policyLevel=read`.
- AURA requires explicit destination consent before sending the brief.
- Analysts are instructed not to edit files, run Git, create commits, push changes, install packages or execute destructive commands.
- Gemini and Grok remain consultants. Codex is the only writer in the current architecture.
