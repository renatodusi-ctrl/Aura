import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, listJobArtifacts, listJobEvents } from "../server/memory.js";
import {
  analystCircuitState,
  cancelAnalystJobProcess,
  hasActiveAnalystJobProcess,
  resetAnalystCircuit,
  runAnalysts
} from "../server/analystAdapter.js";

initMemory();

const jobIds = [];
const tempDirs = [];

try {
  resetAnalystCircuit();

  const hangingGemini = createFakeAnalyst("gemini", "hang");
  const validGrok = createFakeAnalyst("grok", "valid");
  const slowOpenRouter = createFakeAnalyst("openrouter", "slow-valid");
  const degradedJob = createChaosJob("Chaos: one analyst hangs while others finish", 4500);
  const degradedStartedAt = Date.now();
  const degraded = await runAnalysts({
    jobId: degradedJob.id,
    consent: { gemini: true, grok: true, openrouter: true },
    bins: { gemini: hangingGemini, grok: validGrok, openrouter: slowOpenRouter },
    timeoutMs: degradedJob.timeoutMs
  });
  const degradedDurationMs = Date.now() - degradedStartedAt;
  assert.equal(degraded.job.status, "done");
  assert.ok(degradedDurationMs < 6500, `degraded council took ${degradedDurationMs}ms`);
  assert.ok(degraded.analysts.some((entry) => entry.name === "gemini" && entry.error));
  assert.ok(degraded.analysts.some((entry) => entry.name === "grok" && !entry.error));
  assert.ok(degraded.analysts.some((entry) => entry.name === "openrouter" && !entry.error));

  const degradedEvents = listJobEvents(degradedJob.id);
  assert.ok(degradedEvents.some((event) => event.type === "analyst.timed_out"));
  assert.ok(degradedEvents.some((event) => event.type === "analyst.completed"));
  const degradedTelemetry = telemetryArtifact(degradedJob.id);
  assert.equal(degradedTelemetry.degraded, true);
  assert.equal(degradedTelemetry.providers.some((provider) => provider.outcome === "timed_out"), true);
  assert.equal(analystCircuitState("gemini").open, true);

  resetAnalystCircuit("gemini");
  const invalidGemini = createFakeAnalyst("gemini", "invalid-analysis");
  const invalidJob = createChaosJob("Chaos: analyst returns invalid JSON", 3000);
  const invalid = await runAnalysts({
    jobId: invalidJob.id,
    consent: { gemini: true },
    bins: { gemini: invalidGemini },
    timeoutMs: invalidJob.timeoutMs
  });
  assert.equal(invalid.job.status, "needs_input");
  assert.ok(listJobEvents(invalidJob.id).some((event) => event.type === "analyst.failed"));
  assert.equal(analystCircuitState("gemini").open, true);

  resetAnalystCircuit("gemini");
  const failingGemini = createFakeAnalyst("gemini", "exit-analysis");
  const failingJob = createChaosJob("Chaos: analyst exits immediately", 3000);
  const failed = await runAnalysts({
    jobId: failingJob.id,
    consent: { gemini: true },
    bins: { gemini: failingGemini },
    timeoutMs: failingJob.timeoutMs
  });
  assert.equal(failed.job.status, "needs_input");
  assert.ok(listJobEvents(failingJob.id).some((event) => event.type === "analyst.failed"));

  resetAnalystCircuit("gemini");
  const cancellableGemini = createFakeAnalyst("gemini", "hang");
  const cancelJob = createChaosJob("Chaos: cancel analyst tree quickly", 8000);
  const startedAt = Date.now();
  const running = runAnalysts({
    jobId: cancelJob.id,
    consent: { gemini: true },
    bins: { gemini: cancellableGemini },
    timeoutMs: cancelJob.timeoutMs
  });
  await waitUntil(() => hasActiveAnalystJobProcess(cancelJob.id), 1500);
  assert.equal(cancelAnalystJobProcess(cancelJob.id), true);
  const cancelled = await running;
  const cancelDurationMs = Date.now() - startedAt;
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(hasActiveAnalystJobProcess(cancelJob.id), false);
  assert.ok(cancelDurationMs < 5000, `cancel took ${cancelDurationMs}ms`);
  const cancelEvents = listJobEvents(cancelJob.id);
  assert.ok(cancelEvents.some((event) => event.type === "analyst.cancel_requested"));
  assert.ok(cancelEvents.some((event) => event.type === "analyst.cancelled"));

  console.log("Analyst chaos verification passed.");
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

function createChaosJob(goal, timeoutMs) {
  const job = createJob({
    goal,
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs
  });
  jobIds.push(job.id);
  return job;
}

function telemetryArtifact(jobId) {
  const artifact = listJobArtifacts(jobId).find((item) => item.kind === "analyst-telemetry");
  assert.ok(artifact, "missing analyst telemetry artifact");
  return JSON.parse(artifact.content);
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for condition.");
}

function createFakeAnalyst(name, behavior) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-chaos-${name}-`));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const valid = JSON.stringify({
    findings: [`${name} survived chaos`],
    risks: [`${name} risk noted`],
    open_questions: [],
    recommendation: `${name} recommends degraded progress`,
    confidence: "medium"
  });

  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      `if "%1"=="--version" echo ${name} fake& exit /b 0`,
      `if "%1"=="-v" echo ${name} fake& exit /b 0`,
      `set "AURA_FAKE_PAYLOAD=${valid.replaceAll("\"", "\\\"")}"`,
      `set "AURA_FAKE_BEHAVIOR=${behavior}"`,
      `"${process.execPath}" "%~f0.js" %*`,
      "exit /b %errorlevel%"
    ].join("\r\n"));
    fs.writeFileSync(`${scriptPath}.js`, fakeNodeScript());
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"-v\" ]; then",
      `  echo '${name} fake'`,
      "  exit 0",
      "fi",
      `AURA_FAKE_PAYLOAD='${valid}' AURA_FAKE_BEHAVIOR='${behavior}' '${process.execPath}' '${scriptPath}.js' \"$@\"`
    ].join("\n"));
    fs.writeFileSync(`${scriptPath}.js`, fakeNodeScript());
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}

function fakeNodeScript() {
  return `
const fs = require("node:fs");
const behavior = process.env.AURA_FAKE_BEHAVIOR;
const payload = process.env.AURA_FAKE_PAYLOAD;
const args = process.argv.slice(2);
let prompt = args.join(" ");
const promptFileIndex = args.indexOf("--prompt-file");
if (promptFileIndex !== -1 && args[promptFileIndex + 1]) {
  prompt += "\\n" + fs.readFileSync(args[promptFileIndex + 1], "utf8");
}
const health = prompt.includes("health-check-ok");
if (behavior === "hang") {
  setTimeout(() => {}, 10000);
} else if (behavior === "slow-valid") {
  setTimeout(() => {
    console.log(payload);
  }, 250);
} else if (behavior === "invalid-analysis" && !health) {
  console.log("not-json");
} else if (behavior === "exit-analysis" && !health) {
  console.error("boom");
  process.exit(7);
} else {
  console.log(payload);
}
`.trimStart();
}
