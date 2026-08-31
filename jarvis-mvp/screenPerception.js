export const DEFAULT_SCREEN_PERCEPTION_MS = 300000;
export const MIN_SCREEN_PERCEPTION_MS = 60000;
export const MAX_SCREEN_PERCEPTION_MS = 900000;

export function normalizePerceptionDurationMs(value) {
  const durationMs = Number(value);
  if (Number.isFinite(durationMs) && durationMs >= MIN_SCREEN_PERCEPTION_MS && durationMs <= MAX_SCREEN_PERCEPTION_MS) {
    return durationMs;
  }
  return DEFAULT_SCREEN_PERCEPTION_MS;
}

export function createScreenPerception({ now = Date.now(), durationMs = DEFAULT_SCREEN_PERCEPTION_MS, purpose }) {
  const normalizedDuration = normalizePerceptionDurationMs(durationMs);
  return {
    startedAt: now,
    expiresAt: now + normalizedDuration,
    durationMs: normalizedDuration,
    purpose: purpose || "Observacao temporaria consentida do cockpit"
  };
}

export function remainingPerceptionMs(session, now = Date.now()) {
  if (!session?.expiresAt) {
    return 0;
  }
  return Math.max(0, session.expiresAt - now);
}

export function isPerceptionExpired(session, now = Date.now()) {
  return Boolean(session?.expiresAt && now >= session.expiresAt);
}

export function finishScreenPerception(session, { now = Date.now(), reason = "manual" } = {}) {
  if (!session) {
    return null;
  }
  const durationMs = Math.max(0, now - session.startedAt);
  return {
    purpose: session.purpose,
    reason,
    durationMs,
    rawFramesPersisted: false,
    endedAt: new Date(now).toISOString(),
    text: `${session.purpose}; encerrada por ${labelForPerceptionEnd(reason)} apos ${formatDurationMs(durationMs)}; frames crus nao persistidos.`
  };
}

export function labelForPerceptionEnd(reason) {
  const labels = {
    browser: "controle do navegador",
    expired: "expiracao",
    failed: "falha",
    manual: "acao do operador"
  };
  return labels[reason] || reason;
}

export function formatCountdown(ms) {
  const totalSeconds = Math.max(0, Math.ceil(Number(ms) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

function formatDurationMs(value) {
  if (!Number.isFinite(value) || value <= 0) {
    return "0 segundos";
  }
  const seconds = Math.round(value / 1000);
  if (seconds < 60) {
    return `${seconds} segundos`;
  }
  const minutes = Math.round(seconds / 60);
  return `${minutes} minutos`;
}
