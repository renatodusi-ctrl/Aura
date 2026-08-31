import { config, ROOT_DIR } from "./config.js";
import { createJob, getJob, listJobArtifacts, listJobs, updateJobStatus } from "./memory.js";
import { evaluateJobPolicy } from "./policy.js";
import { cancelJobProcess } from "./supervisor.js";

export function handleVoiceIntent(text) {
  const intent = parseVoiceIntent(text);
  if (!intent) {
    return null;
  }

  if (intent.type === "job.create") {
    return createJobFromVoice(intent);
  }

  if (intent.type === "job.status") {
    return jobStatusForVoice(intent);
  }

  if (intent.type === "job.decision") {
    return jobDecisionForVoice(intent);
  }

  if (intent.type === "job.blockers") {
    return jobBlockersForVoice(intent);
  }

  if (intent.type === "job.next_step") {
    return jobNextStepForVoice(intent);
  }

  if (intent.type === "job.resume_read") {
    return jobResumeReadForVoice(intent);
  }

  if (intent.type === "job.cancel") {
    return cancelJobFromVoice(intent);
  }

  return null;
}

export function parseVoiceIntent(text) {
  const original = String(text || "").trim();
  const normalized = normalizeText(original);
  if (!normalized) {
    return null;
  }

  const cancel = normalized.match(/\b(?:cancelar|cancele|parar|pare)\s+(?:(?:o|do|a|da)\s+)?(?:job|demanda)\s+(\d+)\b/);
  if (cancel) {
    return { type: "job.cancel", id: Number(cancel[1]) };
  }

  const statusOne = normalized.match(/\b(?:status|consultar|consulte|como esta|ver)\s+(?:(?:o|do|a|da)\s+)?(?:job|demanda)\s+(\d+)\b/);
  if (statusOne) {
    return { type: "job.status", id: Number(statusOne[1]) };
  }

  if (/\b(?:status|consultar|listar|mostrar)\s+(?:(?:dos\s+)?jobs|(?:as\s+|das\s+)?demandas)\b/.test(normalized)) {
    return { type: "job.status", id: null };
  }

  const decision = normalized.match(/\b(?:decisao|recomendacao|resumo do conselho|ler decisao)(?:\s+(?:do conselho))?(?:\s+(?:(?:do|da)\s+)?(?:job|demanda)\s+(\d+))?\b/);
  if (decision) {
    return { type: "job.decision", id: decision[1] ? Number(decision[1]) : null };
  }

  const blockers = normalized.match(/\b(?:bloqueio|bloqueios|bloqueou|critica|critic|criticou|risco|riscos)(?:\s+(?:(?:do|da)\s+)?(?:job|demanda)\s+(\d+))?\b/);
  if (blockers) {
    return { type: "job.blockers", id: blockers[1] ? Number(blockers[1]) : null };
  }

  const nextStep = normalized.match(/\b(?:proximo passo|o que fazer agora|qual o proximo passo|seguir agora)(?:\s+(?:(?:do|da)\s+)?(?:job|demanda)\s+(\d+))?\b/);
  if (nextStep) {
    return { type: "job.next_step", id: nextStep[1] ? Number(nextStep[1]) : null };
  }

  const resumeRead = original.match(/^(?:retomar|retome|continuar|continue)\s+(?:o\s+)?(?:conselho|analise|análise)(?:\s+(?:(?:do|da)\s+)?(?:job|demanda)\s+#?(\d+))?(?:\s+(?:com|sobre|para)\s+(.+))?$/i);
  if (resumeRead) {
    return {
      type: "job.resume_read",
      id: resumeRead[1] ? Number(resumeRead[1]) : null,
      note: resumeRead[2]?.trim() || ""
    };
  }

  const explicitJob = original.match(/^(?:criar|crie|abrir|abra)\s+(?:um\s+|uma\s+)?(?:job|demanda)\s+(.+)$/i);
  if (explicitJob) {
    return {
      type: "job.create",
      goal: explicitJob[1].trim(),
      mode: modeFromText(explicitJob[1])
    };
  }

  const analyze = original.match(/^(?:analisar|analise|pedir analise sobre)\s+(.+)$/i);
  if (analyze) {
    return { type: "job.create", goal: analyze[1].trim(), mode: "analyze" };
  }

  const implement = original.match(/^(?:implementar|corrigir|alterar)\s+(.+)$/i);
  if (implement) {
    return { type: "job.create", goal: implement[1].trim(), mode: "implement" };
  }

  return null;
}

function createJobFromVoice(intent) {
  const mode = intent.mode || "ask";
  const policyLevel = mode === "implement" ? "write" : "read";
  const policy = evaluateJobPolicy(policyLevel);
  const job = createJob({
    goal: intent.goal,
    workspace: ROOT_DIR,
    mode,
    requestedBy: "voice",
    policyLevel,
    requiresConfirmation: policy.requiresConfirmation,
    timeoutMs: mode === "implement" ? config.codexTimeoutMs : config.jobTimeoutMs,
    metadata: {
      voice: {
        source: "local-intent",
        confirmation: "visual-required-for-write"
      },
      policy: {
        confirmationType: policy.confirmationType,
        reason: policy.reason
      }
    }
  });

  const finalJob = policy.status === "awaiting_confirm"
    ? updateJobStatus(job.id, "awaiting_confirm", { summary: policy.reason })
    : job;

  return {
    reply: finalJob.status === "awaiting_confirm"
      ? `Demanda ${finalJob.id} criada. Precisa de confirmacao visual antes de escrever.`
      : `Demanda ${finalJob.id} criada em modo ${finalJob.mode}.`,
    intent: { type: "job.create", mode: finalJob.mode },
    job: finalJob
  };
}

function jobResumeReadForVoice(intent) {
  const job = resolveVoiceJob(intent.id);
  if (!job) {
    return missingJobReply(intent);
  }
  if (job.mode !== "analyze") {
    return {
      reply: `Demanda ${job.id} nao e uma analise. Para escrita, confirme visualmente no cockpit.`,
      intent,
      job
    };
  }
  if (job.status !== "needs_input") {
    return {
      reply: `Demanda ${job.id} nao esta aguardando retomada. Proximo passo: ${nextStepForVoiceJob(job)}`,
      intent,
      job
    };
  }
  return {
    reply: `Retomada read-only preparada para a demanda ${job.id}. No cockpit, use Retomar conselho${intent.note ? ` com a orientacao: ${intent.note}` : " e adicione uma orientacao curta"}.`,
    intent,
    job,
    recovery: {
      allowed: true,
      mode: "read-only",
      note: intent.note || ""
    }
  };
}

function jobDecisionForVoice(intent) {
  const job = resolveVoiceJob(intent.id);
  if (!job) {
    return missingJobReply(intent);
  }

  const synthesis = latestJsonArtifact(job.id, "debate-synthesis");
  if (!synthesis) {
    return {
      reply: `Demanda ${job.id} ainda nao tem Decisao do Conselho.`,
      intent,
      job
    };
  }

  const risks = Array.isArray(synthesis.risks) ? synthesis.risks.length : 0;
  const recommendation = sentenceForVoice(synthesis.recommendation || "sem recomendacao textual");
  return {
    reply: `Decisao da demanda ${job.id}: ${recommendation}. Confianca ${synthesis.confidence || "baixa"}; ${risks} riscos registrados.`,
    intent,
    job,
    synthesis
  };
}

function jobBlockersForVoice(intent) {
  const job = resolveVoiceJob(intent.id);
  if (!job) {
    return missingJobReply(intent);
  }

  const critic = latestArtifact(job.id, "critic-review");
  const synthesis = latestJsonArtifact(job.id, "debate-synthesis");
  const risks = [
    ...(job.error ? [job.error] : []),
    ...(critic?.metadata?.risks || []),
    ...((Array.isArray(synthesis?.risks) ? synthesis.risks : []).map((risk) => risk.text || risk))
  ].filter(Boolean);

  return {
    reply: risks.length
      ? `Bloqueios da demanda ${job.id}: ${risks.slice(0, 3).join(" | ")}`
      : `Demanda ${job.id} nao tem bloqueios registrados.`,
    intent,
    job,
    blockers: risks
  };
}

function jobNextStepForVoice(intent) {
  const job = resolveVoiceJob(intent.id);
  if (!job) {
    return missingJobReply(intent);
  }

  return {
    reply: `Proximo passo da demanda ${job.id}: ${nextStepForVoiceJob(job)}`,
    intent,
    job
  };
}

function jobStatusForVoice(intent) {
  if (intent.id) {
    const job = getJob(intent.id);
    if (!job) {
      return {
        reply: `Nao encontrei a demanda ${intent.id}.`,
        intent
      };
    }
    return {
      reply: `Demanda ${job.id}: ${job.status}. ${job.summary || job.goal}`,
      intent,
      job
    };
  }

  const jobs = listJobs(5);
  const summary = jobs.length
    ? jobs.map((job) => `Demanda ${job.id}: ${job.status}, ${job.mode}`).join(" | ")
    : "Nenhuma demanda registrada.";
  return {
    reply: summary,
    intent,
    jobs
  };
}

function resolveVoiceJob(id) {
  if (id) {
    return getJob(id);
  }
  return listJobs(1)[0] || null;
}

function missingJobReply(intent) {
  return {
    reply: intent.id ? `Nao encontrei a demanda ${intent.id}.` : "Nenhuma demanda registrada.",
    intent
  };
}

function latestArtifact(jobId, kind) {
  return [...listJobArtifacts(jobId)].reverse().find((artifact) => artifact.kind === kind) || null;
}

function latestJsonArtifact(jobId, kind) {
  const artifact = latestArtifact(jobId, kind);
  if (!artifact?.content) {
    return null;
  }
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function nextStepForVoiceJob(job) {
  if (job.status === "awaiting_confirm") {
    return "revise no cockpit e confirme visualmente se quiser permitir escrita.";
  }
  if (job.status === "needs_input") {
    return job.mode === "implement"
      ? "adicione uma orientacao de retomada ou aprove novamente depois de revisar a critica."
      : "retome o Conselho com uma orientacao curta ou ignore a rodada.";
  }
  if (job.status === "draft") {
    return job.mode === "analyze" ? "consultar o Conselho de IAs." : "aprovar ou detalhar a demanda.";
  }
  if (job.status === "running" || job.status === "queued") {
    return "aguardar a execucao atual ou cancelar se ela estiver errada.";
  }
  if (job.status === "done") {
    return job.mode === "analyze" ? "usar a Decisao do Conselho para criar uma implementacao confirmavel." : "revisar os artefatos gerados.";
  }
  if (job.status === "failed") {
    return "ler o erro e retomar com uma demanda menor ou mais contexto.";
  }
  return "nenhuma acao pendente.";
}

function sentenceForVoice(value) {
  return String(value || "")
    .trim()
    .replace(/[.!?]+$/u, "");
}

function cancelJobFromVoice(intent) {
  const job = getJob(intent.id);
  if (!job) {
    return {
      reply: `Nao encontrei a demanda ${intent.id}.`,
      intent
    };
  }

  if (cancelJobProcess(job.id)) {
    return {
      reply: `Cancelamento solicitado para a demanda ${job.id}.`,
      intent,
      job: getJob(job.id)
    };
  }

  if (["done", "failed", "cancelled"].includes(job.status)) {
    return {
      reply: `Demanda ${job.id} ja esta ${job.status}; nao ha execucao para cancelar.`,
      intent,
      job
    };
  }

  const cancelled = updateJobStatus(job.id, "cancelled", {
    summary: "Demanda cancelada por comando de voz."
  });
  return {
    reply: `Demanda ${job.id} cancelada.`,
    intent,
    job: cancelled
  };
}

function modeFromText(text) {
  const normalized = normalizeText(text);
  if (/\b(?:analisar|analise|debater|comparar|consultar)\b/.test(normalized)) {
    return "analyze";
  }
  if (/\b(?:implementar|corrigir|alterar|editar|criar arquivo)\b/.test(normalized)) {
    return "implement";
  }
  return "ask";
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}
