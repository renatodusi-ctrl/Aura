import { DatabaseSync } from "node:sqlite";
import { config } from "./config.js";

let db;

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
  `);
}

export function getStatus() {
  const memoryCount = db.prepare("SELECT COUNT(*) AS count FROM memories").get().count;
  const openTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'open'").get().count;
  const completedTasks = db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE status = 'done'").get().count;
  return {
    database: config.databasePath,
    memoryCount,
    openTasks,
    completedTasks
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
    JSON.stringify(input || {}),
    JSON.stringify(output || {})
  );
}
