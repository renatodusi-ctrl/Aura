import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config, ensureRuntime, ROOT_DIR } from "./config.js";
import { getStatus, initMemory, listMemories, addMemory, listTasks, addTask, updateTask, deleteTask } from "./memory.js";
import { getLocalContext, listTools, runTool } from "./tools.js";

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
