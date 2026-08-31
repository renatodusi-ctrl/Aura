# Memory

## Storage

SQLite database: `data/aura.sqlite`.

Tables:

- `memories`: local facts and notes.
- `tasks`: persistent task list.
- `tool_runs`: audit trail for local tools.

Short operational memory lives only in the Node.js process through `server/sessionMemory.js`.
It is not written to SQLite, clears on restart and is rehydrated only if a future explicit flow is created for that.

The short session keeps at most 12 timeline items:

- active demand id, mode, status and safe summary;
- latest Council decision and key risks;
- recent operator preference from text or voice;
- next safe action for `/api/now` and local voice/text continuity.

## Policy

Memory should be user-controlled. Store information when the user asks to remember it or when it clearly supports their personal workflow.

Operational session memory must be redacted before exposure. API keys, tokens, secrets, passwords and `.env` paths are replaced before the summary is returned by `/api/status`, `/api/now` or local chat.

Persistent memories are explicit and typed:

- `preference`: confirmed operator preferences that should survive restart.
- `project`: workspace or repository context the operator chose to keep.
- `decision`: decisions worth reusing later.
- `note`: general local note.

The cockpit lists persistent memories and lets the operator edit or delete them. `/api/now` returns a redacted `persistentMemory` summary, and Conselho evidence briefs cite confirmed memories when they influence analysis.

## Commands

Fallback examples:

- `guardar Rafael prefere respostas diretas`
- `guardar preferencia prefiro briefing executivo com proximas acoes`
- `guardar projeto Aura usa /Users/rdusi/Documents/Projetos/Pessoal/Aura`
- `lembrar comprar cafe`
- `tarefa revisar roadmap do AURA`
