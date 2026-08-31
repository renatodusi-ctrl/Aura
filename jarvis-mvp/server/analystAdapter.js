import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  createJobArtifact,
  getJob,
  listJobArtifacts,
  listJobEvents,
  recordJobEvent,
  updateJobMetadata,
  updateJobStatus
} from "./memory.js";
import { envForAnalyst, filteredToolEnv, killProcessTree, prepareToolSpawn } from "./processTools.js";
import { redactText } from "./redaction.js";

const HEALTH_CHECK_TIMEOUT_MS = 30000;
const ANALYST_KILL_GRACE_MS = 2500;
const ANALYST_CIRCUIT_OPEN_MS = Number.parseInt(process.env.AURA_ANALYST_CIRCUIT_MS || "", 10) || 180000;
const MAX_FILE_EVIDENCE_BYTES = 6000;
const MAX_FILE_EVIDENCE_TOTAL_BYTES = 18000;
const MIN_FILE_EVIDENCE_BYTES = 1200;
const DEFAULT_EVIDENCE_TERMS = Object.freeze([
  "synthesize",
  "debate-synthesis",
  "Decisao do Conselho",
  "critic-review",
  "critic gate",
  "needs_input",
  "skip",
  "runAnalystConsultation",
  "renderCouncilDecisionCard",
  "finalize: false",
  "qualityGate"
]);
const ANALYST_JSON_SCHEMA = JSON.stringify({
  type: "object",
  additionalProperties: false,
  required: ["findings", "risks", "open_questions", "recommendation", "confidence"],
  properties: {
    findings: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
    open_questions: { type: "array", items: { type: "string" } },
    recommendation: { type: "string" },
    confidence: { type: "string", enum: ["low", "medium", "high"] }
  }
});
const HEALTH_CHECK_PROMPT = [
  "Return only this JSON object and do not add any other text:",
  "{\"findings\":[\"health-check-ok\"],\"risks\":[],\"open_questions\":[],\"recommendation\":\"usable\",\"confidence\":\"high\"}"
].join("\n");

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
    promptFile: true,
    args: (prompt, options = {}) => [
      ...(options.promptFile ? ["--prompt-file", options.promptFile] : ["-p", prompt]),
      "--no-alt-screen",
      "--no-plan",
      "--disable-web-search",
      "--no-subagents",
      "--output-format",
      "json",
      "--max-turns",
      process.env.AURA_GROK_MAX_TURNS || "8",
      "--json-schema",
      ANALYST_JSON_SCHEMA
    ]
  },
  openrouter: {
    binEnv: "AURA_OPENROUTER_BIN",
    bin: "openrouter",
    versionArgs: ["--version"],
    args: (prompt) => [
      "chat",
      "--no-stream",
      "--output",
      "json",
      "--model",
      process.env.AURA_OPENROUTER_MODEL || process.env.OPENROUTER_MODEL || "~openai/gpt-latest",
      prompt
    ]
  }
});

const ANALYST_NAMES = Object.freeze(Object.keys(DEFAULT_ANALYSTS));
const activeAnalystProcesses = new Map();
const analystCircuits = new Map();

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
  const fileEvidence = buildFileEvidence(job.workspace, files, context);

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
    "## File Evidence",
    ...(fileEvidence.length ? fileEvidence : ["- No file excerpts included."]),
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
  const result = await captureCommand(resolvedBin, config.versionArgs, process.cwd(), 5000, envForAnalyst(name));
  if (result.errorCode === "ENOENT") {
    return {
      name,
      detected: false,
      available: false,
      usable: false,
      bin: resolvedBin,
      version: null,
      error: `${displayName(name)} CLI was not found on PATH.`
    };
  }
  if (result.exitCode !== 0) {
    return {
      name,
      detected: false,
      available: false,
      usable: false,
      bin: resolvedBin,
      version: null,
      error: result.stderr || result.stdout || `${displayName(name)} CLI version check failed.`
    };
  }
  return {
    name,
    detected: true,
    available: true,
    usable: null,
    bin: resolvedBin,
    version: result.stdout.trim() || "unknown",
    error: null
  };
}

