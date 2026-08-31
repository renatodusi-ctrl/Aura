import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, ensureRuntime, ROOT_DIR } from "./config.js";
import {
  getStatus,
  initMemory,
  listMemories,
  addMemory,
  updateMemory,
  persistentMemorySummary,
  listTasks,
  addTask,
  updateTask,
  deleteTask,
  getTask,
  createJob,
  createJobArtifact,
  deleteJobArtifact,
  getJob,
  listJobArtifacts,
  listJobEvents,
  listJobs,
  getCostSummary,
  recordJobEvent,
  recordCostUsage,
  updateJobDraft,
  updateJobMetadata,
  updateJobStatus
} from "./memory.js";
import { getLocalContext, listTools, runTool } from "./tools.js";
import { evaluateJobPolicy, normalizePolicyLevel, POLICY_LEVELS } from "./policy.js";
import { createSessionToken, isAllowedOrigin, isProtectedApiPath, validateSessionRequest } from "./httpSecurity.js";
import { activeJobProcessSummary, cancelJobProcess } from "./supervisor.js";
import { detectCodex, runCodexAsk, runCodexImplement } from "./codexAdapter.js";
import {
  activeAnalystProcessSummary,
  analystCircuitState,
  buildEvidenceBrief,
  cancelAnalystJobProcess,
  resetAnalystCircuit,
  runAnalysts
} from "./analystAdapter.js";
import { synthesizeDebate } from "./debateSynthesizer.js";
import { handleVoiceIntent } from "./voiceIntents.js";
import { buildVoiceHealth } from "./voiceHealth.js";
import { rememberDecision, rememberJobEvent, rememberPreference, sessionMemorySummary } from "./sessionMemory.js";
import { redactText } from "./redaction.js";
import { filteredToolEnv, killProcessTree, prepareToolSpawn, spawnToolSync } from "./processTools.js";
import { codexActivityPayload, listLocalFolder, localRootsPayload } from "./localAccess.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, "..");
const systemPrompt = fs.readFileSync(path.join(__dirname, "prompts", "system.txt"), "utf8");

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8"
};

const JOB_API_MODES = new Set(["ask", "analyze", "implement"]);
const TASK_EXECUTORS = new Set(["codex", "council", "codex-council"]);
const PROVIDER_PREFLIGHT_TTL_MS = 10000;
const sessionToken = createSessionToken();
let providerPreflightCache = null;
ensureRuntime();
initMemory();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: error.message || "Internal server error" });
  }
});

server.listen(config.port, config.host, () => {
  const currentVoiceStatus = voiceStatus();
  console.log(`AURA cockpit ready at http://${config.host}:${config.port}`);
  console.log(currentVoiceStatus.enabled ? `Realtime voice: ${currentVoiceStatus.provider}` : `Realtime voice: ${currentVoiceStatus.status} (${currentVoiceStatus.fallbackReason})`);
});

