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
  routineEnabled: localStorage.getItem("aura.routineEnabled") === "true",
  screenStream: null,
  realtime: null,
  sessionToken: ""
};

const els = {
  realtimePill: document.querySelector("#realtime-pill"),
  dbPill: document.querySelector("#db-pill"),
  routineToggle: document.querySelector("#routine-toggle"),
  voiceButton: document.querySelector("#voice-button"),
  screenButton: document.querySelector("#screen-button"),
  stopScreenButton: document.querySelector("#stop-screen-button"),
  localForm: document.querySelector("#local-form"),
  localInput: document.querySelector("#local-input"),
  conversation: document.querySelector("#conversation"),
  taskForm: document.querySelector("#task-form"),
  taskInput: document.querySelector("#task-input"),
  taskList: document.querySelector("#task-list"),
  memoryForm: document.querySelector("#memory-form"),
  memoryInput: document.querySelector("#memory-input"),
  memoryList: document.querySelector("#memory-list"),
  jobsRefreshButton: document.querySelector("#jobs-refresh-button"),
  jobList: document.querySelector("#job-list"),
  jobDetail: document.querySelector("#job-detail"),
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
      appendMessage("system", "Conectando voz em tempo real...");
      await state.realtime.connect();
      els.voiceButton.dataset.connected = "true";
      els.voiceButton.textContent = "Desconectar voz";
    } catch (error) {
      appendMessage("system", `Voz real indisponivel: ${error.message}`);
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
  renderRoutine();
}

async function refreshJobs() {
  const jobsData = await api("/api/jobs?limit=20");
  state.jobs = jobsData.jobs;
  await loadSelectedJob();
  renderJobs();
}

async function loadSelectedJob() {
  if (!state.jobs.length) {
    state.selectedJobId = null;
    state.selectedJob = null;
    state.selectedJobEvents = [];
    state.selectedJobArtifacts = [];
    return;
  }

  if (!state.selectedJobId || !state.jobs.some((job) => job.id === state.selectedJobId)) {
    state.selectedJobId = state.jobs[0].id;
  }

  const detail = await api(`/api/jobs/${state.selectedJobId}`);
  state.selectedJob = detail.job;
  state.selectedJobEvents = detail.events || [];
  state.selectedJobArtifacts = detail.artifacts || [];
}

function renderStatus() {
  els.realtimePill.textContent = state.status.realtimeEnabled ? "Realtime pronto" : "Fallback local";
  els.realtimePill.className = `pill ${state.status.realtimeEnabled ? "ok" : "warn"}`;
  els.dbPill.textContent = `${state.status.memory.openTasks} tarefas abertas`;
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
  if (!state.jobs.length) {
    const empty = document.createElement("li");
    empty.className = "empty";
    empty.textContent = "Nenhum job registrado.";
    els.jobList.replaceChildren(empty);
    renderJobDetail();
    return;
  }

  els.jobList.replaceChildren(...state.jobs.map((job) => {
    const item = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `job-row ${job.id === state.selectedJobId ? "selected" : ""}`;
    button.setAttribute("aria-pressed", String(job.id === state.selectedJobId));

    const title = document.createElement("span");
    title.className = "job-title";
    title.textContent = job.goal;

    const meta = document.createElement("small");
    meta.textContent = `#${job.id} · ${job.mode} · ${job.policyLevel}`;

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
  title.textContent = `Job #${job.id}`;
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
      if (!confirm(`Cancelar job #${job.id}?`)) {
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
      if (!confirm(`Executar job #${job.id} com permissao de escrita no workspace?`)) {
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
    summary.querySelector("span").textContent = job.summary;
    notes.append(summary);
  }
  if (job.error) {
    const error = document.createElement("p");
    error.className = "error-text";
    error.innerHTML = `<strong>Erro</strong><span></span>`;
    error.querySelector("span").textContent = job.error;
    notes.append(error);
  }

  const eventTitle = document.createElement("h3");
  eventTitle.textContent = "Eventos";
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
  els.jobDetail.append(notes, artifactTitle, artifactList, eventTitle, eventList);
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
    els.routinePanel.textContent = "Rotina pausada.";
    return;
  }

  const tasks = state.tasks.filter((task) => task.status !== "done");
  const summary = document.createElement("p");
  summary.textContent = tasks.length
    ? `Hoje: ${tasks.map((task) => task.title).join(" · ")}`
    : "Rotina ativa. Nenhuma tarefa aberta agora.";

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
  button.textContent = "Sugerir";

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
    idle: "Voz parada",
    fallback: "Fallback local",
    "requesting-token": "Pedindo token",
    "requesting-microphone": "Pedindo microfone",
    negotiating: "Negociando WebRTC",
    connected: "Voz conectada",
    closed: "Voz encerrada"
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
