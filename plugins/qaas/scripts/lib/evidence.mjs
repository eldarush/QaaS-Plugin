import path from "node:path";
import { appendDurableLine, ensurePrivateDirectory } from "./io.mjs";
import { canonicalDigest, canonicalJson, sha256 } from "./canonical-json.mjs";
import { assertNoSecrets, redact } from "./redact.mjs";
import { prepareSafeProjectWritePath } from "./safe-project-write.mjs";

const FORBIDDEN_FIELDS = new Set([
  "prompt",
  "rawPrompt",
  "command",
  "rawCommand",
  "mcpPayload",
  "rawPayload",
  "reportBody",
  "rawOutput",
  "transcript",
  "environment",
]);

function rejectRawFields(value, currentPath = "$") {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => rejectRawFields(entry, `${currentPath}[${index}]`));
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value)) {
    if (FORBIDDEN_FIELDS.has(key)) {
      throw new Error(`Evidence may not contain raw field ${currentPath}.${key}`);
    }
    rejectRawFields(entry, `${currentPath}.${key}`);
  }
}

export function createEvidenceEvent({
  projectId,
  taskId,
  type,
  actionClass,
  status,
  timestamp = new Date().toISOString(),
  tool = null,
  inputDigest = null,
  outputDigest = null,
  exitCode = null,
  paths = [],
  excerpt = null,
  details = {},
}) {
  rejectRawFields(details);
  const safe = redact({
    schemaVersion: "1.0",
    projectId,
    taskId,
    type,
    actionClass,
    status,
    timestamp,
    tool,
    inputDigest,
    outputDigest,
    exitCode,
    paths,
    excerpt,
    details,
  });
  assertNoSecrets(safe, "evidence event");
  safe.digest = canonicalDigest(safe);
  return safe;
}

export async function recordEvidence(
  authority,
  event,
  { mirrorPath = null, projectRoot = null } = {},
) {
  let resolvedMirror = null;
  if (mirrorPath) {
    if (typeof projectRoot !== "string" || projectRoot.trim() === "") {
      throw new Error("Evidence mirroring requires an explicit projectRoot");
    }
    resolvedMirror = await prepareSafeProjectWritePath(projectRoot, mirrorPath);
  }
  const signedEvent = await authority.appendEvent("evidence", event, {
    log: "evidence/events.jsonl",
    head: "evidence/head.json",
    lock: "evidence/chain.lock",
  });
  await authority.writeSigned(
    `evidence/records/${event.digest}.json`,
    {
      schemaVersion: "1.0",
      projectId: authority.projectId,
      event,
      authorityEventHash: signedEvent.eventHash,
      authoritySequence: signedEvent.sequence,
      sequence: 0,
    },
    { expectedSequence: -1 },
  );
  if (resolvedMirror) {
    await ensurePrivateDirectory(path.dirname(resolvedMirror));
    const rechecked = await prepareSafeProjectWritePath(
      projectRoot,
      resolvedMirror,
    );
    const mirror = {
      ...event,
      authorityEventHash: signedEvent.eventHash,
      authoritySequence: signedEvent.sequence,
    };
    await appendDurableLine(rechecked, canonicalJson(mirror));
  }
  return signedEvent;
}

export function evidenceDigestFromToolResponse(response) {
  return sha256(redact(response));
}
