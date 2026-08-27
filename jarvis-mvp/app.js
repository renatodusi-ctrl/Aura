import { RealtimeClient } from "./realtime.js";

const state = {
  status: null,
  tasks: [],
  memories: [],
  costs: null,
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  selectedJobEvents: [],
  selectedJobArtifacts: [],
  events: [],
  demandFilter: "all",
  sessionTab: "tasks",
  topView: "cockpit",
  composerIntent: "chat",
  taskExecutor: "codex",
  attachments: [],
  activeDemandTab: "summary",
  routineEnabled: localStorage.getItem("aura.routineEnabled") === "true",
  screenStream: null,
  realtime: null,
  recordedRealtimeUsage: new Set(),
  sessionToken: ""
};

const els = {
  realtimePill: document.querySelector("#realtime-pill"),
  privacyPill: document.querySelector("#privacy-pill"),
  tasksPill: document.querySelector("#tasks-pill"),
  topNextStep: document.querySelector("#top-next-step"),
  routineToggle: document.querySelector("#routine-toggle"),
  voiceButton: document.querySelector("#voice-button"),
  screenButton: document.querySelector("#screen-button"),
  stopScreenButton: document.querySelector("#stop-screen-button"),
  localForm: document.querySelector("#local-form"),
  localInput: document.querySelector("#local-input"),
  localSubmitButton: document.querySelector("#local-submit-button"),
  attachmentInput: document.querySelector("#attachment-input"),
  attachmentTray: document.querySelector("#attachment-tray"),
  composerIntentButtons: Array.from(document.querySelectorAll("[data-composer-intent]")),
  conversation: document.querySelector("#conversation"),
  taskForm: document.querySelector("#task-form"),
  taskInput: document.querySelector("#task-input"),
  taskList: document.querySelector("#task-list"),
  memoryForm: document.querySelector("#memory-form"),
  memoryInput: document.querySelector("#memory-input"),
  memoryList: document.querySelector("#memory-list"),
  costsRefreshButton: document.querySelector("#costs-refresh-button"),
  costsPanel: document.querySelector("#costs-panel"),
  topCostsRefreshButton: document.querySelector("#top-costs-refresh-button"),
  topCostsPanel: document.querySelector("#top-costs-panel"),
  topCostPanel: document.querySelector("[data-top-panel='costs']"),
  topViewButtons: Array.from(document.querySelectorAll("[data-top-view]")),
  jobsRefreshButton: document.querySelector("#jobs-refresh-button"),
  demandHistorySummary: document.querySelector("#demand-history-summary"),
  demandFilterButtons: Array.from(document.querySelectorAll("[data-demand-filter]")),
  jobList: document.querySelector("#job-list"),
  jobDetail: document.querySelector("#job-detail"),
  activeDemand: document.querySelector("#active-demand"),
  aiCouncil: document.querySelector("#ai-council"),
  sessionTabButtons: Array.from(document.querySelectorAll("[data-session-tab]")),
  sessionPanels: Array.from(document.querySelectorAll("[data-session-panel]")),
  eventLog: document.querySelector("#event-log"),
  screenVideo: document.querySelector("#screen-video"),
  routinePanel: document.querySelector("#routine-panel"),
  toolsList: document.querySelector("#tools-list"),
  integrationsList: document.querySelector("#integrations-list"),
  localContextSummary: document.querySelector("#local-context-summary")
};

init();

async function init() {
  await loadSession();

  state.realtime = new RealtimeClient({
    onStatus: setVoiceStatus,
    onEvent: (event) => {
      logEvent(event.type, event);
      if (event.type === "response.done") {
        recordRealtimeUsage(event).catch((error) => logEvent("cost.usage.failed", { error: error.message }));
        refreshAll();
      }
    },
    onTranscript: appendAssistantDelta,
    onToolCall: handleRealtimeToolCall,
    sessionToken: () => state.sessionToken
  });

  bindEvents();
  await refreshAll();
  renderRoutine();
  setInterval(() => {
    refreshJobs().catch((error) => logEvent("jobs.refresh.failed", { error: error.message }));
  }, 5000);
}

async function loadSession() {
  const response = await fetch("/api/session");
  const data = await response.json();
  if (!response.ok || !data.token) {
    throw new Error("Could not establish local AURA session.");
  }
  state.sessionToken = data.token;
}

function bindEvents() {
  els.routineToggle.checked = state.routineEnabled;
  els.routineToggle.addEventListener("change", () => {
    state.routineEnabled = els.routineToggle.checked;
    localStorage.setItem("aura.routineEnabled", String(state.routineEnabled));
    renderRoutine();
  });

  els.voiceButton.addEventListener("click", async () => {
    if (els.voiceButton.dataset.connected === "true") {
      state.realtime.disconnect();
      return;
    }

    try {
      appendMessage("system", "Vou abrir o microfone e ficar em standby. Diga Aura para me chamar.");
      await state.realtime.connect();
      els.voiceButton.dataset.connected = "true";
      els.voiceButton.textContent = "Desconectar voz";
    } catch (error) {
      logEvent("voice.connect.failed", {
        status: error.status || null,
        type: error.type || null,
        code: error.code || null,
        message: error.message
      });
      appendMessage("system", `Nao consegui abrir a voz ao vivo porque ${humanizeVoiceError(error)}. Podemos continuar por texto local.`);
      setVoiceStatus("fallback");
    }
  });

  els.localForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = els.localInput.value.trim();
    const attachments = [...state.attachments];
    if (!text && !attachments.length) {
      updateComposerValidation();
      return;
    }
    const messageText = text || "Analise os anexos enviados.";
    await withBusyButton(els.localSubmitButton, "Enviando", async () => {
      els.localInput.value = "";
      clearAttachments();
      appendMessage("user", messageText, attachments);

      if (state.composerIntent !== "chat") {
        await createComposerDemand(messageText, attachments);
        return;
      }

      if (state.realtime?.sendText(messageText, attachments)) {
        return;
      }

      const response = await api("/api/local/chat", {
        method: "POST",
        body: {
          text: messageText,
          attachments: attachments.map(attachmentSummary),
          activeJob: activeJobSummary()
        }
      });
      appendMessage("assistant", response.reply);
      if (response.job?.id) {
        state.selectedJobId = response.job.id;
      }
      await refreshAll();
    });
    updateComposerValidation();
  });

  els.composerIntentButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.composerIntent = button.dataset.composerIntent;
      renderComposerIntents();
    });
  });

  els.attachmentInput.addEventListener("change", async () => {
    await addAttachments(els.attachmentInput.files);
    els.attachmentInput.value = "";
  });

  els.localInput.addEventListener("input", updateComposerValidation);
  els.taskInput.addEventListener("input", () => updateSubmitButton(els.taskForm, Boolean(els.taskInput.value.trim())));
  els.memoryInput.addEventListener("input", () => updateSubmitButton(els.memoryForm, Boolean(els.memoryInput.value.trim())));

  els.taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = els.taskInput.value.trim();
    if (!title) {
      return;
    }
    els.taskInput.value = "";
    await withBusyButton(els.taskForm.querySelector("button[type='submit']"), "Adicionando", async () => {
      await api("/api/tasks", { method: "POST", body: { title } });
      await refreshAll();
    });
    updateSubmitButton(els.taskForm, false);
  });

  els.memoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = els.memoryInput.value.trim();
    if (!content) {
      return;
    }
    els.memoryInput.value = "";
    await withBusyButton(els.memoryForm.querySelector("button[type='submit']"), "Guardando", async () => {
      await api("/api/memories", { method: "POST", body: { kind: "note", content } });
      await refreshAll();
    });
    updateSubmitButton(els.memoryForm, false);
  });

  els.screenButton.addEventListener("click", startScreenCapture);
  els.stopScreenButton.addEventListener("click", stopScreenCapture);
  els.costsRefreshButton.addEventListener("click", refreshCosts);
  els.topCostsRefreshButton.addEventListener("click", refreshCosts);
  els.jobsRefreshButton.addEventListener("click", refreshJobs);
  els.topViewButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.topView = button.dataset.topView;
      renderTopView();
      if (state.topView === "costs") {
        refreshCosts().catch((error) => logEvent("costs.refresh.failed", { error: error.message }));
      }
    });
  });
  els.demandFilterButtons.forEach((button) => {
    button.addEventListener("click", async () => {
      state.demandFilter = button.dataset.demandFilter;
      state.selectedJobId = null;
      await loadSelectedJob();
      renderJobs();
    });
  });
  els.sessionTabButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.sessionTab = button.dataset.sessionTab;
      renderSessionTabs();
    });
  });
  updateComposerValidation();
  updateSubmitButton(els.taskForm, false);
  updateSubmitButton(els.memoryForm, false);
}

async function createComposerDemand(text, attachments = []) {
  const mode = state.composerIntent === "execute" ? "implement" : "analyze";
  const attachmentContext = attachments.length ? `\n\nAnexos: ${attachments.map((attachment) => `${attachment.kind} ${attachment.name}`).join("; ")}` : "";
  try {
    const result = await api("/api/jobs", {
      method: "POST",
      body: {
        goal: `${text}${attachmentContext}`,
        mode,
        requestedBy: "text",
        metadata: {
          source: "composer-intent",
          intent: state.composerIntent,
          attachments: attachments.map(attachmentSummary)
        }
      }
    });
    state.selectedJobId = result.job.id;
    state.demandFilter = "all";
    appendMessage(
      "assistant",
      state.composerIntent === "execute"
        ? `Demanda ${result.job.id} preparada para execucao com Codex. Revise a confirmacao visual antes de escrever.`
        : `Demanda ${result.job.id} enviada para o Conselho de IAs.`
    );
    await refreshAll();
  } catch (error) {
    appendMessage("system", `Demanda nao criada: ${humanizeJobMessage(error.message, error.details)}`);
  }
}

async function developTask(taskId, executor = "codex", source = "task-action") {
  try {
    const result = await api(`/api/tasks/${taskId}/develop`, {
      method: "POST",
      body: { source, requestedBy: "text", executor }
    });
    state.selectedJobId = result.job.id;
    state.demandFilter = "all";
    appendMessage("assistant", result.reply);
    await refreshAll();
    document.querySelector(".active-demand-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    appendMessage("system", `Nao consegui criar a demanda da task: ${humanizeJobMessage(error.message, error.details)}`);
  }
}

async function addAttachments(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (!isSupportedAttachment(file)) {
      appendMessage("system", `Anexo ignorado: ${file.name} nao e imagem nem audio.`);
      continue;
    }
    if (file.size > 8 * 1024 * 1024) {
      appendMessage("system", `Anexo ignorado: ${file.name} passa de 8 MB.`);
      continue;
    }
    if (state.attachments.length >= 4) {
      appendMessage("system", "Limite de 4 anexos por mensagem.");
      break;
    }
    state.attachments.push(await fileToAttachment(file));
  }
  renderAttachmentTray();
}

function isSupportedAttachment(file) {
  return file?.type?.startsWith("image/") || file?.type?.startsWith("audio/");
}

function fileToAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      resolve({
        id: crypto.randomUUID(),
        name: file.name,
        type: file.type,
        size: file.size,
        kind: file.type.startsWith("image/") ? "imagem" : "audio",
        dataUrl: String(reader.result || "")
      });
    });
    reader.addEventListener("error", () => reject(reader.error));
    reader.readAsDataURL(file);
  });
}

function renderAttachmentTray() {
  els.attachmentTray.replaceChildren(...state.attachments.map((attachment) => {
    const item = document.createElement("span");
    item.className = "attachment-chip";

    const label = document.createElement("span");
    label.textContent = `${attachment.kind}: ${attachment.name}`;

    const remove = iconButton("x", `Remover ${attachment.name}`);
    remove.addEventListener("click", () => {
      state.attachments = state.attachments.filter((candidate) => candidate.id !== attachment.id);
      renderAttachmentTray();
    });

    item.append(label, remove);
    return item;
  }));
  updateComposerValidation();
}

function clearAttachments() {
  state.attachments = [];
  renderAttachmentTray();
}

function attachmentSummary(attachment) {
  return {
    name: attachment.name,
    type: attachment.type,
    kind: attachment.kind,
    size: attachment.size
  };
}

function activeJobSummary() {
  if (!state.selectedJob) {
    return null;
  }
  return {
    id: state.selectedJob.id,
    goal: state.selectedJob.goal,
    mode: state.selectedJob.mode,
    status: state.selectedJob.status
  };
}

async function refreshAll() {
  const [status, tasksData, memoriesData, jobsData, costsData] = await Promise.all([
    api("/api/status"),
    api("/api/tasks"),
    api("/api/memories"),
    api("/api/jobs?limit=20"),
    api("/api/costs")
  ]);

  state.status = status;
  state.tasks = tasksData.tasks;
  state.memories = memoriesData.memories;
  state.jobs = jobsData.jobs;
  state.costs = costsData;
  await loadSelectedJob();
  renderStatus();
  renderTopNextStep();
  renderTopView();
  renderTasks();
  renderMemories();
  renderJobs();
  renderTools();
  renderCosts();
  renderIntegrations();
  renderLocalContextSummary();
  renderComposerIntents();
  renderCouncil();
  renderSessionTabs();
  renderRoutine();
}

async function refreshJobs() {
  const jobsData = await api("/api/jobs?limit=20");
  state.jobs = jobsData.jobs;
  await loadSelectedJob();
  renderJobs();
  renderCouncil();
  renderLocalContextSummary();
  renderTopNextStep();
}

async function refreshCosts() {
  state.costs = await api("/api/costs");
  renderCosts();
}

async function loadSelectedJob() {
  const candidates = filteredJobs();
  if (!candidates.length) {
    state.selectedJobId = null;
    state.selectedJob = null;
    state.selectedJobEvents = [];
    state.selectedJobArtifacts = [];
    return;
  }

  if (!state.selectedJobId || !candidates.some((job) => job.id === state.selectedJobId)) {
    state.selectedJobId = candidates[0].id;
  }

  const detail = await api(`/api/jobs/${state.selectedJobId}`);
  state.selectedJob = detail.job;
  state.selectedJobEvents = detail.events || [];
  state.selectedJobArtifacts = detail.artifacts || [];
}

function renderStatus() {
  els.privacyPill.textContent = "Local privado";
  els.privacyPill.title = "Servidor local em 127.0.0.1; chave OpenAI fica no servidor.";

  const voiceProvider = state.status.realtimeProvider === "gemini" ? "Gemini Live" : "OpenAI";
  els.realtimePill.textContent = state.status.realtimeEnabled ? `Voz: ${voiceProvider}` : "Voz local";
  els.realtimePill.className = `pill ${state.status.realtimeEnabled ? "ok" : "warn"}`;
  els.realtimePill.title = state.status.realtimeEnabled
    ? `${voiceProvider} · ${state.status.realtimeModel} · voz ${state.status.realtimeVoice}.`
    : "Voz ao vivo indisponivel; AURA opera com fallback local.";

  els.tasksPill.textContent = `${state.status.memory.openTasks} tarefas abertas`;
  els.tasksPill.className = "pill";

  renderIntegrations();
}

function renderTopNextStep() {
  if (!els.topNextStep) {
    return;
  }

  if (state.selectedJob) {
    els.topNextStep.textContent = nextStepForJob(state.selectedJob);
    return;
  }

  const openTasks = state.tasks.filter((task) => task.status !== "done").length;
  if (openTasks) {
    els.topNextStep.textContent = `Escolha uma das ${openTasks} tarefas abertas e defina Codex, Conselho ou Codex + Conselho.`;
    return;
  }

  els.topNextStep.textContent = "Diga ou escreva uma missao para AURA organizar o trabalho.";
}

function renderTopView() {
  const showCosts = state.topView === "costs";
  els.topViewButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.topView === state.topView));
  });
  document.querySelector(".cockpit").hidden = showCosts;
  document.querySelector(".jobs-panel").hidden = showCosts;
  document.querySelector(".session-panel").hidden = showCosts;
  if (els.topCostPanel) {
    els.topCostPanel.hidden = !showCosts;
  }
}

function renderComposerIntents() {
  els.composerIntentButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.composerIntent === state.composerIntent));
  });
  updateComposerValidation();
}

function renderIntegrations() {
  if (!state.status || !els.integrationsList) {
    return;
  }

  const providers = state.status.providers || {};
  const items = [
    {
      name: "Voz ao vivo",
      role: state.status.realtimeProvider === "gemini" ? "Gemini Live" : "OpenAI Realtime",
      detail: state.status.realtimeEnabled ? `${state.status.realtimeModel} · ${state.status.realtimeVoice}` : "fallback local por texto",
      state: state.status.realtimeEnabled ? "available" : "checking"
    },
    integrationItemForProvider("Codex", providers.codex),
    integrationItemForProvider("Gemini", providers.gemini),
    integrationItemForProvider("Grok", providers.grok),
    integrationItemForProvider("OpenRouter", providers.openrouter),
    {
      name: "Workspace",
      role: "Cockpit local",
      detail: "127.0.0.1 · dados locais",
      state: "available"
    }
  ];

  els.integrationsList.replaceChildren(...items.map((item) => {
    const row = document.createElement("article");
    row.className = `integration-card ${item.state}`;

    const dot = document.createElement("span");
    dot.className = "integration-dot";
    dot.setAttribute("aria-hidden", "true");

    const body = document.createElement("div");
    body.className = "integration-body";
    const title = document.createElement("strong");
    title.textContent = item.name;
    const role = document.createElement("span");
    role.textContent = item.role || "IA conectada";
    const detail = document.createElement("small");
    detail.textContent = item.detail;
    body.append(title, role, detail);

    const state = document.createElement("span");
    state.className = "integration-state";
    state.textContent = labelForIntegrationState(item.state);

    row.append(dot, body, state);
    return row;
  }));
}

function integrationItemForProvider(name, provider = {}) {
  const status = provider.status || (provider.available ? "available" : "unavailable");
  return {
    name: provider.label || name,
    role: roleForProvider(provider.name || name),
    detail: provider.available
      ? provider.version || "CLI disponivel"
      : provider.error || "nao configurado neste ambiente",
    state: status
  };
}

function roleForProvider(name) {
  const key = String(name || "").toLowerCase();
  if (key.includes("codex")) {
    return "Executor local";
  }
  if (key.includes("gemini")) {
    return "Analise e voz";
  }
  if (key.includes("grok")) {
    return "Critica e riscos";
  }
  if (key.includes("openrouter")) {
    return "Roteador de modelos";
  }
  return "Integracao";
}

function labelForIntegrationState(status) {
  const labels = {
    available: "pronto",
    unavailable: "off",
    checking: "local"
  };
  return labels[status] || status;
}

function renderCouncil() {
  const seats = [
    councilSeatFor("codex", "Codex", "Executor local", "Arquivos, comandos e workspace."),
    councilSeatFor("gemini", "Gemini", "Analise alternativa", "Amplitude, contexto e comparacao."),
    councilSeatFor("grok", "Grok", "Critica e riscos", "Contrapontos, riscos e caminhos alternativos."),
    councilSeatFor("openrouter", "OpenRouter", "Roteador de modelos", "Parecer externo via modelos roteados.")
  ];

  els.aiCouncil.replaceChildren(...seats.map((seat) => {
    const item = document.createElement("article");
    item.className = `council-seat ${seat.state}`;

    const header = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = seat.name;
    const role = document.createElement("span");
    role.textContent = seat.role;
    header.append(title, role);

    const state = document.createElement("small");
    state.className = "council-state";
    state.textContent = seat.label;

    const summary = document.createElement("p");
    summary.textContent = seat.summary;

    item.append(header, state, summary);
    return item;
  }));
}

function councilSeatFor(key, name, role, idleSummary) {
  const provider = state.status?.providers?.[key];
  if (provider && !provider.available) {
    return {
      name,
      role,
      state: "unavailable",
      label: "indisponivel",
      summary: provider.error || `${name} nao esta disponivel neste ambiente.`
    };
  }

  const job = state.selectedJob;
  if (!job) {
    return {
      name,
      role,
      state: "ready",
      label: provider?.available ? "pronto" : "aguardando",
      summary: idleSummary
    };
  }

  if (key === "codex") {
    return codexCouncilState(job, name, role);
  }

  return analystCouncilState(job, key, name, role);
}

function codexCouncilState(job, name, role) {
  if (job.mode === "implement") {
    if (job.status === "awaiting_confirm") {
      return { name, role, state: "waiting", label: "aguardando", summary: "Pronto para executar depois da sua confirmacao visual." };
    }
    if (job.status === "running") {
      return { name, role, state: "thinking", label: "executando", summary: "Codex esta trabalhando no workspace local." };
    }
    if (job.status === "done") {
      return { name, role, state: "ready", label: "concluido", summary: "Execucao finalizada; confira os artefatos da demanda." };
    }
    if (job.status === "failed") {
      return { name, role, state: "error", label: "erro", summary: "Execucao bloqueada ou falhou; veja o resumo da demanda." };
    }
    return { name, role, state: "waiting", label: "aguardando", summary: "Demanda preparada para execucao local." };
  }

  return { name, role, state: "ready", label: "pronto", summary: "Executor em espera; esta demanda ainda nao pediu escrita local." };
}

function analystCouncilState(job, key, name, role) {
  const hasResponse = state.selectedJobArtifacts.some((artifact) => artifact.kind === "analyst-response" && artifact.metadata?.name === key);
  if (hasResponse) {
    return { name, role, state: "ready", label: "respondeu", summary: `${name} ja contribuiu para esta demanda.` };
  }
  if (job.mode === "analyze") {
    if (job.status === "running") {
      return { name, role, state: "thinking", label: "pensando", summary: `${name} pode estar analisando esta demanda.` };
    }
    if (job.status === "failed") {
      return { name, role, state: "error", label: "erro", summary: `${name} nao retornou uma contribuicao valida para esta demanda.` };
    }
    return { name, role, state: "waiting", label: "aguardando", summary: "Aguardando consulta do conselho para analisar a demanda." };
  }

  return { name, role, state: "ready", label: "pronto", summary: "Disponivel para contraponto quando voce consultar o conselho." };
}

