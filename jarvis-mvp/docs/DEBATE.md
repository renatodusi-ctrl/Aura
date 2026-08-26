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
- `implementation_requires.short_plan=true`;
- `implementation_requires.confirmation=true`.

## Rules

- Synthesis requires `mode=analyze` and `policyLevel=read`.
- Debate runs only when explicitly requested or when job metadata sets `debateAllowed=true`.
- The first synthesis uses one round by default.
- `maxRounds` is capped at `3`.
- Re-debate without new analyst evidence requires an explicit user request.
- Any later implementation must become a separate short plan and pass the confirmed implement flow.
