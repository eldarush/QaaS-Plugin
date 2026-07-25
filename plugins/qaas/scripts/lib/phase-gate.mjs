export const PHASES = Object.freeze([
  "UNONBOARDED",
  "DISCOVERING",
  "CONTEXT_REVIEW",
  "PROJECT_READY",
  "TASK_DISCOVERY",
  "PLAN_REVIEW",
  "PLAN_APPROVED",
  "IMPLEMENTING",
  "BUILD_VERIFIED",
  "TEMPLATE_VERIFIED",
  "IMPLEMENTED_NOT_RUN",
  "EXECUTION_REVIEW",
  "MUTATION_REVIEW",
  "MUTATION_APPROVED",
  "EXECUTION_APPROVED",
  "EXECUTING",
  "VERIFIED",
  "DIAGNOSING",
  "REPAIRING",
  "STALE",
  "BLOCKED",
  "SAFETY_VIOLATION",
]);

export const ACTION_CLASSES = Object.freeze([
  "ordinary-read",
  "configured-source-read",
  "context-write",
  "project-write",
  "source-checkout-write",
  "restore",
  "build",
  "template",
  "test-run",
  "observability-query",
  "infrastructure-mutation",
]);

export const APPROVAL_REQUIRED_ACTIONS = new Set(
  ACTION_CLASSES.filter(
    (action) => !["ordinary-read", "configured-source-read"].includes(action),
  ),
);

const ALLOWED_PHASES = Object.freeze({
  "ordinary-read": new Set(PHASES),
  "configured-source-read": new Set([
    "DISCOVERING",
    "CONTEXT_REVIEW",
    "PROJECT_READY",
    "TASK_DISCOVERY",
    "PLAN_REVIEW",
    "PLAN_APPROVED",
    "IMPLEMENTING",
    "DIAGNOSING",
    "REPAIRING",
  ]),
  "context-write": new Set(["CONTEXT_REVIEW"]),
  "project-write": new Set(["IMPLEMENTING", "REPAIRING"]),
  "source-checkout-write": new Set(),
  restore: new Set(["IMPLEMENTING", "REPAIRING"]),
  build: new Set(["IMPLEMENTING", "REPAIRING"]),
  template: new Set(["BUILD_VERIFIED", "IMPLEMENTING", "REPAIRING"]),
  "test-run": new Set(["EXECUTING"]),
  "observability-query": new Set([
    "IMPLEMENTED_NOT_RUN",
    "EXECUTION_APPROVED",
    "DIAGNOSING",
    "VERIFIED",
  ]),
  "infrastructure-mutation": new Set(["EXECUTING"]),
});

const FINGERPRINT_FOR_ACTION = Object.freeze({
  "context-write": "onboardingFingerprint",
  "project-write": "taskBaseline",
  "source-checkout-write": "taskBaseline",
  restore: "expectedWorkingFingerprint",
  build: "expectedWorkingFingerprint",
  template: "expectedWorkingFingerprint",
  "test-run": "staticVerificationFingerprint",
  "observability-query": "staticVerificationFingerprint",
  "infrastructure-mutation": "staticVerificationFingerprint",
});

export function actionNeedsApproval(actionClass) {
  return APPROVAL_REQUIRED_ACTIONS.has(actionClass);
}

export function requiredFingerprintStage(actionClass, options = {}) {
  if (
    actionClass === "observability-query" &&
    ["DIAGNOSING", "VERIFIED"].includes(options.phase)
  ) {
    return "onboardingFingerprint";
  }
  if (
    actionClass === "project-write" &&
    options.hasAuthorizedWrite === true
  ) {
    return "expectedWorkingFingerprint";
  }
  if (
    actionClass === "source-checkout-write" &&
    ["DISCOVERING", "CONTEXT_REVIEW"].includes(options.phase)
  ) {
    return "onboardingFingerprint";
  }
  return FINGERPRINT_FOR_ACTION[actionClass] ?? null;
}

export function evaluatePhaseGate({
  phase,
  actionClass,
  hasApproval = false,
  hooksAttested = false,
  destructive = false,
  integrityValid = true,
  mutationApproved = false,
}) {
  const reasons = [];
  if (!PHASES.includes(phase)) reasons.push(`Unknown phase: ${phase}`);
  if (!ACTION_CLASSES.includes(actionClass)) {
    reasons.push(`Unknown action class: ${actionClass}`);
  }
  if (destructive) reasons.push("Destructive actions are never permitted");
  if (!integrityValid) reasons.push("Authority integrity is not valid");
  if (["STALE", "SAFETY_VIOLATION"].includes(phase) && actionClass !== "ordinary-read") {
    reasons.push(`${phase} permits ordinary read-only investigation only`);
  }
  if (
    ALLOWED_PHASES[actionClass] &&
    !ALLOWED_PHASES[actionClass].has(phase)
  ) {
    reasons.push(`${actionClass} is not legal in phase ${phase}`);
  }
  if (actionNeedsApproval(actionClass) && !hasApproval) {
    reasons.push(`${actionClass} requires signed preauthorization`);
  }
  if (actionNeedsApproval(actionClass) && !hooksAttested) {
    reasons.push(`${actionClass} requires active-hook attestation`);
  }
  if (actionClass === "infrastructure-mutation" && !mutationApproved) {
    reasons.push("Infrastructure mutation requires separate mutation approval");
  }
  return {
    allowed: reasons.length === 0,
    reasons,
    requiredFingerprint: requiredFingerprintStage(actionClass, { phase }),
  };
}

export function assertPhaseGate(input) {
  const result = evaluatePhaseGate(input);
  if (!result.allowed) {
    throw new Error(result.reasons.join("; "));
  }
  return result;
}