export async function healthCheckAnalyst(name, { bin, cwd = process.cwd(), timeoutMs = HEALTH_CHECK_TIMEOUT_MS, jobId = null } = {}) {
  const circuit = analystCircuitState(name);
  if (circuit.open) {
    if (jobId) {
      recordJobEvent(jobId, "analyst.circuit_open", `${displayName(name)} circuit breaker is open.`, {
        name,
        reason: circuit.reason,
        retryAt: circuit.retryAt,
        remainingMs: circuit.remainingMs
      });
    }
    return {
      name,
      detected: true,
      available: false,
      usable: false,
      bin: bin || analystConfig(name).bin,
      version: null,
      error: circuit.reason,
      health: "circuit_open",
      reason: circuit.reason,
      circuit
    };
  }

  const detection = await detectAnalyst(name, { bin });
  if (!detection.available) {
    return {
      ...detection,
      detected: detection.available,
      usable: false,
      health: "not_detected",
      reason: detection.error || `${displayName(name)} nao foi detectado.`
    };
  }

  const config = analystConfig(name);
  const result = await captureCommand(
    detection.bin,
    config.args(HEALTH_CHECK_PROMPT),
    cwd,
    timeoutMs,
    envForAnalyst(name),
    jobId ? { jobId, name, stage: "health-check" } : {}
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  const normalized = normalizeAnalystResponse(output);
  const usable = result.exitCode === 0 && normalized.validSchema === true;
  const reason = usable ? "" : reasonForAnalystFailure(name, result, output, normalized);
  if (!usable && result.cancelled !== true) {
    openAnalystCircuit(name, reason, { stage: "health-check", timeoutMs });
  }
  if (!usable && jobId) {
    recordAnalystOutcome(jobId, name, outcomeForResult(result, reason), {
      stage: "health-check",
      reason,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      validSchema: normalized.validSchema,
      circuit: analystCircuitState(name)
    });
  }

  return {
    ...detection,
    detected: true,
    usable,
    health: usable ? "usable" : "unusable",
    reason,
    check: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled === true,
      validSchema: normalized.validSchema
    },
    circuit: analystCircuitState(name)
  };
}

export function cancelAnalystJobProcess(jobId) {
  const active = activeAnalystProcesses.get(Number(jobId));
  if (!active || !active.size) {
    return false;
  }

  for (const entry of active) {
    entry.cancelled = true;
    recordJobEvent(entry.jobId, "analyst.cancel_requested", `${displayName(entry.name)} cancellation requested.`, {
      name: entry.name,
      stage: entry.stage
    });
    killProcessTree(entry.child);
    entry.hardTimeout = entry.hardTimeout || setTimeout(() => {
      entry.finish({
        exitCode: null,
        signal: "SIGTERM",
        timedOut: false,
        cancelled: true,
        stdout: entry.stdout(),
        stderr: entry.stderr(),
        errorCode: "CANCELLED"
      });
    }, ANALYST_KILL_GRACE_MS);
  }

  return true;
}

export function hasActiveAnalystJobProcess(jobId) {
  const active = activeAnalystProcesses.get(Number(jobId));
  return Boolean(active && active.size);
}

export function analystCircuitState(name) {
  const state = analystCircuits.get(name);
  if (!state) {
    return { open: false, reason: null, retryAt: null, remainingMs: 0 };
  }

  const remainingMs = state.retryAt - Date.now();
  if (remainingMs <= 0) {
    analystCircuits.delete(name);
    return { open: false, reason: null, retryAt: null, remainingMs: 0 };
  }

  return {
    open: true,
    reason: state.reason,
    retryAt: new Date(state.retryAt).toISOString(),
    remainingMs
  };
}

export function resetAnalystCircuit(name = null) {
  if (name) {
    analystCircuits.delete(name);
    return;
  }
  analystCircuits.clear();
}

