import { redactText } from "./redaction.js";
import { spawnToolSync } from "./processTools.js";

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_OUTPUT_CHARS = 5000;
const ENV_PRESENCE_KEYS = [
  "OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GOOGLE_GENAI_API_KEY",
  "GROK_API_KEY",
  "XAI_API_KEY",
  "OPENROUTER_API_KEY",
  "OPENROUTE_API_KEY",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "AURA_GITHUB_REPO",
  "AURA_LOCAL_READ_ROOTS",
  "VOICE_PROVIDER"
];

const diagnostics = new Map([
  ["node.version", {
    label: "Node.js",
    group: "Runtime",
    description: "Consulta a versao do Node.js usada pelo servidor local.",
    command: process.execPath,
    commandLabel: "node",
    args: ["--version"]
  }],
  ["npm.version", {
    label: "npm",
    group: "Runtime",
    description: "Consulta a versao do npm disponivel para scripts locais.",
    command: "npm",
    args: ["--version"]
  }],
  ["codex.version", {
    label: "Codex CLI",
    group: "IAs",
    description: "Consulta a versao do executor Codex CLI.",
    command: process.env.AURA_CODEX_BIN || "codex",
    args: ["--version"]
  }],
  ["gemini.version", {
    label: "Gemini CLI",
    group: "IAs",
    description: "Consulta a versao do Gemini CLI.",
    command: process.env.AURA_GEMINI_BIN || "gemini",
    args: ["--version"]
  }],
  ["grok.version", {
    label: "Grok CLI",
    group: "IAs",
    description: "Consulta a versao do Grok CLI.",
    command: process.env.AURA_GROK_BIN || "grok",
    args: ["--version"]
  }],
  ["openrouter.version", {
    label: "OpenRouter CLI",
    group: "IAs",
    description: "Consulta a versao do OpenRouter CLI configurado.",
    command: process.env.AURA_OPENROUTER_BIN || "openrouter",
    args: ["--version"]
  }],
  ["github.auth", {
    label: "GitHub auth",
    group: "Repositorio",
    description: "Consulta o status local de autenticacao do GitHub CLI.",
    command: "gh",
    args: ["auth", "status", "-h", "github.com"]
  }],
  ["aura.env.presence", {
    label: "Credenciais e paths",
    group: "AURA",
    description: "Mostra apenas se variaveis essenciais existem, sem revelar valores.",
    custom: envPresenceDiagnostic
  }]
]);

export function listTerminalDiagnostics() {
  return Array.from(diagnostics, ([id, diagnostic]) => ({
    id,
    label: diagnostic.label,
    group: diagnostic.group,
    description: diagnostic.description,
    command: commandPreview(diagnostic)
  }));
}

export function runTerminalDiagnostic(id) {
  const diagnostic = diagnostics.get(String(id || ""));
  if (!diagnostic) {
    const error = new Error("Terminal diagnostic is not allowlisted.");
    error.statusCode = 400;
    throw error;
  }

  if (diagnostic.custom) {
    return normalizeResult(id, diagnostic, diagnostic.custom());
  }

  const startedAt = new Date().toISOString();
  const result = spawnToolSync(diagnostic.command, diagnostic.args, {
    encoding: "utf8",
    timeout: diagnostic.timeoutMs || DEFAULT_TIMEOUT_MS,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"]
  });

  return normalizeResult(id, diagnostic, {
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: typeof result.status === "number" ? result.status : null,
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: result.stdout || "",
    stderr: result.stderr || result.error?.message || ""
  });
}

function normalizeResult(id, diagnostic, result) {
  const stdout = truncate(redactText(result.stdout || ""));
  const stderr = truncate(redactText(result.stderr || ""));
  const ok = result.exitCode === 0 && !result.timedOut;
  return {
    id,
    label: diagnostic.label,
    group: diagnostic.group,
    description: diagnostic.description,
    command: commandPreview(diagnostic),
    ok,
    exitCode: result.exitCode,
    signal: result.signal || null,
    timedOut: Boolean(result.timedOut),
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || new Date().toISOString(),
    stdout,
    stderr,
    summary: summaryForResult(ok, result, stdout, stderr)
  };
}

function envPresenceDiagnostic() {
  const startedAt = new Date().toISOString();
  const lines = ENV_PRESENCE_KEYS.map((name) => `${name} status ${process.env[name] ? "configured" : "missing"}`);
  return {
    startedAt,
    finishedAt: new Date().toISOString(),
    exitCode: 0,
    stdout: lines.join("\n"),
    stderr: ""
  };
}

function commandPreview(diagnostic) {
  if (diagnostic.custom) {
    return "internal:aura-env-presence";
  }
  return [diagnostic.commandLabel || diagnostic.command, ...(diagnostic.args || [])].join(" ");
}

function summaryForResult(ok, result, stdout, stderr) {
  if (result.timedOut) {
    return "Tempo limite atingido antes de concluir a consulta.";
  }
  if (ok) {
    return firstMeaningfulLine(stdout) || "Consulta concluida com sucesso.";
  }
  return firstMeaningfulLine(stderr) || firstMeaningfulLine(stdout) || "Consulta terminou com erro.";
}

function firstMeaningfulLine(value) {
  return String(value || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
}

function truncate(value) {
  const text = String(value || "");
  if (text.length <= MAX_OUTPUT_CHARS) {
    return text;
  }
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n...[saida truncada pela AURA]`;
}