function councilSummaryForJob(job) {
  if (job.mode === "analyze") {
    return "Gemini, Grok e OpenRouter entram como analistas; Codex permanece em espera ate haver decisao de execucao.";
  }
  if (job.mode === "implement") {
    return "Codex e o executor desta demanda; Gemini e Grok continuam visiveis para revisao e contraponto.";
  }
  return "Conselho em espera. Use Consultar conselho para pedir analise de Gemini e Grok.";
}

function renderTasks() {
  els.taskList.replaceChildren(...state.tasks.map((task) => {
    const item = document.createElement("li");
    item.className = task.status === "done" ? "done" : "";

    const label = document.createElement("span");
    label.textContent = task.title;

    const actions = document.createElement("div");
    actions.className = "row-actions";

    const executor = document.createElement("select");
    executor.className = "task-executor";
    executor.setAttribute("aria-label", `Executor para ${task.title}`);
    for (const [value, labelText] of [
      ["codex", "Codex"],
      ["council", "Conselho"],
      ["codex-council", "Codex + Conselho"]
    ]) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = labelText;
      executor.append(option);
    }
    executor.value = state.taskExecutor;
    executor.addEventListener("change", () => {
      state.taskExecutor = executor.value;
    });

    const developButton = document.createElement("button");
    developButton.type = "button";
    developButton.className = "task-dev-button";
    developButton.textContent = "Desenvolver";
    developButton.addEventListener("click", async () => {
      await withBusyButton(developButton, "Criando", async () => {
        await developTask(task.id, executor.value);
      });
    });

    const doneButton = iconButton(task.status === "done" ? "↩" : "✓", task.status === "done" ? "Reabrir" : "Concluir");
    doneButton.addEventListener("click", async () => {
      await withBusyButton(doneButton, "...", async () => {
        await api(`/api/tasks/${task.id}`, {
          method: "PATCH",
          body: { status: task.status === "done" ? "open" : "done" }
        });
        await refreshAll();
      });
    });

    const deleteButton = iconButton("×", "Excluir");
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Excluir tarefa "${task.title}"?`)) {
        return;
      }
      await withBusyButton(deleteButton, "...", async () => {
        await api(`/api/tasks/${task.id}?confirm=true`, { method: "DELETE" });
        await refreshAll();
      });
    });

    actions.append(executor, developButton, doneButton, deleteButton);
    item.append(label, actions);
    return item;
  }));
}

function renderMemories() {
  els.memoryList.replaceChildren(...state.memories.map((memory) => {
    const item = document.createElement("li");
    const content = document.createElement("span");
    content.textContent = memory.content;

    const deleteButton = iconButton("×", "Excluir memoria");
    deleteButton.addEventListener("click", async () => {
      if (!confirm("Excluir esta memoria local?")) {
        return;
      }
      await withBusyButton(deleteButton, "...", async () => {
        await api(`/api/memories/${memory.id}?confirm=true`, { method: "DELETE" });
        await refreshAll();
      });
    });

    item.append(content, deleteButton);
    return item;
  }));
}

function renderJobs() {
  renderDemandHistorySummary();
  renderDemandFilters();

  if (!state.jobs.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nenhuma demanda registrada.";
    els.jobList.replaceChildren(empty);
    renderJobDetail();
    renderActiveDemand();
    renderCouncil();
    return;
  }

  const jobs = filteredJobs();
  if (!jobs.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nenhuma demanda neste filtro.";
    els.jobList.replaceChildren(empty);
    renderJobDetail();
    renderActiveDemand();
    renderCouncil();
    return;
  }

  els.jobList.replaceChildren(...jobs.map((job) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `job-row ${job.id === state.selectedJobId ? "selected" : ""}`;
    button.setAttribute("aria-pressed", String(job.id === state.selectedJobId));

    const title = document.createElement("span");
    title.className = "job-title";
    title.textContent = job.goal;

    const meta = document.createElement("small");
    meta.textContent = `#${job.id} · ${labelForJobMode(job.mode)} · ${labelForPolicy(job.policyLevel)}`;

    const status = document.createElement("span");
    status.className = `status-chip ${job.status}`;
    status.textContent = labelForJobStatus(job.status);

    button.append(title, meta, status);
    button.addEventListener("click", async () => {
      state.selectedJobId = job.id;
      await loadSelectedJob();
      renderJobs();
    });

    item.append(button);
    return item;
  }));

  renderJobDetail();
  renderActiveDemand();
  renderCouncil();
}

function renderDemandFilters() {
  const counts = demandCounts();
  const labels = {
    all: "Todas",
    needs: "Aguardando voce",
    running: "Rodando",
    failed: "Falhou",
    done: "Concluido"
  };
  els.demandFilterButtons.forEach((button) => {
    const key = button.dataset.demandFilter;
    button.setAttribute("aria-pressed", String(key === state.demandFilter));
    button.textContent = `${labels[key] || key} ${counts[key] ?? 0}`;
  });
}

function renderDemandHistorySummary() {
  if (!els.demandHistorySummary) {
    return;
  }

  const counts = demandCounts();
  const selected = state.selectedJob;
  const items = [
    ["Total", counts.all],
    ["Aguardando voce", counts.needs],
    ["Em andamento", counts.running],
    ["Falhas", counts.failed]
  ];

  const stats = items.map(([label, value]) => {
    const item = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = value;
    const text = document.createElement("small");
    text.textContent = label;
    item.append(strong, text);
    return item;
  });

  const focus = document.createElement("p");
  focus.textContent = selected
    ? `Selecionada: demanda #${selected.id} · ${labelForJobStatus(selected.status)} · ${formatDateTime(selected.updatedAt)}`
    : "Selecione uma demanda para ver detalhes, artefatos e eventos.";

  els.demandHistorySummary.replaceChildren(...stats, focus);
}

function demandCounts() {
  return {
    all: state.jobs.length,
    needs: state.jobs.filter((job) => ["draft", "awaiting_confirm", "needs_input"].includes(job.status)).length,
    running: state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length,
    failed: state.jobs.filter((job) => ["failed", "cancelled"].includes(job.status)).length,
    done: state.jobs.filter((job) => job.status === "done").length
  };
}

function filteredJobs() {
  const predicates = {
    all: () => true,
    needs: (job) => ["draft", "awaiting_confirm", "needs_input"].includes(job.status),
    running: (job) => ["queued", "running"].includes(job.status),
    failed: (job) => ["failed", "cancelled"].includes(job.status),
    done: (job) => job.status === "done"
  };
  const predicate = predicates[state.demandFilter] || predicates.all;
  return state.jobs.filter(predicate);
}

function renderSessionTabs() {
  els.sessionTabButtons.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sessionTab === state.sessionTab));
  });
  els.sessionPanels.forEach((panel) => {
    panel.hidden = panel.dataset.sessionPanel !== state.sessionTab;
  });
}

function renderActiveDemand() {
  els.activeDemand.replaceChildren();

  if (!state.selectedJob) {
    const empty = document.createElement("div");
    empty.className = "active-demand-empty";

    const title = document.createElement("strong");
    title.textContent = "Nenhuma demanda selecionada";
    const copy = document.createElement("p");
    copy.textContent = "Use o comando abaixo para conversar, pedir analise do Conselho ou transformar uma ideia em demanda de desenvolvimento.";
    const dashboard = renderMissionOverviewCards(null);

    empty.append(title, copy, dashboard);
    els.activeDemand.append(empty);
    return;
  }

  const job = state.selectedJob;
  const status = document.createElement("span");
  status.className = `status-chip ${job.status}`;
  status.textContent = labelForJobStatus(job.status);

  const mode = document.createElement("span");
  mode.className = "active-demand-mode";
  mode.textContent = `${labelForJobMode(job.mode)} · ${labelForPolicy(job.policyLevel)}`;

  const head = document.createElement("div");
  head.className = "active-demand-head";
  head.append(status, mode);

  const goal = document.createElement("h3");
  goal.textContent = job.goal;

  const meta = document.createElement("p");
  meta.className = "active-demand-meta";
  meta.textContent = `Demanda #${job.id} · ${labelForJobMode(job.mode)} · ${labelForPolicy(job.policyLevel)}`;

  const overview = renderMissionOverviewCards(job);

  const next = document.createElement("p");
  next.className = "active-demand-next";
  const nextLabel = document.createElement("strong");
  nextLabel.textContent = "Proximo passo";
  const nextText = document.createElement("span");
  nextText.textContent = nextStepForJob(job);
  next.append(nextLabel, nextText);

  const tabs = document.createElement("div");
  tabs.className = "active-demand-tabs";
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "Inspector da demanda atual");
  const tabItems = [
    ["summary", "Resumo", false],
    ["council", "Conselho", false],
    ["artifacts", "Artefatos", false],
    ["events", "Eventos tecnicos", false]
  ];
  for (const [key, label, disabled] of tabItems) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "tab");
    button.setAttribute("aria-selected", String(state.activeDemandTab === key));
    if (disabled) {
      button.disabled = true;
      button.title = "Disponivel nas proximas etapas do cockpit.";
    } else {
      button.addEventListener("click", () => {
        state.activeDemandTab = key;
        renderActiveDemand();
        if (key === "council") {
          document.querySelector(".council-section").scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      });
    }
    button.textContent = label;
    tabs.append(button);
  }

  const facts = document.createElement("dl");
  facts.className = "active-demand-facts";
  appendFact(facts, "Integracao", integrationForJob(job));
  appendFact(facts, "Contexto", demandContextLabel(job));
  appendFact(facts, "Criada", formatDateTime(job.createdAt));
  appendFact(facts, "Atualizada", formatDateTime(job.updatedAt));

  const action = document.createElement("button");
  action.type = "button";
  action.className = "secondary";
  action.textContent = "Ver no historico";
  action.addEventListener("click", () => {
    document.querySelector(".jobs-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  if (state.activeDemandTab === "council") {
    const councilPanel = renderActiveDemandCouncil(job);
    els.activeDemand.append(head, goal, meta, overview, tabs, councilPanel, action);
    return;
  }

  if (state.activeDemandTab === "events") {
    const technical = document.createElement("div");
    technical.className = "active-demand-technical";
    const copy = document.createElement("p");
    copy.textContent = state.selectedJobEvents.length
      ? "Detalhe original da execucao, preservado para auditoria."
      : "Sem eventos tecnicos registrados para esta demanda.";
    const list = document.createElement("ul");
    list.className = "job-events";
    list.replaceChildren(...(state.selectedJobEvents.length ? state.selectedJobEvents.map(renderJobEvent) : []));
    technical.append(copy, list);
    els.activeDemand.append(head, goal, meta, overview, tabs, technical, action);
    return;
  }

  if (state.activeDemandTab === "artifacts") {
    const panel = document.createElement("div");
    panel.className = "artifact-cards";
    if (state.selectedJobArtifacts.length) {
      panel.replaceChildren(...state.selectedJobArtifacts.map(renderArtifactCard));
    } else {
      const empty = document.createElement("p");
      empty.className = "empty-state";
      empty.textContent = "Sem artefatos para esta demanda ainda.";
      panel.append(empty);
    }
    els.activeDemand.append(head, goal, meta, overview, tabs, panel, action);
    return;
  }

  const timeline = renderDemandTimeline(job);
  const security = renderSecurityBand(job);
  const alert = renderHumanFailure(job);
  els.activeDemand.append(head, goal, meta, overview, tabs);
  els.activeDemand.append(timeline);
  if (security) {
    els.activeDemand.append(security);
  }
  if (alert) {
    els.activeDemand.append(alert);
  }
  els.activeDemand.append(next, facts, action);
}

function integrationForJob(job) {
  if (job.mode === "implement") {
    return "Codex local";
  }
  if (job.mode === "analyze") {
    return "Gemini/Grok com consentimento";
  }
  return "AURA local";
}

function demandContextLabel(job) {
  const metadata = job.metadata || {};
  const files = metadata.files || metadata.likelyFiles;
  if (Array.isArray(files) && files.length) {
    return files.join(", ");
  }
  if (files) {
    return String(files);
  }
  if (metadata.source) {
    return `Origem: ${metadata.source}`;
  }
  return "Workspace e memoria locais.";
}

function renderHumanFailure(job) {
  if (job.status !== "failed" || (!job.error && !job.summary)) {
    return null;
  }

  const panel = document.createElement("p");
  panel.className = "active-demand-alert";
  const label = document.createElement("strong");
  label.textContent = "Falha acionavel";
  const copy = document.createElement("span");
  copy.textContent = humanizeJobMessage(job.error || job.summary);
  panel.append(label, copy);
  return panel;
}

function renderMissionOverviewCards(job) {
  const cards = document.createElement("div");
  cards.className = "mission-overview";

  const waitingJobs = state.jobs.filter((item) => ["draft", "awaiting_confirm", "needs_input"].includes(item.status)).length;
  const runningJobs = state.jobs.filter((item) => ["queued", "running"].includes(item.status)).length;
  const openTasks = state.tasks.filter((task) => task.status !== "done").length;
  const cost = state.costs?.totals?.estimatedCostUsd || 0;

  const items = job ? [
    ["Status", labelForJobStatus(job.status), labelForJobMode(job.mode)],
    ["Executor", integrationForJob(job), labelForPolicy(job.policyLevel)],
    ["Proximo passo", nextStepForJob(job), `Atualizada ${formatDateTime(job.updatedAt)}`],
    ["Custo local", formatUsd(cost), `${formatInteger(state.costs?.totals?.tokens || 0)} tokens`]
  ] : [
    ["Tarefas", formatInteger(openTasks), "abertas"],
    ["Demandas", formatInteger(runningJobs), "em execucao"],
    ["Aguardando", formatInteger(waitingJobs), "sua decisao"],
    ["Custo local", formatUsd(cost), `${formatInteger(state.costs?.totals?.tokens || 0)} tokens`]
  ];

  for (const [label, value, detail] of items) {
    const card = document.createElement("article");
    card.className = "mission-overview-card";
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = detail;
    card.append(small, strong, span);
    cards.append(card);
  }

  return cards;
}

function renderActiveDemandCouncil(job) {
  const panel = document.createElement("div");
  panel.className = "active-demand-council";

  const summary = document.createElement("p");
  summary.className = "active-demand-next";
  const label = document.createElement("strong");
  label.textContent = "Conselho";
  const copy = document.createElement("span");
  copy.textContent = councilSummaryForJob(job);
  summary.append(label, copy);
  panel.append(summary);

  const analystConsent = renderAnalystConsent(job);
  const debateControls = renderDebateControls(job);
  if (analystConsent) {
    panel.append(analystConsent);
  }
  if (debateControls) {
    panel.append(debateControls);
  }
  if (!analystConsent && !debateControls) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = job.mode === "implement"
      ? "Esta demanda esta preparada para Codex. Use o Conselho depois como revisao ou crie uma demanda de analise."
      : "Sem acao pendente do Conselho para esta demanda.";
    panel.append(empty);
  }

  return panel;
}

