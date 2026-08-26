import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");

for (const id of ["job-list", "job-detail", "jobs-refresh-button"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const pattern of [
  /api\("\/api\/jobs\?limit=20"\)/,
  /api\(`\/api\/jobs\/\$\{state\.selectedJobId\}`\)/,
  /api\(`\/api\/jobs\/\$\{job\.id\}\/cancel`/
]) {
  assert.match(app, pattern);
}

for (const token of [
  "workspace",
  "mode",
  "policyLevel",
  "selectedJobEvents",
  "selectedJobArtifacts",
  "canCancelJob",
  "canConfirmImplementJob",
  "codex/implement",
  "renderJobArtifact",
  "renderImplementationApproval",
  "analysts/run",
  "renderAnalystConsent",
  "buildAnalystPreview",
  "Gemini",
  "Grok"
]) {
  assert.match(app, new RegExp(token), `Missing jobs UI token: ${token}`);
}

console.log("Jobs UI verification passed.");
