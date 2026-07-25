import path from "node:path";
import {
  findApprovalByDigest,
} from "./lib/approval-authority.mjs";
import { scanProjectExecutableInputs } from "./lib/authored-safety.mjs";
import {
  safeEqualHex,
  sha256,
} from "./lib/canonical-json.mjs";
import {
  isDirectExecution,
  parseNamedArguments,
  printJson,
} from "./lib/cli.mjs";
import {
  compareFingerprints,
  createFingerprint,
} from "./lib/fingerprint.mjs";
import {
  createEvidenceEvent,
  recordEvidence,
} from "./lib/evidence.mjs";
import { mirrorProjectState } from "./lib/project-state-mirror.mjs";
import {
  computePackageSnapshot,
  writePackageSnapshot,
} from "./lib/package-snapshot.mjs";
import { runProcess } from "./lib/process-runner.mjs";
import { commitTransition } from "./lib/state.mjs";
import {
  captureProcessFingerprint,
  captureVerificationArtifacts,
  evaluateVerification,
  verifyProcessChanges,
} from "./lib/verification.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";

const PLAN_ACTIONS = new Set(["restore", "build", "template"]);

export function assertAirGapPackageSources(snapshot) {
  const unsafe = (snapshot?.packageSources ?? []).filter((source) => {
    if (source.kind === "unresolved-project-expression") return true;
    if (source.kind !== "http") return false;
    try {
      const host = new URL(source.url).hostname.toLowerCase();
      return host === "nuget.org" || host.endsWith(".nuget.org");
    } catch {
      return true;
    }
  });
  if (unsafe.length > 0) {
    throw new Error(
      "Restore is blocked because project package metadata contains an unresolved or public NuGet source",
    );
  }
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function exactStoredFingerprint(
  context,
  state,
  stage,
  fallbackExclusions = [],
) {
  const expected = (
    await context.authority.readSigned(`fingerprints/${stage}.json`)
  ).payload;
  const stateDigest =
    typeof state.fingerprints[stage] === "string"
      ? state.fingerprints[stage]
      : state.fingerprints[stage]?.digest;
  if (!safeEqualHex(stateDigest, expected.digest)) {
    throw new Error(`${stage} does not match signed current state`);
  }
  const actual = await createFingerprint({
    projectRoot: context.projectRoot,
    stage,
    relevantPaths: expected.scopePaths ?? null,
    exclusions: expected.exclusions ?? fallbackExclusions,
    packageSnapshot: expected.packageSnapshot,
    contextDigest: expected.contextDigest,
    externalReferences: expected.externalReferences,
    renderedTemplate: expected.renderedTemplate,
  });
  const comparison = compareFingerprints(expected, actual);
  if (!comparison.equal) {
    throw new Error(
      `Working fingerprint is stale: added=${comparison.added.join(",")}; ` +
        `removed=${comparison.removed.join(",")}; changed=${comparison.changed.join(",")}`,
    );
  }
  return expected;
}

async function exactWorkingFingerprint(context, state, plan) {
  const stage = state.fingerprints?.expectedWorkingFingerprint
    ? "expectedWorkingFingerprint"
    : state.fingerprints?.taskBaseline
      ? "taskBaseline"
      : null;
  if (!stage) throw new Error("No signed working fingerprint is active");
  return exactStoredFingerprint(
    context,
    state,
    stage,
    plan.generatedOutputs,
  );
}

async function exactApproval(context, active, kind, digest) {
  if (!safeEqualHex(active.state.approvedDigests?.[kind], digest)) {
    throw new Error(`Signed state lacks exact ${kind} approval`);
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind,
    approvedDigest: digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) {
    throw new Error(`Current session/lease lacks exact ${kind} approval`);
  }
  return approval;
}

async function exactReview(context, kind, artifact) {
  const review = await context.authority.readSigned(
    `artifacts/${kind}-review.json`,
  );
  if (
    review.payload.kind !== kind ||
    !safeEqualHex(review.payload.artifactDigest, artifact.payload.digest) ||
    !Array.isArray(review.payload.processBindings)
  ) {
    throw new Error(`Signed ${kind} process review is stale or malformed`);
  }
  return review.payload;
}

function commandCwd(projectRoot, command) {
  const cwd = path.resolve(projectRoot, command.cwd);
  if (!isInside(projectRoot, cwd)) {
    throw new Error("Approved command cwd escapes the project");
  }
  return cwd;
}

async function runOne({
  context,
  approvalDigest,
  approval,
  review,
  action,
  index,
  commandIndex = index,
  command,
  outputDirectories,
  protectedPaths = [],
  fingerprintStage,
  executionTimeoutMs = null,
}) {
  const cwd = commandCwd(context.projectRoot, command);
  const binding = review.processBindings.find(
    (entry) =>
      entry.action === action &&
      entry.commandIndex === commandIndex,
  );
  if (!binding) {
    throw new Error(`Signed review lacks ${action} command binding ${commandIndex}`);
  }
  const before = await captureProcessFingerprint(
    context.projectRoot,
    fingerprintStage,
  );
  const result = await runProcess({
    program: binding.resolvedProgram,
    args: command.args,
    cwd,
    envNames: command.envNames,
    timeoutMs: command.timeoutMs,
    outputLimitBytes: command.outputLimitBytes,
    outputDirectories,
    scopeRoot: context.projectRoot,
    environment: context.env,
    executionTimeoutMs,
    expectedSpecDigest: binding.processSpecDigest,
    expectedScriptDigest: command.scriptDigest ?? null,
    approvedExecutablePath: binding.resolvedProgram,
    expectedExecutableDigest: binding.executableDigest,
    actionClass: action === "test-run" ? "test-run" : action,
    verifyAuthorization: async (specification) =>
      safeEqualHex(approval.approvedDigest, approvalDigest) &&
      safeEqualHex(specification.specDigest, binding.processSpecDigest) &&
      specification.actionClass ===
        (action === "test-run" ? "test-run" : action),
  });
  const integrity = await verifyProcessChanges({
    projectRoot: context.projectRoot,
    before,
    allowedOutputDirectories: outputDirectories,
    protectedPaths,
    stage: fingerprintStage,
  });
  return { ...result, integrity };
}

function processResultSucceeded(result) {
  return (
    result.exitCode === 0 &&
    !result.timedOut &&
    !result.truncated &&
    !result.killDeadlineExceeded &&
    result.integrity?.ok === true &&
    result.verification?.passed !== false
  );
}

async function recordRunEvidence(
  context,
  state,
  action,
  artifactDigest,
  results,
  verification = null,
  classification = null,
) {
  const outputDigest = sha256(
    results.map((entry) => ({
      specDigest: entry.specDigest,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
      killDeadlineExceeded: entry.killDeadlineExceeded,
      truncated: entry.truncated,
      integrity: entry.integrity,
      verification: entry.verification ?? null,
      stdoutDigest: sha256(entry.stdout),
      stderrDigest: sha256(entry.stderr),
    })),
  );
  const successful =
    results.length > 0 &&
    results.every(processResultSucceeded) &&
    verification?.passed !== false;
  const event = createEvidenceEvent({
    projectId: context.authority.projectId,
    taskId: state.taskId,
    type: "approved-process",
    actionClass: action,
    status: successful ? "success" : "failure",
    tool: "run-approved",
    inputDigest: artifactDigest,
    outputDigest,
    exitCode: results.at(-1)?.exitCode ?? null,
    paths: [],
    excerpt: results.at(-1)?.stderr?.slice(0, 2048) ?? null,
    details: {
      processCount: results.length,
      specificationDigests: results.map((entry) => entry.specDigest),
      timedOut: results.some((entry) => entry.timedOut),
      killDeadlineExceeded: results.some(
        (entry) => entry.killDeadlineExceeded,
      ),
      truncated: results.some((entry) => entry.truncated),
      integrity: results.map((entry) => entry.integrity),
      verification,
      classification,
    },
  });
  await recordEvidence(context.authority, event, {
    projectRoot: context.projectRoot,
    mirrorPath: path.join(
      context.projectRoot,
      ".claude",
      "qaas",
      "state",
      "tasks",
      state.taskId,
      "evidence.jsonl",
    ),
  });
  return { event, successful, outputDigest };
}

export async function enterSafetyViolationForProcessDrift(
  context,
  state,
  action,
  results,
) {
  const unexpected = results.flatMap(
    (entry) => entry.integrity?.unexpected ?? [],
  );
  const invalidOutputs = results.flatMap(
    (entry) => entry.integrity?.invalidOutputDirectories ?? [],
  );
  const killDeadlineExceeded = results.some(
    (entry) => entry.killDeadlineExceeded,
  );
  if (
    unexpected.length === 0 &&
    invalidOutputs.length === 0 &&
    !killDeadlineExceeded
  ) {
    return null;
  }
  const reason = killDeadlineExceeded
    ? `${action} process tree did not terminate by the hard kill deadline`
    : `${action} changed paths outside its reviewed output scope: ` +
      [...unexpected, ...invalidOutputs].join(", ");
  const next = await commitTransition(
    context.authority,
    state,
    "SAFETY_VIOLATION",
    {
      reason,
      patch: {
        blocker: reason,
        nextLegalAction: "Stop and inspect authoritative security evidence",
      },
    },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Blocked unreviewed process changes",
  );
  return next;
}

async function runPlanAction(context, active, action) {
  const allowedPhases = {
    restore: new Set(["IMPLEMENTING", "REPAIRING"]),
    build: new Set(["IMPLEMENTING", "REPAIRING"]),
    template: new Set(["BUILD_VERIFIED"]),
  };
  if (!allowedPhases[action].has(active.state.phase)) {
    throw new Error(`${action} is not legal from ${active.state.phase}`);
  }
  const artifact = await context.authority.readSigned("artifacts/plan.json");
  const plan = artifact.payload.document;
  const review = await exactReview(context, "plan", artifact);
  const approval = await exactApproval(
    context,
    active,
    "plan",
    review.digest,
  );
  const safetyScan = await scanProjectExecutableInputs({
    projectRoot: context.projectRoot,
    additionalPaths: plan.generatedOutputs,
  });
  if (!safetyScan.safe) {
    throw new Error(
      `Approved process inputs contain destructive behavior: ${safetyScan.findings
        .map((entry) => `${entry.identifier}:${entry.reason}`)
        .join(", ")}`,
    );
  }
  await exactWorkingFingerprint(context, active.state, plan);
  if (action === "build" && active.state.phase === "REPAIRING") {
    active = {
      ...active,
      state: await commitTransition(
        context.authority,
        active.state,
        "IMPLEMENTING",
        {
          reason: "Exact-scope repair is ready for fresh build verification",
          patch: {
            nextLegalAction: "Run fresh build and template verification",
          },
        },
      ),
    };
    await mirrorProjectState(
      context.projectRoot,
      active.state,
      "Started repaired build verification",
    );
  }
  const commands = plan.commands[action];
  if (!Array.isArray(commands) || commands.length === 0) {
    if (action === "restore") {
      return { action, skipped: true, reason: "No restore commands were approved" };
    }
    throw new Error(`Approved plan has no ${action} commands`);
  }
  if (action === "restore") {
    assertAirGapPackageSources(
      await computePackageSnapshot({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
    );
  }
  const priorArtifacts = await captureVerificationArtifacts(
    context.projectRoot,
    plan.verification[action],
  );
  const fingerprintStage = active.state.fingerprints?.expectedWorkingFingerprint
    ? "expectedWorkingFingerprint"
    : "taskBaseline";
  const protectedPaths = [
    ...Object.values(plan.paths ?? {}).flat(),
    ...(plan.changes ?? []).map((change) => change.path),
    ".claude",
    ".git",
  ];
  const results = [];
  for (const [index, command] of commands.entries()) {
    const result = await runOne({
      context,
      approvalDigest: review.digest,
      approval,
      review,
      action,
      index,
      command,
      outputDirectories: plan.generatedOutputs,
      protectedPaths,
      fingerprintStage,
    });
    results.push(result);
    if (!processResultSucceeded(result)) break;
  }
  const verification = await evaluateVerification({
    projectRoot: context.projectRoot,
    results,
    checks: plan.verification[action],
    warningPolicy: plan.warningPolicy,
    changedPaths: results.flatMap((entry) => entry.integrity?.changed ?? []),
    requireFreshArtifacts: action === "template",
    priorArtifactStates: priorArtifacts,
  });
  const evidence = await recordRunEvidence(
    context,
    active.state,
    action,
    review.digest,
    results,
    verification,
  );
  let state = active.state;
  const safetyState = await enterSafetyViolationForProcessDrift(
    context,
    state,
    action,
    results,
  );
  if (safetyState) {
    return {
      action,
      successful: false,
      phase: safetyState.phase,
      evidenceDigest: evidence.event.digest,
      verification,
    };
  }
  if (action === "build" && evidence.successful) {
    state = await commitTransition(context.authority, state, "BUILD_VERIFIED", {
      reason: "Every exact approved build command succeeded",
      patch: {
        completedWork: [...state.completedWork, "approved build verified"],
        nextLegalAction: "Run exact approved template verification",
      },
    });
  } else if (action === "template" && evidence.successful) {
    const renderedSafety = await scanProjectExecutableInputs({
      projectRoot: context.projectRoot,
      additionalPaths: plan.generatedOutputs,
    });
    if (!renderedSafety.safe) {
      throw new Error(
        `Rendered template contains destructive behavior: ${renderedSafety.findings
          .map((entry) => `${entry.identifier}:${entry.reason}`)
          .join(", ")}`,
      );
    }
    const packageSnapshot = await writePackageSnapshot(
      context.authority,
      "packages/static-verification.json",
      await computePackageSnapshot({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
    );
    const staticFingerprint = await createFingerprint({
      projectRoot: context.projectRoot,
      stage: "staticVerificationFingerprint",
      exclusions: plan.generatedOutputs,
      packageSnapshot,
      contextDigest: state.contextDigest ?? null,
      renderedTemplate: {
        planDigest: review.digest,
        commandSpecificationDigests: results.map((entry) => entry.specDigest),
        outputDigest: evidence.outputDigest,
      },
    });
    const old = await context.authority.readSigned(
      "fingerprints/staticVerificationFingerprint.json",
      { required: false },
    );
    await context.authority.writeSigned(
      "fingerprints/staticVerificationFingerprint.json",
      staticFingerprint,
      { expectedDigest: old?.digest ?? null },
    );
    state = await commitTransition(
      context.authority,
      state,
      "TEMPLATE_VERIFIED",
      {
        reason: "Every exact approved template command succeeded",
        patch: {
          fingerprints: {
            ...state.fingerprints,
            staticVerificationFingerprint: staticFingerprint.digest,
          },
        },
      },
    );
    state = await commitTransition(
      context.authority,
      state,
      "IMPLEMENTED_NOT_RUN",
      {
        reason: "Static build/template verification completed without test execution",
        patch: {
          completedWork: [
            ...state.completedWork,
            "approved template verification completed",
          ],
          nextLegalAction: "Stage and review an exact execution plan",
        },
      },
    );
  } else if (!evidence.successful) {
    state = await commitTransition(
      context.authority,
      state,
      "DIAGNOSING",
      {
        reason:
          `Approved ${action} failed typed verification or bounded-process safety`,
        patch: {
          blocker: verification.failures.join("; ").slice(0, 2048),
          nextLegalAction:
            "Diagnose signed process/check evidence, then request exact-scope repair",
        },
      },
    );
  }
  await mirrorProjectState(
    context.projectRoot,
    state,
    `Completed approved ${action}`,
  );
  return {
    action,
    successful: evidence.successful,
    phase: state.phase,
    evidenceDigest: evidence.event.digest,
    results: results.map((entry) => ({
      program: entry.program,
      executableDigest: entry.executableDigest,
      specDigest: entry.specDigest,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
      killEscalated: entry.killEscalated,
      killDeadlineExceeded: entry.killDeadlineExceeded,
      truncated: entry.truncated,
      integrity: entry.integrity,
      stdout: entry.stdout,
      stderr: entry.stderr,
    })),
    verification,
  };
}

async function runExecution(context, active) {
  if (active.state.phase !== "EXECUTION_APPROVED") {
    throw new Error("test-run requires EXECUTION_APPROVED");
  }
  const artifact = await context.authority.readSigned("artifacts/execution.json");
  const execution = artifact.payload.document;
  const review = await exactReview(context, "execution", artifact);
  const approval = await exactApproval(
    context,
    active,
    "execution",
    review.digest,
  );
  const plan = await context.authority.readSigned("artifacts/plan.json");
  const safetyScan = await scanProjectExecutableInputs({
    projectRoot: context.projectRoot,
    additionalPaths: [
      ...(plan.payload.document.generatedOutputs ?? []),
      ...(execution.outputPaths ?? []),
    ],
  });
  if (!safetyScan.safe) {
    throw new Error(
      `Execution inputs contain destructive behavior: ${safetyScan.findings
        .map((entry) => `${entry.identifier}:${entry.reason}`)
        .join(", ")}`,
    );
  }
  const staticRecord = await context.authority.readSigned(
    "fingerprints/staticVerificationFingerprint.json",
  );
  if (
    !safeEqualHex(
      active.state.fingerprints?.staticVerificationFingerprint,
      staticRecord.payload.digest,
    ) ||
    !safeEqualHex(execution.staticVerificationDigest, staticRecord.payload.digest)
  ) {
    throw new Error("Execution plan static verification fingerprint is stale");
  }
  await exactStoredFingerprint(
    context,
    active.state,
    "staticVerificationFingerprint",
    plan.payload.document.generatedOutputs,
  );
  let state = await commitTransition(
    context.authority,
    active.state,
    "EXECUTING",
    {
      reason: "Started exact approved bounded execution",
      patch: { nextLegalAction: "Complete bounded run and record evidence" },
    },
  );
  await mirrorProjectState(context.projectRoot, state, "Started approved execution");
  const results = [];
  const requiredSuccesses = execution.repeatCount;
  const maximumAttempts = execution.repeatCount + execution.retryBudget;
  let successes = 0;
  let failedAttempts = 0;
  const started = Date.now();
  for (let index = 0; index < maximumAttempts && successes < requiredSuccesses; index += 1) {
    const remainingMs = execution.wallClockLimitMs - (Date.now() - started);
    if (remainingMs < 1) break;
    const priorArtifacts = await captureVerificationArtifacts(
      context.projectRoot,
      execution.successChecks,
    );
    const result = await runOne({
      context,
      approvalDigest: review.digest,
      approval,
      review,
      action: "test-run",
      index,
      commandIndex: 0,
      command: execution.command,
      outputDirectories: execution.outputPaths,
      protectedPaths: [
        ...Object.values(plan.payload.document.paths ?? {}).flat(),
        ...(plan.payload.document.changes ?? []).map((change) => change.path),
        ".claude",
        ".git",
      ],
      fingerprintStage: "staticVerificationFingerprint",
      executionTimeoutMs: Math.min(
        execution.command.timeoutMs,
        remainingMs,
      ),
    });
    result.verification = await evaluateVerification({
      projectRoot: context.projectRoot,
      results: [result],
      checks: execution.successChecks,
      warningPolicy: execution.warningPolicy,
      changedPaths: result.integrity?.changed ?? [],
      requireFreshArtifacts: true,
      priorArtifactStates: priorArtifacts,
    });
    results.push(result);
    if (processResultSucceeded(result)) successes += 1;
    else failedAttempts += 1;
  }
  const classification =
    failedAttempts > 0 && successes > 0
      ? "flaky-rejected"
      : failedAttempts > 0
        ? "failed"
        : "clean";
  const evidence = await recordRunEvidence(
    context,
    state,
    "test-run",
    review.digest,
    results,
    null,
    classification,
  );
  const verified =
    successes === requiredSuccesses &&
    failedAttempts === 0 &&
    Date.now() - started <= execution.wallClockLimitMs;
  const safetyState = await enterSafetyViolationForProcessDrift(
    context,
    state,
    "test-run",
    results,
  );
  if (safetyState) {
    return {
      action: "test-run",
      successful: false,
      phase: safetyState.phase,
      successes,
      attempts: results.length,
      classification: "safety-violation",
      evidenceDigest: evidence.event.digest,
    };
  }
  let verifiedBaseline = null;
  let verifiedPackageSnapshot = null;
  if (verified) {
    verifiedPackageSnapshot = await writePackageSnapshot(
      context.authority,
      "packages/verified-baseline.json",
      await computePackageSnapshot({
        projectRoot: context.projectRoot,
        env: context.env,
      }),
    );
    const mutation = await context.authority.readSigned(
      "artifacts/mutation.json",
      { required: false },
    );
    const currentMutationOutputs =
      mutation?.payload.document?.taskId === state.taskId &&
      safeEqualHex(
        mutation?.payload.document?.executionPlanDigest,
        artifact.payload.digest,
      )
        ? mutation.payload.document.tool?.outputDirectories ?? []
        : [];
    verifiedBaseline = await createFingerprint({
      projectRoot: context.projectRoot,
      stage: "onboardingFingerprint",
      exclusions: [
        ...(plan.payload.document.generatedOutputs ?? []),
        ...(execution.outputPaths ?? []),
        ...currentMutationOutputs,
      ],
      packageSnapshot: verifiedPackageSnapshot,
      contextDigest: state.contextDigest ?? null,
    });
    const priorBaseline = await context.authority.readSigned(
      "fingerprints/onboardingFingerprint.json",
      { required: false },
    );
    await context.authority.writeSigned(
      "fingerprints/onboardingFingerprint.json",
      verifiedBaseline,
      { expectedDigest: priorBaseline?.digest ?? null },
    );
  }
  state = await commitTransition(
    context.authority,
    state,
    verified ? "VERIFIED" : "DIAGNOSING",
    {
      reason: verified
        ? "Approved execution met every success/repeat bound"
        : "Approved execution failed or exhausted its retry/wall-clock bound",
      patch: {
        completedWork: verified
          ? [...state.completedWork, "approved execution verified"]
          : state.completedWork,
        fingerprints: verified
          ? {
              onboardingFingerprint: verifiedBaseline.digest,
            }
          : state.fingerprints,
        packageSnapshotDigest: verified
          ? verifiedPackageSnapshot.digest
          : state.packageSnapshotDigest,
        blocker: verified ? null : "execution evidence requires diagnosis",
        nextLegalAction: verified
          ? "Task verified; begin another bounded task if requested"
          : "Diagnose evidence without mutating, then stage a repair",
      },
    },
  );
  await mirrorProjectState(context.projectRoot, state, "Completed approved execution");
  return {
    action: "test-run",
    successful: verified,
    phase: state.phase,
    successes,
    attempts: results.length,
    classification,
    evidenceDigest: evidence.event.digest,
    results: results.map((entry) => ({
      program: entry.program,
      executableDigest: entry.executableDigest,
      specDigest: entry.specDigest,
      exitCode: entry.exitCode,
      timedOut: entry.timedOut,
      killEscalated: entry.killEscalated,
      killDeadlineExceeded: entry.killDeadlineExceeded,
      truncated: entry.truncated,
      integrity: entry.integrity,
      verification: entry.verification,
      stdout: entry.stdout,
      stderr: entry.stderr,
    })),
  };
}

async function runMutation(context, active) {
  if (active.state.phase !== "EXECUTION_APPROVED") {
    throw new Error("mutation requires EXECUTION_APPROVED");
  }
  const mutationArtifact = await context.authority.readSigned(
    "artifacts/mutation.json",
  );
  const mutation = mutationArtifact.payload.document;
  const mutationReview = await exactReview(
    context,
    "mutation",
    mutationArtifact,
  );
  const mutationApproval = await exactApproval(
    context,
    active,
    "mutation",
    mutationReview.digest,
  );
  const executionArtifact = await context.authority.readSigned(
    "artifacts/execution.json",
  );
  const executionReview = await exactReview(
    context,
    "execution",
    executionArtifact,
  );
  await exactApproval(
    context,
    active,
    "execution",
    executionReview.digest,
  );
  if (
    !safeEqualHex(
      mutation.executionPlanDigest,
      executionArtifact.payload.digest,
    )
  ) {
    throw new Error("Mutation no longer binds the approved execution plan");
  }
  const completionMarker = `approved mutation ${mutationReview.digest} completed`;
  if (active.state.completedWork.includes(completionMarker)) {
    throw new Error("Exact approved mutation has already been executed");
  }
  const plan = await context.authority.readSigned("artifacts/plan.json");
  const safetyScan = await scanProjectExecutableInputs({
    projectRoot: context.projectRoot,
    additionalPaths: [
      ...(plan.payload.document.generatedOutputs ?? []),
      ...(mutation.tool.outputDirectories ?? []),
    ],
  });
  if (!safetyScan.safe) {
    throw new Error(
      `Mutation inputs contain destructive behavior: ${safetyScan.findings
        .map((entry) => `${entry.identifier}:${entry.reason}`)
        .join(", ")}`,
    );
  }
  await exactStoredFingerprint(
    context,
    active.state,
    "staticVerificationFingerprint",
    plan.payload.document.generatedOutputs,
  );
  let state = await commitTransition(
    context.authority,
    active.state,
    "EXECUTING",
    {
      reason: "Started one exact separately approved infrastructure mutation",
      patch: { nextLegalAction: "Complete bounded mutation and record evidence" },
    },
  );
  await mirrorProjectState(context.projectRoot, state, "Started approved mutation");
  const priorArtifacts = await captureVerificationArtifacts(
    context.projectRoot,
    mutation.successChecks,
  );
  const result = await runOne({
    context,
    approvalDigest: mutationReview.digest,
    approval: mutationApproval,
    review: mutationReview,
    action: "infrastructure-mutation",
    index: 0,
    commandIndex: 0,
    command: mutation.tool.command,
    outputDirectories: mutation.tool.outputDirectories,
    protectedPaths: [
      ...Object.values(plan.payload.document.paths ?? {}).flat(),
      ...(plan.payload.document.changes ?? []).map((change) => change.path),
      ".claude",
      ".git",
    ],
    fingerprintStage: "staticVerificationFingerprint",
  });
  result.verification = await evaluateVerification({
    projectRoot: context.projectRoot,
    results: [result],
    checks: mutation.successChecks,
    warningPolicy: mutation.warningPolicy,
    changedPaths: result.integrity?.changed ?? [],
    requireFreshArtifacts: true,
    priorArtifactStates: priorArtifacts,
  });
  const evidence = await recordRunEvidence(
    context,
    state,
    "infrastructure-mutation",
    mutationReview.digest,
    [result],
  );
  const safetyState = await enterSafetyViolationForProcessDrift(
    context,
    state,
    "infrastructure-mutation",
    [result],
  );
  if (safetyState) {
    return {
      action: "mutation",
      successful: false,
      phase: safetyState.phase,
      evidenceDigest: evidence.event.digest,
      verification: result.verification,
    };
  }
  state = await commitTransition(
    context.authority,
    state,
    evidence.successful ? "EXECUTION_APPROVED" : "DIAGNOSING",
    {
      reason: evidence.successful
        ? "Exact approved mutation completed; bounded test execution remains"
        : "Approved mutation failed and requires diagnosis",
      patch: {
        completedWork: evidence.successful
          ? [...state.completedWork, completionMarker]
          : state.completedWork,
        blocker: evidence.successful
          ? null
          : "infrastructure mutation evidence requires diagnosis",
        nextLegalAction: evidence.successful
          ? "Run the exact approved execution plan"
          : "Diagnose evidence without mutating, then stage a repair",
      },
    },
  );
  await mirrorProjectState(context.projectRoot, state, "Completed approved mutation");
  return {
    action: "mutation",
    successful: evidence.successful,
    phase: state.phase,
    evidenceDigest: evidence.event.digest,
    result: {
      program: result.program,
      executableDigest: result.executableDigest,
      specDigest: result.specDigest,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      killEscalated: result.killEscalated,
      killDeadlineExceeded: result.killDeadlineExceeded,
      truncated: result.truncated,
      integrity: result.integrity,
      verification: result.verification,
      stdout: result.stdout,
      stderr: result.stderr,
    },
  };
}

export async function runApproved(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const args = parseNamedArguments(argv);
  const action = args.action;
  if (![...PLAN_ACTIONS, "mutation", "test-run"].includes(action)) {
    throw new Error(
      "--action must be restore, build, template, mutation, or test-run",
    );
  }
  const context = await runtimeContext(env);
  const active = await activeSession(context, args["session-handle"]);
  if (PLAN_ACTIONS.has(action)) {
    return runPlanAction(context, active, action);
  }
  return action === "mutation"
    ? runMutation(context, active)
    : runExecution(context, active);
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runApproved());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
