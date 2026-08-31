import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { config } from "../server/config.js";
import { createJob, createJobArtifact, initMemory, updateJobStatus } from "../server/memory.js";
import { handleVoiceIntent, parseVoiceIntent } from "../server/voiceIntents.js";

initMemory();

const jobIds = [];

try {
  assert.deepEqual(parseVoiceIntent("cancelar job 42"), { type: "job.cancel", id: 42 });
  assert.deepEqual(parseVoiceIntent("cancelar demanda 42"), { type: "job.cancel", id: 42 });
  assert.deepEqual(parseVoiceIntent("status do job 7"), { type: "job.status", id: 7 });
  assert.deepEqual(parseVoiceIntent("status da demanda 7"), { type: "job.status", id: 7 });
  assert.deepEqual(parseVoiceIntent("status dos jobs"), { type: "job.status", id: null });
  assert.deepEqual(parseVoiceIntent("listar demandas"), { type: "job.status", id: null });
  assert.deepEqual(parseVoiceIntent("qual a decisao da demanda 42"), { type: "job.decision", id: 42 });
  assert.deepEqual(parseVoiceIntent("proximo passo do job 42"), { type: "job.next_step", id: 42 });
  assert.deepEqual(parseVoiceIntent("bloqueios do job 42"), { type: "job.blockers", id: 42 });
  assert.deepEqual(parseVoiceIntent("retomar conselho da demanda 42 com evidencias novas"), {
    type: "job.resume_read",
    id: 42,
    note: "evidencias novas"
  });
  assert.equal(parseVoiceIntent("criar tarefa comprar cafe"), null);

  const ask = handleVoiceIntent("criar job revisar a arquitetura local");
  jobIds.push(ask.job.id);
  assert.equal(ask.intent.type, "job.create");
  assert.equal(ask.job.mode, "ask");
  assert.equal(ask.job.requestedBy, "voice");
  assert.equal(ask.job.policyLevel, "read");
  assert.equal(ask.job.status, "draft");
  assert.match(ask.reply, /Demanda \d+ criada/);

  const status = handleVoiceIntent(`consultar job ${ask.job.id}`);
  assert.equal(status.job.id, ask.job.id);
  assert.match(status.reply, new RegExp(`Demanda ${ask.job.id}: draft`));

  const cancelled = handleVoiceIntent(`cancelar job ${ask.job.id}`);
  assert.equal(cancelled.job.status, "cancelled");
  assert.match(cancelled.reply, /cancelad[ao]/);

  const implement = handleVoiceIntent("implementar uma melhoria pequena");
  jobIds.push(implement.job.id);
  assert.equal(implement.job.mode, "implement");
  assert.equal(implement.job.policyLevel, "write");
  assert.equal(implement.job.status, "awaiting_confirm");
  assert.equal(implement.job.requiresConfirmation, true);
  assert.match(implement.reply, /confirmacao visual/);

  const listed = handleVoiceIntent("listar jobs");
  assert.ok(listed.jobs.some((job) => job.id === implement.job.id));
  updateJobStatus(implement.job.id, "cancelled", { summary: "Release voice implement fixture." });

  const councilJob = createJob({
    goal: "Verify spoken council decision",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read"
  });
  jobIds.push(councilJob.id);
  createJobArtifact(councilJob.id, {
    kind: "debate-synthesis",
    label: "Debate synthesis",
    content: JSON.stringify({
      recommendation: "criar um draft confirmavel",
      confidence: "medium",
      risks: [{ text: "validar antes de executar" }]
    })
  });
  updateJobStatus(councilJob.id, "running");
  updateJobStatus(councilJob.id, "done", { summary: "Debate synthesis: 1 risk." });

  const decision = handleVoiceIntent(`qual a decisao da demanda ${councilJob.id}`);
  assert.match(decision.reply, /criar um draft confirmavel/);
  assert.match(decision.reply, /Confianca medium/);

  const nextStep = handleVoiceIntent(`proximo passo do job ${councilJob.id}`);
  assert.match(nextStep.reply, /criar uma implementacao confirmavel/);

  const blockedVoiceJob = createJob({
    goal: "Verify spoken blockers",
    workspace: process.cwd(),
    mode: "implement",
    policyLevel: "write",
    requiresConfirmation: true
  });
  jobIds.push(blockedVoiceJob.id);
  updateJobStatus(blockedVoiceJob.id, "awaiting_confirm", { summary: "Needs confirmation." });
  updateJobStatus(blockedVoiceJob.id, "queued");
  updateJobStatus(blockedVoiceJob.id, "running");
  createJobArtifact(blockedVoiceJob.id, {
    kind: "critic-review",
    label: "AURA critic review",
    content: "# AURA Critic Review",
    metadata: { gate: "review", risks: ["sem teste automatico"] }
  });
  updateJobStatus(blockedVoiceJob.id, "needs_input", { error: "AURA critic gate requires human review: sem teste automatico" });
  const blockers = handleVoiceIntent(`bloqueios do job ${blockedVoiceJob.id}`);
  assert.match(blockers.reply, /sem teste automatico/);

  const resumeJob = createJob({
    goal: "Verify read-only voice resume",
    workspace: process.cwd(),
    mode: "analyze",
    policyLevel: "read"
  });
  jobIds.push(resumeJob.id);
  updateJobStatus(resumeJob.id, "running");
  updateJobStatus(resumeJob.id, "needs_input", { error: "No usable analyst." });
  const resume = handleVoiceIntent(`retomar conselho da demanda ${resumeJob.id} com novo contexto`);
  assert.equal(resume.recovery.allowed, true);
  assert.equal(resume.recovery.mode, "read-only");
  assert.match(resume.reply, /Retomada read-only preparada/);

  const writeResume = handleVoiceIntent(`retomar conselho da demanda ${blockedVoiceJob.id}`);
  assert.match(writeResume.reply, /confirme visualmente/);

  console.log("Voice intent verification passed.");
} finally {
  const cleanup = new DatabaseSync(config.databasePath);
  cleanup.exec("PRAGMA foreign_keys = ON");
  for (const id of jobIds) {
    cleanup.prepare("DELETE FROM jobs WHERE id = ?").run(id);
  }
  cleanup.close();
}
