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
  ["draft", new Set(["awaiting_confirm", "queued", "running", "needs_input", "failed", "cancelled"])],
  ["awaiting_confirm", new Set(["queued", "needs_input", "failed", "cancelled"])],
  ["queued", new Set(["running", "needs_input", "failed", "cancelled"])],
  ["running", new Set(["needs_input", "done", "failed", "cancelled"])],
  ["needs_input", new Set(["awaiting_confirm", "queued", "running", "failed", "cancelled"])],
  ["done", new Set()],
  ["failed", new Set()],
  ["cancelled", new Set()]
]);

const COST_RATES_USD_PER_MILLION = {
  openai: {
    "gpt-realtime-2.1": {
      textInput: 4,
      textCachedInput: 0.4,
      textOutput: 24,
      audioInput: 32,
      audioCachedInput: 0.4,
      audioOutput: 64,
      imageInput: 5,
      imageCachedInput: 0.5
    },
    "gpt-realtime-2.1-mini": {
      textInput: 0.6,
      textCachedInput: 0.06,
      textOutput: 2.4,
      audioInput: 10,
      audioCachedInput: 0.3,
      audioOutput: 20,
      imageInput: 0.8,
      imageCachedInput: 0.08
    }
  }
};

const TOKEN_USAGE_KEYS = [
  "textInputTokens",
  "textCachedInputTokens",
  "textOutputTokens",
  "audioInputTokens",
  "audioCachedInputTokens",
  "audioOutputTokens",
  "imageInputTokens",
  "imageCachedInputTokens",
  "rawInputTokens",
  "rawOutputTokens"
];

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

    CREATE TABLE IF NOT EXISTS cost_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider TEXT NOT NULL,
      key_label TEXT NOT NULL,
      model TEXT NOT NULL,
      source TEXT NOT NULL,
      operation TEXT NOT NULL DEFAULT 'unknown',
      usage TEXT NOT NULL DEFAULT '{}',
      estimated_cost_usd REAL,
      metadata TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS idx_jobs_workspace ON jobs(workspace);
    CREATE INDEX IF NOT EXISTS idx_job_events_job_id ON job_events(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_job_artifacts_job_id ON job_artifacts(job_id, id);
    CREATE INDEX IF NOT EXISTS idx_cost_usage_provider ON cost_usage(provider, model, created_at);
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
  const text = redactText(String(content || "").trim());
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

export function updateMemory(id, { kind, content }) {
  const current = db.prepare(`
    SELECT id, kind, content, created_at AS createdAt, updated_at AS updatedAt
    FROM memories
    WHERE id = ?
  `).get(Number(id));
  if (!current) {
    throw new Error("Memory not found.");
  }

  const nextKind = kind === undefined ? current.kind : String(kind || "note").trim();
  const nextContent = content === undefined ? current.content : redactText(String(content || "").trim());
  if (!nextContent) {
    throw new Error("Memory content is required.");
  }

  db.prepare(`
    UPDATE memories
    SET kind = ?, content = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextKind, nextContent, Number(id));

  return db.prepare(`
    SELECT id, kind, content, created_at AS createdAt, updated_at AS updatedAt
    FROM memories
    WHERE id = ?
  `).get(Number(id));
}

export function deleteMemory(id) {
  const result = db.prepare("DELETE FROM memories WHERE id = ?").run(Number(id));
  return { deleted: result.changes > 0 };
}

export function persistentMemorySummary(limit = 12) {
  const memories = listMemories(limit)
    .map((memory) => ({
      id: memory.id,
      kind: memory.kind,
      content: redactText(memory.content),
      updatedAt: memory.updatedAt
    }));
  return {
    retention: "sqlite-explicit",
    preferences: memories.filter((item) => item.kind === "preference").slice(0, 5),
    projects: memories.filter((item) => item.kind === "project").slice(0, 5),
    decisions: memories.filter((item) => item.kind === "decision").slice(0, 5),
    notes: memories.filter((item) => item.kind === "note").slice(0, 5)
  };
}

export function listTasks(includeDone = true) {
  const query = includeDone
    ? `SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
       FROM tasks ORDER BY status = 'done', COALESCE(due_at, '9999-12-31'), id DESC`
    : `SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
       FROM tasks WHERE status != 'done' ORDER BY COALESCE(due_at, '9999-12-31'), id DESC`;
  return db.prepare(query).all();
}

export function getTask(id) {
  return db.prepare(`
    SELECT id, title, status, due_at AS dueAt, created_at AS createdAt, updated_at AS updatedAt, completed_at AS completedAt
    FROM tasks
    WHERE id = ?
  `).get(Number(id)) || null;
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

export function recordCostUsage({
  provider,
  keyLabel,
  model,
  source,
  operation = "unknown",
  usage = {},
  estimatedCostUsd,
  metadata = {}
}) {
  const normalizedUsage = normalizeCostUsage(usage);
  const normalizedMetadata = redactObject(normalizeJsonObject(metadata, "Cost metadata"));
  const cost = normalizeEstimatedCost(estimatedCostUsd) ?? estimateCostUsd(provider, model, normalizedUsage);
  const result = db.prepare(`
    INSERT INTO cost_usage (
      provider, key_label, model, source, operation, usage, estimated_cost_usd, metadata
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    String(provider || "unknown"),
    String(keyLabel || "unknown"),
    String(model || "unknown"),
    String(source || "unknown"),
    String(operation || "unknown"),
    JSON.stringify(normalizedUsage),
    cost,
    JSON.stringify(normalizedMetadata)
  );

  return getCostUsage(result.lastInsertRowid);
}

export function getCostSummary(limit = 50) {
  const rows = db.prepare(`
    SELECT
      id,
      provider,
      key_label AS keyLabel,
      model,
      source,
      operation,
      usage,
      estimated_cost_usd AS estimatedCostUsd,
      metadata,
      created_at AS createdAt
    FROM cost_usage
    ORDER BY id DESC
  `).all().map(formatCostUsage);

  const recent = rows.slice(0, limit);
  const usageTotals = sumUsage(rows);

  const totals = {
    estimatedCostUsd: sumCost(rows),
    measuredEvents: rows.length,
    unpricedEvents: rows.filter((row) => row.estimatedCostUsd === null || row.estimatedCostUsd === undefined).length,
    tokens: totalTokensFromUsage(usageTotals),
    inputTokens: inputTokensFromUsage(usageTotals),
    outputTokens: outputTokensFromUsage(usageTotals)
  };

  return {
    currency: "USD",
    totals,
    byProvider: costGroupsFromRows(rows, (row) => row.provider),
    byModel: costGroupsFromRows(rows, (row) => `${row.provider} · ${row.model}`),
    byOperation: costGroupsFromRows(rows, (row) => row.operation),
    tokenBreakdown: tokenBreakdown(rows),
    tokenSeries: costSeries(rows),
    recent,
    pricing: publicCostRates()
  };
}

function getCostUsage(id) {
  const row = db.prepare(`
    SELECT
      id,
      provider,
      key_label AS keyLabel,
      model,
      source,
      operation,
      usage,
      estimated_cost_usd AS estimatedCostUsd,
      metadata,
      created_at AS createdAt
    FROM cost_usage
    WHERE id = ?
  `).get(Number(id));
  return row ? formatCostUsage(row) : null;
}

function formatCostUsage(row) {
  return {
    ...row,
    usage: parseJson(row.usage, {}),
    metadata: parseJson(row.metadata, {})
  };
}

function normalizeCostUsage(usage) {
  const value = normalizeJsonObject(usage || {}, "Cost usage");
  return {
    textInputTokens: numberFromUsage(value.textInputTokens ?? value.inputTextTokens),
    textCachedInputTokens: numberFromUsage(value.textCachedInputTokens ?? value.cachedTextInputTokens),
    textOutputTokens: numberFromUsage(value.textOutputTokens ?? value.outputTextTokens),
    audioInputTokens: numberFromUsage(value.audioInputTokens ?? value.inputAudioTokens),
    audioCachedInputTokens: numberFromUsage(value.audioCachedInputTokens ?? value.cachedAudioInputTokens),
    audioOutputTokens: numberFromUsage(value.audioOutputTokens ?? value.outputAudioTokens),
    imageInputTokens: numberFromUsage(value.imageInputTokens ?? value.inputImageTokens),
    imageCachedInputTokens: numberFromUsage(value.imageCachedInputTokens ?? value.cachedImageInputTokens),
    rawInputTokens: numberFromUsage(value.rawInputTokens ?? value.inputTokens),
    rawOutputTokens: numberFromUsage(value.rawOutputTokens ?? value.outputTokens)
  };
}

function normalizeEstimatedCost(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Number(number.toFixed(8)) : null;
}

function costGroupsFromRows(rows, labelForRow) {
  const groups = new Map();
  for (const row of rows) {
    const label = String(labelForRow(row) || "unknown");
    const current = groups.get(label) || {
      label,
      estimatedCostUsd: 0,
      events: 0,
      tokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      unpricedEvents: 0
    };
    current.estimatedCostUsd += Number(row.estimatedCostUsd || 0);
    current.events += 1;
    current.inputTokens += inputTokensFromUsage(row.usage);
    current.outputTokens += outputTokensFromUsage(row.usage);
    current.tokens += totalTokensFromUsage(row.usage);
    if (row.estimatedCostUsd === null || row.estimatedCostUsd === undefined) {
      current.unpricedEvents += 1;
    }
    groups.set(label, current);
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      estimatedCostUsd: Number(group.estimatedCostUsd.toFixed(8))
    }))
    .sort((left, right) => (
      right.estimatedCostUsd - left.estimatedCostUsd ||
      right.tokens - left.tokens ||
      right.events - left.events ||
      left.label.localeCompare(right.label)
    ));
}

