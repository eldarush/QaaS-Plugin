import { randomBytes } from "node:crypto";
import {
  APPROVAL_DECISION_OPTIONS,
  createApprovalChallenge,
  findApprovalByDigest,
  findApprovalChallenge,
  openAuthority,
  supersedeApprovals,
  supersedeApprovalChallenges,
} from "./lib/approval-authority.mjs";
import {
  activateProject,
  isProjectActivated,
} from "./lib/activation.mjs";
import { sha256 } from "./lib/canonical-json.mjs";
import { isDirectExecution, printJson, readJsonInput } from "./lib/cli.mjs";
import { hookEnvironment } from "./lib/hook-runtime.mjs";
import {
  acquireLease,
  leaseIsExpired,
  leaseTakeoverDigest,
  synchronizeLease,
} from "./lib/lease.mjs";
import {
  computePackageSnapshot,
  writePackageSnapshot,
} from "./lib/package-snapshot.mjs";
import { redactText, secretFindings } from "./lib/redact.mjs";
import {
  computeHookSettingsInventory,
  computeRuntimeBundle,
} from "./lib/runtime-attestation.mjs";
import {
  commitCheckpoint,
  commitTransition,
  createInitialState,
  recoverStateTransaction,
} from "./lib/state.mjs";
import { refreshSessionLiveness } from "./lib/session-liveness.mjs";
import { mirrorProjectState } from "./lib/project-state-mirror.mjs";

const ATTESTATION_TTL_MS = 30 * 60 * 1000;
const REFRESH_APPROVAL_KINDS = Object.freeze([
  "context",
  "plan",
  "execution",
  "mutation",
  "source-checkout",
  "source-read",
  "capabilities",
  "readiness-fact",
  "query",
]);
const STOP_TERMINAL_PHASES = new Set([
  "VERIFIED",
  "BLOCKED",
  "SAFETY_VIOLATION",
]);
const MANUAL_COMMAND_SUCCESS_PHASES = new Set([
  "PROJECT_READY",
  "PLAN_APPROVED",
  "IMPLEMENTED_NOT_RUN",
]);
const MANUAL_STOP_COMMANDS = Object.freeze({
  "/qaas:onboard": Object.freeze({
    expectedPhase: "PROJECT_READY",
    startPhases: Object.freeze(["UNONBOARDED", "DISCOVERING"]),
  }),
  "/qaas:plan": Object.freeze({
    expectedPhase: "PLAN_APPROVED",
    startPhases: Object.freeze(["PROJECT_READY", "VERIFIED"]),
  }),
  "/qaas:implement": Object.freeze({
    expectedPhase: "IMPLEMENTED_NOT_RUN",
    startPhases: Object.freeze(["PLAN_APPROVED"]),
  }),
});
const MAX_STOP_QUESTION_BYTES = 2_400;

function sessionOutput(eventName, additionalContext, systemMessage = null) {
  return {
    hookSpecificOutput: {
      hookEventName: eventName,
      ...(additionalContext ? { additionalContext } : {}),
    },
    ...(systemMessage ? { systemMessage } : {}),
  };
}

function boundedSessionContext(value, maxBytes = 2_400) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.byteLength <= maxBytes) return bytes.toString("utf8");
  return `${bytes.subarray(0, maxBytes - 32).toString("utf8")} [summary truncated]`;
}

function boundedCheckpointList(value, maxItems = 12, maxLength = 240) {
  return Array.isArray(value)
    ? value.slice(-maxItems).map((entry) => {
        const text = String(entry);
        return text.length <= maxLength
          ? text
          : `${text.slice(0, maxLength - 14)} [truncated]`;
      })
    : [];
}

function boundedStopMessage(value) {
  if (typeof value !== "string") return null;
  const message = value.trim();
  if (
    message.length < 4 ||
    Buffer.byteLength(message, "utf8") > MAX_STOP_QUESTION_BYTES ||
    /[\0-\x08\x0B\x0C\x0E-\x1F\x7F]/u.test(message) ||
    /```/u.test(message) ||
    !/[\p{L}\p{N}]/u.test(message)
  ) {
    return null;
  }
  return message;
}

function corroboratesOneFocusedQuestion(value) {
  const message = boundedStopMessage(value);
  if (!message) return false;
  const questionMarks = message.match(/[?？؟]/gu) ?? [];
  return (
    questionMarks.length === 1 &&
    /[?？؟](?:[*_`]*)$/u.test(message)
  );
}

function manualStopCommand(prompt) {
  if (typeof prompt !== "string") return null;
  const match = prompt.match(
    /^\s*(\/qaas:(?:onboard|plan|implement))(?:\s+[\s\S]*?)?\s*$/u,
  );
  return match ? match[1] : null;
}

