import { RealtimeClient } from "./realtime.js";
import { buildSpeakableNow, shouldNarrateNow } from "./nowNarration.js";
import {
  buildCouncilImplementationPlan,
  implementationEvidenceFromArtifacts,
  implementationGoalFromPlan
} from "./councilPlan.js";
import { buildExecutiveCouncilBriefing } from "./councilBriefing.js";
import { buildProactiveSuggestion, recordProactiveDecision } from "./proactive.js";
import {
  createScreenPerception,
  finishScreenPerception,
  formatCountdown,
  isPerceptionExpired,
  normalizePerceptionDurationMs,
  remainingPerceptionMs
} from "./screenPerception.js";
import { redactClientObject, redactClientText } from "./clientPrivacy.js";

const state = {
  status: null,
  now: null,
  tasks: [],
  memories: [],
  costs: null,
  github: null,
  githubIssueState: "open",
  localFiles: null,
  codexActivity: null,
  localFileRoot: 0,
  localFilePath: ".",
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
  screenPerception: null,
  screenPerceptionTimer: null,
  lastPerceptionSummary: "",
  voiceMetrics: null,
  realtime: null,
  narrationEnabled: localStorage.getItem("aura.narrationEnabled") !== "false",
  proactivityEnabled: localStorage.getItem("aura.proactivityEnabled") !== "false",
  proactivityLedger: loadJsonSetting("aura.proactivityLedger", { decisions: {}, history: [] }),
  proactiveSuggestion: null,
  narrationQueue: [],
  narrationSpeaking: false,
  narrationBootstrapped: false,
  lastNarrationId: "",
  spokenNarrationIds: new Set(),
  recordedRealtimeUsage: new Set(),
  sessionToken: ""
};

