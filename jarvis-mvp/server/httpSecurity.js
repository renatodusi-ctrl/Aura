import crypto from "node:crypto";

export function createSessionToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function isAllowedOrigin(origin, { host, port }) {
  if (!origin) {
    return true;
  }

  const allowedOrigins = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`
  ]);

  if (host && !["0.0.0.0", "::", "::1", "127.0.0.1", "localhost"].includes(host)) {
    allowedOrigins.add(`http://${host}:${port}`);
  }

  return allowedOrigins.has(origin);
}

export function isProtectedApiPath(pathname) {
  if (!pathname.startsWith("/api/")) {
    return false;
  }

  return !["/api/session", "/api/status", "/api/realtime/config"].includes(pathname);
}

export function validateSessionRequest({ origin, token, expectedToken, host, port }) {
  if (!isAllowedOrigin(origin, { host, port })) {
    return { ok: false, status: 403, error: "Unexpected request origin." };
  }

  if (token !== expectedToken) {
    return { ok: false, status: 401, error: "Missing or invalid AURA session token." };
  }

  return { ok: true };
}
