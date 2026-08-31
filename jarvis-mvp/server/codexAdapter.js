import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { DATA_DIR } from "./config.js";
import {
  createJobArtifact,
  getJob,
  listJobArtifacts,
  listJobEvents,
  recordJobEvent,
  updateJobStatus
} from "./memory.js";
import { runJobCommand } from "./supervisor.js";
import { filteredToolEnv, prepareToolSpawn } from "./processTools.js";

const DEFAULT_CODEX_BIN = "codex";
const BLOCKED_IMPLEMENT_PATTERNS = [
  { name: "git push", pattern: /\bgit\s+push\b/i },
  { name: "git reset", pattern: /\bgit\s+reset\b/i },
  { name: "dangerous remove", pattern: /\brm\s+-rf\s+(?:\/|\.|\*)/i },
  { name: "windows recursive delete", pattern: /\b(?:del|rmdir)\s+\/[sq]\b/i }
];

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

export async function runCodexImplement({
  jobId,
  prompt,
  confirmed = false,
  bin = process.env.AURA_CODEX_BIN || DEFAULT_CODEX_BIN,
  timeoutMs,
  testCommand
}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }

  assertImplementJob(job, confirmed);
  assertNoBlockedImplementIntent([job.goal, prompt, metadataText(job.metadata), commandText(testCommand)]);

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
      artifacts: listJobArtifacts(job.id),
      events: listJobEvents(job.id)
    };
  }

  const queued = updateJobStatus(job.id, "queued", {
    summary: "Implementation approved for Codex execution."
  });
  const finalPrompt = buildImplementPrompt(prompt || job.goal, queued);
  const outputPath = process.env.AURA_CODEX_LAST_MESSAGE_PATH || path.join(DATA_DIR, `aura-codex-implement-${job.id}-${Date.now()}.txt`);
  const args = [
    "exec",
    "--cd",
    queued.workspace,
    "--sandbox",
    "workspace-write",
    "--color",
    "never",
    "--output-last-message",
    outputPath,
    "-"
  ];

  recordJobEvent(job.id, "codex.implement.started", "Codex implement started after visual confirmation.", {
    bin: codex.bin,
    version: codex.version,
    sandbox: "workspace-write",
    cwd: queued.workspace,
    blockedCommands: BLOCKED_IMPLEMENT_PATTERNS.map((entry) => entry.name)
  });

  const result = await runJobCommand({
    jobId: job.id,
    command: codex.bin,
    args,
    cwd: queued.workspace,
    timeoutMs: timeoutMs || queued.timeoutMs,
    input: finalPrompt,
    finalize: false
  });

  const lastMessage = readOptionalFile(outputPath);
  removeOptionalFile(outputPath);

  const artifacts = [];
  artifacts.push(createJobArtifact(job.id, {
    kind: "codex-log",
    label: "Codex stdout",
    content: result.stdout,
    metadata: { command: codex.bin, args, exitCode: result.exitCode, signal: result.signal }
  }));

  if (result.stderr) {
    artifacts.push(createJobArtifact(job.id, {
      kind: "codex-log",
      label: "Codex stderr",
      content: result.stderr,
      metadata: { command: codex.bin, args, exitCode: result.exitCode, signal: result.signal }
    }));
  }

  if (lastMessage) {
    artifacts.push(createJobArtifact(job.id, {
      kind: "codex-summary",
      label: "Codex final message",
      content: lastMessage,
      metadata: { source: "output-last-message" }
    }));
  }

  const diff = await captureCommand("git", ["diff", "--"], queued.workspace, 10000);
  artifacts.push(createJobArtifact(job.id, {
    kind: "diff",
    label: "Workspace diff",
    content: diff.stdout || diff.stderr,
    metadata: { command: "git", args: ["diff", "--"], exitCode: diff.exitCode }
  }));

  const changedFiles = await captureCommand("git", ["diff", "--name-only", "--"], queued.workspace, 10000);
  const changedFileList = changedFiles.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  artifacts.push(createJobArtifact(job.id, {
    kind: "changed-files",
    label: "Changed files",
    content: changedFileList.join("\n"),
    metadata: { files: changedFileList, exitCode: changedFiles.exitCode }
  }));

  const normalizedTestCommand = normalizeTestCommand(testCommand, queued.workspace);
  let testResult = null;
  if (result.exitCode === 0 && normalizedTestCommand) {
    recordJobEvent(job.id, "codex.implement.tests_started", "Post-implementation test command started.", normalizedTestCommand);
    testResult = await captureCommand(normalizedTestCommand.command, normalizedTestCommand.args, queued.workspace, normalizedTestCommand.timeoutMs);
    artifacts.push(createJobArtifact(job.id, {
      kind: "test-log",
      label: "Test log",
      content: [testResult.stdout, testResult.stderr].filter(Boolean).join("\n"),
      metadata: {
        command: normalizedTestCommand.command,
        args: normalizedTestCommand.args,
        exitCode: testResult.exitCode,
        signal: testResult.signal,
        timedOut: testResult.timedOut
      }
    }));
  }

  const criticReview = buildCriticReview({
    job: queued,
    changedFiles: changedFileList,
    diff: diff.stdout || diff.stderr || "",
    testResult,
    result
  });
  const processStatus = statusFromImplementProcess(result);
  const processError = errorFromImplementProcess(result, timeoutMs || queued.timeoutMs);
  const finalStatus = finalStatusForImplement({ processStatus, criticGate: criticReview.gate });
  artifacts.push(createJobArtifact(job.id, {
    kind: "critic-review",
    label: "AURA critic review",
    content: criticReview.content,
    metadata: {
      source: "local-rules",
      gate: criticReview.gate,
      risks: criticReview.risks,
      changedFiles: changedFileList,
      testExitCode: testResult?.exitCode ?? null,
      codexExitCode: result.exitCode
    }
  }));

  if (finalStatus === "needs_input") {
    const rollbackPlan = buildRollbackPlan({
      job: queued,
      changedFiles: changedFileList,
      diff: diff.stdout || diff.stderr || "",
      criticReview
    });
    const independentCriticBrief = buildIndependentCriticBrief({
      job: queued,
      changedFiles: changedFileList,
      diff: diff.stdout || diff.stderr || "",
      testResult,
      criticReview
    });
    artifacts.push(createJobArtifact(job.id, {
      kind: "rollback-plan",
      label: "Safe rollback plan",
      content: rollbackPlan,
      metadata: {
        strategy: "operator-reviewed",
        destructiveCommandsUsed: false,
        changedFiles: changedFileList,
        criticGate: criticReview.gate
      }
    }));
    artifacts.push(createJobArtifact(job.id, {
      kind: "independent-critic-brief",
      label: "Independent critic brief",
      content: independentCriticBrief,
      metadata: {
        status: "ready_for_read_only_review",
        criticGate: criticReview.gate,
        suggestedReviewer: "codex-ask-or-analyst"
      }
    }));
    const independentReview = await runIndependentCriticReview({
      codex,
      job: queued,
      brief: independentCriticBrief,
      timeoutMs: Math.min(timeoutMs || queued.timeoutMs || 120000, 120000)
    });
    artifacts.push(createJobArtifact(job.id, {
      kind: "independent-critic-review",
      label: "Independent critic review",
      content: independentReview.content,
      metadata: {
        source: "codex-read-only",
        attempted: true,
        exitCode: independentReview.exitCode,
        signal: independentReview.signal,
        timedOut: independentReview.timedOut
      }
    }));
  }

  const finalError = errorForImplementFinalStatus({ finalStatus, processError, criticReview });
  const finalSummary = buildImplementSummary({
    status: finalStatus,
    lastMessage,
    changedFiles: changedFileList,
    testResult,
    result,
    criticReview
  });
  const finalJob = updateJobStatus(job.id, finalStatus, {
    summary: finalSummary,
    error: finalError
  });

  recordJobEvent(job.id, "codex.implement.finished", "Codex implement finished with artifacts.", {
    status: finalJob.status,
    changedFiles: changedFileList,
    testCommand: normalizedTestCommand,
    testExitCode: testResult?.exitCode ?? null,
    criticReview: true,
    qualityGate: criticReview.gate
  });

  return {
    job: finalJob,
    codex,
    result: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      stdout: result.stdout,
      stderr: result.stderr,
      lastMessage,
      changedFiles: changedFileList,
      testResult
    },
    artifacts: listJobArtifacts(job.id),
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

