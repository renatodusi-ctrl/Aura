# Analyst Adapters

Gemini, Grok and OpenRouter are read-only external analysts for AURA jobs.

## Evidence Brief

Both analysts receive the same evidence brief:

- job id, objective, workspace, mode and policy;
- constraints;
- relevant files;
- bounded, redacted file evidence when requested;
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
    "grok": true,
    "openrouter": false
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

Grok runs with `--prompt-file`, `--no-alt-screen`, `--no-plan`, `--disable-web-search`, `--no-subagents`, `--output-format json`, `--json-schema` and `--max-turns` from `AURA_GROK_MAX_TURNS` or `8`.

OpenRouter runs through `openrouter chat --no-stream --output json`.

Before the real brief is dispatched, each selected analyst must pass a short JSON health-check. The adapter records the shared evidence brief, health-check events and each analyst response as job artifacts. Health-check failures open a short in-memory circuit breaker so AURA does not keep calling a provider that just failed. A successful Conselho run can then be synthesized into a `debate-synthesis` artifact for a visible recommendation.

## Safety

- Analyst jobs require `mode=analyze` and `policyLevel=read`.
- AURA requires explicit destination consent before sending the brief.
- Analysts are instructed not to edit files, run Git, create commits, push changes, install packages or execute destructive commands.
- Gemini, Grok and OpenRouter remain consultants. Codex is the only writer in the current architecture.
- Running analyst processes are tracked per job. `POST /api/jobs/:id/cancel` cancels active analyst processes and kills their child process tree before the job reaches `cancelled`.
