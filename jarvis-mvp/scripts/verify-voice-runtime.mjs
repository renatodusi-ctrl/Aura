import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  classifyTurnTaking,
  createVoiceMetrics,
  isAssistantSpeaking,
  markVoiceMetric,
  voiceDirectiveForText
} from "../voiceRuntime.js";

const root = path.resolve(import.meta.dirname, "..");
const realtime = fs.readFileSync(path.join(root, "realtime.js"), "utf8");

let metrics = createVoiceMetrics("gemini");
metrics = markVoiceMetric(metrics, { type: "capture-requested", provider: "gemini" }, 100);
assert.equal(metrics.turnState, "connecting");
metrics = markVoiceMetric(metrics, { type: "microphone-ready" }, 180);
assert.equal(metrics.turnState, "listening");
assert.equal(metrics.captureLatencyMs, 80);

metrics = markVoiceMetric(metrics, { type: "user-input", text: "Aura status da demanda 38" }, 300);
assert.equal(metrics.turnTakingMode, "quick_command");
assert.equal(metrics.summaryMode, true);
metrics = markVoiceMetric(metrics, { type: "assistant-first-output" }, 420);
assert.equal(metrics.turnState, "speaking");
assert.equal(metrics.firstResponseLatencyMs, 120);
assert.equal(isAssistantSpeaking(metrics), true);

metrics = markVoiceMetric(metrics, { type: "barge-in" }, 450);
assert.equal(metrics.turnState, "listening");
assert.equal(metrics.interruptions, 1);
metrics = markVoiceMetric(metrics, { type: "late-response-dropped" }, 460);
assert.equal(metrics.lateResponsesDropped, 1);

metrics = markVoiceMetric(metrics, { type: "assistant-first-output" }, 500);
metrics = markVoiceMetric(metrics, { type: "assistant-output-done" }, 900);
assert.equal(metrics.turnState, "listening");
assert.equal(metrics.conclusionLatencyMs, 600);
assert.equal(metrics.lastSpokenDurationMs, 400);

assert.deepEqual(classifyTurnTaking("Aura, resuma isso em poucas frases"), {
  mode: "summary_request",
  shouldSummarize: true
});
assert.deepEqual(classifyTurnTaking("Aura liste arquivos"), {
  mode: "quick_command",
  shouldSummarize: true
});
assert.equal(classifyTurnTaking("Vamos pensar com calma e comparar os riscos desta arquitetura em detalhes para evoluir a plataforma").mode, "long_conversation");
assert.match(voiceDirectiveForText("Aura seja breve"), /ate 3 frases curtas/);

for (const token of [
  "requestMicrophoneStream",
  "echoCancellation",
  "noiseSuppression",
  "autoGainControl",
  "captureSilence",
  "assistantGain",
  "GEMINI_PLAYBACK_LEAD_SECONDS",
  "GEMINI_PLAYBACK_RAMP_SECONDS",
  "GEMINI_CONTINUOUS_QUEUE_THRESHOLD_SECONDS",
  "GEMINI_RESUME_BUFFER_SECONDS",
  "GEMINI_RESUME_MAX_WAIT_MS",
  "pendingAudioBuffers",
  "scheduleGeminiPlayback",
  "flushGeminiPlayback",
  "scheduleAudioBufferSource",
  "clearPendingGeminiAudio",
  "aura.audio.playback_buffer_refilled",
  "shouldSuppressMicrophoneForPlayback",
  "aura.audio.capture_suppressed_during_playback",
  "autoGainControl: { ideal: false }",
  "aura.audio.capture_constraints"
]) {
  assert.ok(realtime.includes(token), `Missing voice audio stability token: ${token}`);
}

console.log("Voice runtime verification passed.");