function assertImplementJob(job, confirmed) {
  if (job.mode !== "implement") {
    throw new Error("Codex implement requires a job with mode=implement.");
  }

  if (job.policyLevel !== "write") {
    throw new Error("Codex implement requires policyLevel=write.");
  }

  if (job.status !== "awaiting_confirm" && job.status !== "needs_input") {
    throw new Error(`Codex implement cannot run while job status is ${job.status}.`);
  }

  if (!confirmed) {
    throw new Error("Codex implement requires explicit visual confirmation.");
  }
}

function assertNoBlockedImplementIntent(values) {
  const text = values.filter(Boolean).join("\n");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    for (const entry of BLOCKED_IMPLEMENT_PATTERNS) {
      if (entry.pattern.test(trimmed) && !isBlockedCommandProhibition(trimmed)) {
        throw new Error(`Blocked command in Codex implement request: ${entry.name}.`);
      }
    }
  }
}

function statusFromImplementProcess(result) {
  if (result.cancelled) {
    return "cancelled";
  }
  if (result.timedOut || result.exitCode !== 0) {
    return "failed";
  }
  return "done";
}

function errorFromImplementProcess(result, timeoutMs) {
  if (result.cancelled) {
    return null;
  }
  if (result.timedOut) {
    return `Process timed out after ${timeoutMs}ms.`;
  }
  if (result.exitCode !== 0) {
    return `Process exited with code ${result.exitCode ?? "unknown"}${result.signal ? ` and signal ${result.signal}` : ""}.`;
  }
  return null;
}