function tokenBreakdown(rows) {
  const totals = sumUsage(rows);
  const detailedInput = totals.textInputTokens + totals.textCachedInputTokens + totals.audioInputTokens + totals.audioCachedInputTokens + totals.imageInputTokens + totals.imageCachedInputTokens;
  const detailedOutput = totals.textOutputTokens + totals.audioOutputTokens;
  const items = [
    ["Texto entrada", totals.textInputTokens],
    ["Texto cache", totals.textCachedInputTokens],
    ["Texto saida", totals.textOutputTokens],
    ["Audio entrada", totals.audioInputTokens],
    ["Audio cache", totals.audioCachedInputTokens],
    ["Audio saida", totals.audioOutputTokens],
    ["Imagem entrada", totals.imageInputTokens],
    ["Imagem cache", totals.imageCachedInputTokens]
  ];
  if (!detailedInput && totals.rawInputTokens) {
    items.push(["Entrada bruta", totals.rawInputTokens]);
  }
  if (!detailedOutput && totals.rawOutputTokens) {
    items.push(["Saida bruta", totals.rawOutputTokens]);
  }
  return items
    .filter(([, tokens]) => tokens > 0)
    .map(([label, tokens]) => ({ label, tokens }));
}

function costSeries(rows) {
  const groups = new Map();
  for (const row of rows) {
    const day = String(row.createdAt || "").slice(0, 10) || "sem data";
    const current = groups.get(day) || {
      label: day,
      estimatedCostUsd: 0,
      tokens: 0,
      events: 0
    };
    current.estimatedCostUsd += Number(row.estimatedCostUsd || 0);
    current.tokens += totalTokensFromUsage(row.usage);
    current.events += 1;
    groups.set(day, current);
  }
  return Array.from(groups.values())
    .map((item) => ({ ...item, estimatedCostUsd: Number(item.estimatedCostUsd.toFixed(8)) }))
    .sort((left, right) => left.label.localeCompare(right.label))
    .slice(-14);
}

