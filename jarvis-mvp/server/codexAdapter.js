import fs from "node:fs";
import path from "node:path";
import { DATA_DIR } from "./config.js";
import { getJob, listJobEvents, recordJobEvent, updateJobStatus } from "./memory.js";
import { runJobCommand } from "./supervisor.js";

const DEFAULT_CODEX_BIN = "codex";

export async function detectCodex({ bin = process.env.AURA_CODEX_BIN || DEFAULT_CODEX_BIN } = {}) {
  const versionResult = await runProbe(bin, ["--version"]);
  if (versionResult.errorCode === "ENOENT") {
    return {
      available: false,
      bin,
      version: null,
      error: "Codex CLI was not found on PATH."
    };
  }

  if (versionResult.exitCode !== 0) {
    return {
      available: false,
      bin,
      version: null,
      error: versionResult.stderr || versionResult.stdout || `Codex CLI version check failed with code ${versionResult.exitCode}.`
    };
  }

  return {
    available: true,
    bin,
    version: versionResult.stdout.trim() || "unknown",
    error: null
  };
}

export async function runCodexAsk({
  jobId,
  prompt,
  bin = process.env.AURA_CODEX_BIN || DEFAULT_CODEX_BIN,
  timeoutMs
}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }

  assertAskJob(job);

  const codex = await detectCodex({ bin });
  recordJobEvent(job.id, "codex.detected", codex.available ? "Codex CLI detected." : "Codex CLI unavailable.", {
    bin: codex.bin,
    version: codex.version,
    available: codex.available,
    error: codex.error
  });

  if (!codex.available) {
    const failed = updateJobStatus(job.id, "failed", {
      error: codex.error,
      summary: "Codex CLI unavailable."
    });
    return {
      job: failed,
      codex,
      result: null,
      events: listJobEvents(job.id)
    };
  }

  const finalPrompt = buildAskPrompt(prompt || job.goal);
  const outputPath = process.env.AURA_CODEX_LAST_MESSAGE_PATH || path.join(DATA_DIR, `aura-codex-${job.id}-${Date.now()}.txt`);
  const args = [
    "exec",
    "--cd",
    job.workspace,
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
    "-"
  ];

  recordJobEvent(job.id, "codex.ask.started", "Codex ask started in read-only mode.", {
    bin: codex.bin,
    version: codex.version,
    sandbox: "read-only",
    cwd: job.workspace
  });

  const result = await runJobCommand({
    jobId: job.id,
    command: codex.bin,
    args,
    cwd: job.workspace,
    timeoutMs: timeoutMs || job.timeoutMs,
    input: finalPrompt
  });

  const lastMessage = readOptionalFile(outputPath);
  if (lastMessage) {
    recordJobEvent(job.id, "codex.ask.summary", "Codex ask final message.", {
      text: lastMessage
    });
  }
  removeOptionalFile(outputPath);

  return {
    job: getJob(job.id),
    codex,
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdout: result.stdout,
      stderr: result.stderr,
      lastMessage
    },
    events: listJobEvents(job.id)
  };
}

function assertAskJob(job) {
  if (job.mode !== "ask") {
    throw new Error("Codex ask requires a job with mode=ask.");
  }

  if (job.policyLevel !== "read") {
    throw new Error("Codex ask requires policyLevel=read.");
  }

  if (job.status !== "draft" && job.status !== "queued") {
    throw new Error(`Codex ask cannot run while job status is ${job.status}.`);
  }
}

function buildAskPrompt(prompt) {
  return [
    "You are Codex running inside AURA in read-only ask mode.",
    "Do not edit files, create commits, push changes, install packages, or run destructive commands.",
    "Answer the user's technical question using the current workspace as context when useful.",
    "",
    String(prompt || "").trim()
  ].join("\n");
}

function runProbe(command, args) {
  return new Promise((resolve) => {
    const child = import("node:child_process").then(({ spawn }) => {
      const proc = spawn(command, args, {
        env: filteredProbeEnv(),
        windowsHide: true
      });
      let stdout = "";
      let stderr = "";
      proc.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
      });
      proc.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      proc.on("error", (error) => {
        resolve({ exitCode: null, stdout, stderr, errorCode: error.code || "ERROR" });
      });
      proc.on("close", (exitCode) => {
        resolve({ exitCode, stdout, stderr, errorCode: null });
      });
    });
    child.catch((error) => resolve({ exitCode: null, stdout: "", stderr: error.message, errorCode: "ERROR" }));
  });
}

function filteredProbeEnv() {
  const env = {};
  for (const name of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}

function readOptionalFile(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8").trim();
  } catch {
    return "";
  }
}

function removeOptionalFile(filePath) {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // Best effort cleanup.
  }
}
