import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
export const ROOT_DIR = path.resolve(__dirname, "..");
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const EXPORT_DIR = path.join(ROOT_DIR, "exports");

loadEnvFile(path.join(ROOT_DIR, ".env"));

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const contents = fs.readFileSync(filePath, "utf8");
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) {
      continue;
    }

    const [rawKey, ...valueParts] = trimmed.split("=");
    const key = rawKey.trim();
    const value = valueParts.join("=").trim().replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function intFromEnv(name, fallback) {
  const value = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(value) ? value : fallback;
}

function pathsFromEnv(name, fallback) {
  const raw = String(process.env[name] || "").trim();
  const values = raw
    ? raw.split(/[;,]/).map((entry) => entry.trim()).filter(Boolean)
    : fallback;
  return [...new Set(values.map((entry) => path.resolve(entry)))];
}

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intFromEnv("PORT", 5173),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || process.env.GOOGLE_GENAI_API_KEY || "",
  voiceProvider: (process.env.VOICE_PROVIDER || "openai").toLowerCase(),
  realtimeModel: process.env.REALTIME_MODEL || "gpt-realtime-2.1",
  realtimeVoice: process.env.REALTIME_VOICE || "cedar",
  geminiLiveModel: process.env.GEMINI_LIVE_MODEL || "gemini-3.1-flash-live-preview",
  geminiLiveVoice: process.env.GEMINI_LIVE_VOICE || "Vindemiatrix",
  dailyRoutineHour: intFromEnv("DAILY_ROUTINE_HOUR", 8),
  jobHistoryRetentionDays: intFromEnv("JOB_HISTORY_RETENTION_DAYS", 90),
  jobExportDir: process.env.JOB_EXPORT_DIR || EXPORT_DIR,
  jobTimeoutMs: intFromEnv("JOB_TIMEOUT_MS", 300000),
  codexTimeoutMs: intFromEnv("CODEX_TIMEOUT_MS", 900000),
  localReadRoots: pathsFromEnv("AURA_LOCAL_READ_ROOTS", [path.resolve(ROOT_DIR, "..")]),
  databasePath: path.join(DATA_DIR, "aura.sqlite")
};

export function ensureRuntime() {
  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major < 22) {
    throw new Error(`AURA requires Node.js 22 or newer. Current version: ${process.version}`);
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(EXPORT_DIR, { recursive: true });
}
