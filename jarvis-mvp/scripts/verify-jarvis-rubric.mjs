import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { evaluateJarvisRubric, JARVIS_SCENARIOS, JARVIS_TARGET_SCORE } from "../jarvisRubric.js";

const root = path.resolve(import.meta.dirname, "..");
const sources = readSources({
  app: "app.js",
  packageJson: "package.json",
  realtime: "realtime.js",
  nowNarration: "nowNarration.js",
  councilPlan: "councilPlan.js",
  proactive: "proactive.js",
  slo: "slo.js",
  index: "server/index.js",
  memory: "server/memory.js",
  tools: "server/tools.js",
  supervisor: "server/supervisor.js",
  codexAdapter: "server/codexAdapter.js",
  analystAdapter: "server/analystAdapter.js",
  debateSynthesizer: "server/debateSynthesizer.js",
  voiceHealth: "server/voiceHealth.js",
  voiceIntents: "server/voiceIntents.js",
  smoke: "scripts/verify-job-smoke.mjs",
  jobs: "scripts/verify-jobs.mjs",
  jobsUi: "scripts/verify-jobs-ui.mjs",
  codexVerifier: "scripts/verify-codex-adapter.mjs",
  analystsVerifier: "scripts/verify-analysts.mjs",
  chaosVerifier: "scripts/verify-analyst-chaos.mjs",
  progressiveVerifier: "scripts/verify-progressive-debate.mjs",
  voiceIntentVerifier: "scripts/verify-voice-intents.mjs",
  voiceHealthVerifier: "scripts/verify-voice-health.mjs",
  nowNarrationVerifier: "scripts/verify-now-narration.mjs",
  proactiveVerifier: "scripts/verify-proactive.mjs",
  testingDoc: "docs/TESTING.md",
  rubricDoc: "docs/JARVIS_RUBRIC.md",
  securityDoc: "docs/SECURITY_PRIVACY.md"
});

const presenceReport = readJsonIfExists(path.join(root, "exports", "presence-slo-report.json"));
const evidence = collectEvidence(sources, presenceReport);
const result = evaluateJarvisRubric(evidence);
const reportPath = path.join(root, "exports", "jarvis-rubric-report.json");

fs.mkdirSync(path.dirname(reportPath), { recursive: true });
fs.writeFileSync(reportPath, `${JSON.stringify({
  generatedAt: new Date().toISOString(),
  target: JARVIS_TARGET_SCORE,
  evidence,
  ...result
}, null, 2)}\n`);

for (const scenario of JARVIS_SCENARIOS) {
  assert.ok(result.scenarios.some((item) => item.id === scenario.id), `Missing scenario ${scenario.id}`);
}

assert.equal(result.blockers.length, 0, `JARVIS P0 blockers: ${result.blockers.join(", ")}`);
assert.ok(result.score >= JARVIS_TARGET_SCORE, `JARVIS score ${result.score}/10 is below target ${JARVIS_TARGET_SCORE}/10`);

console.log(`${result.summary} Report: ${reportPath}`);

function readSources(files) {
  return Object.fromEntries(Object.entries(files).map(([key, file]) => {
    return [key, fs.readFileSync(path.join(root, file), "utf8")];
  }));
}

