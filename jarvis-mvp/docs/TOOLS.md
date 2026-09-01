# Tools

Tools live in `server/tools.js`.

Tool confirmation is driven by the central policy model in `server/policy.js`.

## Safe by Default

- `memory.add`
- `tasks.add`
- `tasks.complete`
- `tasks.reopen`
- `terminal.diagnostics`

`terminal.diagnostics` accepts only an allowlisted diagnostic ID. It is intended for CLI configuration checks and returns redacted output.

## Confirmation Required

- `memory.delete`
- `tasks.delete`
- `screen.capture.intent`

## Next Work

Add JSON schemas for Realtime tool calls and a confirmation queue in the UI.
