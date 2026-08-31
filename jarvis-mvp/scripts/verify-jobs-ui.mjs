import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const html = fs.readFileSync(path.join(root, "index.html"), "utf8");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "styles.css"), "utf8");

for (const id of ["now-hud", "proactive-suggestion", "job-list", "job-detail", "jobs-refresh-button"]) {
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
  "attachScreenEvidenceToJob",
  "screen-evidence",
  "Remover evidencia",
  "Evidencia visual",
  "AURA deve considerar esta evidencia visual como contexto consentido.",
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
  "Descartar"
]) {
  assert.match(app, new RegExp(token), `Missing jobs UI token: ${token}`);
}

for (const token of [
  "council-briefing-grid",
  "council-briefing-block",
  "council-artifact-note",
  "confidence-low",
  "@media (max-width: 560px)"
]) {
  assert.ok(css.includes(token), `Missing jobs UI CSS token: ${token}`);
}

console.log("Jobs UI verification passed.");
