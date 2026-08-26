import { RealtimeClient } from "./realtime.js";

const state = {
  status: null,
  tasks: [],
  memories: [],
  jobs: [],
  selectedJobId: null,
  selectedJob: null,
  selectedJobEvents: [],
  selectedJobArtifacts: [],
  events: [],
  demandFilter: "all",
  sessionTab: "tasks",
  composerIntent: "chat",
  activeDemandTab: "summary",
  routineEnabled: localStorage.getItem("aura.routineEnabled") === "true",
  screenStream: null,
  realtime: null,
  sessionToken: ""
};

const els = {
  realtimePill: document.querySelector("#realtime-pill"),
  privacyPill: document.querySelector("#privacy-pill"),
  tasksPill: document.querySelector("#tasks-pill"),
  geminiPill: document.querySelector("#gemini-pill"),
  grokPill: document.querySelector("#grok-pill"),
  codexPill: document.querySelector("#codex-pill"),
  routineToggle: document.querySelector("#routine-toggle"),
  voiceButton: document.querySelector("#voice-button"),
  screenButton: document.querySelector("#screen-button"),
  stopScreenButton: document.querySelector("#stop-screen-button"),
  localForm: document.querySelector("#local-form"),
  localInput: document.querySelector("#local-input"),
  composerIntentButtons: Array.from(document.querySelectorAll("[data-composer-intent]")),
  conversation: document.querySelector("#conversation"),
  taskForm: document.querySelector("#task-form"),
  taskInput: document.querySelector("#task-input"),
  taskList: document.querySelector("#task-list"),
  memoryForm: document.querySelector("#memory-form"),
  memoryInput: document.querySelector("#memory-input"),
  memoryList: document.querySelector("#memory-list"),
  jobsRefreshButton: document.querySelector("#jobs-refresh-button"),
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
  toolsList: document.querySelector("#tools-list")
};

init();

async function init() {
  await loadSession();

  state.realtime = new RealtimeClient({
    onStatus: setVoiceStatus,
    onEvent: (event) => {
      logEvent(event.type, event);
      if (event.type === "response.done") {
        refreshAll();
      }
    },
    onTranscript: appendAssistantDelta,
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
      appendMessage("system", "Vou abrir o microfone e conectar a voz ao vivo.");
      await state.realtime.connect();
      els.voiceButton.dataset.connected = "true";
      els.voiceButton.textContent = "Desconectar voz";
    } catch (error) {
      appendMessage("system", `Nao consegui abrir a voz ao vivo: ${error.message}. Podemos continuar por texto local.`);
      setVoiceStatus("fallback");
    }
  });

  els.localForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const text = els.localInput.value.trim();
    if (!text) {
      return;
    }
    els.localInput.value = "";
    appendMessage("user", text);

    if (state.composerIntent !== "chat") {
      await createComposerDemand(text);
      return;
    }

    if (state.realtime?.sendText(text)) {
      return;
    }

    const response = await api("/api/local/chat", { method: "POST", body: { text } });
    appendMessage("assistant", response.reply);
    if (response.job?.id) {
      state.selectedJobId = response.job.id;
    }
    await refreshAll();
  });

  els.composerIntentButtons.forEach((button) => {
    button.addEventListener("click", () => {
      state.composerIntent = button.dataset.composerIntent;
      renderComposerIntents();
    });
  });

  els.taskForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const title = els.taskInput.value.trim();
    if (!title) {
      return;
    }
    els.taskInput.value = "";
    await api("/api/tasks", { method: "POST", body: { title } });
    await refreshAll();
  });

  els.memoryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    const content = els.memoryInput.value.trim();
    if (!content) {
      return;
    }
    els.memoryInput.value = "";
    await api("/api/memories", { method: "POST", body: { kind: "note", content } });
    await refreshAll();
  });

  els.screenButton.addEventListener("click", startScreenCapture);
  els.stopScreenButton.addEventListener("click", stopScreenCapture);
  els.jobsRefreshButton.addEventListener("click", refreshJobs);
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
}

