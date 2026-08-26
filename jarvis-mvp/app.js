import { RealtimeClient } from "./realtime.js";

const state = {
  status: null,
  tasks: [],
  memories: [],
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
}

async function refreshAll() {
  const [status, tasksData, memoriesData] = await Promise.all([
    api("/api/status"),
    api("/api/tasks"),
    api("/api/memories")
  ]);

  state.status = status;
  state.tasks = tasksData.tasks;
  state.memories = memoriesData.memories;
  renderStatus();
  renderTasks();
  renderMemories();
  renderTools();
  renderRoutine();
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

function renderTools() {
  els.toolsList.replaceChildren(...state.status.tools.map((tool) => {
    const item = document.createElement("li");
    item.innerHTML = `<span>${tool.name}</span><small>${tool.requiresConfirmation ? "confirma" : "seguro"}</small>`;
    return item;
  }));
}

function renderRoutine() {
  if (!state.routineEnabled) {
    els.routinePanel.textContent = "Rotina pausada.";
    return;
  }

  const tasks = state.tasks.filter((task) => task.status !== "done");
  els.routinePanel.textContent = tasks.length
    ? `Hoje: ${tasks.map((task) => task.title).join(" · ")}`
    : "Rotina ativa. Nenhuma tarefa aberta agora.";
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