function isSlashCommandPrompt(prompt) {
  return (
    typeof prompt === "string" &&
    /^\s*\/[\p{L}\p{N}_-]+(?::[\p{L}\p{N}_-]+)*(?:\s+[\s\S]*?)?\s*$/iu.test(
      prompt,
    )
  );
}

function manualStopBoundaryPath(sessionId) {
  return `sessions/${sha256(sessionId)}/manual-stop-boundary.json`;
}

async function updateManualStopBoundaryForPrompt(
  authority,
  event,
  state,
  prompt,
  { questionState = null } = {},
) {
  const lease = await authority.readSigned("lease/current.json", {
    required: false,
  });
  if (
    !lease ||
    lease.payload.status !== "active" ||
    lease.payload.sessionId !== event.session_id ||
    leaseIsExpired(lease.payload)
  ) {
    return false;
  }
  const relative = manualStopBoundaryPath(event.session_id);
  const prior = await authority.readSigned(relative, { required: false });
  const command = manualStopCommand(prompt);
  const specification = command ? MANUAL_STOP_COMMANDS[command] : null;
  if (
    specification &&
    specification.startPhases.includes(state.phase)
  ) {
    const boundary = {
      schemaVersion: "1.0",
      projectId: authority.projectId,
      sessionId: event.session_id,
      boundaryId: randomBytes(18).toString("hex"),
      issuedLeaseId: lease.payload.leaseId,
      command,
      expectedPhase: specification.expectedPhase,
      startPhase: state.phase,
      issuedStateSequence: state.sequence,
      issuedStateDigest: sha256(state),
      sourceEvent: event.hook_event_name,
      status: "pending",
      issuedAt: new Date().toISOString(),
      sequence: (prior?.payload.sequence ?? -1) + 1,
    };
    await authority.writeSigned(relative, boundary, {
      expectedSequence: prior?.payload.sequence ?? -1,
    });
    await authority.appendEvent("manual-stop-boundary-issued", {
      sessionId: event.session_id,
      boundaryId: boundary.boundaryId,
      command,
      issuedLeaseId: boundary.issuedLeaseId,
      expectedPhase: boundary.expectedPhase,
      issuedStateSequence: boundary.issuedStateSequence,
    });
    return true;
  }
  if (prior?.payload.status !== "pending") return false;
  if (
    !specification &&
    !isSlashCommandPrompt(prompt) &&
    questionState?.awaitingUser === true &&
    questionState.projectId === authority.projectId &&
    state.projectId === authority.projectId &&
    state.phase === questionState.phase &&
    state.sequence === questionState.sequence + 1 &&
    prior.payload.projectId === authority.projectId &&
    prior.payload.sessionId === event.session_id &&
    prior.payload.issuedLeaseId === lease.payload.leaseId &&
    Number.isSafeInteger(prior.payload.issuedStateSequence) &&
    prior.payload.issuedStateSequence <= questionState.sequence
  ) {
    const continued = {
      ...prior.payload,
      continuationCount: (prior.payload.continuationCount ?? 0) + 1,
      lastQuestionStateSequence: questionState.sequence,
      lastQuestionStateDigest: sha256(questionState),
      lastAnswerStateSequence: state.sequence,
      lastAnswerStateDigest: sha256(state),
      lastAnswerAt: new Date().toISOString(),
      sequence: prior.payload.sequence + 1,
    };
    await authority.writeSigned(relative, continued, {
      expectedSequence: prior.payload.sequence,
    });
    await authority.appendEvent("manual-stop-boundary-continued", {
      sessionId: event.session_id,
      boundaryId: continued.boundaryId,
      command: continued.command,
      issuedLeaseId: continued.issuedLeaseId,
      continuationCount: continued.continuationCount,
      questionStateSequence: questionState.sequence,
      answerStateSequence: state.sequence,
    });
    return true;
  }
  const invalidated = {
    ...prior.payload,
    status: "invalidated",
    invalidatedAt: new Date().toISOString(),
    invalidatedStateSequence: state.sequence,
    invalidationReason: specification
      ? `command is not legal from ${state.phase}`
      : isSlashCommandPrompt(prompt)
        ? "another slash command interrupted the pending manual boundary"
        : "next lease-owner prompt is unrelated",
    sequence: prior.payload.sequence + 1,
  };
  await authority.writeSigned(relative, invalidated, {
    expectedSequence: prior.payload.sequence,
  });
  await authority.appendEvent("manual-stop-boundary-invalidated", {
    sessionId: event.session_id,
    boundaryId: invalidated.boundaryId,
    reason: invalidated.invalidationReason,
  });
  return false;
}

