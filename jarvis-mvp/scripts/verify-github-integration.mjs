import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { normalizeGitHubIssue, normalizeGitHubRepo } from "../server/githubAdapter.js";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const config = fs.readFileSync(path.join(root, "server", "config.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

assert.equal(normalizeGitHubRepo("renatodusi-ctrl/Aura"), "renatodusi-ctrl/Aura");
assert.equal(normalizeGitHubRepo("https://github.com/renatodusi-ctrl/Aura.git"), "renatodusi-ctrl/Aura");
assert.equal(normalizeGitHubRepo("git@github.com:renatodusi-ctrl/Aura.git"), "renatodusi-ctrl/Aura");

assert.deepEqual(normalizeGitHubIssue({
  number: 43,
  title: "Conselho deve exigir evidencias",
  state: "OPEN",
  labels: [{ name: "priority:p0" }],
  author: { login: "rdusi01" },
  createdAt: "2026-08-31T00:00:00Z",
  updatedAt: "2026-08-31T01:00:00Z",
  url: "https://github.com/renatodusi-ctrl/Aura/issues/43",
  body: "sem segredo"
}), {
  number: 43,
  title: "Conselho deve exigir evidencias",
  state: "open",
  labels: [{ name: "priority:p0" }],
  author: "rdusi01",
  createdAt: "2026-08-31T00:00:00Z",
  updatedAt: "2026-08-31T01:00:00Z",
  url: "https://github.com/renatodusi-ctrl/Aura/issues/43",
  body: "sem segredo"
});

for (const token of [
  "AURA_GITHUB_REPO",
  "githubRepo"
]) {
  assert.match(config, new RegExp(token), `Missing config token ${token}`);
}

for (const token of [
  "/api/github/status",
  "/api/github/issues",
  "importGitHubIssueTaskRoute",
  "listGitHubIssues",
  "getGitHubIssue"
]) {
  assert.match(server, new RegExp(token), `Missing server token ${token}`);
}

for (const id of ["github-refresh-button", "github-state-select", "github-panel"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} in app.js.`);
}

for (const token of [
  'data-session-tab="github"',
  'data-session-panel="github"',
  "GitHub Issues",
  "Virar task",
  "integrationItemForGitHub",
  "/api/github/issues/${issue.number}/import-task"
]) {
  assert.ok(`${html}\n${app}`.includes(token), `Missing GitHub UI token ${token}`);
}

for (const token of [
  "github-panel",
  "github-summary",
  "github-issue-list",
  "button-link"
]) {
  assert.ok(css.includes(token), `Missing GitHub CSS token ${token}`);
}

console.log("GitHub integration verification passed.");
