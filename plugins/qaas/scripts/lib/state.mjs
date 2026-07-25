import { canonicalDigest, sha256 } from "./canonical-json.mjs";
import { PHASES } from "./phase-gate.mjs";
import { randomBytes } from "node:crypto";

const STATE_TRANSACTION_PATH = "transactions/state-current.json";

const BASE_TRANSITIONS = Object.freeze({
  UNONBOARDED: ["DISCOVERING"],
  DISCOVERING: ["CONTEXT_REVIEW", "BLOCKED"],
  CONTEXT_REVIEW: ["PROJECT_READY", "DISCOVERING", "BLOCKED"],
  PROJECT_READY: ["TASK_DISCOVERY", "STALE", "BLOCKED"],
  TASK_DISCOVERY: ["PLAN_REVIEW", "BLOCKED", "STALE"],
  PLAN_REVIEW: ["PLAN_APPROVED", "TASK_DISCOVERY", "STALE", "BLOCKED"],
  PLAN_APPROVED: ["IMPLEMENTING", "PLAN_REVIEW", "STALE", "BLOCKED"],
  IMPLEMENTING: ["BUILD_VERIFIED", "DIAGNOSING", "BLOCKED", "STALE"],
  BUILD_VERIFIED: [
    "TEMPLATE_VERIFIED",
    "IMPLEMENTING",
    "DIAGNOSING",
    "STALE",
    "BLOCKED",
  ],
  TEMPLATE_VERIFIED: ["IMPLEMENTED_NOT_RUN", "IMPLEMENTING", "STALE", "BLOCKED"],
  IMPLEMENTED_NOT_RUN: ["EXECUTION_REVIEW", "TASK_DISCOVERY", "STALE", "BLOCKED"],
  EXECUTION_REVIEW: [
    "MUTATION_REVIEW",
    "EXECUTION_APPROVED",
    "IMPLEMENTED_NOT_RUN",
    "STALE",
    "BLOCKED",
  ],
  MUTATION_REVIEW: [
    "MUTATION_APPROVED",
    "EXECUTION_REVIEW",
    "STALE",
    "BLOCKED",
  ],
  MUTATION_APPROVED: [
    "EXECUTION_REVIEW",
    "IMPLEMENTED_NOT_RUN",
    "EXECUTION_APPROVED",
    "MUTATION_REVIEW",
    "STALE",
    "BLOCKED",
  ],
  EXECUTION_APPROVED: ["EXECUTING", "EXECUTION_REVIEW", "STALE", "BLOCKED"],
  EXECUTING: [
    "EXECUTION_APPROVED",
    "VERIFIED",
    "DIAGNOSING",
    "BLOCKED",
    "STALE",
  ],
  VERIFIED: ["TASK_DISCOVERY", "STALE"],
  DIAGNOSING: [
    "REPAIRING",
    "TASK_DISCOVERY",
    "VERIFIED",
    "BLOCKED",
    "STALE"
  ],
  REPAIRING: ["IMPLEMENTING", "BLOCKED", "STALE"],
  STALE: ["DISCOVERING", "BLOCKED"],
  BLOCKED: ["DISCOVERING", "TASK_DISCOVERY"],
  SAFETY_VIOLATION: [],
});

export function createInitialState({ projectId, now = new Date().toISOString() }) {
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new TypeError("projectId is required");
  }
  return {
    schemaVersion: "1.0",
    projectId,
    phase: "UNONBOARDED",
    sequence: 0,
    taskId: null,
    approvedDigests: {},
    fingerprints: {},
    hooksAttested: false,
    completedWork: [],
    remainingWork: [],
    evidencePaths: [],
    blocker: null,
    nextLegalAction: "Begin read-only discovery",
    updatedAt: now,
  };
}

export function validateState(state) {
  const errors = [];
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    return { valid: false, errors: ["state must be an object"] };
  }
  if (state.schemaVersion !== "1.0") errors.push("unsupported schemaVersion");
  if (typeof state.projectId !== "string" || !state.projectId) {
    errors.push("projectId is required");
  }
  if (!PHASES.includes(state.phase)) errors.push(`unknown phase: ${state.phase}`);
  if (!Number.isSafeInteger(state.sequence) || state.sequence < 0) {
    errors.push("sequence must be a non-negative safe integer");
  }
  if (!state.approvedDigests || typeof state.approvedDigests !== "object") {
    errors.push("approvedDigests must be an object");
  }
  if (!state.fingerprints || typeof state.fingerprints !== "object") {
    errors.push("fingerprints must be an object");
  }
  return { valid: errors.length === 0, errors };
}

export function legalTransitions(phase) {
  if (!PHASES.includes(phase)) return [];
  const base = BASE_TRANSITIONS[phase] ?? [];
  return phase === "SAFETY_VIOLATION"
    ? []
    : [...new Set([...base, "SAFETY_VIOLATION"])];
}

export function canTransition(from, to) {
  return legalTransitions(from).includes(to);
}

export function transitionState(
  state,
  to,
  {
    expectedSequence = state?.sequence,
    reason,
    patch = {},
    now = new Date().toISOString(),
  } = {},
) {
  const validity = validateState(state);
  if (!validity.valid) {
    throw new Error(`Invalid current state: ${validity.errors.join("; ")}`);
  }
  if (state.sequence !== expectedSequence) {
    throw new Error(
      `State compare-and-swap failed: expected sequence ${expectedSequence}, found ${state.sequence}`,
    );
  }
  if (!canTransition(state.phase, to)) {
    throw new Error(`Illegal state transition: ${state.phase} -> ${to}`);
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("A state-transition reason is required");
  }
  const next = {
    ...state,
    ...patch,
    schemaVersion: "1.0",
    projectId: state.projectId,
    phase: to,
    sequence: state.sequence + 1,
    updatedAt: now,
  };
  if (to === "STALE" || to === "SAFETY_VIOLATION") {
    next.approvedDigests = {};
    next.hooksAttested = false;
  }
  const event = {
    schemaVersion: "1.0",
    type: "state-transition",
    sequence: next.sequence,
    projectId: state.projectId,
    from: state.phase,
    to,
    reason,
    timestamp: now,
    stateDigestBefore: sha256(state),
    stateDigestAfter: sha256(next),
  };
  event.digest = canonicalDigest(event);
  return { state: next, event };
}

