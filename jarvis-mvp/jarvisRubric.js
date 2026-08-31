export const JARVIS_TARGET_SCORE = 6.5;

export const JARVIS_DIMENSIONS = [
  {
    id: "reliability",
    label: "confiabilidade",
    weight: 20,
    criteria: [
      { id: "p0-status-now-slo", p0: true, points: 4, evidence: ["presenceSloPass"] },
      { id: "cancel-hanging-analysis", p0: true, points: 3, evidence: ["cancelRoute", "analystTimeoutSmoke"] },
      { id: "provider-circuit-breaker", p0: true, points: 3, evidence: ["circuitBreaker", "manualCircuitReset"] },
      { id: "demo-scenario-suite", p0: false, points: 2, evidence: ["demoScenarioSuite"] }
    ]
  },
  {
    id: "presence",
    label: "presenca",
    weight: 15,
    criteria: [
      { id: "now-single-source", p0: true, points: 4, evidence: ["nowEndpoint", "nowSnapshot"] },
      { id: "voice-health-honesty", p0: true, points: 3, evidence: ["voiceHealthEndpoint", "voiceFallbackReason"] },
      { id: "speakable-now", p0: false, points: 3, evidence: ["speakableNow", "narrationVerifier"] },
      { id: "barge-in-turn-taking", p0: false, points: 2, evidence: ["bargeInTurnTaking"] }
    ]
  },
  {
    id: "action",
    label: "acao",
    weight: 20,
    criteria: [
      { id: "confirmable-implementation", p0: true, points: 4, evidence: ["visualConfirmation", "workspaceWriteSandbox"] },
      { id: "implementation-evidence", p0: true, points: 3, evidence: ["diffArtifact", "criticReview", "rollbackPlan"] },
      { id: "council-to-implementation", p0: false, points: 3, evidence: ["councilImplementationPlan", "awaitingConfirmFromCouncil"] },
      { id: "rollback-from-cockpit", p0: false, points: 2, evidence: ["rollbackFromCockpit"] }
    ]
  },
  {
    id: "memory",
    label: "memoria",
    weight: 15,
    criteria: [
      { id: "local-sqlite-memory", p0: false, points: 3, evidence: ["sqliteMemory", "memoryCrud"] },
      { id: "current-mission-continuity", p0: true, points: 4, evidence: ["activeJobReference", "voiceJobStatus"] },
      { id: "session-decision-context", p0: false, points: 3, evidence: ["debateSynthesisLookup", "councilPlanSourceJob"] },
      { id: "preference-memory", p0: false, points: 2, evidence: ["preferenceMemory"] }
    ]
  },
  {
    id: "perception",
    label: "percepcao",
    weight: 15,
    criteria: [
      { id: "consented-screen-capture", p0: true, points: 4, evidence: ["screenCaptureConsent", "screenCaptureStop"] },
      { id: "provider-status-visible", p0: true, points: 3, evidence: ["providerStatusApi", "integrationCarousel"] },
      { id: "evidence-brief-artifact", p0: false, points: 3, evidence: ["evidenceBrief", "screenEvidenceDocs"] },
      { id: "continuous-consented-perception", p0: false, points: 2, evidence: ["continuousConsentedPerception"] }
    ]
  },
  {
    id: "fluency",
    label: "fluidez",
    weight: 15,
    criteria: [
      { id: "council-executive-briefing", p0: true, points: 4, evidence: ["debateSynthesisShape", "councilDecisionCard"] },
      { id: "voice-or-text-intents", p0: false, points: 3, evidence: ["voiceIntentDecision", "composerIntent"] },
      { id: "safe-proactivity", p0: false, points: 3, evidence: ["proactiveSuggestion", "proactiveVerifier"] },
      { id: "operator-ready-demo", p0: false, points: 2, evidence: ["operatorReadyDemo"] }
    ]
  }
];