export async function runAnalysts({
  jobId,
  context = {},
  consent = {},
  bins = {},
  timeoutMs,
  debateRounds = 1
}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }
  assertAnalyzeJob(job);

  const selected = ANALYST_NAMES.filter((name) => consent[name] === true);
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

  updateJobMetadata(job.id, {
    analystRun: {
      requestedDestinations: selected,
      lastRequestedAt: new Date().toISOString()
    }
  });
  recordJobEvent(job.id, "analysts.consent", "Analyst destinations approved.", { destinations: selected });
  updateJobStatus(job.id, "running", { summary: "Read-only analysts running." });

  const analystResults = [];
  const usableAnalysts = [];
  const totalTimeoutMs = normalizeTimeoutMs(timeoutMs || job.timeoutMs);
  const providerTimeoutMs = perProviderTimeout(totalTimeoutMs, selected.length);
  const deadline = Date.now() + totalTimeoutMs;
  let cancelled = false;
  for (const name of selected) {
    if (Date.now() >= deadline) {
      analystResults.push({ name, detection: null, response: null, error: `Tempo total do Conselho esgotado antes de iniciar ${displayName(name)}.` });
      recordJobEvent(job.id, "analyst.deadline_reached", "Analyst run deadline reached.", { name, deadline: new Date(deadline).toISOString() });
      break;
    }

    const detection = await detectAnalyst(name, { bin: bins[name] });
    recordJobEvent(job.id, "analyst.detected", `${displayName(name)} detection completed.`, detection);

    if (!detection.available) {
      analystResults.push({ name, detection, response: null, error: detection.error });
      continue;
    }

    const health = await healthCheckAnalyst(name, {
      bin: detection.bin,
      cwd: job.workspace,
      timeoutMs: remainingTimeout(deadline, healthCheckTimeout(providerTimeoutMs)),
      jobId: job.id
    });
    recordJobEvent(job.id, "analyst.health_checked", `${displayName(name)} usability check completed.`, health);
    if (health.check?.cancelled) {
      cancelled = true;
      break;
    }

    if (!health.usable) {
      analystResults.push({ name, detection: health, response: null, error: health.reason || `${displayName(name)} is not usable for this job.` });
      continue;
    }
    usableAnalysts.push(name);

    const prompt = buildAnalystPrompt(name, brief);
    const config = analystConfig(name);
    recordJobEvent(job.id, "analyst.started", `${displayName(name)} started in read-only analyst mode.`, {
      name,
      bin: detection.bin,
      version: detection.version,
      mode: "read-only"
    });

    const promptFile = config.promptFile ? writeAnalystPromptFile(name, prompt) : null;
    let result;
    try {
      result = await captureCommand(
        detection.bin,
        config.args(prompt, { promptFile }),
        job.workspace,
        remainingTimeout(deadline, providerTimeoutMs),
        envForAnalyst(name),
        { jobId: job.id, name, stage: "initial-analysis" }
      );
    } finally {
      removeAnalystPromptFile(promptFile);
    }
    if (result.cancelled) {
      recordAnalystOutcome(job.id, name, "cancelled", {
        stage: "initial-analysis",
        signal: result.signal
      });
      cancelled = true;
      break;
    }
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    const normalized = normalizeAnalystResponse(output);
    const error = result.exitCode === 0 && normalized.validSchema
      ? null
      : reasonForAnalystFailure(name, result, output, normalized);
    if (error && !result.cancelled) {
      openAnalystCircuit(name, error, {
        stage: "initial-analysis",
        timeoutMs: providerTimeoutMs,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        validSchema: normalized.validSchema
      });
    }

    createJobArtifact(job.id, {
      kind: "analyst-response",
      label: `${displayName(name)} response`,
      content: output,
      metadata: {
        name,
        round: 1,
        promptPurpose: "initial-analysis",
        exitCode: result.exitCode,
        signal: result.signal,
        timedOut: result.timedOut,
        normalized
      }
    });

    analystResults.push({ name, detection: health, result, response: normalized, error });
    recordAnalystOutcome(job.id, name, outcomeForResult(result, error), {
      stage: "initial-analysis",
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      validSchema: normalized.validSchema,
      confidence: normalized.confidence,
      error
    });
    recordJobEvent(job.id, "analyst.finished", `${displayName(name)} finished.`, {
      name,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      validSchema: normalized.validSchema,
      confidence: normalized.confidence
    });
  }

  const requestedRounds = Math.max(1, Math.min(Number.parseInt(debateRounds, 10) || 1, 3));
  if (requestedRounds > 1) {
    for (let round = 2; round <= requestedRounds; round += 1) {
      const previousSuccessful = analystResults.filter((entry) => entry.response && !entry.error);
      if (!previousSuccessful.length) {
        break;
      }
      if (Date.now() >= deadline || cancelled) {
        recordJobEvent(job.id, "analyst.deadline_reached", "Analyst debate deadline reached.", { round, deadline: new Date(deadline).toISOString() });
        break;
      }
      const followUpBrief = buildDebateFollowUpBrief(job, brief, previousSuccessful, round);
      createJobArtifact(job.id, {
        kind: "evidence-brief",
        label: `Evidence brief round ${round}`,
        content: followUpBrief,
        metadata: {
          destinations: previousSuccessful.map((entry) => entry.name),
          round,
          promptPurpose: "dissent-review"
        }
      });

      for (const previous of previousSuccessful) {
        const name = previous.name;
        const config = analystConfig(name);
        const prompt = buildAnalystPrompt(name, followUpBrief);
        recordJobEvent(job.id, "analyst.debate_round_started", `${displayName(name)} started debate round ${round}.`, {
          name,
          round,
          mode: "read-only"
        });

        const promptFile = config.promptFile ? writeAnalystPromptFile(name, prompt) : null;
        let result;
        try {
          result = await captureCommand(
            previous.detection.bin || bins[name] || config.bin,
            config.args(prompt, { promptFile }),
            job.workspace,
            remainingTimeout(deadline, providerTimeoutMs),
            envForAnalyst(name),
            { jobId: job.id, name, stage: `dissent-review:${round}` }
          );
        } finally {
          removeAnalystPromptFile(promptFile);
        }
        if (result.cancelled) {
          recordAnalystOutcome(job.id, name, "cancelled", {
            stage: `dissent-review:${round}`,
            round,
            signal: result.signal
          });
          cancelled = true;
          break;
        }

        const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
        const normalized = normalizeAnalystResponse(output);
        const error = result.exitCode === 0 && normalized.validSchema
          ? null
          : reasonForAnalystFailure(name, result, output, normalized);

        createJobArtifact(job.id, {
          kind: "analyst-response",
          label: `${displayName(name)} response round ${round}`,
          content: output,
          metadata: {
            name,
            round,
            promptPurpose: "dissent-review",
            exitCode: result.exitCode,
            signal: result.signal,
            timedOut: result.timedOut,
            normalized
          }
        });

        analystResults.push({ name, detection: previous.detection, result, response: normalized, error, round });
        recordJobEvent(job.id, "analyst.debate_round_finished", `${displayName(name)} finished debate round ${round}.`, {
          name,
          round,
          exitCode: result.exitCode,
          timedOut: result.timedOut,
          validSchema: normalized.validSchema,
          confidence: normalized.confidence
        });
      }
      if (cancelled) {
        break;
      }
    }
  }

  if (cancelled) {
    const finalJob = updateJobStatus(job.id, "cancelled", {
      summary: "Conselho cancelado pelo operador."
    });
    return {
      job: finalJob,
      brief,
      analysts: analystResults,
      artifacts: listJobArtifacts(job.id),
      events: listJobEvents(job.id)
    };
  }

  const successful = analystResults.filter((entry) => entry.response && !entry.error);
  const failed = analystResults.filter((entry) => entry.error);
  const telemetry = analystTelemetry(selected, usableAnalysts, analystResults, {
    totalTimeoutMs,
    providerTimeoutMs,
    cancelled,
    degraded: successful.length > 0 && failed.length > 0
  });
  createJobArtifact(job.id, {
    kind: "analyst-telemetry",
    label: "Council telemetry",
    content: JSON.stringify(telemetry, null, 2),
    metadata: telemetry
  });
  const status = successful.length ? "done" : "needs_input";
  const failureSummary = analystFailureSummary(selected, usableAnalysts, failed);
  updateJobStatus(job.id, status, {
    summary: `Analysts completed: ${successful.map((entry) => entry.name).join(", ") || "none"}. Failed: ${failed.map((entry) => entry.name).join(", ") || "none"}.`,
    error: successful.length ? null : failureSummary
  });
  const finalJob = updateJobMetadata(job.id, {
    analystRun: {
      requestedDestinations: selected,
      usableDestinations: usableAnalysts,
      failedDestinations: failed.map((entry) => entry.name),
      roundsRequested: requestedRounds,
      roundsCompleted: Math.max(0, ...successful.map((entry) => entry.round || 1)),
      telemetry,
      lastCompletedAt: new Date().toISOString(),
      recovery: successful.length ? "none" : "retry_or_skip"
    }
  });

  return {
    job: finalJob,
    brief,
    analysts: analystResults,
    artifacts: listJobArtifacts(job.id),
    events: listJobEvents(job.id)
  };
}

