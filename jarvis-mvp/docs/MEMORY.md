# Memory

## Storage

SQLite database: `data/aura.sqlite`.

Tables:

- `memories`: local facts and notes.
- `tasks`: persistent task list.
- `tool_runs`: audit trail for local tools.

## Policy

Memory should be user-controlled. Store information when the user asks to remember it or when it clearly supports their personal workflow.

## Commands

Fallback examples:

- `guardar Rafael prefere respostas diretas`
- `lembrar comprar cafe`
- `tarefa revisar roadmap do AURA`
