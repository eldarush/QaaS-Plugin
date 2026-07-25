import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, open, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import {
  appendDurableLine,
  atomicWriteJson,
  compareAndSwapJson,
  ensurePrivateDirectory,
  pathExists,
  readJson,
  withFileLock,
} from "./io.mjs";
import {
  canonicalDigest,
  canonicalJson,
  isSha256,
  safeEqualHex,
  sha256,
} from "./canonical-json.mjs";

const KEY_FILE = "authority.key";

function normalizeProjectRoot(projectRoot) {
  const resolved = path.resolve(projectRoot);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export function projectIdForPath(projectRoot) {
  return sha256(normalizeProjectRoot(projectRoot));
}

async function readOrCreateKey(pluginData, create) {
  if (create) await ensurePrivateDirectory(pluginData);
  const keyPath = path.join(pluginData, KEY_FILE);
  try {
    const text = (await readFile(keyPath, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(text)) {
      throw new Error("Authority key has an invalid format");
    }
    if (process.platform !== "win32") await chmod(keyPath, 0o600);
    return Buffer.from(text, "hex");
  } catch (error) {
    if (error?.code !== "ENOENT" || !create) throw error;
  }

  const key = randomBytes(32);
  let handle;
  try {
    handle = await open(keyPath, "wx", 0o600);
    await handle.writeFile(`${key.toString("hex")}\n`, "utf8");
    await handle.sync();
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const text = (await readFile(keyPath, "utf8")).trim();
    if (!/^[a-f0-9]{64}$/u.test(text)) {
      throw new Error("Authority key has an invalid format");
    }
    return Buffer.from(text, "hex");
  } finally {
    await handle?.close();
  }
  return key;
}

function safeRelative(relativePath) {
  const normalized = String(relativePath).replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.includes(":") ||
    segments.some((segment) => segment === "." || segment === ".." || segment === "") ||
    segments.some((segment) => /[ .]$/u.test(segment)) ||
    segments.some((segment) =>
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Authority path escapes its root: ${relativePath}`);
  }
  return normalized;
}

function signatureFor(key, payload) {
  return createHmac("sha256", key).update(canonicalJson(payload)).digest("hex");
}

function constantTimeSignatureEqual(left, right) {
  if (
    typeof left !== "string" ||
    typeof right !== "string" ||
    left.length !== right.length
  ) {
    return false;
  }
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function buildEnvelope(key, payload) {
  return {
    payload,
    signature: signatureFor(key, payload),
  };
}

function verifyEnvelopeWithKey(key, envelope) {
  if (
    !envelope ||
    typeof envelope !== "object" ||
    !envelope.payload ||
    typeof envelope.signature !== "string"
  ) {
    return false;
  }
  return constantTimeSignatureEqual(
    signatureFor(key, envelope.payload),
    envelope.signature,
  );
}

async function initializeMetadata({
  key,
  projectRoot,
  projectRootNormalized,
  projectId,
  projectDirectory,
  pluginVersion,
}) {
  const metadataPath = path.join(projectDirectory, "authority.json");
  if (await pathExists(metadataPath)) {
    const envelope = await readJson(metadataPath);
    if (!verifyEnvelopeWithKey(key, envelope)) {
      throw new Error("Project authority metadata signature is invalid");
    }
    if (
      envelope.payload.projectId !== projectId ||
      envelope.payload.projectRoot !== projectRootNormalized
    ) {
      throw new Error("Project authority metadata does not match this project");
    }
    if (envelope.payload.pluginVersion !== pluginVersion) {
      const error = new Error(
        `Authority plugin version ${envelope.payload.pluginVersion} does not match runtime ${pluginVersion}; controlled migration and fresh approvals are required`,
      );
      error.code = "AUTHORITY_VERSION_MISMATCH";
      throw error;
    }
    return envelope.payload;
  }
  const metadata = {
    schemaVersion: "1.0",
    projectId,
    projectRoot: projectRootNormalized,
    displayProjectRoot: path.resolve(projectRoot),
    projectNonce: randomBytes(24).toString("hex"),
    pluginVersion,
    createdAt: new Date().toISOString(),
  };
  await atomicWriteJson(metadataPath, buildEnvelope(key, metadata));
  return metadata;
}

export async function openAuthority({
  pluginData,
  projectRoot,
  pluginVersion = "0.3.0",
  create = false,
}) {
  if (typeof pluginData !== "string" || pluginData.trim() === "") {
    throw new Error("CLAUDE_PLUGIN_DATA is required for protected authority");
  }
  if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
    throw new Error("projectRoot is required");
  }
  const key = await readOrCreateKey(path.resolve(pluginData), create);
  const canonicalProjectRoot = await realpath(path.resolve(projectRoot));
  const normalizedRoot = normalizeProjectRoot(canonicalProjectRoot);
  const projectId = sha256(normalizedRoot);
  const projectDirectory = path.join(
    path.resolve(pluginData),
    "projects",
    projectId,
  );
  if (!create && !(await pathExists(path.join(projectDirectory, "authority.json")))) {
    throw new Error("No protected authority exists for this project");
  }
  await ensurePrivateDirectory(projectDirectory);
  const metadata = await initializeMetadata({
    key,
    projectRoot: canonicalProjectRoot,
    projectRootNormalized: normalizedRoot,
    projectId,
    projectDirectory,
    pluginVersion,
  });

  const resolve = (relativePath) =>
    path.join(projectDirectory, ...safeRelative(relativePath).split("/"));

  const authority = {
    projectId,
    projectRoot: normalizedRoot,
    root: projectDirectory,
    metadata: Object.freeze({ ...metadata }),
    sign(payload) {
      return buildEnvelope(key, payload);
    },
    verify(envelope) {
      return verifyEnvelopeWithKey(key, envelope);
    },
    async readSigned(relativePath, { required = true } = {}) {
      const target = resolve(relativePath);
      if (!(await pathExists(target))) {
        if (!required) return null;
        throw new Error(`Missing signed authority record: ${relativePath}`);
      }
      const envelope = await readJson(target);
      if (!verifyEnvelopeWithKey(key, envelope)) {
        throw new Error(`Invalid signature for authority record: ${relativePath}`);
      }
      return { payload: envelope.payload, envelope, digest: sha256(envelope) };
    },
    async writeSigned(
      relativePath,
      payload,
      { expectedDigest = undefined, expectedSequence = undefined } = {},
    ) {
      const target = resolve(relativePath);
      const envelope = buildEnvelope(key, payload);
      await ensurePrivateDirectory(path.dirname(target));
      const currentExists = await pathExists(target);
      let expected = expectedDigest;
      if (expectedSequence !== undefined) {
        if (!currentExists && expectedSequence !== -1 && expectedSequence !== 0) {
          throw new Error("Signed state compare-and-swap failed: record is missing");
        }
        if (currentExists) {
          const current = await readJson(target);
          if (!verifyEnvelopeWithKey(key, current)) {
            throw new Error(`Invalid current signature for ${relativePath}`);
          }
          if (current.payload.sequence !== expectedSequence) {
            throw new Error(
              `Signed state compare-and-swap failed: expected sequence ${expectedSequence}, found ${current.payload.sequence}`,
            );
          }
          expected = sha256(current);
        } else {
          expected = null;
        }
      } else if (expected === undefined) {
        expected = currentExists ? sha256(await readJson(target)) : null;
      }
      return compareAndSwapJson(target, envelope, {
        expectedDigest: expected,
      });
    },
    async appendEvent(type, data, options = {}) {
      if (typeof type !== "string" || !type) throw new Error("Event type is required");
      const eventsPath = resolve(options.log ?? "events/events.jsonl");
      const headPath = resolve(options.head ?? "events/head.json");
      const lockPath = resolve(options.lock ?? "events/chain.lock");
      return withFileLock(lockPath, async () => {
        let head = {
          sequence: 0,
          eventHash: "0".repeat(64),
        };
        let signedHead = null;
        if (await pathExists(headPath)) {
          signedHead = await readJson(headPath);
          if (!verifyEnvelopeWithKey(key, signedHead)) {
            throw new Error("Event-chain head signature is invalid");
          }
          head = signedHead.payload;
        }
        const existingEvents = [];
        if (await pathExists(eventsPath)) {
          const existingText = await readFile(eventsPath, "utf8");
          let previousHash = "0".repeat(64);
          let sequence = 0;
          for (const [index, line] of existingText
            .split(/\r?\n/u)
            .filter(Boolean)
            .entries()) {
            let existing;
            try {
              existing = JSON.parse(line);
            } catch {
              throw new Error(`Event chain line ${index + 1} is invalid JSON`);
            }
            sequence += 1;
            const expectedHash = canonicalDigest(existing, [
              "eventHash",
              "signature",
            ]);
            const expectedSignature = signatureFor(key, {
              eventHash: existing.eventHash,
              sequence: existing.sequence,
              projectId,
            });
            if (
              existing.sequence !== sequence ||
              existing.previousHash !== previousHash ||
              !safeEqualHex(expectedHash, existing.eventHash) ||
              !constantTimeSignatureEqual(
                expectedSignature,
                existing.signature,
              )
            ) {
              throw new Error(`Event chain line ${index + 1} has invalid integrity`);
            }
            previousHash = existing.eventHash;
            existingEvents.push(existing);
          }
          const expectedHeadHash =
            head.sequence === 0
              ? "0".repeat(64)
              : existingEvents[head.sequence - 1]?.eventHash;
          if (
            head.sequence > existingEvents.length ||
            expectedHeadHash !== head.eventHash
          ) {
            throw new Error("Event-chain head is not reachable from the durable log");
          }
          if (head.sequence < existingEvents.length) {
            const tail = existingEvents.at(-1);
            head = {
              sequence: tail.sequence,
              eventHash: tail.eventHash,
            };
            await atomicWriteJson(headPath, buildEnvelope(key, head));
          }
        } else if (signedHead && head.sequence !== 0) {
          throw new Error("Event-chain head exists without its durable log");
        }
        if (options.idempotencyKey) {
          for (const existing of existingEvents) {
            if (existing.idempotencyKey !== options.idempotencyKey) continue;
            return existing;
          }
        }
        const event = {
          schemaVersion: "1.0",
          projectId,
          sequence: head.sequence + 1,
          previousHash: head.eventHash,
          timestamp: options.timestamp ?? new Date().toISOString(),
          type,
          data,
          idempotencyKey: options.idempotencyKey ?? null,
        };
        event.eventHash = canonicalDigest(event, ["eventHash", "signature"]);
        event.signature = signatureFor(key, {
          eventHash: event.eventHash,
          sequence: event.sequence,
          projectId,
        });
        await appendDurableLine(eventsPath, canonicalJson(event));
        await atomicWriteJson(
          headPath,
          buildEnvelope(key, {
            sequence: event.sequence,
            eventHash: event.eventHash,
          }),
        );
        return event;
      });
    },
    async withExclusive(relativePath, action) {
      if (typeof action !== "function") throw new TypeError("Exclusive action is required");
      return withFileLock(resolve(relativePath), action);
    },
    async verifyEventChain(options = {}) {
      const eventsPath = resolve(options.log ?? "events/events.jsonl");
      const headPath = resolve(options.head ?? "events/head.json");
      if (!(await pathExists(eventsPath))) {
        if (await pathExists(headPath)) {
          return { valid: false, errors: ["head exists without event log"] };
        }
        return { valid: true, count: 0, head: "0".repeat(64), errors: [] };
      }
      const text = await readFile(eventsPath, "utf8");
      const lines = text.split(/\r?\n/u).filter(Boolean);
      const errors = [];
      let previousHash = "0".repeat(64);
      let sequence = 0;
      for (const [index, line] of lines.entries()) {
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          errors.push(`line ${index + 1} is invalid JSON`);
          continue;
        }
        sequence += 1;
        if (event.sequence !== sequence) errors.push(`line ${index + 1} sequence mismatch`);
        if (event.previousHash !== previousHash) {
          errors.push(`line ${index + 1} previousHash mismatch`);
        }
        const expectedHash = canonicalDigest(event, ["eventHash", "signature"]);
        if (!safeEqualHex(expectedHash, event.eventHash)) {
          errors.push(`line ${index + 1} eventHash mismatch`);
        }
        const expectedSignature = signatureFor(key, {
          eventHash: event.eventHash,
          sequence: event.sequence,
          projectId,
        });
        if (!constantTimeSignatureEqual(expectedSignature, event.signature)) {
          errors.push(`line ${index + 1} signature mismatch`);
        }
        previousHash = event.eventHash;
      }
      if (await pathExists(headPath)) {
        const head = await readJson(headPath);
        if (!verifyEnvelopeWithKey(key, head)) errors.push("head signature mismatch");
        else if (
          head.payload.sequence !== sequence ||
          head.payload.eventHash !== previousHash
        ) {
          errors.push("head does not match event log");
        }
      } else if (lines.length > 0) {
        errors.push("event log exists without head");
      }
      return { valid: errors.length === 0, count: lines.length, head: previousHash, errors };
    },
    resolveProtectedPath: resolve,
  };
  return Object.freeze(authority);
}

function preauthorizationPath(toolUseId) {
  return `preauthorizations/${sha256(toolUseId)}.json`;
}

export function toolInputDigest(toolName, toolInput) {
  return sha256({ toolName, toolInput });
}

export async function issuePreauthorization(
  authority,
  {
    toolUseId,
    toolName,
    toolInput,
    actionClass,
    approvalDigest,
    leaseId,
    fingerprintStage,
    fingerprintDigest,
    phase,
    scope = {},
    expiresAt,
    approvalId,
    approvalObjectId,
    sessionId,
  },
) {
  for (const [field, value] of Object.entries({
    toolUseId,
    toolName,
    actionClass,
    approvalDigest,
    leaseId,
    fingerprintStage,
    fingerprintDigest,
    phase,
    approvalId,
    approvalObjectId,
    sessionId,
  })) {
    if (typeof value !== "string" || !value) throw new Error(`${field} is required`);
  }
  if (!isSha256(approvalDigest) || !isSha256(fingerprintDigest)) {
    throw new Error("Approval and fingerprint digests must be SHA-256 values");
  }
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    Date.parse(expiresAt) - Date.now() > 15 * 60 * 1000
  ) {
    throw new Error("Preauthorization expiry must be within the next 15 minutes");
  }
  const approvalRecord = await authority.readSigned(`approvals/${approvalId}.json`);
  const expectedApprovalKind =
    actionClass === "context-write"
      ? "context"
      : actionClass === "test-run"
        ? "execution"
        : actionClass === "observability-query"
          ? "query"
        : actionClass === "infrastructure-mutation"
          ? "mutation"
          : "plan";
  if (
    approvalRecord.payload.approvalId !== approvalId ||
    !safeEqualHex(approvalRecord.payload.approvedDigest, approvalDigest) ||
    approvalRecord.payload.kind !== expectedApprovalKind ||
    approvalRecord.payload.objectId !== approvalObjectId ||
    approvalRecord.payload.sessionId !== sessionId ||
    approvalRecord.payload.pluginVersion !== authority.metadata.pluginVersion
  ) {
    throw new Error(
      "Preauthorization approval record does not match action kind, object, session, or digest",
    );
  }
  if (
    !approvalRecord.payload.leaseId ||
    approvalRecord.payload.leaseId !== leaseId
  ) {
    throw new Error("Approval is bound to a different lease");
  }
  const payload = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    pluginVersion: authority.metadata.pluginVersion,
    tokenId: randomBytes(18).toString("hex"),
    toolUseId,
    toolName,
    toolInputDigest: toolInputDigest(toolName, toolInput),
    actionClass,
    approvalDigest,
    approvalId,
    approvalObjectId,
    sessionId,
    leaseId,
    fingerprintStage,
    fingerprintDigest,
    phase,
    scope,
    status: "issued",
    issuedAt: new Date().toISOString(),
    expiresAt,
    sequence: 0,
  };
  await authority.writeSigned(preauthorizationPath(toolUseId), payload, {
    expectedSequence: -1,
  });
  await authority.appendEvent("preauthorization-issued", {
    tokenId: payload.tokenId,
    toolUseId,
    actionClass,
    approvalDigest,
  });
  return payload;
}

export async function reservePreauthorization(
  authority,
  event,
  expectations,
) {
  const relative = preauthorizationPath(event.tool_use_id);
  const record = await authority.readSigned(relative);
  const token = record.payload;
  const errors = [];
  if (token.status !== "issued") errors.push(`token status is ${token.status}`);
  if (token.toolUseId !== event.tool_use_id) errors.push("tool_use_id mismatch");
  if (token.toolName !== event.tool_name) errors.push("tool name mismatch");
  const currentInputDigest = toolInputDigest(event.tool_name, event.tool_input);
  if (!safeEqualHex(token.toolInputDigest, currentInputDigest)) {
    errors.push("tool input digest mismatch");
  }
  for (const [field, expected] of Object.entries(expectations ?? {})) {
    if (expected !== undefined && token[field] !== expected) {
      errors.push(`${field} mismatch`);
    }
  }
  if (
    !Number.isFinite(Date.parse(token.expiresAt)) ||
    Date.parse(token.expiresAt) <= Date.now()
  ) {
    errors.push("token expired");
  }
  if (errors.length > 0) {
    throw new Error(`Preauthorization rejected: ${errors.join("; ")}`);
  }
  const reserved = {
    ...token,
    status: "reserved",
    reservedAt: new Date().toISOString(),
    sequence: token.sequence + 1,
  };
  await authority.writeSigned(relative, reserved, {
    expectedSequence: token.sequence,
  });
  return reserved;
}

export async function consumePreauthorization(
  authority,
  event,
  { success = true, resultDigest = null } = {},
) {
  const relative = preauthorizationPath(event.tool_use_id);
  const record = await authority.readSigned(relative);
  const token = record.payload;
  if (token.status !== "reserved") {
    throw new Error(`Cannot consume preauthorization in status ${token.status}`);
  }
  const leaseRecord = await authority.readSigned("lease/current.json");
  const lease = leaseRecord.payload;
  if (
    lease.status !== "active" ||
    lease.leaseId !== token.leaseId ||
    lease.sessionId !== token.sessionId ||
    lease.sessionId !== event.session_id ||
    !Number.isFinite(Date.parse(lease.expiresAt)) ||
    Date.parse(lease.expiresAt) <= Date.now() ||
    !Number.isFinite(Date.parse(token.expiresAt)) ||
    Date.parse(token.expiresAt) <= Date.now()
  ) {
    throw new Error(
      "Reserved preauthorization no longer belongs to the active unexpired lease",
    );
  }
  if (
    token.toolUseId !== event.tool_use_id ||
    token.toolName !== event.tool_name ||
    !safeEqualHex(
      token.toolInputDigest,
      toolInputDigest(event.tool_name, event.tool_input),
    )
  ) {
    throw new Error("PostToolUse does not match reserved preauthorization");
  }
  const consumed = {
    ...token,
    status: success ? "consumed" : "failed",
    consumedAt: new Date().toISOString(),
    resultDigest,
    sequence: token.sequence + 1,
  };
  await authority.writeSigned(relative, consumed, {
    expectedSequence: token.sequence,
  });
  await authority.appendEvent("preauthorization-consumed", {
    tokenId: token.tokenId,
    toolUseId: token.toolUseId,
    actionClass: token.actionClass,
    success,
    resultDigest,
  });
  return consumed;
}

function challengePath(challengeId) {
  return `approval-challenges/${sha256(challengeId)}.json`;
}

export const APPROVAL_DECISION_OPTIONS = Object.freeze([
  Object.freeze({
    label: "Approve",
    description: "Approve this exact digest-bound action.",
  }),
  Object.freeze({
    label: "Revise",
    description: "Reject this version and request changes.",
  }),
  Object.freeze({
    label: "Cancel",
    description: "Cancel without granting approval.",
  }),
]);

export function canonicalApprovalQuestion(value) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !["question", "header", "options", "multiSelect"].includes(key),
    )
  ) {
    throw new Error("Approval question has unknown fields");
  }
  const {
    question,
    header,
    options = APPROVAL_DECISION_OPTIONS,
    multiSelect = false,
  } = value;
  if (typeof question !== "string" || question.trim() === "") {
    throw new Error("Approval question text is required");
  }
  if (typeof header !== "string" || header.trim() === "") {
    throw new Error("Approval question header is required");
  }
  if (multiSelect !== false) {
    throw new Error("Approval question must be single-select");
  }
  if (
    !Array.isArray(options) ||
    options.length !== APPROVAL_DECISION_OPTIONS.length
  ) {
    throw new Error("Approval question must have exactly three decision options");
  }
  const normalizedOptions = options.map((option, index) => {
    if (
      !option ||
      typeof option !== "object" ||
      Array.isArray(option) ||
      Object.keys(option).some((key) => !["label", "description"].includes(key)) ||
      option.label !== APPROVAL_DECISION_OPTIONS[index].label ||
      option.description !== APPROVAL_DECISION_OPTIONS[index].description
    ) {
      throw new Error(
        "Approval options must use the exact Approve, Revise, Cancel order and descriptions",
      );
    }
    return {
      label: option.label,
      description: option.description,
    };
  });
  return {
    question,
    header,
    options: normalizedOptions,
    multiSelect: false,
  };
}

export async function createApprovalChallenge(
  authority,
  {
    challengeId,
    kind,
    objectId,
    approvalDigest,
    sessionId,
    questionId,
    prompt,
    options = APPROVAL_DECISION_OPTIONS,
    multiSelect = false,
    expiresAt,
    leaseId = null,
  },
) {
  if (
    ![
      "context",
      "plan",
      "execution",
      "mutation",
      "capabilities",
      "source-checkout",
      "source-read",
      "readiness-fact",
      "query",
      "lease-takeover",
    ].includes(kind)
  ) {
    throw new Error("Unsupported approval challenge kind");
  }
  if (typeof leaseId !== "string" || leaseId.length === 0) {
    throw new Error("Approval challenge must bind the active lease ID");
  }
  if (!isSha256(approvalDigest)) throw new Error("approvalDigest must be SHA-256");
  if (
    typeof expiresAt !== "string" ||
    !Number.isFinite(Date.parse(expiresAt)) ||
    Date.parse(expiresAt) <= Date.now() ||
    Date.parse(expiresAt) - Date.now() > 30 * 60 * 1000
  ) {
    throw new Error("Approval challenge expiry must be within the next 30 minutes");
  }
  const question = canonicalApprovalQuestion({
    question: prompt,
    header: questionId,
    options,
    multiSelect,
  });
  const payload = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    pluginVersion: authority.metadata.pluginVersion,
    challengeId,
    kind,
    objectId,
    approvalDigest,
    sessionId,
    questionId,
    questionDigest: sha256(question),
    status: "pending",
    askToolUseId: null,
    createdAt: new Date().toISOString(),
    expiresAt,
    leaseId,
    sequence: 0,
  };
  await authority.writeSigned(challengePath(challengeId), payload, {
    expectedSequence: -1,
  });
  return payload;
}

export async function registerApprovalQuestion(
  authority,
  challengeId,
  { sessionId, toolUseId, question },
) {
  const relative = challengePath(challengeId);
  const { payload } = await authority.readSigned(relative);
  const errors = [];
  const canonicalQuestion = canonicalApprovalQuestion(question);
  if (payload.status !== "pending") errors.push("challenge is not pending");
  if (payload.sessionId !== sessionId) errors.push("session mismatch");
  if (payload.questionId !== canonicalQuestion.header) errors.push("question ID mismatch");
  if (!safeEqualHex(payload.questionDigest, sha256(canonicalQuestion))) {
    errors.push("full question mismatch");
  }
  if (errors.length) throw new Error(errors.join("; "));
  const registered = {
    ...payload,
    status: "asked",
    askToolUseId: toolUseId,
    askedAt: new Date().toISOString(),
    sequence: payload.sequence + 1,
  };
  await authority.writeSigned(relative, registered, {
    expectedSequence: payload.sequence,
  });
  return registered;
}

export async function findApprovalChallenge(
  authority,
  { sessionId, question },
) {
  const directory = authority.resolveProtectedPath("approval-challenges");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const canonicalQuestion = canonicalApprovalQuestion(question);
  const questionHash = sha256(canonicalQuestion);
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const record = await authority.readSigned(
      `approval-challenges/${entry.name}`,
    );
    const challenge = record.payload;
    if (
      challenge.status === "pending" &&
      challenge.sessionId === sessionId &&
      challenge.questionId === canonicalQuestion.header &&
      safeEqualHex(challenge.questionDigest, questionHash)
    ) {
      matches.push(challenge);
    }
  }
  if (matches.length > 1) {
    throw new Error("Multiple approval challenges match one question");
  }
  return matches[0] ?? null;
}

export async function findRegisteredApprovalChallenge(
  authority,
  { sessionId, toolUseId },
) {
  const directory = authority.resolveProtectedPath("approval-challenges");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const { payload } = await authority.readSigned(
      `approval-challenges/${entry.name}`,
    );
    if (
      payload.status === "asked" &&
      payload.sessionId === sessionId &&
      payload.askToolUseId === toolUseId
    ) {
      matches.push(payload);
    }
  }
  if (matches.length > 1) {
    throw new Error("Multiple approval challenges match one tool use");
  }
  return matches[0] ?? null;
}

export async function rejectApprovalChallenge(
  authority,
  challengeId,
  { sessionId, toolUseId, decision },
) {
  if (!["Revise", "Cancel"].includes(decision)) {
    throw new Error("Approval rejection decision must be Revise or Cancel");
  }
  const relative = challengePath(challengeId);
  const { payload } = await authority.readSigned(relative);
  if (
    payload.status !== "asked" ||
    payload.sessionId !== sessionId ||
    payload.askToolUseId !== toolUseId
  ) {
    throw new Error("Approval rejection does not match the asked challenge");
  }
  const rejected = {
    ...payload,
    status: decision === "Revise" ? "revision-requested" : "cancelled",
    decision,
    decidedAt: new Date().toISOString(),
    sequence: payload.sequence + 1,
  };
  await authority.writeSigned(relative, rejected, {
    expectedSequence: payload.sequence,
  });
  await authority.appendEvent("approval-rejected", {
    challengeId,
    kind: payload.kind,
    objectId: payload.objectId,
    decision,
  });
  return rejected;
}

export async function supersedeApprovalChallenges(
  authority,
  { kind, sessionId, reason },
) {
  const directory = authority.resolveProtectedPath("approval-challenges");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relative = `approval-challenges/${entry.name}`;
    const { payload } = await authority.readSigned(relative);
    if (
      payload.kind !== kind ||
      payload.sessionId !== sessionId ||
      !["pending", "asked"].includes(payload.status)
    ) {
      continue;
    }
    await authority.writeSigned(
      relative,
      {
        ...payload,
        status: "superseded",
        supersededAt: new Date().toISOString(),
        supersededReason: reason,
        sequence: payload.sequence + 1,
      },
      { expectedSequence: payload.sequence },
    );
    count += 1;
  }
  if (count > 0) {
    await authority.appendEvent("approval-challenges-superseded", {
      kind,
      sessionId,
      reason,
      count,
    });
  }
  return count;
}

export async function supersedeApprovals(
  authority,
  { kind, sessionId, reason },
) {
  const directory = authority.resolveProtectedPath("approvals");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return 0;
    throw error;
  }
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const relative = `approvals/${entry.name}`;
    const { payload } = await authority.readSigned(relative);
    if (
      payload.kind !== kind ||
      payload.sessionId !== sessionId ||
      ![undefined, "active"].includes(payload.status)
    ) {
      continue;
    }
    await authority.writeSigned(
      relative,
      {
        ...payload,
        status: "superseded",
        supersededAt: new Date().toISOString(),
        supersededReason: reason,
        sequence: payload.sequence + 1,
      },
      { expectedSequence: payload.sequence },
    );
    count += 1;
  }
  if (count > 0) {
    await authority.appendEvent("approvals-superseded", {
      kind,
      sessionId,
      reason,
      count,
    });
  }
  return count;
}

export async function findApprovalByDigest(
  authority,
  { kind, approvedDigest, sessionId, leaseId },
) {
  const directory = authority.resolveProtectedPath("approvals");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const matches = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const { payload } = await authority.readSigned(`approvals/${entry.name}`);
    if (
      payload.kind === kind &&
      safeEqualHex(payload.approvedDigest, approvedDigest) &&
      payload.sessionId === sessionId &&
      payload.leaseId === leaseId &&
      payload.pluginVersion === authority.metadata.pluginVersion &&
      [undefined, "active"].includes(payload.status)
    ) {
      matches.push(payload);
    }
  }
  if (matches.length > 1) {
    throw new Error("Multiple approvals match the current digest and lease");
  }
  return matches[0] ?? null;
}

export async function consumeApproval(
  authority,
  approval,
  { reason },
) {
  if (
    !approval ||
    typeof approval.approvalId !== "string" ||
    !/^[a-f0-9]{36}$/u.test(approval.approvalId) ||
    typeof reason !== "string" ||
    reason.length < 1 ||
    reason.length > 240
  ) {
    throw new Error("Approval consumption requires an exact approval and reason");
  }
  const relative = `approvals/${approval.approvalId}.json`;
  const { payload } = await authority.readSigned(relative);
  if (
    payload.approvalId !== approval.approvalId ||
    payload.kind !== approval.kind ||
    !safeEqualHex(payload.approvedDigest, approval.approvedDigest) ||
    ![undefined, "active"].includes(payload.status)
  ) {
    throw new Error("Approval is stale or has already been consumed");
  }
  const consumed = {
    ...payload,
    status: "consumed",
    consumedAt: new Date().toISOString(),
    consumedReason: reason,
    sequence: payload.sequence + 1,
  };
  await authority.writeSigned(relative, consumed, {
    expectedSequence: payload.sequence,
  });
  await authority.appendEvent("approval-consumed", {
    approvalId: payload.approvalId,
    kind: payload.kind,
    objectId: payload.objectId,
    approvedDigest: payload.approvedDigest,
    reason,
  });
  return consumed;
}

export async function mintApproval(
  authority,
  challengeId,
  { sessionId, toolUseId, answer, source = "AskUserQuestion" },
) {
  if (!["AskUserQuestion", "direct-command-helper"].includes(source)) {
    throw new Error("Unsupported approval provenance source");
  }
  const relative = challengePath(challengeId);
  const { payload } = await authority.readSigned(relative);
  const errors = [];
  if (payload.status !== "asked") errors.push("challenge was not registered as asked");
  if (payload.sessionId !== sessionId) errors.push("session mismatch");
  if (payload.askToolUseId !== toolUseId) errors.push("tool use mismatch");
  if (answer !== "Approve") errors.push("answer is not the exact Approve decision");
  if (
    !Number.isFinite(Date.parse(payload.expiresAt)) ||
    Date.parse(payload.expiresAt) <= Date.now()
  ) {
    errors.push("challenge expired");
  }
  if (errors.length) throw new Error(`Approval rejected: ${errors.join("; ")}`);
  const approval = {
    schemaVersion: "1.0",
    approvalId: randomBytes(18).toString("hex"),
    projectId: authority.projectId,
    kind: payload.kind,
    objectId: payload.objectId,
    approvedDigest: payload.approvalDigest,
    sessionId,
    challengeId,
    questionId: payload.questionId,
    source,
    decision: "Approve",
    status: "active",
    timestamp: new Date().toISOString(),
    sequence: 0,
    leaseId: payload.leaseId,
    pluginVersion: authority.metadata.pluginVersion,
  };
  await authority.writeSigned(`approvals/${approval.approvalId}.json`, approval, {
    expectedSequence: -1,
  });
  await authority.writeSigned(
    relative,
    {
      ...payload,
      status: "consumed",
      approvalId: approval.approvalId,
      consumedAt: approval.timestamp,
      sequence: payload.sequence + 1,
    },
    { expectedSequence: payload.sequence },
  );
  await authority.appendEvent("approval-minted", {
    approvalId: approval.approvalId,
    kind: approval.kind,
    objectId: approval.objectId,
    approvedDigest: approval.approvedDigest,
    source,
  });
  return approval;
}

export function isProtectedAuthorityPath(
  candidate,
  { pluginData, projectRoot },
) {
  const resolved = path.resolve(candidate);
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const isInside = (root) => {
    const normalizedRoot = normalize(path.resolve(root));
    const normalizedCandidate = normalize(resolved);
    return (
      normalizedCandidate === normalizedRoot ||
      normalizedCandidate.startsWith(`${normalizedRoot}${path.sep}`)
    );
  };
  if (pluginData && isInside(pluginData)) return true;
  if (projectRoot) {
    const protectedProjectPaths = [
      ".claude/qaas/state",
      ".claude/qaas/fingerprint.json",
    ].map((relative) => path.join(projectRoot, ...relative.split("/")));
    if (protectedProjectPaths.some(isInside)) return true;
  }
  return false;
}

async function canonicalizeNearest(target) {
  const absolute = path.resolve(target);
  const missing = [];
  let cursor = absolute;
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return path.join(resolved, ...missing.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function isProtectedAuthorityPathCanonical(
  candidate,
  { pluginData, projectRoot },
) {
  if (
    typeof candidate !== "string" ||
    candidate.includes("\0") ||
    /[*?[\]]/u.test(candidate)
  ) {
    return true;
  }
  const normalize = (value) =>
    process.platform === "win32" ? value.toLowerCase() : value;
  const canonicalCandidate = normalize(await canonicalizeNearest(candidate));
  const inside = async (root) => {
    const canonicalRoot = normalize(await canonicalizeNearest(root));
    return (
      canonicalCandidate === canonicalRoot ||
      canonicalCandidate.startsWith(`${canonicalRoot}${path.sep}`)
    );
  };
  if (pluginData && (await inside(pluginData))) return true;
  if (projectRoot) {
    for (const relative of [
      ".claude/qaas/state",
      ".claude/qaas/fingerprint.json",
    ]) {
      if (await inside(path.join(projectRoot, ...relative.split("/")))) {
        return true;
      }
    }
  }
  return false;
}
