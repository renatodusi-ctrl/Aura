import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";
import { redactObject, redactText } from "./redaction.js";

let db;

const JOB_MODES = new Set(["ask", "analyze", "implement"]);
const JOB_STATUSES = new Set(["draft", "awaiting_confirm", "queued", "running", "needs_input", "done", "failed", "cancelled"]);
const POLICY_LEVELS = new Set(["read", "write", "git", "network", "secrets", "destructive"]);
const WRITER_POLICY_LEVELS = new Set(["write", "git"]);
const REQUEST_SOURCES = new Set(["text", "voice", "routine"]);
const TERMINAL_JOB_STATUSES = new Set(["done", "failed", "cancelled"]);
const JOB_STATUS_TRANSITIONS = new Map([
  ["draft", new Set(["awaiting_confirm", "queued", "running", "failed", "cancelled"])],
  ["awaiting_confirm", new Set(["queued", "failed", "cancelled"])],
  ["queued", new Set(["running", "failed", "cancelled"])],
  ["running", new Set(["needs_input", "done", "failed", "cancelled"])],
  ["needs_input", new Set(["running", "failed", "cancelled"])],
  ["done", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()]
]);

export function initMemory() {
  db = new DatabaseSync(config.databasePath);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL DEFAULT 'note',
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'open',
      due_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS tool_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      output TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      goal TEXT NOT NULL,
      workspace TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'ask'
        CHECK (mode IN ('ask', 'analyze', 'implement')),
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'awaiting_confirm', 'queued', 'running', 'needs_input', 'done', 'failed', 'cancelled')),
      requested_by TEXT NOT NULL DEFAULT 'text'
        CHECK (requested_by IN ('text', 'voice', 'routine')),
      policy_level TEXT NOT NULL DEFAULT 'read'
        CHECK (policy_level IN ('read', 'write', 'git', 'network', 'secrets', 'destructive')),
      requires_confirmation INTEGER NOT NULL DEFAULT 0
        CHECK (requires_confirmation IN (0, 1)),
      timeout_ms INTEGER NOT NULL DEFAULT 300000,
      error TEXT,
      summary TEXT,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      started_at TEXT,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS job_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      type TEXT NOT NULL,
      message TEXT,
      data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS job_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id INTEGER NOT NULL,
      kind TEXT NOT NULL,
      label TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace);
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_id ON job_artifacts(job_id, id);
  `);
}

export function getStatus() {
  const memoryCount = db.prepare("SELECT COUNT(*) AS count FROM memories").get().count;
  const openTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open'").get().count;
  const completedTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'done'").get().count;
  const jobCount = db.prepare("SELECT COUNT(*) AS count FROM jobs").get().count;
  const runningJobs = db.prepare("SELECT COUNT(*) AS count FROM jobs WHERE status = 'running'").get().count;
  return {
    database: config.databasePath,
    memoryCount,
    openTasks,
    completedTasks,
    jobCount,
    runningJobs
  };
}

export function listMemories(limit = 50) {
  return db.prepare(`
    SELECT id, kind, content, created_at AS createdAt, updated_at AS updatedAt
    FROM memories
    ORDER BY id DESC
    LIMIT ?
  `).all(limit);
}

export function addMemory({ kind = "note", content }) {
  const text = String(content || "").trim();
  if (!text) {
    throw new Error("Memory content is required.");
  }

  const result = db.prepare("INSERT INTO memories (kind, content) VALUES (?, ?)").run(kind, text);
  return db.prepare(`
    SELECT id, kind, content, created_at AS createdAt, updated_at AS updatedAt
    FROM memories
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

export function deleteMemory(id) {
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(Number(id));
  return { deleted: result.changes > 0 };
}

export function listTasks(includeDone = true) {
  const query = includeDone
    ? `SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
       FROM tasks ORDER BY status = 'done', COALESCE(due_at, '9999-12-31'), id DESC`
    : `SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
       FROM tasks WHERE status != 'done' ORDER BY COALESCE(due_at, '9999-12-31'), id DESC`;
  return db.prepare(query).all();
}

export function addTask({ title, dueAt = null }) {
  const text = String(title || "").trim();
  if (!text) {
    throw new Error("Task title is required.");
  }

  const result = db.prepare("INSERT INTO tasks (title, due_at) VALUES (?, ?)").run(text, dueAt || null);
  return db.prepare(`
    SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
    FROM tasks
    WHERE id = ?
  `).get(result.lastInsertRowid);
}

