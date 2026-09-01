import assert from "node:assert/strict";
import { isAllowedOrigin, isProtectedApiPath, validateSessionRequest } from "../server/httpSecurity.js";

const config = { host: "127.0.0.1", port: 5173 };

assert.equal(isAllowedOrigin(undefined, config), true);
assert.equal(isAllowedOrigin("http://127.0.0.1:5173", config), true);
assert.equal(isAllowedOrigin("http://localhost:5173", config), true);
assert.equal(isAllowedOrigin("http://evil.local:5173", config), false);
assert.equal(isAllowedOrigin("https://evil.example", config), false);

assert.equal(isProtectedApiPath("/api/context"), true);
assert.equal(isProtectedApiPath("/api/jobs"), true);
assert.equal(isProtectedApiPath("/api/github/issues"), true);
assert.equal(isProtectedApiPath("/api/terminal/run"), true);
assert.equal(isProtectedApiPath("/api/status"), false);
assert.equal(isProtectedApiPath("/api/session"), false);

assert.deepEqual(validateSessionRequest({
  origin: "http://evil.local:5173",
  token: "ok",
  expectedToken: "ok",
  ...config
}), { ok: false, status: 403, error: "Unexpected request origin." });

assert.deepEqual(validateSessionRequest({
  origin: "http://127.0.0.1:5173",
  token: "bad",
  expectedToken: "ok",
  ...config
}), { ok: false, status: 401, error: "Missing or invalid AURA session token." });

console.log("HTTP security verification passed.");
