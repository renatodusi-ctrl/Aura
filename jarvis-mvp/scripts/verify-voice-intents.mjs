import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../server/config.js";
import { initMemory } from "../server/memory.js";
import { handleVoiceIntent, parseVoiceIntent } from "../server/voiceIntents.js";

initMemory();

const jobIds = [];

try {
  assert.deepEqual(parseVoiceIntent("cancelar job 42"), { type: "job.cancel", id: 42 });
  assert.deepEqual(parseVoiceIntent("status do job 7"), { type: "job.status", id: 7 });
  assert.deepEqual(parseVoiceIntent("status dos jobs"), { type: "job.status", id: null });
  assert.equal(parseVoiceIntent("criar tarefa comprar cafe"), null);

  const ask = handleVoiceIntent("criar job revisar a arquitetura local");
  jobIds.push(ask.job.id);
  assert.equal(ask.intent.type, "job.create");
  assert.equal(ask.job.mode, "ask");
  assert.equal(ask.job.requestedBy, "voice");
  assert.equal(ask.job.policyLevel, "read");
  assert.equal(ask.job.status, "draft");
  assert.match(ask.reply, /Job \d+ criado/);

  const status = handleVoiceIntent(`consultar job ${ask.job.id}`);
  assert.equal(status.job.id, ask.job.id);
  assert.match(status.reply, new RegExp(`Job ${ask.job.id}: draft`));

  const cancelled = handleVoiceIntent(`cancelar job ${ask.job.id}`);
  assert.equal(cancelled.job.status, "cancelled");
  assert.match(cancelled.reply, /cancelado/);

  const implement = handleVoiceIntent("implementar uma melhoria pequena");
  jobIds.push(implement.job.id);
  assert.equal(implement.job.mode, "implement");
  assert.equal(implement.job.policyLevel, "write");
  assert.equal(implement.job.status, "awaiting_confirm");
  assert.equal(implement.job.requiresConfirmation, true);
  assert.match(implement.reply, /confirmacao visual/);

  const listed = handleVoiceIntent("listar jobs");
  assert.ok(listed.jobs.some((job) => job.id === implement.job.id));

  console.log("Voice intent verification passed.");
} finally {
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
}
