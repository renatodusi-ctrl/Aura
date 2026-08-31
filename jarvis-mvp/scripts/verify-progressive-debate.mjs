import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, listJobArtifacts, listJobEvents } from "../server/memory.js";
import { synthesizeDebate } from "../server/debateSynthesizer.js";
import {
  debateQualitySignals,
  progressiveDebateDecision,
  resetAnalystCircuit,
  runAnalysts
} from "../server/analystAdapter.js";

initMemory();

const jobIds = [];
const tempDirs = [];

try {
  resetAnalystCircuit();

  const simple = entries([
    response("Ship the smallest safe change.", "high"),
    response("Ship the smallest safe change.", "high")
  ]);
  assert.equal(progressiveDebateDecision(simple, { round: 2, maxRounds: 3 }).run, false);
  assert.equal(debateQualitySignals(simple).hasDissent, false);

  const lowConfidence = entries([response("Proceed carefully.", "low")]);
  assert.equal(progressiveDebateDecision(lowConfidence, { round: 2, maxRounds: 3 }).run, true);
  assert.ok(progressiveDebateDecision(lowConfidence, { round: 2, maxRounds: 3 }).reasons.includes("low_confidence"));

  const dissent = entries([
    response("Implement now.", "high"),
    response("Do not implement yet.", "high")
  ]);
  assert.equal(progressiveDebateDecision(dissent, { round: 2, maxRounds: 3 }).run, true);
  assert.ok(progressiveDebateDecision(dissent, { round: 2, maxRounds: 3 }).reasons.includes("dissent"));

  const risky = entries([response("Proceed after review.", "medium", ["risk one", "risk two"])]);
  assert.equal(progressiveDebateDecision(risky, { round: 2, maxRounds: 3 }).run, true);
  assert.ok(progressiveDebateDecision(risky, { round: 2, maxRounds: 3 }).reasons.includes("decision_risk"));

  const simpleJob = createAnalyzeJob("Progressive simple council stops after one round");
  const simpleOutput = await runAnalysts({
    jobId: simpleJob.id,
    consent: { gemini: true, grok: true },
    bins: {
      gemini: createFakeAnalyst("gemini", response("Ship the smallest safe change.", "high")),
      grok: createFakeAnalyst("grok", response("Ship the smallest safe change.", "high"))
    },
    timeoutMs: 5000,
    debateRounds: 3,
    progressiveDebate: true
  });
  assert.equal(simpleOutput.job.status, "done");
  assert.equal(simpleOutput.analysts.filter((entry) => !entry.error).length, 2);
  assert.equal(simpleOutput.debateBudget.progressiveDecisions[0].run, false);
  const simpleSynthesis = synthesizeDebate({
    jobId: simpleJob.id,
    requested: true,
    budget: simpleOutput.debateBudget
  });
  assert.equal(simpleSynthesis.synthesis.budget.roundsUsed, 1);
  assert.equal(simpleSynthesis.synthesis.budget.followUpRounds, 0);
  assert.ok(simpleSynthesis.synthesis.rounds.some((round) => round.status === "skipped"));

  const dissentJob = createAnalyzeJob("Progressive dissent council opens second round");
  const dissentOutput = await runAnalysts({
    jobId: dissentJob.id,
    consent: { gemini: true, grok: true },
    bins: {
      gemini: createFakeAnalyst("gemini", response("Implement the HUD now.", "high")),
      grok: createFakeAnalyst("grok", response("Delay implementation until risks are reduced.", "high"))
    },
    timeoutMs: 6000,
    debateRounds: 2,
    progressiveDebate: true
  });
  assert.equal(dissentOutput.job.status, "done");
  assert.equal(dissentOutput.analysts.filter((entry) => !entry.error).length, 4);
  assert.equal(dissentOutput.debateBudget.progressiveDecisions[0].run, true);
  assert.ok(dissentOutput.debateBudget.progressiveDecisions[0].reasons.includes("dissent"));
  assert.ok(listJobEvents(dissentJob.id).some((event) => event.type === "analyst.debate_round_decision"));
  assert.ok(listJobArtifacts(dissentJob.id).some((artifact) => artifact.kind === "evidence-brief" && artifact.metadata?.progressiveDecision?.run === true));
  const dissentSynthesis = synthesizeDebate({
    jobId: dissentJob.id,
    requested: true,
    budget: dissentOutput.debateBudget
  });
  assert.equal(dissentSynthesis.synthesis.budget.roundsUsed, 2);
  assert.equal(dissentSynthesis.synthesis.budget.followUpRounds, 0);

  console.log("Progressive debate verification passed.");
} finally {
  resetAnalystCircuit();
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
  for (const dir of tempDirs) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
}

function createAnalyzeJob(goal) {
  const job = createJob({
    goal,
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 5000,
    metadata: { debateAllowed: true }
  });
  jobIds.push(job.id);
  return job;
}

function entries(responses) {
  return responses.map((item, index) => ({
    name: index === 0 ? "gemini" : "grok",
    response: item,
    error: null
  }));
}

function response(recommendation, confidence = "high", risks = [], openQuestions = []) {
  return {
    findings: ["shared finding"],
    risks,
    open_questions: openQuestions,
    recommendation,
    confidence
  };
}

function createFakeAnalyst(name, payload) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-progressive-${name}-`));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const serialized = JSON.stringify(payload);

  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      `if "%1"=="--version" echo ${name} fake& exit /b 0`,
      `if "%1"=="-v" echo ${name} fake& exit /b 0`,
      `echo ${serialized.replaceAll("\"", "\\\"")}`,
      "exit /b 0"
    ].join("\r\n"));
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"-v\" ]; then",
      `  echo '${name} fake'`,
      "  exit 0",
      "fi",
      `printf '%s\\n' '${serialized}'`
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}