export function updateTask(id, patch) {
  const taskId = Number(id);
  const current = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
  if (!current) {
    throw new Error("Task not found.");
  }

  const title = patch.title === undefined ? current.title : String(patch.title).trim();
  const status = patch.status === undefined ? current.status : String(patch.status);
  const dueAt = patch.dueAt === undefined ? current.due_at : patch.dueAt || null;
  const completedAt = status === "done" ? current.completed_at || new Date().toISOString() : null;

  db.prepare(`
    UPDATE tasks
    SET title = ?, status = ?, due_at = ?, completed_at = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(title, status, dueAt, completedAt, taskId);

  return db.prepare(`
    SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
    FROM tasks
    WHERE id = ?
  `).get(taskId);
}

export function deleteTask(id) {
  const result = db.prepare("DELETE FROM tasks WHERE id = ?").run(Number(id));
  return { deleted: result.changes > 0 };
}

export function recordToolRun(name, status, input, output) {
  db.prepare("INSERT INTO tool_runs (name, status, input, output) VALUES (?, ?, ?, ?)").run(
    name,
    status,
    JSON.stringify(redactObject(input || {})),
    JSON.stringify(redactObject(output || {}))
  );
}

export function createJob({
  goal,
  workspace,
  mode = "ask",
  status = "draft",
  requestedBy = "text",
  policyLevel = "read",
  requiresConfirmation = false,
  timeoutMs = 300000,
  metadata = {}
}) {
  const normalized = normalizeJobInput({ goal, workspace, mode, status, requestedBy, policyLevel, timeoutMs });
  const normalizedMetadata = redactObject(normalizeJsonObject(metadata, "Job metadata"));
  if (normalized.status !== "draft") {
    throw new Error("New jobs must start as draft.");
  }

  const jobId = withTransaction(() => {
    assertWorkspaceWriterAvailable(normalized.workspace, normalized.policyLevel);

    const result = db.prepare(`
      INSERT INTO jobs (
        goal, workspace, mode, status, requested_by, policy_level,
        requires_confirmation, timeout_ms, metadata
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalized.goal,
      normalized.workspace,
      normalized.mode,
      normalized.status,
      normalized.requestedBy,
      normalized.policyLevel,
      requiresConfirmation ? 1 : 0,
      normalized.timeoutMs,
      JSON.stringify(normalizedMetadata)
    );

    insertJobEvent(result.lastInsertRowid, "job.created", "Job created.", {
      status: normalized.status,
      mode: normalized.mode,
      policyLevel: normalized.policyLevel
    });
    return Number(result.lastInsertRowid);
  });

  return getJob(jobId);
}

export function listJobs(limit = 50) {
  return db.prepare(`
    SELECT ${jobSelectColumns()}
    FROM jobs
    ORDER BY id DESC
    LIMIT ?
  `).all(limit).map(formatJob);
}

export function getJob(id) {
  const job = db.prepare(`
    SELECT ${jobSelectColumns()}
    FROM jobs
    WHERE id = ?
  `).get(Number(id));
  return job ? formatJob(job) : null;
}

export function getActiveWorkspaceWriter(workspace, excludeId = null) {
  const writer = db.prepare(`
    SELECT ${jobSelectColumns()}
    FROM jobs
    WHERE workspace = ?
      AND policy_level IN ('write', 'git')
      AND status NOT IN ('done', 'failed', 'cancelled')
      AND (? IS NULL OR id != ?)
    ORDER BY id ASC
    LIMIT 1
  `).get(String(workspace), excludeId, excludeId);
  return writer ? formatJob(writer) : null;
}

export function listJobEvents(jobId) {
  return db.prepare(`
    SELECT
      id,
      job_id AS jobId,
      type,
      message,
      data,
      created_at AS createdAt
    FROM job_events
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(Number(jobId)).map(formatJobEvent);
}

export function recordJobEvent(jobId, type, message = "", data = {}) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }

  return insertJobEvent(jobId, type, message, data);
}

export function createJobArtifact(jobId, { kind, label, content = "", metadata = {} }) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }

  const normalizedMetadata = redactObject(normalizeJsonObject(metadata, "Job artifact metadata"));
  const result = db.prepare(`
    INSERT INTO job_artifacts (job_id, kind, label, content, metadata)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    Number(jobId),
    String(kind || "artifact"),
    redactText(String(label || kind || "Artifact")),
    redactText(String(content || "")),
    JSON.stringify(normalizedMetadata)
  );

  const artifact = db.prepare(`
    SELECT
      id,
      job_id AS jobId,
      kind,
      label,
      content,
      metadata,
      created_at AS createdAt
    FROM job_artifacts
    WHERE id = ?
  `).get(result.lastInsertRowid);

  insertJobEvent(jobId, "job.artifact_created", `Artifact created: ${artifact.label}.`, {
    artifactId: artifact.id,
    kind: artifact.kind,
    label: artifact.label
  });

  return formatJobArtifact(artifact);
}

export function listJobArtifacts(jobId) {
  return db.prepare(`
    SELECT
      id,
      job_id AS jobId,
      kind,
      label,
      content,
      metadata,
      created_at AS createdAt
    FROM job_artifacts
    WHERE job_id = ?
    ORDER BY id ASC
  `).all(Number(jobId)).map(formatJobArtifact);
}