const els = {
  realtimePill: document.querySelector("#realtime-pill"),
  privacyPill: document.querySelector("#privacy-pill"),
  tasksPill: document.querySelector("#tasks-pill"),
  topNextStep: document.querySelector("#top-next-step"),
  nowHud: document.querySelector("#now-hud"),
  proactiveSuggestion: document.querySelector("#proactive-suggestion"),
  routineToggle: document.querySelector("#routine-toggle"),
  voiceButton: document.querySelector("#voice-button"),
  screenButton: document.querySelector("#screen-button"),
  attachScreenEvidenceButton: document.querySelector("#attach-screen-evidence-button"),
  stopScreenButton: document.querySelector("#stop-screen-button"),
  screenDurationSelect: document.querySelector("#screen-duration-select"),
  purgeScreenEvidenceButton: document.querySelector("#purge-screen-evidence-button"),
  screenPerceptionStatus: document.querySelector("#screen-perception-status"),
  screenPerceptionLabel: document.querySelector("#screen-perception-label"),
  screenPerceptionPurpose: document.querySelector("#screen-perception-purpose"),
  screenPerceptionTimer: document.querySelector("#screen-perception-timer"),
  localForm: document.querySelector("#local-form"),
  localInput: document.querySelector("#local-input"),
  localSubmitButton: document.querySelector("#local-submit-button"),
  voicePanel: document.querySelector(".voice-panel"),
  narrationToggle: document.querySelector("#narration-toggle"),
  voiceMetrics: document.querySelector("#voice-metrics"),
  commandBrief: document.querySelector("#command-brief"),
  attachmentInput: document.querySelector("#attachment-input"),
  attachmentTray: document.querySelector("#attachment-tray"),
  composerIntentButtons: Array.from(document.querySelectorAll("[data-composer-intent]")),
  conversation: document.querySelector("#conversation"),
  taskForm: document.querySelector("#task-form"),
  taskInput: document.querySelector("#task-input"),
  taskList: document.querySelector("#task-list"),
  memoryForm: document.querySelector("#memory-form"),
  memoryInput: document.querySelector("#memory-input"),
  purgeMemoriesButton: document.querySelector("#purge-memories-button"),
  memoryList: document.querySelector("#memory-list"),
  costsRefreshButton: document.querySelector("#costs-refresh-button"),
  costsPanel: document.querySelector("#costs-panel"),
  githubRefreshButton: document.querySelector("#github-refresh-button"),
  githubStateSelect: document.querySelector("#github-state-select"),
  githubPanel: document.querySelector("#github-panel"),
  localFilesRefreshButton: document.querySelector("#local-files-refresh-button"),
  localFilesPanel: document.querySelector("#local-files-panel"),
  codexActivityRefreshButton: document.querySelector("#codex-activity-refresh-button"),
  codexActivityPanel: document.querySelector("#codex-activity-panel"),
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
    onVoiceMetrics: (metrics) => {
      state.voiceMetrics = metrics;
      renderVoiceMetrics();
      renderCommandBrief();
    },
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

  els.narrationToggle?.addEventListener("click", () => {
    state.narrationEnabled = !state.narrationEnabled;
    localStorage.setItem("aura.narrationEnabled", String(state.narrationEnabled));
    renderNarrationToggle();
    if (state.narrationEnabled) {
      drainNarrationQueue();
    } else if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
      state.narrationQueue = [];
      state.narrationSpeaking = false;
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
  els.purgeMemoriesButton?.addEventListener("click", purgeMemories);

  els.screenButton.addEventListener("click", startScreenCapture);
  els.attachScreenEvidenceButton.addEventListener("click", attachScreenEvidenceToJob);
  els.stopScreenButton.addEventListener("click", stopScreenCapture);
  els.purgeScreenEvidenceButton?.addEventListener("click", purgeScreenEvidence);
  els.costsRefreshButton.addEventListener("click", refreshCosts);
  els.githubRefreshButton?.addEventListener("click", refreshGitHubIssues);
  els.githubStateSelect?.addEventListener("change", async () => {
    state.githubIssueState = els.githubStateSelect.value || "open";
    await refreshGitHubIssues();
  });
  els.localFilesRefreshButton?.addEventListener("click", refreshLocalFiles);
  els.codexActivityRefreshButton?.addEventListener("click", refreshCodexActivity);
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
      if (state.sessionTab === "github") {
        refreshGitHubIssues().catch((error) => logEvent("github.refresh.failed", { error: error.message }));
      }
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
  const [status, nowData, tasksData, memoriesData, jobsData, costsData, githubData, localFilesData, codexActivityData] = await Promise.all([
    api("/api/status"),
    api("/api/now"),
    api("/api/tasks"),
    api("/api/memories"),
    api("/api/jobs?limit=20"),
    api("/api/costs"),
    loadGitHubIssues(),
    loadLocalFiles(),
    api("/api/codex/activity")
  ]);

  state.status = status;
  state.now = nowData.now;
  state.tasks = tasksData.tasks;
  state.memories = memoriesData.memories;
  state.jobs = jobsData.jobs;
  state.costs = costsData;
  state.github = githubData;
  state.localFiles = localFilesData;
  state.codexActivity = codexActivityData;
  await loadSelectedJob();
  renderStatus();
  renderNarrationToggle();
  renderNowHud();
  renderProactiveSuggestion();
  enqueueNowNarration();
  renderTopNextStep();
  renderTopView();
  renderTasks();
  renderMemories();
  renderJobs();
  renderTools();
  renderCosts();
  renderGitHubIssues();
  renderLocalFiles();
  renderCodexActivity();
  renderCommandBrief();
  renderVoiceMetrics();
  renderIntegrations();
  renderScreenPerceptionStatus();
  renderLocalContextSummary();
  renderComposerIntents();
  renderCouncil();
  renderSessionTabs();
  renderRoutine();
}

async function refreshJobs() {
  const [nowData, jobsData] = await Promise.all([
    api("/api/now"),
    api("/api/jobs?limit=20")
  ]);
  state.now = nowData.now;
  state.jobs = jobsData.jobs;
  state.codexActivity = await api("/api/codex/activity");
  await loadSelectedJob();
  renderJobs();
  renderCouncil();
  renderLocalContextSummary();
  renderNowHud();
  renderProactiveSuggestion();
  enqueueNowNarration();
  renderTopNextStep();
  renderCommandBrief();
  renderCodexActivity();
}

async function refreshCosts() {
  state.costs = await api("/api/costs");
  renderCosts();
  renderCommandBrief();
}

async function refreshGitHubIssues() {
  state.github = await loadGitHubIssues();
  renderGitHubIssues();
  renderIntegrations();
  renderLocalContextSummary();
}

async function refreshLocalFiles() {
  state.localFiles = await loadLocalFiles();
  renderLocalFiles();
}

async function refreshCodexActivity() {
  state.codexActivity = await api("/api/codex/activity");
  renderCodexActivity();
}

function loadLocalFiles() {
  const root = encodeURIComponent(String(state.localFileRoot || 0));
  const relativePath = encodeURIComponent(state.localFilePath || ".");
  return api(`/api/local-files/list?root=${root}&path=${relativePath}`);
}

async function loadGitHubIssues() {
  try {
    return await api(`/api/github/issues?state=${encodeURIComponent(state.githubIssueState)}&limit=30`);
  } catch (error) {
    return {
      status: error.status || 0,
      github: error.details?.github || null,
      issues: [],
      error: error.message
    };
  }
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
    state.selectedJobId = preferredMissionJob(candidates).id;
  }

  const detail = await api(`/api/jobs/${state.selectedJobId}`);
  state.selectedJob = detail.job;
  state.selectedJobEvents = detail.events || [];
  state.selectedJobArtifacts = detail.artifacts || [];
}

function renderStatus() {
  els.privacyPill.textContent = "Local privado";
  els.privacyPill.title = "Servidor local em 127.0.0.1; chave OpenAI fica no servidor.";

  const voiceHealth = state.status.voice || {};
  const voiceProvider = voiceHealth.providerLabel || (state.status.realtimeProvider === "gemini" ? "Gemini Live" : "OpenAI");
  els.realtimePill.textContent = state.status.realtimeEnabled
    ? `Voz: ${voiceProvider}`
    : (voiceHealth.status === "configuration_error" ? "Voz: revisar config" : "Voz local");
  els.realtimePill.className = `pill ${state.status.realtimeEnabled ? "ok" : "warn"}`;
  els.realtimePill.title = state.status.realtimeEnabled
    ? `${voiceProvider} · ${state.status.realtimeModel} · voz ${state.status.realtimeVoice}. Health ${voiceHealth.latencyMs ?? 0}ms.`
    : (voiceHealth.fallbackReason || "Voz ao vivo indisponivel; AURA opera com fallback local.");

  els.tasksPill.textContent = `${state.status.memory.openTasks} tarefas abertas`;
  els.tasksPill.className = "pill";

  renderIntegrations();
}

function renderNowHud() {
  if (!els.nowHud) {
    return;
  }

  const now = state.now;
  els.nowHud.replaceChildren();
  if (!now) {
    els.nowHud.hidden = true;
    return;
  }
  els.nowHud.hidden = false;
  els.nowHud.dataset.state = now.state || "idle";
  els.nowHud.dataset.severity = now.severity || "info";
  els.nowHud.dataset.source = now.source || "operator";

  const title = document.createElement("div");
  title.className = "now-hud-main";
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "Agora";
  const headline = document.createElement("strong");
  headline.textContent = now.headline || "AURA pronta";
  const next = document.createElement("p");
  next.textContent = now.nextStep || "Diga ou escreva uma missao para AURA organizar o trabalho.";
  title.append(eyebrow, headline, next);

  const facts = document.createElement("div");
  facts.className = "now-hud-facts";
  facts.append(
    nowHudFact("Voz", now.realtime?.label || "Voz local"),
    nowHudFact("Estado", labelForNowState(now.state)),
    nowHudFact("Bloqueios", formatInteger(now.blockers?.length || 0))
  );

  const action = document.createElement("button");
  action.type = "button";
  action.className = now.cta?.kind === "cancel" ? "danger-button" : "primary";
  action.textContent = now.cta?.label || "Ver agora";
  action.dataset.actionId = now.actionId || now.cta?.actionId || "";
  action.title = `Origem: ${now.source || "operador"} · confianca: ${now.confidence || "media"}`;
  action.disabled = now.cta?.enabled === false;
  action.addEventListener("click", () => runNowAction(now, action));

  els.nowHud.append(title, facts, action);
}

function renderProactiveSuggestion() {
  if (!els.proactiveSuggestion) {
    return;
  }

  els.proactiveSuggestion.replaceChildren();
  if (!state.proactivityEnabled) {
    els.proactiveSuggestion.hidden = false;
    const body = proactiveSuggestionBody({
      label: "Sugestoes pausadas",
      body: "AURA nao vai iniciar proximas acoes ate voce reativar.",
      benefit: "Controle total do ritmo do cockpit.",
      costRisk: "Nenhum custo de API por sugestoes enquanto estiver pausado."
    });
    const enable = document.createElement("button");
    enable.type = "button";
    enable.textContent = "Ativar sugestoes";
    enable.addEventListener("click", () => {
      state.proactivityEnabled = true;
      localStorage.setItem("aura.proactivityEnabled", "true");
      renderProactiveSuggestion();
      logEvent("proactive.enabled", {});
    });
    els.proactiveSuggestion.append(body, enable);
    return;
  }

  const suggestion = buildProactiveSuggestion({
    now: state.now,
    jobs: state.jobs,
    tasks: state.tasks
  }, state.proactivityLedger, {
    enabled: state.proactivityEnabled,
    activeSignature: state.proactiveSuggestion?.signature
  });

  state.proactiveSuggestion = suggestion;
  if (!suggestion) {
    els.proactiveSuggestion.hidden = true;
    return;
  }

  if (state.proactiveSuggestion?.signature !== suggestion.signature) {
    state.proactivityLedger = recordProactiveDecision(state.proactivityLedger, suggestion, "shown");
    saveProactivityLedger();
  }

  els.proactiveSuggestion.hidden = false;
  const body = proactiveSuggestionBody(suggestion);
  const actions = document.createElement("div");
  actions.className = "proactive-actions";

  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "primary";
  accept.textContent = "Aceitar";
  accept.addEventListener("click", async () => {
    recordSuggestionAction(suggestion, "accepted");
    await runProactiveAction(suggestion, accept);
  });

  const snooze = document.createElement("button");
  snooze.type = "button";
  snooze.textContent = "Adiar";
  snooze.addEventListener("click", () => {
    recordSuggestionAction(suggestion, "snoozed");
    appendMessage("system", "Sugestao adiada. AURA nao vai repetir agora.");
    renderProactiveSuggestion();
  });

  const dismiss = document.createElement("button");
  dismiss.type = "button";
  dismiss.textContent = "Recusar";
  dismiss.addEventListener("click", () => {
    recordSuggestionAction(suggestion, "dismissed");
    appendMessage("system", "Sugestao recusada. AURA respeitou e nao vai insistir neste evento.");
    renderProactiveSuggestion();
  });

  const mute = document.createElement("button");
  mute.type = "button";
  mute.className = "secondary";
  mute.textContent = "Silenciar sugestoes";
  mute.addEventListener("click", () => {
    state.proactivityEnabled = false;
    localStorage.setItem("aura.proactivityEnabled", "false");
    logEvent("proactive.muted", {});
    renderProactiveSuggestion();
  });

  actions.append(accept, snooze, dismiss, mute);
  els.proactiveSuggestion.append(body, actions);
}

function proactiveSuggestionBody(suggestion) {
  const body = document.createElement("div");
  body.className = "proactive-body";
  const label = document.createElement("span");
  label.textContent = "Sugestao AURA";
  const title = document.createElement("strong");
  title.textContent = suggestion.label;
  const copy = document.createElement("p");
  copy.textContent = suggestion.body;
  const meta = document.createElement("dl");
  appendFact(meta, "Beneficio", suggestion.benefit);
  appendFact(meta, "Custo/risco", suggestion.costRisk);
  body.append(label, title, copy, meta);
  return body;
}

async function runProactiveAction(suggestion, button) {
  await withBusyButton(button, "Abrindo", async () => {
    if (suggestion.action?.jobId) {
      state.selectedJobId = suggestion.action.jobId;
      await loadSelectedJob();
      renderJobs();
      renderActiveDemand();
      document.querySelector(".active-demand-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else if (suggestion.action?.kind === "task") {
      openSessionPanel("tasks");
    } else {
      els.localInput?.focus();
    }
    renderProactiveSuggestion();
    logEvent("proactive.accepted", { signature: suggestion.signature, event: suggestion.event });
  });
}

function recordSuggestionAction(suggestion, action) {
  state.proactivityLedger = recordProactiveDecision(state.proactivityLedger, suggestion, action);
  saveProactivityLedger();
}

function saveProactivityLedger() {
  localStorage.setItem("aura.proactivityLedger", JSON.stringify(state.proactivityLedger));
}

function renderNarrationToggle() {
  if (!els.narrationToggle) {
    return;
  }
  els.narrationToggle.textContent = state.narrationEnabled ? "Silenciar narracao" : "Ativar narracao";
  els.narrationToggle.setAttribute("aria-pressed", String(state.narrationEnabled));
  els.narrationToggle.title = state.narrationEnabled
    ? "Pausar narracoes curtas do estado Agora sem desligar o cockpit."
    : "Reativar narracoes curtas do estado Agora.";
}

function enqueueNowNarration() {
  const item = buildSpeakableNow(state.now);
  if (!item) {
    state.narrationBootstrapped = true;
    return;
  }

  if (!state.narrationBootstrapped) {
    state.narrationBootstrapped = true;
    state.lastNarrationId = item.id;
    return;
  }

  if (!shouldNarrateNow(item, {
    lastId: state.lastNarrationId,
    spokenIds: state.spokenNarrationIds
  })) {
    return;
  }

  state.lastNarrationId = item.id;
  if (!state.narrationEnabled) {
    return;
  }

  state.spokenNarrationIds.add(item.id);
  state.narrationQueue.push(item);
  drainNarrationQueue();
}

function drainNarrationQueue() {
  if (state.narrationSpeaking || !state.narrationEnabled) {
    return;
  }
  const next = state.narrationQueue.shift();
  if (!next) {
    return;
  }
  speakNarration(next.text).finally(() => {
    state.narrationSpeaking = false;
    drainNarrationQueue();
  });
}

function speakNarration(text) {
  state.narrationSpeaking = true;
  logEvent("voice.narration.queued", { text });
  if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
    appendMessage("system", `Narracao: ${text}`);
    return Promise.resolve();
  }

  window.speechSynthesis.cancel();
  return new Promise((resolve) => {
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = "pt-BR";
    utterance.rate = 1;
    utterance.pitch = 1;
    utterance.onend = resolve;
    utterance.onerror = resolve;
    window.speechSynthesis.speak(utterance);
  });
}

function nowHudFact(label, value) {
  const item = document.createElement("span");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value || "-";
  item.append(small, strong);
  return item;
}

function labelForNowState(state) {
  const labels = {
    idle: "calmo",
    running: "em execucao",
    blocked: "decisao pendente",
    failed: "falha",
    cancelled: "cancelada",
    completed: "concluida"
  };
  return labels[state] || "calmo";
}

async function runNowAction(now, button) {
  const job = now?.activeJob;
  if (!job) {
    els.localInput?.focus();
    return;
  }

  state.selectedJobId = job.id;
  await loadSelectedJob();
  renderJobs();
  renderActiveDemand();

  if (now.cta?.kind === "cancel") {
    if (!confirm(`Cancelar demanda #${job.id}?`)) {
      return;
    }
    await withBusyButton(button, "Cancelando", async () => {
      const result = await api(`/api/jobs/${job.id}/cancel`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      await refreshJobs();
      logEvent("job.cancel", { id: job.id, status: result.job.status });
    });
    return;
  }

  if (now.cta?.kind === "approve" && job.status === "draft") {
    await withBusyButton(button, "Aprovando", async () => {
      const result = await api(`/api/jobs/${job.id}/approve`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      await refreshJobs();
      logEvent("job.approve", { id: job.id, status: result.job.status });
    });
    return;
  }

  document.querySelector(".active-demand-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderTopNextStep() {
  if (!els.topNextStep) {
    return;
  }

  if (state.now?.nextStep) {
    els.topNextStep.textContent = state.now.nextStep;
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

function renderCommandBrief() {
  if (!els.commandBrief) {
    return;
  }

  const voiceProvider = state.status?.voice?.providerLabel || (state.status?.realtimeProvider === "gemini" ? "Gemini Live" : "OpenAI");
  const voiceState = state.status?.realtimeEnabled ? voiceProvider : "Texto local";
  const selected = state.selectedJob;
  const cost = state.costs?.totals?.estimatedCostUsd || 0;
  const tokens = state.costs?.totals?.tokens || 0;
  const intentLabels = {
    chat: "Conversar",
    council: "Conselho",
    execute: "Codex"
  };
  const items = [
    ["Modo", intentLabels[state.composerIntent] || "Conversar", modeHintForComposer()],
    ["Voz", voiceState, voiceMetricsDetail() || (state.status?.realtimeEnabled ? "standby por wake word" : (state.status?.voice?.fallbackReason || "fallback local"))],
    ["Custo", formatUsd(cost), `${formatInteger(tokens)} tokens`],
    ["Demanda", selected ? `#${selected.id}` : "Nenhuma", selected ? nextStepForJob(selected) : "pronta para uma nova missao"]
  ];

  els.commandBrief.replaceChildren(...items.map(([label, value, detail]) => {
    const item = document.createElement("article");
    const small = document.createElement("small");
    small.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const span = document.createElement("span");
    span.textContent = detail;
    item.append(small, strong, span);
    return item;
  }));
}

function renderVoiceMetrics() {
  if (!els.voiceMetrics) {
    return;
  }
  const metrics = state.voiceMetrics;
  if (!metrics) {
    els.voiceMetrics.hidden = true;
    els.voiceMetrics.replaceChildren();
    return;
  }
  els.voiceMetrics.hidden = false;
  els.voiceMetrics.replaceChildren(
    voiceMetricChip("Estado", labelForVoiceTurn(metrics.turnState)),
    voiceMetricChip("Captura", formatLatency(metrics.captureLatencyMs)),
    voiceMetricChip("1a resposta", formatLatency(metrics.firstResponseLatencyMs)),
    voiceMetricChip("Conclusao", formatLatency(metrics.conclusionLatencyMs)),
    voiceMetricChip("Interrupcoes", formatInteger(metrics.interruptions || 0)),
    voiceMetricChip("Turno", labelForTurnTaking(metrics.turnTakingMode))
  );
}

function voiceMetricChip(label, value) {
  const chip = document.createElement("span");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  chip.append(small, strong);
  return chip;
}

function voiceMetricsDetail() {
  const metrics = state.voiceMetrics;
  if (!metrics) {
    return "";
  }
  const parts = [
    labelForVoiceTurn(metrics.turnState),
    `captura ${formatLatency(metrics.captureLatencyMs)}`,
    `1a resposta ${formatLatency(metrics.firstResponseLatencyMs)}`
  ];
  if (metrics.interruptions) {
    parts.push(`${metrics.interruptions} interrupcao(oes)`);
  }
  return parts.join(" · ");
}

function labelForVoiceTurn(value) {
  const labels = {
    connecting: "conectando",
    idle: "parada",
    listening: "ouvindo",
    speaking: "falando"
  };
  return labels[value] || "standby";
}

function labelForTurnTaking(value) {
  const labels = {
    conversation: "conversa",
    long_conversation: "conversa longa",
    quick_command: "comando curto",
    standby: "standby",
    summary_request: "resumo"
  };
  return labels[value] || "standby";
}

function formatLatency(value) {
  return Number.isFinite(value) ? `${Math.round(value)}ms` : "-";
}

function modeHintForComposer() {
  if (state.composerIntent === "execute") {
    return "cria demanda de escrita";
  }
  if (state.composerIntent === "council") {
    return "consulta analistas";
  }
  return "resposta local ou voz";
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
  if (els.voicePanel) {
    els.voicePanel.dataset.intent = state.composerIntent;
  }
  const submitLabels = {
    chat: "Enviar",
    council: "Consultar",
    execute: "Preparar"
  };
  const placeholders = {
    chat: "Ex.: Aura, organize meu proximo passo",
    council: "Ex.: Avalie o layout atual com Gemini, Grok e OpenRouter",
    execute: "Ex.: Desenvolva a melhoria da tela inicial com Codex"
  };
  els.localSubmitButton.textContent = submitLabels[state.composerIntent] || "Enviar";
  els.localInput.placeholder = placeholders[state.composerIntent] || placeholders.chat;
  renderCommandBrief();
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
    integrationItemForGitHub(),
    {
      name: "Workspace",
      role: "Cockpit local",
      detail: "127.0.0.1 · dados locais",
      state: "available"
    }
  ];

  const tickerItems = [...items, ...items];

  els.integrationsList.replaceChildren(...tickerItems.map((item, index) => {
    const row = document.createElement("article");
    row.className = `integration-card ${item.state}`;
    if (index >= items.length) {
      row.setAttribute("aria-hidden", "true");
    }

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
    if (item.circuit?.open && item.key && index < items.length) {
      const reset = document.createElement("button");
      reset.type = "button";
      reset.className = "integration-reset-button";
      reset.textContent = "Resetar circuito";
      reset.title = "Libera nova tentativa manual sem executar a demanda automaticamente.";
      reset.addEventListener("click", async () => {
        await withBusyButton(reset, "Resetando", async () => resetProviderCircuit(item.key));
      });
      row.append(reset);
    }
    return row;
  }));
}

function integrationItemForGitHub() {
  const github = state.github?.github || state.github?.status || {};
  const openCount = state.githubIssueState === "open" ? state.github?.issues?.length || 0 : null;
  return {
    key: "github",
    name: "GitHub",
    role: "Issues",
    detail: github.configured
      ? `${github.repo || "repo"}${openCount === null ? "" : ` · ${formatInteger(openCount)} aberta(s)`}`
      : github.error || "gh auth login ou GITHUB_TOKEN pendente",
    state: github.configured ? "available" : "unavailable"
  };
}

function integrationItemForProvider(name, provider = {}) {
  const status = provider.status || (provider.available ? "available" : "unavailable");
  const circuit = provider.circuit || {};
  const retryLabel = circuit.retryAt ? `Proxima tentativa ${formatDateTime(circuit.retryAt)}` : "";
  return {
    key: provider.name || String(name || "").toLowerCase(),
    name: provider.label || name,
    role: roleForProvider(provider.name || name),
    detail: circuit.open
      ? [provider.error || circuit.reason || "Circuit breaker ativo.", retryLabel].filter(Boolean).join(" · ")
      : provider.available
        ? provider.note || provider.version || "CLI disponivel"
        : provider.error || "nao configurado neste ambiente",
    state: status,
    circuit
  };
}

async function resetProviderCircuit(provider) {
  const result = await api(`/api/providers/${provider}/circuit/reset`, {
    method: "POST",
    body: { jobId: state.selectedJob?.id || null }
  });
  appendMessage("system", `${displayProviderName(result.provider)} liberado para nova tentativa manual. Nenhuma execucao foi iniciada automaticamente.`);
  await refreshAll();
  logEvent("provider.circuit.reset", { provider: result.provider, jobId: state.selectedJob?.id || null });
}

function displayProviderName(provider) {
  const labels = {
    gemini: "Gemini",
    grok: "Grok",
    openrouter: "OpenRouter"
  };
  return labels[provider] || provider;
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
    detected: "detectado",
    unavailable: "off",
    checking: "local",
    circuit_open: "cooldown"
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

  const intro = renderCouncilIntroCard();
  const cards = seats.map((seat) => {
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
  });
  els.aiCouncil.replaceChildren(intro, ...cards);
}

function renderCouncilIntroCard() {
  const card = document.createElement("article");
  card.className = "council-decision-card";

  const label = document.createElement("span");
  label.textContent = "Decisao";
  const title = document.createElement("strong");
  const copy = document.createElement("p");

  if (!state.selectedJob) {
    title.textContent = "Conselho sob demanda";
    copy.textContent = "Acione Gemini, Grok e OpenRouter quando houver uma pergunta clara. AURA sintetiza, voce decide, Codex executa.";
  } else if (state.selectedJob.mode === "analyze") {
    title.textContent = `Demanda #${state.selectedJob.id} em analise`;
    copy.textContent = "Use o Conselho para divergencias, riscos e recomendacao. A decisao final deve virar proximo passo ou task executavel.";
  } else if (state.selectedJob.mode === "implement") {
    title.textContent = `Demanda #${state.selectedJob.id} para execucao`;
    copy.textContent = "Codex e o executor. Consulte o Conselho se precisar revisar risco, escopo ou alternativa antes de aprovar.";
  } else {
    title.textContent = `Demanda #${state.selectedJob.id} em conversa`;
    copy.textContent = "Transforme a conversa em analise ou execucao quando houver um objetivo claro.";
  }

  card.append(label, title, copy);
  return card;
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
      state: provider?.status === "detected" ? "waiting" : "ready",
      label: provider?.status === "detected" ? "detectado" : provider?.available ? "pronto" : "aguardando",
      summary: provider?.status === "detected" ? `${name} sera verificado antes de receber uma demanda.` : idleSummary
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
    if (job.status === "needs_input") {
      return { name, role, state: "error", label: "precisa acao", summary: `${name} sera verificado novamente se voce tentar de novo.` };
    }
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
    return "Codex e o executor desta demanda; Gemini, Grok e OpenRouter ficam disponiveis para revisao e contraponto.";
  }
  return "Conselho em espera. Use Consultar conselho para pedir analise dos provedores conectados.";
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
    content.textContent = `${labelForMemoryKind(memory.kind)}: ${memory.content}`;

    const editButton = iconButton("Editar", "Editar memoria");
    editButton.addEventListener("click", async () => {
      const next = prompt("Atualizar memoria local:", memory.content);
      if (next === null) {
        return;
      }
      await withBusyButton(editButton, "...", async () => {
        await api(`/api/memories/${memory.id}`, {
          method: "PATCH",
          body: { kind: memory.kind, content: next }
        });
        await refreshAll();
      });
    });

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

    item.append(content, editButton, deleteButton);
    return item;
  }));
}

async function purgeMemories() {
  if (!confirm("Apagar todas as memorias persistentes da AURA? Esta acao nao remove tarefas nem historico de demandas.")) {
    return;
  }
  await withBusyButton(els.purgeMemoriesButton, "Apagando", async () => {
    const result = await api("/api/privacy/purge", {
      method: "POST",
      body: { scope: "memories", confirmed: true }
    });
    state.memories = [];
    appendMessage("system", `${formatInteger(result.deleted || 0)} memoria(s) persistente(s) apagada(s).`);
    await refreshAll();
  });
}

async function purgeScreenEvidence() {
  if (!confirm("Apagar todas as evidencias visuais persistidas? Frames crus nao sao armazenados; apenas resumos anexados serao removidos.")) {
    return;
  }
  await withBusyButton(els.purgeScreenEvidenceButton, "Apagando", async () => {
    const result = await api("/api/privacy/purge", {
      method: "POST",
      body: { scope: "screen-evidence", confirmed: true }
    });
    appendMessage("system", `${formatInteger(result.deleted || 0)} evidencia(s) visual(is) apagada(s).`);
    await refreshAll();
  });
}

function labelForMemoryKind(kind) {
  const labels = {
    preference: "Preferencia",
    project: "Projeto",
    decision: "Decisao",
    note: "Nota"
  };
  return labels[kind] || "Memoria";
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

    const stage = document.createElement("span");
    stage.className = "job-stage";
    stage.textContent = `${pipelineLabelForJob(job)} · ${nextStepForJob(job)}`;

    const status = document.createElement("span");
    status.className = `status-chip ${job.status}`;
    status.textContent = labelForJobStatus(job.status);

    button.append(title, meta, stage, status);
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

function pipelineLabelForJob(job) {
  const labels = {
    captured: "Capturada",
    clarifying: "Esclarecendo",
    council: "Conselho",
    approval: "Aguardando voce",
    executing: "Executando",
    review: "Revisar",
    done: "Concluida"
  };
  return labels[currentTimelineStep(job)] || "Em fluxo";
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

function preferredMissionJob(jobs) {
  const priorityGroups = [
    ["needs_input", "awaiting_confirm"],
    ["running", "queued"],
    ["draft"],
    ["done"],
    ["failed"],
    ["cancelled"]
  ];
  for (const statuses of priorityGroups) {
    const match = jobs.find((job) => statuses.includes(job.status));
    if (match) {
      return match;
    }
  }
  return jobs[0];
}

function renderSessionTabs() {
  els.sessionTabButtons.forEach((button) => {
    button.setAttribute("aria-selected", String(button.dataset.sessionTab === state.sessionTab));
  });
  els.sessionPanels.forEach((panel) => {
    panel.hidden = panel.dataset.sessionPanel !== state.sessionTab;
  });
}

function openSessionPanel(tabName) {
  state.sessionTab = tabName;
  renderSessionTabs();
  const panel = document.querySelector(".session-panel");
  if (panel) {
    panel.open = true;
    panel.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function renderActiveDemand() {
  els.activeDemand.replaceChildren();
  updateScreenEvidenceButton();

  if (!state.selectedJob) {
    const empty = document.createElement("div");
    empty.className = "active-demand-empty";

    const title = document.createElement("strong");
    title.textContent = "Pronto para uma missao";
    const copy = document.createElement("p");
    copy.textContent = "Escolha um ponto de partida ou fale com AURA. Toda demanda importante vira um fluxo rastreavel aqui.";
    const starters = renderMissionStarters();

    empty.append(title, copy, starters);
    els.activeDemand.append(empty);
    return;
  }

  const job = state.selectedJob;
  const status = document.createElement("span");
  status.className = `status-chip ${job.status}`;
  status.textContent = labelForJobStatus(job.status);

  const mode = document.createElement("span");
  mode.className = "active-demand-mode";
  mode.textContent = `#${job.id} · ${labelForJobMode(job.mode)} · ${labelForPolicy(job.policyLevel)}`;

  const head = document.createElement("div");
  head.className = "active-demand-head";
  head.append(status, mode);

  const goal = document.createElement("h3");
  goal.textContent = job.goal;

  const decision = renderMissionDecision(job);

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
          const drawer = document.querySelector(".support-drawer");
          if (drawer) {
            drawer.open = true;
          }
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
    const panel = document.querySelector(".jobs-panel");
    if (panel) {
      panel.open = true;
    }
    document.querySelector(".jobs-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  if (state.activeDemandTab === "council") {
    const councilPanel = renderActiveDemandCouncil(job);
    els.activeDemand.append(head, goal, tabs, councilPanel, action);
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
    els.activeDemand.append(head, goal, tabs, technical, action);
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
    els.activeDemand.append(head, goal, tabs, panel, action);
    return;
  }

  const timeline = renderDemandTimeline(job);
  const details = document.createElement("details");
  details.className = "mission-details";
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "Timeline e detalhes";
  details.append(detailsSummary, timeline, facts);

  const security = renderSecurityBand(job);
  const alert = renderHumanFailure(job);
  const implementationEvidence = renderImplementationEvidence(job);
  els.activeDemand.append(head, goal, decision);
  if (security) {
    els.activeDemand.append(security);
  }
  if (alert) {
    els.activeDemand.append(alert);
  }
  if (implementationEvidence) {
    els.activeDemand.append(implementationEvidence);
  }
  els.activeDemand.append(tabs, details, action);
}

function renderMissionDecision(job) {
  const panel = document.createElement("section");
  panel.className = "mission-decision-card";
  panel.dataset.state = job.status;

  const body = document.createElement("div");
  const label = document.createElement("span");
  label.textContent = "Decisao agora";
  const text = document.createElement("strong");
  text.textContent = nextStepForJob(job);
  const detail = document.createElement("small");
  detail.textContent = missionDecisionDetail(job);
  body.append(label, text, detail);

  const button = document.createElement("button");
  button.type = "button";
  button.className = missionDecisionButtonClass(job);
  button.textContent = missionDecisionButtonLabel(job);
  button.addEventListener("click", () => runMissionDecisionAction(job, button));

  panel.append(body, button);
  return panel;
}

function missionDecisionDetail(job) {
  if (job.status === "needs_input") {
    return "Aguardando sua decisao antes de qualquer proximo passo.";
  }
  if (job.status === "failed") {
    return "Falha degradada com historico preservado para retomar com seguranca.";
  }
  if (job.status === "done") {
    return "Entrega concluida; revise artefatos ou escolha a continuidade.";
  }
  if (canConfirmImplementJob(job)) {
    return "Permissao visual obrigatoria antes de escrita local.";
  }
  return "CTA sincronizada com o estado Agora do cockpit.";
}

function missionDecisionButtonLabel(job) {
  if (state.now?.activeJob?.id === job.id && state.now.cta?.label) {
    return state.now.cta.label;
  }
  if (canConfirmImplementJob(job)) {
    return "Aprovar";
  }
  if (job.status === "needs_input") {
    return "Resolver";
  }
  if (job.status === "failed") {
    return "Revisar";
  }
  if (job.status === "done") {
    return "Ver entrega";
  }
  return "Acompanhar";
}

function missionDecisionButtonClass(job) {
  if (job.status === "failed") {
    return "danger-button";
  }
  if (canConfirmImplementJob(job) || state.now?.activeJob?.id === job.id) {
    return "primary";
  }
  return "secondary";
}

async function runMissionDecisionAction(job, button) {
  if (state.now?.activeJob?.id === job.id) {
    await runNowAction(state.now, button);
    return;
  }
  const panel = document.querySelector(".jobs-panel");
  if (panel) {
    panel.open = true;
  }
  document.querySelector(".jobs-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderMissionStarters() {
  const actions = document.createElement("div");
  actions.className = "mission-starters";

  const quickActions = [
    ["chat", "Nova missao", "Aura, organize uma nova missao para mim"],
    ["council", "Consultar conselho", "Avalie o cockpit atual e proponha melhorias"],
    ["execute", "Executar com Codex", "Desenvolva a proxima melhoria do cockpit"]
  ];

  const nextTask = state.tasks.find((task) => task.status !== "done");
  if (nextTask) {
    quickActions.push(["task", "Retomar task", nextTask.title]);
  }

  for (const [intent, label, text] of quickActions) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", () => {
      if (intent === "task" && nextTask) {
        openSessionPanel("tasks");
        return;
      }
      setComposerIntent(intent, text);
    });
    actions.append(button);
  }

  return actions;
}

function setComposerIntent(intent, seedText = "") {
  state.composerIntent = intent;
  renderComposerIntents();
  if (seedText) {
    els.localInput.value = seedText;
  }
  els.voicePanel?.scrollIntoView({ behavior: "smooth", block: "center" });
  els.localInput.focus();
  updateComposerValidation();
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
  if (!["failed", "needs_input"].includes(job.status) || (!job.error && !job.summary)) {
    return null;
  }

  const panel = document.createElement("section");
  panel.className = "active-demand-alert";
  const label = document.createElement("strong");
  label.textContent = job.status === "needs_input" ? "AURA precisa de uma decisao" : "Falha acionavel";
  const copy = document.createElement("span");
  copy.textContent = humanizeJobMessage(job.error || job.summary);
  panel.append(label, copy);
  const recovery = renderRecoveryActions(job);
  if (recovery) {
    panel.append(recovery);
  }
  return panel;
}

function renderRecoveryActions(job) {
  if (job.status !== "needs_input") {
    return null;
  }

  const panel = document.createElement("form");
  panel.className = "recovery-actions";

  const guidance = document.createElement("textarea");
  guidance.rows = 2;
  guidance.placeholder = "Oriente a retomada desta demanda...";
  guidance.setAttribute("aria-label", "Orientacao para retomar demanda");

  if (job.mode === "analyze") {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "primary";
    retry.textContent = "Retomar conselho";
    retry.addEventListener("click", async () => {
      await withBusyButton(retry, "Verificando", async () => {
        await runAnalystConsultation(job, defaultAnalystConsent(), recoveryContext(guidance.value));
      });
    });
    panel.append(guidance, retry);
  }

  if (job.mode === "implement") {
    const resume = document.createElement("button");
    resume.type = "button";
    resume.className = "primary";
    resume.textContent = "Retomar execucao";
    resume.addEventListener("click", async () => {
      if (!confirm(`Retomar demanda #${job.id} com permissao de escrita no workspace?`)) {
        return;
      }
      await withBusyButton(resume, "Retomando", async () => {
        let result = null;
        try {
          result = await api(`/api/jobs/${job.id}/codex/implement`, {
            method: "POST",
            body: {
              confirmed: true,
              prompt: recoveryPrompt(job, guidance.value),
              timeoutMs: job.timeoutMs
            }
          });
          state.selectedJob = result.job;
          state.selectedJobEvents = result.events || [];
          state.selectedJobArtifacts = result.artifacts || [];
          appendMessage("system", `Demanda #${job.id} retomada com a orientacao informada.`);
        } catch (error) {
          applyJobErrorDetails(error);
          appendMessage("system", `Retomada nao concluida: ${humanizeJobMessage(error.message, error.details)}`);
        }
        await refreshJobs();
        logEvent("job.resume", { id: job.id, status: result?.job?.status || state.selectedJob?.status || "failed" });
      });
    });
    panel.append(guidance, resume);
  }

  const skip = document.createElement("button");
  skip.type = "button";
  skip.className = "secondary";
  skip.textContent = "Ignorar";
  skip.addEventListener("click", async () => {
    await withBusyButton(skip, "Ignorando", async () => {
      const result = await api(`/api/jobs/${job.id}/skip`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      appendMessage("system", `Demanda #${job.id} ignorada. Nenhuma acao foi executada.`);
    });
  });
  panel.append(skip);

  return panel;
}

function recoveryContext(note) {
  const text = String(note || "").trim();
  return text ? { attempted: [`Operador orientou a retomada: ${text}`] } : {};
}

function recoveryPrompt(job, note) {
  const text = String(note || "").trim();
  return [
    job.goal,
    text ? `\nOrientacao do operador para retomar apos needs_input: ${text}` : "",
    "\nUse os artefatos anteriores como contexto, corrija somente o necessario e deixe o resultado para revisao do critic gate."
  ].filter(Boolean).join("\n");
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
  const councilDecision = renderCouncilDecisionCard();
  if (councilDecision) {
    panel.append(councilDecision);
  }
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

function renderCouncilDecisionCard() {
  const synthesis = latestDebateSynthesis();
  if (!synthesis) {
    return null;
  }
  const job = state.selectedJob;
  const plan = job ? buildCouncilImplementationPlan(job, synthesis) : null;
  const briefing = buildExecutiveCouncilBriefing(synthesis, plan);

  const card = document.createElement("section");
  card.className = `council-decision confidence-${briefing.confidence.level}`;

  const header = document.createElement("header");
  const heading = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = briefing.title;
  const recommendation = document.createElement("p");
  recommendation.textContent = briefing.recommendation;
  heading.append(label, recommendation);

  const confidence = document.createElement("span");
  confidence.className = "council-confidence";
  confidence.textContent = `confianca ${briefing.confidence.label}`;
  header.append(heading, confidence);

  const facts = document.createElement("dl");
  facts.className = "council-decision-facts";
  for (const fact of briefing.facts) {
    appendFact(facts, fact.label, fact.value);
  }
  appendFact(facts, "Rodadas", debateRoundLabel(synthesis));
  appendFact(facts, "Criterio", progressiveDebateLabel(synthesis));

  const executiveGrid = document.createElement("div");
  executiveGrid.className = "council-briefing-grid";
  executiveGrid.append(
    renderBriefingBlock("Opinioes principais", briefing.consensus),
    renderBriefingBlock("Divergencias com impacto", briefing.dissent),
    renderBriefingBlock("Riscos", briefing.risks),
    renderBriefingBlock("Proximas acoes", briefing.nextActions.map((text) => ({ text, sources: [], impact: "" })))
  );

  const artifactNote = document.createElement("div");
  artifactNote.className = "council-artifact-note";
  const artifactText = document.createElement("span");
  artifactText.textContent = briefing.artifactHint;
  const artifactButton = document.createElement("button");
  artifactButton.type = "button";
  artifactButton.textContent = "Ver artefatos";
  artifactButton.addEventListener("click", () => {
    state.activeDemandTab = "artifacts";
    renderActiveDemand();
  });
  artifactNote.append(artifactText, artifactButton);

  card.append(header, facts, executiveGrid, artifactNote);
  if (plan) {
    card.append(renderCouncilImplementationPlanPreview(plan));
  }
  const actions = renderCouncilDecisionActions(synthesis, plan);
  if (actions) {
    card.append(actions);
  }
  return card;
}

function renderBriefingBlock(titleText, items) {
  const block = document.createElement("section");
  block.className = "council-briefing-block";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const list = document.createElement("ul");
  for (const item of items || []) {
    const entry = document.createElement("li");
    if (item.muted) {
      entry.className = "muted";
    }
    const text = document.createElement("span");
    text.textContent = item.text;
    entry.append(text);
    if (item.impact || item.sources?.length) {
      const meta = document.createElement("small");
      meta.textContent = [item.impact, item.sources?.length ? `Fontes: ${item.sources.join(", ")}` : ""].filter(Boolean).join(" ");
      entry.append(meta);
    }
    list.append(entry);
  }
  block.append(title, list);
  return block;
}

function debateRoundLabel(synthesis) {
  const used = synthesis.budget?.roundsUsed || 1;
  const followUp = synthesis.budget?.followUpRounds || 0;
  return followUp > 0
    ? `${used} executada(s), ${followUp} pendente(s)`
    : `${used} executada(s)`;
}

function progressiveDebateLabel(synthesis) {
  const decisions = synthesis.budget?.progressiveDecisions || [];
  const latest = decisions.at(-1);
  if (!latest) {
    return "1 rodada direta";
  }
  if (latest.run) {
    return `extra: ${latest.reasons?.join(", ") || "criterio ativo"}`;
  }
  return "sem rodada extra";
}

function renderCouncilImplementationPlanPreview(plan) {
  const preview = document.createElement("section");
  preview.className = "council-plan-preview";
  preview.setAttribute("aria-label", "Plano estruturado da decisao do Conselho");

  const title = document.createElement("strong");
  title.textContent = "Plano acionavel";
  const summary = document.createElement("p");
  summary.textContent = plan.summary;

  const grid = document.createElement("div");
  grid.className = "council-plan-grid";
  grid.append(
    compactList("Passos", plan.steps),
    compactList("Arquivos provaveis", plan.likelyFiles.length ? plan.likelyFiles : ["Codex deve confirmar o arquivo antes de editar."]),
    compactList("Verificacoes", plan.verification)
  );

  preview.append(title, summary, grid);
  return preview;
}

function compactList(titleText, items) {
  const section = document.createElement("div");
  const title = document.createElement("span");
  title.textContent = titleText;
  const list = document.createElement("ul");
  for (const item of items || []) {
    const entry = document.createElement("li");
    entry.textContent = item;
    list.append(entry);
  }
  section.append(title, list);
  return section;
}

function renderCouncilDecisionActions(synthesis, plan) {
  const job = state.selectedJob;
  if (!job || job.mode !== "analyze" || !synthesis?.recommendation) {
    return null;
  }

  const actions = document.createElement("div");
  actions.className = "council-decision-actions";
  const implement = document.createElement("button");
  implement.type = "button";
  implement.className = "primary";
  implement.textContent = "Criar implementacao";
  implement.addEventListener("click", async () => {
    await withBusyButton(implement, "Criando", async () => {
      try {
        const result = await createImplementationFromCouncil(job, synthesis);
        state.selectedJobId = result.job.id;
        state.demandFilter = "all";
        appendMessage("assistant", `Demanda #${result.job.id} criada a partir da Decisao do Conselho. Ela aguarda confirmacao visual antes de escrever.`);
        await refreshAll();
        document.querySelector(".active-demand-panel").scrollIntoView({ behavior: "smooth", block: "start" });
      } catch (error) {
        appendMessage("system", `Implementacao nao criada: ${humanizeJobMessage(error.message, error.details)}`);
      }
    });
  });

  const review = document.createElement("button");
  review.type = "button";
  review.textContent = "Revisar plano";
  review.addEventListener("click", () => {
    document.querySelector(".council-plan-preview")?.scrollIntoView({ behavior: "smooth", block: "center" });
  });

  const secondOpinion = document.createElement("button");
  secondOpinion.type = "button";
  secondOpinion.textContent = "Pedir segunda opiniao";
  secondOpinion.addEventListener("click", async () => {
    await withBusyButton(secondOpinion, "Consultando", async () => {
      await runAnalystConsultation(job, defaultAnalystConsent(), {
        constraints: ["Revisar o plano estruturado antes de executar qualquer mudanca."],
        files: plan?.likelyFiles || [],
        findings: plan?.steps || []
      }, 2);
    });
  });

  actions.append(implement, review, secondOpinion);
  return actions;
}

async function createImplementationFromCouncil(sourceJob, synthesis) {
  const councilPlan = buildCouncilImplementationPlan(sourceJob, synthesis);
  return api("/api/jobs", {
    method: "POST",
    body: {
      goal: implementationGoalFromPlan(sourceJob, councilPlan),
      mode: "implement",
      requestedBy: "text",
      policyLevel: "write",
      metadata: {
        source: "council-decision",
        sourceJobId: sourceJob.id,
        councilPlan,
        plan: councilPlan.summary,
        planSummary: councilPlan.steps.join("\n"),
        risk: councilPlan.risks?.length
          ? `Riscos levantados pelo Conselho: ${councilPlan.risks.join(" | ")}`
          : "Implementacao criada a partir de sintese do Conselho; exige confirmacao visual.",
        likelyFiles: councilPlan.likelyFiles,
        verification: councilPlan.verification
      }
    }
  });
}

function latestDebateSynthesis() {
  const artifact = latestArtifactOfKind("debate-synthesis");
  if (!artifact?.content) {
    return null;
  }
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function latestArtifactOfKind(kind) {
  return [...state.selectedJobArtifacts]
    .reverse()
    .find((artifact) => artifact.kind === kind);
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
  if (lower.includes("critic gate requires human review")) {
    return "A critica local pediu revisao humana antes de concluir. Leia os artefatos, adicione uma orientacao curta e retome se estiver seguro.";
  }
  if (lower.includes("critic gate blocked completion")) {
    return "A critica local bloqueou a conclusao. Corrija o ponto indicado ou retome com uma orientacao mais especifica.";
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
  if (lower.includes("nenhum analista utilizavel") || lower.includes("no analyst completed successfully")) {
    return "Nenhum analista conseguiu responder agora. A demanda ficou aguardando sua decisao: tente novamente depois do health-check ou ignore sem executar nada.";
  }
  if (lower.includes("fora do contrato json") || lower.includes("valid json")) {
    return "O analista respondeu fora do formato esperado pelo Conselho. Tente novamente com um brief menor ou ignore esta rodada.";
  }
  if (lower.includes("max turns")) {
    return "O analista chegou ao limite de turnos antes de concluir. Tente novamente com um brief mais curto.";
  }
  if (lower.includes("certificate") || lower.includes("certificado") || lower.includes("cert")) {
    return "O provedor falhou na verificacao de certificado. Ele foi tratado como indisponivel para esta demanda.";
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
    ["captured", "capturada"],
    ["clarifying", "esclarecendo"],
    ["council", "conselho"],
    ["approval", "aprovacao"],
    ["executing", "executando"],
    ["review", "revisao"],
    ["done", "concluida"]
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
  if (job.status === "done") {
    return "done";
  }
  if (["failed", "cancelled"].includes(job.status)) {
    return "review";
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
  if (job.mode === "ask") {
    return "clarifying";
  }
  return "captured";
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
  title.textContent = job.status === "needs_input" ? "Revisao critica pede decisao" : "Aguardando aprovacao";

  const facts = document.createElement("dl");
  facts.className = "security-facts";
  appendFact(facts, "Risco", metadata.risk || riskForPolicy(job.policyLevel));
  const likelyFiles = Array.isArray(metadata.likelyFiles) ? metadata.likelyFiles.join(", ") : metadata.likelyFiles;
  appendFact(facts, "Dados/arquivos", likelyFiles || "Workspace local aprovado para esta demanda.");
  appendFact(facts, "Motivo", humanizeJobMessage(policy.reason || "Esta demanda pode alterar arquivos locais."));
  if (metadata.operatorCritique?.comment) {
    appendFact(facts, "Critica", metadata.operatorCritique.comment);
  }

  const controls = document.createElement("div");
  controls.className = "security-actions";

  const critique = document.createElement("textarea");
  critique.className = "plan-critique-input";
  critique.placeholder = "Critique ou ajuste o plano antes de aprovar";
  critique.setAttribute("aria-label", "Critica do plano antes da execucao");

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

  const pause = document.createElement("button");
  pause.type = "button";
  pause.textContent = "Pausar";
  pause.addEventListener("click", async () => {
    await withBusyButton(pause, "Pausando", async () => {
      const result = await api(`/api/jobs/${job.id}/pause`, { method: "POST" });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      appendMessage("system", `Demanda #${job.id} pausada antes de executar.`);
    });
  });

  const revise = document.createElement("button");
  revise.type = "button";
  revise.textContent = "Registrar critica";
  revise.addEventListener("click", async () => {
    const comment = critique.value.trim();
    if (!comment) {
      critique.focus();
      appendMessage("system", "Escreva a critica ou ajuste do plano antes de registrar.");
      return;
    }
    await withBusyButton(revise, "Registrando", async () => {
      const result = await api(`/api/jobs/${job.id}/revise`, {
        method: "POST",
        body: { comment }
      });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      appendMessage("system", `Critica registrada na demanda #${job.id}. Revise o plano antes de executar.`);
    });
  });

  const details = document.createElement("button");
  details.type = "button";
  details.textContent = "Ver detalhes";
  details.addEventListener("click", () => {
    document.querySelector(".jobs-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  });

  const source = sourceJobIdForImplementation(job);
  if (source) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Voltar a decisao original";
    back.addEventListener("click", () => goToOriginalCouncilDecision(source));
    controls.append(back);
  }

  controls.append(approve, pause, revise, deny, details);
  panel.append(title, facts, critique, controls);
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
  const implementationEvidence = renderImplementationEvidence(job);
  const analystConsent = renderAnalystConsent(job);
  const debateControls = renderDebateControls(job);
  const routineDraftControls = renderRoutineDraftControls(job);
  const recoveryControls = renderRecoveryActions(job);
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
  if (implementationEvidence) {
    els.jobDetail.append(implementationEvidence);
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
  if (recoveryControls) {
    els.jobDetail.append(recoveryControls);
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
  appendApprovalItem(panel, "Plano", metadata.planSummary || metadata.plan || job.goal);
  appendApprovalItem(panel, "Risco", metadata.risk || riskForPolicy(job.policyLevel));
  const likelyFiles = Array.isArray(metadata.likelyFiles) ? metadata.likelyFiles.join("\n") : metadata.likelyFiles;
  appendApprovalItem(panel, "Arquivos provaveis", likelyFiles || "Nao informado");
  const verification = Array.isArray(metadata.verification) ? metadata.verification.join("\n") : metadata.verification;
  if (verification) {
    appendApprovalItem(panel, "Verificacoes", verification);
  }
  const source = sourceJobIdForImplementation(job);
  if (source) {
    const controls = document.createElement("div");
    controls.className = "approval-actions";
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Voltar a decisao original";
    back.addEventListener("click", () => goToOriginalCouncilDecision(source));
    controls.append(back);
    panel.append(controls);
  }
  return panel;
}

function renderImplementationEvidence(job) {
  if (job.mode !== "implement" || job.metadata?.source !== "council-decision") {
    return null;
  }

  const evidence = implementationEvidenceFromArtifacts(job, state.selectedJobArtifacts);
  if (!evidence.hasEvidence) {
    return null;
  }

  const panel = document.createElement("section");
  panel.className = "implementation-evidence";
  const title = document.createElement("strong");
  title.textContent = "Evidencias de implementacao";
  const result = document.createElement("p");
  result.textContent = evidence.result;

  const facts = document.createElement("dl");
  facts.className = "implementation-evidence-facts";
  appendFact(facts, "Resultado", evidence.outcome);
  appendFact(facts, "Arquivos", evidence.changedFiles.length ? evidence.changedFiles.join(", ") : "Nenhum arquivo alterado registrado ainda.");
  appendFact(facts, "Testes", evidence.tests.length ? evidence.tests.map((test) => `${test.command}: ${test.status}`).join(" | ") : "Sem teste registrado ainda.");
  appendFact(facts, "Retomada", evidence.resumePath);

  const actions = document.createElement("div");
  actions.className = "implementation-evidence-actions";
  const source = evidence.sourceJobId || sourceJobIdForImplementation(job);
  if (source) {
    const back = document.createElement("button");
    back.type = "button";
    back.textContent = "Voltar a decisao original";
    back.addEventListener("click", () => goToOriginalCouncilDecision(source));
    actions.append(back);
  }
  const artifacts = document.createElement("button");
  artifacts.type = "button";
  artifacts.textContent = "Revisar artefatos";
  artifacts.addEventListener("click", () => {
    state.activeDemandTab = "artifacts";
    renderActiveDemand();
  });
  actions.append(artifacts);

  panel.append(title, result, facts, actions);
  return panel;
}

function sourceJobIdForImplementation(job) {
  return job?.metadata?.sourceJobId || job?.metadata?.councilPlan?.sourceJobId || null;
}

async function goToOriginalCouncilDecision(sourceJobId) {
  state.selectedJobId = Number(sourceJobId);
  state.activeDemandTab = "council";
  await refreshAll();
  document.querySelector(".active-demand-panel")?.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const gemini = analystCheckboxControl(job, "gemini", "Gemini");
  const grok = analystCheckboxControl(job, "grok", "Grok");
  const openrouter = analystCheckboxControl(job, "openrouter", "OpenRouter");
  const rounds = document.createElement("label");
  rounds.className = "select-control";
  const roundsText = document.createElement("span");
  roundsText.textContent = "Teto de rodadas";
  const roundsSelect = document.createElement("select");
  roundsSelect.setAttribute("aria-label", "Teto de rodadas do Conselho");
  [
    ["1", "Ate 1 rodada"],
    ["2", "Ate 2 rodadas"],
    ["3", "Ate 3 rodadas"]
  ].forEach(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    roundsSelect.append(option);
  });
  rounds.append(roundsText, roundsSelect);
  const runButton = document.createElement("button");
  runButton.type = "button";
  runButton.className = "primary";
  runButton.textContent = job.status === "needs_input" ? "Tentar novamente" : "Consultar";
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
    await withBusyButton(runButton, "Consultando", async () => runAnalystConsultation(job, consent, {}, Number(roundsSelect.value)));
  });
  updateAnalystButton();

  controls.append(gemini.label, grok.label, openrouter.label, rounds, runButton);
  panel.append(preview, controls);
  return panel;
}

async function runAnalystConsultation(job, consent, extraContext = {}, maxRounds = 1) {
  let result = null;
  const safeRounds = Math.max(1, Math.min(3, Number(maxRounds) || 1));
  try {
    result = await api(`/api/jobs/${job.id}/analysts/run`, {
      method: "POST",
      body: {
        consent,
        context: mergeAnalystContext(analystContext(job), extraContext),
        synthesize: true,
        budget: {
          maxRounds: safeRounds,
          progressive: safeRounds > 1
        }
      }
    });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    state.selectedJobArtifacts = result.artifacts || [];
    if (result.job.status === "needs_input") {
      appendMessage("system", `Conselho nao conseguiu concluir a demanda #${job.id}. Voce pode tentar novamente ou ignorar.`);
    } else if (result.debate?.synthesis) {
      appendMessage("system", `Conselho sintetizou uma decisao para a demanda #${job.id}.`);
    } else if (result.job.status === "done" && hasAnalystResponseArtifacts(result.artifacts || [])) {
      const synthesis = await synthesizeCouncilDecision(result.job.id);
      if (synthesis) {
        result = synthesis;
        appendMessage("system", `Conselho sintetizou uma decisao para a demanda #${job.id}.`);
      }
    }
  } catch (error) {
    applyJobErrorDetails(error);
    appendMessage("system", `Analise nao concluida: ${humanizeJobMessage(error.message, error.details)}`);
  }
  await refreshJobs();
  logEvent("job.analysts", { id: job.id, status: result?.job?.status || state.selectedJob?.status || "failed", consent });
}

function mergeAnalystContext(base, extra) {
  return {
    ...base,
    ...extra,
    constraints: [...(base.constraints || []), ...(extra.constraints || [])],
    files: [...(base.files || []), ...(extra.files || [])],
    findings: [...(base.findings || []), ...(extra.findings || [])],
    attempted: [...(base.attempted || []), ...(extra.attempted || [])],
    focusTerms: [...(base.focusTerms || []), ...(extra.focusTerms || [])]
  };
}

async function synthesizeCouncilDecision(jobId) {
  try {
    const result = await api(`/api/jobs/${jobId}/debate/synthesize`, {
      method: "POST",
      body: {
        requested: true,
        budget: { maxRounds: 1 }
      }
    });
    state.selectedJob = result.job;
    state.selectedJobEvents = result.events || [];
    state.selectedJobArtifacts = result.artifacts || [];
    return result;
  } catch (error) {
    appendMessage("system", `Conselho respondeu, mas a sintese nao foi gerada: ${humanizeJobMessage(error.message, error.details)}`);
    return null;
  }
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
        result = await synthesizeCouncilDecision(job.id);
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
  return hasAnalystResponseArtifacts(state.selectedJobArtifacts);
}

function hasAnalystResponseArtifacts(artifacts) {
  return Array.isArray(artifacts) && artifacts.some((artifact) => artifact.kind === "analyst-response");
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

function analystCheckboxControl(job, key, labelText) {
  const provider = state.status?.providers?.[key] || {};
  const detected = provider.available !== false;
  const suffix = provider.status === "detected"
    ? "detectado; verificar antes de enviar"
    : detected ? "verificar antes de enviar" : "indisponivel";
  const control = checkboxControl(`analyst-${key}-${job.id}`, `${labelText} (${suffix})`, detected);
  control.input.disabled = !detected;
  control.input.title = detected
    ? "AURA fara um health-check antes de enviar o brief da demanda."
    : humanizeJobMessage(provider.error || `${labelText} indisponivel.`);
  return control;
}

function defaultAnalystConsent() {
  const providers = state.status?.providers || {};
  return {
    gemini: providers.gemini?.available !== false,
    grok: providers.grok?.available !== false,
    openrouter: providers.openrouter?.available !== false
  };
}

function renderJobArtifact(artifact) {
  const item = document.createElement("li");
  const main = document.createElement("div");
  const label = document.createElement("strong");
  label.textContent = artifact.label;
  const meta = document.createElement("small");
  meta.textContent = labelForArtifactKind(artifact.kind);
  main.append(label, meta);

  const preview = document.createElement("pre");
  preview.textContent = artifactPreview(artifact, 2500);
  item.append(main, preview);
  return item;
}

function renderArtifactCard(artifact) {
  const card = document.createElement("article");
  const gateClass = artifact.kind === "critic-review" && artifact.metadata?.gate
    ? ` gate-${artifact.metadata.gate}`
    : "";
  card.className = `artifact-card artifact-${artifact.kind}${gateClass}`;

  const header = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = artifact.label;
  const meta = document.createElement("small");
  meta.textContent = labelForArtifactKind(artifact.kind);
  header.append(title, meta);

  const preview = document.createElement("p");
  preview.textContent = artifactSummary(artifact);

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
  use.textContent = "Usar como contexto";
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
  if (artifact.kind === "screen-evidence") {
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "danger-button";
    remove.textContent = "Remover evidencia";
    remove.addEventListener("click", async () => {
      if (!confirm("Remover esta evidencia visual da demanda?")) {
        return;
      }
      await withBusyButton(remove, "Removendo", async () => {
        const result = await api(`/api/jobs/${artifact.jobId}/artifacts/${artifact.id}?confirm=true`, { method: "DELETE" });
        state.selectedJobEvents = result.events || [];
        state.selectedJobArtifacts = result.artifacts || [];
        await refreshJobs();
        appendMessage("system", "Evidencia visual removida da demanda.");
      });
    });
    actions.append(remove);
  }
  card.append(header, preview, actions);
  return card;
}

function labelForArtifactKind(kind) {
  const labels = {
    "evidence-brief": "Brief enviado",
    "analyst-response": "Resposta do Conselho",
    "debate-synthesis": "Decisao do Conselho",
    "codex-log": "Log do Codex",
    "codex-summary": "Resumo do executor",
    "diff": "Diff do workspace",
    "changed-files": "Arquivos alterados",
    "test-log": "Resultado de testes",
    "screen-evidence": "Evidencia visual",
    "critic-review": "Critica local",
    "rollback-plan": "Plano de rollback",
    "independent-critic-brief": "Brief de critica independente",
    "independent-critic-review": "Critica independente"
  };
  return labels[kind] || kind;
}

function artifactSummary(artifact) {
  const content = String(artifact.content || "").trim();
  if (artifact.kind === "changed-files") {
    const files = content.split(/\r?\n/).filter(Boolean);
    return files.length ? `${files.length} arquivo(s): ${files.join(", ")}` : "Nenhum arquivo alterado registrado.";
  }
  if (artifact.kind === "diff") {
    const additions = (content.match(/^\+/gm) || []).length;
    const removals = (content.match(/^-/gm) || []).length;
    return content ? `Diff capturado com ${additions} adicoes e ${removals} remocoes.` : "Diff vazio.";
  }
  if (artifact.kind === "test-log") {
    const exitCode = artifact.metadata?.exitCode;
    return exitCode === 0 ? "Testes passaram." : `Testes exigem atencao${exitCode === undefined ? "" : `: exit ${exitCode}`}.`;
  }
  if (artifact.kind === "screen-evidence") {
    return "Tela considerada com consentimento explicito; imagem crua nao foi persistida.";
  }
  if (artifact.kind === "critic-review") {
    const gate = artifact.metadata?.gate;
    const labels = {
      pass: "Gate aprovado",
      review: "Gate pede revisao",
      block: "Gate bloqueia confianca"
    };
    return `${labels[gate] || "Critica local"}: ${firstUsefulLine(content) || "AURA comparou plano, diff e testes."}`;
  }
  if (artifact.kind === "rollback-plan") {
    return "Plano seguro para revisar, retomar ou reverter somente os arquivos alterados.";
  }
  if (artifact.kind === "independent-critic-brief") {
    return "Brief pronto para uma revisao independente em modo leitura.";
  }
  if (artifact.kind === "independent-critic-review") {
    return firstUsefulLine(content) || "Revisao independente executada em modo leitura.";
  }
  return artifactPreview(artifact, 360) || "Artefato sem conteudo textual.";
}

function artifactPreview(artifact, limit) {
  const content = String(artifact.content || "").trim();
  if (!content) {
    return "";
  }
  return content.length > limit ? `${content.slice(0, limit)}...` : content;
}

function firstUsefulLine(content) {
  return String(content || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && !line.startsWith("#") && !line.startsWith("-"));
}

function renderTools() {
  els.toolsList.replaceChildren(...state.status.tools.map((tool) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${tool.name}</span><small>${tool.requiresConfirmation ? "confirma" : "seguro"}</small>`;
    return item;
  }));
}

function renderLocalFiles() {
  if (!els.localFilesPanel) {
    return;
  }

  const data = state.localFiles;
  if (!data) {
    els.localFilesPanel.replaceChildren(emptyParagraph("Permissao local ainda nao carregada."));
    return;
  }

  const header = document.createElement("div");
  header.className = "local-files-header";

  const rootSelect = document.createElement("select");
  rootSelect.setAttribute("aria-label", "Raiz local permitida");
  for (const root of data.roots || [data.root]) {
    const option = document.createElement("option");
    option.value = root.id;
    option.textContent = `${root.label} · ${root.realPath}`;
    option.selected = Number(root.id) === Number(data.root.id);
    rootSelect.append(option);
  }
  rootSelect.addEventListener("change", async () => {
    state.localFileRoot = Number(rootSelect.value);
    state.localFilePath = ".";
    await refreshLocalFiles();
  });

  const pathLabel = document.createElement("span");
  pathLabel.textContent = data.path === "." ? data.root.realPath : `${data.root.realPath}/${data.path}`;
  header.append(rootSelect, pathLabel);

  const actions = document.createElement("div");
  actions.className = "local-files-actions";
  if (data.parent) {
    const parent = document.createElement("button");
    parent.type = "button";
    parent.textContent = "Subir";
    parent.addEventListener("click", async () => {
      state.localFilePath = data.parent;
      await refreshLocalFiles();
    });
    actions.append(parent);
  }

  const list = document.createElement("ul");
  list.className = "local-files-list";
  const entries = data.entries || [];
  if (!entries.length) {
    list.append(emptyListItem("Pasta vazia ou sem itens visiveis."));
  } else {
    for (const entry of entries) {
      const item = document.createElement("li");
      const main = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = `${entry.type === "directory" ? "Pasta" : "Arquivo"} · ${entry.name}`;
      const meta = document.createElement("small");
      meta.textContent = entry.type === "directory"
        ? `Atualizada ${formatDateTime(entry.updatedAt)}`
        : `${formatBytes(entry.size)} · ${formatDateTime(entry.updatedAt)}`;
      main.append(name, meta);
      item.append(main);
      if (entry.type === "directory") {
        const open = document.createElement("button");
        open.type = "button";
        open.textContent = "Abrir";
        open.addEventListener("click", async () => {
          state.localFilePath = entry.path || ".";
          await refreshLocalFiles();
        });
        item.append(open);
      }
      list.append(item);
    }
  }

  const note = document.createElement("p");
  note.className = "permission-note";
  note.textContent = "Leitura limitada as raizes configuradas em AURA_LOCAL_READ_ROOTS. AURA lista nomes, tipos, tamanhos e datas; nao abre conteudo de arquivo nesta tela.";

  els.localFilesPanel.replaceChildren(header, actions, list, note);
}

function renderGitHubIssues() {
  if (!els.githubPanel) {
    return;
  }

  const data = state.github;
  if (!data) {
    els.githubPanel.replaceChildren(emptyParagraph("Issues do GitHub ainda nao carregadas."));
    return;
  }

  if (els.githubStateSelect) {
    els.githubStateSelect.value = state.githubIssueState;
  }

  const github = data.github || data.status || {};
  const summary = document.createElement("div");
  summary.className = "github-summary";
  summary.append(
    statusMetric("Repositorio", github.repo || "Nao configurado", github.configured ? `conectado via ${github.source}` : "configure AURA_GITHUB_REPO"),
    statusMetric("Issues", formatInteger(data.issues?.length || 0), labelForGitHubIssueState(state.githubIssueState)),
    statusMetric("Acesso", github.configured ? "pronto" : "pendente", github.error || "gh CLI ou token local")
  );

  const list = document.createElement("ul");
  list.className = "github-issue-list";
  if (data.error) {
    list.append(emptyListItem(`GitHub indisponivel: ${data.error}`));
  } else if (!data.issues?.length) {
    list.append(emptyListItem("Nenhuma issue encontrada para este filtro."));
  } else {
    for (const issue of data.issues) {
      list.append(renderGitHubIssue(issue));
    }
  }

  const note = document.createElement("p");
  note.className = "permission-note";
  note.textContent = "AURA le issues via servidor local usando gh CLI ou GITHUB_TOKEN. Credenciais nao sao enviadas ao navegador.";

  els.githubPanel.replaceChildren(summary, list, note);
}

function renderGitHubIssue(issue) {
  const item = document.createElement("li");
  item.className = `github-issue ${issue.state || "open"}`;

  const main = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = `#${issue.number} · ${issue.title}`;
  const meta = document.createElement("small");
  const labels = (issue.labels || []).map((label) => label.name).filter(Boolean).slice(0, 4).join(", ");
  meta.textContent = [
    issue.state === "closed" ? "fechada" : "aberta",
    labels,
    issue.updatedAt ? `atualizada ${formatDateTime(issue.updatedAt)}` : ""
  ].filter(Boolean).join(" · ");
  main.append(title, meta);

  const actions = document.createElement("div");
  actions.className = "row-actions";

  const task = document.createElement("button");
  task.type = "button";
  task.textContent = "Virar task";
  task.addEventListener("click", async () => {
    await withBusyButton(task, "Importando", async () => {
      const result = await api(`/api/github/issues/${issue.number}/import-task`, { method: "POST" });
      appendMessage("system", result.imported
        ? `Issue #${issue.number} importada como task local.`
        : `Issue #${issue.number} ja existia como task local.`);
      await refreshAll();
      state.sessionTab = "tasks";
      renderSessionTabs();
    });
  });

  const open = document.createElement("a");
  open.className = "button-link";
  open.href = issue.url;
  open.target = "_blank";
  open.rel = "noreferrer";
  open.textContent = "Abrir";

  actions.append(task, open);
  item.append(main, actions);
  return item;
}

function labelForGitHubIssueState(value) {
  const labels = {
    open: "abertas",
    closed: "fechadas",
    all: "todas"
  };
  return labels[value] || "issues";
}

function renderCodexActivity() {
  if (!els.codexActivityPanel) {
    return;
  }

  const data = state.codexActivity;
  if (!data) {
    els.codexActivityPanel.replaceChildren(emptyParagraph("Status do Codex ainda nao carregado."));
    return;
  }

  const summary = document.createElement("div");
  summary.className = "codex-activity-summary";
  summary.append(
    statusMetric("CLI", data.codex?.available ? "pronto" : "indisponivel", data.codex?.version || data.codex?.error || "sem versao"),
    statusMetric("Ativas", formatInteger(data.active?.length || 0), "demandas com Codex"),
    statusMetric("Recentes", formatInteger(data.recent?.length || 0), "historico Codex")
  );

  const activeSection = codexJobSection("Em andamento", data.active || []);
  const recentSection = codexJobSection("Recentes", data.recent || []);

  els.codexActivityPanel.replaceChildren(summary, activeSection, recentSection);
}

function codexJobSection(title, jobs) {
  const section = document.createElement("section");
  section.className = "codex-job-section";
  const heading = document.createElement("h3");
  heading.textContent = title;
  const list = document.createElement("ul");
  list.className = "codex-job-list";
  if (!jobs.length) {
    list.append(emptyListItem(title === "Em andamento" ? "Nenhuma execucao Codex em andamento." : "Sem demandas Codex recentes."));
  } else {
    for (const job of jobs) {
      const item = document.createElement("li");
      const main = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = `#${job.id} · ${job.goal}`;
      const meta = document.createElement("small");
      const event = job.lastCodexEvent ? ` · ${job.lastCodexEvent.type}` : "";
      meta.textContent = `${labelForJobStatus(job.status)} · ${job.workspace}${event}`;
      main.append(name, meta);
      const open = document.createElement("button");
      open.type = "button";
      open.textContent = "Abrir";
      open.addEventListener("click", async () => {
        state.selectedJobId = job.id;
        state.demandFilter = "all";
        await loadSelectedJob();
        renderJobs();
        const panel = document.querySelector(".jobs-panel");
        if (panel) {
          panel.open = true;
        }
      });
      item.append(main, open);
      list.append(item);
    }
  }
  section.append(heading, list);
  return section;
}

function statusMetric(label, value, detail) {
  const item = document.createElement("article");
  const small = document.createElement("small");
  small.textContent = label;
  const strong = document.createElement("strong");
  strong.textContent = value;
  const span = document.createElement("span");
  span.textContent = detail;
  item.append(small, strong, span);
  return item;
}

function emptyParagraph(text) {
  const empty = document.createElement("p");
  empty.className = "empty-state";
  empty.textContent = text;
  return empty;
}

function emptyListItem(text) {
  const empty = document.createElement("li");
  empty.className = "empty";
  empty.textContent = text;
  return empty;
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

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / (1024 ** index)).toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
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
    ["Percepcao", state.screenPerception ? "ativa" : "parada"],
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
  return job.mode === "implement" && job.policyLevel === "write" && ["awaiting_confirm", "needs_input"].includes(job.status);
}

function canRunAnalystsJob(job) {
  return job.mode === "analyze" && job.policyLevel === "read" && ["draft", "queued", "needs_input"].includes(job.status);
}

function analystContext(job) {
  const metadata = job.metadata || {};
  const visualEvidence = screenEvidenceContextForJob();
  const persistentEvidence = persistentMemoryContextForCouncil();
  const findings = Array.isArray(metadata.findings)
    ? metadata.findings
    : metadata.findings ? [String(metadata.findings)] : [];
  return {
    constraints: metadata.constraints,
    files: metadata.files || metadata.likelyFiles,
    findings: [...findings, ...visualEvidence, ...persistentEvidence],
    attempted: metadata.attempted
  };
}

function screenEvidenceContextForJob() {
  return state.selectedJobArtifacts
    .filter((artifact) => artifact.kind === "screen-evidence")
    .map((artifact) => artifact.content || artifact.metadata?.summary || "")
    .filter(Boolean)
    .map((content) => `Evidencia visual consentida considerada: ${content}`);
}

function persistentMemoryContextForCouncil() {
  return state.memories
    .filter((memory) => ["preference", "project", "decision"].includes(memory.kind))
    .slice(0, 6)
    .map((memory) => `Memoria persistente (${labelForMemoryKind(memory.kind)} #${memory.id}) considerada: ${memory.content}`);
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
  const findings = Array.isArray(context.findings) ? context.findings : [];
  if (findings.some((item) => /Evidencia visual consentida/.test(item))) {
    lines.push("Visual evidence: included with explicit user consent.");
  }
  if (findings.some((item) => /Memoria persistente/.test(item))) {
    lines.push("Persistent memory: cited as operator-confirmed context.");
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
  const raw = String(value);
  const date = new Date(raw.includes("T") || raw.endsWith("Z") ? raw : `${raw}Z`);
  if (Number.isNaN(date.getTime())) {
    return "-";
  }
  return date.toLocaleString("pt-BR", {
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
  const suggestion = routineSuggestion(tasks);
  const summary = document.createElement("p");
  summary.textContent = suggestion.summary;

  const form = document.createElement("form");
  form.className = "routine-job-form";
  const input = document.createElement("input");
  input.type = "text";
  input.value = suggestion.goal;
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

function routineSuggestion(tasks) {
  const needs = state.jobs.filter((job) => ["draft", "awaiting_confirm", "needs_input"].includes(job.status));
  const failed = state.jobs.filter((job) => ["failed", "cancelled"].includes(job.status));
  const latestDone = state.jobs.find((job) => job.status === "done");

  if (needs.length) {
    return {
      summary: `Sugestao do dia: resolver ${needs.length} demanda(s) aguardando sua decisao antes de iniciar trabalho novo.`,
      goal: `Revisar e decidir proximos passos das demandas aguardando: ${needs.slice(0, 3).map((job) => `#${job.id}`).join(", ")}`
    };
  }

  if (tasks.length) {
    return {
      summary: `Sugestao do dia baseada nas tarefas abertas: ${tasks.map((task) => task.title).join(" · ")}`,
      goal: `Analisar prioridades de hoje: ${tasks.map((task) => task.title).join(", ")}`
    };
  }

  if (failed.length) {
    return {
      summary: `Sugestao do dia: revisar ${failed.length} demanda(s) com falha ou ignoradas para separar ruído de bloqueador real.`,
      goal: `Revisar falhas recentes e propor uma proxima acao segura: ${failed.slice(0, 3).map((job) => `#${job.id}`).join(", ")}`
    };
  }

  if (latestDone) {
    return {
      summary: `Sugestao do dia: continuar a partir da ultima entrega concluida, demanda #${latestDone.id}.`,
      goal: `Avaliar a continuidade da demanda #${latestDone.id} e propor o proximo passo de maior impacto`
    };
  }

  return {
    summary: "Rotina ativa. AURA pode sugerir uma demanda para organizar os proximos passos do dia.",
    goal: "Analisar proximos passos do dia"
  };
}

async function startScreenCapture() {
  if (state.screenStream) {
    stopScreenCapture("manual");
    return;
  }

  try {
    const permission = await api("/api/tools/run", {
      method: "POST",
      body: { name: "screen.capture.intent", input: {}, confirmed: true }
    });
    logEvent("screen.capture.intent", permission);
    const startedAt = Date.now();
    const durationMs = selectedPerceptionDurationMs();
    const purpose = screenPerceptionPurpose();
    state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    state.screenPerception = createScreenPerception({ now: startedAt, durationMs, purpose });
    els.screenVideo.srcObject = state.screenStream;
    els.screenVideo.hidden = false;
    els.stopScreenButton.hidden = false;
    els.screenButton.textContent = "Encerrar percepcao";
    startScreenPerceptionTimer();
    renderScreenPerceptionStatus();
    updateScreenEvidenceButton();
    renderLocalContextSummary();
    appendMessage("system", `Percepcao temporaria ativa por ${formatDurationMs(durationMs)}. Finalidade: ${purpose}. Frames crus nao serao persistidos.`);
    state.screenStream.getVideoTracks()[0].addEventListener("ended", () => stopScreenCapture("browser"));
  } catch (error) {
    appendMessage("system", `Captura nao iniciada: ${error.message}`);
    stopScreenCapture("failed");
  }
}

function stopScreenCapture(reason = "manual") {
  const ended = finishPerceptionSummary(reason);
  state.screenStream?.getTracks().forEach((track) => track.stop());
  state.screenStream = null;
  state.screenPerception = null;
  stopScreenPerceptionTimer();
  els.screenVideo.srcObject = null;
  els.screenVideo.hidden = true;
  els.attachScreenEvidenceButton.hidden = true;
  els.stopScreenButton.hidden = true;
  els.screenButton.textContent = "Iniciar percepcao";
  if (ended) {
    logEvent("screen.perception_ended", ended);
    if (reason === "expired") {
      appendMessage("system", "Percepcao encerrada automaticamente por expiracao.");
    }
  }
  renderScreenPerceptionStatus();
  renderLocalContextSummary();
}

function selectedPerceptionDurationMs() {
  return normalizePerceptionDurationMs(els.screenDurationSelect?.value);
}

function screenPerceptionPurpose() {
  if (state.selectedJob?.id) {
    return `Acompanhar demanda #${state.selectedJob.id}`;
  }
  return "Observacao temporaria consentida do cockpit";
}

function startScreenPerceptionTimer() {
  stopScreenPerceptionTimer();
  state.screenPerceptionTimer = window.setInterval(() => {
    if (!state.screenPerception) {
      return;
    }
    if (isPerceptionExpired(state.screenPerception)) {
      stopScreenCapture("expired");
      return;
    }
    renderScreenPerceptionStatus();
  }, 1000);
}

function stopScreenPerceptionTimer() {
  if (state.screenPerceptionTimer) {
    window.clearInterval(state.screenPerceptionTimer);
  }
  state.screenPerceptionTimer = null;
}

function finishPerceptionSummary(reason) {
  const summary = finishScreenPerception(state.screenPerception, { reason });
  if (!summary) {
    return null;
  }
  state.lastPerceptionSummary = summary.text;
  return summary;
}

function renderScreenPerceptionStatus() {
  if (!els.screenPerceptionStatus) {
    return;
  }
  const active = Boolean(state.screenPerception && state.screenStream);
  els.screenPerceptionStatus.classList.toggle("active", active);
  els.screenPerceptionStatus.classList.toggle("idle", !active);
  els.screenPerceptionLabel.textContent = active ? "Percepcao ativa" : "Percepcao desligada";
  els.screenPerceptionPurpose.textContent = active
    ? state.screenPerception.purpose
    : state.lastPerceptionSummary || "Sem observacao ativa.";
  const remainingMs = active ? remainingPerceptionMs(state.screenPerception) : 0;
  els.screenPerceptionTimer.textContent = active ? formatCountdown(remainingMs) : "--:--";
  els.screenPerceptionTimer.setAttribute("datetime", `PT${Math.ceil(remainingMs / 1000)}S`);
}

async function attachScreenEvidenceToJob() {
  if (!state.screenStream || els.screenVideo.hidden) {
    appendMessage("system", "Inicie a captura de tela antes de anexar evidencia.");
    return;
  }
  if (!state.selectedJob) {
    appendMessage("system", "Selecione uma demanda antes de anexar evidencia visual.");
    return;
  }
  if (!confirm(`Anexar a tela atual como evidencia resumida da demanda #${state.selectedJob.id}? A imagem crua nao sera persistida.`)) {
    return;
  }

  const width = els.screenVideo.videoWidth || 0;
  const height = els.screenVideo.videoHeight || 0;
  const summary = [
    `Tela capturada pelo operador para a demanda #${state.selectedJob.id}.`,
    `Estado do cockpit: ${state.now?.headline || state.selectedJob.status}.`,
    "AURA deve considerar esta evidencia visual como contexto consentido."
  ].join(" ");

  await withBusyButton(els.attachScreenEvidenceButton, "Anexando", async () => {
    try {
      const result = await api(`/api/jobs/${state.selectedJob.id}/screen-evidence`, {
        method: "POST",
        body: {
          confirmed: true,
          width,
          height,
          summary
        }
      });
      state.selectedJob = result.job;
      state.selectedJobEvents = result.events || [];
      state.selectedJobArtifacts = result.artifacts || [];
      await refreshJobs();
      appendMessage("system", `Evidencia visual anexada a demanda #${state.selectedJob.id}.`);
    } catch (error) {
      appendMessage("system", `Evidencia visual nao anexada: ${humanizeJobMessage(error.message, error.details)}`);
    }
  });
}

function updateScreenEvidenceButton() {
  els.attachScreenEvidenceButton.hidden = !state.screenStream || !state.selectedJob;
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
  if (message.includes("gemini_api_key") || message.includes("gemini api key") || message.includes("gemini live websocket")) {
    return "a conexao com o Gemini Live nao foi aberta";
  }
  if (message.includes("voice_provider")) {
    return "o provider de voz configurado nao e suportado; use openai ou gemini";
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
  if (call.name === "aura_list_local_folder") {
    return listLocalFolderFromRealtime(args);
  }
  if (call.name === "aura_codex_activity") {
    return codexActivityFromRealtime();
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

async function listLocalFolderFromRealtime(args) {
  const rootId = Number(args.root_id ?? args.rootId ?? args.root ?? 0);
  const relativePath = String(args.path ?? args.relative_path ?? args.relativePath ?? ".").trim() || ".";

  if (relativePath.startsWith("/") || relativePath.includes("..")) {
    return {
      ok: false,
      error: "Use um caminho relativo dentro da raiz local permitida."
    };
  }

  try {
    state.localFileRoot = Number.isFinite(rootId) ? rootId : 0;
    state.localFilePath = relativePath;
    state.localFiles = await loadLocalFiles();
    renderLocalFiles();
    renderLocalContextSummary();
    openSessionPanel("files");

    const entries = state.localFiles.entries || [];
    const directories = entries.filter((entry) => entry.type === "directory").slice(0, 10);
    const files = entries.filter((entry) => entry.type !== "directory").slice(0, 10);
    const spokenSummary = `Pasta local lida pela voz: ${entries.length} itens em ${state.localFiles.path === "." ? state.localFiles.root.realPath : state.localFiles.path}.`;
    appendMessage("system", spokenSummary);

    return {
      ok: true,
      root: state.localFiles.root.realPath,
      path: state.localFiles.path,
      totalEntries: entries.length,
      truncated: Boolean(state.localFiles.truncated),
      directories: directories.map(localEntrySummary),
      files: files.map(localEntrySummary),
      responseHint: "Responda em portugues, cite no maximo 6 itens e avise que a aba Arquivos foi aberta com os detalhes."
    };
  } catch (error) {
    const message = humanizeJobMessage(error.message, error.details);
    appendMessage("system", `Nao consegui listar a pasta por voz: ${message}`);
    return { ok: false, error: message };
  }
}

async function codexActivityFromRealtime() {
  try {
    state.codexActivity = await api("/api/codex/activity");
    renderCodexActivity();
    renderLocalContextSummary();
    openSessionPanel("codex");

    const active = state.codexActivity.active || [];
    const recent = state.codexActivity.recent || [];
    appendMessage("system", `Atividade Codex consultada pela voz: ${active.length} ativa(s), ${recent.length} recente(s).`);
    return {
      ok: true,
      codexAvailable: Boolean(state.codexActivity.codex?.available),
      codexVersion: state.codexActivity.codex?.version || "",
      activeCount: active.length,
      recentCount: recent.length,
      active: active.slice(0, 5).map(codexJobSummary),
      recent: recent.slice(0, 5).map(codexJobSummary),
      responseHint: "Responda em portugues e diga que a aba Codex foi aberta com os detalhes."
    };
  } catch (error) {
    const message = humanizeJobMessage(error.message, error.details);
    appendMessage("system", `Nao consegui consultar o Codex por voz: ${message}`);
    return { ok: false, error: message };
  }
}

function localEntrySummary(entry) {
  return {
    name: entry.name,
    type: entry.type,
    path: entry.path,
    size: entry.size ? formatBytes(entry.size) : null,
    updatedAt: entry.updatedAt
  };
}

function codexJobSummary(job) {
  return {
    id: job.id,
    goal: job.goal,
    status: job.status,
    workspace: job.workspace,
    updatedAt: job.updatedAt
  };
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
  const body = last.querySelector("p");
  body.textContent = redactClientText(`${body.textContent}${delta}`);
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
  body.textContent = redactClientText(text);
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
    caption.textContent = redactClientText(`${attachment.kind}: ${attachment.name}`);
    card.append(caption);
    list.append(card);
  }
  return list;
}

function logEvent(type, payload) {
  state.events.unshift({
    type: redactClientText(type),
    payload: redactClientObject(payload),
    at: new Date().toLocaleTimeString()
  });
  state.events = state.events.slice(0, 20);
  els.eventLog.replaceChildren(...state.events.map((event) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${event.at}</span><code>${event.type}</code>`;
    return item;
  }));
}

function loadJsonSetting(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
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
