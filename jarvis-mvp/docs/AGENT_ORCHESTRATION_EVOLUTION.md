# AURA Agent Orchestration Evolution

Date: 2026-08-26

## Purpose

This document defines the next evolution of AURA: from a local voice cockpit into a local Jarvis-style agent orchestrator.

The goal is not to make AURA a voice shortcut for terminal commands. The goal is to make AURA the conductor:

- understand user intent by voice or text;
- keep an ongoing assistant conversation;
- create visible, persistent jobs;
- use Codex CLI as the primary executor for code/project/Git work;
- consult Gemini CLI and Grok CLI as read-only external analysts;
- synthesize debates with evidence, dissent and risk;
- require explicit confirmation before sensitive actions.

## Current Baseline

AURA currently has:

- local Node.js 22 server at `http://127.0.0.1:5173`;
- browser cockpit UI;
- OpenAI Realtime/WebRTC voice scaffold;
- local fallback without `OPENAI_API_KEY`;
- SQLite local memory and tasks via `node:sqlite`;
- safe and confirmed tools;
- opt-in screen capture;
- opt-in routine while the cockpit is open;
- project docs, ADRs and Windows scripts.

Local CLI availability checked on 2026-08-26:

- Codex CLI: `0.149.1`;
- Gemini CLI: `0.57.0`;
- Grok CLI: `1.0.5`.

## Product Direction

AURA should evolve into a local command center with four roles.

| Role | Component | Responsibility | Can Write Project Files? | Speaks to User? |
| --- | --- | --- | --- | --- |
| Conductor | AURA | Conversation, intent, memory, job state, policy, synthesis | No, except AURA's own SQLite state | Yes |
| Executor | Codex CLI | Code/project/Git work after approval | Yes, within pinned workspace and policy | No direct user conversation |
| Analysts | Gemini CLI, Grok CLI | Independent read-only review and alternatives | No | No direct user conversation |
| Critic | AURA rules plus optional model review | Compare outputs, diffs and tests against the accepted plan | No | Through AURA synthesis |

Rule: only one writer per job. Analysts never execute project changes.

## Architecture Target

```text
Voice/Text UI
  -> Intent Parser
  -> Policy Engine
  -> Job Orchestrator
       -> Planner
       -> Codex Adapter
       -> Gemini Adapter
       -> Grok Adapter
       -> Debate Synthesizer
       -> Critic
  -> SQLite Job Store
  -> Cockpit Timeline + TTS Status
```

## Job Contract

Every user demand should become a persistent job.

Minimum job fields:

- `id`;
- `goal`;
- `workspace`;
- `mode`: `ask`, `analyze`, `implement`;
- `status`: `draft`, `awaiting_confirm`, `queued`, `running`, `needs_input`, `done`, `failed`, `cancelled`;
- `requested_by`: `voice`, `text`, `routine`;
- `policy_level`: `read`, `write`, `git`, `network`, `secrets`, `destructive`;
- `requires_confirmation`;
- `timeout_ms`;
- `created_at`, `started_at`, `finished_at`;
- `error`;
- `summary`.

Related tables:

- `job_events`: append-only log for UI timeline and audit;
- `agent_runs`: one row per CLI invocation;
- `agent_messages`: normalized analyst/executor output;
- `approvals`: explicit approval records;
- `artifacts`: diffs, test logs, generated files, exported briefs.

The initial implemented schema is documented in `docs/JOBS.md`.

## Policy Model

The current per-tool confirmation model should become a central policy engine.

Sensitivity levels:

- `read`: allowed without confirmation;
- `write`: UI confirmation required;
- `git`: UI confirmation required;
- `network`: UI confirmation required;
- `secrets`: deny or require typed confirmation;
- `destructive`: typed confirmation required.

Voice may create, cancel or request status for jobs. Voice must not confirm sensitive actions by itself.

Examples:

- Codex `ask`: `read`;
- Codex `implement`: `write`;
- `git commit`: `git`;
- `git push`: out of scope until later phase;
- screen capture sent to an external model: explicit per-destination opt-in;
- routine-created implementation job: must stop at `awaiting_confirm`.

## Debate Protocol

Debate should happen only when it adds value:

- user explicitly asks for debate;
- job mode is `analyze`;
- Codex fails or reports uncertainty;
- a diff needs external critique.

Protocol:

1. AURA creates one evidence brief with objective, constraints, relevant files, current findings and what was already attempted.
2. Gemini CLI and Grok CLI receive the same brief.
3. Both analysts must answer the same schema:
   - `findings`;
   - `risks`;
   - `open_questions`;
   - `recommendation`;
   - `confidence`.
4. AURA synthesizes:
   - consensus;
   - disagreements;
   - unverified claims;
   - recommended next action.
5. If implementation is needed, AURA asks the user to approve a short plan.
6. Codex executes the approved plan.
7. AURA or a critic pass compares evidence, diff and tests against the approved plan.

Anti-pattern: sending the same task to three CLIs as writers and voting on the result.

## CLI Adapter Requirements

All CLI integrations should be implemented behind adapters, never direct route handlers.

Each adapter should provide:

- binary discovery and version check;
- fixed working directory;
- filtered environment;
- timeout;
- stdout/stderr capture;
- exit code capture;
- cancellation using a process group;
- transcript persistence;
- redaction before persistence;
- schema normalization;
- clear failure modes.