async function consumeManualStopBoundary(authority, event, state) {
  if (!MANUAL_COMMAND_SUCCESS_PHASES.has(state.phase)) return false;
  const relative = manualStopBoundaryPath(event.session_id);
  const [record, lease] = await Promise.all([
    authority.readSigned(relative, { required: false }),
    authority.readSigned("lease/current.json", { required: false }),
  ]);
  const boundary = record?.payload;
  if (
    !boundary ||
    !lease ||
    lease.payload.status !== "active" ||
    lease.payload.sessionId !== event.session_id ||
    leaseIsExpired(lease.payload) ||
    boundary.status !== "pending" ||
    boundary.projectId !== authority.projectId ||
    boundary.sessionId !== event.session_id ||
    boundary.issuedLeaseId !== lease.payload.leaseId ||
    MANUAL_STOP_COMMANDS[boundary.command]?.expectedPhase !== state.phase ||
    boundary.expectedPhase !== state.phase ||
    !Number.isSafeInteger(boundary.issuedStateSequence) ||
    boundary.issuedStateSequence > state.sequence
  ) {
    return false;
  }
  const consumed = {
    ...boundary,
    status: "consumed",
    consumedAt: new Date().toISOString(),
    consumedStateSequence: state.sequence,
    consumedStateDigest: sha256(state),
    sequence: boundary.sequence + 1,
  };
  await authority.writeSigned(relative, consumed, {
    expectedSequence: boundary.sequence,
  });
  await authority.appendEvent("manual-stop-boundary-consumed", {
    sessionId: event.session_id,
    boundaryId: consumed.boundaryId,
    command: consumed.command,
    issuedLeaseId: consumed.issuedLeaseId,
    phase: state.phase,
    consumedStateSequence: state.sequence,
  });
  return true;
}

async function setHookOwnedAwaitingUser(
  authority,
  state,
  context,
  awaitingUser,
  reason,
) {
  if (state.awaitingUser === awaitingUser) return state;
  const next = await commitCheckpoint(
    authority,
    state,
    { awaitingUser },
    { reason },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    awaitingUser
      ? "Stop hook corroborated a user-wait boundary"
      : "Stop hook rejected an uncorroborated user-wait boundary",
  );
  return next;
}

async function ensureState(authority) {
  let record = await authority.readSigned("state/current.json", {
    required: false,
  });
  if (!record) {
    const state = createInitialState({ projectId: authority.projectId });
    await authority.writeSigned("state/current.json", state, {
      expectedSequence: -1,
    });
    await authority.appendEvent("state-initialized", {
      phase: state.phase,
      stateDigest: sha256(state),
    });
    record = await authority.readSigned("state/current.json");
  }
  await recoverStateTransaction(authority);
  return authority.readSigned("state/current.json");
}

async function activatedAuthority(context) {
  if (!context.pluginData) return null;
  try {
    const authority = await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: false,
    });
    return (await isProjectActivated(authority)) ? authority : null;
  } catch (error) {
    if (/No protected authority exists|ENOENT/u.test(error.message)) return null;
    throw error;
  }
}

async function writeAttestation(authority, event, context, state) {
  const runtimeBundle = await computeRuntimeBundle({
    pluginRoot: context.pluginRoot,
    pluginVersion: context.pluginVersion,
  });
  const settings = await computeHookSettingsInventory({
    projectRoot: context.projectRoot,
    userHome: context.env.USERPROFILE ?? context.env.HOME ?? null,
  });
  const active =
    settings.valid === true &&
    settings.disableAllHooks !== true &&
    settings.unknownSideEffectingHooks === false;
  const prior = await authority.readSigned("attestations/hooks.json", {
    required: false,
  });
  const issuedAt = new Date().toISOString();
  const sessionHandle = randomBytes(24).toString("hex");
  const attestation = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    pluginVersion: context.pluginVersion,
    sessionId: event.session_id,
    sessionHandleDigest: sha256(sessionHandle),
    runtimeBundleDigest: runtimeBundle.digest,
    settingsDigest: settings.digest ?? null,
    status: active ? "active" : "inactive",
    disableAllHooks: settings.disableAllHooks === true,
    unknownSideEffectingHooks: settings.unknownSideEffectingHooks !== false,
    issuedAt,
    expiresAt: new Date(Date.parse(issuedAt) + ATTESTATION_TTL_MS).toISOString(),
    sequence: (prior?.payload.sequence ?? -1) + 1,
  };
  await authority.writeSigned("attestations/hooks.json", attestation, {
    expectedSequence: prior?.payload.sequence ?? -1,
  });
  if (state.hooksAttested !== active) {
    state = await commitCheckpoint(
      authority,
      state,
      {
        hooksAttested: active,
        nextLegalAction: active
          ? state.nextLegalAction
          : "Resolve hook configuration conflicts before writes or runs",
      },
      { reason: active ? "Activated runtime hook attestation" : "Hook attestation is inactive" },
    );
  }
  return { active, attestation, settings, state, sessionHandle };
}