function perProviderTimeout(totalTimeoutMs, selectedCount) {
  const count = Math.max(1, Number.parseInt(selectedCount, 10) || 1);
  const total = normalizeTimeoutMs(totalTimeoutMs);
  return Math.max(1000, Math.floor(total / count));
}

function outcomeForResult(result = {}, error = null) {
  if (result.cancelled) {
    return "cancelled";
  }
  if (result.timedOut) {
    return "timed_out";
  }
  if (error || result.exitCode !== 0) {
    return "failed";
  }
  return "completed";
}

function recordAnalystOutcome(jobId, name, outcome, data = {}) {
  const messages = {
    completed: `${displayName(name)} completed successfully.`,
    failed: `${displayName(name)} failed.`,
    timed_out: `${displayName(name)} timed out.`,
    cancelled: `${displayName(name)} was cancelled.`,
    circuit_open: `${displayName(name)} circuit breaker is open.`
  };
  recordJobEvent(jobId, `analyst.${outcome}`, messages[outcome] || `${displayName(name)} changed state.`, {
    name,
    outcome,
    ...data
  });
}

function analystTelemetry(selected, usableAnalysts, analystResults, context = {}) {
  const providers = selected.map((name) => {
    const attempts = analystResults.filter((entry) => entry.name === name);
    const last = attempts.at(-1);
    const error = last?.error || null;
    const result = last?.result || last?.detection?.check || {};
    return {
      name,
      usable: usableAnalysts.includes(name),
      attempts: attempts.length,
      outcome: last ? outcomeForResult(result, error) : "skipped",
      error: error ? redactText(error) : null,
      timedOut: Boolean(result.timedOut),
      cancelled: Boolean(result.cancelled),
      circuit: analystCircuitState(name)
    };
  });
  return {
    requested: selected,
    usable: usableAnalysts,
    successful: analystResults.filter((entry) => entry.response && !entry.error).map((entry) => entry.name),
    failed: analystResults.filter((entry) => entry.error).map((entry) => entry.name),
    ...context,
    providers
  };
}