function sumUsage(rows) {
  const totals = Object.fromEntries(TOKEN_USAGE_KEYS.map((key) => [key, 0]));
  for (const row of rows) {
    for (const key of TOKEN_USAGE_KEYS) {
      totals[key] += numberFromUsage(row.usage?.[key]);
    }
  }
  return totals;
}

function sumCost(rows) {
  const total = rows.reduce((sum, row) => sum + Number(row.estimatedCostUsd || 0), 0);
  return Number(total.toFixed(8));
}

function totalTokensFromUsage(usage = {}) {
  return inputTokensFromUsage(usage) + outputTokensFromUsage(usage);
}

function inputTokensFromUsage(usage = {}) {
  const detailed =
    numberFromUsage(usage.textInputTokens) +
    numberFromUsage(usage.textCachedInputTokens) +
    numberFromUsage(usage.audioInputTokens) +
    numberFromUsage(usage.audioCachedInputTokens) +
    numberFromUsage(usage.imageInputTokens) +
    numberFromUsage(usage.imageCachedInputTokens);
  return detailed || numberFromUsage(usage.rawInputTokens);
}

function outputTokensFromUsage(usage = {}) {
  const detailed =
    numberFromUsage(usage.textOutputTokens) +
    numberFromUsage(usage.audioOutputTokens);
  return detailed || numberFromUsage(usage.rawOutputTokens);
}

