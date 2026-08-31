import assert from "node:assert/strict";
import { buildExecutiveCouncilBriefing } from "../councilBriefing.js";

const complete = buildExecutiveCouncilBriefing({
  recommendation: "Implementar o menor redesign primeiro.",
  confidence: "high",
  consensus: [
    { text: "Reduzir densidade da primeira dobra.", sources: ["Gemini", "Grok"] },
    { text: "Manter artefatos como detalhe.", sources: ["Codex"] }
  ],
  dissent: [
    { source: "Grok", text: "Adiar animacoes ate estabilizar layout." }
  ],
  risks: [
    { text: "Poluir ainda mais a tela se todos os detalhes ficarem abertos.", sources: ["Grok"] }
  ],
  unverified: [
    { text: "Validar no mobile real.", sources: ["Gemini"], reason: "open_question" }
  ],
  budget: { roundsUsed: 2 }
}, {
  steps: [
    "Criar briefing executivo.",
    "Separar artefatos como detalhe.",
    "Validar em desktop e mobile.",
    "Registrar evidencias."
  ]
});

assert.equal(complete.recommendation, "Implementar o menor redesign primeiro.");
assert.equal(complete.confidence.level, "high");
assert.equal(complete.facts.find((fact) => fact.label === "Divergencias").value, "1");
assert.match(complete.consensus[0].impact, /confirmado por 2 agentes/);
assert.match(complete.dissent[0].impact, /Grok/);
assert.equal(complete.nextActions.length, 3);
assert.match(complete.artifactHint, /secundaria/);

const partial = buildExecutiveCouncilBriefing({
  confidence: "low",
  risks: ["Sem evidencia suficiente para executar."]
});

assert.match(partial.recommendation, /Mitigar riscos/);
assert.equal(partial.confidence.label, "baixa");
assert.equal(partial.consensus[0].muted, true);
assert.equal(partial.dissent[0].muted, true);
assert.equal(partial.risks[0].text, "Sem evidencia suficiente para executar.");
assert.ok(partial.nextActions.some((item) => /Mitigar/.test(item) || /Criar implementacao/.test(item)));

console.log("Council briefing verification passed.");