export async function completeApprovedLeaseTakeover(
  authority,
  event,
  context,
  approval,
) {
  if (
    approval?.kind !== "lease-takeover" ||
    approval.sessionId !== event.session_id
  ) {
    throw new Error("Lease takeover completion requires the exact minted approval");
  }
  let state = (await authority.readSigned("state/current.json")).payload;
  const lease = await acquireLease(authority, {
    sessionId: event.session_id,
    taskId: state.taskId ?? "__onboarding__",
    phase: state.phase,
    takeoverApprovalId: approval.approvalId,
  });
  state = (await authority.readSigned("state/current.json")).payload;
  const attested = await writeAttestation(authority, event, context, state);
  await authority.appendEvent("lease-takeover-session-activated", {
    sessionId: event.session_id,
    leaseId: lease.leaseId,
    approvalId: approval.approvalId,
  });
  return {
    lease,
    sessionHandle: attested.sessionHandle,
    state: attested.state,
  };
}

async function establishLease(
  authority,
  event,
  state,
  takeoverApprovalId = null,
) {
  const taskId = state.taskId ?? "__onboarding__";
  const existing = await authority.readSigned("lease/current.json", {
    required: false,
  });
  if (
    existing?.payload.status === "active" &&
    existing.payload.sessionId !== event.session_id &&
    !takeoverApprovalId
  ) {
    return {
      writable: false,
      reason:
        "another top-level session holds the project write lease; explicit signed takeover approval is required",
      lease: existing.payload,
    };
  }
  if (
    existing?.payload.status === "active" &&
    existing.payload.sessionId === event.session_id &&
    !leaseIsExpired(existing.payload)
  ) {
    return {
      writable: true,
      lease: await synchronizeLease(authority, {
        sessionId: event.session_id,
        taskId,
        phase: state.phase,
      }),
    };
  }
  return {
    writable: true,
    lease: await acquireLease(authority, {
      sessionId: event.session_id,
      taskId,
      phase: state.phase,
      takeoverApprovalId,
    }),
  };
}

function takeoverQuestion(lease, event, taskId, digest) {
  return {
    question:
      `Approve exact QaaS lease takeover from session ${lease.sessionId} ` +
      `to ${event.session_id} for task ${taskId} with SHA-256 ${digest}?`,
    header: "QaaS Lease",
    options: APPROVAL_DECISION_OPTIONS,
    multiSelect: false,
  };
}

async function resolveLeaseTakeover(authority, event, state, lease) {
  const taskId = state.taskId ?? "__onboarding__";
  const approvalDigest = leaseTakeoverDigest({
    leaseId: lease.leaseId,
    currentSessionId: lease.sessionId,
    newSessionId: event.session_id,
    taskId,
  });
  const approval = await findApprovalByDigest(authority, {
    kind: "lease-takeover",
    approvedDigest: approvalDigest,
    sessionId: event.session_id,
    leaseId: lease.leaseId,
  });
  if (approval) {
    return { approved: true, approvalId: approval.approvalId };
  }
  const question = takeoverQuestion(lease, event, taskId, approvalDigest);
  let challenge = await findApprovalChallenge(authority, {
    sessionId: event.session_id,
    question,
  });
  if (!challenge) {
    challenge = await createApprovalChallenge(authority, {
      challengeId: randomBytes(24).toString("hex"),
      kind: "lease-takeover",
      objectId: lease.leaseId,
      approvalDigest,
      sessionId: event.session_id,
      questionId: question.header,
      prompt: question.question,
      options: question.options,
      multiSelect: question.multiSelect,
      expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      leaseId: lease.leaseId,
    });
  }
  return {
    approved: false,
    challengeId: challenge.challengeId,
    question,
    expiredLease: leaseIsExpired(lease),
  };
}

