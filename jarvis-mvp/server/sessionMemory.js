import { redactObject, redactText } from "./redaction.js";

const MAX_TIMELINE = 12;
const MAX_TEXT = 280;

let session = freshSession();

export function rememberJobEvent(job, eventType = "updated") {
  if (!job) {
    return summary();
  }

  const safeJob = safeJobSnapshot(job);
  session.activeJob = safeJob;
  session.nextAction = nextActionForJob(job);
  pushTimeline({
    type: `job.${eventType}`,
    jobId: safeJob.id,
    status: safeJob.status,
    summary: safeJob.summary || safeJob.goal
  });
  return summary();
}

export function rememberDecision(job, synthesis = {}) {
  const recommendation = limit(redactText(synthesis.recommendation || ""));
  const risks = normalizeItems(synthesis.risks).slice(0, 3);
  const dissent = normalizeItems(synthesis.dissent).slice(0, 3);
  const decision = {
    jobId: job?.id || null,
    recommendation: recommendation || "Conselho sem recomendacao consolidada.",
    confidence: limit(redactText(synthesis.confidence || "low")),
    risks,
    dissent,
    updatedAt: new Date().toISOString()
  };

  session.lastDecision = decision;
  session.nextAction = job
    ? "Revisar a decisao do Conselho e escolher se cria uma implementacao confirmavel."
    : "Revisar a ultima decisao do Conselho antes de continuar.";
  pushTimeline({
    type: "decision.updated",
    jobId: decision.jobId,
    status: "reviewed",
    summary: decision.recommendation
  });
  return summary();
}

export function rememberPreference(text, source = "text") {
  const preference = extractPreference(text);
  if (!preference) {
    return null;
  }

  session.recentPreference = {
    text: preference,
    source,
    updatedAt: new Date().toISOString()
  };
  pushTimeline({
    type: "preference.updated",
    status: "noted",
    summary: preference
  });
  return summary();
}

export function sessionMemorySummary() {
  return summary();
}

export function resetSessionMemoryForTests() {
  session = freshSession();
  return summary();
}

function summary() {
  return redactObject({
    startedAt: session.startedAt,
    retention: {
      mode: "process-memory",
      maxTimelineItems: MAX_TIMELINE,
      clearsOnRestart: true,
      rehydrate: "explicit-only"
    },
    activeJob: session.activeJob,
    lastDecision: session.lastDecision,
    recentPreference: session.recentPreference,
    nextAction: session.nextAction,
    timeline: session.timeline
  });
}

function freshSession() {
  return {
    startedAt: new Date().toISOString(),
    activeJob: null,
    lastDecision: null,
    recentPreference: null,
    nextAction: "Aguardando uma missao para organizar a sessao.",
    timeline: []
  };
}

function safeJobSnapshot(job) {
  return redactObject({
    id: job.id,
    mode: job.mode,
    status: job.status,
    requestedBy: job.requestedBy,
    policyLevel: job.policyLevel,
    goal: limit(redactText(job.goal || "")),
    summary: limit(redactText(job.summary || job.error || "")),
    updatedAt: job.updatedAt
  });
}

function nextActionForJob(job) {
  const actions = {
    draft: "Revisar o draft e aprovar quando estiver pronto.",
    awaiting_confirm: "Confirmar visualmente antes de permitir escrita no workspace.",
    queued: "Acompanhar a fila ou cancelar se a prioridade mudou.",
    running: "Aguardar a execucao terminar ou cancelar se travar.",
    needs_input: "Responder ao bloqueio para liberar o proximo passo.",
    done: "Revisar resultado e decidir se gera implementacao ou encerra.",
    failed: "Ler a falha e reabrir com escopo menor ou mais contexto.",
    cancelled: "Escolher uma nova demanda ou retomar outra pendencia."
  };
  return actions[job.status] || "Revisar o cockpit para decidir o proximo passo.";
}

function extractPreference(text) {
  const raw = String(text || "").trim();
  if (!/\b(?:prefiro|preferencia|preferência|quero manter|vamos manter|gostaria que|use|usar|priorize|priorizar)\b/i.test(raw)) {
    return null;
  }
  return limit(redactText(raw));
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") {
        return limit(redactText(item));
      }
      return limit(redactText(item?.text || item?.recommendation || item?.summary || ""));
    })
    .filter(Boolean);
}

function pushTimeline(entry) {
  session.timeline.unshift({
    ...redactObject(entry),
    createdAt: new Date().toISOString()
  });
  session.timeline = session.timeline.slice(0, MAX_TIMELINE);
}

function limit(text) {
  const clean = String(text || "").replace(/\s+/g, " ").trim();
  if (clean.length <= MAX_TEXT) {
    return clean;
  }
  return `${clean.slice(0, MAX_TEXT - 1).trimEnd()}.`;
}
