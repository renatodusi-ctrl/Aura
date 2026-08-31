import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const demoDoc = fs.readFileSync(path.join(root, "docs", "DEMO_JARVIS.md"), "utf8");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

for (const token of [
  "Voice Standby",
  "Mission HUD",
  "Conselho Decision",
  "Confirmable Implementation",
  "Privacy Controls",
  "Re-score",
  "Recording Checklist",
  "npm run demo:seed",
  "npm run verify"
]) {
  assert.match(demoDoc, new RegExp(token), `Missing demo token: ${token}`);
}

assert.equal(packageJson.scripts["demo:seed"], "node scripts/demo-seed.mjs");

const { stdout } = await execFileAsync(process.execPath, ["scripts/demo-seed.mjs", "--dry-run"], {
  cwd: root
});
const payload = JSON.parse(stdout);
assert.equal(payload.ok, true);
assert.equal(payload.mutations, false);
assert.equal(payload.scenes.length, 4);
assert.ok(payload.scenes.some((scene) => scene.id === "voice-standby"));
assert.ok(payload.scenes.some((scene) => scene.id === "council-briefing"));
assert.ok(payload.scenes.some((scene) => scene.id === "confirmable-implementation"));
assert.ok(payload.scenes.some((scene) => scene.id === "privacy-recovery"));

console.log("Demo suite verification passed.");
