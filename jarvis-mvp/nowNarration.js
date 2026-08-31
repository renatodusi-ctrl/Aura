const NARRATABLE_STATES = new Set(["blocked", "failed", "cancelled", "completed"]);
const MAX_SPOKEN_CHARS = 240;

export function buildSpeakableNow(now) {
  if (!now || !NARRATABLE_STATES.has(now.state)) {
    return null;
  }

  const jobId = now.activeJob?.id || now.jobRef?.id || now.demandRef?.id || "";
  const subject = jobId ? `Demanda ${jobId}` : "A demanda atual";
  const cause = blockerText(now) || decisionText(now);
  const nextStep = cleanSentence(now.nextStep || now.cta?.label || "Revise o cockpit para decidir o proximo passo.");
  const firstSentence = sentenceForState(now.state, subject, cause);
  const text = limitSpokenText(`${firstSentence} ${nextStep}`);

  return {
    id: narrationId(now, text),
    state: now.state,
    actionId: now.actionId || now.cta?.actionId || "",
    severity: now.severity || "info",
    text
  };
}

export function shouldNarrateNow(item, memory = {}) {
  if (!item?.id) {
    return false;
  }
  if (item.id === memory.lastId) {
    return false;
  }
  return !memory.spokenIds?.has?.(item.id);
}

function sentenceForState(state, subject, cause) {
  if (state === "completed") {
    return `${subject} concluida.`;
  }
  if (state === "failed") {
    return cause ? `${subject} falhou: ${cause}.` : `${subject} falhou.`;
  }
  if (state === "cancelled") {
    return `${subject} foi cancelada.`;
  }
  if (state === "blocked") {
    return cause ? `${subject} precisa da sua decisao: ${cause}.` : `${subject} precisa da sua decisao.`;
  }
  return `${subject} atualizada.`;
}

function narrationId(now, text) {
  const jobId = now.activeJob?.id || now.jobRef?.id || now.demandRef?.id || "none";
  return [
    jobId,
    now.state || "idle",
    now.actionId || now.cta?.actionId || "none",
    hashText(text)
  ].join(":");
}

function blockerText(now) {
  const blocker = Array.isArray(now.blockers) ? now.blockers[0] : null;
  const text = blocker?.message || blocker?.summary || blocker?.reason || "";
  return cleanSentence(text);
}

function decisionText(now) {
  const decision = now.councilDecision;
  return cleanSentence(decision?.summary || decision?.recommendation || "");
}

function cleanSentence(value) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .replace(/[`*_#>[\]{}]/g, "")
    .trim()
    .replace(/[.!?]+$/g, "");
}

function limitSpokenText(text) {
  const sentences = text
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean)
    .slice(0, 2);
  const joined = sentences.join(" ");
  if (joined.length <= MAX_SPOKEN_CHARS) {
    return joined;
  }
  return `${joined.slice(0, MAX_SPOKEN_CHARS - 1).trimEnd()}.`;
}

function hashText(text) {
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}
