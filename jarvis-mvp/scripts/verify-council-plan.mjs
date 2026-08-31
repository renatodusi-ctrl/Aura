import assert from "node:assert/strict";
import {
  buildCouncilImplementationPlan,
  implementationEvidenceFromArtifacts,
  implementationGoalFromPlan,
  inferLikelyFiles
} from "../councilPlan.js";

const sourceJob = {
  id: 29,
  goal: "Revisar o cockpit, a tela, o Conselho de IAs e o dashboard de custos."
};

const synthesis = {
  recommendation: "Criar uma etapa confirmavel entre a decisao do Conselho e a execucao pelo Codex.",
  confidence: "medium",
  consensus: [
    { text: "O usuario precisa ver plano, escopo e verificacao antes da escrita." }
  ],
  risks: [
    { text: "Executar sem listar arquivos pode ampliar o escopo sem consentimento." }
  ],
  unverified: [
    { text: "Validar no browser depois de criar a demanda de implementacao." }
  ]
};

const inferred = inferLikelyFiles(`${sourceJob.goal}\n${synthesis.recommendation}`);
assert.ok(inferred.includes("app.js"));
assert.ok(inferred.includes("styles.css"));

const plan = buildCouncilImplementationPlan(sourceJob, synthesis);
assert.equal(plan.source, "council-decision");
assert.equal(plan.sourceJobId, sourceJob.id);
assert.equal(plan.generatedFrom, "debate-synthesis");
assert.ok(plan.steps.length >= 3);
assert.ok(plan.likelyFiles.includes("app.js"));
assert.ok(plan.verification.includes("npm run verify"));
assert.ok(plan.reviewOptions.includes("Pedir segunda opiniao"));

const goal = implementationGoalFromPlan(sourceJob, plan);
assert.match(goal, /Passos:/);
assert.match(goal, /Arquivos provaveis:/);
assert.match(goal, /Verificacoes esperadas:/);
assert.match(goal, /npm run verify/);

const evidence = implementationEvidenceFromArtifacts({
  id: 91,
  mode: "implement",
  status: "done",
  metadata: {
    source: "council-decision",
    sourceJobId: 29
  }
}, [
  {
    kind: "changed-files",
    content: "app.js\nstyles.css",
    metadata: { files: ["app.js", "styles.css"] }
  },
  {
    kind: "test-log",
    label: "Test log",
    content: "ok",
    metadata: { command: "npm", args: ["run", "verify"], exitCode: 0 }
  },
  {
    kind: "codex-summary",
    content: "Implementacao concluida e validada."
  }
]);

assert.equal(evidence.sourceJobId, 29);
assert.deepEqual(evidence.changedFiles, ["app.js", "styles.css"]);
assert.equal(evidence.tests[0].command, "npm run verify");
assert.equal(evidence.tests[0].status, "passou");
assert.match(evidence.outcome, /Concluido/);
assert.match(evidence.resumePath, /decisao original/);

console.log("Council plan verification passed.");
