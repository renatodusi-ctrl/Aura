import assert from "node:assert/strict";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import path from "node:path";
import {
  buildPresenceSloReport,
  evaluatePresenceSlo,
  PRESENCE_SLO_TARGETS
} from "../slo.js";
import { EXPORT_DIR, config } from "../server/config.js";
import { createJob, initMemory } from "../server/memory.js";
import { activeJobProcessSummary, cancelJobProcess, runJobCommand } from "../server/supervisor.js";

const root = path.resolve(import.meta.dirname, "..");
const args = new Map(process.argv.slice(2).map((arg) => {
  const [key, value = "true"] = arg.replace(/^--/, "").split("=");
  return [key, value];
}));
const sampleCount = Math.max(4, Number.parseInt(args.get("samples") || "8", 10));
const reportPath = path.resolve(args.get("report") || path.join(EXPORT_DIR, "presence-slo-report.json"));
const host = "127.0.0.1";
const port = await freePort();
const base = `http://${host}:${port}`;
const samples = [];
const cancelSamples = [];
const jobIds = [];
let serverProcess;

initMemory();

try {
  serverProcess = spawn(process.execPath, ["server/index.js"], {
    cwd: root,
    env: { ...process.env, HOST: host, PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stderr = [];
  serverProcess.stderr.on("data", (chunk) => stderr.push(String(chunk)));
  await waitForServer(base, stderr);

  const session = await timedJson(`${base}/api/session`);
  const headers = { "X-AURA-Session": session.data.token };
  await timedJson(`${base}/api/status`, { headers });
  await timedJson(`${base}/api/now`, { headers });

  for (let index = 0; index < sampleCount; index += 1) {
    const status = await timedJson(`${base}/api/status`, { headers });
    const now = await timedJson(`${base}/api/now`, { headers });
    samples.push({
      endpoint: "/api/status",
      latencyMs: status.latencyMs,
      consistent: status.data.ok === true && status.data.operations?.jobProcesses?.total >= 0
    });
    samples.push({
      endpoint: "/api/now",
      latencyMs: now.latencyMs,
      consistent: Boolean(now.data.now?.generatedAt && now.data.now?.actionId)
    });
  }

  const cancelJob = createJob({
    goal: "Presence SLO cancel hanging process",
    workspace: root,
    policyLevel: "read",
    timeoutMs: 5000
  });
  jobIds.push(cancelJob.id);
  const running = runJobCommand({
    jobId: cancelJob.id,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000);"],
    timeoutMs: 5000
  });
  await waitUntil(() => activeJobProcessSummary().total === 1, 1500);
  const cancelStartedAt = performance.now();
  assert.equal(cancelJobProcess(cancelJob.id), true);
  const cancelled = await running;
  cancelSamples.push(Math.round(performance.now() - cancelStartedAt));
  assert.equal(cancelled.job.status, "cancelled");
  assert.equal(activeJobProcessSummary().total, 0);

  const report = buildPresenceSloReport(samples, cancelSamples, activeJobProcessSummary());
  const gate = evaluatePresenceSlo(report, PRESENCE_SLO_TARGETS);
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });
  fs.writeFileSync(reportPath, `${JSON.stringify({ ...report, gate }, null, 2)}\n`);

  assert.equal(gate.pass, true, gate.failures.join("; "));
  console.log(`Presence SLO passed. Report: ${reportPath}`);
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
}

async function timedJson(url, options = {}) {
  const startedAt = performance.now();
  const response = await fetch(url, options);
  const data = await response.json();
  return {
    status: response.status,
    data,
    latencyMs: Math.round(performance.now() - startedAt)
  };
}

async function waitForServer(baseUrl, stderr) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/session`);
      if (response.ok) {
        return;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Server did not start. ${stderr.join("\n")}`);
}

async function waitUntil(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for SLO condition.");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, host, () => {
      const address = server.address();
      server.close(() => resolve(address.port));
    });
    server.on("error", reject);
  });
}
