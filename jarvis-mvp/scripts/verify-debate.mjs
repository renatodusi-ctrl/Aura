import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../server/config.js";
import { createJob, createJobArtifact, initMemory, listJobArtifacts } from "../server/memory.js";
import { synthesizeDebate } from "../server/debateSynthesizer.js";

initMemory();

const jobIds = [];

try {
  const job = createJob({
    goal: "Verify debate synthesis",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 1000,
    metadata: { debateAllowed: true }
  });
  jobIds.push(job.id);

  createAnalystArtifact(job.id, "gemini", {
    findings: ["Use a shared brief.", "Keep analysts read-only."],
    risks: ["Brief may omit evidence."],
    open_questions: ["Which files matter most?"],
    recommendation: "Proceed with a small implementation plan.",
    confidence: "medium"
  });
  createAnalystArtifact(job.id, "grok", {
    findings: ["Use a shared brief.", "Expose dissent."],
    risks: ["Brief may omit evidence.", "Consensus can hide uncertainty."],
    open_questions: ["What changed since last run?"],
    recommendation: "Review dissent before implementing.",
    confidence: "low"
  });

  const output = synthesizeDebate({ jobId: job.id, budget: { maxRounds: 99 } });
  assert.equal(output.job.status, "draft");
  assert.equal(output.synthesis.budget.maxRounds, 3);
  assert.equal(output.synthesis.budget.roundsUsed, 1);
  assert.ok(output.synthesis.consensus.some((item) => item.text === "Use a shared brief."));
  assert.ok(output.synthesis.dissent.length >= 2);
  assert.ok(output.synthesis.risks.some((item) => item.text === "Brief may omit evidence."));
  assert.ok(output.synthesis.unverified.some((item) => item.text === "Keep analysts read-only."));
  assert.ok(output.synthesis.unverified.some((item) => item.reason === "open_question"));
  assert.equal(output.synthesis.implementation_requires.short_plan, true);
  assert.equal(output.synthesis.implementation_requires.confirmation, true);

  const artifacts = listJobArtifacts(job.id);
  assert.ok(artifacts.some((artifact) => artifact.kind === "debate-synthesis" && artifact.content.includes("consensus")));

  assert.throws(
    () => synthesizeDebate({ jobId: job.id }),
    /Re-debate requires new evidence/
  );

  const explicit = synthesizeDebate({ jobId: job.id, requested: true, budget: { maxRounds: 1 } });
  assert.equal(explicit.synthesis.budget.maxRounds, 1);

  const blocked = createJob({
    goal: "Verify debate request gate",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(blocked.id);
  createAnalystArtifact(blocked.id, "gemini", {
    findings: ["Single finding"],
    risks: [],
    open_questions: [],
    recommendation: "No action.",
    confidence: "low"
  });
  assert.throws(
    () => synthesizeDebate({ jobId: blocked.id }),
    /explicit request or policy allowance/
  );

  console.log("Debate synthesis verification passed.");
} finally {
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
}

function createAnalystArtifact(jobId, name, normalized) {
  return createJobArtifact(jobId, {
    kind: "analyst-response",
    label: `${name} response`,
    content: JSON.stringify(normalized),
    metadata: { name, normalized }
  });
}
