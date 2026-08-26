import { spawn } from "node:child_process";
import {
  createJobArtifact,
  getJob,
  listJobArtifacts,
  listJobEvents,
  recordJobEvent,
  updateJobStatus
} from "./memory.js";

const DEFAULT_ANALYSTS = Object.freeze({
  gemini: {
    binEnv: "AURA_GEMINI_BIN",
    bin: "gemini",
    versionArgs: ["--version"],
    args: (prompt) => ["-p", prompt, "--approval-mode", "plan", "--output-format", "text"]
  },
  grok: {
    binEnv: "AURA_GROK_BIN",
    bin: "grok",
    versionArgs: ["--version"],
    args: (prompt) => ["-p", prompt, "--permission-mode", "plan", "--disable-web-search", "--no-subagents", "--max-turns", "1", "--output-format", "plain"]
  }
});

export function buildEvidenceBrief(job, context = {}) {
  const files = Array.isArray(context.files) ? context.files : [];
  const constraints = Array.isArray(context.constraints) ? context.constraints : [
    "Read-only analysis.",
    "Do not edit files.",
    "Do not run Git commands.",
    "Return only the requested schema."
  ];
  const findings = Array.isArray(context.findings) ? context.findings : [];
  const attempted = Array.isArray(context.attempted) ? context.attempted : [];

  return [
    "# AURA Evidence Brief",
    "",
    `Job: #${job.id}`,
    `Objective: ${job.goal}`,
    `Workspace: ${job.workspace}`,
    `Mode: ${job.mode}`,
    `Policy: ${job.policyLevel}`,
    "",
    "## Constraints",
    ...constraints.map((item) => `- ${item}`),
    "",
    "## Relevant Files",
    ...(files.length ? files.map((item) => `- ${item}`) : ["- Not provided"]),
    "",
    "## Current Findings",
    ...(findings.length ? findings.map((item) => `- ${item}`) : ["- Not provided"]),
    "",
    "## Already Attempted",
    ...(attempted.length ? attempted.map((item) => `- ${item}`) : ["- Not provided"]),
    "",
    "## Required Response Schema",
    "Return JSON with keys: findings, risks, open_questions, recommendation, confidence.",
    "Use arrays for findings, risks and open_questions. Use a string for recommendation. Use low, medium or high for confidence."
  ].join("\n");
}

export async function detectAnalyst(name, { bin } = {}) {
  const config = analystConfig(name);
  const resolvedBin = bin || process.env[config.binEnv] || config.bin;
  const result = await captureCommand(resolvedBin, config.versionArgs, process.cwd(), 5000);
  if (result.errorCode === "ENOENT") {
    return {
      name,
      available: false,
      bin: resolvedBin,
      version: null,
      error: `${displayName(name)} CLI was not found on PATH.`
    };
  }
  if (result.exitCode !== 0) {
    return {
      name,
      available: false,
      bin: resolvedBin,
      version: null,
      error: result.stderr || result.stdout || `${displayName(name)} CLI version check failed.`
    };
  }
  return {
    name,
    available: true,
    bin: resolvedBin,
    version: result.stdout.trim() || "unknown",
    error: null
  };
}

