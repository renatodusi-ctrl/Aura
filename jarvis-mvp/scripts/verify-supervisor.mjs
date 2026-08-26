import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../server/config.js";
import { createJob, getJob, initMemory, listJobEvents } from "../server/memory.js";
import { cancelJobProcess, runJobCommand } from "../server/supervisor.js";

initMemory();

const jobIds = [];

try {
  const successJob = createJob({
    goal: "Verify supervisor success",
    workspace: process.cwd(),
    policyLevel: "read"
  });
  jobIds.push(successJob.id);
  const success = await runJobCommand({
    jobId: successJob.id,
    command: process.execPath,
    args: ["-e", "console.log('supervisor stdout'); console.error('supervisor stderr');"],
    timeoutMs: 5000
  });
  assert.equal(success.exitCode, 0);
  assert.equal(success.job.status, "done");
  const successEvents = listJobEvents(successJob.id).map((event) => event.type);
  assert.ok(successEvents.includes("process.started"));
  assert.ok(successEvents.includes("process.stdout"));
  assert.ok(successEvents.includes("process.stderr"));
  assert.ok(successEvents.includes("process.finished"));

  const timeoutJob = createJob({
    goal: "Verify supervisor timeout",
    workspace: process.cwd(),
    policyLevel: "read"
  });
  jobIds.push(timeoutJob.id);
  const timedOut = await runJobCommand({
    jobId: timeoutJob.id,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000);"],
    timeoutMs: 100
  });
  assert.equal(timedOut.timedOut, true);
  assert.equal(timedOut.job.status, "failed");
  assert.match(getJob(timeoutJob.id).error, /timed out/);

  const cancelJob = createJob({
    goal: "Verify supervisor cancel",
    workspace: process.cwd(),
    policyLevel: "read"
  });
  jobIds.push(cancelJob.id);
  const running = runJobCommand({
    jobId: cancelJob.id,
    command: process.execPath,
    args: ["-e", "setTimeout(() => {}, 5000);"],
    timeoutMs: 5000
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(cancelJobProcess(cancelJob.id), true);
  const cancelled = await running;
  assert.equal(cancelled.cancelled, true);
  assert.equal(cancelled.job.status, "cancelled");

  console.log("Supervisor verification passed.");
} finally {
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
}
