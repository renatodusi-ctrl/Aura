import fs from "node:fs";
import path from "node:path";
import { ROOT_DIR } from "../server/config.js";
import {
  addMemory,
  addTask,
  createJob,
  createJobArtifact,
  getCostSummary,
  initMemory,
  listJobArtifacts,
  listJobs,
  listMemories,
  listTasks,
  recordCostUsage,
  updateJobStatus
} from "../server/memory.js";

const DEMO_PREFIX = "AURA DEMO ::";
const demoWorkspace = path.join(ROOT_DIR, "demo-workspace");

const scenes = [
  {
    id: "voice-standby",
    title: "Voz em standby com wake word",
    success: "AURA conecta, mostra metricas de voz e responde apenas apos ouvir Aura."
  },
  {
    id: "council-briefing",
    title: "Conselho sintetiza decisao",
    success: "Gemini, Grok e OpenRouter aparecem como analistas e a decisao fica no HUD."
  },
  {
    id: "confirmable-implementation",
    title: "Implementacao confirmavel",
    success: "Codex aparece aguardando confirmacao visual antes de escrever."
  },
  {
    id: "privacy-recovery",
    title: "Privacidade e recuperacao",
    success: "Evidencias e memorias podem ser apagadas; falhas mostram proximo passo."
  }
];

if (process.argv.includes("--dry-run")) {
  console.log(JSON.stringify({ ok: true, mutations: false, scenes }, null, 2));
  process.exit(0);
}

initMemory();
fs.mkdirSync(demoWorkspace, { recursive: true });

const created = {
  tasks: [],
  memories: [],
  jobs: [],
  costs: []
};

ensureMemory("preference", `${DEMO_PREFIX} preferir briefing executivo com decisao, risco e proxima acao.`);
ensureMemory("project", `${DEMO_PREFIX} cockpit AURA local em ${ROOT_DIR}.`);

ensureTask(`${DEMO_PREFIX} Validar voz em standby e barge-in`);
ensureTask(`${DEMO_PREFIX} Gravar cena do Conselho sintetizando decisao`);
ensureTask(`${DEMO_PREFIX} Revisar privacidade antes da demo`);

const council = ensureJob({
  goal: `${DEMO_PREFIX} Conselho avalia uma melhoria visual do HUD de missao unica`,
  workspace: ROOT_DIR,
  mode: "analyze",
  policyLevel: "read",
  summary: "Demo: Conselho gerou decisao executiva com riscos e proxima acao."
});
ensureArtifact(council.id, "debate-synthesis", "Demo decisao do Conselho", {
  recommendation: "Manter HUD focado em Agora, Decisao agora e um CTA real.",
  confidence: "high",
  consensus: ["Hierarquia clara", "Detalhes tecnicos em drawers"],
  dissent: [{ source: "Grok", text: "Evitar excesso de chips sempre visiveis." }],
  risks: [{ text: "Validar mobile antes da gravacao." }],
  nextActions: ["Abrir cockpit", "Mostrar Conselho", "Criar implementacao confirmavel"]
});

ensureJob({
  goal: `${DEMO_PREFIX} Implementar uma micro melhoria visual apos aprovacao`,
  workspace: demoWorkspace,
  mode: "implement",
  policyLevel: "write",
  requiresConfirmation: true,
  targetStatus: "awaiting_confirm",
  summary: "Demo: aguardando confirmacao visual antes de Codex escrever."
});

ensureJob({
  goal: `${DEMO_PREFIX} Demonstrar fallback de provedor indisponivel sem mascarar falha`,
  workspace: ROOT_DIR,
  mode: "ask",
  policyLevel: "read",
  targetStatus: "needs_input",
  summary: "Demo: falha degradada com proximo passo claro.",
  error: "Provider temporarily unavailable; retry after health-check."
});

ensureCostUsage({
  provider: "gemini",
  keyLabel: "GEMINI_API_KEY",
  model: "gemini-3.1-flash-live-preview",
  source: "demo",
  operation: "voice.demo",
  usage: { textInputTokens: 1200, textOutputTokens: 600, audioInputTokens: 900, audioOutputTokens: 700 }
});

ensureCostUsage({
  provider: "openrouter",
  keyLabel: "OPENROUTER_API_KEY",
  model: "openrouter/demo-review",
  source: "demo",
  operation: "council.demo",
  usage: { textInputTokens: 1400, textOutputTokens: 800 },
  estimatedCostUsd: 0.0042
});

console.log(JSON.stringify({
  ok: true,
  mutations: true,
  demoWorkspace,
  scenes,
  created
}, null, 2));

function ensureMemory(kind, content) {
  const existing = listMemories(200).find((memory) => memory.kind === kind && memory.content === content);
  if (existing) {
    return existing;
  }
  const memory = addMemory({ kind, content });
  created.memories.push(memory);
  return memory;
}

function ensureTask(title) {
  const existing = listTasks(true).find((task) => task.title === title);
  if (existing) {
    return existing;
  }
  const task = addTask({ title });
  created.tasks.push(task);
  return task;
}

function ensureJob({ goal, workspace, mode, policyLevel, requiresConfirmation = false, targetStatus = "done", summary = "", error = "" }) {
  const existing = listJobs(200).find((job) => job.goal === goal);
  if (existing) {
    return existing;
  }
  const job = createJob({
    goal,
    workspace,
    mode,
    requestedBy: "text",
    policyLevel,
    requiresConfirmation,
    metadata: { demo: true, scene: goal.replace(DEMO_PREFIX, "").trim() }
  });

  let finalJob = job;
  if (targetStatus === "done") {
    finalJob = updateJobStatus(job.id, "running");
    finalJob = updateJobStatus(job.id, "done", { summary });
  } else if (targetStatus === "awaiting_confirm") {
    finalJob = updateJobStatus(job.id, "awaiting_confirm", { summary });
  } else if (targetStatus === "needs_input") {
    finalJob = updateJobStatus(job.id, "needs_input", { summary, error });
  }
  created.jobs.push(finalJob);
  return finalJob;
}

function ensureArtifact(jobId, kind, label, content) {
  const existing = listJobArtifacts(jobId).find((artifact) => artifact.kind === kind && artifact.label === label);
  if (existing) {
    return existing;
  }
  const serialized = typeof content === "string" ? content : JSON.stringify(content, null, 2);
  return createJobArtifact(jobId, {
    kind,
    label,
    content: serialized,
    metadata: { demo: true }
  });
}

function ensureCostUsage(entry) {
  const existing = getCostSummary(200).recent.find((usage) => (
    usage.provider === entry.provider
      && usage.source === entry.source
      && usage.operation === entry.operation
      && usage.model === entry.model
  ));
  if (existing) {
    return existing;
  }
  const usage = recordCostUsage(entry);
  created.costs.push(usage);
  return usage;
}
