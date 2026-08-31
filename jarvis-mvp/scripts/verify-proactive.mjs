import assert from "node:assert/strict";
import { buildProactiveSuggestion, normalizeLedger, recordProactiveDecision } from "../proactive.js";

const context = {
  now: {
    activeJob: {
      id: 33,
      status: "needs_input",
      updatedAt: "2026-08-31T14:00:00Z"
    },
    blockers: ["Precisa de decisao humana."]
  },
  jobs: [],
  tasks: []
};

const first = buildProactiveSuggestion(context, {}, { nowMs: 1000 });
assert.ok(first);
assert.equal(first.event, "decision_needed");
assert.match(first.benefit, /Destrava/);
assert.match(first.costRisk, /retomar|escrita|contexto/i);

const shownLedger = recordProactiveDecision({}, first, "shown", { nowMs: 1000 });
const cooledDown = buildProactiveSuggestion(context, shownLedger, { nowMs: 1000 + 60_000 });
assert.equal(cooledDown, null);
const stillVisible = buildProactiveSuggestion(context, shownLedger, {
  nowMs: 1000 + 60_000,
  activeSignature: first.signature
});
assert.ok(stillVisible);

const afterCooldown = buildProactiveSuggestion(context, shownLedger, { nowMs: 1000 + 11 * 60_000 });
assert.ok(afterCooldown);

const dismissedLedger = recordProactiveDecision(shownLedger, first, "dismissed", { nowMs: 2000 });
const dismissed = buildProactiveSuggestion(context, dismissedLedger, { nowMs: 1000 + 60 * 60_000 });
assert.equal(dismissed, null);

const acceptedLedger = recordProactiveDecision({}, first, "accepted", { nowMs: 2000 });
const accepted = buildProactiveSuggestion(context, acceptedLedger, { nowMs: 1000 + 60 * 60_000 });
assert.equal(accepted, null);

const snoozedLedger = recordProactiveDecision({}, first, "snoozed", { nowMs: 1000, snoozeMs: 30_000 });
assert.equal(buildProactiveSuggestion(context, snoozedLedger, { nowMs: 20_000 }), null);
assert.ok(buildProactiveSuggestion(context, snoozedLedger, { nowMs: 1000 + 11 * 60_000 }));

const disabled = buildProactiveSuggestion(context, {}, { enabled: false, nowMs: 1000 });
assert.equal(disabled, null);

const taskSuggestion = buildProactiveSuggestion({
  now: {},
  jobs: [],
  tasks: [{ id: 7, title: "Validar fluxo de voz", status: "open" }]
}, normalizeLedger(), { nowMs: 1000 });
assert.equal(taskSuggestion.event, "task_opportunity");
assert.match(taskSuggestion.costRisk, /confirmacao/);

console.log("Proactive suggestion verification passed.");
