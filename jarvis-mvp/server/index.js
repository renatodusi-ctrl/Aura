import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, ensureRuntime, ROOT_DIR } from "./config.js";
import {
  getStatus,
  initMemory,
  listMemories,
  addMemory,
  listTasks,
  addTask,
  updateTask,
  deleteTask,
  getTask,
  createJob,
  getJob,
  listJobArtifacts,
  listJobEvents,
  listJobs,
  getCostSummary,
  recordCostUsage,
  updateJobDraft,
  updateJobStatus
} from "./memory.js";
import { getLocalContext, listTools, runTool } from "./tools.js";
import { evaluateJobPolicy, normalizePolicyLevel, POLICY_LEVELS } from "./policy.js";
import { createSessionToken, isAllowedOrigin, isProtectedApiPath, validateSessionRequest } from "./httpSecurity.js";
import { cancelJobProcess } from "./supervisor.js";
import { detectCodex, runCodexAsk, runCodexImplement } from "./codexAdapter.js";
import { buildEvidenceBrief, runAnalysts } from "./analystAdapter.js";
import { synthesizeDebate } from "./debateSynthesizer.js";
import { handleVoiceIntent } from "./voiceIntents.js";
import { redactText } from "./redaction.js";

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
const sessionToken = createSessionToken();
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
  console.log(`AURA cockpit ready at http://${config.host}:${config.port}`);
  console.log(voiceStatus().enabled ? `Realtime voice: ${voiceStatus().provider}` : "Realtime voice: local fallback (voice provider not configured)");
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
    const currentVoiceStatus = voiceStatus();
    return sendJson(res, 200, {
      ok: true,
      realtimeEnabled: currentVoiceStatus.enabled,
      realtimeProvider: currentVoiceStatus.provider,
      realtimeModel: currentVoiceStatus.model,
      realtimeVoice: currentVoiceStatus.voice,
      dailyRoutineHour: config.dailyRoutineHour,
      jobHistoryRetentionDays: config.jobHistoryRetentionDays,
      jobExportDir: config.jobExportDir,
      providers,
      memory: getStatus(),
      tools: listTools()
    });
  }

  if (url.pathname === "/api/context" && method === "GET") {
    return sendJson(res, 200, getLocalContext());
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

  if (jobRoute && method === "POST" && jobRoute.action === "approve") {
    return approveJobRoute(jobRoute.id, res);
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

  if (url.pathname === "/api/memories" && method === "GET") {
    return sendJson(res, 200, { memories: listMemories() });
  }

  if (url.pathname === "/api/memories" && method === "POST") {
    return sendJson(res, 201, { memory: addMemory(await readJson(req)) });
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

function voiceStatus() {
  if (config.voiceProvider === "gemini") {
    return {
      provider: "gemini",
      enabled: Boolean(config.geminiApiKey),
      model: config.geminiLiveModel,
      voice: config.geminiLiveVoice
    };
  }

  return {
    provider: "openai",
    enabled: Boolean(config.openaiApiKey),
    model: config.realtimeModel,
    voice: config.realtimeVoice
  };
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
  return `${systemPrompt}\n\nVoz Gemini Live:\n- Voce e AURA, uma assistente pessoal por voz.\n- Fale sempre em portugues brasileiro natural.\n- Responda com frases curtas e objetivas.\n- A sessao comeca em standby silencioso. Responda somente quando a fala contiver claramente o nome Aura.\n- Se ouvir ate logo Aura, obrigado Aura, pode descansar Aura ou tchau Aura, responda brevemente e volte ao standby.\n- Quando o usuario pedir para criar task ou demanda, use as ferramentas disponiveis.`;
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
  const hasCli = commandAvailable(process.env.AURA_OPENROUTER_BIN || "openrouter", ["-v"]);
  return {
    provider: "OpenRouter",
    envName,
    configured: hasEnvKey || hasCli,
    source: hasEnvKey ? "OpenRouter API" : "OpenRouter CLI",
    label: hasEnvKey ? `${envName} configurada` : hasCli ? "CLI configurado; chave gerenciada pelo OpenRouter CLI" : `${envName} ausente`
  };
}

function commandAvailable(command, args = []) {
  const result = spawnSync(command, args, {
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
      return sendJson(res, 202, { job: getJob(job.id), cancellation: "requested", events: listJobEvents(job.id) });
    }

    const cancelled = updateJobStatus(job.id, "cancelled", {
      summary: "Job cancelled before execution."
    });
    return sendJson(res, 200, { job: cancelled, events: listJobEvents(job.id) });
  } catch (error) {
    return sendJson(res, 409, { error: error.message || "Could not cancel job." });
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
    const output = await runAnalysts({
      jobId: id,
      context: body.context || {},
      consent: body.consent || {},
      bins: body.bins || {},
      timeoutMs: body.timeoutMs
    });
    return sendJson(res, output.job.status === "failed" ? 503 : 200, responseForCommandOutput(output));
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not run analysts." });
  }
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
  const match = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(events|cancel|approve|codex\/ask|codex\/implement|analysts\/preview|analysts\/run|debate\/synthesize))?$/);
  if (!match) {
    return null;
  }
  return {
    id: Number(match[1]),
    action: match[2] || null
  };
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

function localChat(body) {
  const text = String(body.text || "").trim();
  const lower = text.toLowerCase();
  const attachments = Array.isArray(body.attachments) ? body.attachments : [];
  const activeJob = normalizeActiveJob(body.activeJob);

  if (!text) {
    return { reply: "Diga o que voce quer fazer." };
  }

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
    const memory = addMemory({ kind: "note", content });
    return { reply: "Memoria guardada localmente.", memory };
  }

  const voiceIntent = handleVoiceIntent(text);
  if (voiceIntent) {
    return voiceIntent;
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
      instructions: `${systemPrompt}\n\nVoz e idioma:\n- Fale sempre em portugues brasileiro natural.\n- Use ritmo calmo, frases curtas e tom de assistente pessoal proximo.\n- Evite sotaque estrangeiro, traducoes literais e palavras em ingles quando houver equivalente comum em portugues.\n\nProtocolo de ativacao por voz:\n- A sessao começa em standby silencioso. Nao cumprimente e nao inicie conversa ao conectar.\n- Em standby, responda somente quando a fala do usuario contiver claramente o nome Aura.\n- Quando ouvir Aura junto de um pedido, considere a conversa ativa e responda ao pedido.\n- Enquanto a conversa estiver ativa, continue respondendo normalmente ate o usuario encerrar.\n- Se o usuario disser algo como ate logo Aura, obrigado Aura, pode descansar Aura ou tchau Aura, responda brevemente e volte para standby.\n- Depois de voltar ao standby, ignore falas sem Aura. Nao gere texto, audio nem chamadas de ferramenta para falas sem wake word.\n\nFerramentas por voz:\n- Se precisar criar uma task no cockpit, use aura_create_task e depois confirme em voz curta.\n- Se o usuario pedir para desenvolver uma task existente, use aura_develop_task. Se nao disser executor, assuma Codex.\n- Se citar Conselho, Gemini, Grok ou OpenRouter, use executor council para analise ou codex-council quando tambem pedir Codex.\n- Se o usuario pedir desenvolvimento sem citar task, use aura_create_development_demand.\n- Demandas de desenvolvimento sempre ficam visiveis no cockpit e exigem confirmacao visual antes do Codex escrever.`,
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
        }
      ],
      tool_choice: "auto"
    }
  };
}