export function updateJobStatus(id, status, patch = {}) {
  if (!JOB_STATUSES.has(status)) {
    throw new Error(`Invalid job status: ${status}`);
  }

  const current = getJob(id);
  if (!current) {
    throw new Error("Job not found.");
  }

  assertJobTransition(current.status, status);

  const nextError = Object.hasOwn(patch, "error") ? patch.error : current.error;
  const nextSummary = Object.hasOwn(patch, "summary") ? patch.summary : current.summary;

  withTransaction(() => {
    if (!TERMINAL_JOB_STATUSES.has(status)) {
      assertWorkspaceWriterAvailable(current.workspace, current.policyLevel, current.id);
    }

    db.prepare(`
      UPDATE jobs
      SET
        status = ?,
        error = ?,
        summary = ?,
        started_at = CASE
          WHEN ? = 'running' AND started_at IS NULL THEN datetime('now')
          ELSE started_at
        END,
        finished_at = CASE
          WHEN ? IN ('done', 'failed', 'cancelled') THEN datetime('now')
          ELSE finished_at
        END,
        updated_at = datetime('now')
      WHERE id = ?
    `).run(status, nextError, nextSummary, status, status, Number(id));

    insertJobEvent(current.id, "job.status_changed", `Job status changed to ${status}.`, {
      from: current.status,
      to: status,
      error: nextError,
      summary: nextSummary
    });
  });

  return getJob(id);
}

function insertJobEvent(jobId, type, message = "", data = {}) {
  const normalizedData = redactObject(normalizeJsonObject(data, "Job event data"));
  const result = db.prepare(`
    INSERT INTO job_events (job_id, type, message, data)
    VALUES (?, ?, ?, ?)
  `).run(Number(jobId), String(type || "job.event"), message ? redactText(message) : null, JSON.stringify(normalizedData));

  const event = db.prepare(`
    SELECT
      id,
      job_id AS jobId,
      type,
      message,
      data,
      created_at AS createdAt
    FROM job_events
    WHERE id = ?
  `).get(result.lastInsertRowid);
  return formatJobEvent(event);
}

function normalizeJobInput({ goal, workspace, mode, status, requestedBy = "text", policyLevel, timeoutMs }) {
  const normalizedGoal = redactText(String(goal || "").trim());
  const normalizedWorkspace = String(workspace || "").trim();
  const normalizedRequestedBy = String(requestedBy || "text");

  if (!normalizedGoal) {
    throw new Error("Job goal is required.");
  }

  if (!normalizedWorkspace) {
    throw new Error("Job workspace is required.");
  }

  if (!JOB_MODES.has(mode)) {
    throw new Error(`Invalid job mode: ${mode}`);
  }

  if (!JOB_STATUSES.has(status)) {
    throw new Error(`Invalid job status: ${status}`);
  }

  if (!REQUEST_SOURCES.has(normalizedRequestedBy)) {
    throw new Error(`Invalid job request source: ${requestedBy}`);
  }

  if (!POLICY_LEVELS.has(policyLevel)) {
    throw new Error(`Invalid job policy level: ${policyLevel}`);
  }

  const parsedTimeout = Number.parseInt(timeoutMs, 10);
  if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
    throw new Error("Job timeout must be a positive integer.");
  }

  return {
    goal: normalizedGoal,
    workspace: normalizedWorkspace,
    mode,
    status,
    requestedBy: normalizedRequestedBy,
    policyLevel,
    timeoutMs: parsedTimeout
  };
}

function assertJobTransition(from, to) {
  if (from === to) {
    return;
  }

  const allowed = JOB_STATUS_TRANSITIONS.get(from);
  if (!allowed?.has(to)) {
    const terminalHint = TERMINAL_JOB_STATUSES.has(from) ? " Terminal job statuses cannot transition." : "";
    throw new Error(`Invalid job status transition: ${from} -> ${to}.${terminalHint}`);
  }
}

function assertWorkspaceWriterAvailable(workspace, policyLevel, excludeId = null) {
  if (!WRITER_POLICY_LEVELS.has(policyLevel)) {
    return;
  }

  const lockedBy = getActiveWorkspaceWriter(workspace, excludeId);
  if (!lockedBy) {
    return;
  }

  const error = new Error(`Workspace is locked by writer job ${lockedBy.id}: ${workspace}`);
  error.code = "WORKSPACE_LOCKED";
  error.lockedBy = lockedBy;
  throw error;
}

function withTransaction(callback) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = callback();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function normalizeJsonObject(value, label) {
  const parsed = typeof value === "string" ? parseJson(value, null) : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }
  return parsed;
}

function jobSelectColumns() {
  return `
    id,
    goal,
    workspace,
    mode,
    status,
    requested_by AS requestedBy,
    policy_level AS policyLevel,
    requires_confirmation AS requiresConfirmation,
    timeout_ms AS timeoutMs,
    error,
    summary,
    metadata,
    created_at AS createdAt,
    updated_at AS updatedAt,
    started_at AS startedAt,
    finished_at AS finishedAt
  `;
}

function formatJob(job) {
  return {
    ...job,
    requiresConfirmation: Boolean(job.requiresConfirmation),
    metadata: parseJson(job.metadata, {})
  };
}

function formatJobEvent(event) {
  return {
    ...event,
    data: parseJson(event.data, {})
  };
}

function formatJobArtifact(artifact) {
  return {
    ...artifact,
    metadata: parseJson(artifact.metadata, {})
  };
}

function parseJson(value, fallback) {
  try {
    return JSON.parse(value || "");
  } catch {
    return fallback;
  }
}
