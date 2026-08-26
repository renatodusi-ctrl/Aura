import assert from "node:assert/strict";
import { redactObject, redactText } from "../server/redaction.js";

assert.equal(redactText("OPENAI_API_KEY=sk-abcdefghijklmnop"), "OPENAI_API_KEY=[REDACTED]");
assert.equal(redactText("/tmp/project/.env"), "[REDACTED_ENV_PATH]");

const redacted = redactObject({
  apiKey: "sk-abcdefghijklmnop",
  nested: {
    path: "/tmp/project/.env",
    text: "GITHUB_TOKEN=ghp_abcdefghijklmnop"
  }
});

assert.equal(redacted.apiKey, "[REDACTED]");
assert.equal(redacted.nested.path, "[REDACTED_ENV_PATH]");
assert.equal(redacted.nested.text, "GITHUB_TOKEN=[REDACTED]");

console.log("Redaction verification passed.");
