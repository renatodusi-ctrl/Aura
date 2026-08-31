import { spawn } from "node:child_process";
import {
  getJob,
  recordJobEvent,
  updateJobStatus
} from "./memory.js";
import { filteredToolEnv, killProcessTree, prepareToolSpawn } from "./processTools.js";

const activeProcesses = new Map();
const OUTPUT_CHUNK_LIMIT = 12000;

export async function runJobCommand({
  jobId,
  command,
  args = [],
  cwd,
  timeoutMs = 300000,
  env = {},
  input = "",
  finalize = true
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
    const processEnv = filteredEnv(env);
    const prepared = prepareToolSpawn(command, args, processEnv);
    const child = spawn(prepared.command, prepared.args, {
      cwd: workingDirectory,
      env: processEnv,
      ...prepared.options,
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
      killProcessTree(child);
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

    if (input) {
      child.stdin?.end(input);
    } else {
      child.stdin?.end();
    }

    child.on("close", (exitCode, signal) => {
      clearTimeout(active.timeout);
      activeProcesses.delete(job.id);

      let finalJob;
      if (!finalize) {
        finalJob = getJob(job.id);
      } else {
        finalJob = finalizeProcessJob(job.id, {
          exitCode,
          signal,
          timedOut: active.timedOut,
          cancelled: active.cancelled,
          timeoutMs
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

function finalizeProcessJob(jobId, { exitCode, signal, timedOut, cancelled, timeoutMs }) {
  if (timedOut) {
    return updateJobStatus(jobId, "failed", {
      error: `Process timed out after ${timeoutMs}ms.`,
      summary: "Process timed out."
    });
  }
  if (cancelled) {
    return updateJobStatus(jobId, "cancelled", {
      summary: "Process cancelled."
    });
  }
  if (exitCode === 0) {
    return updateJobStatus(jobId, "done", {
      summary: "Process completed successfully."
    });
  }
  return updateJobStatus(jobId, "failed", {
    error: `Process exited with code ${exitCode ?? "unknown"}${signal ? ` and signal ${signal}` : ""}.`,
    summary: "Process failed."
  });
}

export function cancelJobProcess(jobId) {
  const active = activeProcesses.get(Number(jobId));
  if (!active) {
    return false;
  }

  active.cancelled = true;
  recordJobEvent(active.jobId, "process.cancel_requested", "Process cancellation requested.", {});
  killProcessTree(active.child);
  return true;
}

export function hasActiveJobProcess(jobId) {
  return activeProcesses.has(Number(jobId));
}

export function activeJobProcessSummary() {
  const jobs = [...activeProcesses.values()].map((active) => ({
    jobId: active.jobId,
    timedOut: active.timedOut,
    cancelled: active.cancelled,
    stdoutBytes: active.stdout.length,
    stderrBytes: active.stderr.length
  }));
  return {
    total: jobs.length,
    jobs
  };
}

function filteredEnv(extraEnv = {}) {
  return filteredToolEnv(extraEnv);
}

function truncateOutput(text) {
  if (text.length <= OUTPUT_CHUNK_LIMIT) {
    return text;
  }
  return `${text.slice(0, OUTPUT_CHUNK_LIMIT)}...[truncated]`;
}