export async function runAnalysts({
  jobId,
  context = {},
  consent = {},
  bins = {},
  timeoutMs
}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }
  assertAnalyzeJob(job);

  const selected = ["gemini", "grok"].filter((name) => consent[name] === true);
  if (!selected.length) {
    throw new Error("At least one analyst destination must be explicitly approved.");
  }

  const brief = buildEvidenceBrief(job, context);
  createJobArtifact(job.id, {
    kind: "evidence-brief",
    label: "Evidence brief",
    content: brief,
    metadata: { destinations: selected }
  });

  recordJobEvent(job.id, "analysts.consent", "Analyst destinations approved.", { destinations: selected });
  updateJobStatus(job.id, "running", { summary: "Read-only analysts running." });

  const analystResults = [];
  for (const name of selected) {
    const detection = await detectAnalyst(name, { bin: bins[name] });
    recordJobEvent(job.id, "analyst.detected", `${displayName(name)} detection completed.`, detection);

    if (!detection.available) {
      analystResults.push({ name, detection, response: null, error: detection.error });
      continue;
    }

    const prompt = buildAnalystPrompt(name, brief);
    const config = analystConfig(name);
    recordJobEvent(job.id, "analyst.started", `${displayName(name)} started in read-only plan mode.`, {
      name,
      bin: detection.bin,
      version: detection.version,
      mode: "plan"
    });

    const result = await captureCommand(detection.bin, config.args(prompt), job.workspace, timeoutMs || job.timeoutMs);
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const normalized = normalizeAnalystResponse(output);

    createJobArtifact(job.id, {
      kind: "analyst-response",
      label: `${displayName(name)} response`,
      content: output,
      metadata: {
        name,
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        normalized
      }
    });

    analystResults.push({ name, detection, result, response: normalized, error: result.exitCode === 0 ? null : output || "Analyst failed." });
    recordJobEvent(job.id, "analyst.finished", `${displayName(name)} finished.`, {
      name,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      confidence: normalized.confidence
    });
  }

  const successful = analystResults.filter((entry) => entry.response && !entry.error);
  const failed = analystResults.filter((entry) => entry.error);
  const status = successful.length ? "done" : "failed";
  const finalJob = updateJobStatus(job.id, status, {
    summary: `Analysts completed: ${successful.map((entry) => entry.name).join(", ") || "none"}. Failed: ${failed.map((entry) => entry.name).join(", ") || "none"}.`,
    error: successful.length ? null : "No analyst completed successfully."
  });

  return {
    job: finalJob,
    brief,
    analysts: analystResults,
    artifacts: listJobArtifacts(job.id),
    events: listJobEvents(job.id)
  };
}

export function normalizeAnalystResponse(text) {
  const parsed = parseJsonObject(text);
  if (parsed) {
    return {
      findings: normalizeStringArray(parsed.findings),
      risks: normalizeStringArray(parsed.risks),
      open_questions: normalizeStringArray(parsed.open_questions || parsed.openQuestions),
      recommendation: String(parsed.recommendation || "").trim(),
      confidence: normalizeConfidence(parsed.confidence)
    };
  }

  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    findings: lines.slice(0, 5),
    risks: [],
    open_questions: [],
    recommendation: lines.slice(0, 2).join(" ") || "No recommendation provided.",
    confidence: "low"
  };
}

function assertAnalyzeJob(job) {
  if (job.mode !== "analyze") {
    throw new Error("Analysts require a job with mode=analyze.");
  }
  if (job.policyLevel !== "read") {
    throw new Error("Analysts require policyLevel=read.");
  }
  if (job.status !== "draft" && job.status !== "queued") {
    throw new Error(`Analysts cannot run while job status is ${job.status}.`);
  }
}

function buildAnalystPrompt(name, brief) {
  return [
    `You are ${displayName(name)} running as an external AURA analyst.`,
    "Operate in read-only planning mode.",
    "Do not edit files, run Git commands, create commits, push changes, install packages, or execute destructive commands.",
    "Analyze the shared evidence brief and return only JSON matching the requested schema.",
    "",
    brief
  ].join("\n");
}

function analystConfig(name) {
  const config = DEFAULT_ANALYSTS[name];
  if (!config) {
    throw new Error(`Unknown analyst: ${name}.`);
  }
  return config;
}

function displayName(name) {
  return name === "grok" ? "Grok" : "Gemini";
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const candidates = [raw, raw.match(/\{[\s\S]*\}/)?.[0]].filter(Boolean);
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Try next candidate.
    }
  }
  return null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item || "").trim()).filter(Boolean);
  }
  const text = String(value || "").trim();
  return text ? [text] : [];
}

function normalizeConfidence(value) {
  const normalized = String(value || "low").toLowerCase();
  return ["low", "medium", "high"].includes(normalized) ? normalized : "low";
}

function captureCommand(command, args, cwd, timeoutMs = 300000) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
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
      timedOut = true;
      child?.kill("SIGTERM");
    }, timeoutMs);

    try {
      child = spawn(command, args, {
        cwd,
        env: filteredEnv(),
        windowsHide: true
      });
    } catch (error) {
      stderr += error.message;
      finish({ exitCode: null, signal: null, timedOut, stdout, stderr, errorCode: error.code || "ERROR" });
      return;
    }

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish({ exitCode: null, signal: null, timedOut, stdout, stderr, errorCode: error.code || "ERROR" });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, timedOut, stdout, stderr, errorCode: null });
    });
  });
}

function filteredEnv() {
  const env = {};
  for (const name of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }
  return env;
}
