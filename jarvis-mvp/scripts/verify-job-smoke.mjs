import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, updateJobStatus } from "../server/memory.js";
import { runJobCommand } from "../server/supervisor.js";

const root = path.resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const port = await freePort();
const base = `http://${host}:${port}`;
const jobIds = [];
const tempDirs = [];
let serverProcess;

initMemory();

try {
  serverProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: {
      ...process.env,
      HOST: host,
      PORT: String(port)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  serverProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  await waitForServer(base, stderr);

  const rejectedOrigin = await fetch(`${base}/api/session`, {
    headers: { Origin: "https://evil.example" }
  });
  assert.equal(rejectedOrigin.status, 403);

  const protectedWithoutToken = await fetch(`${base}/api/jobs`);
  assert.equal(protectedWithoutToken.status, 401);

  const token = (await json(await fetch(`${base}/api/session`))).token;
  assert.ok(token);
  const headers = {
    "Content-Type": "application/json",
    "X-AURA-Session": token
  };

  const now = await request("/api/now", { headers });
  assert.equal(now.status, 200);
  assert.ok(now.data.now.nextStep);
  assert.ok(now.data.now.realtime);
  assert.ok(now.data.now.actionId);
  assert.ok(now.data.now.source);
  assert.ok(["high", "medium", "low"].includes(now.data.now.confidence));
  assert.ok(["info", "notice", "active", "warning", "success", "critical", "muted"].includes(now.data.now.severity));
  assert.ok(["idle", "running", "blocked", "failed", "cancelled", "completed"].includes(now.data.now.state));
  assert.equal(now.data.now.cta.actionId, now.data.now.actionId);

  const created = await request("/api/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke create and list job",
      workspace: root,
      mode: "ask",
      policyLevel: "read"
    }
  });
  assert.equal(created.status, 201);
  jobIds.push(created.data.job.id);
  const nowAfterCreated = await request("/api/now", { headers });
  assert.equal(nowAfterCreated.status, 200);
  assert.equal(nowAfterCreated.data.now.sessionMemory.activeJob.id, created.data.job.id);
  assert.equal(nowAfterCreated.data.now.sessionMemory.retention.clearsOnRestart, true);

  const preference = await request("/api/local/chat", {
    method: "POST",
    headers,
    body: { text: "prefiro respostas curtas sem expor OPENAI_API_KEY=sk-proj-smoke-secret" }
  });
  assert.equal(preference.status, 200);
  const sessionContinuity = await request("/api/local/chat", {
    method: "POST",
    headers,
    body: { text: "o que esta acontecendo agora" }
  });
  assert.match(sessionContinuity.data.reply, /Preferencia recente:/);
  assert.doesNotMatch(sessionContinuity.data.reply, /sk-proj-smoke-secret/);

  const persistentPreference = await request("/api/memories", {
    method: "POST",
    headers,
    body: {
      kind: "preference",
      content: "prefiro briefing objetivo sem OPENAI_API_KEY=sk-proj-persistent-secret"
    }
  });
  assert.equal(persistentPreference.status, 201);
  assert.equal(persistentPreference.data.memory.kind, "preference");
  assert.doesNotMatch(persistentPreference.data.memory.content, /sk-proj-persistent-secret/);

  const editedPreference = await request(`/api/memories/${persistentPreference.data.memory.id}`, {
    method: "PATCH",
    headers,
    body: {
      kind: "preference",
      content: "prefiro briefing executivo com proximas acoes"
    }
  });
  assert.equal(editedPreference.status, 200);
  assert.match(editedPreference.data.memory.content, /proximas acoes/);
  const nowWithPersistentMemory = await request("/api/now", { headers });
  assert.ok(nowWithPersistentMemory.data.now.persistentMemory.preferences.some((memory) => memory.id === persistentPreference.data.memory.id));

  const deletedPreference = await request(`/api/memories/${persistentPreference.data.memory.id}?confirm=true`, {
    method: "DELETE",
    headers
  });
  assert.equal(deletedPreference.status, 200);
  assert.equal(deletedPreference.data.output.deleted, true);

  const purgeMemoryFixture = await request("/api/memories", {
    method: "POST",
    headers,
    body: {
      kind: "note",
      content: "memoria temporaria para purga OPENAI_API_KEY=sk-proj-purge-secret"
    }
  });
  assert.equal(purgeMemoryFixture.status, 201);
  assert.doesNotMatch(purgeMemoryFixture.data.memory.content, /sk-proj-purge-secret/);

  const purgeMemoryDenied = await request("/api/privacy/purge", {
    method: "POST",
    headers,
    body: { scope: "memories", confirmed: false }
  });
  assert.equal(purgeMemoryDenied.status, 400);

  const purgeMemory = await request("/api/privacy/purge", {
    method: "POST",
    headers,
    body: { scope: "memories", ids: [purgeMemoryFixture.data.memory.id], confirmed: true }
  });
  assert.equal(purgeMemory.status, 200);
  assert.ok(purgeMemory.data.deleted >= 1);
  assert.ok(!purgeMemory.data.persistentMemory.notes.some((memory) => memory.id === purgeMemoryFixture.data.memory.id));

  const listed = await request("/api/jobs?limit=5", { headers });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.jobs.some((job) => job.id === created.data.job.id));

  const screenEvidenceDenied = await request(`/api/jobs/${created.data.job.id}/screen-evidence`, {
    method: "POST",
    headers,
    body: { confirmed: false, summary: "should not attach" }
  });
  assert.equal(screenEvidenceDenied.status, 400);

  const screenEvidence = await request(`/api/jobs/${created.data.job.id}/screen-evidence`, {
    method: "POST",
    headers,
    body: {
      confirmed: true,
      width: 1280,
      height: 720,
      summary: "Tela do cockpit com OPENAI_API_KEY=sk-proj-screen-secret"
    }
  });
  assert.equal(screenEvidence.status, 201);
  assert.equal(screenEvidence.data.artifact.kind, "screen-evidence");
  assert.equal(screenEvidence.data.artifact.metadata.rawImagePersisted, false);
  assert.doesNotMatch(screenEvidence.data.artifact.content, /sk-proj-screen-secret/);
  assert.ok(screenEvidence.data.events.some((event) => event.type === "screen.evidence_attached"));

  const screenEvidenceRemoveDenied = await request(`/api/jobs/${created.data.job.id}/artifacts/${screenEvidence.data.artifact.id}`, {
    method: "DELETE",
    headers
  });
  assert.equal(screenEvidenceRemoveDenied.status, 400);

  const screenEvidenceRemoved = await request(`/api/jobs/${created.data.job.id}/artifacts/${screenEvidence.data.artifact.id}?confirm=true`, {
    method: "DELETE",
    headers
  });
  assert.equal(screenEvidenceRemoved.status, 200);
  assert.equal(screenEvidenceRemoved.data.deleted, true);
  assert.ok(screenEvidenceRemoved.data.events.some((event) => event.type === "screen.evidence_removed"));
  assert.ok(!screenEvidenceRemoved.data.artifacts.some((artifact) => artifact.id === screenEvidence.data.artifact.id));

  const purgeScreenEvidenceFixture = await request(`/api/jobs/${created.data.job.id}/screen-evidence`, {
    method: "POST",
    headers,
    body: {
      confirmed: true,
      width: 800,
      height: 450,
      summary: "Evidencia temporaria para purga com GITHUB_TOKEN=ghp_abcdefghijklmnop"
    }
  });
  assert.equal(purgeScreenEvidenceFixture.status, 201);
  assert.doesNotMatch(purgeScreenEvidenceFixture.data.artifact.content, /ghp_abcdefghijklmnop/);

  const purgeScreenEvidenceDenied = await request("/api/privacy/purge", {
    method: "POST",
    headers,
    body: { scope: "screen-evidence", confirmed: false }
  });
  assert.equal(purgeScreenEvidenceDenied.status, 400);

  const purgeScreenEvidence = await request("/api/privacy/purge", {
    method: "POST",
    headers,
    body: { scope: "screen-evidence", ids: [purgeScreenEvidenceFixture.data.artifact.id], confirmed: true }
  });
  assert.equal(purgeScreenEvidence.status, 200);
  assert.ok(purgeScreenEvidence.data.deleted >= 1);

  const governed = await request("/api/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke governable approval flow",
      workspace: root,
      mode: "implement",
      policyLevel: "write"
    }
  });
  assert.equal(governed.status, 202);
  assert.equal(governed.data.job.status, "awaiting_confirm");
  jobIds.push(governed.data.job.id);

  const revised = await request(`/api/jobs/${governed.data.job.id}/revise`, {
    method: "POST",
    headers,
    body: { comment: "Antes de executar, reduzir escopo e nao expor OPENAI_API_KEY=sk-proj-revise-secret." }
  });
  assert.equal(revised.status, 200);
  assert.match(revised.data.job.metadata.operatorCritique.comment, /reduzir escopo/);
  assert.doesNotMatch(revised.data.job.metadata.operatorCritique.comment, /sk-proj-revise-secret/);
  assert.ok(revised.data.events.some((event) => event.type === "job.plan_critiqued"));

  const paused = await request(`/api/jobs/${governed.data.job.id}/pause`, {
    method: "POST",
    headers
  });
  assert.equal(paused.status, 200);
  assert.equal(paused.data.job.status, "needs_input");
  assert.equal(paused.data.job.metadata.paused.reversible, true);
  assert.ok(paused.data.events.some((event) => event.type === "job.paused"));

  const pausedCancelled = await request(`/api/jobs/${governed.data.job.id}/cancel`, {
    method: "POST",
    headers
  });
  assert.equal(pausedCancelled.status, 200);
  assert.equal(pausedCancelled.data.job.status, "cancelled");

  const missingCli = await request(`/api/jobs/${created.data.job.id}/codex/ask`, {
    method: "POST",
    headers,
    body: {
      prompt: "This smoke expects a missing CLI failure.",
      bin: "__aura_missing_codex_binary__",
      timeoutMs: 1000
    }
  });
  assert.equal(missingCli.status, 503);
  assert.equal(missingCli.data.codex.available, false);
  assert.equal(missingCli.data.job.status, "failed");
  const missingCliDetail = await request(`/api/jobs/${created.data.job.id}`, { headers });
  assert.equal(missingCliDetail.status, 200);
  assert.equal(missingCliDetail.data.job.status, "failed");

  const cancellable = await request("/api/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke cancel draft job",
      workspace: root,
      mode: "ask",
      policyLevel: "read"
    }
  });
  assert.equal(cancellable.status, 201);
  jobIds.push(cancellable.data.job.id);

  const cancelled = await request(`/api/jobs/${cancellable.data.job.id}/cancel`, {
    method: "POST",
    headers
  });
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.data.job.status, "cancelled");
  const cancelledDetail = await request(`/api/jobs/${cancellable.data.job.id}`, { headers });
  assert.equal(cancelledDetail.status, 200);
  assert.equal(cancelledDetail.data.job.status, "cancelled");

  const skippable = createJob({
    goal: "Smoke skip needs_input job",
    workspace: root,
    mode: "analyze",
    policyLevel: "read",
    timeoutMs: 1000
  });
  jobIds.push(skippable.id);
  updateJobStatus(skippable.id, "running", { summary: "Smoke needs_input setup." });
  updateJobStatus(skippable.id, "needs_input", { error: "Smoke recoverable analyst failure.", summary: "Needs a decision." });
  const skipped = await request(`/api/jobs/${skippable.id}/skip`, {
    method: "POST",
    headers
  });
  assert.equal(skipped.status, 200);
  assert.equal(skipped.data.job.status, "cancelled");
  assert.match(skipped.data.job.summary, /Demanda ignorada/);
  assert.ok(Array.isArray(skipped.data.events));
  assert.ok(Array.isArray(skipped.data.artifacts));

  const hangingAnalyst = createHangingAnalyst("gemini");
  const analystCancelJob = await request("/api/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke cancel hanging analyst job",
      workspace: root,
      mode: "analyze",
      policyLevel: "read",
      timeoutMs: 5000
    }
  });
  assert.equal(analystCancelJob.status, 201);
  jobIds.push(analystCancelJob.data.job.id);
  const runningAnalysts = request(`/api/jobs/${analystCancelJob.data.job.id}/analysts/run`, {
    method: "POST",
    headers,
    body: {
      consent: { gemini: true },
      bins: { gemini: hangingAnalyst },
      timeoutMs: 5000
    }
  });
  await waitForJobEvent(analystCancelJob.data.job.id, "analyst.process_started", headers);
  const cancelAnalyst = await request(`/api/jobs/${analystCancelJob.data.job.id}/cancel`, {
    method: "POST",
    headers
  });
  assert.equal(cancelAnalyst.status, 202);
  const analystCancelled = await runningAnalysts;
  assert.equal(analystCancelled.data.job.status, "cancelled");

  const badGemini = createBadHealthAnalyst("gemini");
  const circuitJob = await request("/api/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke provider circuit reset",
      workspace: root,
      mode: "analyze",
      policyLevel: "read",
      timeoutMs: 3000
    }
  });
  assert.equal(circuitJob.status, 201);
  jobIds.push(circuitJob.data.job.id);
  const circuitRun = await request(`/api/jobs/${circuitJob.data.job.id}/analysts/run`, {
    method: "POST",
    headers,
    body: {
      consent: { gemini: true },
      bins: { gemini: badGemini },
      timeoutMs: 3000
    }
  });
  assert.equal(circuitRun.status, 200);
  assert.equal(circuitRun.data.job.status, "needs_input");
  const circuitStatus = await request("/api/status", { headers });
  assert.equal(circuitStatus.status, 200);
  assert.equal(circuitStatus.data.providers.gemini.status, "circuit_open");
  assert.ok(circuitStatus.data.providers.gemini.circuit.retryAt);
  const resetCircuit = await request("/api/providers/gemini/circuit/reset", {
    method: "POST",
    headers,
    body: { jobId: circuitJob.data.job.id }
  });
  assert.equal(resetCircuit.status, 200, JSON.stringify(resetCircuit.data));
  assert.equal(resetCircuit.data.reset, true);
  assert.equal(resetCircuit.data.retry.duplicateExecution, false);
  const afterReset = await request("/api/status", { headers });
  assert.notEqual(afterReset.data.providers.gemini.status, "circuit_open");
  const circuitEvents = await request(`/api/jobs/${circuitJob.data.job.id}/events`, { headers });
  assert.ok(circuitEvents.data.events.some((event) => event.type === "analyst.circuit_reset"));

  const routineDraft = await request("/api/routine/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke routine draft",
      workspace: root,
      mode: "analyze"
    }
  });
  assert.equal(routineDraft.status, 201);
  assert.equal(routineDraft.data.job.requestedBy, "routine");
  assert.equal(routineDraft.data.job.mode, "analyze");
  assert.equal(routineDraft.data.job.policyLevel, "read");
  assert.equal(routineDraft.data.job.status, "draft");
  jobIds.push(routineDraft.data.job.id);

  const editedRoutineDraft = await request(`/api/jobs/${routineDraft.data.job.id}`, {
    method: "PATCH",
    headers,
    body: {
      goal: "Smoke edited routine draft",
      mode: "ask"
    }
  });
  assert.equal(editedRoutineDraft.status, 200);
  assert.equal(editedRoutineDraft.data.job.goal, "Smoke edited routine draft");
  assert.equal(editedRoutineDraft.data.job.mode, "ask");

  const approvedRoutineDraft = await request(`/api/jobs/${routineDraft.data.job.id}/approve`, {
    method: "POST",
    headers
  });
  assert.equal(approvedRoutineDraft.status, 200);
  assert.equal(approvedRoutineDraft.data.job.status, "queued");

  const continuity = await request("/api/local/chat", {
    method: "POST",
    headers,
    body: {
      text: "o que esta em andamento?"
    }
  });
  assert.equal(continuity.status, 200);
  assert.match(continuity.data.reply, /demanda\(s\) em aberto/);
  assert.ok(continuity.data.jobs.some((job) => job.id === routineDraft.data.job.id));

  const blockedRoutineImplement = await request("/api/routine/jobs", {
    method: "POST",
    headers,
    body: {
      goal: "Smoke blocked routine implement",
      workspace: root,
      mode: "implement"
    }
  });
  assert.equal(blockedRoutineImplement.status, 400);

  const timeoutWriter = createJob({
    goal: "Smoke timeout writer lock",
    workspace: root,
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true,
    timeoutMs: 1000
  });
  jobIds.push(timeoutWriter.id);

  const timedOut = await runJobCommand({
    jobId: timeoutWriter.id,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000);"],
    timeoutMs: 100
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.job.status, "failed");

  const writerAfterTimeout = createJob({
    goal: "Smoke writer after timeout",
    workspace: root,
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true,
    timeoutMs: 1000
  });
  jobIds.push(writerAfterTimeout.id);
  updateJobStatus(writerAfterTimeout.id, "cancelled", { summary: "Smoke cleanup writer lock." });

  console.log("Job smoke verification passed.");
} finally {
  if (serverProcess && !serverProcess.killed) {
    serverProcess.kill();
    await once(serverProcess, "exit").catch(() => {});
  }

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

async function request(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, {
    method: options.method || "GET",
    headers: options.headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return {
    status: response.status,
    data: await json(response)
  };
}

async function json(response) {
  return response.json().catch(() => ({}));
}

async function waitForServer(url, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Smoke server exited early: ${stderr.join("")}`);
    }

    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Smoke server did not start: ${stderr.join("")}`);
}

async function waitForJobStatus(jobId, status, headers) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const detail = await request(`/api/jobs/${jobId}`, { headers });
    if (detail.data.job?.status === status) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for job ${jobId} to reach ${status}.`);
}

async function waitForJobEvent(jobId, eventType, headers) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const detail = await request(`/api/jobs/${jobId}`, { headers });
    if ((detail.data.events || []).some((event) => event.type === eventType)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.fail(`Timed out waiting for job ${jobId} event ${eventType}.`);
}

async function freePort() {
  const server = net.createServer();
  server.listen(0, host);
  await once(server, "listening");
  const address = server.address();
  const selectedPort = address.port;
  server.close();
  await once(server, "close");
  return selectedPort;
}

function createHangingAnalyst(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-smoke-hang-${name}-`));
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
      `"${process.execPath}" -e 'setTimeout(() => {}, 10000)'`
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}

function createBadHealthAnalyst(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-smoke-bad-health-${name}-`));
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
      "echo not-json"
    ].join("\n"));
    fs.chmodSync(scriptPath, 0o755);
  }

  return scriptPath;
}
