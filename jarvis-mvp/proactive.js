const DEFAULT_COOLDOWN_MS = 10 * 60 * 1000;
const DEFAULT_SNOOZE_MS = 30 * 60 * 1000;

export function buildProactiveSuggestion(context = {}, ledger = {}, options = {}) {
  if (options.enabled === false) {
    return null;
  }

  const now = context.now || {};
  const job = now.activeJob || preferredJob(context.jobs || []);
  const task = (context.tasks || []).find((item) => item.status !== "done");
  const candidate = candidateForContext(now, job, task);
  if (!candidate) {
    return null;
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const cooldownMs = Number.isFinite(options.cooldownMs) ? options.cooldownMs : DEFAULT_COOLDOWN_MS;
  const decision = ledger.decisions?.[candidate.signature] || {};

  if (decision.dismissedAt || decision.acceptedAt) {
    return null;
  }
  if (decision.snoozedUntil && decision.snoozedUntil > nowMs) {
    return null;
  }
  if (
    decision.lastShownAt
    && nowMs - decision.lastShownAt < cooldownMs
    && options.activeSignature !== candidate.signature
  ) {
    return null;
  }

  return {
    ...candidate,
    shownAt: nowMs,
    snoozeMs: DEFAULT_SNOOZE_MS
  };
}

export function recordProactiveDecision(ledger = {}, suggestion, action, options = {}) {
  if (!suggestion?.signature) {
    return normalizeLedger(ledger);
  }

  const nowMs = Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
  const snoozeMs = Number.isFinite(options.snoozeMs) ? options.snoozeMs : (suggestion.snoozeMs || DEFAULT_SNOOZE_MS);
  const next = normalizeLedger(ledger);
  const current = next.decisions[suggestion.signature] || {};
  const record = {
    ...current,
    lastAction: action,
    lastActionAt: nowMs,
    lastShownAt: action === "shown" ? nowMs : (current.lastShownAt || suggestion.shownAt || nowMs),
    acceptedCount: current.acceptedCount || 0,
    acceptedAt: current.acceptedAt || null,
    dismissedAt: current.dismissedAt || null,
    snoozedUntil: current.snoozedUntil || null
  };

  if (action === "accepted") {
    record.acceptedCount += 1;
    record.acceptedAt = nowMs;
    record.snoozedUntil = null;
  }
  if (action === "dismissed") {
    record.dismissedAt = nowMs;
  }
  if (action === "snoozed") {
    record.snoozedUntil = nowMs + snoozeMs;
  }
  if (action === "shown") {
    record.lastShownAt = nowMs;
  }

  next.decisions[suggestion.signature] = record;
  next.history = [
    { signature: suggestion.signature, action, at: nowMs, label: suggestion.label },
    ...next.history
  ].slice(0, 50);
  return next;
}

export function normalizeLedger(ledger = {}) {
  return {
    decisions: ledger.decisions && typeof ledger.decisions === "object" ? { ...ledger.decisions } : {},
    history: Array.isArray(ledger.history) ? [...ledger.history] : []
  };
}

function candidateForContext(now, job, task) {
  if (job?.status === "done") {
    return suggestion({
      signature: `job:${job.id}:done:${job.updatedAt || ""}`,
      event: "demand_completed",
      label: "Revisar resultado da demanda",
      body: `A demanda #${job.id} terminou. Vale revisar artefatos e decidir se fecha ou transforma em proxima etapa.`,
      benefit: "Evita perder conclusoes e deixa o historico confiavel.",
      costRisk: "Custo baixo; exige alguns minutos de revisao humana.",
      action: { kind: "review", jobId: job.id }
    });
  }

  if (["needs_input", "awaiting_confirm"].includes(job?.status)) {
    return suggestion({
      signature: `job:${job.id}:${job.status}:${job.updatedAt || ""}`,
      event: "decision_needed",
      label: job.status === "awaiting_confirm" ? "Confirmar ou negar execucao" : "Responder bloqueio da demanda",
      body: `A demanda #${job.id} esta parada aguardando voce.`,
      benefit: "Destrava a fila sem a AURA repetir o mesmo pedido.",
      costRisk: job.status === "awaiting_confirm"
        ? "Pode liberar escrita local; revise arquivos e risco antes."
        : "Pode retomar uma tentativa que ainda precisa de contexto.",
      action: { kind: "review", jobId: job.id }
    });
  }

  if (job?.status === "failed") {
    return suggestion({
      signature: `job:${job.id}:failed:${job.updatedAt || ""}`,
      event: "demand_failed",
      label: "Diagnosticar falha recente",
      body: `A demanda #${job.id} falhou e tem caminho de retomada no historico.`,
      benefit: "Reduz retrabalho antes de criar outra demanda parecida.",
      costRisk: "Custo medio; pode exigir nova consulta ao Conselho ou ajuste de escopo.",
      action: { kind: "review", jobId: job.id }
    });
  }

  if (now?.blockers?.length) {
    return suggestion({
      signature: `now:blocker:${stableText(now.blockers.join("|"))}`,
      event: "blocker_detected",
      label: "Resolver bloqueio principal",
      body: now.blockers[0],
      benefit: "Mantem a missao atual fluindo com uma decisao objetiva.",
      costRisk: "Custo depende do bloqueio; revise antes de executar qualquer escrita.",
      action: { kind: "review", jobId: job?.id || null }
    });
  }

  if (!job && task) {
    return suggestion({
      signature: `task:${task.id}:open`,
      event: "task_opportunity",
      label: "Retomar uma tarefa aberta",
      body: `A tarefa "${task.title}" pode virar uma demanda rastreavel.`,
      benefit: "Tira a proxima acao da lista e coloca no fluxo do cockpit.",
      costRisk: "Custo baixo; demanda criada ainda pede confirmacao antes de escrita.",
      action: { kind: "task", taskId: task.id }
    });
  }

  return null;
}

function preferredJob(jobs) {
  return jobs.find((job) => ["needs_input", "awaiting_confirm", "failed", "done"].includes(job.status)) || null;
}

function suggestion(data) {
  return {
    id: data.signature,
    ...data
  };
}

function stableText(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}
