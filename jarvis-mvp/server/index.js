import fs from "node:fs";
import http from "node:http";
import path from "node:path";
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
  createJob,
  getJob,
  listJobEvents,
  listJobs,
  updateJobStatus
} from "./memory.js";
import { getLocalContext, listTools, runTool } from "./tools.js";
import { evaluateJobPolicy, normalizePolicyLevel, POLICY_LEVELS } from "./policy.js";
import { createSessionToken, isAllowedOrigin, isProtectedApiPath, validateSessionRequest } from "./httpSecurity.js";
import { cancelJobProcess } from "./supervisor.js";
import { detectCodex, runCodexAsk } from "./codexAdapter.js";

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
  console.log(config.openaiApiKey ? "Realtime voice: enabled" : "Realtime voice: local fallback (OPENAI_API_KEY not set)");
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
    return sendJson(res, 200, {
      ok: true,
      realtimeEnabled: Boolean(config.openaiApiKey),
      realtimeModel: config.realtimeModel,
      realtimeVoice: config.realtimeVoice,
      dailyRoutineHour: config.dailyRoutineHour,
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

  const jobRoute = matchJobRoute(url.pathname);
  if (jobRoute && method === "GET" && !jobRoute.action) {
    const job = getJob(jobRoute.id);
    if (!job) {
      return sendJson(res, 404, { error: "Job not found." });
    }
    return sendJson(res, 200, { job, events: listJobEvents(job.id) });
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

  if (jobRoute && method === "POST" && jobRoute.action === "codex/ask") {
    return codexAskRoute(jobRoute.id, req, res);
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

  if (url.pathname.startsWith("/api/tasks/") && method === "DELETE") {
    const id = url.pathname.split("/").pop();
    return sendJson(res, 200, runTool("tasks.delete", { id }, url.searchParams.get("confirm") === "true"));
  }

  if (url.pathname === "/api/tools/run" && method === "POST") {
    const body = await readJson(req);
    return sendJson(res, 200, runTool(body.name, body.input, body.confirmed === true));
  }

  if (url.pathname === "/api/local/chat" && method === "POST") {
    return sendJson(res, 200, localChat(await readJson(req)));
  }

  if (url.pathname === "/api/realtime/token" && method === "GET") {
    return createRealtimeToken(res);
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
      timeoutMs: body.timeoutMs || 300000,
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
    return sendJson(res, output.job.status === "failed" ? 503 : 200, output);
  } catch (error) {
    return sendJson(res, 400, { error: error.message || "Could not run Codex ask." });
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
  const match = pathname.match(/^\/api\/jobs\/(\d+)(?:\/(events|cancel|codex\/ask))?$/);
  if (!match) {
    return null;
  }
  return {
    id: Number(match[1]),
    action: match[2] || null
  };
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

  if (!text) {
    return { reply: "Diga o que voce quer fazer." };
  }

  if (lower.startsWith("lembrar ") || lower.startsWith("guardar ")) {
    const content = text.replace(/^(lembrar|guardar)\s+/i, "");
    const memory = addMemory({ kind: "note", content });
    return { reply: "Memoria guardada localmente.", memory };
  }

  if (lower.startsWith("tarefa ") || lower.startsWith("criar tarefa ")) {
    const title = text.replace(/^(criar\s+)?tarefa\s+/i, "");
    const task = addTask({ title });
    return { reply: "Tarefa criada.", task };
  }

  if (lower.includes("rotina") || lower.includes("bom dia")) {
    const tasks = listTasks(false);
    const openList = tasks.length ? tasks.map((task) => `- ${task.title}`).join("\n") : "Nenhuma tarefa aberta.";
    return { reply: `Resumo local: ${openList}` };
  }

  return {
    reply: "Estou em modo local. Posso guardar memorias com \"guardar ...\", criar tarefas com \"tarefa ...\" e mostrar sua rotina enquanto a chave OpenAI nao estiver configurada."
  };
}

async function createRealtimeToken(res) {
  if (!config.openaiApiKey) {
    return sendJson(res, 503, { error: "OPENAI_API_KEY is not configured.", fallback: true });
  }

  const response = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.openaiApiKey}`,
      "Content-Type": "application/json",
      "OpenAI-Safety-Identifier": "local-aura-user"
    },
    body: JSON.stringify(realtimeSessionPayload())
  });

  const text = await response.text();
  res.writeHead(response.status, {
    "Content-Type": response.headers.get("content-type") || "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(text);
}

function realtimeSessionPayload() {
  return {
    session: {
      type: "realtime",
      model: config.realtimeModel,
      instructions: systemPrompt,
      audio: {
        output: {
          voice: config.realtimeVoice
        }
      }
    }
  };
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