async function handleSessionStart(event, context) {
  if (!context.pluginData) {
    return {};
  }
  if (typeof event.session_id !== "string" || event.session_id.length === 0) {
    throw new Error("SessionStart requires session_id");
  }
  let authority;
  try {
    authority = await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: false,
    });
  } catch (error) {
    if (/No protected authority exists|ENOENT/u.test(error.message)) return {};
    throw error;
  }
  if (!(await isProjectActivated(authority))) return {};
  let { payload: state } = await ensureState(authority);
  const existingLease = await authority.readSigned("lease/current.json", {
    required: false,
  });
  let takeoverApprovalId = null;
  if (
    existingLease?.payload.status === "active" &&
    existingLease.payload.sessionId !== event.session_id
  ) {
    const takeover = await resolveLeaseTakeover(
      authority,
      event,
      state,
      existingLease.payload,
    );
    if (takeover.approved) {
      takeoverApprovalId = takeover.approvalId;
      await acquireLease(authority, {
        sessionId: event.session_id,
        taskId: state.taskId ?? "__onboarding__",
        phase: state.phase,
        takeoverApprovalId,
      });
      state = (await authority.readSigned("state/current.json")).payload;
    } else {
      const exactInput = JSON.stringify({ questions: [takeover.question] });
      await authority.appendEvent("lease-takeover-challenge-created", {
        challengeId: takeover.challengeId,
        leaseId: existingLease.payload.leaseId,
        newSessionId: event.session_id,
        expiredLease: takeover.expiredLease,
      });
      return sessionOutput(
        "SessionStart",
        boundedSessionContext(
          `QaaS phase: ${state.phase}. Write lease: read-only. ` +
            `Call AskUserQuestion once with this exact JSON input: ${exactInput}`,
        ),
        "QaaS write/run authority requires the exact signed lease-takeover approval.",
      );
    }
  }
  if (
    existingLease?.payload.status === "active" &&
    existingLease.payload.sessionId !== event.session_id &&
    !takeoverApprovalId
  ) {
    return sessionOutput(
      "SessionStart",
      `QaaS phase: ${state.phase}. Write lease: read-only. Another top-level session holds the signed project lease.`,
      "QaaS write/run authority unavailable; explicit signed takeover approval is required.",
    );
  }
  const attested = await writeAttestation(authority, event, context, state);
  state = attested.state;
  const lease = attested.active
    ? await establishLease(authority, event, state, takeoverApprovalId)
    : { writable: false, reason: "runtime hook attestation is inactive" };
  const summary = [
    `QaaS phase: ${state.phase}.`,
    `Task: ${state.taskId ?? "none"}.`,
    `Hook attestation: ${attested.active ? "active" : "inactive"}.`,
    `Write lease: ${lease.writable ? "held by this session" : "read-only"}.`,
    ...(lease.writable ? [`Session handle: ${attested.sessionHandle}.`] : []),
    `Next legal action: ${state.nextLegalAction}.`,
    ...(lease.writable
      ? [
          "Before continuing, call workflow-authority.mjs resume with this session handle and follow only its signed bounded projection.",
        ]
      : []),
  ].join(" ");
  await authority.appendEvent("session-started", {
    sessionId: event.session_id,
    source: typeof event.source === "string" ? event.source : "unknown",
    phase: state.phase,
    attested: attested.active,
    writable: lease.writable,
  });
  return sessionOutput(
    "SessionStart",
    boundedSessionContext(summary),
    lease.writable ? null : `QaaS write/run authority unavailable: ${lease.reason}.`,
  );
}

