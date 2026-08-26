import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, getJob, initMemory, listJobEvents, updateJobStatus } from "../server/memory.js";
import { detectCodex, runCodexAsk } from "../server/codexAdapter.js";

initMemory();

const jobIds = [];
const tempDirs = [];

try {
  const fakeCodex = createFakeCodex();
  const fakeDetected = await detectCodex({ bin: fakeCodex });
  assert.equal(fakeDetected.available, true);
  assert.equal(fakeDetected.version, "codex-cli fake");

  const detected = await detectCodex();
  assert.equal(typeof detected.available, "boolean");
  assert.equal(typeof detected.bin, "string");

  const missingJob = createJob({
    goal: "Verify missing Codex path",
    workspace: process.cwd(),
    mode: "ask",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(missingJob.id);

  const missing = await runCodexAsk({
    jobId: missingJob.id,
    prompt: "This should not run.",
    bin: "__aura_missing_codex_binary__",
    timeoutMs: 1000
  });
  assert.equal(missing.codex.available, false);
  assert.equal(missing.job.status, "failed");
  assert.match(getJob(missingJob.id).summary, /unavailable/i);
  assert.ok(listJobEvents(missingJob.id).some((event) => event.type === "codex.detected"));

  const fakeAskJob = createJob({
    goal: "Verify fake Codex ask",
    workspace: process.cwd(),
    mode: "ask",
    policyLevel: "read",
    timeoutMs: 5000
  });
  jobIds.push(fakeAskJob.id);
  const fakeAsk = await runCodexAsk({
    jobId: fakeAskJob.id,
    prompt: "Fake ask prompt",
    bin: fakeCodex,
    timeoutMs: 5000
  });
  assert.equal(fakeAsk.result.exitCode, 0);
  assert.equal(fakeAsk.job.status, "done");
  assert.match(fakeAsk.result.stdout, /--sandbox read-only/);
  assert.match(fakeAsk.result.stdout, / -\s*$/);
  assert.equal(fakeAsk.result.lastMessage, "FAKE_CODEX_LAST_MESSAGE");
  const fakeEvents = listJobEvents(fakeAskJob.id).map((event) => event.type);
  assert.ok(fakeEvents.includes("codex.ask.started"));
  assert.ok(fakeEvents.includes("codex.ask.summary"));

  const wrongModeJob = createJob({
    goal: "Verify wrong Codex mode",
    workspace: process.cwd(),
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true,
    timeoutMs: 1000
  });
  jobIds.push(wrongModeJob.id);
  await assert.rejects(
    () => runCodexAsk({ jobId: wrongModeJob.id, bin: fakeCodex }),
    /Codex ask requires a job with mode=ask/
  );

  const wrongStatusJob = createJob({
    goal: "Verify wrong Codex status",
    workspace: process.cwd(),
    mode: "ask",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(wrongStatusJob.id);
  updateJobStatus(wrongStatusJob.id, "cancelled", { summary: "Wrong status fixture." });
  await assert.rejects(
    () => runCodexAsk({ jobId: wrongStatusJob.id, bin: fakeCodex }),
    /Codex ask cannot run while job status is cancelled/
  );

  if (detected.available && process.env.AURA_VERIFY_CODEX_REAL === "1") {
    const askJob = createJob({
      goal: "Say exactly: AURA-CODEX-VERIFY",
      workspace: process.cwd(),
      mode: "ask",
      policyLevel: "read",
      timeoutMs: 120000
    });
    jobIds.push(askJob.id);

    const result = await runCodexAsk({
      jobId: askJob.id,
      prompt: "Say exactly: AURA-CODEX-VERIFY",
      timeoutMs: 120000
    });
    assert.equal(result.codex.available, true);
    assert.ok(["done", "failed"].includes(result.job.status));
    assert.ok(listJobEvents(askJob.id).some((event) => event.type === "codex.ask.started"));
  }

  console.log("Codex adapter verification passed.");
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

function createFakeCodex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-fake-codex-"));
  tempDirs.push(dir);

  const scriptPath = path.join(dir, process.platform === "win32" ? "codex.cmd" : "codex");
  if (process.platform === "win32") {
    fs.writeFileSync(scriptPath, [
      "@echo off",
      "if \"%1\"==\"--version\" echo codex-cli fake& exit /b 0",
      "echo %*",
      ":loop",
      "if \"%1\"==\"--output-last-message\" (",
      "  echo FAKE_CODEX_LAST_MESSAGE>%2",
      "  exit /b 0",
      ")",
      "shift",
      "if not \"%1\"==\"\" goto loop",
      "exit /b 0"
    ].join("\r\n"));
  } else {
    fs.writeFileSync(scriptPath, [
      "#!/usr/bin/env sh",
      "if [ \"$1\" = \"--version\" ]; then",
      "  echo 'codex-cli fake'",
      "  exit 0",
      "fi",
      "printf '%s ' \"$@\"",
      "printf '\\n'",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = \"--output-last-message\" ]; then",
      "    printf 'FAKE_CODEX_LAST_MESSAGE\\n' > \"$2\"",
      "    exit 0",
      "  fi",
      "  shift",
      "done",
      "exit 0"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}
