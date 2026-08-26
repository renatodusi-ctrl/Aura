import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../server/config.js";
import {
  createJob,
  getJob,
  initMemory,
  listJobEvents,
  recordJobEvent,
  updateJobStatus
} from "../server/memory.js";

initMemory();

const jobIds = [];

try {
  assert.throws(
    () => createJob({ goal: "bad", workspace: process.cwd(), status: "running" }),
    /New jobs must start as draft/
  );

  const job = createJob({
    goal: "Verify job kernel",
    workspace: process.cwd(),
    mode: "ask",
    requestedBy: "text",
    policyLevel: "read",
    metadata: "{\"source\":\"verify\"}"
  });
  jobIds.push(job.id);

  assert.equal(job.status, "draft");
  assert.equal(job.metadata.source, "verify");

  const customEvent = recordJobEvent(job.id, "verify.custom", "Verify custom event.", { ok: true });
  assert.equal(customEvent.data.ok, true);

  const running = updateJobStatus(job.id, "running");
  assert.equal(running.status, "running");
  assert.ok(running.startedAt);

  const failed = updateJobStatus(job.id, "failed", { error: "boom", summary: "verify failed intentionally" });
  assert.equal(failed.status, "failed");
  assert.equal(failed.error, "boom");
  assert.equal(failed.summary, "verify failed intentionally");
  assert.ok(failed.finishedAt);

  assert.throws(
    () => updateJobStatus(job.id, "running"),
    /Invalid job status transition/
  );

  const stored = getJob(job.id);
  assert.equal(stored.error, "boom");
  assert.equal(stored.summary, "verify failed intentionally");

  const events = listJobEvents(job.id);
  assert.ok(events.length >= 4);
  assert.equal(typeof events[0].data, "object");

  const readOne = createJob({
    goal: "Verify read one",
    workspace: process.cwd(),
    policyLevel: "read"
  });
  const readTwo = createJob({
    goal: "Verify read two",
    workspace: process.cwd(),
    policyLevel: "read"
  });
  jobIds.push(readOne.id, readTwo.id);
  assert.equal(readOne.policyLevel, "read");
  assert.equal(readTwo.policyLevel, "read");

  const writer = createJob({
    goal: "Verify writer lock",
    workspace: process.cwd(),
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true
  });
  jobIds.push(writer.id);

  assert.throws(
    () => createJob({
      goal: "Verify second writer blocked",
      workspace: process.cwd(),
      mode: "implement",
      policyLevel: "write",
      requiresConfirmation: true
    }),
    /Workspace is locked by writer job/
  );

  updateJobStatus(writer.id, "cancelled", { summary: "Release writer lock." });

  const writerAfterRelease = createJob({
    goal: "Verify writer after release",
    workspace: process.cwd(),
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true
  });
  jobIds.push(writerAfterRelease.id);
  updateJobStatus(writerAfterRelease.id, "cancelled", { summary: "Cleanup writer lock." });

  console.log("Job kernel verification passed.");
} finally {
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
}
