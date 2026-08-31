import assert from "node:assert/strict";
import { buildSpeakableNow, shouldNarrateNow } from "../nowNarration.js";

const baseNow = {
  activeJob: { id: 982 },
  jobRef: { id: 982 },
  actionId: "job.review_result",
  cta: { actionId: "job.review_result", label: "Revisar resultado" },
  nextStep: "Revise o resultado e feche a demanda se estiver tudo certo.",
  blockers: []
};

assert.equal(buildSpeakableNow({ ...baseNow, state: "idle" }), null);
assert.equal(buildSpeakableNow({ ...baseNow, state: "running" }), null);

const completed = buildSpeakableNow({ ...baseNow, state: "completed" });
assert.match(completed.text, /Demanda 982 concluida/);
assert.ok(sentenceCount(completed.text) <= 2);
assert.equal(shouldNarrateNow(completed, { spokenIds: new Set() }), true);
assert.equal(shouldNarrateNow(completed, { lastId: completed.id, spokenIds: new Set() }), false);
assert.equal(shouldNarrateNow(completed, { spokenIds: new Set([completed.id]) }), false);

const failed = buildSpeakableNow({
  ...baseNow,
  state: "failed",
  actionId: "job.review_failure",
  blockers: [{ message: "Process timed out after 300000ms. Veja os logs completos em detalhes tecnicos longos que nao devem ser lidos." }]
});
assert.match(failed.text, /falhou/i);
assert.match(failed.text, /Process timed out/);
assert.ok(sentenceCount(failed.text) <= 2);
assert.ok(failed.text.length <= 240);

const blocked = buildSpeakableNow({
  ...baseNow,
  state: "blocked",
  actionId: "job.approve_draft",
  blockers: [{ message: "Aguardando aprovacao visual." }]
});
assert.match(blocked.text, /precisa da sua decisao/i);
assert.match(blocked.text, /Aguardando aprovacao visual/);

const cancelled = buildSpeakableNow({ ...baseNow, state: "cancelled", actionId: "job.none" });
assert.match(cancelled.text, /foi cancelada/i);

console.log("Now narration verification passed.");

function sentenceCount(text) {
  return text.split(/[.!?]+/).map((part) => part.trim()).filter(Boolean).length;
}
