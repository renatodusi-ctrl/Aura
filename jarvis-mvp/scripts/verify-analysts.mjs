import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, listJobArtifacts, listJobEvents } from "../server/memory.js";
import { buildEvidenceBrief, detectAnalyst, normalizeAnalystResponse, runAnalysts } from "../server/analystAdapter.js";

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
    findings: ["Adapters should normalize output."],
    attempted: ["Created job kernel."]
  };
  const brief = buildEvidenceBrief(job, context);
  assert.match(brief, /AURA Evidence Brief/);
  assert.match(brief, /server\/analystAdapter\.js/);

  const output = await runAnalysts({
    jobId: job.id,
    context,
    consent: { gemini: true, grok: true, openrouter: true },
    bins: { gemini: fakeGemini, grok: fakeGrok, openrouter: fakeOpenRouter },
    timeoutMs: 5000
  });

  assert.equal(output.job.status, "done");
  assert.equal(output.analysts.length, 3);
  assert.ok(output.analysts.every((entry) => entry.response.findings.length));
  assert.ok(output.analysts.every((entry) => entry.response.confidence === "medium"));

  const artifacts = listJobArtifacts(job.id);
  assert.ok(artifacts.some((artifact) => artifact.kind === "evidence-brief" && artifact.content.includes("Verify shared analyst brief")));
  assert.equal(artifacts.filter((artifact) => artifact.kind === "analyst-response").length, 3);

  const events = listJobEvents(job.id).map((event) => event.type);
  assert.ok(events.includes("analysts.consent"));
  assert.ok(events.includes("analyst.started"));
  assert.ok(events.includes("analyst.finished"));

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
  assert.equal(missing.job.status, "failed");
  assert.equal(missing.analysts[0].detection.available, false);

  console.log("Analyst adapter verification passed.");
} finally {
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
      "echo %* | findstr /C:\"approval-mode\" /C:\"permission-mode\" /C:\"code\" >nul",
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
      "printf '%s ' \"$@\" | grep -Eq 'approval-mode|permission-mode|code' || exit 2",
      `printf '%s\\n' '${payload}'`,
      "exit 0"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}
