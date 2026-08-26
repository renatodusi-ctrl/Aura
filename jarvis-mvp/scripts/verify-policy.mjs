import assert from "node:assert/strict";
import { evaluateJobPolicy, evaluateToolPolicy, normalizePolicyLevel } from "../server/policy.js";

assert.equal(evaluateJobPolicy("read").requiresConfirmation, false);
assert.equal(evaluateJobPolicy("read").status, "draft");

for (const level of ["write", "git", "network"]) {
  const policy = evaluateJobPolicy(level);
  assert.equal(policy.allowed, true);
  assert.equal(policy.requiresConfirmation, true);
  assert.equal(policy.confirmationType, "ui_confirm");
  assert.equal(policy.status, "awaiting_confirm");
}

for (const level of ["secrets", "destructive"]) {
  const policy = evaluateJobPolicy(level);
  assert.equal(policy.allowed, false);
  assert.equal(policy.requiresConfirmation, true);
  assert.equal(policy.confirmationType, "typed_confirm");
  assert.equal(policy.status, "failed");
}

assert.equal(evaluateToolPolicy("destructive").allowed, true);
assert.equal(evaluateToolPolicy("destructive").requiresConfirmation, true);
assert.throws(() => normalizePolicyLevel("admin"), /Invalid policy level/);

console.log("Policy verification passed.");
