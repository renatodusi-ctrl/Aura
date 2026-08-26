import { spawn } from "node:child_process";
import {
  getJob,
  recordJobEvent,
  updateJobStatus
} from "./memory.js";

const activeProcesses = new Map();
const OUTPUT_CHUNK_LIMIT = 12000;

export async function runJobCommand({
  jobId,
  command,
  args = [],
  cwd,
  timeoutMs = 300000,
  env = {}
}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }

  if (activeProcesses.has(job.id)) {
    throw new Error(`Job ${job.id} already has an active process.`);
  }

  const workingDirectory = cwd || job.workspace;
  const started = updateJobStatus(job.id, "running");
  recordJobEvent(job.id, "process.started", "Process started.", {
    command,
    args,
    cwd: workingDirectory,
    timeoutMs
  });

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: workingDirectory,
      env: filteredEnv(env),
      detached: process.platform !== "win32",
      windowsHide: true
    });

    const active = {
      child,
      jobId: job.id,
      timeout: null,
      timedOut: false,
      cancelled: false,
      stdout: "",
      stderr: ""
    };
    activeProcesses.set(job.id, active);

    active.timeout = setTimeout(() => {
      active.timedOut = true;
      recordJobEvent(job.id, "process.timeout", "Process timed out.", { timeoutMs });
      killChild(child);
    }, timeoutMs);

    child.stdout?.on("data", (chunk) => {
      const text = chunk.toString();
      active.stdout += text;
      recordJobEvent(job.id, "process.stdout", "Process stdout.", { chunk: truncateOutput(text) });
    });

    child.stderr?.on("data", (chunk) => {
      const text = chunk.toString();
      active.stderr += text;
      recordJobEvent(job.id, "process.stderr", "Process stderr.", { chunk: truncateOutput(text) });
    });

    child.on("error", (error) => {
      active.stderr += error.message;
      recordJobEvent(job.id, "process.error", "Process failed to start.", { error: error.message });
    });

    child.on("close", (exitCode, signal) => {
      clearTimeout(active.timeout);
      activeProcesses.delete(job.id);

      let finalJob;
      if (active.timedOut) {
        finalJob = updateJobStatus(job.id, "failed", {
          error: `Process timed out after ${timeoutMs}ms.`,
          summary: "Process timed out."
        });
      } else if (active.cancelled) {
        finalJob = updateJobStatus(job.id, "cancelled", {
          summary: "Process cancelled."
        });
      } else if (exitCode === 0) {
        finalJob = updateJobStatus(job.id, "done", {
          summary: "Process completed successfully."
        });
      } else {
        finalJob = updateJobStatus(job.id, "failed", {
          error: `Process exited with code ${exitCode ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`,
          summary: "Process failed."
        });
      }

      recordJobEvent(job.id, "process.finished", "Process finished.", {
        exitCode,
        signal,
        timedOut: active.timedOut,
        cancelled: active.cancelled
      });

      resolve({
        job: finalJob,
        started,
        exitCode,
        signal,
        timedOut: active.timedOut,
        cancelled: active.cancelled,
        stdout: active.stdout,
        stderr: active.stderr
      });
    });
  });
}

export function cancelJobProcess(jobId) {
  const active = activeProcesses.get(Number(jobId));
  if (!active) {
    return false;
  }

  active.cancelled = true;
  recordJobEvent(active.jobId, "process.cancel_requested", "Process cancellation requested.", {});
  killChild(active.child);
  return true;
}

export function hasActiveJobProcess(jobId) {
  return activeProcesses.has(Number(jobId));
}

function filteredEnv(extraEnv = {}) {
  const allowed = {};
  for (const name of ["PATH", "HOME", "USER", "TMPDIR", "TEMP", "TMP", "SystemRoot", "ComSpec", "PATHEXT"]) {
    if (process.env[name]) {
      allowed[name] = process.env[name];
    }
  }
  return { ...allowed, ...extraEnv };
}

function killChild(child) {
  if (child.killed) {
    return;
  }

  try {
    if (process.platform === "win32") {
      child.kill("SIGTERM");
    } else {
      process.kill(-child.pid, "SIGTERM");
    }
  } catch {
    child.kill("SIGTERM");
  }
}

function truncateOutput(text) {
  if (text.length <= OUTPUT_CHUNK_LIMIT) {
    return text;
  }
  return `${text.slice(0, OUTPUT_CHUNK_LIMIT)}...[truncated]`;
}
