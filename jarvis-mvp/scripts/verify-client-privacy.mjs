import assert from "node:assert/strict";
import { redactClientObject, redactClientText } from "../clientPrivacy.js";

assert.equal(redactClientText("OPENAI_API_KEY=sk-proj-secretvalue123456"), "OPENAI_API_KEY=[REDACTED]");
assert.equal(redactClientText("arquivo /tmp/app/.env.local"), "arquivo [REDACTED_ENV_PATH]");
assert.equal(redactClientText("token ghp_abcdefghijklmnop"), "token [REDACTED_GITHUB_TOKEN]");
assert.equal(redactClientText("data:image/png;base64,abc123=="), "[REDACTED_ATTACHMENT_DATA]");

const redacted = redactClientObject({
  text: "use sk-proj-secretvalue123456",
  audioDataUrl: "data:audio/webm;base64,abc123",
  nested: {
    apiToken: "secret",
    note: "sem segredo"
  }
});

assert.equal(redacted.text, "use [REDACTED_OPENAI_KEY]");
assert.equal(redacted.audioDataUrl, "[REDACTED]");
assert.equal(redacted.nested.apiToken, "[REDACTED]");
assert.equal(redacted.nested.note, "sem segredo");

console.log("Client privacy verification passed.");
