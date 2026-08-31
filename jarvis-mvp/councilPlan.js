const DEFAULT_VERIFICATIONS = [
  "npm run verify",
  "Validar no browser o fluxo Conselho -> plano -> execucao."
];

const FILE_HINTS = [
  {
    pattern: /\b(frontend|layout|visual|tela|cockpit|dashboard|aba|botao|card|rodape|carrossel|ux|ui)\b/i,
    files: ["index.html", "styles.css", "app.js"]
  },
  {
    pattern: /\b(voz|audio|microfone|realtime|live|gemini live|wake|standby)\b/i,
    files: ["realtime.js", "app.js", "server/voiceHealth.js", "server/voiceIntents.js"]
  },
  {
    pattern: /\b(conselho|gemini|grok|openrouter|analista|debate|sintese)\b/i,
    files: ["server/analystAdapter.js", "server/debateSynthesizer.js", "app.js"]
  },
  {
    pattern: /\b(custo|token|api key|apikey|billing|usd|dolar)\b/i,
    files: ["server/memory.js", "app.js", "styles.css"]
  },
  {
    pattern: /\b(memoria|sqlite|task|demanda|historico|rotina|workspace|pasta)\b/i,
    files: ["server/memory.js", "server/index.js", "app.js"]
  },
  {
    pattern: /\b(seguranca|privacidade|permissao|confirmacao|segredo|consentimento)\b/i,
    files: ["server/policy.js", "server/httpSecurity.js", "server/redaction.js", "app.js"]
  }
];

export function buildCouncilImplementationPlan(sourceJob = {}, synthesis = {}) {
  const summary = cleanText(synthesis.recommendation) || "Implementar a decisao aprovada pelo Conselho.";
  const consensus = normalizeItems(synthesis.consensus);
  const dissent = normalizeItems(synthesis.dissent);
  const risks = normalizeItems(synthesis.risks);
  const unverified = normalizeItems(synthesis.unverified);
  const likelyFiles = inferLikelyFiles([
    sourceJob.goal,
    summary,
    ...consensus,
    ...risks,
    ...unverified
  ].join("\n"));

  return {
    source: "council-decision",
    sourceJobId: sourceJob.id || null,
    title: sourceJob.id ? `Implementacao da demanda #${sourceJob.id}` : "Implementacao da decisao do Conselho",
    summary,
    confidence: cleanText(synthesis.confidence) || "baixa",
    steps: buildPlanSteps({ sourceJob, summary, consensus, dissent, risks, unverified }),
    likelyFiles,
    risks: risks.length ? risks.slice(0, 4) : ["Mudancas exigem confirmacao visual antes de escrever no workspace."],
    verification: verificationForPlan(summary),
    reviewOptions: ["Executar plano", "Revisar plano", "Pedir segunda opiniao"],
    generatedFrom: "debate-synthesis"
  };
}

export function implementationGoalFromPlan(sourceJob = {}, plan = {}) {
  const lines = [
    `Implementar a Decisao do Conselho da demanda #${sourceJob.id || "origem"}.`,
    "",
    `Objetivo original: ${cleanText(sourceJob.goal) || "Nao informado."}`,
    "",
    `Plano aprovado: ${cleanText(plan.summary) || "Sem resumo estruturado."}`,
    "",
    "Passos:",
    ...normalizeItems(plan.steps).map((step, index) => `${index + 1}. ${step}`),
    "",
    "Arquivos provaveis:",
    ...normalizeItems(plan.likelyFiles).map((file) => `- ${file}`),
    "",
    "Verificacoes esperadas:",
    ...normalizeItems(plan.verification).map((item) => `- ${item}`),
    "",
    "Antes de alterar arquivos, mantenha o escopo pequeno. Se precisar sair dos arquivos provaveis, explique no resumo e registre evidencia."
  ];
  return lines.join("\n");
}

export function implementationEvidenceFromArtifacts(job = {}, artifacts = []) {
  const changed = latestArtifact(artifacts, "changed-files");
  const changedFiles = filesFromChangedArtifact(changed);
  const tests = artifacts
    .filter((artifact) => artifact.kind === "test-log")
    .map(testEvidence)
    .filter(Boolean);
  const summary = cleanText(latestArtifact(artifacts, "codex-summary")?.content);
  const critic = latestArtifact(artifacts, "critic-review");
  const hasDiff = Boolean(cleanText(latestArtifact(artifacts, "diff")?.content));
  const outcome = outcomeForJob(job, tests, critic);

  return {
    sourceJobId: job?.metadata?.sourceJobId || job?.metadata?.councilPlan?.sourceJobId || null,
    changedFiles,
    tests,
    result: summary || fallbackResultForJob(job),
    outcome,
    hasDiff,
    resumePath: resumePathForJob(job),
    hasEvidence: changedFiles.length > 0 || tests.length > 0 || Boolean(summary) || hasDiff || ["done", "failed", "needs_input"].includes(job?.status)
  };
}