async function getProviderPreflight() {
  const providers = {
    gemini: {
      name: "gemini",
      label: "Gemini",
      bin: process.env.AURA_GEMINI_BIN || "gemini",
      args: ["--version"]
    },
    grok: {
      name: "grok",
      label: "Grok",
      bin: process.env.AURA_GROK_BIN || "grok",
      args: ["--version"]
    },
    openrouter: {
      name: "openrouter",
      label: "OpenRouter",
      bin: process.env.AURA_OPENROUTER_BIN || "openrouter",
      args: ["-v"]
    },
    codex: {
      name: "codex",
      label: "Codex",
      bin: process.env.AURA_CODEX_BIN || "codex",
      args: ["--version"]
    }
  };

  const entries = await Promise.all(Object.entries(providers).map(async ([key, provider]) => {
    const probe = await runProviderProbe(provider.bin, provider.args, 1800);
    return [key, {
      name: provider.name,
      label: provider.label,
      status: probe.available ? "available" : "unavailable",
      available: probe.available,
      bin: provider.bin,
      version: probe.version,
      error: probe.error
    }];
  }));

  return Object.fromEntries(entries);
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
      child?.kill("SIGTERM");
      finish({
        available: false,
        version: null,
        error: `${command} nao respondeu ao preflight em ${timeoutMs} ms.`
      });
    }, timeoutMs);

    try {
      child = spawn(command, args, {
        env: filteredProviderEnv(),
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
  const env = {};
  for (const name of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
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
