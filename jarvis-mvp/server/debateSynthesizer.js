import {
  createJobArtifact,
  getJob,
  listJobArtifacts,
  listJobEvents,
  recordJobEvent,
  updateJobStatus
} from "./memory.js";

const MAX_ROUNDS = 3;

export function synthesizeDebate({ jobId, requested = false, budget = {} }) {
  const job = getJob(jobId);
  if (!job) {
    throw new Error("Job not found.");
  }
  assertDebateAllowed(job, requested);

  const maxRounds = Math.min(Number.parseInt(budget.maxRounds, 10) || 1, MAX_ROUNDS);
  if (maxRounds < 1) {
    throw new Error("Debate budget must allow at least one round.");
  }

  const artifacts = listJobArtifacts(job.id);
  assertReDebateAllowed(artifacts, requested);

  const responses = artifacts
    .filter((artifact) => artifact.kind === "analyst-response")
    .map((artifact) => ({
      source: artifact.metadata?.name || artifact.label,
      normalized: artifact.metadata?.normalized || {}
    }));

  if (responses.length < 1) {
    throw new Error("Debate synthesis requires at least one analyst response artifact.");
  }

  const synthesis = buildSynthesis(responses, {
    maxRounds,
    roundsUsed: 1,
    requested
  });

  const artifact = createJobArtifact(job.id, {
    kind: "debate-synthesis",
    label: "Debate synthesis",
    content: JSON.stringify(synthesis, null, 2),
    metadata: {
      roundsUsed: synthesis.budget.roundsUsed,
      maxRounds: synthesis.budget.maxRounds,
      sources: responses.map((response) => response.source)
    }
  });

  recordJobEvent(job.id, "debate.synthesized", "Debate synthesis created.", {
    artifactId: artifact.id,
    consensusCount: synthesis.consensus.length,
    dissentCount: synthesis.dissent.length,
    unverifiedCount: synthesis.unverified.length
  });

  const finalJob = updateJobStatus(job.id, job.status, {
    summary: `Debate synthesis: ${synthesis.consensus.length} consensus, ${synthesis.dissent.length} dissent, ${synthesis.unverified.length} unverified.`
  });

  return {
    job: finalJob,
    synthesis,
    artifact,
    artifacts: listJobArtifacts(job.id),
    events: listJobEvents(job.id)
  };
}

function assertDebateAllowed(job, requested) {
  if (job.mode !== "analyze") {
    throw new Error("Debate synthesis requires mode=analyze.");
  }
  if (job.policyLevel !== "read") {
    throw new Error("Debate synthesis requires policyLevel=read.");
  }
  if (!requested && job.metadata?.debateAllowed !== true) {
    throw new Error("Debate synthesis requires an explicit request or policy allowance.");
  }
}

function assertReDebateAllowed(artifacts, requested) {
  const syntheses = artifacts.filter((artifact) => artifact.kind === "debate-synthesis");
  if (!syntheses.length || requested) {
    return;
  }

  const latestSynthesisId = Math.max(...syntheses.map((artifact) => artifact.id));
  const hasNewEvidence = artifacts.some((artifact) => artifact.kind === "analyst-response" && artifact.id > latestSynthesisId);
  if (!hasNewEvidence) {
    throw new Error("Re-debate requires new evidence or an explicit user request.");
  }
}

function buildSynthesis(responses, budget) {
  const findingEntries = responses.flatMap((response) => normalizeArray(response.normalized.findings).map((text) => ({
    text,
    source: response.source
  })));
  const groupedFindings = groupByText(findingEntries);
  const consensus = [];
  const unverified = [];

  for (const group of groupedFindings.values()) {
    const item = {
      text: group.text,
      sources: [...new Set(group.sources)]
    };
    if (item.sources.length > 1) {
      consensus.push(item);
    } else {
      unverified.push(item);
    }
  }

  const recommendations = responses.map((response) => ({
    source: response.source,
    text: String(response.normalized.recommendation || "").trim()
  })).filter((entry) => entry.text);
  const recommendationTexts = [...new Set(recommendations.map((entry) => normalizeComparable(entry.text)))];
  const dissent = recommendationTexts.length > 1 ? recommendations : [];

  const risks = unionWithSources(responses, "risks");
  const openQuestions = unionWithSources(responses, "open_questions");
  for (const question of openQuestions) {
    unverified.push({
      text: question.text,
      sources: question.sources,
      reason: "open_question"
    });
  }

  return {
    consensus,
    dissent,
    risks,
    unverified,
    recommendation: recommendationTexts.length === 1
      ? recommendations[0].text
      : "Review dissent and unverified items before choosing an implementation plan.",
    confidence: confidenceFromResponses(responses),
    budget,
    implementation_requires: {
      short_plan: true,
      confirmation: true
    }
  };
}

function unionWithSources(responses, field) {
  const entries = responses.flatMap((response) => normalizeArray(response.normalized[field]).map((text) => ({
    text,
    source: response.source
  })));
  return [...groupByText(entries).values()].map((group) => ({
    text: group.text,
    sources: [...new Set(group.sources)]
  }));
}

function groupByText(entries) {
  const groups = new Map();
  for (const entry of entries) {
    const key = normalizeComparable(entry.text);
    if (!key) {
      continue;
    }
    if (!groups.has(key)) {
      groups.set(key, { text: entry.text, sources: [] });
    }
    groups.get(key).sources.push(entry.source);
  }
  return groups;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value.map((item) => String(item || "").trim()).filter(Boolean) : [];
}

function normalizeComparable(value) {
  return String(value || "").trim().toLowerCase();
}

function confidenceFromResponses(responses) {
  const values = responses.map((response) => response.normalized.confidence).filter(Boolean);
  if (values.includes("low")) {
    return "low";
  }
  if (values.includes("medium")) {
    return "medium";
  }
  return values.length ? "high" : "low";
}
