import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const realtime = fs.readFileSync(path.join(root, "realtime.js"), "utf8");
const voiceRuntime = fs.readFileSync(path.join(root, "voiceRuntime.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

for (const id of ["now-hud", "proactive-suggestion", "job-list", "job-detail", "jobs-refresh-button"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["screen-perception-status", "screen-perception-label", "screen-perception-purpose", "screen-perception-timer", "screen-duration-select"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["voice-metrics"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["aura-core", "aura-core-canvas", "aura-core-label"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["purge-memories-button", "purge-screen-evidence-button"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["github-refresh-button", "github-state-select", "github-panel"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const id of ["terminal-refresh-button", "terminal-panel"]) {
  assert.match(html, new RegExp(`id="${id}"`), `Missing #${id} in cockpit HTML.`);
  assert.match(app, new RegExp(`#${id}`), `Missing #${id} binding in app.js.`);
}

for (const pattern of [
  /api\("\/api\/jobs\?limit=20"\)/,
  /api\("\/api\/now"\)/,
  /api\(`\/api\/jobs\/\$\{state\.selectedJobId\}`\)/,
  /api\(`\/api\/jobs\/\$\{job\.id\}\/cancel`/
]) {
  assert.match(app, pattern);
}

for (const token of [
  "workspace",
  "mode",
  "policyLevel",
  "selectedJobEvents",
  "selectedJobArtifacts",
  "persistentMemoryContextForCouncil",
  "labelForMemoryKind",
  "Editar memoria",
  "Memoria persistente",
  "attachScreenEvidenceToJob",
  "screen-evidence",
  "Remover evidencia",
  "Evidencia visual",
  "AURA deve considerar esta evidencia visual como contexto consentido.",
  "screen-perception-status",
  "screen-duration-select",
  "Percepcao ativa",
  "selectedPerceptionDurationMs",
  "formatCountdown",
  "screen.perception_ended",
  "renderVoiceMetrics",
  "initAuraCore",
  "renderAuraCoreState",
  "buildAuraNeuralGraph",
  "voiceMetricsDetail",
  "renderMissionDecision",
  "mission-decision-card",
  "runMissionDecisionAction",
  "Decisao agora",
  "purgeMemories",
  "purgeScreenEvidence",
  "redactClientText",
  "/api/privacy/purge",
  "renderNowHud",
  "nowHudFact",
  "runNowAction",
  "proactive-suggestion",
  "renderProactiveSuggestion",
  "buildProactiveSuggestion",
  "recordProactiveDecision",
  "Sugestao AURA",
  "Aceitar",
  "Adiar",
  "Recusar",
  "Silenciar sugestoes",
  "resetProviderCircuit",
  "Resetar circuito",
  "Proxima tentativa",
  "circuit_open",
  "canCancelJob",
  "canConfirmImplementJob",
  "plan-critique-input",
  "Registrar critica",
  "/pause",
  "/revise",
  "operatorCritique",
  "codex/implement",
  "renderJobArtifact",
  "renderArtifactCard",
  "labelForArtifactKind",
  "critic-review",
  "rollback-plan",
  "independent-critic-brief",
  "independent-critic-review",
  "preferredMissionJob",
  "renderImplementationApproval",
  "analysts/run",
  "renderAnalystConsent",
  "buildAnalystPreview",
  "Teto de rodadas",
  "safeRounds",
  "maxRounds: safeRounds",
  "progressive: safeRounds > 1",
  "Gemini",
  "Grok",
  "debate/synthesize",
  "synthesizeCouncilDecision",
  "renderCouncilDecisionCard",
  "buildExecutiveCouncilBriefing",
  "council-briefing-grid",
  "Divergencias com impacto",
  "Ver artefatos",
  "renderCouncilDecisionActions",
  "renderCouncilImplementationPlanPreview",
  "buildCouncilImplementationPlan",
  "implementationGoalFromPlan",
  "implementationEvidenceFromArtifacts",
  "council-plan-preview",
  "debateRoundLabel",
  "createImplementationFromCouncil",
  "Criar implementacao",
  "Revisar plano",
  "Pedir segunda opiniao",
  "Decisao do Conselho",
  "Evidencias de implementacao",
  "Voltar a decisao original",
  "renderDebateControls",
  "canSynthesizeDebate",
  "recoveryContext",
  "Retomar conselho",
  "Retomar execucao",
  "Sintetizar",
  "/api/routine/jobs",
  "renderRoutineDraftControls",
  "routine.job.created",
  "routineSuggestion",
  "Aprovar",
  "Descartar",
  "renderGitHubIssues",
  "integrationItemForGitHub",
  "Virar task",
  "/api/github/issues",
  "renderTerminalDiagnostics",
  "terminalDiagnosticFromRealtime",
  "integrationItemForTerminal",
  "Terminal seguro",
  "/api/terminal/run"
]) {
  assert.match(app, new RegExp(token), `Missing jobs UI token: ${token}`);
}

for (const token of [
  "aura.voice.metrics",
  "aura.voice.barge_in",
  "aura.voice.turn_taking",
  "late-response-dropped",
  "summary_request",
  "quick_command"
]) {
  assert.match(`${realtime}\n${voiceRuntime}`, new RegExp(token), `Missing voice runtime token: ${token}`);
}

for (const token of [
  "council-briefing-grid",
  "council-briefing-block",
  "council-artifact-note",
  "mission-decision-card",
  "presence-console",
  "orb-wrap",
  "neural-canvas",
  "terminal-command-list",
  "terminal-output",
  "confidence-low",
  "@media (max-width: 560px)"
]) {
  assert.ok(css.includes(token), `Missing jobs UI CSS token: ${token}`);
}

console.log("Jobs UI verification passed.");
