# Testing

## Static Verification

```powershell
scripts\verify.ps1
```

This checks JavaScript syntax with Node.

## Manual Smoke Test

1. Run `scripts\run.ps1`.
2. Open `http://127.0.0.1:5173`.
3. Add a task.
4. Add a memory.
5. Send `bom dia` in the text composer.
6. Toggle routine on.
7. Try screen capture and stop it.
8. Add `OPENAI_API_KEY` to `.env`, restart, and test voice.

## Future Automation

- Add Playwright smoke tests.
- Add API tests for task/memory CRUD.
- Add Realtime event fixture tests.
