# Tools

Tools live in `server/tools.js`.

Tool confirmation is driven by the central policy model in `server/policy.js`.

## Safe by Default

- `memory.add`
- `tasks.add`
- `tasks.complete`
- `tasks.reopen`

## Confirmation Required

- `memory.delete`
- `tasks.delete`
- `screen.capture.intent`

## Next Work

Add JSON schemas for Realtime tool calls and a confirmation queue in the UI.
