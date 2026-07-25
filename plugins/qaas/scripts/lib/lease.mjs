import { randomBytes } from "node:crypto";
import { commitCheckpoint } from "./state.mjs";
import { canonicalDigest, safeEqualHex } from "./canonical-json.mjs";

const LEASE_PATH = "lease/current.json";

function expiryFrom(now, ttlMs) {
  return new Date(Date.parse(now) + ttlMs).toISOString();
}

function validateTimestamp(value, label) {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${label} must be a valid timestamp`);
  }
}

export function leaseIsExpired(lease, now = Date.now()) {
  const expiry = Date.parse(lease?.expiresAt);
  return !Number.isFinite(expiry) || expiry <= now;
}

export function leaseTakeoverDigest({
  leaseId,
  currentSessionId,
  newSessionId,
  taskId,
}) {
  return canonicalDigest({
    kind: "lease-takeover",
    leaseId,
    currentSessionId,
    newSessionId,
    taskId,
  });
}

export async function acquireLease(
  authority,
  {
    sessionId,
    taskId,
    phase,
    ttlMs = 10 * 60 * 1000,
    takeoverApprovalId = null,
    now = new Date().toISOString(),
  },
) {
  if (!sessionId || !taskId || !phase) {
    throw new Error("sessionId, taskId, and phase are required for a lease");
  }
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60 * 1000) {
    throw new Error("Lease ttlMs must be between 1 second and 10 minutes");
  }
  const currentRecord = await authority.readSigned(LEASE_PATH, {
    required: false,
  });
  const current = currentRecord?.payload ?? null;
  if (
    current &&
    current.status === "active" &&
    current.sessionId !== sessionId &&
    !takeoverApprovalId
  ) {
    throw new Error(
      `Project write lease belongs to another session; explicit takeover approval is required`,
    );
  }
  const takeover =
    current &&
    current.status === "active" &&
    current.sessionId !== sessionId;
  const sameSessionRotation =
    current &&
    current.status === "active" &&
    current.sessionId === sessionId &&
    leaseIsExpired(current, Date.parse(now));
  if (takeover && !takeoverApprovalId) {
    throw new Error("An active lease requires a signed takeover approval");
  }
  if (takeover) {
    const approval = await authority.readSigned(
      `approvals/${takeoverApprovalId}.json`,
    );
    const expectedDigest = leaseTakeoverDigest({
      leaseId: current.leaseId,
      currentSessionId: current.sessionId,
      newSessionId: sessionId,
      taskId,
    });
    if (
      approval.payload.kind !== "lease-takeover" ||
      approval.payload.objectId !== current.leaseId ||
      approval.payload.sessionId !== sessionId ||
      approval.payload.leaseId !== current.leaseId ||
      approval.payload.pluginVersion !== authority.metadata.pluginVersion ||
      !safeEqualHex(approval.payload.approvedDigest, expectedDigest)
    ) {
      throw new Error("Signed takeover approval does not match this lease transfer");
    }
  }
  const lease = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    leaseId: randomBytes(18).toString("hex"),
    sessionId,
    taskId,
    phase,
    eventSequence: current?.eventSequence ?? 0,
    heartbeatAt: now,
    expiresAt: expiryFrom(now, ttlMs),
    status: "active",
    takeoverOf: takeover || sameSessionRotation ? current.leaseId : null,
    sequence: (current?.sequence ?? -1) + 1,
  };
  if (takeover || sameSessionRotation) {
    const stateRecord = await authority.readSigned("state/current.json", {
      required: false,
    });
    if (stateRecord) {
      await commitCheckpoint(
        authority,
        stateRecord.payload,
        {
          approvedDigests: {},
          nextLegalAction: takeover
            ? "Reapprove work under the new project lease"
            : "The same session lease rotated after expiry; reapprove exact work",
        },
        {
          reason:
            `Lease ${lease.leaseId} replaced ${current.leaseId}; ` +
            `prior approvals and preauthorizations invalidated`,
        },
      );
    }
  }
  await authority.writeSigned(LEASE_PATH, lease, {
    expectedSequence: current?.sequence ?? -1,
  });
  await authority.appendEvent(
    takeover
      ? "lease-taken-over"
      : sameSessionRotation
        ? "lease-rotated"
        : "lease-acquired",
  {
    leaseId: lease.leaseId,
    sessionId,
    taskId,
    phase,
    takeoverOf: lease.takeoverOf,
    approvalsInvalidated: takeover || sameSessionRotation,
  },
  );
  return lease;
}

export async function heartbeatLease(
  authority,
  { leaseId, sessionId, phase, ttlMs = 10 * 60 * 1000, now = new Date().toISOString() },
) {
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60 * 1000) {
    throw new Error("Lease ttlMs must be between 1 second and 10 minutes");
  }
  const { payload: lease } = await authority.readSigned(LEASE_PATH);
  validateLease(lease, { leaseId, sessionId, phase, now: Date.parse(now) });
  const next = {
    ...lease,
    phase,
    heartbeatAt: now,
    expiresAt: expiryFrom(now, ttlMs),
    eventSequence: lease.eventSequence + 1,
    sequence: lease.sequence + 1,
  };
  await authority.writeSigned(LEASE_PATH, next, {
    expectedSequence: lease.sequence,
  });
  return next;
}

export async function synchronizeLease(
  authority,
  {
    sessionId,
    taskId,
    phase,
    ttlMs = 10 * 60 * 1000,
    now = new Date().toISOString(),
  },
) {
  if (!sessionId || !taskId || !phase) {
    throw new Error("sessionId, taskId, and phase are required to synchronize a lease");
  }
  validateTimestamp(now, "now");
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 1_000 || ttlMs > 10 * 60 * 1000) {
    throw new Error("Lease ttlMs must be between 1 second and 10 minutes");
  }
  const { payload: lease } = await authority.readSigned(LEASE_PATH);
  validateLease(lease, { sessionId, now: Date.parse(now) });
  const next = {
    ...lease,
    taskId,
    phase,
    heartbeatAt: now,
    expiresAt: expiryFrom(now, ttlMs),
    eventSequence: lease.eventSequence + 1,
    sequence: lease.sequence + 1,
  };
  await authority.writeSigned(LEASE_PATH, next, {
    expectedSequence: lease.sequence,
  });
  return next;
}

export async function releaseLease(
  authority,
  { leaseId, sessionId, reason = "session ended", now = new Date().toISOString() },
) {
  validateTimestamp(now, "now");
  const { payload: lease } = await authority.readSigned(LEASE_PATH);
  validateLease(lease, { leaseId, sessionId, now: Date.parse(now) });
  const released = {
    ...lease,
    status: "released",
    releasedAt: now,
    releaseReason: reason,
    sequence: lease.sequence + 1,
  };
  await authority.writeSigned(LEASE_PATH, released, {
    expectedSequence: lease.sequence,
  });
  await authority.appendEvent("lease-released", {
    leaseId,
    sessionId,
    reason,
  });
  return released;
}

export function validateLease(
  lease,
  { leaseId, sessionId, taskId, phase, now = Date.now() } = {},
) {
  const errors = [];
  if (!lease || typeof lease !== "object") errors.push("lease is missing");
  else {
    if (!Number.isFinite(Date.parse(lease.heartbeatAt))) {
      errors.push("heartbeat timestamp is invalid");
    }
    if (!Number.isFinite(Date.parse(lease.expiresAt))) {
      errors.push("expiry timestamp is invalid");
    }
    if (lease.status !== "active") errors.push(`lease status is ${lease.status}`);
    if (leaseId && lease.leaseId !== leaseId) errors.push("lease ID mismatch");
    if (sessionId && lease.sessionId !== sessionId) errors.push("session mismatch");
    if (taskId && lease.taskId !== taskId) errors.push("task mismatch");
    if (phase && lease.phase !== phase) errors.push("phase mismatch");
    if (leaseIsExpired(lease, now)) errors.push("lease expired");
  }
  if (errors.length > 0) {
    throw new Error(`Invalid project lease: ${errors.join("; ")}`);
  }
  return lease;
}

export async function readAndValidateLease(authority, expectations = {}) {
  const { payload } = await authority.readSigned(LEASE_PATH);
  return validateLease(payload, expectations);
}
