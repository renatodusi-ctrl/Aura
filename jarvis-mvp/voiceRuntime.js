export function createVoiceMetrics(provider = "unknown") {
  return {
    provider,
    turnState: "idle",
    captureLatencyMs: null,
    firstResponseLatencyMs: null,
    conclusionLatencyMs: null,
    lastSpokenDurationMs: null,
    interruptions: 0,
    lateResponsesDropped: 0,
    turnTakingMode: "standby",
    summaryMode: false,
    captureRequestedAt: null,
    microphoneReadyAt: null,
    lastUserInputAt: null,
    lastAssistantStartedAt: null,
    lastAssistantDoneAt: null,
    updatedAt: new Date().toISOString()
  };
}

export function markVoiceMetric(metrics, event, now = performanceNow()) {
  const next = {
    ...metrics,
    updatedAt: new Date().toISOString()
  };

  if (event.type === "capture-requested") {
    next.provider = event.provider || next.provider;
    next.captureRequestedAt = now;
    next.turnState = "connecting";
  }

  if (event.type === "microphone-ready") {
    next.microphoneReadyAt = now;
    next.captureLatencyMs = elapsed(next.captureRequestedAt, now);
    next.turnState = "listening";
  }

  if (event.type === "user-input") {
    const turn = classifyTurnTaking(event.text || "");
    next.lastUserInputAt = now;
    next.turnTakingMode = turn.mode;
    next.summaryMode = turn.shouldSummarize || next.summaryMode;
    next.turnState = "listening";
  }

  if (event.type === "assistant-first-output") {
    next.lastAssistantStartedAt = next.lastAssistantStartedAt || now;
    next.firstResponseLatencyMs = elapsed(next.lastUserInputAt, now);
    next.turnState = "speaking";
  }

  if (event.type === "assistant-output-done") {
    next.lastAssistantDoneAt = now;
    next.conclusionLatencyMs = elapsed(next.lastUserInputAt, now);
    next.lastSpokenDurationMs = elapsed(next.lastAssistantStartedAt, now);
    next.lastAssistantStartedAt = null;
    next.turnState = "listening";
  }

  if (event.type === "barge-in") {
    next.interruptions += 1;
    next.turnState = "listening";
    next.lastAssistantStartedAt = null;
  }

  if (event.type === "late-response-dropped") {
    next.lateResponsesDropped += 1;
    next.turnState = "listening";
  }

  if (event.type === "closed") {
    next.turnState = "idle";
    next.captureRequestedAt = null;
    next.microphoneReadyAt = null;
    next.lastUserInputAt = null;
    next.lastAssistantStartedAt = null;
  }

  return next;
}

export function classifyTurnTaking(text) {
  const normalized = normalizeText(text);
  const words = normalized.split(/\s+/).filter(Boolean);
  if (!normalized) {
    return { mode: "standby", shouldSummarize: false };
  }
  if (/\b(?:resuma|resume|resumir|mais curto|seja breve|encurte|resposta curta)\b/.test(normalized)) {
    return { mode: "summary_request", shouldSummarize: true };
  }
  if (words.length <= 8 || /^(?:aura\s+)?(?:abra|crie|liste|mostre|execute|pare|cancele|status|resumo)\b/.test(normalized)) {
    return { mode: "quick_command", shouldSummarize: true };
  }
  if (words.length >= 28 || /\b(?:vamos pensar|explique|debater|comparar|investigar)\b/.test(normalized)) {
    return { mode: "long_conversation", shouldSummarize: false };
  }
  return { mode: "conversation", shouldSummarize: false };
}

export function voiceDirectiveForText(text) {
  const turn = classifyTurnTaking(text);
  if (!turn.shouldSummarize) {
    return "";
  }
  if (turn.mode === "summary_request") {
    return "Diretriz de voz: interrompa qualquer fala anterior e responda em ate 3 frases curtas.";
  }
  return "Diretriz de voz: trate como comando curto e responda de forma objetiva, sem preambulo longo.";
}

export function isAssistantSpeaking(metrics) {
  return metrics?.turnState === "speaking";
}

function elapsed(start, end) {
  return Number.isFinite(start) ? Math.max(0, Math.round(end - start)) : null;
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim();
}

function performanceNow() {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now();
  }
  return Date.now();
}