async function checkpointLifecycleEvent(event, context) {
  if (!context.pluginData || typeof event.session_id !== "string") return {};
  const authority = await activatedAuthority(context);
  if (!authority) return {};
  const stateRecord = await authority.readSigned("state/current.json", {
    required: false,
  });
  if (!stateRecord) return {};
  let state = stateRecord.payload;
  let stopCorroboration = null;
  let stopDecision = {};
  if (event.hook_event_name === "Stop") {
    if (event.stop_hook_active === true) {
      stopCorroboration = "recursion-guard";
    } else if (STOP_TERMINAL_PHASES.has(state.phase)) {
      stopCorroboration = "terminal-phase";
    } else if (corroboratesOneFocusedQuestion(event.last_assistant_message)) {
      stopCorroboration = "single-focused-question";
      state = await setHookOwnedAwaitingUser(
        authority,
        state,
        context,
        true,
        "Stop hook corroborated exactly one focused user question",
      );
      await authority.appendEvent("stop-question-corroborated", {
        sessionId: event.session_id,
        phase: state.phase,
        messageDigest: sha256(event.last_assistant_message.trim()),
        messageBytes: Buffer.byteLength(
          event.last_assistant_message.trim(),
          "utf8",
        ),
      });
    } else if (
      boundedStopMessage(event.last_assistant_message) &&
      !/[?？؟]/u.test(event.last_assistant_message) &&
      await consumeManualStopBoundary(authority, event, state)
    ) {
      stopCorroboration = "manual-command-success-phase";
      state = await setHookOwnedAwaitingUser(
        authority,
        state,
        context,
        true,
        `Stop hook corroborated documented manual-command success phase ${state.phase}`,
      );
    } else {
      state = await setHookOwnedAwaitingUser(
        authority,
        state,
        context,
        false,
        "Stop hook rejected an uncorroborated waiting claim",
      );
      stopDecision = {
        decision: "block",
        reason: boundedSessionContext(
          "QaaS work is not at a documented command boundary or terminal phase, and the final response is not exactly one focused question. " +
            `Continue with the signed next legal action: ${state.nextLegalAction ?? "resume the bounded workflow"}. ` +
            "A progress checkpoint cannot authorize Stop.",
          1_200,
        ),
      };
    }
  }
  const prior = await authority.readSigned(
    `sessions/${sha256(event.session_id)}/checkpoint.json`,
    { required: false },
  );
  const payload = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    sessionId: event.session_id,
    eventName: event.hook_event_name,
    phase: state.phase,
    stateSequence: state.sequence,
    stateDigest: sha256(state),
    taskId: state.taskId ?? null,
    completedWork: boundedCheckpointList(state.completedWork),
    remainingWork: boundedCheckpointList(state.remainingWork),
    evidencePaths: boundedCheckpointList(state.evidencePaths),
    blocker:
      typeof state.blocker === "string"
        ? state.blocker.slice(0, 512)
        : null,
    awaitingUser: state.awaitingUser === true,
    nextLegalAction:
      typeof state.nextLegalAction === "string"
        ? state.nextLegalAction.slice(0, 512)
        : null,
    approvedKinds: Object.keys(
      state.approvedDigests ?? {},
    ).sort(),
    projectFingerprint:
      state.fingerprints?.staticVerificationFingerprint ??
      state.fingerprints?.expectedWorkingFingerprint ??
      state.fingerprints?.onboardingFingerprint ??
      null,
    stopCorroboration,
    checkpointId: randomBytes(18).toString("hex"),
    timestamp: new Date().toISOString(),
    sequence: (prior?.payload.sequence ?? -1) + 1,
  };
  await authority.writeSigned(
    `sessions/${sha256(event.session_id)}/checkpoint.json`,
    payload,
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  await authority.appendEvent("session-checkpoint", {
    sessionId: event.session_id,
    eventName: event.hook_event_name,
    phase: payload.phase,
    stateDigest: payload.stateDigest,
  });
  return stopDecision;
}

function contextRefreshPatch() {
  return {
    taskId: null,
    contextDigest: null,
    packageSnapshotDigest: null,
    approvedDigests: {},
    fingerprints: {},
    hooksAttested: false,
    completedWork: [],
    remainingWork: [],
    evidencePaths: [],
    blocker: null,
    awaitingUser: false,
    nextLegalAction:
      "Complete fresh evidence-bound discovery and stage reviewed context",
  };
}

async function supersedeRefreshApprovals(authority, sessionId, phase) {
  const reason = `Explicit /qaas:onboard context refresh from ${phase}`;
  for (const kind of REFRESH_APPROVAL_KINDS) {
    await supersedeApprovalChallenges(authority, {
      kind,
      sessionId,
      reason,
    });
    await supersedeApprovals(authority, {
      kind,
      sessionId,
      reason,
    });
  }
}