export function normalizeAnalystResponse(text) {
  const parsed = parseJsonObject(text);
  if (parsed) {
    const structured = extractStructuredAnalystPayload(parsed);
    if (structured) {
      return normalizedAnalystObject(structured);
    }
    if (typeof parsed.text === "string") {
      const nested = parseJsonObject(parsed.text);
      if (nested) {
        return normalizedAnalystObject(nested);
      }
    }
    return normalizedAnalystObject(parsed);
  }

  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return {
    findings: lines.slice(0, 5),
    risks: [],
    open_questions: [],
    recommendation: lines.slice(0, 2).join(" ") || "No recommendation provided.",
    confidence: "low",
    validSchema: false
  };
}

function buildDebateFollowUpBrief(job, originalBrief, previousSuccessful, round) {
  const recommendations = previousSuccessful
    .map((entry) => `- ${displayName(entry.name)}: ${entry.response.recommendation || "No recommendation."}`)
    .join("\n");
  const risks = previousSuccessful
    .flatMap((entry) => normalizeStringArray(entry.response.risks).map((risk) => `- ${displayName(entry.name)}: ${risk}`))
    .join("\n") || "- No risks raised.";
  const questions = previousSuccessful
    .flatMap((entry) => normalizeStringArray(entry.response.open_questions).map((question) => `- ${displayName(entry.name)}: ${question}`))
    .join("\n") || "- No open questions raised.";

  return [
    originalBrief,
    "",
    `# Debate Follow-up Round ${round}`,
    "",
    "This is a real follow-up round. Re-read the original evidence, challenge the previous answers, and return the same JSON schema.",
    "Focus on dissent, missing evidence, safest next action, and whether implementation should proceed.",
    "",
    "## Previous Recommendations",
    recommendations || "- No previous recommendations.",
    "",
    "## Previous Risks",
    risks,
    "",
    "## Previous Open Questions",
    questions
  ].join("\n");
}

function normalizedAnalystObject(parsed) {
  return {
    findings: normalizeStringArray(parsed.findings),
    risks: normalizeStringArray(parsed.risks),
    open_questions: normalizeStringArray(parsed.open_questions || parsed.openQuestions),
    recommendation: String(parsed.recommendation || "").trim(),
    confidence: normalizeConfidence(parsed.confidence),
    validSchema: isValidAnalystSchema(parsed)
  };
}

