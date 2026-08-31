const MAX_ITEMS = 3;

export function buildExecutiveCouncilBriefing(synthesis = {}, plan = null) {
  const consensus = normalizeItems(synthesis.consensus);
  const dissent = normalizeItems(synthesis.dissent);
  const risks = normalizeItems(synthesis.risks);
  const unverified = normalizeItems(synthesis.unverified);
  const recommendation = cleanText(synthesis.recommendation) || fallbackRecommendation({ dissent, risks, unverified });
  const nextActions = actionableSteps(plan, { risks, dissent, unverified });

  return {
    title: "Briefing executivo",
    recommendation,
    confidence: confidenceBadge(synthesis.confidence),
    facts: [
      { label: "Confianca", value: confidenceBadge(synthesis.confidence).label },
      { label: "Consenso", value: String(consensus.length) },
      { label: "Divergencias", value: String(dissent.length) },
      { label: "Riscos", value: String(risks.length) }
    ],
    consensus: takeUseful(consensus, "Sem consenso repetido entre agentes ainda."),
    dissent: takeUseful(dissent, "Sem divergencia relevante entre agentes."),
    risks: takeUseful(risks, "Sem risco critico destacado pelo Conselho."),
    unverified: takeUseful(unverified, "Sem pergunta aberta registrada."),
    nextActions,
    artifactHint: "Artefatos seguem disponiveis como evidencia secundaria."
  };
}

function actionableSteps(plan, synthesis) {
  const steps = normalizeItems(plan?.steps).map((item) => item.text);
  if (steps.length) {
    return steps.slice(0, MAX_ITEMS);
  }

  const fallback = [
    synthesis.dissent.length ? "Resolver a divergencia com maior impacto antes de executar." : "",
    synthesis.risks.length ? "Mitigar o risco principal e registrar a decisao tomada." : "",
    synthesis.unverified.length ? "Responder o item nao verificado antes de ampliar escopo." : "",
    "Criar implementacao confirmavel somente depois de revisar a recomendacao."
  ].filter(Boolean);
  return fallback.slice(0, MAX_ITEMS);
}

function takeUseful(items, emptyText) {
  if (!items.length) {
    return [{ text: emptyText, sources: [], muted: true, impact: "" }];
  }
  return items.slice(0, MAX_ITEMS).map((item) => ({
    text: item.text,
    sources: item.sources,
    muted: false,
    impact: impactForItem(item)
  }));
}

function impactForItem(item) {
  if (item.reason === "open_question") {
    return "Impacto: exige validacao antes de decidir.";
  }
  if (item.sources.length > 1) {
    return `Impacto: confirmado por ${item.sources.length} agentes.`;
  }
  if (item.sources.length === 1) {
    return `Impacto: ponto levantado por ${item.sources[0]}.`;
  }
  return "Impacto: revisar antes de executar.";
}

function fallbackRecommendation({ dissent, risks, unverified }) {
  if (dissent.length) {
    return "Revisar divergencias antes de transformar a decisao em implementacao.";
  }
  if (risks.length) {
    return "Mitigar riscos principais antes de prosseguir.";
  }
  if (unverified.length) {
    return "Completar itens nao verificados antes de executar.";
  }
  return "Conselho sem recomendacao consolidada; use os artefatos apenas como apoio.";
}

function confidenceBadge(value) {
  const normalized = cleanText(value).toLowerCase();
  const labels = {
    high: "alta",
    medium: "media",
    low: "baixa",
    alta: "alta",
    media: "media",
    baixa: "baixa"
  };
  const levels = {
    high: "high",
    medium: "medium",
    low: "low",
    alta: "high",
    media: "medium",
    baixa: "low"
  };
  return {
    level: levels[normalized] || "low",
    label: labels[normalized] || "baixa"
  };
}

function normalizeItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      if (typeof item === "string") {
        return { text: cleanText(item), sources: [], reason: "" };
      }
      return {
        text: cleanText(item?.text || item?.recommendation || item?.summary || item?.question || item?.risk),
        sources: normalizeSources(item?.sources || item?.source),
        reason: cleanText(item?.reason)
      };
    })
    .filter((item) => item.text);
}

function normalizeSources(value) {
  if (Array.isArray(value)) {
    return value.map(cleanText).filter(Boolean).slice(0, 4);
  }
  const text = cleanText(value);
  return text ? [text] : [];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