async function createComposerDemand(text) {
  const mode = state.composerIntent === "execute" ? "implement" : "analyze";
  try {
    const result = await api("/api/jobs", {
      method: "POST",
      body: {
        goal: text,
        mode,
        requestedBy: "text",
        metadata: {
          source: "composer-intent",
          intent: state.composerIntent
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
    appendMessage("system", `Demanda nao criada: ${error.message}`);
  }
}

async function refreshAll() {
  const [status, tasksData, memoriesData, jobsData] = await Promise.all([
    api("/api/status"),
    api("/api/tasks"),
    api("/api/memories"),
    api("/api/jobs?limit=20")
  ]);

  state.status = status;
  state.tasks = tasksData.tasks;
  state.memories = memoriesData.memories;
  state.jobs = jobsData.jobs;
  await loadSelectedJob();
  renderStatus();
  renderTasks();
  renderMemories();
  renderJobs();
  renderTools();
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

  els.realtimePill.textContent = state.status.realtimeEnabled ? "Voz ao vivo" : "Voz local";
  els.realtimePill.className = `pill ${state.status.realtimeEnabled ? "ok" : "warn"}`;
  els.realtimePill.title = state.status.realtimeEnabled
    ? `Realtime ${state.status.realtimeModel} com voz ${state.status.realtimeVoice}.`
    : "OPENAI_API_KEY ausente; AURA opera com fallback local.";

  els.tasksPill.textContent = `${state.status.memory.openTasks} tarefas abertas`;
  els.tasksPill.className = "pill";

  renderProviderPill(els.geminiPill, state.status.providers?.gemini);
  renderProviderPill(els.grokPill, state.status.providers?.grok);
  renderProviderPill(els.codexPill, state.status.providers?.codex);
}

function renderProviderPill(element, provider = {}) {
  const name = provider.label || provider.name || element.textContent;
  const status = provider.status || "checking";
  const labels = {
    available: "pronto",
    unavailable: "indisponivel",
    checking: "verificando"
  };
  element.className = `provider-pill ${status}`;
  element.textContent = `${name} ${labels[status] || status}`;
  element.title = provider.available
    ? `${name} disponivel${provider.version ? `: ${provider.version}` : "."}`
    : provider.error || `${name} ainda nao verificado.`;
}

function renderComposerIntents() {
  els.composerIntentButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.composerIntent === state.composerIntent));
  });
}

function renderCouncil() {
  const seats = [
    councilSeatFor("codex", "Codex", "Executor local", "Arquivos, comandos e workspace."),
    councilSeatFor("gemini", "Gemini", "Analise alternativa", "Amplitude, contexto e comparacao."),
    councilSeatFor("grok", "Grok", "Critica e riscos", "Contrapontos, riscos e caminhos alternativos.")
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
    return "Gemini e Grok entram como analistas; Codex permanece em espera ate haver decisao de execucao.";
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

    const doneButton = iconButton(task.status === "done" ? "↩" : "✓", task.status === "done" ? "Reabrir" : "Concluir");
    doneButton.addEventListener("click", async () => {
      await api(`/api/tasks/${task.id}`, {
        method: "PATCH",
        body: { status: task.status === "done" ? "open" : "done" }
      });
      await refreshAll();
    });

    const deleteButton = iconButton("×", "Excluir");
    deleteButton.addEventListener("click", async () => {
      if (!confirm(`Excluir tarefa "${task.title}"?`)) {
        return;
      }
      await api(`/api/tasks/${task.id}?confirm=true`, { method: "DELETE" });
      await refreshAll();
    });

    actions.append(doneButton, deleteButton);
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
      await api(`/api/memories/${memory.id}?confirm=true`, { method: "DELETE" });
      await refreshAll();
    });

    item.append(content, deleteButton);
    return item;
  }));
}

function renderJobs() {
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
  els.demandFilterButtons.forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.demandFilter === state.demandFilter));
  });
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
    title.textContent = "Nenhuma demanda ativa";
    const copy = document.createElement("p");
    copy.textContent = "Quando voce criar ou selecionar uma demanda, AURA mostra aqui objetivo, status e proximo passo.";

    empty.append(title, copy);
    els.activeDemand.append(empty);
    return;
  }

  const job = state.selectedJob;
  const status = document.createElement("span");
  status.className = `status-chip ${job.status}`;
  status.textContent = labelForJobStatus(job.status);

  const goal = document.createElement("h3");
  goal.textContent = job.goal;

  const meta = document.createElement("p");
  meta.className = "active-demand-meta";
  meta.textContent = `Demanda #${job.id} · ${labelForJobMode(job.mode)} · ${labelForPolicy(job.policyLevel)}`;

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
    const councilHint = document.createElement("p");
    councilHint.className = "active-demand-next";
    const label = document.createElement("strong");
    label.textContent = "Conselho";
    const copy = document.createElement("span");
    copy.textContent = councilSummaryForJob(job);
    councilHint.append(label, copy);
    els.activeDemand.append(status, goal, meta, tabs, councilHint, action);
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
    els.activeDemand.append(status, goal, meta, tabs, technical, action);
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
    els.activeDemand.append(status, goal, meta, tabs, panel, action);
    return;
  }

  const timeline = renderDemandTimeline(job);
  const security = renderSecurityBand(job);
  const alert = renderHumanFailure(job);
  els.activeDemand.append(status, goal, meta, tabs);
  els.activeDemand.append(timeline);
  if (security) {
    els.activeDemand.append(security);
  }
  if (alert) {
    els.activeDemand.append(alert);
  }
  els.activeDemand.append(next, facts, action);
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

