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
    input: finalPrompt
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

  const latest = getJob(job.id);
  const finalSummary = buildImplementSummary({
    status: latest.status,
    lastMessage,
    changedFiles: changedFileList,
    testResult,
    result
  });
  const finalJob = updateJobStatus(job.id, latest.status, {
    summary: finalSummary,
    error: latest.status === "failed" ? latest.error : null
  });

  recordJobEvent(job.id, "codex.implement.finished", "Codex implement finished with artifacts.", {
    status: finalJob.status,
    changedFiles: changedFileList,
    testCommand: normalizedTestCommand,
    testExitCode: testResult?.exitCode ?? null
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

  if (job.status !== "awaiting_confirm") {
    throw new Error(`Codex implement cannot run while job status is ${job.status}.`);
  }

  if (!confirmed) {
    throw new Error("Codex implement requires explicit visual confirmation.");
  }
}

function assertNoBlockedImplementIntent(values) {
  const text = values.filter(Boolean).join("\n");
  for (const entry of BLOCKED_IMPLEMENT_PATTERNS) {
    if (entry.pattern.test(text)) {
      throw new Error(`Blocked command in Codex implement request: ${entry.name}.`);
    }
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

function buildImplementSummary({ status, lastMessage, changedFiles, testResult, result }) {
  const files = changedFiles.length ? changedFiles.join(", ") : "no files reported by git diff";
  const commands = ["codex exec --sandbox workspace-write"];
  if (testResult) {
    commands.push(`test command exit ${testResult.exitCode}`);
  }
  const codexOutcome = status === "done" ? "Codex implementation completed." : `Codex implementation ended as ${status}.`;
  return [
    lastMessage || codexOutcome,
    `Changed files: ${files}.`,
    `Relevant commands: ${commands.join("; ")}.`,
    result.timedOut ? "Codex process timed out." : ""
  ].filter(Boolean).join(" ");
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

function captureCommand(command, args, cwd, timeoutMs = 10000) {
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

    const child = spawn(command, args, {
      cwd,
      env: filteredProbeEnv(),
      windowsHide: true
    });
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