server.on("upgrade", (req, socket) => {
  handleUpgrade(req, socket).catch((error) => {
    console.error(error);
    socket.destroy();
  });
});

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method || "GET";

  if (url.pathname === "/api/session" && method === "GET") {
    if (!isAllowedOrigin(req.headers.origin, { host: config.host, port: config.port })) {
      return sendJson(res, 403, { error: "Unexpected request origin." });
    }
    return sendJson(res, 200, { token: sessionToken });
  }

  if (isProtectedApiPath(url.pathname, method)) {
    const protection = validateApiProtection(req);
    if (!protection.ok) {
      return sendJson(res, protection.status, { error: protection.error });
    }
  }

  if (url.pathname === "/api/status" && method === "GET") {
    const providers = await getProviderPreflight();
    const voiceHealthStartedAtMs = Date.now();
    const currentVoiceStatus = voiceStatus(voiceHealthStartedAtMs);
    return sendJson(res, 200, {
      ok: true,
      realtimeEnabled: currentVoiceStatus.enabled,
      realtimeProvider: currentVoiceStatus.provider,
      realtimeModel: currentVoiceStatus.model,
      realtimeVoice: currentVoiceStatus.voice,
      voice: currentVoiceStatus,
      dailyRoutineHour: config.dailyRoutineHour,
      jobHistoryRetentionDays: config.jobHistoryRetentionDays,
      jobExportDir: config.jobExportDir,
      providers,
      memory: getStatus(),
      persistentMemory: persistentMemorySummary(),
      operations: {
        jobProcesses: activeJobProcessSummary(),
        analystProcesses: activeAnalystProcessSummary()
      },
      sessionMemory: sessionMemorySummary(),
      tools: listTools()
    });
  }

  if (url.pathname === "/api/context" && method === "GET") {
    return sendJson(res, 200, getLocalContext());
  }

  if (url.pathname === "/api/now" && method === "GET") {
    return sendJson(res, 200, { now: buildNowSnapshot() });
  }

  if (url.pathname === "/api/voice/health" && method === "GET") {
    return sendJson(res, 200, { voice: voiceStatus(Date.now()) });
  }

  if (url.pathname === "/api/local-files" && method === "GET") {
    return sendJson(res, 200, localRootsPayload());
  }

  if (url.pathname === "/api/local-files/list" && method === "GET") {
    try {
      return sendJson(res, 200, listLocalFolder({
        rootId: url.searchParams.get("root") || 0,
        relativePath: url.searchParams.get("path") || "."
      }));
    } catch (error) {
      return sendJson(res, error.statusCode || 400, { error: error.message || "Could not list local folder." });
    }
  }

  if (url.pathname === "/api/codex/activity" && method === "GET") {
    return sendJson(res, 200, await codexActivityPayload());
  }

  if (url.pathname === "/api/jobs" && method === "GET") {
    return sendJson(res, 200, { jobs: listJobs(limitFromQuery(url, 50)) });
  }

  if (url.pathname === "/api/jobs" && method === "POST") {
    return createJobRoute(req, res);
  }

  if (url.pathname === "/api/routine/jobs" && method === "POST") {
    return createRoutineJobRoute(req, res);
  }

  const providerCircuitRoute = matchProviderCircuitRoute(url.pathname);
  if (providerCircuitRoute && method === "POST") {
    return resetProviderCircuitRoute(providerCircuitRoute.provider, req, res);
  }

  const jobRoute = matchJobRoute(url.pathname);
  if (jobRoute && method === "PATCH" && !jobRoute.action) {
    return updateJobDraftRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "GET" && !jobRoute.action) {
    const job = getJob(jobRoute.id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    return sendJson(res, 200, { job, events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  }

  if (jobRoute && method === "GET" && jobRoute.action === "events") {
    const job = getJob(jobRoute.id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    return sendJson(res, 200, { events: listJobEvents(job.id) });
  }

  if (jobRoute && method === "POST" && jobRoute.action === "cancel") {
    return cancelJobRoute(jobRoute.id, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "skip") {
    return skipJobRoute(jobRoute.id, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "approve") {
    return approveJobRoute(jobRoute.id, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "pause") {
    return pauseJobRoute(jobRoute.id, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "revise") {
    return reviseJobPlanRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "codex/ask") {
    return codexAskRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "codex/implement") {
    return codexImplementRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "analysts/preview") {
    return analystPreviewRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "analysts/run") {
    return analystsRunRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "debate/synthesize") {
    return debateSynthesizeRoute(jobRoute.id, req, res);
  }

  if (jobRoute && method === "POST" && jobRoute.action === "screen-evidence") {
    return attachScreenEvidenceRoute(jobRoute.id, req, res);
  }

  const artifactRoute = matchJobArtifactRoute(url.pathname);
  if (artifactRoute && method === "DELETE") {
    return removeScreenEvidenceRoute(artifactRoute.jobId, artifactRoute.artifactId, url, res);
  }

  if (url.pathname === "/api/memories" && method === "GET") {
    return sendJson(res, 200, { memories: listMemories() });
  }

  if (url.pathname === "/api/memories" && method === "POST") {
    return sendJson(res, 201, { memory: addMemory(await readJson(req)) });
  }

  const memoryRoute = matchMemoryRoute(url.pathname);
  if (memoryRoute && method === "PATCH") {
    return updateMemoryRoute(memoryRoute.id, req, res);
  }

  if (url.pathname.startsWith("/api/memories/") && method === "DELETE") {
    const id = url.pathname.split("/").pop();
    return sendJson(res, 200, runTool("memory.delete", { id }, url.searchParams.get("confirm") === "true"));
  }

  if (url.pathname === "/api/tasks" && method === "GET") {
    return sendJson(res, 200, { tasks: listTasks(url.searchParams.get("includeDone") !== "false") });
  }

  if (url.pathname === "/api/tasks" && method === "POST") {
    return sendJson(res, 201, { task: addTask(await readJson(req)) });
  }

  if (url.pathname.startsWith("/api/tasks/") && method === "PATCH") {
    const id = url.pathname.split("/").pop();
    return sendJson(res, 200, { task: updateTask(id, await readJson(req)) });
  }

  const taskDevelopRoute = matchTaskDevelopRoute(url.pathname);
  if (taskDevelopRoute && method === "POST") {
    return developTaskRoute(taskDevelopRoute.id, req, res);
  }

  if (url.pathname.startsWith("/api/tasks/") && method === "DELETE") {
    const id = url.pathname.split("/").pop();
    return sendJson(res, 200, runTool("tasks.delete", { id }, url.searchParams.get("confirm") === "true"));
  }

  if (url.pathname === "/api/tools/run" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, runTool(body.name, body.input, body.confirmed === true));
  }

  if (url.pathname === "/api/costs" && method === "GET") {
    return sendJson(res, 200, costDashboardPayload());
  }

  if (url.pathname === "/api/costs/usage" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 201, { usage: recordCostUsage(body), costs: costDashboardPayload() });
  }

  if (url.pathname === "/api/local/chat" && method === "POST") {
    return sendJson(res, 200, localChat(await readJson(req)));
  }

  if (url.pathname === "/api/realtime/token" && method === "GET") {
    return createRealtimeToken(res);
  }

  if (url.pathname === "/api/realtime/call" && method === "POST") {
    return createRealtimeCallRoute(req, res);
  }

  if (url.pathname === "/api/realtime/config" && method === "GET") {
    return sendJson(res, 200, realtimeSessionPayload());
  }

  return serveStatic(url.pathname, res);
}

function validateApiProtection(req) {
  return validateSessionRequest({
    origin: req.headers.origin,
    token: req.headers["x-aura-session"],
    expectedToken: sessionToken,
    host: config.host,
    port: config.port
  });
}

function voiceStatus(startedAtMs) {
  return buildVoiceHealth(config, { startedAtMs });
}

async function handleUpgrade(req, socket) {
  const url = new URL(req.url || "/", `http://${req.headers.host}`);
  if (url.pathname !== "/api/gemini/live") {
    socket.destroy();
    return;
  }

  const protection = validateSessionRequest({
    origin: req.headers.origin,
    token: url.searchParams.get("session"),
    expectedToken: sessionToken,
    host: config.host,
    port: config.port
  });
  if (!protection.ok) {
    socket.write(`HTTP/1.1 ${protection.status} ${protection.error}\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    return;
  }

  if (!config.geminiApiKey) {
    socket.write("HTTP/1.1 503 Gemini API key missing\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.write("HTTP/1.1 400 Missing WebSocket key\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "\r\n"
  ].join("\r\n"));

  bridgeGeminiLive(new LocalWebSocket(socket));
}

function bridgeGeminiLive(client) {
  const geminiUrl = `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(config.geminiApiKey)}`;
  const gemini = new WebSocket(geminiUrl);

  gemini.addEventListener("open", () => {
    gemini.send(JSON.stringify(geminiLiveSetupPayload()));
    client.sendJson({ type: "aura.gemini.connecting", model: config.geminiLiveModel });
  });
  gemini.addEventListener("message", async (event) => {
    client.sendText(await websocketMessageToText(event.data));
  });
  gemini.addEventListener("error", (event) => {
    client.sendJson({ type: "aura.gemini.error", error: event.message || "Gemini Live WebSocket error." });
  });
  gemini.addEventListener("close", (event) => {
    client.sendJson({ type: "aura.gemini.closed", code: event.code, reason: event.reason || "" });
    client.close();
  });

  client.onMessage = (text) => {
    if (gemini.readyState !== WebSocket.OPEN) {
      return;
    }
    const message = JSON.parse(text);
    if (message.type === "audio" && message.data) {
      gemini.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: message.data,
            mimeType: message.mimeType || "audio/pcm;rate=16000"
          }
        }
      }));
      return;
    }
    if (message.type === "text" && message.text) {
      gemini.send(JSON.stringify({
        realtimeInput: {
          text: message.text
        }
      }));
      return;
    }
    if (message.type === "toolResponse" && Array.isArray(message.functionResponses)) {
      gemini.send(JSON.stringify({
        toolResponse: {
          functionResponses: message.functionResponses
        }
      }));
    }
  };
  client.onClose = () => {
    if (gemini.readyState === WebSocket.OPEN || gemini.readyState === WebSocket.CONNECTING) {
      gemini.close();
    }
  };
}

async function websocketMessageToText(data) {
  if (typeof data === "string") {
    return data;
  }
  if (data instanceof Blob) {
    return data.text();
  }
  if (data instanceof ArrayBuffer) {
    return Buffer.from(data).toString("utf8");
  }
  return Buffer.from(data).toString("utf8");
}

function geminiLiveSetupPayload() {
  return {
    setup: {
      model: `models/${config.geminiLiveModel}`,
      generationConfig: {
        responseModalities: ["AUDIO"]
      },
      systemInstruction: {
        parts: [{ text: geminiLiveInstructions() }]
      },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      tools: [{
        functionDeclarations: geminiFunctionDeclarations()
      }]
    }
  };
}

function geminiLiveInstructions() {
  return `${systemPrompt}\n\nVoz Gemini Live:\n- Voce e AURA, uma assistente pessoal por voz.\n- Fale sempre em portugues brasileiro natural.\n- Responda com frases curtas e objetivas.\n- A sessao comeca em standby silencioso. Responda somente quando a fala contiver claramente o nome Aura.\n- Se ouvir ate logo Aura, obrigado Aura, pode descansar Aura ou tchau Aura, responda brevemente e volte ao standby.\n- Quando o usuario pedir para criar task ou demanda, use as ferramentas disponiveis.\n- Quando o usuario pedir para ver pastas, projetos, arquivos locais ou o que existe no workspace, use aura_list_local_folder. A ferramenta e somente leitura e limitada as raizes permitidas.\n- Quando o usuario perguntar o que esta em andamento no Codex, use aura_codex_activity.`;
}

function geminiFunctionDeclarations() {
  return [
    {
      name: "aura_create_task",
      description: "Cria uma task segura no cockpit local do AURA.",
      parameters: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING", description: "Titulo curto da task em portugues." },
          scope: { type: "STRING", enum: ["demanda", "plataforma", "geral"] },
          demandId: { type: "INTEGER", description: "Id da demanda, quando houver." }
        },
        required: ["title"]
      }
    },
    {
      name: "aura_develop_task",
      description: "Transforma uma task existente em demanda de desenvolvimento.",
      parameters: {
        type: "OBJECT",
        properties: {
          taskId: { type: "INTEGER", description: "Id da task." },
          extraGoal: { type: "STRING", description: "Detalhe adicional opcional." },
          executor: { type: "STRING", enum: ["codex", "council", "codex-council"] }
        },
        required: ["taskId"]
      }
    },
    {
      name: "aura_create_development_demand",
      description: "Cria uma demanda de desenvolvimento livre no cockpit.",
      parameters: {
        type: "OBJECT",
        properties: {
          goal: { type: "STRING", description: "Objetivo de desenvolvimento em portugues." },
          executor: { type: "STRING", enum: ["codex", "council", "codex-council"] }
        },
        required: ["goal"]
      }
    },
    {
      name: "aura_list_local_folder",
      description: "Lista, em modo somente leitura, pastas e arquivos dentro das raizes locais permitidas do cockpit.",
      parameters: {
        type: "OBJECT",
        properties: {
          root_id: { type: "INTEGER", description: "Indice da raiz permitida. Use 0 quando o usuario nao especificar." },
          path: { type: "STRING", description: "Caminho relativo dentro da raiz permitida. Use ponto para a raiz." }
        }
      }
    },
    {
      name: "aura_codex_activity",
      description: "Consulta o que esta em andamento ou recente no Codex dentro do cockpit AURA.",
      parameters: {
        type: "OBJECT",
        properties: {}
      }
    }
  ];
}

class LocalWebSocket {
  constructor(socket) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.onMessage = () => {};
    this.onClose = () => {};

    socket.on("data", (chunk) => this.handleData(chunk));
    socket.on("close", () => this.onClose());
    socket.on("error", () => this.onClose());
  }

  sendJson(value) {
    this.sendText(JSON.stringify(value));
  }

  sendText(text) {
    if (this.socket.destroyed) {
      return;
    }
    this.socket.write(encodeWebSocketFrame(String(text)));
  }

  close() {
    if (!this.socket.destroyed) {
      this.socket.end(encodeWebSocketFrame("", 0x8));
    }
  }

  handleData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= 2) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (!frame) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.frameLength);
      if (frame.opcode === 0x8) {
        this.close();
        return;
      }
      if (frame.opcode === 0x9) {
        this.socket.write(encodeWebSocketFrame(frame.payload, 0xA));
        continue;
      }
      if (frame.opcode === 0x1) {
        this.onMessage(frame.payload.toString("utf8"));
      }
    }
  }
}

function decodeWebSocketFrame(buffer) {
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  const masked = Boolean(second & 0x80);
  let offset = 2;
  let length = second & 0x7f;

  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    length = Number(buffer.readBigUInt64BE(offset));
    offset += 8;
  }

  const maskLength = masked ? 4 : 0;
  const frameLength = offset + maskLength + length;
  if (buffer.length < frameLength) {
    return null;
  }

  const mask = masked ? buffer.subarray(offset, offset + 4) : null;
  offset += maskLength;
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (mask) {
    for (let index = 0; index < payload.length; index += 1) {
      payload[index] ^= mask[index % 4];
    }
  }

  return { opcode, payload, frameLength };
}

function encodeWebSocketFrame(data, opcode = 0x1) {
  const payload = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
  let header;
  if (payload.length < 126) {
    header = Buffer.from([0x80 | opcode, payload.length]);
  } else if (payload.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function costDashboardPayload() {
  return {
    ...getCostSummary(80),
    keys: [
      keyStatus("OpenAI", "OPENAI_API_KEY", Boolean(config.openaiApiKey), "Realtime/WebRTC"),
      keyStatus("Gemini", configuredEnvName(["GEMINI_API_KEY", "GOOGLE_API_KEY"]), Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), "Gemini CLI"),
      keyStatus("Grok", configuredEnvName(["GROK_API_KEY", "XAI_API_KEY"]), Boolean(process.env.GROK_API_KEY || process.env.XAI_API_KEY), "Grok CLI"),
      openRouterCostKeyStatus(),
      keyStatus("Codex", configuredEnvName(["CODEX_API_KEY", "OPENAI_API_KEY"]), Boolean(process.env.CODEX_API_KEY || process.env.OPENAI_API_KEY), "Codex CLI")
    ],
    notes: [
      "Custos sao estimativas locais quando o provedor retorna usage.",
      "Valores de chaves nunca sao exibidos ou persistidos.",
      "CLIs sem usage automatico aparecem como configurados, mas sem custo medido."
    ]
  };
}

function keyStatus(provider, envName, configured, source) {
  return {
    provider,
    envName,
    configured,
    source,
    label: configured ? `${envName} configurada` : `${envName} ausente`
  };
}

function openRouterCostKeyStatus() {
  const envName = configuredEnvName(["OPENROUTER_API_KEY", "OPENROUTE_API_KEY"]);
  const hasEnvKey = Boolean(process.env.OPENROUTER_API_KEY || process.env.OPENROUTE_API_KEY);
  const hasCli = commandAvailable(process.env.AURA_OPENROUTER_BIN || "openrouter", ["--version"]);
  return {
    provider: "OpenRouter",
    envName,
    configured: hasEnvKey || hasCli,
    source: hasEnvKey ? "OpenRouter API" : "OpenRouter CLI",
    label: hasEnvKey ? `${envName} configurada` : hasCli ? "CLI configurado; chave gerenciada pelo OpenRouter CLI" : `${envName} ausente`
  };
}

function commandAvailable(command, args = []) {
  const result = spawnToolSync(command, args, {
    encoding: "utf8",
    stdio: "ignore",
    timeout: 1800,
    windowsHide: true
  });
  return result.status === 0;
}

function configuredEnvName(names) {
  return names.find((name) => Boolean(process.env[name])) || names[0];
}

async function createJobRoute(req, res) {
  try {
    const body = await readJson(req);
    const workspace = resolveWorkspace(body.workspace);
    const mode = normalizeJobMode(body.mode || "ask");
    const policyLevel = policyLevelForJobMode(mode, normalizeJobPolicyLevel(body.policyLevel || defaultPolicyLevelForMode(mode)));
    const policy = evaluateJobPolicy(policyLevel);

    const job = createJob({
      goal: body.goal,
      workspace,
      mode,
      requestedBy: body.requestedBy || "text",
      policyLevel,
      requiresConfirmation: policy.requiresConfirmation,
      timeoutMs: body.timeoutMs || timeoutForJobMode(mode),
      metadata: {
        ...(body.metadata || {}),
        policy: {
          confirmationType: policy.confirmationType,
          reason: policy.reason
        }
      }
    });

    let finalJob = job;
    let status = 201;
    if (policy.status === "awaiting_confirm") {
      finalJob = updateJobStatus(job.id, "awaiting_confirm", { summary: policy.reason });
      status = 202;
    }

    if (policy.status === "failed") {
      finalJob = updateJobStatus(job.id, "failed", { error: policy.reason, summary: policy.reason });
      status = 403;
    }

    rememberJobEvent(finalJob, "created");
    return sendJson(res, status, { job: finalJob, events: listJobEvents(job.id), policy });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not create job."));
  }
}

async function createRoutineJobRoute(req, res) {
  try {
    const body = await readJson(req);
    const mode = normalizeJobMode(body.mode || "analyze");
    if (mode === "implement") {
      throw httpError(400, "Routine cannot create implement jobs automatically.");
    }
    const workspace = resolveWorkspace(body.workspace);
    const job = createJob({
      goal: body.goal,
      workspace,
      mode,
      requestedBy: "routine",
      policyLevel: "read",
      requiresConfirmation: false,
      timeoutMs: body.timeoutMs || config.jobTimeoutMs,
      metadata: {
        ...(body.metadata || {}),
        routine: {
          draft: true,
          execution: "manual"
        }
      }
    });
    rememberJobEvent(job, "routine_created");
    return sendJson(res, 201, { job, events: listJobEvents(job.id), policy: evaluateJobPolicy("read") });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not create routine job."));
  }
}

async function developTaskRoute(id, req, res) {
  try {
    const body = await readJson(req);
    const result = createDevelopmentJobFromTask(id, {
      requestedBy: body.requestedBy || "text",
      source: body.source || "task-action",
      executor: body.executor || "codex",
      workspace: body.workspace,
      extraGoal: body.extraGoal,
      timeoutMs: body.timeoutMs
    });
    return sendJson(res, 202, result);
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not create development demand."));
  }
}

async function updateJobDraftRoute(id, req, res) {
  try {
    const job = getJob(id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    const body = await readJson(req);
    const mode = body.mode === undefined ? undefined : normalizeJobMode(body.mode);
    if (job.requestedBy === "routine" && mode === "implement") {
      throw httpError(400, "Routine draft jobs cannot switch to implement mode.");
    }
    const updated = updateJobDraft(id, { goal: body.goal, mode });
    return sendJson(res, 200, { job: updated, events: listJobEvents(updated.id), artifacts: listJobArtifacts(updated.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not update draft job."));
  }
}

function approveJobRoute(id, res) {
  try {
    const job = getJob(id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    if (job.status !== "draft") {
      throw httpError(409, "Only draft jobs can be approved.");
    }
    const queued = updateJobStatus(job.id, "queued", {
      summary: "Draft approved. Execution remains manual."
    });
    rememberJobEvent(queued, "approved");
    return sendJson(res, 200, { job: queued, events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not approve draft job."));
  }
}

function cancelJobRoute(id, res) {
  try {
    const job = getJob(id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }

    if (cancelJobProcess(job.id)) {
      const current = getJob(job.id);
      rememberJobEvent(current, "cancel_requested");
      return sendJson(res, 202, { job: current, cancellation: "requested", events: listJobEvents(job.id) });
    }

    if (cancelAnalystJobProcess(job.id)) {
      const current = getJob(job.id);
      rememberJobEvent(current, "cancel_requested");
      return sendJson(res, 202, { job: current, cancellation: "requested", events: listJobEvents(job.id) });
    }

    const cancelled = updateJobStatus(job.id, "cancelled", {
      summary: "Job cancelled before execution."
    });
    rememberJobEvent(cancelled, "cancelled");
    return sendJson(res, 200, { job: cancelled, events: listJobEvents(job.id) });
  } catch (error) {
    return sendJson(res, 409, { error: error.message || "Could not cancel job." });
  }
}

function pauseJobRoute(id, res) {
  try {
    const job = getJob(id);
    if (!job) {
      throw httpError(404, "Job not found.");
    }
    if (!["draft", "awaiting_confirm", "queued", "running", "needs_input"].includes(job.status)) {
      throw httpError(409, "Only active or pending jobs can be paused.");
    }
    if (job.status === "running" && (cancelJobProcess(job.id) || cancelAnalystJobProcess(job.id))) {
      const current = getJob(job.id);
      rememberJobEvent(current, "pause_requested");
      return sendJson(res, 202, { job: current, cancellation: "requested", events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
    }

    const paused = updateJobStatus(job.id, "needs_input", {
      summary: "Demanda pausada pelo usuario antes de executar efeitos no workspace."
    });
    updateJobMetadata(job.id, {
      paused: {
        at: new Date().toISOString(),
        reason: "operator-request",
        reversible: true
      }
    });
    recordJobEvent(job.id, "job.paused", "Job paused before irreversible effects.", { reversible: true });
    rememberJobEvent(getJob(job.id), "paused");
    return sendJson(res, 200, { job: getJob(job.id), events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not pause job."));
  }
}

async function reviseJobPlanRoute(id, req, res) {
  try {
    const job = getJob(id);
    if (!job) {
      throw httpError(404, "Job not found.");
    }
    if (!["draft", "awaiting_confirm", "needs_input"].includes(job.status)) {
      throw httpError(409, "Only jobs waiting for a decision can be revised.");
    }
    const body = await readJson(req);
    const comment = redactText(String(body.comment || body.critique || "").trim());
    if (!comment) {
      throw httpError(400, "Revision comment is required.");
    }

    const revised = updateJobMetadata(job.id, {
      operatorCritique: {
        comment,
        at: new Date().toISOString(),
        effect: "revise-before-execution"
      },
      planRevision: {
        status: "needs-human-review",
        reason: "operator-critique"
      }
    });
    recordJobEvent(job.id, "job.plan_critiqued", "Operator critique added before execution.", {
      comment,
      effect: "revise-before-execution"
    });
    rememberJobEvent(revised, "plan_critiqued");
    return sendJson(res, 200, { job: revised, events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not revise job plan."));
  }
}

function skipJobRoute(id, res) {
  try {
    const job = getJob(id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    if (job.status !== "needs_input" && job.status !== "draft" && job.status !== "awaiting_confirm") {
      throw httpError(409, "Only demands waiting for a decision can be skipped.");
    }

    const skipped = updateJobStatus(job.id, "cancelled", {
      summary: "Demanda ignorada por decisao do usuario. Nenhuma acao foi executada."
    });
    rememberJobEvent(skipped, "skipped");
    return sendJson(res, 200, { job: skipped, events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not skip job."));
  }
}

async function attachScreenEvidenceRoute(id, req, res) {
  try {
    const job = getJob(id);
    if (!job) {
      throw httpError(404, "Job not found.");
    }
    const body = await readJson(req);
    if (body.confirmed !== true) {
      throw httpError(400, "Screen evidence requires explicit user confirmation.");
    }

    const summary = redactText(String(body.summary || body.note || "Tela capturada com consentimento do usuario.").trim());
    const artifact = createJobArtifact(job.id, {
      kind: "screen-evidence",
      label: "Evidencia visual consentida",
      content: [
        "Evidencia visual considerada com consentimento explicito.",
        `Resumo: ${summary}`,
        `Dimensoes: ${Number(body.width) || 0}x${Number(body.height) || 0}`,
        `Capturada em: ${new Date().toISOString()}`,
        "Imagem crua nao foi persistida para reduzir exposicao de dados sensiveis."
      ].join("\n"),
      metadata: {
        consent: "explicit",
        source: "browser-getDisplayMedia",
        redacted: true,
        rawImagePersisted: false,
        width: Number(body.width) || 0,
        height: Number(body.height) || 0,
        summary
      }
    });
    recordJobEvent(job.id, "screen.evidence_attached", "Screen evidence attached with explicit consent.", {
      artifactId: artifact.id,
      rawImagePersisted: false
    });
    rememberJobEvent(getJob(job.id), "screen_evidence");
    return sendJson(res, 201, { job: getJob(job.id), artifact, events: listJobEvents(job.id), artifacts: listJobArtifacts(job.id) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not attach screen evidence."));
  }
}

function removeScreenEvidenceRoute(jobId, artifactId, url, res) {
  try {
    if (url.searchParams.get("confirm") !== "true") {
      throw httpError(400, "Removing screen evidence requires confirm=true.");
    }
    const removed = deleteJobArtifact(jobId, artifactId, { allowedKinds: ["screen-evidence"] });
    recordJobEvent(jobId, "screen.evidence_removed", "Screen evidence removed by user.", {
      artifactId,
      rawImagePersisted: false
    });
    rememberJobEvent(getJob(jobId), "screen_evidence_removed");
    return sendJson(res, 200, { ...removed, events: listJobEvents(jobId), artifacts: listJobArtifacts(jobId) });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not remove screen evidence."));
  }
}

async function resetProviderCircuitRoute(provider, req, res) {
  try {
    const body = await readJson(req);
    const normalized = normalizeAnalystName(provider);
    const before = analystCircuitState(normalized);
    resetAnalystCircuit(normalized);
    providerPreflightCache = null;
    const after = analystCircuitState(normalized);

    if (body.jobId) {
      const job = getJob(Number(body.jobId));
      if (!job) {
        throw httpError(404, "Job not found.");
      }
      recordJobEvent(job.id, "analyst.circuit_reset", `${displayName(normalized)} circuit breaker reset by operator.`, {
        provider: normalized,
        before,
        after,
        manual: true,
        retry: "manual"
      });
    }

    return sendJson(res, 200, {
      provider: normalized,
      reset: true,
      before,
      after,
      retry: {
        eligible: true,
        mode: "manual",
        duplicateExecution: false
      }
    });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not reset provider circuit."));
  }
}

async function codexAskRoute(id, req, res) {
  try {
    const body = await readJson(req);
    const output = await runCodexAsk({
      jobId: id,
      prompt: body.prompt,
      bin: body.bin,
      timeoutMs: body.timeoutMs
    });
    rememberJobEvent(output.job, output.job.status === "done" ? "completed" : "reviewed");
    return sendJson(res, output.job.status === "failed" ? 503 : 200, responseForCommandOutput(output));
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not run Codex ask." });
  }
}

async function codexImplementRoute(id, req, res) {
  try {
    const body = await readJson(req);
    const output = await runCodexImplement({
      jobId: id,
      prompt: body.prompt,
      confirmed: body.confirmed === true,
      bin: body.bin,
      timeoutMs: body.timeoutMs || config.codexTimeoutMs,
      testCommand: body.testCommand
    });
    rememberJobEvent(output.job, output.job.status === "done" ? "completed" : "reviewed");
    return sendJson(res, output.job.status === "failed" ? 503 : 200, responseForCommandOutput(output));
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not run Codex implement." });
  }
}

async function analystPreviewRoute(id, req, res) {
  try {
    const job = getJob(id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    const body = await readJson(req);
    return sendJson(res, 200, { brief: buildEvidenceBrief(job, body.context || {}) });
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not build analyst preview." });
  }
}

async function analystsRunRoute(id, req, res) {
  try {
    const body = await readJson(req);
    const budget = normalizeAnalystBudget(body.budget || {}, { synthesize: body.synthesize === true });
    const output = await runAnalysts({
      jobId: id,
      context: body.context || {},
      consent: body.consent || {},
      bins: body.bins || {},
      timeoutMs: body.timeoutMs,
      debateRounds: budget.maxRounds,
      progressiveDebate: budget.progressive === true
    });
    providerPreflightCache = null;
    if (body.synthesize === true && output.job.status === "done") {
      output.debate = synthesizeDebate({
        jobId: id,
        requested: true,
        budget: output.debateBudget || budget
      });
      output.job = output.debate.job;
      output.artifacts = output.debate.artifacts;
      output.events = output.debate.events;
      rememberDecision(output.job, output.debate.synthesis);
    }
    rememberJobEvent(output.job, output.job.status === "done" ? "completed" : "reviewed");
    return sendJson(res, output.job.status === "failed" ? 503 : 200, responseForCommandOutput(output));
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not run analysts." });
  }
}

function normalizeAnalystBudget(budget = {}, { synthesize = false } = {}) {
  const requestedRounds = Math.max(1, Math.min(Number.parseInt(budget.maxRounds, 10) || 1, 3));
  const explicitMultiRound = budget.explicitMultiRound === true || budget.operatorRequested === true;
  const progressive = synthesize && requestedRounds > 1 && explicitMultiRound !== true;
  const maxRounds = synthesize ? requestedRounds : 1;
  return {
    ...budget,
    maxRounds,
    requestedMaxRounds: requestedRounds,
    progressive,
    explicitMultiRound,
    cappedByProgressivePolicy: false
  };
}

function responseForCommandOutput(output) {
  if (output?.job?.status !== "failed") {
    return output;
  }
  return {
    ...output,
    error: output.job.error || output.job.summary || "Command execution failed."
  };
}

async function debateSynthesizeRoute(id, req, res) {
  try {
    const body = await readJson(req);
    const output = synthesizeDebate({
      jobId: id,
      requested: body.requested === true,
      budget: body.budget || {}
    });
    rememberDecision(output.job, output.synthesis);
    rememberJobEvent(output.job, "reviewed");
    return sendJson(res, 200, output);
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not synthesize debate." });
  }
}

function resolveWorkspace(workspace = ROOT_DIR) {
  const resolved = path.resolve(String(workspace || ROOT_DIR));
  let stat;

  try {
    stat = fs.statSync(resolved);
  } catch {
    throw httpError(400, `Workspace does not exist: ${resolved}`);
  }

  if (!stat.isDirectory()) {
    throw httpError(400, `Workspace is not a directory: ${resolved}`);
  }

  return resolved;
}

function normalizeJobMode(mode) {
  const normalized = String(mode || "ask");
  if (!JOB_API_MODES.has(normalized)) {
    throw httpError(400, `Invalid job mode: ${normalized}. Use ask, analyze, or implement.`);
  }
  return normalized;
}

function timeoutForJobMode(mode) {
  return mode === "implement" ? config.codexTimeoutMs : config.jobTimeoutMs;
}

function normalizeJobPolicyLevel(policyLevel) {
  try {
    return normalizePolicyLevel(policyLevel || "read");
  } catch {
    throw httpError(400, `Invalid job policy level: ${policyLevel}. Use ${POLICY_LEVELS.join(", ")}.`);
  }
}

function defaultPolicyLevelForMode(mode) {
  return mode === "implement" ? "write" : "read";
}

function policyLevelForJobMode(mode, policyLevel) {
  if (mode === "implement" && policyLevel === "read") {
    return "write";
  }
  return policyLevel;
}

function matchJobRoute(pathname) {
  const match = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(events|cancel|skip|approve|pause|revise|codex\/ask|codex\/implement|analysts\/preview|analysts\/run|debate\/synthesize|screen-evidence))?$/);
  if (!match) {
    return null;
  }
  return {
    id: Number(match[1]),
    action: match[2] || null
  };
}

function matchJobArtifactRoute(pathname) {
  const match = pathname.match(/^\/api\/jobs\/(\d+)\/artifacts\/(\d+)$/);
  if (!match) {
    return null;
  }
  return {
    jobId: Number(match[1]),
    artifactId: Number(match[2])
  };
}

function matchMemoryRoute(pathname) {
  const match = pathname.match(/^\/api\/memories\/(\d+)$/);
  return match ? { id: Number(match[1]) } : null;
}

function matchProviderCircuitRoute(pathname) {
  const match = pathname.match(/^\/api\/providers\/([a-z0-9_-]+)\/circuit\/reset$/i);
  return match ? { provider: match[1] } : null;
}

function normalizeAnalystName(name) {
  const normalized = String(name || "").toLowerCase();
  if (!["gemini", "grok", "openrouter"].includes(normalized)) {
    throw httpError(400, "Circuit reset is available for gemini, grok or openrouter.");
  }
  return normalized;
}

function displayName(name) {
  const labels = {
    gemini: "Gemini",
    grok: "Grok",
    openrouter: "OpenRouter"
  };
  return labels[name] || name;
}

function matchTaskDevelopRoute(pathname) {
  const match = pathname.match(/^\/api\/tasks\/(\d+)\/develop$/);
  return match ? { id: Number(match[1]) } : null;
}

function limitFromQuery(url, fallback) {
  const value = Number.parseInt(url.searchParams.get("limit") || "", 10);
  if (!Number.isFinite(value) || value <= 0) {
    return fallback;
  }
  return Math.min(value, 200);
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function statusForJobError(error) {
  if (error.statusCode) {
    return error.statusCode;
  }

  if (error.code === "WORKSPACE_LOCKED") {
    return 409;
  }

  return 400;
}

function bodyForJobError(error, fallback) {
  const body = { error: error.message || fallback };
  if (error.code === "WORKSPACE_LOCKED" && error.lockedBy) {
    body.lockedBy = {
      id: error.lockedBy.id,
      goal: error.lockedBy.goal,
      workspace: error.lockedBy.workspace,
      status: error.lockedBy.status,
      policyLevel: error.lockedBy.policyLevel
    };
  }
  return body;
}

function buildNowSnapshot() {
  const jobs = listJobs(20);
  const tasks = listTasks(false);
  const activeJob = preferredNowJob(jobs);
  const decision = activeJob ? latestDebateSynthesisForJob(activeJob.id) : latestDebateSynthesisAcross(jobs);
  const realtime = voiceStatus();
  const blockers = nowBlockers(activeJob, decision);
  const cta = ctaForJob(activeJob);
  const presence = nowPresence(activeJob, tasks, blockers);
  const nextStep = activeJob
    ? nextStepForJob(activeJob, decision)
    : tasks.length
      ? `Escolha uma das ${tasks.length} tarefas abertas e defina Codex, Conselho ou Codex + Conselho.`
      : "Diga ou escreva uma missao para AURA organizar o trabalho.";

  return {
    generatedAt: new Date().toISOString(),
    state: presence.state,
    source: presence.source,
    confidence: presence.confidence,
    severity: presence.severity,
    actionId: cta.actionId,
    headline: activeJob ? `Demanda #${activeJob.id}: ${labelForJobStatus(activeJob.status)}` : "Nenhuma demanda ativa",
    nextStep,
    blockers,
    cta,
    realtime: {
      enabled: realtime.enabled,
      provider: realtime.provider,
      model: realtime.model,
      voice: realtime.voice,
      label: realtime.enabled ? "Voz realtime pronta" : "Voz local em fallback",
      detail: realtime.enabled ? `${realtime.model} · voz ${realtime.voice}` : (realtime.fallbackReason || "Configure a chave do provider para conversa ao vivo.")
    },
    activeJob: activeJob ? summarizeJob(activeJob) : null,
    jobRef: activeJob ? nowJobReference(activeJob) : null,
    demandRef: activeJob ? nowJobReference(activeJob) : null,
    councilDecision: decision ? summarizeDebateSynthesis(decision) : null,
    sessionMemory: sessionMemorySummary(),
    persistentMemory: persistentMemorySummary(),
    counts: {
      openTasks: tasks.length,
      waitingJobs: jobs.filter((job) => ["draft", "awaiting_confirm", "needs_input"].includes(job.status)).length,
      runningJobs: jobs.filter((job) => ["queued", "running"].includes(job.status)).length,
      doneJobs: jobs.filter((job) => job.status === "done").length
    }
  };
}

function nowPresence(job, tasks, blockers) {
  if (!job) {
    return {
      state: "idle",
      source: tasks.length ? "tasks" : "operator",
      confidence: "high",
      severity: blockers.length ? "notice" : "info"
    };
  }

  const state = nowStateForJob(job.status);
  return {
    state,
    source: "job",
    confidence: job.status === "running" || job.status === "queued" ? "medium" : "high",
    severity: nowSeverityForState(state)
  };
}

function nowStateForJob(status) {
  const states = {
    draft: "blocked",
    awaiting_confirm: "blocked",
    queued: "running",
    running: "running",
    needs_input: "blocked",
    done: "completed",
    failed: "failed",
    cancelled: "cancelled"
  };
  return states[status] || "idle";
}

function nowSeverityForState(state) {
  const severities = {
    idle: "info",
    running: "active",
    blocked: "warning",
    completed: "success",
    failed: "critical",
    cancelled: "muted"
  };
  return severities[state] || "info";
}

function nowJobReference(job) {
  return {
    id: job.id,
    status: job.status,
    mode: job.mode,
    workspace: job.workspace,
    updatedAt: job.updatedAt
  };
}

function preferredNowJob(jobs) {
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
  return jobs[0] || null;
}

function latestDebateSynthesisAcross(jobs) {
  for (const job of jobs) {
    const synthesis = latestDebateSynthesisForJob(job.id);
    if (synthesis) {
      return synthesis;
    }
  }
  return null;
}

function latestDebateSynthesisForJob(jobId) {
  const artifact = [...listJobArtifacts(jobId)].reverse().find((item) => item.kind === "debate-synthesis");
  if (!artifact) {
    return null;
  }
  try {
    return JSON.parse(artifact.content);
  } catch {
    return null;
  }
}

function summarizeDebateSynthesis(synthesis) {
  return {
    recommendation: synthesis.recommendation || "Conselho sem recomendacao textual.",
    confidence: synthesis.confidence || "low",
    consensusCount: Array.isArray(synthesis.consensus) ? synthesis.consensus.length : 0,
    dissentCount: Array.isArray(synthesis.dissent) ? synthesis.dissent.length : 0,
    riskCount: Array.isArray(synthesis.risks) ? synthesis.risks.length : 0,
    unverifiedCount: Array.isArray(synthesis.unverified) ? synthesis.unverified.length : 0,
    roundsUsed: synthesis.budget?.roundsUsed || 1
  };
}

function summarizeJob(job) {
  return {
    id: job.id,
    goal: job.goal,
    mode: job.mode,
    status: job.status,
    policyLevel: job.policyLevel,
    summary: job.summary,
    error: job.error,
    updatedAt: job.updatedAt
  };
}

function nowBlockers(job, decision) {
  const blockers = [];
  if (!voiceStatus().enabled) {
    blockers.push("Voz realtime ainda esta em fallback local.");
  }
  if (job?.status === "needs_input") {
    blockers.push(job.error || job.summary || "AURA precisa de uma decisao do operador.");
  }
  if (job?.status === "failed") {
    blockers.push(job.error || "A ultima demanda falhou e precisa de revisao.");
  }
  const risks = Array.isArray(decision?.risks) ? decision.risks : [];
  blockers.push(...risks.slice(0, 2).map((risk) => risk.text || String(risk)));
  return blockers.slice(0, 4);
}

function nextStepForJob(job, decision = null) {
  if (!job) {
    return "Diga ou escreva uma missao para AURA organizar o trabalho.";
  }
  if (job.status === "done" && decision?.recommendation) {
    return "Revisar a Decisao do Conselho e criar uma implementacao confirmavel se fizer sentido.";
  }
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

function ctaForJob(job) {
  if (!job) {
    return { actionId: "compose.new_mission", kind: "compose", label: "Criar missao", enabled: true };
  }
  const ctas = {
    draft: { actionId: "job.approve_draft", kind: "approve", label: "Aprovar draft", enabled: true },
    awaiting_confirm: { actionId: "job.confirm_execution", kind: "confirm", label: "Confirmar execucao", enabled: true },
    queued: { actionId: "job.cancel", kind: "cancel", label: "Cancelar", enabled: true },
    running: { actionId: "job.cancel", kind: "cancel", label: "Cancelar", enabled: true },
    needs_input: { actionId: "job.recover", kind: "recover", label: "Retomar ou ignorar", enabled: true },
    done: { actionId: "job.review_result", kind: "review", label: "Ver resultado", enabled: true },
    failed: { actionId: "job.review_failure", kind: "review", label: "Revisar falha", enabled: true },
    cancelled: { actionId: "job.none", kind: "none", label: "Nada pendente", enabled: false }
  };
  return ctas[job.status] || { actionId: "job.review", kind: "review", label: "Ver demanda", enabled: true };
}

function labelForJobStatus(status) {
  const labels = {
    draft: "draft",
    awaiting_confirm: "aguardando confirmacao",
    queued: "na fila",
    running: "em execucao",
    needs_input: "aguardando voce",
    done: "concluida",
    failed: "falhou",
    cancelled: "cancelada"
  };
  return labels[status] || status;
}

function localChat(body) {
  const text = String(body.text || "").trim();
  const lower = text.toLowerCase();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const activeJob = normalizeActiveJob(body.activeJob);

  if (!text) {
    return { reply: "Diga o que voce quer fazer." };
  }

  rememberPreference(text, body.requestedBy || "text");

  const developmentIntent = parseTaskDevelopmentIntent(text);
  if (developmentIntent) {
    return createDevelopmentJobFromTask(developmentIntent.taskId, {
      requestedBy: "text",
      source: "local-chat",
      executor: developmentIntent.executor,
      extraGoal: developmentIntent.extraGoal
    });
  }

  const taskIntent = parseTaskIntent(text, activeJob);
  if (taskIntent) {
    const task = addTask({ title: taskIntent.title });
    return { reply: taskIntent.reply, task };
  }

  if (lower.startsWith("lembrar ") || lower.startsWith("guardar ")) {
    const content = text.replace(/^(lembrar|guardar)\s+/i, "");
    const memory = addMemory({ kind: memoryKindFromText(content), content });
    return { reply: "Memoria guardada localmente.", memory };
  }

  const voiceIntent = handleVoiceIntent(text);
  if (voiceIntent) {
    if (voiceIntent.job) {
      rememberJobEvent(voiceIntent.job, "voice");
    }
    return voiceIntent;
  }

  if (/\b(?:agora|andamento|pendente|pendencias|pendências|o que estamos fazendo|o que esta acontecendo|o que está acontecendo|em aberto|fila)\b/i.test(text)) {
    return localWorkContinuity();
  }

  if (lower.includes("rotina") || lower.includes("bom dia")) {
    const tasks = listTasks(false);
    const openList = tasks.length ? tasks.map((task) => `- ${task.title}`).join("\n") : "Nenhuma tarefa aberta.";
    return { reply: `Resumo local: ${openList}` };
  }

  if (attachments.length) {
    const summary = attachments.map((attachment) => `${attachment.kind || "anexo"} ${attachment.name}`).join(", ");
    return {
      reply: `Recebi os anexos: ${summary}. Em modo local eu guardo o contexto da conversa; para analise visual completa, use a voz ao vivo ou transforme isso em demanda.`
    };
  }

  return {
    reply: "Estou em modo local. Posso guardar memorias com \"guardar ...\", criar tasks com \"crie uma task para a plataforma ...\", desenvolver uma task com \"desenvolva a task 4\", criar demandas com \"criar demanda ...\", consultar com \"status da demanda 1\" e cancelar com \"cancelar demanda 1\"."
  };
}

function localWorkContinuity() {
  const now = buildNowSnapshot();
  const session = sessionMemorySummary();
  const persistent = persistentMemorySummary();
  const jobs = listJobs(8);
  const active = jobs.filter((job) => ["draft", "awaiting_confirm", "queued", "running", "needs_input"].includes(job.status));
  const sessionLines = [...sessionSummaryLines(session), ...persistentMemoryLines(persistent)];
  if (!active.length) {
    const latest = jobs[0];
    return {
      reply: latest
        ? [`Agora: ${now.nextStep}`, ...sessionLines, `Ultima demanda: ${latest.id}, ${latest.status}, ${latest.summary || latest.goal}`].join("\n")
        : [`Agora: ${now.nextStep}`, ...sessionLines].join("\n"),
      now,
      sessionMemory: session,
      persistentMemory: persistent,
      jobs
    };
  }

  return {
    reply: [
      `Agora: ${now.nextStep}`,
      ...sessionLines,
      `Temos ${active.length} demanda(s) em aberto:`,
      ...active.map((job) => `- ${job.id}: ${job.status}, ${job.mode}. ${job.summary || job.goal}`)
    ].join("\n"),
    now,
    sessionMemory: session,
    persistentMemory: persistent,
    jobs: active
  };
}

async function updateMemoryRoute(id, req, res) {
  try {
    const updated = updateMemory(id, await readJson(req));
    return sendJson(res, 200, { memory: updated, persistentMemory: persistentMemorySummary() });
  } catch (error) {
    return sendJson(res, statusForJobError(error), bodyForJobError(error, "Could not update memory."));
  }
}

function sessionSummaryLines(session) {
  const lines = [];
  if (session.lastDecision?.recommendation) {
    lines.push(`Ultima decisao: ${session.lastDecision.recommendation}`);
  }
  if (session.recentPreference?.text) {
    lines.push(`Preferencia recente: ${session.recentPreference.text}`);
  }
  if (session.nextAction) {
    lines.push(`Memoria da sessao: ${session.nextAction}`);
  }
  return lines.slice(0, 3);
}

function persistentMemoryLines(memory) {
  const lines = [];
  if (memory.preferences?.[0]?.content) {
    lines.push(`Preferencia confirmada: ${memory.preferences[0].content}`);
  }
  if (memory.projects?.[0]?.content) {
    lines.push(`Contexto de projeto: ${memory.projects[0].content}`);
  }
  if (memory.decisions?.[0]?.content) {
    lines.push(`Decisao persistente: ${memory.decisions[0].content}`);
  }
  return lines.slice(0, 3);
}

function memoryKindFromText(text) {
  const normalized = normalizeText(text);
  if (/\b(?:prefiro|preferencia|preferência|gosto|quero manter|priorize)\b/.test(normalized)) {
    return "preference";
  }
  if (/\b(?:projeto|repo|repositorio|workspace|pasta)\b/.test(normalized)) {
    return "project";
  }
  if (/\b(?:decisao|decisão|decidimos|recomendacao|recomendação)\b/.test(normalized)) {
    return "decision";
  }
  return "note";
}

function parseTaskDevelopmentIntent(text) {
  const original = String(text || "").trim();
  const normalized = normalizeText(original);
  if (!/\b(?:desenvolver|desenvolva|implementar|implemente|executar|execute|acionar|acione)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(?:task|tasks|tarefa|tarefas)\b/.test(normalized)) {
    return null;
  }

  const taskMatch = normalized.match(/\b(?:task|tarefa)\s+#?(\d+)\b/);
  if (!taskMatch) {
    return null;
  }

  const extra = original
    .replace(/^.*?\b(?:task|tarefa)\s+#?\d+\b\s*/i, "")
    .replace(/^(?:para|com|e)\s+/i, "")
    .trim();

  return {
    taskId: Number(taskMatch[1]),
    executor: executorFromText(normalized),
    extraGoal: extra
  };
}

function executorFromText(normalized) {
  const wantsCouncil = /\b(?:conselho|gemini|grok|openrouter|openroute|analise|analista|analistas)\b/.test(normalized);
  const wantsCodex = /\b(?:codex|desenvolver|desenvolva|implementar|implemente|executar|execute)\b/.test(normalized);
  if (wantsCouncil && wantsCodex) {
    return "codex-council";
  }
  if (wantsCouncil) {
    return "council";
  }
  return "codex";
}

function parseTaskIntent(text, activeJob) {
  const original = String(text || "").trim();
  const normalized = normalizeText(original);
  if (!/\b(?:task|tasks|tarefa|tarefas)\b/.test(normalized)) {
    return null;
  }
  if (!/\b(?:criar|crie|registrar|registre|adicionar|adicione|nova|novo)\b/.test(normalized) && !/^(?:task|tarefa)\s+/i.test(original)) {
    return null;
  }

  let title = original
    .replace(/^(?:aura,?\s*)?(?:criar|crie|registrar|registre|adicionar|adicione)\s+(?:uma\s+|um\s+|a\s+|o\s+)?(?:task|tarefa)\s*/i, "")
    .replace(/^(?:nova|novo)\s+(?:task|tarefa)\s*/i, "")
    .replace(/^(?:task|tarefa)\s*/i, "")
    .replace(/^(?:para|da|do|de)\s+/i, "")
    .trim();

  const colon = title.indexOf(":");
  if (colon >= 0 && colon < title.length - 1) {
    title = title.slice(colon + 1).trim();
  }

  const scope = scopeForTask(normalized, activeJob);
  title = title
    .replace(/^(?:a\s+|o\s+)?(?:plataforma|cockpit|aura|projeto)\s*/i, "")
    .replace(/^(?:essa|esta|a|da|do)?\s*demanda(?:\s+atual)?\s*/i, "")
    .trim();

  if (!title) {
    title = scope.type === "platform" ? "Definir proximo passo de evolucao da plataforma" : "Definir proximo passo da demanda";
  }

  const scopedTitle = scope.prefix ? `${scope.prefix} ${title}` : title;
  return {
    title: scopedTitle,
    reply: scope.type === "platform"
      ? "Task criada no cockpit para evolucao da plataforma."
      : scope.type === "demand"
        ? "Task criada no cockpit para evolucao da demanda."
        : "Task criada no cockpit."
  };
}

function scopeForTask(normalized, activeJob) {
  const explicitDemand = normalized.match(/\bdemanda\s+(\d+)\b/);
  if (explicitDemand) {
    return { type: "demand", prefix: `[Demanda #${Number(explicitDemand[1])}]` };
  }
  if (/\b(?:essa|esta|a|da)\s+demanda\b|\bdemanda\s+atual\b/.test(normalized) && activeJob?.id) {
    return { type: "demand", prefix: `[Demanda #${activeJob.id}]` };
  }
  if (/\b(?:plataforma|cockpit|aura|projeto)\b/.test(normalized)) {
    return { type: "platform", prefix: "[Plataforma]" };
  }
  return { type: "general", prefix: "" };
}

function normalizeActiveJob(job) {
  if (!job || typeof job !== "object") {
    return null;
  }
  const id = Number(job.id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }
  return {
    id,
    goal: String(job.goal || ""),
    mode: String(job.mode || ""),
    status: String(job.status || "")
  };
}

function normalizeText(text) {
  return String(text || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function createDevelopmentJobFromTask(taskId, options = {}) {
  const task = getTask(taskId);
  if (!task) {
    throw httpError(404, "Task not found.");
  }
  if (task.status === "done") {
    throw httpError(400, "Task already completed.");
  }

  const executor = normalizeTaskExecutor(options.executor || "codex");
  const mode = executor === "council" ? "analyze" : "implement";
  const policyLevel = mode === "implement" ? "write" : "read";
  const policy = evaluateJobPolicy(policyLevel);
  const extraGoal = String(options.extraGoal || "").trim();
  const goal = [
    `${mode === "implement" ? "Desenvolver" : "Analisar desenvolvimento da"} task #${task.id}: ${task.title}`,
    extraGoal ? `Detalhe adicional: ${extraGoal}` : ""
  ].filter(Boolean).join("\n\n");

  const job = createJob({
    goal,
    workspace: resolveWorkspace(options.workspace),
    mode,
    requestedBy: options.requestedBy || "text",
    policyLevel,
    requiresConfirmation: policy.requiresConfirmation,
    timeoutMs: options.timeoutMs || timeoutForJobMode(mode),
    metadata: {
      source: options.source || "task-development",
      executor,
      task: {
        id: task.id,
        title: task.title
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

  rememberJobEvent(finalJob, "task_development");
  return {
    reply: replyForTaskDevelopment(finalJob, task, executor),
    task,
    job: finalJob,
    events: listJobEvents(finalJob.id),
    policy
  };
}

function normalizeTaskExecutor(value) {
  const executor = String(value || "codex").toLowerCase().trim();
  if (TASK_EXECUTORS.has(executor)) {
    return executor;
  }
  throw httpError(400, `Invalid task executor: ${executor}. Use codex, council, or codex-council.`);
}

function replyForTaskDevelopment(job, task, executor) {
  if (executor === "council") {
    return `Demanda ${job.id} criada para o Conselho analisar a task ${task.id}.`;
  }
  if (executor === "codex-council") {
    return `Demanda ${job.id} criada para Codex desenvolver a task ${task.id}, com Conselho disponivel para revisao. Revise a confirmacao visual antes de executar.`;
  }
  return `Demanda ${job.id} criada para Codex desenvolver a task ${task.id}. Revise a confirmacao visual antes de executar.`;
}

async function createRealtimeToken(res) {
  if (!config.openaiApiKey) {
    return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured.", fallback: true });
  }

  const payload = JSON.stringify(realtimeClientSecretPayload());

  try {
    const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openaiApiKey}`,
        "Content-Type": "application/json",
        "OpenAI-Safety-Identifier": "local-aura-user"
      },
      body: payload
    });

    return sendRawOpenAiResponse(res, {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: await response.text()
    });
  } catch (error) {
    if (!isNetworkFetchError(error)) {
      throw error;
    }
  }

  try {
    const response = await createRealtimeTokenWithCurl(payload);
    return sendRawOpenAiResponse(res, response, { transport: "curl-fallback" });
  } catch (error) {
    return sendJson(res, 502, {
      error: "Could not create Realtime session.",
      details: redactText(error.message || "OpenAI network request failed.")
    });
  }
}

async function createRealtimeCallRoute(req, res) {
  if (!config.openaiApiKey) {
    return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured.", fallback: true });
  }

  const body = await readJson(req);
  const sdp = String(body.sdp || "").trim();
  if (!sdp.startsWith("v=0")) {
    return sendJson(res, 400, { error: "Invalid SDP offer." });
  }

  try {
    const response = await createRealtimeCallWithCurl(sdp);
    return sendRawOpenAiResponse(res, response, { transport: "curl-fallback" });
  } catch (error) {
    return sendJson(res, 502, {
      error: "Could not create Realtime call.",
      details: redactText(error.message || "OpenAI Realtime call failed.")
    });
  }
}

function sendRawOpenAiResponse(res, response, options = {}) {
  const headers = {
    "Content-Type": response.contentType || "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  };
  if (options.transport) {
    headers["X-AURA-Realtime-Transport"] = options.transport;
  }
  res.writeHead(response.status, headers);
  res.end(response.body);
}

function isNetworkFetchError(error) {
  const code = error?.cause?.code || error?.code;
  return error?.message === "fetch failed" || code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ENETUNREACH";
}

function createRealtimeTokenWithCurl(payload) {
  const curlBin = process.env.AURA_CURL_BIN || "curl";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-realtime-"));
  const payloadPath = path.join(tempDir, "payload.json");
  fs.writeFileSync(payloadPath, payload, { mode: 0o600 });

  const curlConfig = [
    'url = "https://api.openai.com/v1/realtime/client_secrets"',
    'request = "POST"',
    "http1.1",
    "silent",
    "show-error",
    `header = "Authorization: Bearer ${escapeCurlConfigValue(config.openaiApiKey)}"`,
    'header = "Content-Type: application/json"',
    'header = "OpenAI-Safety-Identifier: local-aura-user"',
    `data-binary = "@${escapeCurlConfigValue(payloadPath)}"`,
    'write-out = "\\n__AURA_STATUS__:%{http_code}\\n__AURA_CONTENT_TYPE__:%{content_type}\\n"'
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(curlBin, ["--config", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      cleanupTempFile(tempDir, payloadPath);
      reject(error);
    });
    child.on("close", (code) => {
      cleanupTempFile(tempDir, payloadPath);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }
      try {
        resolve(parseCurlOpenAiResponse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(curlConfig);
  });
}

function createRealtimeCallWithCurl(sdp) {
  const session = JSON.stringify(realtimeCallSessionPayload());
  const curlBin = process.env.AURA_CURL_BIN || "curl";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "aura-realtime-call-"));
  const sdpPath = path.join(tempDir, "offer.sdp");
  const sessionPath = path.join(tempDir, "session.json");
  fs.writeFileSync(sdpPath, sdp, { mode: 0o600 });
  fs.writeFileSync(sessionPath, session, { mode: 0o600 });

  const curlConfig = [
    'url = "https://api.openai.com/v1/realtime/calls"',
    'request = "POST"',
    "http1.1",
    "silent",
    "show-error",
    `header = "Authorization: Bearer ${escapeCurlConfigValue(config.openaiApiKey)}"`,
    `form = "sdp=<${escapeCurlConfigValue(sdpPath)};type=application/sdp"`,
    `form = "session=<${escapeCurlConfigValue(sessionPath)};type=application/json"`,
    'write-out = "\\n__AURA_STATUS__:%{http_code}\\n__AURA_CONTENT_TYPE__:%{content_type}\\n"'
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(curlBin, ["--config", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      cleanupTempFiles(tempDir, [sdpPath, sessionPath]);
      reject(error);
    });
    child.on("close", (code) => {
      cleanupTempFiles(tempDir, [sdpPath, sessionPath]);
      if (code !== 0) {
        reject(new Error(stderr.trim() || `curl exited with code ${code}`));
        return;
      }
      try {
        resolve(parseCurlOpenAiResponse(stdout));
      } catch (error) {
        reject(error);
      }
    });
    child.stdin.end(curlConfig);
  });
}

function parseCurlOpenAiResponse(output) {
  const match = output.match(/([\s\S]*?)\n__AURA_STATUS__:(\d{3})\n__AURA_CONTENT_TYPE__:(.*)\n?$/);
  if (!match) {
    throw new Error("Could not parse curl Realtime response.");
  }
  return {
    body: match[1],
    status: Number(match[2]),
    contentType: match[3].trim() || "application/json; charset=utf-8"
  };
}

function cleanupTempFile(tempDir, payloadPath) {
  cleanupTempFiles(tempDir, [payloadPath]);
}

function cleanupTempFiles(tempDir, filePaths) {
  try {
    for (const filePath of filePaths) {
      fs.rmSync(filePath, { force: true });
    }
    fs.rmdirSync(tempDir);
  } catch {
    // Best-effort cleanup for the local fallback payload.
  }
}

function escapeCurlConfigValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function realtimeClientSecretPayload() {
  const { type, model, audio } = realtimeSessionPayload().session;
  return {
    session: {
      type,
      model,
      audio
    }
  };
}

function realtimeCallSessionPayload() {
  const { type, model, audio } = realtimeSessionPayload().session;
  return {
    type,
    model,
    audio
  };
}

function realtimeSessionPayload() {
  return {
    session: {
      type: "realtime",
      model: config.realtimeModel,
      instructions: `${systemPrompt}\n\nVoz e idioma:\n- Fale sempre em portugues brasileiro natural.\n- Use ritmo calmo, frases curtas e tom de assistente pessoal proximo.\n- Evite sotaque estrangeiro, traducoes literais e palavras em ingles quando houver equivalente comum em portugues.\n\nProtocolo de ativacao por voz:\n- A sessao começa em standby silencioso. Nao cumprimente e nao inicie conversa ao conectar.\n- Em standby, responda somente quando a fala do usuario contiver claramente o nome Aura.\n- Quando ouvir Aura junto de um pedido, considere a conversa ativa e responda ao pedido.\n- Enquanto a conversa estiver ativa, continue respondendo normalmente ate o usuario encerrar.\n- Se o usuario disser algo como ate logo Aura, obrigado Aura, pode descansar Aura ou tchau Aura, responda brevemente e volte para standby.\n- Depois de voltar ao standby, ignore falas sem Aura. Nao gere texto, audio nem chamadas de ferramenta para falas sem wake word.\n\nFerramentas por voz:\n- Se precisar criar uma task no cockpit, use aura_create_task e depois confirme em voz curta.\n- Se o usuario pedir para desenvolver uma task existente, use aura_develop_task. Se nao disser executor, assuma Codex.\n- Se citar Conselho, Gemini, Grok ou OpenRouter, use executor council para analise ou codex-council quando tambem pedir Codex.\n- Se o usuario pedir desenvolvimento sem citar task, use aura_create_development_demand.\n- Se o usuario pedir para ver pastas, projetos, arquivos locais ou o que existe no workspace, use aura_list_local_folder. A ferramenta e somente leitura e limitada as raizes permitidas.\n- Se o usuario perguntar o que esta em andamento no Codex, use aura_codex_activity.\n- Demandas de desenvolvimento sempre ficam visiveis no cockpit e exigem confirmacao visual antes do Codex escrever.`,
      audio: {
        input: {
          noise_reduction: {
            type: "near_field"
          },
          transcription: {
            model: "gpt-transcribe",
            language: "pt"
          },
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
            interrupt_response: true
          }
        },
        output: {
          voice: config.realtimeVoice
        }
      },
      tools: [
        {
          type: "function",
          name: "aura_create_task",
          description: "Cria uma task segura no cockpit local do AURA para evolucao de demanda ou da propria plataforma.",
          parameters: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "Titulo curto e acionavel da task em portugues."
              },
              scope: {
                type: "string",
                enum: ["demanda", "plataforma", "geral"],
                description: "Use demanda para a demanda atual, plataforma para evolucao do cockpit/AURA, ou geral quando nao houver escopo claro."
              },
              demandId: {
                type: "integer",
                description: "Id da demanda quando o usuario citar uma demanda especifica."
              }
            },
            required: ["title"]
          }
        },
        {
          type: "function",
          name: "aura_develop_task",
          description: "Transforma uma task existente em demanda de desenvolvimento com Codex, aguardando confirmacao visual.",
          parameters: {
            type: "object",
            properties: {
              taskId: {
                type: "integer",
                description: "Id da task que deve virar demanda de desenvolvimento."
              },
              extraGoal: {
                type: "string",
                description: "Detalhe adicional opcional do que desenvolver."
              },
              executor: {
                type: "string",
                enum: ["codex", "council", "codex-council"],
                description: "Quem deve conduzir o fluxo: Codex, Conselho, ou Codex com Conselho para revisao."
              }
            },
            required: ["taskId"]
          }
        },
        {
          type: "function",
          name: "aura_create_development_demand",
          description: "Cria uma demanda de desenvolvimento livre com Codex, aguardando confirmacao visual.",
          parameters: {
            type: "object",
            properties: {
              goal: {
                type: "string",
                description: "Objetivo de desenvolvimento em portugues."
              },
              executor: {
                type: "string",
                enum: ["codex", "council", "codex-council"],
                description: "Quem deve conduzir a demanda livre."
              }
            },
            required: ["goal"]
          }
        },
        {
          type: "function",
          name: "aura_list_local_folder",
          description: "Lista, em modo somente leitura, pastas e arquivos dentro das raizes locais permitidas do cockpit.",
          parameters: {
            type: "object",
            properties: {
              root_id: {
                type: "integer",
                description: "Indice da raiz permitida. Use 0 quando o usuario nao especificar."
              },
              path: {
                type: "string",
                description: "Caminho relativo dentro da raiz permitida. Use ponto para a raiz."
              }
            }
          }
        },
        {
          type: "function",
          name: "aura_codex_activity",
          description: "Consulta demandas em andamento ou recentes no Codex dentro do cockpit AURA.",
          parameters: {
            type: "object",
            properties: {}
          }
        }
      ],
      tool_choice: "auto"
    }
  };
}

async function getProviderPreflight() {
  const now = Date.now();
  if (providerPreflightCache && now - providerPreflightCache.createdAt < PROVIDER_PREFLIGHT_TTL_MS) {
    return providerPreflightCache.providers;
  }

  const providers = {
    gemini: {
      name: "gemini",
      label: "Gemini",
      role: "analyst",
      bin: process.env.AURA_GEMINI_BIN || "gemini",
      args: ["--version"]
    },
    grok: {
      name: "grok",
      label: "Grok",
      role: "analyst",
      bin: process.env.AURA_GROK_BIN || "grok",
      args: ["--version"]
    },
    openrouter: {
      name: "openrouter",
      label: "OpenRouter",
      role: "analyst",
      bin: process.env.AURA_OPENROUTER_BIN || "openrouter",
      args: ["--version"]
    },
    codex: {
      name: "codex",
      label: "Codex",
      role: "executor",
      bin: process.env.AURA_CODEX_BIN || "codex",
      args: ["--version"]
    }
  };

  const entries = await Promise.all(Object.entries(providers).map(async ([key, provider]) => {
    const isAnalyst = provider.role === "analyst";
    const circuit = isAnalyst ? analystCircuitState(key) : { open: false };
    if (circuit.open) {
      return [key, {
        name: provider.name,
        label: provider.label,
        role: provider.role,
        status: "circuit_open",
        detected: true,
        available: false,
        usable: false,
        dispatchable: false,
        bin: provider.bin,
        version: null,
        error: circuit.reason,
        note: `Circuit breaker ativo ate ${circuit.retryAt}.`,
        circuit
      }];
    }

    const probe = await runProviderProbe(provider.bin, provider.args, 5000);
    return [key, {
      name: provider.name,
      label: provider.label,
      role: provider.role,
      status: probe.available ? (isAnalyst ? "detected" : "available") : "unavailable",
      detected: probe.available,
      available: probe.available,
      usable: isAnalyst ? null : probe.available,
      dispatchable: isAnalyst ? "health_check_required" : probe.available,
      bin: provider.bin,
      version: probe.version,
      error: probe.error,
      note: probe.available && isAnalyst ? "Verificacao real acontece antes de enviar a demanda." : null,
      circuit
    }];
  }));

  const payload = Object.fromEntries(entries);
  providerPreflightCache = {
    createdAt: now,
    providers: payload
  };
  return payload;
}

function runProviderProbe(command, args, timeoutMs) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      killProcessTree(child);
      finish({
        available: false,
        version: null,
        error: `${command} nao respondeu ao preflight em ${timeoutMs} ms.`
      });
    }, timeoutMs);

    try {
      const env = filteredProviderEnv();
      const prepared = prepareToolSpawn(command, args, env);
      child = spawn(prepared.command, prepared.args, {
        env,
        ...prepared.options,
        windowsHide: true
      });
    } catch (error) {
      finish({
        available: false,
        version: null,
        error: error.code === "ENOENT" ? `${command} nao encontrado no PATH.` : error.message
      });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish({
        available: false,
        version: null,
        error: error.code === "ENOENT" ? `${command} nao encontrado no PATH.` : error.message
      });
    });
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        finish({
          available: true,
          version: stdout.trim() || "unknown",
          error: null
        });
        return;
      }

      finish({
        available: false,
        version: null,
        error: stderr.trim() || stdout.trim() || `${command} retornou codigo ${exitCode}.`
      });
    });
  });
}

function filteredProviderEnv() {
  return filteredToolEnv();
}

async function readJson(req) {
  const raw = await readBody(req);
  if (!raw) {
    return {};
  }
  return JSON.parse(raw);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        req.destroy(new Error("Request body too large."));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(data, null, 2));
}

function serveStatic(requestPath, res) {
  const cleanPath = requestPath === "/" ? "/index.html" : decodeURIComponent(requestPath);
  const filePath = path.normalize(path.join(publicDir, cleanPath));
  const relativePath = path.relative(ROOT_DIR, filePath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).some((part) => part.startsWith(".")) ||
    relativePath.split(path.sep).includes("server") ||
    relativePath.split(path.sep).includes("data") ||
    relativePath.split(path.sep).includes("exports")
  ) {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  fs.readFile(filePath, (error, contents) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(contents);
  });
}
