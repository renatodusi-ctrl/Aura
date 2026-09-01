import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { listTerminalDiagnostics, runTerminalDiagnostic } from "../server/terminalAdapter.js";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const server = fs.readFileSync(path.join(root, "server", "index.js"), "utf8");
const tools = fs.readFileSync(path.join(root, "server", "tools.js"), "utf8");

const diagnostics = listTerminalDiagnostics();
const ids = diagnostics.map((diagnostic) => diagnostic.id);
assert.ok(ids.includes("node.version"), "Node.js diagnostic should be available.");
assert.ok(ids.includes("codex.version"), "Codex diagnostic should be available.");
assert.ok(ids.includes("aura.env.presence"), "Environment presence diagnostic should be available.");

const envPresence = runTerminalDiagnostic("aura.env.presence");
assert.equal(envPresence.ok, true);
assert.match(envPresence.stdout, /OPENAI_API_KEY status (configured|missing)/);
assert.doesNotMatch(envPresence.stdout, /sk-[A-Za-z0-9_-]{12,}/);
assert.doesNotMatch(envPresence.stdout, /gh[opsu]_[A-Za-z0-9_]{12,}/);

assert.throws(
  () => runTerminalDiagnostic("rm -rf /"),
  /allowlisted/,
  "Terminal diagnostics must reject non-allowlisted IDs."
);

for (const token of [
  "terminal-refresh-button",
  "terminal-panel",
  "renderTerminalDiagnostics",
  "/api/terminal/commands",
  "/api/terminal/run",
  "Terminal seguro"
]) {
  assert.ok(`${html}\n${app}\n${server}`.includes(token), `Missing terminal integration token: ${token}`);
}

assert.ok(tools.includes("terminal.diagnostics"), "Terminal diagnostic tool should be listed in AURA tools.");

console.log("Terminal integration verification passed.");