function applyJobErrorDetails(error) {
  if (!error?.details?.job) {
    return;
  }
  state.selectedJob = error.details.job;
  state.selectedJobId = error.details.job.id;
  state.selectedJobEvents = error.details.events || state.selectedJobEvents;
  state.selectedJobArtifacts = error.details.artifacts || state.selectedJobArtifacts;
}

function humanizeJobMessage(value, details = null) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (!text) {
    return "";
  }
  const lockedBy = details?.lockedBy;
  if (lockedBy?.id || lower.includes("workspace is locked")) {
    const id = lockedBy?.id ? ` #${lockedBy.id}` : "";
    const status = lockedBy?.status ? ` (${labelForJobStatus(lockedBy.status)})` : "";
    return `Ja existe uma demanda de escrita${id}${status} usando este workspace. Aguarde ela terminar ou cancele a demanda antes de iniciar outra execucao.`;
  }
  if (lower.includes("process timed out")) {
    const match = text.match(/after\s+(\d+)ms/i);
    const duration = match ? formatDurationMs(Number(match[1])) : "o limite configurado";
    return `A execucao passou de ${duration} e foi interrompida. Revise os artefatos gerados e rode novamente com uma demanda menor ou aumente CODEX_TIMEOUT_MS.`;
  }
  if (lower.includes("codex cli was not found") || lower.includes("codex cli unavailable")) {
    return "Codex CLI nao foi encontrado. Instale o Codex CLI ou configure AURA_CODEX_BIN e tente novamente.";
  }
  if (lower.includes("job cancelled before execution") || lower.includes("job cancelado")) {
    return "Demanda cancelada antes da execucao. Nenhuma acao local foi realizada.";
  }
  if (lower.includes("gemini cli was not found")) {
    return "Gemini CLI nao foi encontrado. Instale o Gemini CLI ou configure AURA_GEMINI_BIN antes de consultar este analista.";
  }
  if (lower.includes("grok cli was not found")) {
    return "Grok CLI nao foi encontrado. Instale o Grok CLI ou configure AURA_GROK_BIN antes de consultar este analista.";
  }
  if (lower.includes("openrouter cli was not found")) {
    return "OpenRouter CLI nao foi encontrado. Instale o OpenRouter CLI ou configure AURA_OPENROUTER_BIN antes de consultar este analista.";
  }
  if (lower.includes("unavailable") || lower.includes("503")) {
    return "O modelo ou provedor esta temporariamente indisponivel. Aguarde alguns instantes e tente novamente.";
  }
  if (lower.includes("fetch failed") || lower.includes("network")) {
    return "Falha de rede ao consultar o provedor. Verifique a conexao e tente novamente.";
  }
  if (lower.includes("permission") || lower.includes("confirm")) {
    return "A demanda precisa de permissao ou confirmacao antes de continuar. Revise o risco e aprove somente se fizer sentido.";
  }
  return text;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "o limite configurado";
  }
  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${seconds} segundos`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minutos`;
}

function renderDemandTimeline(job) {
  const current = currentTimelineStep(job);
  const steps = [
    ["received", "recebido"],
    ["analyzing", "analisando"],
    ["council", "conselho"],
    ["approval", "aguardando aprovacao"],
    ["executing", "executando"],
    ["result", "resultado"]
  ];
  const list = document.createElement("ol");
  list.className = "demand-timeline";
  list.setAttribute("aria-label", "Timeline da demanda");
  for (const [key, label] of steps) {
    const item = document.createElement("li");
    item.className = key === current ? "current" : "";
    item.setAttribute("aria-current", key === current ? "step" : "false");
    item.textContent = label;
    list.append(item);
  }
  return list;
}

function currentTimelineStep(job) {
  if (["done", "failed", "cancelled"].includes(job.status)) {
    return "result";
  }
  if (job.status === "awaiting_confirm" || job.status === "needs_input") {
    return "approval";
  }
  if (job.status === "queued" || job.status === "running") {
    return "executing";
  }
  if (job.mode === "analyze") {
    return "council";
  }
  if (job.mode === "implement") {
    return "approval";
  }
  return "analyzing";
}

