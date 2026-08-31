import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, listJobArtifacts, listJobEvents } from "../server/memory.js";
import {
  analystCircuitState,
  buildEvidenceBrief,
  cancelAnalystJobProcess,
  detectAnalyst,
  hasActiveAnalystJobProcess,
  healthCheckAnalyst,
  normalizeAnalystResponse,
  resetAnalystCircuit,
  runAnalysts
} from "../server/analystAdapter.js";

initMemory();

const jobIds = [];
const tempDirs = [];

try {
  const fakeGemini = createFakeAnalyst("gemini");
  const fakeGrok = createFakeAnalyst("grok");
  const fakeOpenRouter = createFakeAnalyst("openrouter");

  const geminiDetection = await detectAnalyst("gemini", { bin: fakeGemini });
  assert.equal(geminiDetection.available, true);
  assert.equal(geminiDetection.version, "gemini fake");

  const grokDetection = await detectAnalyst("grok", { bin: fakeGrok });
  assert.equal(grokDetection.available, true);
  assert.equal(grokDetection.version, "grok fake");

  const openRouterDetection = await detectAnalyst("openrouter", { bin: fakeOpenRouter });
  assert.equal(openRouterDetection.available, true);
  assert.equal(openRouterDetection.version, "openrouter fake");

  const normalized = normalizeAnalystResponse(JSON.stringify({
    findings: ["finding"],
    risks: ["risk"],
    open_questions: ["question"],
    recommendation: "ship it",
    confidence: "high"
  }));
  assert.deepEqual(normalized.findings, ["finding"]);
  assert.equal(normalized.confidence, "high");
  assert.equal(normalized.validSchema, true);

  const wrapped = normalizeAnalystResponse(JSON.stringify({
    text: "{\"findings\":[\"wrapped finding\"],\"risks\":[],\"open_questions\":[],\"recommendation\":\"wrapped\",\"confidence\":\"medium\"}",
    structuredOutput: {
      findings: ["structured finding"],
      risks: [],
      open_questions: [],
      recommendation: "structured",
      confidence: "medium"
    }
  }));
  assert.deepEqual(wrapped.findings, ["structured finding"]);
  assert.equal(wrapped.validSchema, true);

  const job = createJob({
    goal: "Verify shared analyst brief",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 5000
  });
  jobIds.push(job.id);

  const context = {
    constraints: ["Read-only analysis.", "Do not run Git commands."],
    files: ["server/analystAdapter.js"],
    focusTerms: ["buildEvidenceBrief"],
    findings: ["Adapters should normalize output."],
    attempted: ["Created job kernel."]
  };
  const brief = buildEvidenceBrief(job, context);
  assert.match(brief, /AURA Evidence Brief/);
  assert.match(brief, /server\/analystAdapter\.js/);
  assert.match(brief, /File Evidence/);
  assert.match(brief, /buildEvidenceBrief/);

  const largeEvidenceWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), "aura-large-evidence-"));
  tempDirs.push(largeEvidenceWorkspace);
  const largeEvidenceFile = path.join(largeEvidenceWorkspace, "large-app.js");
  fs.writeFileSync(largeEvidenceFile, [
    "x".repeat(9000),
    "function renderCouncilDecisionCard() { return 'decision'; }",
    "y".repeat(9000)
  ].join("\n"));
  const largeEvidenceJob = createJob({
    goal: "Verify large evidence excerpts",
    workspace: largeEvidenceWorkspace,
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 5000
  });
  jobIds.push(largeEvidenceJob.id);
  const largeBrief = buildEvidenceBrief(largeEvidenceJob, { files: ["large-app.js"] });
  assert.doesNotMatch(largeBrief, /file is too large/i);
  assert.match(largeBrief, /renderCouncilDecisionCard/);
  assert.match(largeBrief, /Excerpt selected by AURA evidence budget/);

  const output = await runAnalysts({
    jobId: job.id,
    context: { ...context, includeFileEvidence: false },
    consent: { gemini: true, grok: true, openrouter: true },
    bins: { gemini: fakeGemini, grok: fakeGrok, openrouter: fakeOpenRouter },
    timeoutMs: 5000,
    debateRounds: 2
  });

  assert.equal(output.job.status, "done");
  assert.equal(output.analysts.length, 6);
  assert.ok(output.analysts.every((entry) => entry.detection.usable === true));
  assert.ok(output.analysts.every((entry) => entry.response.findings.length));
  assert.ok(output.analysts.every((entry) => entry.response.confidence === "medium"));

  const artifacts = listJobArtifacts(job.id);
  assert.ok(artifacts.some((artifact) => artifact.kind === "evidence-brief" && artifact.content.includes("Verify shared analyst brief")));
  assert.ok(artifacts.some((artifact) => artifact.kind === "evidence-brief" && artifact.metadata.round === 2));
  assert.equal(artifacts.filter((artifact) => artifact.kind === "analyst-response").length, 6);
  assert.equal(artifacts.filter((artifact) => artifact.kind === "analyst-response" && artifact.metadata.round === 2).length, 3);

  const events = listJobEvents(job.id).map((event) => event.type);
  assert.ok(events.includes("analysts.consent"));
  assert.ok(events.includes("analyst.health_checked"));
  assert.ok(events.includes("analyst.started"));
  assert.ok(events.includes("analyst.finished"));
  assert.ok(events.includes("analyst.debate_round_started"));
  assert.ok(events.includes("analyst.debate_round_finished"));

  const blockedJob = createJob({
    goal: "Verify analyst consent gate",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(blockedJob.id);
  await assert.rejects(
    () => runAnalysts({ jobId: blockedJob.id, consent: {}, bins: { gemini: fakeGemini, grok: fakeGrok } }),
    /At least one analyst destination/
  );

  const missingJob = createJob({
    goal: "Verify missing analysts",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(missingJob.id);
  const missing = await runAnalysts({
    jobId: missingJob.id,
    consent: { gemini: true },
    bins: { gemini: "__aura_missing_gemini_binary__" },
    timeoutMs: 1000
  });
  assert.equal(missing.job.status, "needs_input");
  assert.match(missing.job.error, /Nenhum analista/i);
  assert.equal(missing.analysts[0].detection.available, false);
  assert.equal(missing.analysts[0].detection.usable, false);

  const recovered = await runAnalysts({
    jobId: missingJob.id,
    consent: { gemini: true },
    bins: { gemini: fakeGemini },
    timeoutMs: 5000
  });
  assert.equal(recovered.job.status, "done");
  assert.equal(recovered.analysts[0].detection.usable, true);

  resetAnalystCircuit("grok");
  const badGrok = createBadHealthAnalyst("grok");
  const badHealth = await healthCheckAnalyst("grok", { bin: badGrok, timeoutMs: 1000 });
  assert.equal(badHealth.usable, false);
  assert.equal(analystCircuitState("grok").open, true);
  const circuitHealth = await healthCheckAnalyst("grok", { bin: badGrok, timeoutMs: 1000 });
  assert.equal(circuitHealth.health, "circuit_open");
  assert.equal(circuitHealth.available, false);
  resetAnalystCircuit("grok");

  const hangingGemini = createHangingAnalyst("gemini");
  const cancelAnalystJob = createJob({
    goal: "Verify analyst cancel",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 5000
  });
  jobIds.push(cancelAnalystJob.id);
  const runningAnalyst = runAnalysts({
    jobId: cancelAnalystJob.id,
    consent: { gemini: true },
    bins: { gemini: hangingGemini },
    timeoutMs: 5000
  });
  await waitUntil(() => hasActiveAnalystJobProcess(cancelAnalystJob.id), 1500);
  assert.equal(cancelAnalystJobProcess(cancelAnalystJob.id), true);
  const cancelledAnalyst = await runningAnalyst;
  assert.equal(cancelledAnalyst.job.status, "cancelled");
  assert.equal(hasActiveAnalystJobProcess(cancelAnalystJob.id), false);
  assert.ok(listJobEvents(cancelAnalystJob.id).some((event) => event.type === "analyst.cancel_requested"));

  console.log("Analyst adapter verification passed.");
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

function createFakeAnalyst(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-fake-${name}-`));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);
  const payload = JSON.stringify({
    findings: [`${name} finding`],
    risks: [`${name} risk`],
    open_questions: [`${name} question`],
    recommendation: `${name} recommendation`,
    confidence: "medium"
  });

  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      `if "%1"=="--version" echo ${name} fake& exit /b 0`,
      `if "%1"=="-v" echo ${name} fake& exit /b 0`,
      "echo %* | findstr /C:\"approval-mode\" /C:\"permission-mode\" /C:\"no-plan\" /C:\"chat\" >nul",
      "if errorlevel 1 exit /b 2",
      `echo ${payload.replaceAll("\"", "\\\"")}`,
      "exit /b 0"
    ].join("\r\n"));
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ] || [ \"$1\" = \"-v\" ]; then",
      `  echo '${name} fake'`,
      "  exit 0",
      "fi",
      "printf '%s ' \"$@\" | grep -Eq 'approval-mode|permission-mode|no-plan|chat' || exit 2",
      `printf '%s\\n' '${payload}'`,
      "exit 0"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}

function createBadHealthAnalyst(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-bad-${name}-`));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);

  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      `if "%1"=="--version" echo ${name} fake& exit /b 0`,
      "echo not-json",
      "exit /b 0"
    ].join("\r\n"));
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ]; then",
      `  echo '${name} fake'`,
      "  exit 0",
      "fi",
      "echo not-json",
      "exit 0"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}

function createHangingAnalyst(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-hang-${name}-`));
  tempDirs.push(dir);
  const scriptPath = path.join(dir, process.platform === "win32" ? `${name}.cmd` : name);

  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      `if "%1"=="--version" echo ${name} fake& exit /b 0`,
      `"${process.execPath}" -e "setTimeout(() => {}, 10000)"`,
      "exit /b 0"
    ].join("\r\n"));
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ]; then",
      `  echo '${name} fake'`,
      "  exit 0",
      "fi",
      "node -e 'setTimeout(() => {}, 10000)'"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}