function humanizeJobMessage(value) {
  const text = String(value || "").trim();
  const lower = text.toLowerCase();
  if (!text) {
    return "";
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
    try {
      appendMessage("system", `Executando demanda #${job.id} com Codex apos aprovacao visual.`);
      await api(`/api/jobs/${job.id}/codex/implement`, {
        method: "POST",
        body: { confirmed: true, prompt: job.goal }
      });
      await refreshJobs();
    } catch (error) {
      appendMessage("system", `Aprovacao nao concluida: ${error.message}`);
      await refreshJobs();
    }
  });

  const deny = document.createElement("button");
  deny.type = "button";
  deny.className = "danger-button";
  deny.textContent = "Negar";
  deny.addEventListener("click", async () => {
    const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    await refreshJobs();
    appendMessage("system", `Demanda #${job.id} negada sem executar.`);
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
      const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      await refreshJobs();
      logEvent("job.cancel", { id: job.id, status: result.job.status });
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
      let result = null;
      try {
        result = await api(`/api/jobs/${job.id}/codex/implement`, {
          method: "POST",
          body: { confirmed: true, prompt: job.goal }
        });
        state.selectedJob = result.job;
        state.selectedJobEvents = result.events || [];
        state.selectedJobArtifacts = result.artifacts || [];
      } catch (error) {
        appendMessage("system", `Implementacao nao concluida: ${error.message}`);
      }
      await refreshJobs();
      logEvent("job.implement", { id: job.id, status: result?.job?.status || "failed" });
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
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.className = "primary";
  runButton.textContent = "Consultar";
  runButton.addEventListener("click", async () => {
    const consent = {
      gemini: gemini.input.checked,
      grok: grok.input.checked
    };
    if (!consent.gemini && !consent.grok) {
      appendMessage("system", "Selecione ao menos um analista.");
      return;
    }
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

  controls.append(gemini.label, grok.label, runButton);
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
    const result = await api(`/api/jobs/${job.id}/approve`, { method: "POST" });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    state.selectedJobArtifacts = result.artifacts || [];
    await refreshJobs();
    logEvent("job.approve", { id: job.id, status: result.job.status });
  });

  const discard = document.createElement("button");
  discard.type = "button";
  discard.className = "danger-button";
  discard.textContent = "Descartar";
  discard.addEventListener("click", async () => {
    const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    await refreshJobs();
    logEvent("job.discard", { id: job.id, status: result.job.status });
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api(`/api/jobs/${job.id}`, {
      method: "PATCH",
      body: {
        goal: input.value.trim(),
        mode: mode.value
      }
    });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    state.selectedJobArtifacts = result.artifacts || [];
    await refreshJobs();
    logEvent("job.draft.update", { id: job.id });
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
    "Destinations: Gemini, Grok",
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
  for (const value of ["analyze", "ask"]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    mode.append(option);
  }

  const button = document.createElement("button");
  button.type = "submit";
  button.textContent = "Criar demanda";

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const result = await api("/api/routine/jobs", {
      method: "POST",
      body: {
        goal: input.value.trim(),
        mode: mode.value
      }
    });
    state.selectedJobId = result.job.id;
    await refreshAll();
    logEvent("routine.job.created", { id: result.job.id, mode: result.job.mode });
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
}

function setVoiceStatus(status) {
  const labels = {
    idle: "AURA esta pronta para conversar por texto.",
    fallback: "Voz ao vivo indisponivel; continuo com voce por texto local.",
    "requesting-token": "Estou preparando uma sessao segura de voz.",
    "requesting-microphone": "O navegador vai pedir acesso ao microfone.",
    negotiating: "Estou conectando o canal de voz ao vivo.",
    connected: "Voz ao vivo conectada. Pode falar comigo.",
    closed: "Voz encerrada. Continuo disponivel por texto."
  };
  appendMessage("system", labels[status] || status);
  if (status === "idle" || status === "closed" || status === "fallback") {
    els.voiceButton.dataset.connected = "false";
    els.voiceButton.textContent = "Conectar voz";
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

function appendMessage(role, text) {
  const item = document.createElement("article");
  item.className = `message ${role}`;
  const label = document.createElement("strong");
  label.textContent = role === "user" ? "Voce" : role === "assistant" ? "AURA" : "Sistema";
  const body = document.createElement("p");
  body.textContent = text;
  item.append(label, body);
  els.conversation.append(item);
  els.conversation.scrollTop = els.conversation.scrollHeight;
  return item;
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
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}
