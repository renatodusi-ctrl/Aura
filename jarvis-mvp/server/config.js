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

export const config = {
  host: process.env.HOST || "127.0.0.1",
  port: intFromEnv("PORT", 5173),
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  realtimeModel: process.env.REALTIME_MODEL || "gpt-realtime-2.1",
  realtimeVoice: process.env.REALTIME_VOICE || "marin",
  dailyRoutineHour: intFromEnv("DAILY_ROUTINE_HOUR", 8),
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
