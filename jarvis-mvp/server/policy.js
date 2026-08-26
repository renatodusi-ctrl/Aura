export const POLICY_LEVELS = Object.freeze(["read", "write", "git", "network", "secrets", "destructive"]);

const POLICY_LEVEL_SET = new Set(POLICY_LEVELS);

const JOB_POLICY = Object.freeze({
  read: {
    allowed: true,
    requiresConfirmation: false,
    confirmationType: "none",
    status: "draft",
    reason: ""
  },
  write: {
    allowed: true,
    requiresConfirmation: true,
    confirmationType: "ui_confirm",
    status: "awaiting_confirm",
    reason: "Write jobs require visual confirmation before execution."
  },
  git: {
    allowed: true,
    requiresConfirmation: true,
    confirmationType: "ui_confirm",
    status: "awaiting_confirm",
    reason: "Git jobs require visual confirmation before execution."
  },
  network: {
    allowed: true,
    requiresConfirmation: true,
    confirmationType: "ui_confirm",
    status: "awaiting_confirm",
    reason: "Network jobs require visual confirmation before execution."
  },
  secrets: {
    allowed: false,
    requiresConfirmation: true,
    confirmationType: "typed_confirm",
    status: "failed",
    reason: "Secret-bearing jobs are blocked until typed confirmation is implemented."
  },
  destructive: {
    allowed: false,
    requiresConfirmation: true,
    confirmationType: "typed_confirm",
    status: "failed",
    reason: "Destructive jobs are blocked until typed confirmation is implemented."
  }
});

const TOOL_POLICY = Object.freeze({
  read: { allowed: true, requiresConfirmation: false, confirmationType: "none" },
  write: { allowed: true, requiresConfirmation: true, confirmationType: "ui_confirm" },
  git: { allowed: true, requiresConfirmation: true, confirmationType: "ui_confirm" },
  network: { allowed: true, requiresConfirmation: true, confirmationType: "ui_confirm" },
  secrets: { allowed: true, requiresConfirmation: true, confirmationType: "typed_confirm" },
  destructive: { allowed: true, requiresConfirmation: true, confirmationType: "typed_confirm" }
});

export function normalizePolicyLevel(policyLevel = "read") {
  const normalized = String(policyLevel || "read");
  if (!POLICY_LEVEL_SET.has(normalized)) {
    throw new Error(`Invalid policy level: ${normalized}.`);
  }
  return normalized;
}

export function evaluateJobPolicy(policyLevel = "read") {
  return {
    policyLevel: normalizePolicyLevel(policyLevel),
    ...JOB_POLICY[normalizePolicyLevel(policyLevel)]
  };
}

export function evaluateToolPolicy(policyLevel = "read") {
  return {
    policyLevel: normalizePolicyLevel(policyLevel),
    ...TOOL_POLICY[normalizePolicyLevel(policyLevel)]
  };
}