async function resetStagedContext(authority) {
  const existing = await authority.readSigned("staging/context.json", {
    required: false,
  });
  await authority.writeSigned(
    "staging/context.json",
    {
      schemaVersion: "1.0",
      projectId: authority.projectId,
      files: {},
      refreshedAt: new Date().toISOString(),
      sequence: (existing?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: existing?.payload.sequence ?? -1 },
  );
}

async function refreshProjectContext(authority, event, context, currentState) {
  await supersedeRefreshApprovals(
    authority,
    event.session_id,
    currentState.phase,
  );
  const patch = contextRefreshPatch();
  let next;
  if (currentState.phase === "DISCOVERING") {
    next = await commitCheckpoint(authority, currentState, patch, {
      reason: "Explicit /qaas:onboard restarted in-progress discovery",
    });
  } else if (
    ["CONTEXT_REVIEW", "STALE", "BLOCKED"].includes(currentState.phase)
  ) {
    next = await commitTransition(authority, currentState, "DISCOVERING", {
      reason:
        `Explicit /qaas:onboard restarted discovery from ${currentState.phase}`,
      patch,
    });
  } else {
    const stale = await commitTransition(authority, currentState, "STALE", {
      reason:
        `Explicit /qaas:onboard invalidated active context from ${currentState.phase}`,
      patch: {
        blocker: null,
        awaitingUser: false,
        nextLegalAction: "Restart discovery from current project evidence",
      },
    });
    next = await commitTransition(authority, stale, "DISCOVERING", {
      reason:
        `Explicit /qaas:onboard restarted discovery from ${currentState.phase}`,
      patch,
    });
  }
  await resetStagedContext(authority);
  const packageSnapshot = await writePackageSnapshot(
    authority,
    "packages/discovery.json",
    await computePackageSnapshot({
      projectRoot: context.projectRoot,
      env: context.env,
    }),
  );
  await authority.appendEvent("context-refresh-started", {
    sessionId: event.session_id,
    priorPhase: currentState.phase,
    phase: next.phase,
    packageSnapshotDigest: packageSnapshot.digest,
  });
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Restarted reviewed context discovery",
  );
  return {};
}

async function prepareContextRefreshAuthority(authority, event, context) {
  const started = await handleSessionStart(
    {
      ...event,
      hook_event_name: "SessionStart",
      source: "explicit-user-prompt",
    },
    context,
  );
  const [lease, attestation] = await Promise.all([
    authority.readSigned("lease/current.json", { required: false }),
    authority.readSigned("attestations/hooks.json", { required: false }),
  ]);
  const writable =
    lease?.payload.status === "active" &&
    lease.payload.sessionId === event.session_id &&
    !leaseIsExpired(lease.payload) &&
    attestation?.payload.status === "active" &&
    attestation.payload.sessionId === event.session_id;
  return { writable, started };
}

async function heartbeatPromptSession(event, context) {
  if (!context.pluginData || typeof event.session_id !== "string") return null;
  try {
    const authority = await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: false,
    });
    const refreshed = await refreshSessionLiveness(authority, {
      sessionId: event.session_id,
      projectRoot: context.projectRoot,
      pluginRoot: context.pluginRoot,
      pluginVersion: context.pluginVersion,
      userHome: context.env.USERPROFILE ?? context.env.HOME ?? null,
    });
    if (!refreshed.refreshed) return null;
    return {
      rotated: refreshed.leaseRotated === true,
      leaseId: refreshed.lease?.leaseId ?? null,
      ...(refreshed.leaseRotated
        ? {
            message:
              "QaaS rotated the expired same-session lease and invalidated prior approvals; exact work must be reapproved.",
          }
        : {}),
    };
  } catch {
    return null;
  }
}

async function clearAwaitingUserAfterPrompt(authority, event, context) {
  const stateRecord = await authority.readSigned("state/current.json", {
    required: false,
  });
  if (
    !stateRecord ||
    stateRecord.payload.awaitingUser !== true ||
    stateRecord.payload.phase === "SAFETY_VIOLATION"
  ) {
    return false;
  }
  const lease = await authority.readSigned("lease/current.json", {
    required: false,
  });
  if (
    !lease ||
    lease.payload.status !== "active" ||
    lease.payload.sessionId !== event.session_id ||
    leaseIsExpired(lease.payload)
  ) {
    return false;
  }
  const next = await commitCheckpoint(
    authority,
    stateRecord.payload,
    { awaitingUser: false },
    { reason: "Received the next valid user response" },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Cleared awaiting-user checkpoint after a valid response",
  );
  return true;
}