Initial commands:

- Codex: `codex exec --cd <workspace> --sandbox read-only ...` for `ask`;
- Gemini: `gemini -p <prompt> --approval-mode plan ...` for read-only analysis;
- Grok: `grok -p <prompt> --permission-mode plan ...` for read-only analysis.

The exact command line should be owned by the adapter and covered by smoke tests.

## Security and Privacy Requirements

AURA must remain honest about what leaves the machine.

Required controls:

- origin check and local session token for local API calls;
- no model/tool invocation directly from raw Realtime transcript;
- redaction for `.env`, tokens, secrets and known sensitive paths;
- never persist complete secret-bearing stdout;
- no screenshot fan-out without explicit destination approval;
- no Git push, reset or destructive command in early phases;
- workspace lock to prevent multiple writers in the same repo;
- visible job status, cancellation and audit trail;
- "CLI unavailable" must fail safely.

## Phased Backlog

### Phase 0 - Job Kernel

Goal: make AURA tell the truth about work.

- Add SQLite job tables.
- Add job timeline UI.
- Add workspace lock.
- Add process supervisor abstraction.
- Add cancellation.
- Add central policy engine.
- Add local API origin/session protection.

### Phase 1 - Codex Executor

Goal: one demand can become one controlled Codex job.

- Add Codex adapter in `ask` mode first.
- Add read-only job execution with logs.
- Add UI for job submission/status/cancel.
- Add `implement` as confirmed-only.
- Capture Codex transcript, exit code and summary.
- Keep Git push/reset out of scope.

### Phase 2 - Read-Only Analysts

Goal: add Gemini and Grok as consultants, not writers.

- Add Gemini adapter.
- Add Grok adapter.
- Add shared evidence brief format.
- Add normalized analyst response schema.
- Add redaction and prompt preview.
- Add per-destination consent for sending context.

### Phase 3 - Debate and Synthesis

Goal: make debate operational instead of theatrical.

- Add debate jobs.
- Add consensus/dissent synthesis.
- Add confidence and "not verified" fields.
- Add critic pass for diffs and test logs.
- Limit debate rounds by budget.

### Phase 4 - Voice Conductor

Goal: use voice for intent, status and cancellation.

- Add stable voice intents.
- Add push-to-talk mode.
- Add TTS progress summaries.
- Prevent voice-only confirmation for sensitive jobs.
- Improve local fallback degradation.

### Phase 5 - Limited Autonomy

Goal: routine can suggest work, not execute silently.

- Routine can create draft jobs.
- Routine can request analysis jobs.
- Implementation remains confirmation-gated.
- Add retention/export settings for job history.

## Next Sprint Proposal

Scope: Phase 0 plus a thin slice of Phase 1.

Deliverables:

- `jobs` SQLite schema;
- `job_events` SQLite schema;
- job API: create, list, get, cancel;
- job timeline in cockpit;
- process supervisor with timeout/cancel;
- Codex adapter in read-only `ask` mode;
- central policy engine for job sensitivity;
- origin/session protection for local APIs;
- smoke tests for missing CLI, timeout and cancellation.

Out of scope:

- Gemini/Grok debate execution;
- Git push/reset;
- voice-only confirmation;
- routine-triggered implementation;
- screenshot sent to external models.

## Acceptance Criteria

The next sprint is accepted when:

- a user can submit a text demand and see a persistent job;
- the job survives browser refresh;
- the job can run Codex CLI in read-only `ask` mode;
- stdout/stderr, exit code and status are persisted;
- a job can be cancelled;
- two writer jobs cannot run in the same workspace;
- any write mode stops at `awaiting_confirm`;
- missing CLI creates a clear `failed` job;
- timeout kills the process and releases the lock;
- local API rejects unexpected origins;
- the cockpit clearly shows whether a job may write files or send context to a cloud CLI.

## Grok CLI Review

Grok CLI was used as an external architecture reviewer on 2026-08-26 in read-only planning mode:

```text
grok -p <review prompt> --permission-mode plan --disable-web-search --no-subagents --max-turns 1 --output-format plain
```

Key conclusions from Grok:

- The direction is strong, but the next sprint must not try to deliver the full Jarvis vision.
- The highest risk is losing the control contract: who decides, who executes and what is reversible.
- AURA should not become "a chat that fires CLIs".
- CLI integrations must be treated as subprocess adapters with contracts, schemas, budgets, logs and rollback strategy.
- Debate without shared evidence is expensive theater.
- Only Codex should be the writer at first; Gemini and Grok should remain read-only analysts.
- Voice is good for intent and status, but unsafe for irreversible confirmation.
- The system needs a job kernel, workspace locks, cancellation and policy before multi-agent debate.
- AURA must explicitly show what is running, where it is running, whether it can write files and what context leaves the machine.

Most important Grok quote:

> A AURA que vale a pena nao e a que fala melhor. E a que nao executa o que o usuario nao viu.

## Final Recommendation

Build in this order:

1. Truthful job kernel.
2. Single controlled writer through Codex CLI.
3. Read-only external analysts.
4. Evidence-based debate.
5. Voice as the conductor.
6. Limited routine autonomy.

This keeps the Jarvis ambition alive while preserving user control, privacy and project safety.