function extractStructuredAnalystPayload(parsed) {
  if (parsed.structuredOutput && typeof parsed.structuredOutput === "object" && !Array.isArray(parsed.structuredOutput)) {
    return parsed.structuredOutput;
  }
  if (parsed.output && typeof parsed.output === "object" && !Array.isArray(parsed.output)) {
    return parsed.output;
  }
  return null;
}

function assertAnalyzeJob(job) {
  if (job.mode !== "analyze") {
    throw new Error("Analysts require a job with mode=analyze.");
  }
  if (job.policyLevel !== "read") {
    throw new Error("Analysts require policyLevel=read.");
  }
  if (job.status !== "draft" && job.status !== "queued" && job.status !== "needs_input") {
    throw new Error(`Analysts cannot run while job status is ${job.status}.`);
  }
}

function buildAnalystPrompt(name, brief) {
  return [
    `You are ${displayName(name)} running as an external AURA analyst.`,
    "Operate as a read-only reviewer.",
    "Do not edit files, run Git commands, create commits, push changes, install packages, or execute destructive commands.",
    "Do not announce a plan or inspect the workspace. Base your answer only on the shared evidence brief.",
    "Return only JSON matching the requested schema.",
    "",
    brief
  ].join("\n");
}

function buildFileEvidence(workspace, files, context = {}) {
  if (context.includeFileEvidence === false || !files.length) {
    return [];
  }

  const root = path.resolve(workspace || process.cwd());
  const evidence = [];
  let totalBytes = 0;
  const perFileBudget = Math.max(
    MIN_FILE_EVIDENCE_BYTES,
    Math.floor(MAX_FILE_EVIDENCE_TOTAL_BYTES / Math.max(files.length, 1))
  );
  const evidenceTerms = evidenceTermsFor(context);
  for (const file of files) {
    const safe = resolveEvidenceFile(root, file);
    if (!safe.ok) {
      evidence.push(`### ${file}\nSkipped: ${safe.reason}`);
      continue;
    }

    try {
      const stat = fs.statSync(safe.path);
      if (!stat.isFile()) {
        evidence.push(`### ${file}\nSkipped: not a regular file.`);
        continue;
      }
      if (totalBytes >= MAX_FILE_EVIDENCE_TOTAL_BYTES) {
        evidence.push(`### ${file}\nSkipped: total evidence budget reached.`);
        continue;
      }

      const remaining = MAX_FILE_EVIDENCE_TOTAL_BYTES - totalBytes;
      const raw = fs.readFileSync(safe.path, "utf8");
      const limit = Math.min(MAX_FILE_EVIDENCE_BYTES, perFileBudget, remaining);
      const excerpt = redactText(excerptForAnalystEvidence(raw, limit, evidenceTerms));
      totalBytes += Buffer.byteLength(excerpt, "utf8");
      evidence.push([
        `### ${file}`,
        "```text",
        excerpt,
        raw.length > excerpt.length ? "\n[Excerpt selected by AURA evidence budget.]" : "",
        "```"
      ].join("\n"));
    } catch (error) {
      evidence.push(`### ${file}\nSkipped: ${error.message}`);
    }
  }
  return evidence;
}

function evidenceTermsFor(context = {}) {
  const explicit = Array.isArray(context.focusTerms) ? context.focusTerms : [];
  return [...explicit, ...DEFAULT_EVIDENCE_TERMS]
    .map((term) => String(term || "").trim())
    .filter(Boolean);
}

function excerptForAnalystEvidence(raw, limit, terms) {
  const text = String(raw || "");
  if (text.length <= limit) {
    return text;
  }

  const lower = text.toLowerCase();
  const windows = [];
  const windowSize = Math.max(500, Math.floor(limit / 3));
  for (const term of terms) {
    const index = lower.indexOf(term.toLowerCase());
    if (index === -1) {
      continue;
    }
    const start = Math.max(0, index - Math.floor(windowSize / 2));
    const end = Math.min(text.length, start + windowSize);
    windows.push({ start, end });
    if (windows.length >= 3) {
      break;
    }
  }

  if (!windows.length) {
    windows.push({ start: 0, end: Math.min(text.length, limit) });
  }

  const merged = mergeEvidenceWindows(windows);
  let excerpt = merged
    .map(({ start, end }) => {
      const prefix = start > 0 ? "[...]\n" : "";
      const suffix = end < text.length ? "\n[...]" : "";
      return `${prefix}${text.slice(start, end)}${suffix}`;
    })
    .join("\n\n");

  if (excerpt.length > limit) {
    excerpt = `${excerpt.slice(0, limit)}\n[...]`;
  }
  return excerpt;
}