function finalStatusForImplement({ processStatus, criticGate }) {
  if (processStatus !== "done") {
    return processStatus;
  }
  if (criticGate === "block" || criticGate === "review") {
    return "needs_input";
  }
  return "done";
}

function errorForImplementFinalStatus({ finalStatus, processError, criticReview }) {
  if (processError) {
    return processError;
  }
  if (finalStatus === "needs_input") {
    if (criticReview.gate === "block") {
      return `AURA critic gate blocked completion: ${criticReview.risks.join(" ") || "review required"}`;
    }
    return `AURA critic gate requires human review: ${criticReview.risks.join(" ") || "limited confidence"}`;
  }
  return null;
}

function isBlockedCommandProhibition(line) {
  return /\b(?:do not|don't|dont|never|avoid|blocked|prohibited|sem|nao|não|evite|bloqueado|proibido)\b/i.test(line);
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

function buildImplementPrompt(prompt, job) {
  const plan = job.metadata?.plan || job.metadata?.planSummary || "Follow the user's approved implementation request.";
  const likelyFiles = Array.isArray(job.metadata?.likelyFiles) ? job.metadata.likelyFiles.join(", ") : String(job.metadata?.likelyFiles || "");
  return [
    "You are Codex running inside AURA in confirmed implement mode.",
    "The user approved this write job through the AURA cockpit before execution.",
    "Stay inside the pinned workspace and make the smallest useful code changes.",
    "Do not run git push, git reset, destructive delete commands, credential commands, or commands outside the approved workspace.",
    "Do not create commits. Leave changes in the workspace for AURA to inspect.",
    "When done, summarize changed files and relevant commands/tests.",
    "",
    `Workspace: ${job.workspace}`,
    `Approved plan: ${plan}`,
    likelyFiles ? `Likely files: ${likelyFiles}` : "Likely files: not provided",
    "",
    String(prompt || "").trim()
  ].join("\n");
}

function buildImplementSummary({ status, lastMessage, changedFiles, testResult, result, criticReview }) {
  const files = changedFiles.length ? changedFiles.join(", ") : "no files reported by git diff";
  const commands = ["codex exec --sandbox workspace-write"];
  if (testResult) {
    commands.push(`test command exit ${testResult.exitCode}`);
  }
  const codexOutcome = status === "done" ? "Codex implementation completed." : `Codex implementation ended as ${status}.`;
  const gateSummary = criticReview?.gate ? `AURA critic gate: ${criticReview.gate}.` : "";
  return [
    lastMessage || codexOutcome,
    `Changed files: ${files}.`,
    `Relevant commands: ${commands.join("; ")}.`,
    gateSummary,
    result.timedOut ? "Codex process timed out." : ""
  ].filter(Boolean).join(" ");
}

function buildCriticReview({ job, changedFiles, diff, testResult, result }) {
  const plan = job.metadata?.plan || job.metadata?.planSummary || "No approved plan captured.";
  const checks = [];
  checks.push(result.exitCode === 0
    ? "Codex process exited successfully."
    : `Codex process exited with code ${result.exitCode}.`);
  checks.push(changedFiles.length
    ? `Workspace diff reports changed files: ${changedFiles.join(", ")}.`
    : "Workspace diff reports no changed files.");
  if (testResult) {
    checks.push(testResult.exitCode === 0
      ? "Post-implementation test command passed."
      : `Post-implementation test command failed with code ${testResult.exitCode}.`);
  } else {
    checks.push("No post-implementation test command ran.");
  }

  const risks = [];
  if (!changedFiles.length && result.exitCode === 0) {
    risks.push("Codex reported success but no file changes were detected.");
  }
  if (testResult && testResult.exitCode !== 0) {
    risks.push("The implementation needs follow-up because tests did not pass.");
  }
  if (!testResult) {
    risks.push("Confidence is limited because no automated verification ran after implementation.");
  }
  if (!String(diff || "").trim()) {
    risks.push("No diff content is available for review.");
  }
  const gate = criticGateFor({ risks, testResult, result, changedFiles });

  const content = [
    "# AURA Critic Review",
    "",
    `Job: #${job.id}`,
    `Approved plan: ${plan}`,
    `Quality gate: ${gate}`,
    "",
    "## Checks",
    ...checks.map((item) => `- ${item}`),
    "",
    "## Risks",
    ...(risks.length ? risks.map((item) => `- ${item}`) : ["- No immediate local critic risks found."]),
    "",
    "## Recommendation",
    risks.length
      ? "Review the risks above before treating this demand as complete."
      : "Treat this demand as locally verified; external critic review is optional."
  ].join("\n");
  return { content, gate, risks };
}

function buildRollbackPlan({ job, changedFiles, diff, criticReview }) {
  const files = changedFiles.length ? changedFiles.map((file) => `- ${file}`) : ["- No changed files reported."];
  const hasDiff = Boolean(String(diff || "").trim());
  return [
    "# Safe Rollback Plan",
    "",
    `Job: #${job.id}`,
    `Critic gate: ${criticReview.gate}`,
    "",
    "## Changed Files",
    ...files,
    "",
    "## Operator Steps",
    "- Review the diff artifact before accepting or reverting any change.",
    "- If the change is useful, add a recovery note and resume the implementation from the cockpit.",
    "- If the change is unsafe, revert only the listed files manually or in a separate confirmed job.",
    "- Do not run broad reset/clean commands; keep rollback scoped to the listed files.",
    "",
    "## Diff Availability",
    hasDiff
      ? "A diff artifact is available for targeted review."
      : "No diff content was captured; inspect the workspace before deciding."
  ].join("\n");
}

function buildIndependentCriticBrief({ job, changedFiles, diff, testResult, criticReview }) {
  return [
    "# Independent Critic Brief",
    "",
    "Review this implementation in read-only mode. Do not edit files.",
    "",
    `Job: #${job.id}`,
    `Goal: ${job.goal}`,
    `Approved plan: ${job.metadata?.plan || job.metadata?.planSummary || "No approved plan captured."}`,
    `Local critic gate: ${criticReview.gate}`,
    "",
    "## Changed Files",
    ...(changedFiles.length ? changedFiles.map((file) => `- ${file}`) : ["- No changed files reported."]),
    "",
    "## Local Critic Risks",
    ...(criticReview.risks.length ? criticReview.risks.map((risk) => `- ${risk}`) : ["- No local critic risks found."]),
    "",
    "## Test Result",
    testResult ? `Exit code: ${testResult.exitCode}` : "No automated verification ran.",
    "",
    "## Review Questions",
    "- Does the diff match the approved plan?",
    "- Are there hidden regressions or missing tests?",
    "- Should the operator resume, revise the plan, or roll back the listed files?",
    "",
    "## Diff Excerpt",
    String(diff || "").trim().slice(0, 6000) || "No diff content captured."
  ].join("\n");
}

async function runIndependentCriticReview({ codex, job, brief, timeoutMs }) {
  const outputPath = path.join(DATA_DIR, `aura-independent-critic-${job.id}-${Date.now()}.txt`);
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
  recordJobEvent(job.id, "critic.independent_started", "Independent critic started in read-only mode.", {
    source: "codex-read-only",
    sandbox: "read-only"
  });
  const result = await captureCommand(codex.bin, args, job.workspace, timeoutMs, brief);
  const lastMessage = readOptionalFile(outputPath);
  removeOptionalFile(outputPath);
  const content = [
    lastMessage,
    result.stdout,
    result.stderr
  ].filter(Boolean).join("\n").trim() || "Independent critic produced no text.";

  recordJobEvent(job.id, "critic.independent_finished", "Independent critic finished.", {
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    hasContent: Boolean(content)
  });

  return {
    content,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut
  };
}

function criticGateFor({ risks, testResult, result, changedFiles }) {
  if (result.exitCode !== 0 || testResult?.exitCode > 0) {
    return "block";
  }
  if (!changedFiles.length || risks.length) {
    return "review";
  }
  return "pass";
}

function metadataText(metadata = {}) {
  return JSON.stringify({
    plan: metadata.plan || metadata.planSummary || "",
    risk: metadata.risk || "",
    likelyFiles: metadata.likelyFiles || []
  });
}

function commandText(testCommand) {
  if (!testCommand) {
    return "";
  }
  if (typeof testCommand === "string") {
    return testCommand;
  }
  return [testCommand.command, ...(Array.isArray(testCommand.args) ? testCommand.args : [])].join(" ");
}

function normalizeTestCommand(testCommand, workspace) {
  if (testCommand === false) {
    return null;
  }

  if (testCommand && typeof testCommand === "object") {
    const command = String(testCommand.command || "").trim();
    if (!command) {
      throw new Error("testCommand.command is required when testCommand is provided.");
    }
    const args = Array.isArray(testCommand.args) ? testCommand.args.map(String) : [];
    assertNoBlockedImplementIntent([command, args.join(" ")]);
    return {
      command,
      args,
      timeoutMs: Number.parseInt(testCommand.timeoutMs, 10) || 120000
    };
  }

  if (fs.existsSync(path.join(workspace, "package.json"))) {
    return {
      command: process.platform === "win32" ? "npm.cmd" : "npm",
      args: ["run", "verify"],
      timeoutMs: 120000
    };
  }

  return null;
}

function captureCommand(command, args, cwd, timeoutMs = 10000, input = "") {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const env = filteredProbeEnv();
    const prepared = prepareToolSpawn(command, args, env);
    const child = spawn(prepared.command, prepared.args, {
      cwd,
      env,
      ...prepared.options,
      windowsHide: true
    });
    if (input) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      stderr += error.message;
      finish({ exitCode: null, signal: null, timedOut, stdout, stderr });
    });
    child.on("close", (exitCode, signal) => {
      finish({ exitCode, signal, timedOut, stdout, stderr });
    });
  });
}

function runProbe(command, args) {
  return new Promise((resolve) => {
    const child = import("node:child_process").then(({ spawn }) => {
      const env = filteredProbeEnv();
      const prepared = prepareToolSpawn(command, args, env);
      const proc = spawn(prepared.command, prepared.args, {
        env,
        ...prepared.options,
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
  return filteredToolEnv();
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