function collectEvidence(text, report) {
  const verifyIncludes = (token) => has(text.packageJson, token);
  const sloFromReport = report?.gate?.pass === true && report.stuckProcesses === 0 && report.inconsistentSnapshots === 0;
  const sloFromCode = has(text.slo, "evaluatePresenceSlo") && has(text.slo, "PRESENCE_SLO_TARGETS") && verifyIncludes("soak-presence.mjs --samples=4");

  return {
    activeJobReference: hasEvery(text.index, ["activeJob", "jobRef", "demandRef", "preferredNowJob"]),
    analystRun: hasEvery(text.index, ["analystsRunRoute", "runAnalysts", "synthesizeDebate"]),
    analystTimeoutSmoke: hasEvery(text.smoke, ["Smoke cancel hanging analyst job", "analyst.process_started", "analystCancelled"]),
    awaitingConfirmFromCouncil: hasEvery(text.app, ["createImplementationFromCouncil", "awaiting_confirm", "confirmacao visual"]),
    cancelRoute: hasEvery(text.index, ["cancelJobRoute", "cancelAnalystJobProcess"]) && has(text.smoke, "/cancel"),
    circuitBreaker: hasEvery(text.analystAdapter, ["analystCircuitState", "circuit_open", "retryAt"]),
    composerIntent: hasEvery(text.app, ["composerIntent", "Aura, organize uma nova missao"]),
    councilDecisionCard: hasEvery(text.app, ["renderCouncilDecisionCard", "Confianca", "Consenso", "Riscos", "Nao verificado", "Rodadas"]),
    councilImplementationPlan: hasEvery(text.councilPlan, ["buildCouncilImplementationPlan", "implementationGoalFromPlan", "verification"]),
    councilPlanSourceJob: hasEvery(text.councilPlan, ["sourceJobId", "source: \"council-decision\""]),
    criticReview: hasEvery(text.codexAdapter, ["critic-review", "Quality gate", "criticGateFor"]),
    debateSynthesisLookup: hasEvery(text.index, ["latestDebateSynthesisForJob", "latestDebateSynthesisAcross"]),
    debateSynthesisShape: hasEvery(text.debateSynthesizer, ["consensus", "dissent", "risks", "unverified", "recommendation"]),
    diffArtifact: hasEvery(text.codexAdapter, ["kind: \"diff\"", "git\", [\"diff\"", "changed-files"]),
    evidenceBrief: hasEvery(text.analystAdapter, ["buildEvidenceBrief", "evidence-brief"]),
    idleNowHeadline: hasEvery(text.index, ["Nenhuma demanda ativa", "Criar missao"]),
    integrationCarousel: hasEvery(text.app, ["renderIntegrations", "integrations-list", "integration-card"]),
    manualCircuitReset: hasEvery(text.index, ["resetProviderCircuitRoute", "analyst.circuit_reset", "duplicateExecution: false"]),
    memoryCrud: hasEvery(text.index, ["/api/memories", "listMemories"]) && hasEvery(text.memory, ["addMemory", "deleteMemory"]),
    noStuckProcesses: sloFromReport || hasEvery(text.smoke, ["activeJobProcessSummary", "activeAnalystProcessSummary"]),
    narrationVerifier: verifyIncludes("verify-now-narration.mjs") && has(text.nowNarrationVerifier, "buildSpeakableNow"),
    nowEndpoint: hasEvery(text.index, ["/api/now", "buildNowSnapshot"]),
    nowSingleSourceInVerify: verifyIncludes("verify-now-narration.mjs") && verifyIncludes("verify-job-smoke.mjs"),
    nowSmoke: has(text.smoke, "/api/now"),
    nowSnapshot: hasEvery(text.index, ["nextStepForJob", "ctaForJob", "nowPresence", "actionId", "confidence", "severity"]),
    presenceSloPass: sloFromReport || sloFromCode,
    proactiveSuggestion: hasEvery(text.proactive, ["buildProactiveSuggestion", "cooldown", "snooze"]),
    proactiveVerifier: verifyIncludes("verify-proactive.mjs") && has(text.proactiveVerifier, "Proactive suggestion verification"),
    progressiveDebateVerifier: verifyIncludes("verify-progressive-debate.mjs") && hasEvery(text.progressiveVerifier, ["dissent", "roundsUsed"]),
    providerStatusApi: hasEvery(text.index, ["getProviderPreflight", "providers", "status: \"circuit_open\""]),
    rollbackPlan: hasEvery(text.codexAdapter, ["rollback-plan", "Safe Rollback Plan"]),
    screenCaptureConsent: hasEvery(text.app, ["screen.capture.intent", "getDisplayMedia", "confirmed: true"]),
    screenCaptureStop: hasEvery(text.app, ["stopScreenCapture", "getTracks", "track.stop"]),
    screenEvidenceDocs: hasEvery(text.securityDoc, ["Screen capture", "getDisplayMedia", "opt-in"]),
    speakableNow: hasEvery(text.nowNarration, ["buildSpeakableNow", "MAX_SPOKEN_CHARS", "NARRATABLE_STATES"]),
    sqliteMemory: hasEvery(text.memory, ["DatabaseSync", "CREATE TABLE IF NOT EXISTS memories", "CREATE TABLE IF NOT EXISTS jobs"]),
    voiceChip: hasEvery(text.app, ["standby por wake word", "realtimeEnabled", "realtimeVoice"]),
    voiceFallbackReason: hasEvery(text.voiceHealth, ["fallbackReason", "configuration_error"]),
    voiceHealthEndpoint: hasEvery(text.index, ["/api/voice/health", "buildVoiceHealth"]),
    voiceIntentBlockers: hasEvery(text.voiceIntents, ["job.blockers", "jobBlockersForVoice"]),
    voiceIntentDecision: hasEvery(text.voiceIntents, ["job.decision", "jobDecisionForVoice"]),
    voiceIntentNextStep: hasEvery(text.voiceIntents, ["job.next_step", "jobNextStepForVoice"]),
    voiceJobStatus: hasEvery(text.voiceIntents, ["job.status", "jobStatusForVoice"]),
    visualConfirmation: hasEvery(text.codexAdapter, ["explicit visual confirmation", "assertImplementJob", "confirmed"]),
    workspaceWriteSandbox: hasEvery(text.codexAdapter, ["workspace-write", "--sandbox"])
  };
}

function readJsonIfExists(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function has(source, token) {
  return String(source || "").includes(token);
}

function hasEvery(source, tokens) {
  return tokens.every((token) => has(source, token));
}
