import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import net from "node:net";
import path from "node:path";
import { config } from "../server/config.js";
import { createJob, initMemory, updateJobStatus } from "../server/memory.js";
import { runJobCommand } from "../server/supervisor.js";

const root = path.resolve(import.meta.dirname, "..");
const host = "127.0.0.1";
const port = await freePort();
const base = `http://${host}:${port}`;
const jobIds = [];
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

  const listed = await request("/api/jobs?limit=5", { headers });
  assert.equal(listed.status, 200);
  assert.ok(listed.data.jobs.some((job) => job.id === created.data.job.id));

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
