import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const rubric = fs.readFileSync(path.join(root, "docs", "JARVIS_RUBRIC.md"), "utf8");
const index = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const analyst = fs.readFileSync(path.join(root, "server", "analystAdapter.js"), "utf8");
const smoke = fs.readFileSync(path.join(root, "scripts", "verify-job-smoke.mjs"), "utf8");

for (const token of [
  "Presence and voice",
  "Continuity and memory",
  "Safe initiative",
  "Honest perception",
  "Council briefing",
  "Confirmable Codex execution",
  "Now HUD",
  "Reliability floor",
  "Any hanging job",
  "Fixed Scenarios",
  "6.5/10"
]) {
  assert.match(rubric, new RegExp(token), `Missing JARVIS rubric token: ${token}`);
}

for (const token of [
  "/api/now",
  "buildNowSnapshot",
  "nextStepForJob",
  "nowPresence",
  "actionId",
  "source",
  "confidence",
  "severity",
  "jobRef",
  "ctaForJob",
  "normalizeAnalystBudget",
  "progressive"
]) {
  assert.match(index, new RegExp(token), `Missing Now backend token: ${token}`);
}

for (const token of [
  "now-hud",
  "dataset.severity",
  "renderNowHud",
  "runNowAction",
  "progressive: safeRounds > 1"
]) {
  assert.match(app, new RegExp(token), `Missing Now HUD token: ${token}`);
}

for (const token of [
  "cancelAnalystJobProcess",
  "analystCircuitState",
  "analyst.process_timeout",
  "analyst.cancel_requested",
  "circuit_open"
]) {
  assert.match(analyst, new RegExp(token), `Missing analyst reliability token: ${token}`);
}

assert.match(smoke, /Smoke cancel hanging analyst job/);
assert.match(smoke, /analyst\.process_started/);
assert.match(smoke, /\/api\/now/);

console.log("JARVIS rubric verification passed.");
