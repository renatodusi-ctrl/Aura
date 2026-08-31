import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
import { listJobEvents, listJobs } from "./memory.js";
import { detectCodex } from "./codexAdapter.js";

const MAX_DIRECTORY_ENTRIES = 200;
const ACTIVE_STATUSES = new Set(["draft", "awaiting_confirm", "needs_input", "queued", "running"]);

export function localRootsPayload() {
  const roots = allowedRoots();
  return {
    enabled: roots.length > 0,
    roots: roots.map((root, index) => rootPayload(root, index))
  };
}

export function listLocalFolder({ rootId = 0, relativePath = "." } = {}) {
  const roots = allowedRoots();
  const root = roots[Number(rootId)];
  if (!root) {
    throw Object.assign(new Error("Local root is not allowed."), { statusCode: 403 });
  }

  const target = resolveWithinRoot(root, relativePath);
  const stat = fs.statSync(target);
  if (!stat.isDirectory()) {
    throw Object.assign(new Error("Local path is not a directory."), { statusCode: 400 });
  }

  const entries = fs.readdirSync(target, { withFileTypes: true })
    .filter((entry) => !entry.name.startsWith("."))
    .slice(0, MAX_DIRECTORY_ENTRIES)
    .map((entry) => entryPayload(root, target, entry))
    .sort((a, b) => Number(b.type === "directory") - Number(a.type === "directory") || a.name.localeCompare(b.name));

  return {
    roots: roots.map((item, index) => rootPayload(item, index)),
    root: rootPayload(root, Number(rootId)),
    path: path.relative(root.realPath, target) || ".",
    parent: parentRelativePath(root, target),
    truncated: entries.length >= MAX_DIRECTORY_ENTRIES,
    entries
  };
}

export async function codexActivityPayload() {
  const codex = await detectCodex();
  const jobs = listJobs(100)
    .filter((job) => isCodexRelatedJob(job))
    .map((job) => ({
      id: job.id,
      goal: job.goal,
      status: job.status,
      mode: job.mode,
      policyLevel: job.policyLevel,
      workspace: job.workspace,
      summary: job.summary,
      error: job.error,
      updatedAt: job.updatedAt,
      active: ACTIVE_STATUSES.has(job.status),
      lastCodexEvent: latestCodexEvent(job.id)
    }));

  return {
    codex,
    active: jobs.filter((job) => job.active),
    recent: jobs.slice(0, 12)
  };
}

function allowedRoots() {
  return config.localReadRoots
    .map((rootPath) => {
      try {
        const realPath = fs.realpathSync(rootPath);
        const stat = fs.statSync(realPath);
        return stat.isDirectory() ? { path: rootPath, realPath } : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function rootPayload(root, id) {
  return {
    id,
    path: root.path,
    realPath: root.realPath,
    label: path.basename(root.realPath) || root.realPath
  };
}

function resolveWithinRoot(root, relativePath) {
  const requested = String(relativePath || ".").trim() || ".";
  if (path.isAbsolute(requested)) {
    throw Object.assign(new Error("Use relative paths inside the allowed root."), { statusCode: 400 });
  }
  const target = fs.realpathSync(path.resolve(root.realPath, requested));
  const relative = path.relative(root.realPath, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw Object.assign(new Error("Path escapes allowed local root."), { statusCode: 403 });
  }
  return target;
}

function entryPayload(root, parentPath, entry) {
  const absolutePath = path.join(parentPath, entry.name);
  const stat = fs.statSync(absolutePath);
  return {
    name: entry.name,
    type: entry.isDirectory() ? "directory" : "file",
    path: path.relative(root.realPath, absolutePath) || ".",
    size: entry.isDirectory() ? null : stat.size,
    updatedAt: stat.mtime.toISOString()
  };
}

function parentRelativePath(root, target) {
  if (target === root.realPath) {
    return null;
  }
  return path.relative(root.realPath, path.dirname(target)) || ".";
}

function isCodexRelatedJob(job) {
  const metadata = job.metadata || {};
  const executor = String(metadata.executor || metadata.intent || "").toLowerCase();
  return job.mode === "implement" || executor.includes("codex");
}

function latestCodexEvent(jobId) {
  return [...listJobEvents(jobId)]
    .reverse()
    .find((event) => String(event.type || "").includes("codex")) || null;
}
