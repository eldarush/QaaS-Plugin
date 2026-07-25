import { randomBytes } from "node:crypto";
import {
  APPROVAL_DECISION_OPTIONS,
  createApprovalChallenge,
  findApprovalByDigest,
  findApprovalChallenge,
  openAuthority,
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
import { secretFindings } from "./lib/redact.mjs";
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
  const prior = await authority.readSigned(
    `sessions/${sha256(event.session_id)}/checkpoint.json`,
    { required: false },
  );
  const payload = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    sessionId: event.session_id,
    eventName: event.hook_event_name,
    phase: stateRecord.payload.phase,
    stateSequence: stateRecord.payload.sequence,
    stateDigest: sha256(stateRecord.payload),
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
  return {};
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
  const activationRequested = /^\s*\/qaas:onboard\s*$/u.test(prompt);
  if (activationRequested) {
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
    await activateProject(authority, {
      sessionId: event.session_id,
      userPrompt: prompt,
    });
    const recoveryRecord = await ensureState(authority);
    if (["STALE", "BLOCKED"].includes(recoveryRecord.payload.phase)) {
      for (const kind of [
        "context",
        "plan",
        "execution",
        "mutation",
        "source-checkout",
        "capabilities",
        "readiness-fact",
        "query",
      ]) {
        await supersedeApprovalChallenges(authority, {
          kind,
          sessionId: event.session_id,
          reason: `Exact /qaas:onboard recovery from ${recoveryRecord.payload.phase}`,
        });
      }
      const recovered = await commitTransition(
        authority,
        recoveryRecord.payload,
        "DISCOVERING",
        {
          reason:
            `Exact /qaas:onboard restarted discovery from ${recoveryRecord.payload.phase}`,
          patch: {
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
            nextLegalAction:
              "Complete fresh evidence-bound discovery and stage context",
          },
        },
      );
      await mirrorProjectState(
        context.projectRoot,
        recovered,
        "Recovered through exact onboarding",
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
    return started;
  }
  if (!(await activatedAuthority(context))) return {};
  const findings = secretFindings(prompt);
  if (findings.length > 0) {
    return {
      decision: "block",
      reason:
        "QaaS detected credential-like material. Store the value in a user-selected environment variable and provide only its variable name.",
    };
  }
  const heartbeat = await heartbeatPromptSession(event, context);
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
    printJson({
      systemMessage:
        `QaaS lifecycle hook failed closed for write/run authority: ${error.message}`,
    });
    process.exitCode = 0;
  }
}