function renderSecurityBand(job) {
  if (!canConfirmImplementJob(job)) {
    return null;
  }

  const metadata = job.metadata || {};
  const policy = metadata.policy || {};
  const panel = document.createElement("section");
  panel.className = "security-band";
  panel.setAttribute("aria-label", "Confirmacao de seguranca da demanda");

  const title = document.createElement("strong");
  title.textContent = "Aguardando aprovacao";

  const facts = document.createElement("dl");
  facts.className = "security-facts";
  appendFact(facts, "Risco", metadata.risk || riskForPolicy(job.policyLevel));
  const likelyFiles = Array.isArray(metadata.likelyFiles) ? metadata.likelyFiles.join(", ") : metadata.likelyFiles;
  appendFact(facts, "Dados/arquivos", likelyFiles || "Workspace local aprovado para esta demanda.");
  appendFact(facts, "Motivo", humanizeJobMessage(policy.reason || "Esta demanda pode alterar arquivos locais."));

  const controls = document.createElement("div");
  controls.className = "security-actions";

  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary";
  approve.textContent = "Aprovar";
  approve.addEventListener("click", async () => {
    await withBusyButton(approve, "Aprovando", async () => {
      try {
        appendMessage("system", `Executando demanda #${job.id} com Codex apos aprovacao visual.`);
        await api(`/api/jobs/${job.id}/codex/implement`, {
          method: "POST",
          body: { confirmed: true, prompt: job.goal, timeoutMs: job.timeoutMs }
        });
        await refreshJobs();
      } catch (error) {
        applyJobErrorDetails(error);
        appendMessage("system", `Aprovacao nao concluida: ${humanizeJobMessage(error.message, error.details)}`);
        await refreshJobs();
      }
    });
  });

  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "danger-button";
  deny.textContent = "Negar";
  deny.addEventListener("click", async () => {
    await withBusyButton(deny, "Negando", async () => {
      const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      await refreshJobs();
      appendMessage("system", `Demanda #${job.id} negada sem executar.`);
    });
  });

  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Ver detalhes";
  details.addEventListener("click", () => {
    document.querySelector(".jobs-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  controls.append(approve, deny, details);
  panel.append(title, facts, controls);
  return panel;
}

function renderJobDetail() {
  els.jobDetail.replaceChildren();

  if (!state.selectedJob) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Historico vazio.";
    els.jobDetail.append(empty);
    return;
  }

  const job = state.selectedJob;
  const header = document.createElement("div");
  header.className = "job-detail-header";

  const titleGroup = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = `Demanda #${job.id}`;
  const goal = document.createElement("p");
  goal.textContent = job.goal;
  titleGroup.append(title, goal);

  const actions = document.createElement("div");
  actions.className = "job-actions";
  const status = document.createElement("span");
  status.className = `status-chip ${job.status}`;
  status.textContent = labelForJobStatus(job.status);
  actions.append(status);

  if (canCancelJob(job)) {
    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.className = "danger-button";
    cancelButton.textContent = "Cancelar";
    cancelButton.addEventListener("click", async () => {
      if (!confirm(`Cancelar demanda #${job.id}?`)) {
        return;
      }
      await withBusyButton(cancelButton, "Cancelando", async () => {
        const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
        state.selectedJob = result.job;
        state.selectedJobEvents = result.events || [];
        await refreshJobs();
        logEvent("job.cancel", { id: job.id, status: result.job.status });
      });
    });
    actions.append(cancelButton);
  }

  if (canConfirmImplementJob(job)) {
    const runButton = document.createElement("button");
    runButton.type = "button";
    runButton.className = "primary";
    runButton.textContent = "Executar";
    runButton.addEventListener("click", async () => {
      if (!confirm(`Executar demanda #${job.id} com permissao de escrita no workspace?`)) {
        return;
      }
      await withBusyButton(runButton, "Executando", async () => {
        let result = null;
        try {
          result = await api(`/api/jobs/${job.id}/codex/implement`, {
            method: "POST",
            body: { confirmed: true, prompt: job.goal, timeoutMs: job.timeoutMs }
          });
          state.selectedJob = result.job;
          state.selectedJobEvents = result.events || [];
          state.selectedJobArtifacts = result.artifacts || [];
        } catch (error) {
          applyJobErrorDetails(error);
          appendMessage("system", `Implementacao nao concluida: ${humanizeJobMessage(error.message, error.details)}`);
        }
        await refreshJobs();
        logEvent("job.implement", { id: job.id, status: result?.job?.status || "failed" });
      });
    });
    actions.append(runButton);
  }

  header.append(titleGroup, actions);

  const facts = document.createElement("dl");
  facts.className = "job-facts";
  appendFact(facts, "Workspace", job.workspace);
  appendFact(facts, "Modo", job.mode);
  appendFact(facts, "Policy", job.policyLevel);
  appendFact(facts, "Origem", job.requestedBy);
  appendFact(facts, "Criado", formatDateTime(job.createdAt));
  appendFact(facts, "Atualizado", formatDateTime(job.updatedAt));
  appendFact(facts, "Timeout", `${job.timeoutMs} ms`);

  const approval = renderImplementationApproval(job);
  const analystConsent = renderAnalystConsent(job);
  const debateControls = renderDebateControls(job);
  const routineDraftControls = renderRoutineDraftControls(job);
  const notes = document.createElement("div");
  notes.className = "job-notes";
  if (job.summary) {
    const summary = document.createElement("p");
    summary.innerHTML = `<strong>Resumo</strong><span></span>`;
    summary.querySelector("span").textContent = humanizeJobMessage(job.summary);
    notes.append(summary);
  }
  if (job.error) {
    const error = document.createElement("p");
    error.className = "error-text";
    error.innerHTML = `<strong>Erro</strong><span></span>`;
    error.querySelector("span").textContent = humanizeJobMessage(job.error);
    notes.append(error);
  }

  const eventList = document.createElement("ul");
  eventList.className = "job-events";
  const events = state.selectedJobEvents.length ? state.selectedJobEvents : [];
  eventList.replaceChildren(...events.map(renderJobEvent));

  if (!events.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sem eventos.";
    eventList.append(empty);
  }

  const technicalDetails = document.createElement("details");
  technicalDetails.className = "technical-details";
  const technicalSummary = document.createElement("summary");
  technicalSummary.textContent = "Eventos tecnicos";
  technicalDetails.append(technicalSummary, eventList);

  const artifactTitle = document.createElement("h3");
  artifactTitle.textContent = "Artefatos";
  const artifactList = document.createElement("ul");
  artifactList.className = "job-artifacts";
  const artifacts = state.selectedJobArtifacts.length ? state.selectedJobArtifacts : [];
  artifactList.replaceChildren(...artifacts.map(renderJobArtifact));

  if (!artifacts.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sem artefatos.";
    artifactList.append(empty);
  }

  els.jobDetail.append(header, facts);
  if (approval) {
    els.jobDetail.append(approval);
  }
  if (analystConsent) {
    els.jobDetail.append(analystConsent);
  }
  if (debateControls) {
    els.jobDetail.append(debateControls);
  }
  if (routineDraftControls) {
    els.jobDetail.append(routineDraftControls);
  }
  els.jobDetail.append(notes, artifactTitle, artifactList, technicalDetails);
}

function renderJobEvent(event) {
  const item = document.createElement("li");
  const main = document.createElement("div");
  const type = document.createElement("code");
  type.textContent = event.type;
  const message = document.createElement("span");
  message.textContent = event.message || "";
  main.append(type, message);

  const time = document.createElement("time");
  time.dateTime = event.createdAt;
  time.textContent = formatDateTime(event.createdAt);

  item.append(main, time);
  return item;
}

function renderImplementationApproval(job) {
  if (job.mode !== "implement") {
    return null;
  }

  const panel = document.createElement("div");
  panel.className = "approval-summary";
  const metadata = job.metadata || {};
  appendApprovalItem(panel, "Plano", metadata.plan || metadata.planSummary || job.goal);
  appendApprovalItem(panel, "Risco", metadata.risk || riskForPolicy(job.policyLevel));
  const likelyFiles = Array.isArray(metadata.likelyFiles) ? metadata.likelyFiles.join("\n") : metadata.likelyFiles;
  appendApprovalItem(panel, "Arquivos provaveis", likelyFiles || "Nao informado");
  return panel;
}

function renderAnalystConsent(job) {
  if (!canRunAnalystsJob(job)) {
    return null;
  }

  const panel = document.createElement("div");
  panel.className = "analyst-consent";

  const preview = document.createElement("pre");
  preview.textContent = buildAnalystPreview(job);

  const controls = document.createElement("div");
  controls.className = "analyst-controls";
  const gemini = checkboxControl(`analyst-gemini-${job.id}`, "Gemini", true);
  const grok = checkboxControl(`analyst-grok-${job.id}`, "Grok", true);
  const openrouter = checkboxControl(`analyst-openrouter-${job.id}`, "OpenRouter", true);
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.className = "primary";
  runButton.textContent = "Consultar";
  const updateAnalystButton = () => {
    runButton.disabled = !gemini.input.checked && !grok.input.checked && !openrouter.input.checked;
  };
  gemini.input.addEventListener("change", updateAnalystButton);
  grok.input.addEventListener("change", updateAnalystButton);
  openrouter.input.addEventListener("change", updateAnalystButton);
  runButton.addEventListener("click", async () => {
    const consent = {
      gemini: gemini.input.checked,
      grok: grok.input.checked,
      openrouter: openrouter.input.checked
    };
    if (!consent.gemini && !consent.grok && !consent.openrouter) {
      appendMessage("system", "Selecione ao menos um analista.");
      return;
    }
    await withBusyButton(runButton, "Consultando", async () => {
      let result = null;
      try {
        result = await api(`/api/jobs/${job.id}/analysts/run`, {
          method: "POST",
          body: {
            consent,
            context: analystContext(job)
          }
        });
        state.selectedJob = result.job;
        state.selectedJobEvents = result.events || [];
        state.selectedJobArtifacts = result.artifacts || [];
      } catch (error) {
        appendMessage("system", `Analise nao concluida: ${error.message}`);
      }
      await refreshJobs();
      logEvent("job.analysts", { id: job.id, status: result?.job?.status || "failed", consent });
    });
  });
  updateAnalystButton();

  controls.append(gemini.label, grok.label, openrouter.label, runButton);
  panel.append(preview, controls);
  return panel;
}

function renderDebateControls(job) {
  if (!canSynthesizeDebate(job)) {
    return null;
  }

  const panel = document.createElement("div");
  panel.className = "debate-controls";
  const summary = document.createElement("p");
  summary.textContent = "Sintese disponivel para consenso, divergencias, riscos e itens nao verificados.";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "primary";
  button.textContent = "Sintetizar";
  button.addEventListener("click", async () => {
    await withBusyButton(button, "Sintetizando", async () => {
      let result = null;
      try {
        result = await api(`/api/jobs/${job.id}/debate/synthesize`, {
          method: "POST",
          body: {
            requested: true,
            budget: { maxRounds: 1 }
          }
        });
        state.selectedJob = result.job;
        state.selectedJobEvents = result.events || [];
        state.selectedJobArtifacts = result.artifacts || [];
      } catch (error) {
        appendMessage("system", `Sintese nao concluida: ${error.message}`);
      }
      await refreshJobs();
      logEvent("job.debate", { id: job.id, status: result?.job?.status || "failed" });
    });
  });

  panel.append(summary, button);
  return panel;
}

function renderRoutineDraftControls(job) {
  if (job.requestedBy !== "routine" || job.status !== "draft") {
    return null;
  }

  const form = document.createElement("form");
  form.className = "routine-draft";

  const input = document.createElement("input");
  input.type = "text";
  input.value = job.goal;
  input.setAttribute("aria-label", "Editar draft da rotina");

  const mode = document.createElement("select");
  mode.setAttribute("aria-label", "Modo do draft");
  for (const value of ["ask", "analyze"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    option.selected = job.mode === value;
    mode.append(option);
  }

  const save = document.createElement("button");
  save.type = "submit";
  save.textContent = "Guardar";

  const approve = document.createElement("button");
  approve.type = "button";
  approve.className = "primary";
  approve.textContent = "Aprovar";
  approve.addEventListener("click", async () => {
    await withBusyButton(approve, "Aprovando", async () => {
      const result = await api(`/api/jobs/${job.id}/approve`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      logEvent("job.approve", { id: job.id, status: result.job.status });
    });
  });

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "danger-button";
  discard.textContent = "Descartar";
  discard.addEventListener("click", async () => {
    await withBusyButton(discard, "Descartando", async () => {
      const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      await refreshJobs();
      logEvent("job.discard", { id: job.id, status: result.job.status });
    });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const goal = input.value.trim();
    if (!goal) {
      appendMessage("system", "Preencha o objetivo do draft antes de guardar.");
      input.focus();
      return;
    }
    await withBusyButton(save, "Guardando", async () => {
      const result = await api(`/api/jobs/${job.id}`, {
        method: "PATCH",
        body: {
          goal,
          mode: mode.value
        }
      });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      logEvent("job.draft.update", { id: job.id });
    });
  });

  form.append(input, mode, save, approve, discard);
  return form;
}

function canSynthesizeDebate(job) {
  if (job.mode !== "analyze" || job.policyLevel !== "read") {
    return false;
  }
  return state.selectedJobArtifacts.some((artifact) => artifact.kind === "analyst-response");
}

function appendApprovalItem(panel, label, value) {
  const item = document.createElement("p");
  const title = document.createElement("strong");
  title.textContent = label;
  const body = document.createElement("span");
  body.textContent = value;
  item.append(title, body);
  panel.append(item);
}

function checkboxControl(id, text, checked) {
  const label = document.createElement("label");
  label.className = "checkbox-control";
  const input = document.createElement("input");
  input.id = id;
  input.type = "checkbox";
  input.checked = checked;
  const span = document.createElement("span");
  span.textContent = text;
  label.append(input, span);
  return { label, input };
}

function renderJobArtifact(artifact) {
  const item = document.createElement("li");
  const main = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = artifact.label;
  const meta = document.createElement("small");
  meta.textContent = artifact.kind;
  main.append(label, meta);

  const preview = document.createElement("pre");
  preview.textContent = artifact.content || "";
  item.append(main, preview);
  return item;
}

function renderArtifactCard(artifact) {
  const card = document.createElement("article");
  card.className = "artifact-card";

  const header = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = artifact.label;
  const meta = document.createElement("small");
  meta.textContent = artifact.kind;
  header.append(title, meta);

  const preview = document.createElement("p");
  preview.textContent = artifact.content || "Artefato sem conteudo textual.";

  const actions = document.createElement("div");
  actions.className = "artifact-actions";

  const copy = document.createElement("button");
  copy.type = "button";
  copy.textContent = "Copiar";
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(artifact.content || "");
      appendMessage("system", "Artefato copiado.");
    } catch {
      els.localInput.value = artifact.content || "";
      appendMessage("system", "Nao consegui copiar automaticamente; deixei o artefato na conversa.");
    }
  });

  const use = document.createElement("button");
  use.type = "button";
  use.className = "primary";
  use.textContent = "Usar na conversa";
  use.addEventListener("click", () => {
    els.localInput.value = artifact.content || artifact.label;
    els.localInput.focus();
  });

  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Ver detalhes";
  details.addEventListener("click", () => {
    document.querySelector(".jobs-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    els.jobDetail.focus?.();
  });

  actions.append(details, copy, use);
  card.append(header, preview, actions);
  return card;
}

function renderTools() {
  els.toolsList.replaceChildren(...state.status.tools.map((tool) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${tool.name}</span><small>${tool.requiresConfirmation ? "confirma" : "seguro"}</small>`;
    return item;
  }));
}

function renderCosts() {
  if ((!els.costsPanel && !els.topCostsPanel) || !state.costs) {
    return;
  }

  const totals = state.costs.totals || {};
  const hero = document.createElement("section");
  hero.className = "cost-hero";

  const heroMain = document.createElement("article");
  heroMain.className = "cost-hero-total";
  const heroLabel = document.createElement("span");
  heroLabel.textContent = "Custo total estimado";
  const heroValue = document.createElement("strong");
  heroValue.textContent = formatUsd(totals.estimatedCostUsd || 0);
  const heroNote = document.createElement("small");
  heroNote.textContent = `${formatInteger(totals.tokens || 0)} tokens medidos em ${totals.measuredEvents || 0} eventos`;
  heroMain.append(heroLabel, heroValue, heroNote);

  const metrics = document.createElement("div");
  metrics.className = "cost-metrics compact";
  metrics.append(
    renderCostMetricCard("Entrada", formatInteger(totals.inputTokens || 0), "tokens"),
    renderCostMetricCard("Saida", formatInteger(totals.outputTokens || 0), "tokens"),
    renderCostMetricCard("Sem preco", formatInteger(totals.unpricedEvents || 0), "eventos")
  );
  hero.append(heroMain, metrics);

  const providerRows = costProviderDashboardRows();
  const providerGrid = document.createElement("section");
  providerGrid.className = "cost-provider-grid";
  providerRows.forEach((item) => providerGrid.append(renderCostProviderCard(item)));
  const providerSection = renderCostSection("Custo por IA", providerGrid);

  const chartGrid = document.createElement("section");
  chartGrid.className = "cost-chart-grid";
  chartGrid.append(
    renderCostBarChart("Custos por modelo", state.costs.byModel || [], {
      amount: (item) => formatUsd(item.estimatedCostUsd || 0),
      detail: (item) => `${formatInteger(item.tokens || 0)} tokens · ${formatInteger(item.inputTokens || 0)} in · ${formatInteger(item.outputTokens || 0)} out`,
      value: (item) => item.estimatedCostUsd || 0,
      fallbackValue: (item) => item.tokens || 0
    }),
    renderCostBarChart("Tipos de token", state.costs.tokenBreakdown || [], {
      amount: (item) => formatInteger(item.tokens || 0),
      detail: () => "tokens consumidos",
      value: (item) => item.tokens || 0
    })
  );

  const keys = document.createElement("div");
  keys.className = "cost-key-grid";
  for (const key of state.costs.keys || []) {
    keys.append(renderCostKey(key));
  }

  const models = document.createElement("div");
  models.className = "cost-breakdown";
  const modelSection = renderCostSection("Tabela por modelo", models);
  for (const item of state.costs.byModel || []) {
    models.append(renderCostRow(item.label, item.estimatedCostUsd, `${formatInteger(item.tokens || 0)} tokens · ${formatInteger(item.inputTokens || 0)} entrada · ${formatInteger(item.outputTokens || 0)} saida · ${item.events} eventos`));
  }
  if (!models.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Sem modelos medidos ainda.";
    models.append(empty);
  }

  const breakdownGrid = document.createElement("section");
  breakdownGrid.className = "cost-breakdown-grid";
  breakdownGrid.append(modelSection, renderCostBarChart("Serie recente", state.costs.tokenSeries || [], {
    amount: (item) => formatUsd(item.estimatedCostUsd || 0),
    detail: (item) => `${formatInteger(item.tokens || 0)} tokens · ${item.events} eventos`,
    value: (item) => item.estimatedCostUsd || 0,
    fallbackValue: (item) => item.tokens || 0
  }));

  const recent = document.createElement("div");
  recent.className = "cost-recent";
  const recentList = document.createElement("ul");
  recentList.className = "events";
  const rows = state.costs.recent || [];
  recentList.replaceChildren(...rows.slice(0, 8).map(renderCostEvent));
  if (!rows.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Sem eventos de custo registrados.";
    recentList.append(empty);
  }
  recent.append(recentList);
  const recentSection = renderCostSection("Uso recente", recent);

  const notes = document.createElement("section");
  notes.className = "cost-notes";
  for (const text of state.costs.notes || []) {
    const note = document.createElement("p");
    note.textContent = text;
    notes.append(note);
  }

  const keysSection = renderCostSection("Credenciais monitoradas", keys);
  const content = [hero, providerSection, chartGrid, breakdownGrid, keysSection, recentSection, notes];
  if (els.costsPanel) {
    els.costsPanel.replaceChildren(...content);
  }
  if (els.topCostsPanel) {
    els.topCostsPanel.replaceChildren(...content.map((node) => node.cloneNode(true)));
  }
}

function costProviderDashboardRows() {
  const usageByProvider = new Map((state.costs.byProvider || []).map((item) => [normalizeProviderName(item.label), item]));
  const configuredProviders = (state.costs.keys || []).map((key) => key.provider);
  const labels = [...new Set([...configuredProviders, ...(state.costs.byProvider || []).map((item) => item.label)])];
  return labels.map((label) => {
    const usage = usageByProvider.get(normalizeProviderName(label)) || {};
    const key = (state.costs.keys || []).find((item) => normalizeProviderName(item.provider) === normalizeProviderName(label));
    return {
      label,
      configured: key?.configured ?? Boolean(usage.events),
      source: key?.source || "Uso medido",
      tokens: usage.tokens || 0,
      inputTokens: usage.inputTokens || 0,
      outputTokens: usage.outputTokens || 0,
      events: usage.events || 0,
      unpricedEvents: usage.unpricedEvents || 0,
      estimatedCostUsd: usage.estimatedCostUsd || 0
    };
  }).sort((left, right) => (
    right.estimatedCostUsd - left.estimatedCostUsd ||
    right.tokens - left.tokens ||
    Number(right.configured) - Number(left.configured) ||
    left.label.localeCompare(right.label)
  ));
}

function renderCostProviderCard(item) {
  const card = document.createElement("article");
  card.className = `cost-provider-card ${item.configured ? "configured" : "missing"}`;

  const header = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = item.label;
  const status = document.createElement("span");
  status.textContent = item.configured ? "conectada" : "ausente";
  header.append(title, status);

  const amount = document.createElement("b");
  amount.textContent = formatUsd(item.estimatedCostUsd || 0);

  const stats = document.createElement("dl");
  stats.className = "cost-provider-stats";
  appendFact(stats, "Tokens", formatInteger(item.tokens || 0));
  appendFact(stats, "Entrada", formatInteger(item.inputTokens || 0));
  appendFact(stats, "Saida", formatInteger(item.outputTokens || 0));
  appendFact(stats, "Eventos", formatInteger(item.events || 0));

  const note = document.createElement("small");
  note.textContent = item.unpricedEvents
    ? `${item.unpricedEvents} evento(s) sem tabela de preco.`
    : item.source;

  card.append(header, amount, stats, note);
  return card;
}

function normalizeProviderName(value) {
  return String(value || "").trim().toLowerCase();
}

function renderCostMetricCard(label, value, detail) {
  const card = document.createElement("article");
  card.className = "cost-summary-card";
  const title = document.createElement("strong");
  title.textContent = label;
  const amount = document.createElement("span");
  amount.textContent = value;
  const note = document.createElement("small");
  note.textContent = detail;
  card.append(title, amount, note);
  return card;
}

function renderCostSection(title, body) {
  const section = document.createElement("section");
  section.className = "cost-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  section.append(heading, body);
  return section;
}

function renderCostBarChart(title, rows, options) {
  const chart = document.createElement("div");
  chart.className = "cost-chart";
  const maxPrimary = Math.max(0, ...rows.map((item) => Number(options.value(item) || 0)));
  const maxFallback = Math.max(0, ...rows.map((item) => Number(options.fallbackValue?.(item) || 0)));
  const max = maxPrimary || maxFallback || 1;
  for (const item of rows.slice(0, 8)) {
    chart.append(renderCostBar(item, max, options, maxPrimary === 0));
  }
  if (!chart.children.length) {
    const empty = document.createElement("p");
    empty.className = "empty-state";
    empty.textContent = "Sem dados suficientes para grafico.";
    chart.append(empty);
  }
  return renderCostSection(title, chart);
}

function renderCostBar(item, max, options, usingFallback) {
  const value = Number((usingFallback ? options.fallbackValue?.(item) : options.value(item)) || 0);
  const percent = Math.max(2, Math.min(100, (value / max) * 100));
  const row = document.createElement("article");
  row.className = "cost-chart-row";

  const header = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = item.label;
  const amount = document.createElement("span");
  amount.textContent = options.amount(item);
  header.append(label, amount);

  const track = document.createElement("div");
  track.className = "cost-chart-track";
  const bar = document.createElement("span");
  bar.style.width = `${percent}%`;
  track.append(bar);

  const detail = document.createElement("small");
  detail.textContent = options.detail(item);
  row.append(header, track, detail);
  return row;
}

function renderCostKey(key) {
  const item = document.createElement("article");
  item.className = `cost-key ${key.configured ? "configured" : "missing"}`;
  const head = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = key.provider;
  const status = document.createElement("span");
  status.className = "cost-key-status";
  status.textContent = key.configured ? "configurada" : "ausente";
  head.append(title, status);
  const label = document.createElement("span");
  label.textContent = key.label;
  const source = document.createElement("small");
  source.textContent = key.source;
  item.append(head, label, source);
  return item;
}

function renderCostRow(label, value, detail) {
  const row = document.createElement("article");
  row.className = "cost-row";
  const title = document.createElement("strong");
  title.textContent = label;
  const amount = document.createElement("span");
  amount.textContent = formatUsd(value || 0);
  const note = document.createElement("small");
  note.textContent = detail;
  row.append(title, amount, note);
  return row;
}

function renderCostEvent(event) {
  const item = document.createElement("li");
  const main = document.createElement("div");
  const type = document.createElement("code");
  type.textContent = `${event.provider}:${event.operation}`;
  const message = document.createElement("span");
  const price = event.estimatedCostUsd === null || event.estimatedCostUsd === undefined ? "sem preco" : formatUsd(event.estimatedCostUsd || 0);
  message.textContent = `${event.model} · ${price} · ${formatInteger(totalTokensFromUsage(event.usage))} tokens`;
  main.append(type, message);

  const time = document.createElement("time");
  time.dateTime = event.createdAt;
  time.textContent = formatDateTime(event.createdAt);
  item.append(main, time);
  return item;
}

function formatUsd(value) {
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 4,
    maximumFractionDigits: 6
  }).format(Number(value || 0));
}

function formatInteger(value) {
  return new Intl.NumberFormat("pt-BR", {
    maximumFractionDigits: 0
  }).format(Number(value || 0));
}

function totalTokensFromUsage(usage = {}) {
  return inputTokensFromUsage(usage) + outputTokensFromUsage(usage);
}

function inputTokensFromUsage(usage = {}) {
  const detailed =
    numberFromMetric(usage.textInputTokens) +
    numberFromMetric(usage.textCachedInputTokens) +
    numberFromMetric(usage.audioInputTokens) +
    numberFromMetric(usage.audioCachedInputTokens) +
    numberFromMetric(usage.imageInputTokens) +
    numberFromMetric(usage.imageCachedInputTokens);
  return detailed || numberFromMetric(usage.rawInputTokens);
}

function outputTokensFromUsage(usage = {}) {
  const detailed =
    numberFromMetric(usage.textOutputTokens) +
    numberFromMetric(usage.audioOutputTokens);
  return detailed || numberFromMetric(usage.rawOutputTokens);
}

function renderLocalContextSummary() {
  if (!els.localContextSummary || !state.status) {
    return;
  }

  const openTasks = state.tasks.filter((task) => task.status !== "done").length;
  const waitingJobs = state.jobs.filter((job) => ["draft", "awaiting_confirm", "needs_input"].includes(job.status)).length;
  const runningJobs = state.jobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const items = [
    ["Tarefas abertas", openTasks],
    ["Memorias locais", state.memories.length],
    ["Demandas ativas", runningJobs],
    ["Aguardando voce", waitingJobs],
    ["Custo estimado", formatUsd(state.costs?.totals?.estimatedCostUsd || 0)],
    ["Tela", state.screenStream ? "capturando" : "parada"],
    ["Retencao", `${state.status.jobHistoryRetentionDays} dias`]
  ];

  els.localContextSummary.replaceChildren(...items.map(([label, value]) => {
    const item = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("small");
    small.textContent = label;
    item.append(strong, small);
    return item;
  }));
}

function updateComposerValidation() {
  if (!els.localSubmitButton) {
    return;
  }
  const hasPayload = Boolean(els.localInput.value.trim()) || state.attachments.length > 0;
  els.localSubmitButton.disabled = !hasPayload;
  els.localSubmitButton.title = hasPayload ? "" : "Digite uma mensagem ou anexe um arquivo.";
}

function updateSubmitButton(form, enabled) {
  const button = form?.querySelector("button[type='submit']");
  if (!button) {
    return;
  }
  button.disabled = !enabled;
  button.title = enabled ? "" : "Preencha o campo antes de continuar.";
}

async function withBusyButton(button, busyLabel, action) {
  if (!button || button.disabled) {
    return;
  }

  const originalText = button.textContent;
  const originalTitle = button.title;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = busyLabel;
  try {
    await action();
  } finally {
    button.textContent = originalText;
    button.title = originalTitle;
    button.disabled = false;
    button.removeAttribute("aria-busy");
  }
}

function appendFact(list, label, value) {
  const term = document.createElement("dt");
  term.textContent = label;
  const detail = document.createElement("dd");
  detail.textContent = value || "-";
  list.append(term, detail);
}

function canCancelJob(job) {
  return ["draft", "awaiting_confirm", "queued", "running", "needs_input"].includes(job.status);
}

function canConfirmImplementJob(job) {
  return job.mode === "implement" && job.policyLevel === "write" && job.status === "awaiting_confirm";
}

function canRunAnalystsJob(job) {
  return job.mode === "analyze" && job.policyLevel === "read" && ["draft", "queued"].includes(job.status);
}

function analystContext(job) {
  const metadata = job.metadata || {};
  return {
    constraints: metadata.constraints,
    files: metadata.files || metadata.likelyFiles,
    findings: metadata.findings,
    attempted: metadata.attempted
  };
}

function buildAnalystPreview(job) {
  const context = analystContext(job);
  const lines = [
    "AURA Evidence Brief",
    `Objective: ${job.goal}`,
    `Workspace: ${job.workspace}`,
    `Mode: ${job.mode}`,
    `Policy: ${job.policyLevel}`,
    "Destinations: Gemini, Grok, OpenRouter",
    "Constraints: read-only, plan mode, no file edits, no Git commands"
  ];
  const files = Array.isArray(context.files) ? context.files : [];
  if (files.length) {
    lines.push(`Files: ${files.join(", ")}`);
  }
  return lines.join("\n");
}

function riskForPolicy(policyLevel) {
  const risks = {
    read: "Somente leitura.",
    write: "Pode alterar arquivos no workspace.",
    git: "Pode alterar estado Git local.",
    network: "Pode acessar rede.",
    secrets: "Bloqueado para dados sensiveis.",
    destructive: "Bloqueado para acoes destrutivas."
  };
  return risks[policyLevel] || "Risco nao classificado.";
}

function labelForJobStatus(status) {
  const labels = {
    draft: "draft",
    awaiting_confirm: "aguardando",
    queued: "fila",
    running: "rodando",
    needs_input: "entrada",
    done: "concluido",
    failed: "falhou",
    cancelled: "cancelado"
  };
  return labels[status] || status;
}

function labelForJobMode(mode) {
  const labels = {
    ask: "pergunta",
    analyze: "analise",
    implement: "execucao"
  };
  return labels[mode] || mode;
}

function labelForPolicy(policyLevel) {
  const labels = {
    read: "leitura",
    write: "escrita",
    git: "git",
    network: "rede",
    secrets: "segredos",
    destructive: "destrutivo"
  };
  return labels[policyLevel] || policyLevel;
}

function nextStepForJob(job) {
  const steps = {
    draft: "Revisar a demanda e aprovar quando estiver pronta.",
    awaiting_confirm: "Aguardando sua confirmacao visual para continuar.",
    queued: "AURA colocou a demanda na fila de execucao.",
    running: "AURA esta trabalhando nesta demanda agora.",
    needs_input: "AURA precisa de uma resposta sua para prosseguir.",
    done: "Resultado disponivel no historico da demanda.",
    failed: "Verificar erro e decidir se a demanda deve ser reaberta ou ajustada.",
    cancelled: "Demanda cancelada; nenhuma execucao pendente."
  };
  return steps[job.status] || "Acompanhar o andamento no historico.";
}

function formatDateTime(value) {
  if (!value) {
    return "-";
  }
  return new Date(`${value}Z`).toLocaleString("pt-BR", {
    dateStyle: "short",
    timeStyle: "short"
  });
}

function renderRoutine() {
  els.routinePanel.replaceChildren();
  if (!state.routineEnabled) {
    els.routinePanel.textContent = "Rotina pausada. Ative quando quiser que AURA sugira proximos passos enquanto o cockpit estiver aberto.";
    return;
  }

  const tasks = state.tasks.filter((task) => task.status !== "done");
  const summary = document.createElement("p");
  summary.textContent = tasks.length
    ? `Sugestao do dia baseada nas tarefas abertas: ${tasks.map((task) => task.title).join(" · ")}`
    : "Rotina ativa. AURA pode sugerir uma demanda para organizar os proximos passos do dia.";

  const form = document.createElement("form");
  form.className = "routine-job-form";
  const input = document.createElement("input");
  input.type = "text";
  input.value = tasks.length ? `Analisar prioridades de hoje: ${tasks.map((task) => task.title).join(", ")}` : "Analisar proximos passos do dia";
  input.setAttribute("aria-label", "Draft sugerido pela rotina");

  const mode = document.createElement("select");
  mode.setAttribute("aria-label", "Modo da sugestao");
  const modeOptions = [
    ["analyze", "Consultar conselho"],
    ["ask", "Conversar"]
  ];
  for (const [value, label] of modeOptions) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    mode.append(option);
  }

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Criar demanda";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const goal = input.value.trim();
    if (!goal) {
      appendMessage("system", "Preencha a sugestao da rotina antes de criar a demanda.");
      input.focus();
      return;
    }
    try {
      await withBusyButton(button, "Criando", async () => {
        const result = await api("/api/routine/jobs", {
          method: "POST",
          body: {
            goal,
            mode: mode.value
          }
        });
        state.selectedJobId = result.job.id;
        await refreshAll();
        logEvent("routine.job.created", { id: result.job.id, mode: result.job.mode });
      });
    } catch (error) {
      appendMessage("system", `Nao consegui criar a demanda da rotina: ${error.message}`);
    }
  });

  form.append(input, mode, button);
  els.routinePanel.append(summary, form);
}

async function startScreenCapture() {
  try {
    const permission = await api("/api/tools/run", {
      method: "POST",
      body: { name: "screen.capture.intent", input: {}, confirmed: true }
    });
    logEvent("screen.capture.intent", permission);
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    els.screenVideo.srcObject = state.screenStream;
    els.screenVideo.hidden = false;
    els.stopScreenButton.hidden = false;
    renderLocalContextSummary();
    state.screenStream.getVideoTracks()[0].addEventListener("ended", stopScreenCapture);
  } catch (error) {
    appendMessage("system", `Captura nao iniciada: ${error.message}`);
  }
}

function stopScreenCapture() {
  state.screenStream?.getTracks().forEach((track) => track.stop());
  state.screenStream = null;
  els.screenVideo.srcObject = null;
  els.screenVideo.hidden = true;
  els.stopScreenButton.hidden = true;
  renderLocalContextSummary();
}

function setVoiceStatus(status) {
  const labels = {
    idle: "AURA esta pronta para conversar por texto.",
    fallback: "Voz ao vivo indisponivel; continuo com voce por texto local.",
    "requesting-token": "Estou preparando uma sessao segura de voz.",
    "connecting-gemini": "Estou conectando o canal Gemini Live.",
    "requesting-microphone": "O navegador vai pedir acesso ao microfone.",
    negotiating: "Estou conectando o canal de voz ao vivo.",
    connected: "Voz ao vivo conectada.",
    standby: "Voz ativa em standby. Diga Aura para me chamar; diga ate logo, Aura para eu voltar ao standby.",
    closed: "Voz encerrada. Continuo disponivel por texto."
  };
  appendMessage("system", labels[status] || status);
  if (status === "idle" || status === "closed" || status === "fallback") {
    els.voiceButton.dataset.connected = "false";
    els.voiceButton.textContent = "Conectar voz";
  } else if (status === "standby" || status === "connected") {
    els.voiceButton.dataset.connected = "true";
    els.voiceButton.textContent = "Desconectar voz";
  }
}

function humanizeVoiceError(error) {
  const message = String(error?.message || "").toLowerCase();
  const status = Number(error?.status || 0);
  const code = String(error?.code || "").toLowerCase();
  const type = String(error?.type || "").toLowerCase();
  if (message.includes("openai_api_key")) {
    return "a chave de voz ao vivo nao esta configurada";
  }
  if (message.includes("gemini api key") || message.includes("gemini live websocket")) {
    return "a conexao com o Gemini Live nao foi aberta";
  }
  if (message.includes("audio context")) {
    return "este navegador nao permite inicializar audio em tempo real";
  }
  if (message.includes("webrtc is not available")) {
    return "este navegador nao oferece WebRTC para voz ao vivo; use Chrome ou Edge";
  }
  if (message.includes("microphone capture is not available")) {
    return "este navegador nao permite capturar microfone nesta pagina";
  }
  if (message.includes("notallowederror") || message.includes("permission denied") || message.includes("denied") || message.includes("permission")) {
    return "o microfone foi bloqueado pelo navegador; libere o microfone no icone ao lado do endereco";
  }
  if (message.includes("notfounderror") || message.includes("device not found") || message.includes("requested device not found")) {
    return "nenhum microfone foi encontrado pelo navegador";
  }
  if (message.includes("token")) {
    return "nao foi possivel preparar a sessao segura de voz";
  }
  if (message.includes("401") || message.includes("unauthorized") || message.includes("invalid api key")) {
    return "a chave da OpenAI foi recusada pela API";
  }
  if (code.includes("insufficient_quota") || message.includes("insufficient_quota") || message.includes("quota")) {
    return "o projeto da OpenAI esta sem credito ou sem cota disponivel para voz ao vivo";
  }
  if (status === 429 || code.includes("rate_limit") || type.includes("rate_limit") || message.includes("rate limit")) {
    return "a OpenAI recusou a chamada por limite, credito ou cota";
  }
  if (message.includes("connection reset") || message.includes("econnreset") || message.includes("recv failure")) {
    return "a conexao com o Realtime da OpenAI foi reiniciada durante a chamada de voz";
  }
  if (message.includes("realtime/calls") || message.includes("sdp")) {
    return "a negociacao WebRTC com a OpenAI falhou";
  }
  return "houve uma falha de conexao";
}

async function handleRealtimeToolCall(call) {
  const args = safeJson(call.arguments);
  if (call.name === "aura_create_task") {
    return createTaskFromRealtime(args);
  }
  if (call.name === "aura_develop_task") {
    return developTaskFromRealtime(args);
  }
  if (call.name === "aura_create_development_demand") {
    return createDevelopmentDemandFromRealtime(args);
  }

  return { ok: false, error: "Ferramenta desconhecida." };
}

async function recordRealtimeUsage(event) {
  const response = event.response || event;
  const usage = usageFromRealtimeResponse(response);
  if (!hasMeasuredUsage(usage)) {
    return;
  }

  const responseId = response.id || event.event_id || `${Date.now()}`;
  if (state.recordedRealtimeUsage.has(responseId)) {
    return;
  }
  state.recordedRealtimeUsage.add(responseId);

  const result = await api("/api/costs/usage", {
    method: "POST",
    body: {
      provider: "openai",
      keyLabel: "OPENAI_API_KEY",
      model: state.status?.realtimeModel || "gpt-realtime-2.1",
      source: "realtime",
      operation: "response.done",
      usage,
      metadata: {
        responseId,
        voice: state.status?.realtimeVoice || ""
      }
    }
  });
  state.costs = result.costs;
  renderCosts();
}

function usageFromRealtimeResponse(response) {
  const usage = response?.usage || {};
  const inputDetails = usage.input_token_details || usage.inputTokenDetails || {};
  const outputDetails = usage.output_token_details || usage.outputTokenDetails || {};
  return {
    textInputTokens: numberFromMetric(inputDetails.text_tokens ?? inputDetails.textTokens),
    textCachedInputTokens: numberFromMetric(inputDetails.cached_tokens ?? inputDetails.cachedTokens ?? inputDetails.cached_text_tokens),
    textOutputTokens: numberFromMetric(outputDetails.text_tokens ?? outputDetails.textTokens),
    audioInputTokens: numberFromMetric(inputDetails.audio_tokens ?? inputDetails.audioTokens),
    audioCachedInputTokens: numberFromMetric(inputDetails.cached_audio_tokens ?? inputDetails.cachedAudioTokens),
    audioOutputTokens: numberFromMetric(outputDetails.audio_tokens ?? outputDetails.audioTokens),
    imageInputTokens: numberFromMetric(inputDetails.image_tokens ?? inputDetails.imageTokens),
    imageCachedInputTokens: numberFromMetric(inputDetails.cached_image_tokens ?? inputDetails.cachedImageTokens),
    rawInputTokens: numberFromMetric(usage.input_tokens ?? usage.inputTokens),
    rawOutputTokens: numberFromMetric(usage.output_tokens ?? usage.outputTokens)
  };
}

function hasMeasuredUsage(usage) {
  return Object.values(usage).some((value) => Number(value) > 0);
}

function numberFromMetric(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

async function createTaskFromRealtime(args) {
  const title = buildRealtimeTaskTitle(args);
  if (!title) {
    return { ok: false, error: "Titulo da task ausente." };
  }

  const result = await api("/api/tasks", { method: "POST", body: { title } });
  appendMessage("system", `Task criada pela voz: ${result.task.title}`);
  await refreshAll();
  return { ok: true, task: result.task };
}

async function developTaskFromRealtime(args) {
  const taskId = Number(args.taskId || 0);
  if (!Number.isFinite(taskId) || taskId <= 0) {
    return { ok: false, error: "Id da task ausente." };
  }

  const result = await api(`/api/tasks/${taskId}/develop`, {
    method: "POST",
    body: {
      source: "realtime-tool",
      requestedBy: "voice",
      extraGoal: args.extraGoal || "",
      executor: args.executor || "codex"
    }
  });
  state.selectedJobId = result.job.id;
  state.demandFilter = "all";
  appendMessage("system", `Demanda ${result.job.id} criada pela voz para desenvolver a task ${taskId}.`);
  await refreshAll();
  return { ok: true, job: result.job, task: result.task };
}

async function createDevelopmentDemandFromRealtime(args) {
  const goal = String(args.goal || "").trim();
  if (!goal) {
    return { ok: false, error: "Objetivo da demanda ausente." };
  }
  const executor = String(args.executor || "codex").toLowerCase();
  const mode = executor === "council" ? "analyze" : "implement";

  const result = await api("/api/jobs", {
    method: "POST",
    body: {
      goal,
      mode,
      requestedBy: "voice",
      metadata: {
        source: "realtime-tool",
        executor,
        voice: {
          confirmation: mode === "implement" ? "visual-required-for-write" : "read-only-analysis"
        }
      }
    }
  });
  state.selectedJobId = result.job.id;
  state.demandFilter = "all";
  appendMessage("system", `Demanda ${result.job.id} criada pela voz. Revise a confirmacao visual antes de executar.`);
  await refreshAll();
  return { ok: true, job: result.job };
}

function buildRealtimeTaskTitle(args) {
  const rawTitle = String(args.title || "").trim();
  if (!rawTitle) {
    return "";
  }

  const explicitDemandId = Number(args.demandId || 0);
  if (explicitDemandId > 0) {
    return `[Demanda #${explicitDemandId}] ${rawTitle}`;
  }

  const scope = String(args.scope || "").toLowerCase();
  if (scope.includes("plataforma") || scope.includes("cockpit") || scope.includes("aura")) {
    return `[Plataforma] ${rawTitle}`;
  }
  if (scope.includes("demanda") && state.selectedJob?.id) {
    return `[Demanda #${state.selectedJob.id}] ${rawTitle}`;
  }
  return rawTitle;
}

function safeJson(value) {
  if (!value) {
    return {};
  }
  if (typeof value === "object") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

function appendAssistantDelta(delta) {
  let last = els.conversation.lastElementChild;
  if (!last || !last.classList.contains("assistant") || last.dataset.streaming !== "true") {
    last = appendMessage("assistant", "");
    last.dataset.streaming = "true";
  }
  last.querySelector("p").textContent += delta;
}

function appendMessage(role, text, attachments = []) {
  const item = document.createElement("article");
  item.className = `message ${role}`;

  const avatar = document.createElement("span");
  avatar.className = "message-avatar";
  avatar.setAttribute("aria-hidden", "true");
  avatar.textContent = avatarForRole(role);

  const content = document.createElement("div");
  content.className = "message-content";
  const label = document.createElement("strong");
  label.textContent = labelForRole(role);
  const body = document.createElement("p");
  body.textContent = text;
  content.append(label, body);
  item.append(avatar, content);
  if (attachments.length) {
    content.append(renderMessageAttachments(attachments));
  }
  els.conversation.append(item);
  els.conversation.scrollTop = els.conversation.scrollHeight;
  return item;
}

function avatarForRole(role) {
  const labels = {
    user: "Vo",
    assistant: "A",
    system: "S"
  };
  return labels[role] || "A";
}

function labelForRole(role) {
  const labels = {
    user: "Voce",
    assistant: "AURA",
    system: "Sistema"
  };
  return labels[role] || role;
}

function renderMessageAttachments(attachments) {
  const list = document.createElement("div");
  list.className = "message-attachments";
  for (const attachment of attachments) {
    const card = document.createElement("figure");
    card.className = "message-attachment";
    if (attachment.type?.startsWith("image/")) {
      const image = document.createElement("img");
      image.src = attachment.dataUrl;
      image.alt = attachment.name;
      card.append(image);
    } else if (attachment.type?.startsWith("audio/")) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = attachment.dataUrl;
      card.append(audio);
    }
    const caption = document.createElement("figcaption");
    caption.textContent = `${attachment.kind}: ${attachment.name}`;
    card.append(caption);
    list.append(card);
  }
  return list;
}

function logEvent(type, payload) {
  state.events.unshift({ type, payload, at: new Date().toLocaleTimeString() });
  state.events = state.events.slice(0, 20);
  els.eventLog.replaceChildren(...state.events.map((event) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${event.at}</span><code>${event.type}</code>`;
    return item;
  }));
}

function iconButton(text, title) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-button";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

async function api(path, options = {}) {
  const headers = {
    "X-AURA-Session": state.sessionToken
  };
  if (options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(path, {
    method: options.method || "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Request failed: ${response.status}`);
    error.status = response.status;
    error.details = data;
    error.lockedBy = data.lockedBy;
    throw error;
  }
  return data;
}