function estimateCostUsd(provider, model, usage) {
  const rates = COST_RATES_USD_PER_MILLION[String(provider || "").toLowerCase()]?.[String(model || "")];
  if (!rates) {
    return null;
  }
  const total =
    usage.textInputTokens * rates.textInput +
    usage.textCachedInputTokens * rates.textCachedInput +
    usage.textOutputTokens * rates.textOutput +
    usage.audioInputTokens * rates.audioInput +
    usage.audioCachedInputTokens * rates.audioCachedInput +
    usage.audioOutputTokens * rates.audioOutput +
    usage.imageInputTokens * rates.imageInput +
    usage.imageCachedInputTokens * rates.imageCachedInput;
  return Number((total / 1_000_000).toFixed(8));
}

function publicCostRates() {
  return Object.entries(COST_RATES_USD_PER_MILLION).flatMap(([provider, models]) => (
    Object.entries(models).map(([model, rates]) => ({ provider, model, unit: "USD por 1M tokens", rates }))
  ));
}

function numberFromUsage(value) {
  const number = Number(value || 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
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

export function updateJobDraft(id, { goal, mode }) {
  const current = getJob(id);
  if (!current) {
    throw new Error("Job not found.");
  }
  if (current.status !== "draft") {
    throw new Error("Only draft jobs can be edited.");
  }

  const nextGoal = goal === undefined ? current.goal : redactText(String(goal || "").trim());
  const nextMode = mode === undefined ? current.mode : String(mode || current.mode);
  if (!nextGoal) {
    throw new Error("Job goal is required.");
  }
  if (!JOB_MODES.has(nextMode)) {
    throw new Error(`Invalid job mode: ${nextMode}`);
  }
  if (nextMode === "implement" && current.requestedBy === "routine") {
    throw new Error("Routine draft jobs cannot switch to implement mode.");
  }

  db.prepare(`
    UPDATE jobs
    SET goal = ?, mode = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(nextGoal, nextMode, Number(id));

  insertJobEvent(current.id, "job.draft_updated", "Draft job updated.", {
    goal: nextGoal,
    mode: nextMode
  });

  return getJob(id);
}

export function updateJobMetadata(id, patch = {}) {
  const current = getJob(id);
  if (!current) {
    throw new Error("Job not found.");
  }

  const normalizedPatch = redactObject(normalizeJsonObject(patch, "Job metadata patch"));
  const nextMetadata = {
    ...(current.metadata || {}),
    ...normalizedPatch
  };

  db.prepare(`
    UPDATE jobs
    SET metadata = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(JSON.stringify(nextMetadata), Number(id));

  insertJobEvent(current.id, "job.metadata_updated", "Job metadata updated.", {
    keys: Object.keys(normalizedPatch)
  });

  return getJob(id);
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

export function deleteJobArtifact(jobId, artifactId, { allowedKinds = [] } = {}) {
  const artifact = db.prepare(`
    SELECT id, job_id AS jobId, kind, label
    FROM job_artifacts
    WHERE id = ? AND job_id = ?
  `).get(Number(artifactId), Number(jobId));

  if (!artifact) {
    throw new Error("Artifact not found.");
  }
  if (allowedKinds.length && !allowedKinds.includes(artifact.kind)) {
    throw new Error(`Artifact ${artifact.kind} cannot be removed by this route.`);
  }

  const result = db.prepare("DELETE FROM job_artifacts WHERE id = ? AND job_id = ?").run(Number(artifactId), Number(jobId));
  insertJobEvent(jobId, "job.artifact_removed", `Artifact removed: ${artifact.label}.`, {
    artifactId: artifact.id,
    kind: artifact.kind,
    label: artifact.label
  });
  return { deleted: result.changes > 0, artifact: formatJobArtifact({ ...artifact, metadata: "{}", content: "", createdAt: null }) };
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