async function handleUserPrompt(event, context) {
  const prompt =
    event.hook_event_name === "UserPromptExpansion"
      ? `${event.prompt ?? ""}\n${event.command_args ?? ""}`
      : event.prompt;
  if (typeof prompt !== "string") {
    return {
      decision: "block",
      reason: "QaaS rejected a malformed user prompt event.",
    };
  }
  const findings = secretFindings(prompt);
  const activationRequested =
    /^\s*\/qaas:onboard(?:\s+[\s\S]*?)?\s*$/u.test(prompt);
  if (activationRequested) {
    if (findings.length > 0) {
      return {
        decision: "block",
        reason:
          "QaaS detected credential-like material. Store the value in a user-selected environment variable and provide only its variable name.",
      };
    }
    if (!context.pluginData || typeof event.session_id !== "string") {
      return {
        decision: "block",
        reason:
          "QaaS activation requires CLAUDE_PLUGIN_DATA and a real session ID.",
      };
    }
    const authority = await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: true,
    });
    const recoveryRecord = await ensureState(authority);
    if (recoveryRecord.payload.phase === "SAFETY_VIOLATION") {
      return {
        decision: "block",
        reason:
          "QaaS onboarding cannot clear SAFETY_VIOLATION. Preserve the evidence and resolve the recorded safety blocker explicitly.",
      };
    }
    await activateProject(authority, {
      sessionId: event.session_id,
      userPrompt: prompt,
    });
    if (recoveryRecord.payload.phase !== "UNONBOARDED") {
      const prepared = await prepareContextRefreshAuthority(
        authority,
        event,
        context,
      );
      if (!prepared.writable) return prepared.started;
      const refreshState = (
        await authority.readSigned("state/current.json")
      ).payload;
      await refreshProjectContext(
        authority,
        event,
        context,
        refreshState,
      );
    }
    const started = await handleSessionStart(
      {
        ...event,
        hook_event_name: "SessionStart",
        source: "explicit-user-prompt",
      },
      context,
    );
    if (started.hookSpecificOutput) {
      started.hookSpecificOutput.hookEventName = "UserPromptSubmit";
    }
    const boundaryState = (
      await authority.readSigned("state/current.json")
    ).payload;
    await updateManualStopBoundaryForPrompt(
      authority,
      event,
      boundaryState,
      prompt,
    );
    return started;
  }
  const authority = await activatedAuthority(context);
  if (!authority) return {};
  if (findings.length > 0) {
    return {
      decision: "block",
      reason:
        "QaaS detected credential-like material. Store the value in a user-selected environment variable and provide only its variable name.",
    };
  }
  const heartbeat = await heartbeatPromptSession(event, context);
  if (prompt.trim() !== "" && heartbeat?.leaseId) {
    const questionState = (
      await authority.readSigned("state/current.json")
    ).payload;
    const clearedAwaitingUser = await clearAwaitingUserAfterPrompt(
      authority,
      event,
      context,
    );
    const state = (
      await authority.readSigned("state/current.json")
    ).payload;
    await updateManualStopBoundaryForPrompt(
      authority,
      event,
      state,
      prompt,
      {
        questionState:
          clearedAwaitingUser && heartbeat.rotated !== true
            ? questionState
            : null,
      },
    );
  }
  return heartbeat?.message ? { systemMessage: heartbeat.message } : {};
}

async function handleConfigChange(event, context) {
  if (!context.pluginData || !(await activatedAuthority(context))) return {};
  const serialized = JSON.stringify(event);
  const suspicious =
    /disableAllHooks/iu.test(serialized) ||
    /pretool-safety\.mjs|posttool-ledger\.mjs|session-state\.mjs/iu.test(
      serialized,
    );
  if (!suspicious) return {};
  try {
    const authority = await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: false,
    });
    const stateRecord = await authority.readSigned("state/current.json", {
      required: false,
    });
    if (stateRecord?.payload.hooksAttested === true) {
      await commitCheckpoint(
        authority,
        stateRecord.payload,
        {
          hooksAttested: false,
          approvedDigests: {},
          nextLegalAction: "Run /qaas:doctor after the hook configuration change",
        },
        { reason: "Hook-affecting configuration changed" },
      );
    }
    await authority.appendEvent("hook-configuration-changed", {
      sessionId: event.session_id ?? null,
      source: event.source ?? null,
      suspicious: true,
    });
  } catch {
    // A config-change notification cannot restore a missing or disabled hook.
    // The next write/run still fails because its short-lived attestation no
    // longer matches the settings inventory.
  }
  return {
    systemMessage:
      "QaaS invalidated write/run attestation after a hook-affecting configuration change. Run /qaas:doctor.",
  };
}

export async function handleSessionEvent(event, overrides = {}) {
  if (!event || typeof event.hook_event_name !== "string") {
    throw new Error("Malformed lifecycle hook event");
  }
  const context = hookEnvironment(event, overrides);
  switch (event.hook_event_name) {
    case "SessionStart":
      return handleSessionStart(event, context);
    case "UserPromptSubmit":
    case "UserPromptExpansion":
      return handleUserPrompt(event, context);
    case "PreCompact":
    case "PostCompact":
    case "Stop":
      return checkpointLifecycleEvent(event, context);
    case "ConfigChange":
      return handleConfigChange(event, context);
    default:
      return {};
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await handleSessionEvent(await readJsonInput()));
  } catch (error) {
    const detail = boundedSessionContext(
      redactText(error?.message ?? "unknown lifecycle failure"),
      1_200,
    );
    process.stderr.write(
      `QaaS lifecycle hook failed closed: ${detail}\n`,
    );
    process.exitCode = 2;
  }
}