function mergeEvidenceWindows(windows) {
  return [...windows]
    .sort((a, b) => a.start - b.start)
    .reduce((merged, current) => {
      const previous = merged[merged.length - 1];
      if (previous && current.start <= previous.end + 80) {
        previous.end = Math.max(previous.end, current.end);
      } else {
        merged.push({ ...current });
      }
      return merged;
    }, []);
}

function resolveEvidenceFile(root, file) {
  const relative = String(file || "").trim();
  if (!relative) {
    return { ok: false, reason: "empty path" };
  }
  if (/\.env(?:\.|$)|(^|[\\/])(?:node_modules|data|exports|\.git)([\\/]|$)/i.test(relative)) {
    return { ok: false, reason: "sensitive or generated path" };
  }
  const resolved = path.resolve(root, relative);
  const pathFromRoot = path.relative(root, resolved);
  if (pathFromRoot.startsWith("..") || path.isAbsolute(pathFromRoot)) {
    return { ok: false, reason: "outside workspace" };
  }
  return { ok: true, path: resolved };
}

function writeAnalystPromptFile(name, prompt) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `aura-${name}-prompt-`));
  const promptPath = path.join(tempDir, "prompt.txt");
  fs.writeFileSync(promptPath, prompt, "utf8");
  return promptPath;
}

function removeAnalystPromptFile(promptPath) {
  if (!promptPath) {
    return;
  }
  const tempDir = path.dirname(promptPath);
  try {
    fs.unlinkSync(promptPath);
  } catch {
    // Best-effort cleanup.
  }
  try {
    fs.rmdirSync(tempDir);
  } catch {
    // Best-effort cleanup.
  }
}

function analystConfig(name) {
  const config = DEFAULT_ANALYSTS[name];
  if (!config) {
    throw new Error(`Unknown analyst: ${name}.`);
  }
  return config;
}

function displayName(name) {
  const labels = {
    gemini: "Gemini",
    grok: "Grok",
    openrouter: "OpenRouter"
  };
  return labels[name] || name;
}

