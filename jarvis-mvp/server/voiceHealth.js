const PROVIDERS = {
  gemini: {
    provider: "gemini",
    label: "Gemini Live",
    keyLabel: "GEMINI_API_KEY",
    alternateKeyLabels: ["GOOGLE_API_KEY", "GOOGLE_GENAI_API_KEY"],
    modelKey: "geminiLiveModel",
    voiceKey: "geminiLiveVoice",
    hasKey: (config) => Boolean(config.geminiApiKey)
  },
  openai: {
    provider: "openai",
    label: "OpenAI Realtime",
    keyLabel: "OPENAI_API_KEY",
    alternateKeyLabels: [],
    modelKey: "realtimeModel",
    voiceKey: "realtimeVoice",
    hasKey: (config) => Boolean(config.openaiApiKey)
  }
};

export function buildVoiceHealth(config, options = {}) {
  const startedAtMs = Number.isFinite(options.startedAtMs) ? options.startedAtMs : Date.now();
  const checkedAt = options.checkedAt || new Date();
  const requestedProvider = normalizeProvider(config.voiceProvider);
  const providerConfig = PROVIDERS[requestedProvider];

  if (!providerConfig) {
    return {
      status: "configuration_error",
      enabled: false,
      provider: "local",
      requestedProvider,
      providerLabel: "Fallback local",
      model: "",
      voice: "",
      latencyMs: elapsedMs(startedAtMs),
      probe: {
        type: "local_config",
        network: false,
        reason: "Healthcheck local valida configuracao sem chamar APIs externas nem expor chaves."
      },
      fallbackReason: `VOICE_PROVIDER=${requestedProvider || "(vazio)"} nao e suportado. Use openai ou gemini.`,
      configurationError: "VOICE_PROVIDER_INVALID",
      keyLabel: "",
      alternateKeyLabels: [],
      checkedAt: checkedAt.toISOString()
    };
  }

  const configured = providerConfig.hasKey(config);
  const model = String(config[providerConfig.modelKey] || "");
  const voice = String(config[providerConfig.voiceKey] || "");
  return {
    status: configured ? "realtime" : "fallback",
    enabled: configured,
    provider: providerConfig.provider,
    requestedProvider,
    providerLabel: providerConfig.label,
    model,
    voice,
    latencyMs: elapsedMs(startedAtMs),
    probe: {
      type: "local_config",
      network: false,
      reason: "Healthcheck local valida configuracao sem chamar APIs externas nem expor chaves."
    },
    fallbackReason: configured
      ? ""
      : `${providerConfig.keyLabel} nao esta configurada; AURA mantem conversa por texto local.`,
    configurationError: "",
    keyLabel: providerConfig.keyLabel,
    alternateKeyLabels: providerConfig.alternateKeyLabels,
    checkedAt: checkedAt.toISOString()
  };
}

function normalizeProvider(value) {
  return String(value || "openai").trim().toLowerCase();
}

function elapsedMs(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}
