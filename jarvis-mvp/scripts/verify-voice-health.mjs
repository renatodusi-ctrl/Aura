import assert from "node:assert/strict";
import { buildVoiceHealth } from "../server/voiceHealth.js";

const baseConfig = {
  openaiApiKey: "",
  geminiApiKey: "",
  voiceProvider: "openai",
  realtimeModel: "gpt-realtime-2.1",
  realtimeVoice: "cedar",
  geminiLiveModel: "gemini-3.1-flash-live-preview",
  geminiLiveVoice: "Vindemiatrix"
};

const fallback = buildVoiceHealth(baseConfig);
assert.equal(fallback.status, "fallback");
assert.equal(fallback.enabled, false);
assert.equal(fallback.provider, "openai");
assert.equal(fallback.keyLabel, "OPENAI_API_KEY");
assert.equal(fallback.probe.network, false);
assert.match(fallback.fallbackReason, /OPENAI_API_KEY/);
assert.doesNotMatch(JSON.stringify(fallback), /sk-/);

const openai = buildVoiceHealth({ ...baseConfig, openaiApiKey: "sk-test-redacted" });
assert.equal(openai.status, "realtime");
assert.equal(openai.enabled, true);
assert.equal(openai.providerLabel, "OpenAI Realtime");
assert.equal(openai.fallbackReason, "");
assert.doesNotMatch(JSON.stringify(openai), /sk-test-redacted/);

const gemini = buildVoiceHealth({
  ...baseConfig,
  voiceProvider: "gemini",
  geminiApiKey: "AIza-test-redacted"
});
assert.equal(gemini.status, "realtime");
assert.equal(gemini.provider, "gemini");
assert.equal(gemini.keyLabel, "GEMINI_API_KEY");
assert.equal(gemini.model, "gemini-3.1-flash-live-preview");
assert.equal(gemini.voice, "Vindemiatrix");
assert.equal(gemini.probe.type, "local_config");
assert.doesNotMatch(JSON.stringify(gemini), /AIza-test-redacted/);

const invalid = buildVoiceHealth({ ...baseConfig, voiceProvider: "unknown" });
assert.equal(invalid.status, "configuration_error");
assert.equal(invalid.enabled, false);
assert.equal(invalid.provider, "local");
assert.equal(invalid.configurationError, "VOICE_PROVIDER_INVALID");
assert.match(invalid.fallbackReason, /openai ou gemini/);

console.log("Voice health verification passed.");