export function inferLikelyFiles(text) {
  const haystack = String(text || "");
  const files = [];
  for (const hint of FILE_HINTS) {
    if (hint.pattern.test(haystack)) {
      files.push(...hint.files);
    }
  }
  return unique(files).slice(0, 6);
}

function buildPlanSteps({ sourceJob, summary, consensus, dissent, risks, unverified }) {
  const steps = [
    `Revisar a demanda original${sourceJob.id ? ` #${sourceJob.id}` : ""} e confirmar que o escopo continua valido.`,
    firstSentence(summary) || "Aplicar a recomendacao aprovada pelo Conselho.",
    consensus.length ? `Priorizar consenso: ${firstSentence(consensus[0])}` : "",
    dissent.length || unverified.length ? "Resolver divergencias e itens nao verificados antes de ampliar o escopo." : "",
    risks.length ? `Mitigar risco principal: ${firstSentence(risks[0])}` : "",
    "Executar a implementacao, capturar arquivos alterados, testes e resultado final."
  ];
  return unique(steps.map(cleanText).filter(Boolean)).slice(0, 5);
}

function verificationForPlan(text) {
  const verifications = [...DEFAULT_VERIFICATIONS];
  if (/\b(voz|audio|microfone|realtime|live)\b/i.test(text)) {
    verifications.push("Validar conexao e fallback honesto de voz no cockpit.");
  }
  if (/\b(custo|token|dashboard|aba)\b/i.test(text)) {
    verifications.push("Validar dashboard visualmente sem overflow em desktop.");
  }
  return unique(verifications).slice(0, 4);
}

function latestArtifact(artifacts, kind) {
  return [...(artifacts || [])].reverse().find((artifact) => artifact.kind === kind) || null;
}

function filesFromChangedArtifact(artifact) {
  if (!artifact) {
    return [];
  }
  const metadataFiles = Array.isArray(artifact.metadata?.files) ? artifact.metadata.files : [];
  const contentFiles = String(artifact.content || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return unique([...metadataFiles, ...contentFiles]).slice(0, 20);
}

function testEvidence(artifact) {
  const command = [artifact.metadata?.command, ...(artifact.metadata?.args || [])].filter(Boolean).join(" ");
  const exitCode = artifact.metadata?.exitCode;
  return {
    command: command || artifact.label || "Teste registrado",
    status: exitCode === 0 ? "passou" : "revisar",
    exitCode,
    timedOut: artifact.metadata?.timedOut === true
  };
}

function outcomeForJob(job, tests, critic) {
  if (job?.status === "done" && tests.every((test) => test.status === "passou")) {
    return critic?.metadata?.gate === "block" ? "Concluido com critica pendente" : "Concluido com verificacao registrada";
  }
  if (job?.status === "failed") {
    return "Falhou; retomar execucao ou revisar plano";
  }
  if (job?.status === "needs_input") {
    return "Aguardando decisao para retomar";
  }
  return "Evidencia em preparacao";
}

function fallbackResultForJob(job) {
  if (job?.error) {
    return job.error;
  }
  if (job?.summary) {
    return job.summary;
  }
  return "Resultado ainda nao registrado.";
}

function resumePathForJob(job) {
  if (job?.status === "failed") {
    return "Revisar erro, ajustar o plano e retomar com confirmacao.";
  }
  if (job?.status === "needs_input") {
    return "Adicionar orientacao e retomar execucao pelo cockpit.";
  }
  if (job?.status === "done") {
    return "Voltar para a decisao original ou revisar artefatos.";
  }
  return "Aguardar conclusao ou pausar a demanda.";
}

function normalizeItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.map((item) => cleanText(typeof item === "string" ? item : item?.text)).filter(Boolean);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function firstSentence(text) {
  const value = cleanText(text);
  const match = value.match(/^(.{1,180}?)(?:[.!?]|$)/);
  return cleanText(match?.[1] || value).slice(0, 180);
}

function unique(items) {
  return [...new Set(items.map(cleanText).filter(Boolean))];
}