function parseJsonObject(text) {
  const raw = String(text || "").trim();
  const objectLike = raw.match(/\{[\s\S]*\}/)?.[0];
  const unescaped = raw.includes('\\"') ? raw.replaceAll('\\"', '"') : null;
  const candidates = [
    raw,
    objectLike,
    unescaped,
    unescaped?.match(/\{[\s\S]*\}/)?.[0]
  ].filter(Boolean);
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

function isValidAnalystSchema(value) {
  return Boolean(
    value &&
    Array.isArray(value.findings) &&
    Array.isArray(value.risks) &&
    (Array.isArray(value.open_questions) || Array.isArray(value.openQuestions)) &&
    typeof value.recommendation === "string" &&
    ["low", "medium", "high"].includes(String(value.confidence || "").toLowerCase())
  );
}

function healthCheckTimeout(timeoutMs) {
  const parsed = Number.parseInt(timeoutMs, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return HEALTH_CHECK_TIMEOUT_MS;
  }
  return Math.min(parsed, HEALTH_CHECK_TIMEOUT_MS);
}

function reasonForAnalystFailure(name, result = {}, output = "", normalized = {}) {
  if (result.cancelled) {
    return `${displayName(name)} foi cancelado pelo operador.`;
  }
  if (result.timedOut) {
    return `${displayName(name)} nao respondeu dentro do limite.`;
  }
  const text = String(output || "").trim();
  const lower = text.toLowerCase();
  if (lower.includes("fetch failed") || lower.includes("network")) {
    return `${displayName(name)} falhou por rede antes de responder.`;
  }
  if (lower.includes("certificate") || lower.includes("cert")) {
    return `${displayName(name)} falhou por certificado TLS.`;
  }
  if (lower.includes("max turns")) {
    return `${displayName(name)} chegou ao limite de turnos sem entregar JSON valido.`;
  }
  if (result.exitCode !== 0) {
    return text || `${displayName(name)} saiu com codigo ${result.exitCode}.`;
  }
  if (normalized.validSchema === false) {
    return `${displayName(name)} respondeu fora do contrato JSON do Conselho.`;
  }
  return text || `${displayName(name)} nao retornou uma resposta utilizavel.`;
}

function analystFailureSummary(selected, usableAnalysts, failed) {
  if (!usableAnalysts.length) {
    return `Nenhum analista utilizavel agora. Detectados/selecionados: ${selected.join(", ")}. Tente novamente ou ignore esta consulta.`;
  }
  return `Nenhum analista concluiu com resposta valida. Falharam: ${failed.map((entry) => entry.name).join(", ") || "todos"}. Tente novamente ou ignore esta consulta.`;
}

function captureCommand(command, args, cwd, timeoutMs = 300000, extraEnv = {}, options = {}) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;
    let child;
    let active = null;
    let hardTimeout = null;
    const jobId = options.jobId ? Number(options.jobId) : null;
    const analystName = options.name || "analyst";
    const stage = options.stage || "command";
    const safeTimeoutMs = normalizeTimeoutMs(timeoutMs);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      clearTimeout(hardTimeout);
      if (active && jobId) {
        unregisterActiveAnalystProcess(jobId, active);
      }
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      if (jobId) {
        recordJobEvent(jobId, "analyst.process_timeout", `${displayName(analystName)} process timed out.`, {
          name: analystName,
          stage,
          timeoutMs: safeTimeoutMs
        });
      }
      killProcessTree(child);
      hardTimeout = setTimeout(() => {
        finish({ exitCode: null, signal: "SIGTERM", timedOut, cancelled: active?.cancelled === true, stdout, stderr, errorCode: "TIMEOUT" });
      }, ANALYST_KILL_GRACE_MS);
    }, safeTimeoutMs);

    try {
      const env = filteredEnv(extraEnv);
      const prepared = prepareToolSpawn(command, args, env);
      child = spawn(prepared.command, prepared.args, {
        cwd,
        env,
        ...prepared.options,
        detached: process.platform !== "win32",
        windowsHide: true
      });
      child.stdin?.end();
      if (jobId) {
        active = {
          child,
          jobId,
          name: analystName,
          stage,
          cancelled: false,
          hardTimeout: null,
          stdout: () => stdout,
          stderr: () => stderr,
          finish
        };
        registerActiveAnalystProcess(jobId, active);
        recordJobEvent(jobId, "analyst.process_started", `${displayName(analystName)} process started.`, {
          name: analystName,
          stage,
          timeoutMs: safeTimeoutMs
        });
      }
    } catch (error) {
      stderr += error.message;
      finish({ exitCode: null, signal: null, timedOut, cancelled: false, stdout, stderr, errorCode: error.code || "ERROR" });
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
      finish({ exitCode: null, signal: null, timedOut, cancelled: active?.cancelled === true, stdout, stderr, errorCode: error.code || "ERROR" });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, timedOut, cancelled: active?.cancelled === true, stdout, stderr, errorCode: null });
    });
  });
}

function filteredEnv(extraEnv = {}) {
  return filteredToolEnv(extraEnv);
}

function normalizeTimeoutMs(value) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 300000;
}

function remainingTimeout(deadline, fallback) {
  const remaining = deadline - Date.now();
  return Math.max(1, Math.min(normalizeTimeoutMs(fallback), remaining));
}

function registerActiveAnalystProcess(jobId, active) {
  const key = Number(jobId);
  const processes = activeAnalystProcesses.get(key) || new Set();
  processes.add(active);
  activeAnalystProcesses.set(key, processes);
}

function unregisterActiveAnalystProcess(jobId, active) {
  const key = Number(jobId);
  const processes = activeAnalystProcesses.get(key);
  if (!processes) {
    return;
  }
  processes.delete(active);
  if (!processes.size) {
    activeAnalystProcesses.delete(key);
  }
}

function openAnalystCircuit(name, reason, metadata = {}) {
  analystCircuits.set(name, {
    reason: redactText(reason || `${displayName(name)} falhou no health-check.`),
    retryAt: Date.now() + ANALYST_CIRCUIT_OPEN_MS,
    metadata
  });
}
