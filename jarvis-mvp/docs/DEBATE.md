# Debate Synthesis

AURA debate synthesis turns analyst artifacts into an honest summary. It does not vote blindly and it does not erase dissent.

## Input

The synthesizer reads `analyst-response` artifacts from an `analyze` job. Each response should already be normalized into:

- `findings`;
- `risks`;
- `open_questions`;
- `recommendation`;
- `confidence`.

## Output

The synthesis is persisted as a `debate-synthesis` artifact with:

- `consensus`: findings reported by more than one source;
- `dissent`: different analyst recommendations;
- `risks`: risk items with source attribution;
- `unverified`: single-source findings and open questions;
- `recommendation`;
- `confidence`;
- `budget`;
- `rounds`: the executed initial analysis plus any planned follow-up dissent review;
- `implementation_requires.short_plan=true`;
- `implementation_requires.confirmation=true`.

## Rules

- Synthesis requires `mode=analyze` and `policyLevel=read`.
- Debate runs only when explicitly requested or when job metadata sets `debateAllowed=true`.
- The cockpit treats a successful Conselho run as an explicit user-facing synthesis request when the user clicked `Consultar conselho`.
- The cockpit exposes a `Rodadas do Conselho` control so the operator can request one, two, or three read-only rounds before synthesis.
- The first synthesis executes one round by default.
- If `analysts/run` receives a larger `budget.maxRounds` with `explicitMultiRound=true`, AURA re-prompts usable analysts in read-only dissent-review rounds and persists those responses with `round=2` or `round=3`.
- If an API caller requests extra rounds without explicit operator intent, AURA caps the execution to one round and records the effective budget honestly.
- If synthesis sees unused budget without matching analyst response artifacts, it records planned follow-up rounds honestly instead of pretending analysts were re-prompted.
- `maxRounds` is capped at `3`.
- Re-debate without new analyst evidence requires an explicit user request.
- Any later implementation must become a separate short plan and pass the confirmed implement flow.
