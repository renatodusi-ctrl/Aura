import assert from "node:assert/strict";
import {
  DEFAULT_SCREEN_PERCEPTION_MS,
  createScreenPerception,
  finishScreenPerception,
  formatCountdown,
  isPerceptionExpired,
  normalizePerceptionDurationMs,
  remainingPerceptionMs
} from "../screenPerception.js";

const startedAt = Date.parse("2026-08-31T12:00:00.000Z");
const session = createScreenPerception({
  now: startedAt,
  durationMs: 60000,
  purpose: "Acompanhar demanda #36"
});

assert.equal(session.purpose, "Acompanhar demanda #36");
assert.equal(session.expiresAt, startedAt + 60000);
assert.equal(remainingPerceptionMs(session, startedAt + 15000), 45000);
assert.equal(isPerceptionExpired(session, startedAt + 59999), false);
assert.equal(isPerceptionExpired(session, startedAt + 60000), true);
assert.equal(formatCountdown(61000), "01:01");

const finished = finishScreenPerception(session, {
  now: startedAt + 27000,
  reason: "manual"
});
assert.equal(finished.rawFramesPersisted, false);
assert.equal(finished.reason, "manual");
assert.match(finished.text, /Acompanhar demanda #36/);
assert.match(finished.text, /frames crus nao persistidos/);

const expired = finishScreenPerception(session, {
  now: startedAt + 61000,
  reason: "expired"
});
assert.match(expired.text, /expiracao/);

assert.equal(normalizePerceptionDurationMs(1000), DEFAULT_SCREEN_PERCEPTION_MS);
assert.equal(normalizePerceptionDurationMs(900000), 900000);
assert.equal(normalizePerceptionDurationMs("invalid"), DEFAULT_SCREEN_PERCEPTION_MS);

console.log("Screen perception verification passed.");
