# Voice Intents

AURA uses voice as a steering layer for jobs. Voice can request work, ask for status and cancel jobs. Voice does not confirm sensitive execution.

## Stable Intents

| Intent | Examples | Behavior |
| --- | --- | --- |
| `job.create` | `criar job revisar arquitetura`, `analisar logs`, `implementar ajuste pequeno` | Creates a persistent job with `requestedBy=voice`. |
| `job.status` | `status do job 12`, `listar jobs` | Reads one job or recent jobs. |
| `job.decision` | `qual a decisao da demanda 12`, `ler decisao do conselho` | Reads the latest `debate-synthesis` recommendation for one job or the latest job. |
| `job.blockers` | `bloqueios do job 12`, `riscos da demanda 12` | Reads critic risks, job errors and Conselho risks. |
| `job.next_step` | `proximo passo do job 12`, `o que fazer agora` | Speaks the safest next operator action for the job state. |
| `job.resume_read` | `retomar conselho da demanda 12 com novo contexto` | Prepares a read-only recovery instruction for an `analyze` job in `needs_input`; it does not call analysts by itself. |
| `job.cancel` | `cancelar job 12` | Cancels a non-terminal job or requests process cancellation. |

## Safety

- Voice never calls Codex, Gemini or Grok directly.
- Voice-created `implement` jobs use `policyLevel=write`, enter `awaiting_confirm`, and require cockpit confirmation.
- Voice-created `ask` and `analyze` jobs remain read-only by default.
- Voice cannot confirm `write`, `git`, `network`, `secrets` or `destructive` work.
- Voice can narrate decisions, blockers and next steps, but implementation still needs cockpit confirmation.
- Replies are short so they can be spoken through TTS.

When `OPENAI_API_KEY` is absent, the local fallback accepts the same text intents through the cockpit composer.
