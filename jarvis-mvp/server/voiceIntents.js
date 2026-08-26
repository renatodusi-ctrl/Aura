import { ROOT_DIR } from "./config.js";
import { createJob, getJob, listJobs, updateJobStatus } from "./memory.js";
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

  const cancel = normalized.match(/\b(?:cancelar|cancele|parar|pare)\s+(?:(?:o|do)\s+)?job\s+(\d+)\b/);
  if (cancel) {
    return { type: "job.cancel", id: Number(cancel[1]) };
  }

  const statusOne = normalized.match(/\b(?:status|consultar|consulte|como esta|ver)\s+(?:(?:o|do)\s+)?job\s+(\d+)\b/);
  if (statusOne) {
    return { type: "job.status", id: Number(statusOne[1]) };
  }

  if (/\b(?:status|consultar|listar|mostrar)\s+(?:dos\s+)?jobs\b/.test(normalized)) {
    return { type: "job.status", id: null };
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
    timeoutMs: 300000,
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
      ? `Job ${finalJob.id} criado. Precisa de confirmacao visual antes de escrever.`
      : `Job ${finalJob.id} criado em modo ${finalJob.mode}.`,
    intent: { type: "job.create", mode: finalJob.mode },
    job: finalJob
  };
}

function jobStatusForVoice(intent) {
  if (intent.id) {
    const job = getJob(intent.id);
    if (!job) {
      return {
        reply: `Nao encontrei o job ${intent.id}.`,
        intent
      };
    }
    return {
      reply: `Job ${job.id}: ${job.status}. ${job.summary || job.goal}`,
      intent,
      job
    };
  }

  const jobs = listJobs(5);
  const summary = jobs.length
    ? jobs.map((job) => `Job ${job.id}: ${job.status}, ${job.mode}`).join(" | ")
    : "Nenhum job registrado.";
  return {
    reply: summary,
    intent,
    jobs
  };
}

function cancelJobFromVoice(intent) {
  const job = getJob(intent.id);
  if (!job) {
    return {
      reply: `Nao encontrei o job ${intent.id}.`,
      intent
    };
  }

  if (cancelJobProcess(job.id)) {
    return {
      reply: `Cancelamento solicitado para o job ${job.id}.`,
      intent,
      job: getJob(job.id)
    };
  }

  if (["done", "failed", "cancelled"].includes(job.status)) {
    return {
      reply: `Job ${job.id} ja esta ${job.status}; nao ha execucao para cancelar.`,
      intent,
      job
    };
  }

  const cancelled = updateJobStatus(job.id, "cancelled", {
    summary: "Job cancelado por comando de voz."
  });
  return {
    reply: `Job ${job.id} cancelado.`,
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