export const JARVIS_SCENARIOS = [
  {
    id: "S1",
    title: "Perguntar o que esta acontecendo agora sem demanda selecionada",
    p0: true,
    dimension: "presence",
    evidence: ["nowEndpoint", "idleNowHeadline", "nowSmoke"]
  },
  {
    id: "S2",
    title: "Rodar Conselho e produzir briefing visivel/falavel",
    p0: true,
    dimension: "fluency",
    evidence: ["analystRun", "debateSynthesisShape", "progressiveDebateVerifier"]
  },
  {
    id: "S3",
    title: "Pedir decisao, bloqueios e proximo passo por chat ou voz",
    p0: true,
    dimension: "memory",
    evidence: ["voiceIntentDecision", "voiceIntentBlockers", "voiceIntentNextStep"]
  },
  {
    id: "S4",
    title: "Criar implementacao a partir de uma decisao e parar em awaiting_confirm",
    p0: true,
    dimension: "action",
    evidence: ["councilImplementationPlan", "awaitingConfirmFromCouncil", "visualConfirmation"]
  },
  {
    id: "S5",
    title: "Cancelar analise travada sem deixar processo running",
    p0: true,
    dimension: "reliability",
    evidence: ["cancelRoute", "presenceSloPass", "noStuckProcesses"]
  },
  {
    id: "S6",
    title: "Comparar realtime on/off com status e chip do cockpit",
    p0: true,
    dimension: "perception",
    evidence: ["voiceHealthEndpoint", "providerStatusApi", "voiceChip"]
  }
];

export function evaluateJarvisRubric(evidence = {}) {
  const scenarioResults = JARVIS_SCENARIOS.map((scenario) => evaluateEvidenceGroup(scenario, evidence));
  const dimensions = JARVIS_DIMENSIONS.map((dimension) => evaluateDimension(dimension, evidence));
  const weightedScore = dimensions.reduce((sum, dimension) => {
    return sum + (dimension.score / 10) * dimension.weight;
  }, 0) / JARVIS_DIMENSIONS.reduce((sum, dimension) => sum + dimension.weight, 0);
  const score = round1(weightedScore * 10);
  const p0Failures = [
    ...scenarioResults.filter((scenario) => scenario.p0 && !scenario.pass).map((scenario) => scenario.id),
    ...dimensions.flatMap((dimension) => {
      return dimension.criteria
        .filter((criterion) => criterion.p0 && !criterion.pass)
        .map((criterion) => `${dimension.id}:${criterion.id}`);
    })
  ];
  const blockers = [...new Set(p0Failures)];
  const pass = score >= JARVIS_TARGET_SCORE && blockers.length === 0;

  return {
    target: JARVIS_TARGET_SCORE,
    score,
    pass,
    blockers,
    scenarios: scenarioResults,
    dimensions,
    summary: summaryFor({ score, pass, blockers, dimensions })
  };
}

function evaluateDimension(dimension, evidence) {
  const criteria = dimension.criteria.map((criterion) => evaluateEvidenceGroup(criterion, evidence));
  const maxPoints = criteria.reduce((sum, criterion) => sum + criterion.points, 0);
  const earnedPoints = criteria.reduce((sum, criterion) => sum + (criterion.pass ? criterion.points : 0), 0);

  return {
    id: dimension.id,
    label: dimension.label,
    weight: dimension.weight,
    score: maxPoints ? round1((earnedPoints / maxPoints) * 10) : 0,
    earnedPoints,
    maxPoints,
    criteria
  };
}

function evaluateEvidenceGroup(group, evidence) {
  const missing = group.evidence.filter((key) => !evidence[key]);
  return {
    id: group.id,
    title: group.title,
    p0: Boolean(group.p0),
    dimension: group.dimension,
    points: group.points || 0,
    pass: missing.length === 0,
    evidence: group.evidence,
    missing
  };
}

function summaryFor({ score, pass, blockers, dimensions }) {
  const weakest = [...dimensions].sort((a, b) => a.score - b.score)[0];
  const status = pass ? "apto" : "bloqueado";
  const blockerText = blockers.length ? ` Bloqueios P0: ${blockers.join(", ")}.` : "";
  return `JARVIS gate ${status}: nota ${score}/10. Menor dimensao: ${weakest.label} (${weakest.score}/10).${blockerText}`;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}