export async function commitTransition(
  authority,
  currentState,
  to,
  options = {},
) {
  const result = transitionState(currentState, to, options);
  await commitStateTransaction(authority, currentState, result.state, {
    eventType: "state-transition",
    event: result.event,
  });
  return result.state;
}

export function checkpointState(
  state,
  patch,
  { expectedSequence = state?.sequence, reason, now = new Date().toISOString() } = {},
) {
  const validity = validateState(state);
  if (!validity.valid) {
    throw new Error(`Invalid current state: ${validity.errors.join("; ")}`);
  }
  if (state.sequence !== expectedSequence) {
    throw new Error(
      `State compare-and-swap failed: expected sequence ${expectedSequence}, found ${state.sequence}`,
    );
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new Error("A checkpoint reason is required");
  }
  const next = {
    ...state,
    ...patch,
    schemaVersion: "1.0",
    projectId: state.projectId,
    phase: state.phase,
    sequence: state.sequence + 1,
    updatedAt: now,
  };
  const event = {
    schemaVersion: "1.0",
    type: "state-checkpoint",
    sequence: next.sequence,
    projectId: state.projectId,
    phase: state.phase,
    reason,
    timestamp: now,
    stateDigestBefore: sha256(state),
    stateDigestAfter: sha256(next),
  };
  event.digest = canonicalDigest(event);
  return { state: next, event };
}

export async function commitCheckpoint(authority, currentState, patch, options = {}) {
  const result = checkpointState(currentState, patch, options);
  await commitStateTransaction(authority, currentState, result.state, {
    eventType: "state-checkpoint",
    event: result.event,
  });
  return result.state;
}

async function beginStateTransaction(
  authority,
  currentState,
  nextState,
  { eventType, event },
) {
  const priorJournal = await authority.readSigned(STATE_TRANSACTION_PATH, {
    required: false,
  });
  if (priorJournal?.payload.status === "pending") {
    throw new Error("A pending state transaction must be recovered first");
  }
  const journal = {
    schemaVersion: "1.0",
    transactionId: randomBytes(18).toString("hex"),
    projectId: authority.projectId,
    status: "pending",
    priorStateDigest: sha256(currentState),
    priorStateSequence: currentState.sequence,
    nextState,
    nextStateDigest: sha256(nextState),
    eventType,
    event,
    createdAt: new Date().toISOString(),
    sequence: (priorJournal?.payload.sequence ?? -1) + 1,
  };
  await authority.writeSigned(STATE_TRANSACTION_PATH, journal, {
    expectedSequence: priorJournal?.payload.sequence ?? -1,
  });
  return journal;
}

async function recoverStateTransactionUnlocked(authority) {
  const journalRecord = await authority.readSigned(STATE_TRANSACTION_PATH, {
    required: false,
  });
  if (!journalRecord || journalRecord.payload.status === "committed") {
    return {
      recovered: false,
      status: journalRecord?.payload.status ?? "none",
    };
  }
  const journal = journalRecord.payload;
  if (journal.status !== "pending") {
    throw new Error(`Unknown state transaction status: ${journal.status}`);
  }
  const stateRecord = await authority.readSigned("state/current.json");
  const currentDigest = sha256(stateRecord.payload);
  if (currentDigest === journal.priorStateDigest) {
    await authority.writeSigned("state/current.json", journal.nextState, {
      expectedSequence: journal.priorStateSequence,
    });
  } else if (currentDigest !== journal.nextStateDigest) {
    throw new Error(
      "Pending state transaction does not match current or intended state",
    );
  }
  const authorityEvent = await authority.appendEvent(
    journal.eventType,
    {
      transactionId: journal.transactionId,
      event: journal.event,
    },
    { idempotencyKey: journal.transactionId },
  );
  const committed = {
    ...journal,
    status: "committed",
    committedAt: new Date().toISOString(),
    authorityEventHash: authorityEvent.eventHash,
    sequence: journal.sequence + 1,
  };
  await authority.writeSigned(STATE_TRANSACTION_PATH, committed, {
    expectedSequence: journal.sequence,
  });
  return {
    recovered: true,
    status: "committed",
    transactionId: journal.transactionId,
  };
}

export async function recoverStateTransaction(authority) {
  return authority.withExclusive(
    "transactions/state-transaction.lock",
    () => recoverStateTransactionUnlocked(authority),
  );
}

export async function commitStateTransaction(
  authority,
  currentState,
  nextState,
  event,
) {
  return authority.withExclusive(
    "transactions/state-transaction.lock",
    async () => {
      await recoverStateTransactionUnlocked(authority);
      const liveRecord = await authority.readSigned("state/current.json");
      if (
        liveRecord.payload.sequence !== currentState.sequence ||
        sha256(liveRecord.payload) !== sha256(currentState)
      ) {
        throw new Error(
          "State transaction compare-and-swap failed because current state changed",
        );
      }
      const journal = await beginStateTransaction(
        authority,
        currentState,
        nextState,
        event,
      );
      await recoverStateTransactionUnlocked(authority);
      return {
        transactionId: journal.transactionId,
        state: nextState,
      };
    },
  );
}
