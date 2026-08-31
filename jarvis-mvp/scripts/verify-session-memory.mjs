import assert from "node:assert/strict";
import {
  rememberDecision,
  rememberJobEvent,
  rememberPreference,
  resetSessionMemoryForTests,
  sessionMemorySummary
} from "../server/sessionMemory.js";

resetSessionMemoryForTests();
let summary = sessionMemorySummary();
assert.equal(summary.activeJob, null);
assert.equal(summary.lastDecision, null);
assert.equal(summary.retention.clearsOnRestart, true);
assert.equal(summary.retention.rehydrate, "explicit-only");

summary = rememberJobEvent({
  id: 101,
  mode: "analyze",
  status: "needs_input",
  requestedBy: "voice",
  policyLevel: "read",
  goal: "Analisar layout do cockpit",
  summary: "Aguardando decisao do operador.",
  updatedAt: "2026-08-31T10:00:00.000Z"
}, "created");
assert.equal(summary.activeJob.id, 101);
assert.match(summary.nextAction, /Responder ao bloqueio/);

summary = rememberDecision({ id: 101 }, {
  recommendation: "Reduzir a primeira dobra antes de mexer nos artefatos.",
  confidence: "high",
  risks: [{ text: "Excesso de informacao em tela.", sources: ["Grok"] }],
  dissent: [{ text: "Adiar animacoes.", source: "Gemini" }]
});
assert.equal(summary.lastDecision.jobId, 101);
assert.match(summary.lastDecision.recommendation, /Reduzir/);
assert.equal(summary.lastDecision.risks.length, 1);

summary = rememberPreference("prefiro que a Aura priorize leitura rapida sem expor OPENAI_API_KEY=sk-proj-secret", "voice");
assert.equal(summary.recentPreference.source, "voice");
assert.doesNotMatch(summary.recentPreference.text, /sk-proj-secret/);
assert.match(summary.recentPreference.text, /OPENAI_API_KEY/);

for (let index = 0; index < 20; index += 1) {
  rememberJobEvent({
    id: 200 + index,
    mode: "ask",
    status: "done",
    requestedBy: "text",
    policyLevel: "read",
    goal: `Job ${index}`,
    summary: "ok",
    updatedAt: "2026-08-31T10:00:00.000Z"
  }, "completed");
}
summary = sessionMemorySummary();
assert.equal(summary.timeline.length, summary.retention.maxTimelineItems);

summary = resetSessionMemoryForTests();
assert.equal(summary.activeJob, null);
assert.equal(summary.timeline.length, 0);
assert.equal(summary.recentPreference, null);

console.log("Session memory verification passed.");
