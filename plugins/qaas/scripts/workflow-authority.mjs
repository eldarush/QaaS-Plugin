import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPROVAL_DECISION_OPTIONS,
  createApprovalChallenge,
  findApprovalByDigest,
  openAuthority,
  supersedeApprovals,
  supersedeApprovalChallenges,
} from "./lib/approval-authority.mjs";
import {
  canonicalDigest,
  canonicalJson,
  isSha256,
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
  assertCurrentDocumentationSourceConfiguration,
  QAAS_DOCS_CONFIGURATION_NAMES,
} from "./lib/docs-resolver.mjs";
import { atomicWriteText } from "./lib/io.mjs";
import { synchronizeLease } from "./lib/lease.mjs";
import {
  validateExecutionPlan,
  validateMutationPlan,
  validateTaskPlan,
} from "./lib/plan-validation.mjs";
import {
  assertCurrentPackageSnapshot,
  computePackageSnapshot,
  writePackageSnapshot,
} from "./lib/package-snapshot.mjs";
import { assertNoSecrets } from "./lib/redact.mjs";
import { attestQuery } from "./lib/query-read-adapter.mjs";
import { validateQueryPlan } from "./lib/query-validation.mjs";
import { mirrorProjectState } from "./lib/project-state-mirror.mjs";
import {
  computeHookSettingsInventory,
  computeRuntimeBundle,
} from "./lib/runtime-attestation.mjs";
import {
  commitCheckpoint,
  commitTransition,
  recoverStateTransaction,
} from "./lib/state.mjs";
import {
  EVIDENCE_REQUIRED_READINESS_DOMAINS,
  NOT_APPLICABLE_READINESS_DOMAINS,
  READINESS_DOMAINS,
  validateReadiness,
} from "./lib/validation.mjs";
import { validateCapabilityRegistry } from "./lib/mcp-analyzer.mjs";
import { attestProcessSpecification } from "./lib/process-runner.mjs";
import { describeMcpTransport } from "./lib/streamable-mcp-client.mjs";
import {
  validateSourceCheckout,
} from "./lib/source-checkout-validation.mjs";
import { resolveSourceReadRequest } from "./lib/source-read-request.mjs";
import { discoverProgram } from "./lib/process-runner.mjs";

const PLUGIN_VERSION = "0.2.0";
const MAX_ARTIFACT_BYTES = 1024 * 1024;
const MAX_REVIEW_BYTES = 64 * 1024;
const MAX_HUMAN_REVIEW_BYTES = 24 * 1024;
const MAX_RESUME_BYTES = 32 * 1024;
const MAX_RESUME_ITEMS = 12;
const MAX_RECENT_EVIDENCE_HANDLES = 8;
const MAX_EVIDENCE_TAIL_BYTES = 512 * 1024;
const AUTHORITY_CAPABILITIES = Object.freeze({
  writeContentBinding: false,
});
const SOURCE_READ_PHASES = new Set([
  "DISCOVERING",
  "CONTEXT_REVIEW",
  "PROJECT_READY",
  "TASK_DISCOVERY",
  "PLAN_REVIEW",
  "PLAN_APPROVED",
  "IMPLEMENTING",
  "DIAGNOSING",
  "REPAIRING",
]);
const CONTEXT_PATHS = new Set([
  ".claude/CLAUDE.md",
  ".claude/qaas/context-index.json",
  ".claude/qaas/project.md",
  ".claude/qaas/structure.md",
  ".claude/qaas/tested-system.md",
  ".claude/qaas/qaas-configuration.md",
  ".claude/qaas/conventions.md",
  ".claude/qaas/commands.md",
  ".claude/qaas/suites-and-cases.md",
  ".claude/qaas/samples.md",
  ".claude/qaas/custom-hooks.md",
  ".claude/qaas/modules.md",
  ".claude/qaas/environments.md",
  ".claude/qaas/observability.md",
  ".claude/qaas/integrations.md",
  ".claude/qaas/decisions.md",
  ".claude/qaas/unknowns.md",
]);
const RESERVED_CONTEXT_PREFIXES = new Set([
  "state",
  "tasks",
  "evidence",
  "artifacts",
  "fingerprints",
  "approvals",
  "approval-challenges",
  "transactions",
  "attestations",
  "lease",
  "integrations",
  "staging",
]);

function isManagedContextPath(relative) {
  if (CONTEXT_PATHS.has(relative)) return true;
  if (
    typeof relative !== "string" ||
    relative.length > 240 ||
    !relative.startsWith(".claude/qaas/") ||
    !relative.toLowerCase().endsWith(".md")
  ) {
    return false;
  }
  const segments = relative.slice(".claude/qaas/".length).split("/");
  if (
    segments.length < 1 ||
    segments.length > 6 ||
    RESERVED_CONTEXT_PREFIXES.has(segments[0].toLowerCase())
  ) {
    return false;
  }
  return segments.every(
    (segment) =>
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(segment) &&
      !/[ .]$/u.test(segment) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
  );
}

function decodeBase64(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    !/^[A-Za-z0-9+/]*={0,2}$/u.test(value)
  ) {
    throw new Error("--content-base64 must be canonical base64");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.byteLength > MAX_ARTIFACT_BYTES ||
    bytes.toString("base64") !== value
  ) {
    throw new Error("Artifact base64 is non-canonical or exceeds 1 MiB");
  }
  return bytes.toString("utf8");
}

function safeTaskId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9._-]+$/u.test(value)) {
    throw new Error("task ID must contain only letters, digits, dot, underscore, or hyphen");
  }
  return value;
}

function boundedText(value, maxLength = 512) {
  if (value === null || value === undefined) return null;
  const text = String(value);
  return text.length <= maxLength
    ? text
    : `${text.slice(0, Math.max(0, maxLength - 14))} [truncated]`;
}

function boundedStringList(value, label, {
  maxItems = MAX_RESUME_ITEMS,
  maxLength = 240,
  allowEmpty = true,
} = {}) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
  if (value.length > maxItems) {
    throw new Error(`${label} must contain at most ${maxItems} entries`);
  }
  return value.map((entry, index) => {
    if (
      typeof entry !== "string" ||
      (!allowEmpty && entry.trim() === "") ||
      entry.length > maxLength ||
      entry.includes("\0")
    ) {
      throw new Error(
        `${label}[${index}] must contain at most ${maxLength} safe characters`,
      );
    }
    return entry;
  });
}

function currentFingerprintHandle(state) {
  for (const stage of [
    "staticVerificationFingerprint",
    "expectedWorkingFingerprint",
    "onboardingFingerprint",
  ]) {
    const value = state?.fingerprints?.[stage];
    const digest = typeof value === "string" ? value : value?.digest;
    if (isSha256(digest)) return { stage, digest };
  }
  return null;
}

async function readTailLines(target, maxBytes = MAX_EVIDENCE_TAIL_BYTES) {
  let handle;
  try {
    handle = await open(target, "r");
    const info = await handle.stat();
    const length = Math.min(info.size, maxBytes);
    const start = Math.max(0, info.size - length);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, start);
    const lines = buffer
      .toString("utf8")
      .split(/\r?\n/u)
      .filter(Boolean);
    if (start > 0) lines.shift();
    return { lines, truncated: start > 0 };
  } catch (error) {
    if (error?.code === "ENOENT") return { lines: [], truncated: false };
    throw error;
  } finally {
    await handle?.close();
  }
}

async function recentEvidenceHandles(authority) {
  const tail = await readTailLines(
    authority.resolveProtectedPath("evidence/events.jsonl"),
  );
  const handles = [];
  for (const line of tail.lines.reverse()) {
    let wrapped;
    try {
      wrapped = JSON.parse(line);
    } catch {
      continue;
    }
    const event = wrapped?.type === "evidence" ? wrapped.data : null;
    if (
      event?.status !== "success" ||
      !["ordinary-read", "configured-source-read"].includes(event.actionClass) ||
      !["project", "docs", "runtime"].includes(
        event.details?.provenance?.category,
      ) ||
      event.details?.provenance?.immutableLocator !== true ||
      !isSha256(event.digest)
    ) {
      continue;
    }
    const signed = await authority.readSigned(
      `evidence/records/${event.digest}.json`,
      { required: false },
    );
    if (
      !signed ||
      !safeEqualHex(signed.payload.event?.digest, event.digest) ||
      signed.payload.event?.status !== "success"
    ) {
      continue;
    }
    handles.push({
      digest: event.digest,
      actionClass: event.actionClass,
      sourceKind: event.details?.provenance?.category ?? "project",
      tool: boundedText(event.tool, 80),
      timestamp: event.timestamp,
      paths: Array.isArray(event.paths)
        ? event.paths.slice(0, 4).map((entry) => boundedText(entry, 240))
        : [],
    });
    if (handles.length === MAX_RECENT_EVIDENCE_HANDLES) break;
  }
  return {
    handles,
    truncated:
      tail.truncated ||
      tail.lines.length > MAX_RECENT_EVIDENCE_HANDLES,
  };
}

async function stagedResumeSummary(authority) {
  const topics = await authority.readSigned("staging/context.json", {
    required: false,
  });
  const stagedArtifacts = [];
  for (const kind of [
    "readiness",
    "plan",
    "execution",
    "mutation",
    "query",
    "source-checkout",
  ]) {
    const record = await authority.readSigned(`artifacts/${kind}.json`, {
      required: false,
    });
    if (record) {
      stagedArtifacts.push({
        kind,
        digest: record.payload.digest,
        stagedAt: record.payload.stagedAt ?? null,
      });
    }
  }
  const topicEntries = Object.entries(topics?.payload.files ?? {})
    .filter(([entry]) => entry.startsWith(".claude/qaas/"))
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return {
    stagedArtifacts,
    stagedTopics: topicEntries.slice(0, 24).map(([entry, record]) => ({
      path: entry,
      sha256: record.sha256,
    })),
    stagedTopicsTruncated: topicEntries.length > 24,
  };
}

async function pendingResumeAction(authority, sessionId) {
  const record = await authority.readSigned(
    `sessions/${sha256(sessionId)}/pending-action.json`,
    { required: false },
  );
  if (!record) return null;
  const pending = record.payload;
  const challenge = await authority.readSigned(
    `approval-challenges/${sha256(pending.challengeId)}.json`,
    { required: false },
  );
  if (
    !challenge ||
    challenge.payload.sessionId !== sessionId ||
    !["pending", "asked"].includes(challenge.payload.status) ||
    Date.parse(challenge.payload.expiresAt) <= Date.now() ||
    !safeEqualHex(challenge.payload.questionDigest, sha256(pending.question))
  ) {
    return null;
  }
  return {
    type: "AskUserQuestion",
    challengeId: pending.challengeId,
    kind: pending.kind,
    objectId: pending.objectId,
    status: challenge.payload.status,
    expiresAt: challenge.payload.expiresAt,
    question: pending.question,
  };
}

async function createResumeProjection(context, active) {
  const live = (await context.authority.readSigned("state/current.json")).payload;
  const [evidence, staged, pendingAction] = await Promise.all([
    recentEvidenceHandles(context.authority),
    stagedResumeSummary(context.authority),
    pendingResumeAction(
      context.authority,
      active.attestation.sessionId,
    ),
  ]);
  const projection = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    phase: live.phase,
    stateSequence: live.sequence,
    taskId: live.taskId,
    contextDigest: live.contextDigest ?? null,
    packageSnapshotDigest: live.packageSnapshotDigest ?? null,
    projectFingerprint: currentFingerprintHandle(live),
    authorityCapabilities: AUTHORITY_CAPABILITIES,
    approvedKinds: Object.keys(live.approvedDigests ?? {}).sort(),
    completedWork: (live.completedWork ?? [])
      .slice(-MAX_RESUME_ITEMS)
      .map((entry) => boundedText(entry, 240)),
    remainingWork: (live.remainingWork ?? [])
      .slice(0, MAX_RESUME_ITEMS)
      .map((entry) => boundedText(entry, 240)),
    evidencePaths: (live.evidencePaths ?? [])
      .slice(-MAX_RESUME_ITEMS)
      .map((entry) => boundedText(entry, 240)),
    blocker: boundedText(live.blocker, 512),
    nextLegalAction: boundedText(live.nextLegalAction, 512),
    recentEvidenceHandles: evidence.handles,
    recentEvidenceHandlesTruncated: evidence.truncated,
    stagedArtifacts: staged.stagedArtifacts,
    stagedTopics: staged.stagedTopics,
    stagedTopicsTruncated: staged.stagedTopicsTruncated,
    pendingAction,
    createdAt: new Date().toISOString(),
  };
  assertNoSecrets(projection, "resume projection");
  projection.digest = canonicalDigest(projection);
  if (Buffer.byteLength(canonicalJson(projection), "utf8") > MAX_RESUME_BYTES) {
    throw new Error(`Resume projection exceeds ${MAX_RESUME_BYTES} bytes`);
  }
  const relative =
    `sessions/${sha256(active.attestation.sessionId)}/resume-projection.json`;
  const prior = await context.authority.readSigned(relative, {
    required: false,
  });
  const payload = {
    ...projection,
    sequence: (prior?.payload.sequence ?? -1) + 1,
  };
  await context.authority.writeSigned(relative, payload, {
    expectedSequence: prior?.payload.sequence ?? -1,
  });
  const signed = await context.authority.readSigned(relative);
  return {
    projection: signed.payload,
    signedProjection: signed.envelope,
  };
}

async function checkpointProgress(context, active, args) {
  const content = decodeBase64(args["content-base64"]);
  assertNoSecrets(content, "progress checkpoint");
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new Error(`Progress checkpoint is invalid JSON: ${error.message}`);
  }
  const allowed = new Set([
    "completedWork",
    "remainingWork",
    "evidencePaths",
    "blocker",
    "nextLegalAction",
  ]);
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).some((key) => !allowed.has(key))
  ) {
    throw new Error("Progress checkpoint has unsupported fields");
  }
  const completedWork = boundedStringList(
    document.completedWork ?? active.state.completedWork ?? [],
    "completedWork",
  );
  const remainingWork = boundedStringList(
    document.remainingWork ?? active.state.remainingWork ?? [],
    "remainingWork",
  );
  const evidencePaths = boundedStringList(
    document.evidencePaths ?? active.state.evidencePaths ?? [],
    "evidencePaths",
  );
  for (const entry of evidencePaths) {
    const normalized = entry.replaceAll("\\", "/");
    if (
      path.posix.isAbsolute(normalized) ||
      /^[A-Za-z]:/u.test(normalized) ||
      normalized.split("/").includes("..")
    ) {
      throw new Error(`evidencePaths contains an unsafe path: ${entry}`);
    }
  }
  const blocker =
    document.blocker === undefined
      ? active.state.blocker
      : document.blocker;
  if (
    blocker !== null &&
    (typeof blocker !== "string" ||
      blocker.length > 512 ||
      blocker.includes("\0"))
  ) {
    throw new Error("blocker must be null or at most 512 safe characters");
  }
  const nextLegalAction =
    document.nextLegalAction ?? active.state.nextLegalAction;
  if (
    typeof nextLegalAction !== "string" ||
    nextLegalAction.trim() === "" ||
    nextLegalAction.length > 512 ||
    nextLegalAction.includes("\0")
  ) {
    throw new Error("nextLegalAction must contain 1-512 safe characters");
  }
  const next = await commitCheckpoint(
    context.authority,
    active.state,
    {
      completedWork,
      remainingWork,
      evidencePaths,
      blocker,
      nextLegalAction,
    },
    { reason: "Recorded bounded model progress before compaction or handoff" },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Recorded bounded progress checkpoint",
  );
  return createResumeProjection(context, { ...active, state: next });
}

export async function runtimeContext(env) {
  const projectRoot = await realpath(
    path.resolve(env.CLAUDE_PROJECT_DIR ?? process.cwd()),
  );
  const pluginRoot = await realpath(
    path.resolve(
      env.CLAUDE_PLUGIN_ROOT ??
        path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
    ),
  );
  if (!env.CLAUDE_PLUGIN_DATA) {
    throw new Error("CLAUDE_PLUGIN_DATA is required");
  }
  const authority = await openAuthority({
    pluginData: env.CLAUDE_PLUGIN_DATA,
    projectRoot,
    pluginVersion: PLUGIN_VERSION,
    create: false,
  });
  await recoverStateTransaction(authority);
  return { authority, projectRoot, pluginRoot, env };
}

export async function activeSession(context, sessionHandle) {
  if (typeof sessionHandle !== "string" || !/^[a-f0-9]{48}$/u.test(sessionHandle)) {
    throw new Error("--session-handle from SessionStart is required");
  }
  const attestation = await context.authority.readSigned("attestations/hooks.json");
  if (
    attestation.payload.status !== "active" ||
    !safeEqualHex(attestation.payload.sessionHandleDigest, sha256(sessionHandle)) ||
    attestation.payload.pluginVersion !== PLUGIN_VERSION ||
    !Number.isFinite(Date.parse(attestation.payload.expiresAt)) ||
    Date.parse(attestation.payload.expiresAt) <= Date.now()
  ) {
    throw new Error("Session handle does not match the active hook attestation");
  }
  const runtimeBundle = await computeRuntimeBundle({
    pluginRoot: context.pluginRoot,
    pluginVersion: PLUGIN_VERSION,
  });
  const settings = await computeHookSettingsInventory({
    projectRoot: context.projectRoot,
    userHome: context.env.USERPROFILE ?? context.env.HOME ?? null,
  });
  if (
    runtimeBundle.digest !== attestation.payload.runtimeBundleDigest ||
    settings.digest !== attestation.payload.settingsDigest ||
    settings.disableAllHooks === true ||
    settings.unknownSideEffectingHooks !== false
  ) {
    throw new Error("Runtime hook attestation is stale or unsafe");
  }
  const state = (await context.authority.readSigned("state/current.json")).payload;
  const lease = await synchronizeLease(context.authority, {
    sessionId: attestation.payload.sessionId,
    taskId: state.taskId ?? "__onboarding__",
    phase: state.phase,
  });
  return { state, lease, attestation: attestation.payload };
}

async function stageContextFile(context, active, args) {
  if (!["DISCOVERING", "CONTEXT_REVIEW"].includes(active.state.phase)) {
    throw new Error("Context staging is legal only during discovery/review");
  }
  const relative = String(args.path ?? "").replaceAll("\\", "/");
  if (!isManagedContextPath(relative)) {
    throw new Error("Context staging path is not in the managed context allowlist");
  }
  const content = decodeBase64(args["content-base64"]);
  assertNoSecrets(content, `staged ${relative}`);
  if (
    relative === ".claude/CLAUDE.md" &&
    !/^<!-- QAAS:START -->[\s\S]*<!-- QAAS:END -->\r?\n?$/u.test(content)
  ) {
    throw new Error("Managed CLAUDE.md content must be one complete QaaS marker block");
  }
  const existing = await context.authority.readSigned("staging/context.json", {
    required: false,
  });
  const comparable = relative.toLowerCase();
  const collision = Object.keys(existing?.payload.files ?? {}).find(
    (entry) => entry.toLowerCase() === comparable && entry !== relative,
  );
  if (collision) {
    throw new Error(`Context path has a case-insensitive collision: ${collision}`);
  }
  const files = {
    ...(existing?.payload.files ?? {}),
    [relative]: {
      content,
      sha256: sha256(content),
    },
  };
  const payload = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    files,
    updatedAt: new Date().toISOString(),
    sequence: (existing?.payload.sequence ?? -1) + 1,
  };
  await context.authority.writeSigned("staging/context.json", payload, {
    expectedSequence: existing?.payload.sequence ?? -1,
  });
  return { staged: relative, sha256: files[relative].sha256 };
}

function validateContextBundle(projectId, files) {
  for (const required of CONTEXT_PATHS) {
    if (!files[required]) throw new Error(`Missing staged context file: ${required}`);
  }
  for (const relative of Object.keys(files)) {
    if (!isManagedContextPath(relative)) {
      throw new Error(`Staged context contains a forbidden path: ${relative}`);
    }
  }
  let index;
  try {
    index = JSON.parse(files[".claude/qaas/context-index.json"].content);
  } catch (error) {
    throw new Error(`context-index.json is invalid JSON: ${error.message}`);
  }
  const allowedIndexKeys = new Set([
    "schemaVersion",
    "projectId",
    "generatedAt",
    "topics",
    "managedClaudeBlock",
    "contextDigest",
  ]);
  if (
    !index ||
    typeof index !== "object" ||
    Array.isArray(index) ||
    Object.keys(index).some((key) => !allowedIndexKeys.has(key)) ||
    index.schemaVersion !== "1.0" ||
    index.projectId !== projectId ||
    !Number.isFinite(Date.parse(index.generatedAt)) ||
    !Array.isArray(index.topics)
  ) {
    throw new Error("context-index.json has invalid top-level fields");
  }
  const indexedPaths = new Set();
  for (const topic of index.topics) {
    const fullPath = `.claude/${topic?.path}`;
    if (
      !topic ||
      typeof topic !== "object" ||
      !isManagedContextPath(fullPath) ||
      !fullPath.toLowerCase().endsWith(".md") ||
      typeof topic.title !== "string" ||
      !topic.title ||
      typeof topic.purpose !== "string" ||
      !topic.purpose ||
      !files[fullPath] ||
      !safeEqualHex(topic.sha256, files[fullPath].sha256) ||
      indexedPaths.has(fullPath)
    ) {
      throw new Error(`context-index topic is invalid or stale: ${fullPath}`);
    }
    indexedPaths.add(fullPath);
  }
  const expectedTopics = Object.keys(files).filter(
    (entry) =>
      entry.startsWith(".claude/qaas/") &&
      entry.toLowerCase().endsWith(".md"),
  );
  if (
    expectedTopics.some((entry) => !indexedPaths.has(entry)) ||
    indexedPaths.size !== expectedTopics.length
  ) {
    throw new Error(
      "context-index.json must enumerate every core and custom managed topic exactly once",
    );
  }
  const blockDigest = files[".claude/CLAUDE.md"].sha256;
  if (
    index.managedClaudeBlock?.startMarker !== "<!-- QAAS:START -->" ||
    index.managedClaudeBlock?.endMarker !== "<!-- QAAS:END -->" ||
    !safeEqualHex(index.managedClaudeBlock?.sha256, blockDigest)
  ) {
    throw new Error("context-index managed CLAUDE block digest is stale");
  }
  const computedContextDigest = canonicalDigest({
    topics: [...indexedPaths]
      .sort()
      .map((entry) => ({ path: entry, sha256: files[entry].sha256 })),
    managedClaudeBlock: blockDigest,
  });
  if (!safeEqualHex(index.contextDigest, computedContextDigest)) {
    throw new Error("context-index contextDigest is stale");
  }
  return { index, contextDigest: computedContextDigest };
}

function topicMetadata(relative, content) {
  const lines = content.replaceAll("\r\n", "\n").split("\n");
  const heading = lines.find((line) => /^#\s+\S/u.test(line));
  const title = heading
    ? heading.replace(/^#\s+/u, "").trim().slice(0, 160)
    : path.posix.basename(relative, ".md").replaceAll("-", " ").slice(0, 160);
  const purpose =
    lines.find(
      (line) =>
        line.trim() !== "" &&
        !line.trimStart().startsWith("#") &&
        !line.trimStart().startsWith("<!--"),
    )?.trim().slice(0, 240) ?? `Project context for ${title}`;
  return { title, purpose };
}

async function finalizeContextBundle(context, active) {
  if (!["DISCOVERING", "CONTEXT_REVIEW"].includes(active.state.phase)) {
    throw new Error("Context finalization is legal only during discovery/review");
  }
  const existing = await context.authority.readSigned("staging/context.json");
  const files = { ...existing.payload.files };
  const requiredTopics = [...CONTEXT_PATHS].filter((entry) =>
    entry.startsWith(".claude/qaas/") && entry.toLowerCase().endsWith(".md"),
  );
  for (const required of requiredTopics) {
    if (!files[required]) {
      throw new Error(`Missing staged core context topic: ${required}`);
    }
  }
  const topicPaths = Object.keys(files)
    .filter(
      (entry) =>
        entry.startsWith(".claude/qaas/") &&
        entry.toLowerCase().endsWith(".md"),
    )
    .sort();
  const topics = topicPaths.map((entry) => {
    const metadata = topicMetadata(entry, files[entry].content);
    return {
      path: entry.slice(".claude/".length),
      ...metadata,
      sha256: files[entry].sha256,
    };
  });
  const routerTemplatePath = path.join(
    context.pluginRoot,
    "templates",
    "project-context",
    ".claude",
    "CLAUDE.md",
  );
  const routerTemplate = await readFile(routerTemplatePath, "utf8");
  if (
    !routerTemplate.startsWith("<!-- QAAS:START -->") ||
    !routerTemplate.trimEnd().endsWith("<!-- QAAS:END -->")
  ) {
    throw new Error("Shipped CLAUDE router template has invalid managed markers");
  }
  const indexedTopics = [
    "",
    "## Indexed project topics",
    "",
    "Load one topic for the current decision; return to the index before loading another.",
    "",
    ...topics.map(
      (topic) => `- [${topic.title}](${topic.path}) — ${topic.purpose}`,
    ),
    "",
  ].join("\n");
  const block = routerTemplate.replace(
    "<!-- QAAS:END -->",
    `${indexedTopics}<!-- QAAS:END -->`,
  );
  assertNoSecrets(block, "generated managed CLAUDE block");
  files[".claude/CLAUDE.md"] = {
    content: block,
    sha256: sha256(block),
  };
  let generatedAt = new Date().toISOString();
  try {
    const priorIndex = JSON.parse(
      files[".claude/qaas/context-index.json"]?.content ?? "null",
    );
    if (Number.isFinite(Date.parse(priorIndex?.generatedAt))) {
      generatedAt = priorIndex.generatedAt;
    }
  } catch {
    // A deterministic replacement is generated below.
  }
  const contextDigest = canonicalDigest({
    topics: topicPaths.map((entry) => ({
      path: entry,
      sha256: files[entry].sha256,
    })),
    managedClaudeBlock: files[".claude/CLAUDE.md"].sha256,
  });
  const index = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    generatedAt,
    topics,
    managedClaudeBlock: {
      startMarker: "<!-- QAAS:START -->",
      endMarker: "<!-- QAAS:END -->",
      sha256: files[".claude/CLAUDE.md"].sha256,
    },
    contextDigest,
  };
  const indexContent = `${canonicalJson(index)}\n`;
  files[".claude/qaas/context-index.json"] = {
    content: indexContent,
    sha256: sha256(indexContent),
  };
  validateContextBundle(context.authority.projectId, files);
  const payload = {
    ...existing.payload,
    files,
    updatedAt: new Date().toISOString(),
    sequence: existing.payload.sequence + 1,
  };
  await context.authority.writeSigned("staging/context.json", payload, {
    expectedSequence: existing.payload.sequence,
  });
  return {
    finalized: true,
    contextDigest,
    topicCount: topics.length,
    managedBlockDigest: files[".claude/CLAUDE.md"].sha256,
  };
}

function readinessFactDocument({ domain, status, summary }) {
  const fact = {
    schemaVersion: "1.0",
    domain,
    status,
    summary,
  };
  fact.digest = canonicalDigest(fact);
  return fact;
}

async function prepareReadinessFact(context, active, args) {
  if (active.state.phase !== "DISCOVERING") {
    throw new Error("Readiness facts may be confirmed only during discovery");
  }
  const domain = args.domain;
  const status = args.status;
  if (!READINESS_DOMAINS.includes(domain)) {
    throw new Error("--domain must name one exact readiness domain");
  }
  if (!["user_confirmed", "not_applicable"].includes(status)) {
    throw new Error(
      "--status must be user_confirmed or not_applicable for a user fact",
    );
  }
  if (
    status === "not_applicable" &&
    !NOT_APPLICABLE_READINESS_DOMAINS.includes(domain)
  ) {
    throw new Error(`not_applicable is forbidden for core domain ${domain}`);
  }
  if (typeof args["summary-base64"] !== "string") {
    throw new Error("--summary-base64 is required");
  }
  const summary = decodeBase64(args["summary-base64"]);
  if (
    summary.trim().length < 1 ||
    summary.length > 320 ||
    summary.includes("\0")
  ) {
    throw new Error("Readiness fact summary must contain 1-320 safe characters");
  }
  assertNoSecrets(summary, "readiness fact");
  const fact = readinessFactDocument({ domain, status, summary });
  const prior = await context.authority.readSigned(
    `readiness-facts/${fact.digest}.json`,
    { required: false },
  );
  if (!prior) {
    await context.authority.writeSigned(
      `readiness-facts/${fact.digest}.json`,
      {
        schemaVersion: "1.0",
        projectId: context.authority.projectId,
        fact,
        status: "pending",
        sequence: 0,
      },
      { expectedSequence: -1 },
    );
  }
  return createChallenge(context, active, {
    kind: "readiness-fact",
    objectId: domain,
    approvalDigest: fact.digest,
    reviewDocument: fact,
  });
}

async function signedPackageSnapshotForDigest(context, digest) {
  for (const relative of [
    "packages/discovery.json",
    "packages/task-baseline.json",
    "packages/verified-baseline.json",
  ]) {
    const record = await context.authority.readSigned(relative, {
      required: false,
    });
    if (
      record &&
      safeEqualHex(record.payload.snapshotDigest, digest) &&
      safeEqualHex(record.payload.snapshot?.digest, digest)
    ) {
      return record.payload.snapshot;
    }
  }
  return null;
}

async function verifyReadinessAuthority(context, active, document) {
  const sources = [
    ...(document.requiredSourcesEvidence ?? []),
    ...READINESS_DOMAINS.flatMap(
      (domain) => document.domains?.[domain]?.sources ?? [],
    ),
  ];
  const verifiedSources = new Map();
  for (const source of sources) {
    if (source.kind === "user") {
      const domain = READINESS_DOMAINS.find((candidate) =>
        document.domains?.[candidate]?.sources?.some(
          (entry) =>
            entry.kind === "user" &&
            safeEqualHex(entry.digest, source.digest),
        ),
      );
      const entry = domain ? document.domains[domain] : null;
      const expected = entry
        ? readinessFactDocument({
            domain,
            status: entry.status,
            summary: entry.summary,
          })
        : null;
      if (!expected || !safeEqualHex(expected.digest, source.digest)) {
        throw new Error("Readiness user fact does not bind its exact domain statement");
      }
      const approval = await findApprovalByDigest(context.authority, {
        kind: "readiness-fact",
        approvedDigest: source.digest,
        sessionId: active.attestation.sessionId,
        leaseId: active.lease.leaseId,
      });
      if (!approval || approval.objectId !== domain) {
        throw new Error(
          `Readiness fact ${domain ?? "<unknown>"} lacks one exact registered user answer`,
        );
      }
      verifiedSources.set(source.digest, {
        kind: "user",
        locatorKey: source.digest,
      });
      continue;
    }
    if (source.kind === "package") {
      if (!(await signedPackageSnapshotForDigest(context, source.digest))) {
        throw new Error("Readiness package source lacks a signed package snapshot");
      }
      verifiedSources.set(source.digest, {
        kind: "package",
        locatorKey: source.digest,
      });
      continue;
    }
    const record = await context.authority.readSigned(
      `evidence/records/${source.digest}.json`,
      { required: false },
    );
    if (
      !record ||
      !safeEqualHex(record.payload.event?.digest, source.digest) ||
      record.payload.event?.status !== "success" ||
      !["ordinary-read", "configured-source-read"].includes(
        record.payload.event?.actionClass,
      )
    ) {
      throw new Error(
        `Readiness source ${source.identifier} lacks signed successful read evidence`,
      );
    }
    const event = record.payload.event;
    const provenance = event.details?.provenance;
    if (
      !isSha256(event.inputDigest) ||
      !isSha256(event.outputDigest) ||
      !provenance ||
      provenance.category !== source.kind ||
      provenance.immutableLocator !== true ||
      !isSha256(provenance.locatorDigest)
    ) {
      throw new Error(
        `Readiness source ${source.identifier} lacks host-derived input/output/locator provenance`,
      );
    }
    if (source.kind === "project") {
      if (
        event.actionClass !== "ordinary-read" ||
        !Array.isArray(event.paths) ||
        event.paths.length === 0 ||
        !Array.isArray(provenance.readProofs) ||
        provenance.readProofs.length === 0
      ) {
        throw new Error("Project readiness evidence requires exact nonempty file proofs");
      }
      const provenPaths = provenance.readProofs
        .map((proof) => proof.path)
        .sort();
      if (
        canonicalDigest([...event.paths].sort()) !==
        canonicalDigest(provenPaths)
      ) {
        throw new Error("Project readiness evidence paths do not bind its read proofs");
      }
      for (const proof of provenance.readProofs) {
        const target = path.resolve(
          context.projectRoot,
          ...String(proof.path).replaceAll("\\", "/").split("/"),
        );
        const resolved = await realpath(target);
        const relative = path.relative(context.projectRoot, resolved);
        if (
          relative === "" ||
          relative.startsWith("..") ||
          path.isAbsolute(relative)
        ) {
          throw new Error("Project readiness evidence escapes the project");
        }
        const info = await stat(resolved);
        const bytes = await readFile(resolved);
        if (
          !info.isFile() ||
          info.size !== proof.size ||
          !safeEqualHex(sha256(bytes), proof.sha256)
        ) {
          throw new Error(
            `Project readiness evidence is stale for ${proof.path}`,
          );
        }
      }
    } else if (source.kind === "docs") {
      const allowedConfigurationNames = new Set(
        QAAS_DOCS_CONFIGURATION_NAMES,
      );
      if (
        event.actionClass !== "configured-source-read" ||
        !Array.isArray(provenance.configurationNames) ||
        provenance.configurationNames.some(
          (name) => !allowedConfigurationNames.has(name),
        ) ||
        !isSha256(provenance.configurationDigest)
      ) {
        throw new Error("Documentation evidence lacks pinned configured-source provenance");
      }
      if (provenance.source === "qaas-docs") {
        if (
          canonicalDigest([...provenance.configurationNames].sort()) !==
            canonicalDigest([...QAAS_DOCS_CONFIGURATION_NAMES].sort()) ||
          !provenance.documentationConfiguration ||
          !safeEqualHex(
            provenance.documentationConfiguration.digest,
            provenance.configurationDigest,
          )
        ) {
          throw new Error(
            "QaaS documentation evidence omits an effective source selector",
          );
        }
        await assertCurrentDocumentationSourceConfiguration(
          provenance.documentationConfiguration,
          context.env,
        );
      } else {
        const expectedEndpointKinds = {
          gitlab: "reviewed-project-input",
          artifactory: "distribution-built-in",
          nuget: "project-package-metadata",
          modules: "reviewed-project-input",
          "common-hooks": "reviewed-project-input",
        };
        const endpointConfiguration = provenance.endpointConfiguration;
        if (
          !Object.hasOwn(expectedEndpointKinds, provenance.source) ||
          provenance.configurationNames.length !== 0 ||
          !safeEqualHex(provenance.configurationDigest, sha256({})) ||
          !isSha256(provenance.reviewedInputDigest) ||
          endpointConfiguration?.source !== provenance.source ||
          !isSha256(endpointConfiguration?.endpointDigest) ||
          canonicalDigest(endpointConfiguration?.endpoint) !==
            endpointConfiguration.endpointDigest ||
          endpointConfiguration.endpoint?.kind !==
            expectedEndpointKinds[provenance.source]
        ) {
          throw new Error(
            "Configured-source evidence lacks an exact built-in or reviewed endpoint binding",
          );
        }
        const currentConfigurationDigest = sha256(
          Object.fromEntries(
            provenance.configurationNames.map((name) => [
              name,
              Object.hasOwn(context.env, name)
                ? sha256(String(context.env[name]))
                : null,
            ]),
          ),
        );
        if (
          !safeEqualHex(
            currentConfigurationDigest,
            provenance.configurationDigest,
          )
        ) {
          throw new Error(
            "Documentation source configuration changed after its read",
          );
        }
      }
    } else if (
      source.kind !== "runtime" ||
      event.actionClass !== "ordinary-read"
    ) {
      throw new Error(
        `Readiness source kind ${source.kind} does not match host-derived provenance`,
      );
    }
    verifiedSources.set(source.digest, {
      kind: source.kind,
      locatorKey: provenance.locatorDigest,
    });
  }
  const usedClaims = new Set();
  for (const domain of EVIDENCE_REQUIRED_READINESS_DOMAINS) {
    const eligible = (document.domains?.[domain]?.sources ?? [])
      .map((source) => ({
        source,
        proof: verifiedSources.get(source.digest),
      }))
      .find(
        ({ source, proof }) =>
          proof &&
          source.kind !== "user" &&
          !usedClaims.has(source.claimDigest),
      );
    if (!eligible) {
      throw new Error(
        `Core readiness domain ${domain} requires a distinct domain-bound evidence claim`,
      );
    }
    usedClaims.add(eligible.source.claimDigest);
  }
  return true;
}

async function stageArtifact(context, active, args) {
  const kind = args.kind;
  const validators = {
    readiness: validateReadiness,
    plan: validateTaskPlan,
    execution: validateExecutionPlan,
    mutation: validateMutationPlan,
    query: validateQueryPlan,
    "source-checkout": (document) =>
      validateSourceCheckout(document, context.env),
  };
  if (!validators[kind]) throw new Error("stage kind is unsupported");
  if (
    kind === "source-checkout" &&
    active.state.phase !== "DISCOVERING"
  ) {
    throw new Error("Source checkout staging is legal only during discovery");
  }
  const content = decodeBase64(args["content-base64"]);
  assertNoSecrets(content, `staged ${kind}`);
  let document;
  try {
    document = JSON.parse(content);
  } catch (error) {
    throw new Error(`Staged ${kind} is invalid JSON: ${error.message}`);
  }
  if (
    ["plan", "execution", "mutation", "query", "source-checkout"].includes(kind) &&
    document &&
    typeof document === "object" &&
    !Array.isArray(document)
  ) {
    document.digest = canonicalDigest(document);
  }
  const validation = validators[kind](document);
  if (!validation.valid || (kind === "readiness" && !validation.ready)) {
    throw new Error(
      `Staged ${kind} failed validation: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  if (kind === "readiness") {
    await verifyReadinessAuthority(context, active, document);
  }
  if (
    kind === "query" &&
    !["IMPLEMENTED_NOT_RUN", "EXECUTION_APPROVED", "DIAGNOSING", "VERIFIED"].includes(
      active.state.phase,
    )
  ) {
    throw new Error("Query staging is not legal in the current phase");
  }
  if (document.projectId && document.projectId !== context.authority.projectId) {
    throw new Error(`${kind} projectId does not match protected authority`);
  }
  const existing = await context.authority.readSigned(`artifacts/${kind}.json`, {
    required: false,
  });
  const payload = {
    schemaVersion: "1.0",
    kind,
    projectId: context.authority.projectId,
    document,
    digest: kind === "readiness" ? canonicalDigest(document) : document.digest,
    stagedAt: new Date().toISOString(),
    stagedBySession: active.attestation.sessionId,
    sequence: (existing?.payload.sequence ?? -1) + 1,
  };
  await context.authority.writeSigned(`artifacts/${kind}.json`, payload, {
    expectedSequence: existing?.payload.sequence ?? -1,
  });
  return { staged: kind, digest: payload.digest };
}

async function stageCapabilities(context, active, args) {
  if (
    !["DISCOVERING", "CONTEXT_REVIEW", "PROJECT_READY", "TASK_DISCOVERY"].includes(
      active.state.phase,
    )
  ) {
    throw new Error("Capability staging is not legal in the current phase");
  }
  const content = decodeBase64(args["content-base64"]);
  assertNoSecrets(content, "staged integration capabilities");
  let registry;
  try {
    registry = JSON.parse(content);
  } catch (error) {
    throw new Error(`Capability registry is invalid JSON: ${error.message}`);
  }
  const validation = validateCapabilityRegistry(registry);
  if (!validation.valid) {
    throw new Error(
      `Capability registry failed validation: ${validation.errors.join("; ")}`,
    );
  }
  const prior = await context.authority.readSigned(
    "staging/capabilities.json",
    { required: false },
  );
  const payload = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    registry,
    digest: canonicalDigest(registry),
    stagedAt: new Date().toISOString(),
    stagedBySession: active.attestation.sessionId,
    sequence: (prior?.payload.sequence ?? -1) + 1,
  };
  await context.authority.writeSigned("staging/capabilities.json", payload, {
    expectedSequence: prior?.payload.sequence ?? -1,
  });
  return { staged: "capabilities", digest: payload.digest };
}

async function createChallenge(context, active, {
  kind,
  objectId,
  approvalDigest,
  reviewDocument,
}) {
  const canonicalReviewDocument = canonicalJson(reviewDocument);
  if (Buffer.byteLength(canonicalReviewDocument, "utf8") > MAX_REVIEW_BYTES) {
    throw new Error(
      `Exact ${kind} review exceeds the ${MAX_REVIEW_BYTES}-byte review bound`,
    );
  }
  const reviewDigest = canonicalDigest(reviewDocument);
  if (!safeEqualHex(reviewDigest, approvalDigest)) {
    throw new Error(
      `Exact ${kind} review document does not match the approval digest`,
    );
  }
  const reviewLease = await synchronizeLease(context.authority, {
    sessionId: active.attestation.sessionId,
    taskId: active.state.taskId ?? "__onboarding__",
    phase: active.state.phase,
    ttlMs: 10 * 60 * 1000,
  });
  const headers = {
    context: "QaaS Context",
    plan: "QaaS Plan",
    execution: "QaaS Run",
    mutation: "QaaS Mutate",
    capabilities: "QaaS Tools",
    "source-checkout": "QaaS Source",
    "source-read": "QaaS Read",
    "readiness-fact": "QaaS Fact",
    query: "QaaS Query",
  };
  // The registered AskUserQuestion prompt is the authorization surface. Show
  // the complete review object so identifiers, digests, process/endpoint
  // bindings, bounds, checks, risks, and every other material field are never
  // hidden behind an undisplayed signed payload.
  const criticalReview = canonicalReviewDocument;
  const prompt =
    `Review these exact bounded ${kind} fields:\n${criticalReview}\n` +
    `Approval SHA-256: ${approvalDigest}\n` +
    `Approve exact QaaS ${kind} ${objectId}?`;
  if (Buffer.byteLength(prompt, "utf8") > MAX_HUMAN_REVIEW_BYTES) {
    throw new Error(
      `Exact ${kind} human review exceeds the ${MAX_HUMAN_REVIEW_BYTES}-byte bound`,
    );
  }
  const question = {
    question: prompt,
    header: headers[kind] ?? "QaaS Review",
    options: APPROVAL_DECISION_OPTIONS,
    multiSelect: false,
  };
  await supersedeApprovalChallenges(context.authority, {
    kind,
    sessionId: active.attestation.sessionId,
    reason: `A fresh exact ${kind} review replaced the pending review`,
  });
  const challenge = await createApprovalChallenge(context.authority, {
    challengeId: randomBytes(24).toString("hex"),
    kind,
    objectId,
    approvalDigest,
    sessionId: active.attestation.sessionId,
    questionId: question.header,
    prompt: question.question,
    options: question.options,
    multiSelect: question.multiSelect,
    expiresAt: new Date(Date.now() + 8 * 60 * 1000).toISOString(),
    leaseId: reviewLease.leaseId,
  });
  const pendingPath =
    `sessions/${sha256(active.attestation.sessionId)}/pending-action.json`;
  const priorPending = await context.authority.readSigned(pendingPath, {
    required: false,
  });
  const pending = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    challengeId: challenge.challengeId,
    kind,
    objectId,
    approvalDigest,
    question,
    expiresAt: challenge.expiresAt,
    stateSequence: active.state.sequence,
    createdAt: new Date().toISOString(),
    sequence: (priorPending?.payload.sequence ?? -1) + 1,
  };
  assertNoSecrets(pending, "pending resume action");
  if (Buffer.byteLength(canonicalJson(pending), "utf8") > MAX_RESUME_BYTES) {
    throw new Error(`Pending resume action exceeds ${MAX_RESUME_BYTES} bytes`);
  }
  await context.authority.writeSigned(pendingPath, pending, {
    expectedSequence: priorPending?.payload.sequence ?? -1,
  });
  return {
    challengeId: challenge.challengeId,
    question,
    review: {
      kind,
      objectId,
      approvalDigest,
      reviewDigest,
      canonicalDocument: canonicalReviewDocument,
      instruction:
        "The registered question itself contains every critical human-review field.",
    },
  };
}

async function prepareSourceCheckout(context, active) {
  if (active.state.phase !== "DISCOVERING") {
    throw new Error("Source checkout review is legal only during discovery");
  }
  const artifact = await context.authority.readSigned(
    "artifacts/source-checkout.json",
  );
  const validation = validateSourceCheckout(
    artifact.payload.document,
    context.env,
  );
  if (!validation.valid) {
    throw new Error(
      `Source checkout became invalid: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  const document = artifact.payload.document;
  const referenceRoot = context.authority.resolveProtectedPath(
    "r",
  );
  await mkdir(referenceRoot, { recursive: true, mode: 0o700 });
  const destination = context.authority.resolveProtectedPath(
    `r/${artifact.payload.digest.slice(0, 24)}.git`,
  );
  const checkoutEnvironment = {
    ...context.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: document.tlsVerify ? "1" : "2",
    GIT_CONFIG_KEY_0: "http.followRedirects",
    GIT_CONFIG_VALUE_0: "false",
    ...(document.tlsVerify
      ? {}
      : {
          GIT_CONFIG_KEY_1: "http.sslVerify",
          GIT_CONFIG_VALUE_1: "false",
        }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  const commonCloneArguments = [
    "--bare",
    "--no-local",
    "--depth",
    "1",
    "--single-branch",
    "--branch",
    document.ref,
    "--no-recurse-submodules",
    "--template=",
  ];
  const cloneCommand =
    document.transport === "git"
      ? {
          program: "git",
          args: [
            "clone",
            ...commonCloneArguments,
            document.repositoryUrl,
            destination,
          ],
        }
      : {
          program: "glab",
          args: [
            "repo",
            "clone",
            document.repositoryUrl,
            destination,
            "--",
            ...commonCloneArguments,
          ],
        };
  const cloneBinding = await attestProcessSpecification({
    program: cloneCommand.program,
    args: cloneCommand.args,
    cwd: referenceRoot,
    envNames: [
      "GIT_TERMINAL_PROMPT",
      "GIT_LFS_SKIP_SMUDGE",
      "GIT_NO_LAZY_FETCH",
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_CONFIG_COUNT",
      "GIT_CONFIG_KEY_0",
      "GIT_CONFIG_VALUE_0",
      ...(document.tlsVerify
        ? []
        : [
            "GIT_CONFIG_KEY_1",
            "GIT_CONFIG_VALUE_1",
          ]),
      ...(document.credentialEnv ? [document.credentialEnv] : []),
    ],
    timeoutMs: 120_000,
    outputLimitBytes: 64 * 1024,
    outputDirectories: [destination],
    scopeRoot: referenceRoot,
    actionClass: "source-checkout-write",
    environment: checkoutEnvironment,
  });
  const git = await discoverProgram("git", {
    cwd: referenceRoot,
    env: checkoutEnvironment,
  });
  if (!git.available) {
    throw new Error(`Git verifier is unavailable: ${git.error}`);
  }
  for (const resolved of [cloneBinding.resolvedProgram, git.resolvedPath]) {
    const relative = path.relative(context.projectRoot, resolved);
    if (
      relative === "" ||
      (!relative.startsWith("..") && !path.isAbsolute(relative))
    ) {
      throw new Error("Source checkout executable resolves inside the project");
    }
  }
  const reviewDocument = {
    schemaVersion: "1.0",
    kind: "source-checkout",
    projectId: context.authority.projectId,
    objectId: document.checkoutId,
    artifactDigest: artifact.payload.digest,
    document,
    destination,
    cloneCommand,
    cloneBinding,
    gitVerifier: {
      resolvedProgram: git.resolvedPath,
      executableDigest: git.executableDigest,
    },
  };
  reviewDocument.digest = canonicalDigest(reviewDocument);
  const prior = await context.authority.readSigned(
    "artifacts/source-checkout-review.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "artifacts/source-checkout-review.json",
    {
      ...reviewDocument,
      sequence: (prior?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  return createChallenge(context, active, {
    kind: "source-checkout",
    objectId: document.checkoutId,
    approvalDigest: reviewDocument.digest,
    reviewDocument,
  });
}

async function prepareSourceRead(context, active, args) {
  if (!SOURCE_READ_PHASES.has(active.state.phase)) {
    throw new Error("Source-read review is not legal in the current phase");
  }
  const request = await resolveSourceReadRequest({
    args,
    env: context.env,
    projectRoot: context.projectRoot,
  });
  if (!request.requiresExactApproval) {
    throw new Error(
      "A source-read review is required only for an exact user-supplied GitLab, modules, or Common Hooks URL",
    );
  }
  const reviewDocument = {
    schemaVersion: "1.0",
    kind: "source-read",
    projectId: context.authority.projectId,
    taskId: active.state.taskId ?? null,
    phase: active.state.phase,
    request: request.description,
    requestDigest: canonicalDigest(request.description),
    oneUse: true,
  };
  assertNoSecrets(reviewDocument, "source-read review");
  reviewDocument.digest = canonicalDigest(reviewDocument);
  const prior = await context.authority.readSigned(
    "artifacts/source-read-review.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "artifacts/source-read-review.json",
    {
      ...reviewDocument,
      sequence: (prior?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  await supersedeApprovals(context.authority, {
    kind: "source-read",
    sessionId: active.attestation.sessionId,
    reason: "A fresh exact source-read review replaced prior access",
  });
  return createChallenge(context, active, {
    kind: "source-read",
    objectId:
      `${request.description.source}:` +
      request.description.requestUrlDigest.slice(0, 16),
    approvalDigest: reviewDocument.digest,
    reviewDocument,
  });
}

async function prepareCapabilities(context, active) {
  const staged = await context.authority.readSigned("staging/capabilities.json");
  const reviewDocument = {
    schemaVersion: "1.0",
    kind: "capabilities",
    projectId: context.authority.projectId,
    registry: staged.payload.registry,
    registryDigest: staged.payload.digest,
    docsMcpTransport: describeMcpTransport(context.env),
  };
  reviewDocument.digest = canonicalDigest(reviewDocument);
  const prior = await context.authority.readSigned(
    "staging/capabilities-review.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "staging/capabilities-review.json",
    {
      ...reviewDocument,
      sequence: (prior?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  return createChallenge(context, active, {
    kind: "capabilities",
    objectId: `capabilities:${staged.payload.registry.version}`,
    approvalDigest: reviewDocument.digest,
    reviewDocument,
  });
}

async function commitCapabilities(context, active) {
  const staged = await context.authority.readSigned("staging/capabilities.json");
  const review = await context.authority.readSigned(
    "staging/capabilities-review.json",
  );
  const {
    sequence: _reviewSequence,
    ...reviewContent
  } = review.payload;
  if (
    !safeEqualHex(review.payload.registryDigest, staged.payload.digest) ||
    !safeEqualHex(review.payload.digest, canonicalDigest(reviewContent))
  ) {
    throw new Error("Capability review is stale or corrupt");
  }
  const currentTransport = describeMcpTransport(context.env);
  if (
    canonicalDigest(currentTransport) !==
    canonicalDigest(review.payload.docsMcpTransport)
  ) {
    throw new Error("Documentation MCP transport changed after exact review");
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "capabilities",
    approvedDigest: review.payload.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) throw new Error("Exact capability registry is not approved");
  const validation = validateCapabilityRegistry(staged.payload.registry);
  if (!validation.valid) {
    throw new Error("Staged capability registry became invalid");
  }
  const prior = await context.authority.readSigned(
    "integrations/capabilities.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "integrations/capabilities.json",
    staged.payload.registry,
    { expectedDigest: prior?.digest ?? null },
  );
  const priorTransport = await context.authority.readSigned(
    "integrations/docs-mcp-transport.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "integrations/docs-mcp-transport.json",
    currentTransport,
    { expectedDigest: priorTransport?.digest ?? null },
  );
  await context.authority.appendEvent("capability-registry-committed", {
    registryDigest: staged.payload.digest,
    reviewDigest: review.payload.digest,
    transportDigest: canonicalDigest(currentTransport),
    approvalId: approval.approvalId,
    capabilityCount: staged.payload.registry.capabilities.length,
  });
  return {
    committed: true,
    digest: staged.payload.digest,
    capabilityCount: staged.payload.registry.capabilities.length,
  };
}

async function prepareContext(context, active) {
  if (active.state.phase !== "DISCOVERING") {
    throw new Error("Context review may begin only from DISCOVERING");
  }
  const readiness = await context.authority.readSigned("artifacts/readiness.json");
  const readinessValidation = validateReadiness(readiness.payload.document);
  if (!readinessValidation.valid || !readinessValidation.ready) {
    throw new Error("Readiness artifact is not currently complete");
  }
  await verifyReadinessAuthority(context, active, readiness.payload.document);
  const discoveryPackages = await context.authority.readSigned(
    "packages/discovery.json",
  );
  await assertCurrentPackageSnapshot({
    authority: context.authority,
    relativePath: "packages/discovery.json",
    projectRoot: context.projectRoot,
    env: context.env,
    expectedDigest: discoveryPackages.payload.snapshotDigest,
  });
  const staged = await context.authority.readSigned("staging/context.json");
  const bundle = validateContextBundle(context.authority.projectId, staged.payload.files);
  const baseFingerprint = await createFingerprint({
    projectRoot: context.projectRoot,
    stage: "onboardingFingerprint",
    exclusions: [".claude/qaas"],
  });
  const proposal = {
    schemaVersion: "1.0",
    kind: "context",
    projectId: context.authority.projectId,
    contextDigest: bundle.contextDigest,
    readinessDigest: readiness.payload.digest,
    readiness: readiness.payload.document,
    packageSnapshotDigest: discoveryPackages.payload.snapshotDigest,
    baseFingerprintDigest: baseFingerprint.digest,
    fileDigests: Object.fromEntries(
      Object.entries(staged.payload.files)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([filePath, record]) => [filePath, record.sha256]),
    ),
  };
  proposal.digest = canonicalDigest(proposal);
  const existing = await context.authority.readSigned("artifacts/context-proposal.json", {
    required: false,
  });
  await context.authority.writeSigned(
    "artifacts/context-proposal.json",
    {
      ...proposal,
      sequence: (existing?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: existing?.payload.sequence ?? -1 },
  );
  const priorFingerprint = await context.authority.readSigned(
    "fingerprints/context-base.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "fingerprints/context-base.json",
    baseFingerprint,
    { expectedDigest: priorFingerprint?.digest ?? null },
  );
  const next = await commitTransition(context.authority, active.state, "CONTEXT_REVIEW", {
    reason: "Validated complete context proposal and opened exact review",
  });
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Opened context review",
  );
  return createChallenge(context, { ...active, state: next }, {
    kind: "context",
    objectId: `context:${bundle.contextDigest}`,
    approvalDigest: proposal.digest,
    reviewDocument: proposal,
  });
}

async function currentStoredFingerprint(context, relativePath) {
  const record = await context.authority.readSigned(relativePath);
  const expected = record.payload;
  const actual = await createFingerprint({
    projectRoot: context.projectRoot,
    stage: expected.stage,
    relevantPaths: expected.scopePaths ?? null,
    exclusions: (expected.exclusions ?? []).filter(
      (entry) => ![".git", ".claude/qaas/state"].includes(entry),
    ),
    packageSnapshot: expected.packageSnapshot,
    contextDigest: expected.contextDigest,
    externalReferences: expected.externalReferences,
    renderedTemplate: expected.renderedTemplate,
  });
  const comparison = compareFingerprints(expected, actual);
  if (!comparison.equal) {
    const error = new Error(
      `Project fingerprint is stale: added=${comparison.added.join(",")}; ` +
        `removed=${comparison.removed.join(",")}; changed=${comparison.changed.join(",")}`,
    );
    error.code = "STALE";
    throw error;
  }
  return expected;
}

async function transitionStale(context, state, reason) {
  const next = await commitTransition(context.authority, state, "STALE", {
    reason,
    patch: {
      blocker: reason,
      nextLegalAction: "Run exact /qaas:onboard to rediscover current project state",
    },
  });
  await mirrorProjectState(context.projectRoot, next, "Invalidated stale review");
  return next;
}

async function preparePlanLike(context, active, kind) {
  const mapping = {
    plan: {
      phase: "TASK_DISCOVERY",
      to: "PLAN_REVIEW",
      id: "planId",
      approvalKind: "plan",
    },
    execution: {
      phases: [
        "IMPLEMENTED_NOT_RUN",
        "EXECUTION_REVIEW",
        "MUTATION_APPROVED",
      ],
      to: "EXECUTION_REVIEW",
      id: "executionId",
      approvalKind: "execution",
    },
    mutation: {
      phases: ["EXECUTION_REVIEW"],
      to: "MUTATION_REVIEW",
      id: "mutationId",
      approvalKind: "mutation",
    },
  };
  const rule = mapping[kind];
  const allowedPhases = rule.phases ?? [rule.phase];
  if (!allowedPhases.includes(active.state.phase)) {
    throw new Error(
      `${kind} review may begin only from ${allowedPhases.join(" or ")}`,
    );
  }
  const artifact = await context.authority.readSigned(`artifacts/${kind}.json`);
  const document = artifact.payload.document;
  if (document.taskId !== active.state.taskId) {
    throw new Error(`${kind} taskId does not match current signed state`);
  }
  if (kind === "plan") {
    if (document.contextDigest !== active.state.contextDigest) {
      throw new Error("Plan context digest is stale");
    }
    const fingerprint = await context.authority.readSigned(
      "fingerprints/onboardingFingerprint.json",
    );
    if (document.projectFingerprintDigest !== fingerprint.payload.digest) {
      throw new Error("Plan project fingerprint is stale");
    }
    try {
      await currentStoredFingerprint(
        context,
        "fingerprints/onboardingFingerprint.json",
      );
      const taskPackages = await context.authority.readSigned(
        "packages/task-baseline.json",
      );
      if (
        !safeEqualHex(
          document.packageSnapshotDigest,
          taskPackages.payload.snapshotDigest,
        )
      ) {
        throw new Error("Plan package snapshot does not bind the task baseline");
      }
      await assertCurrentPackageSnapshot({
        authority: context.authority,
        relativePath: "packages/task-baseline.json",
        projectRoot: context.projectRoot,
        env: context.env,
        expectedDigest: document.packageSnapshotDigest,
      });
    } catch (error) {
      await transitionStale(
        context,
        active.state,
        `Plan review invalidated before approval: ${error.message}`,
      );
      throw error;
    }
  } else if (kind === "execution") {
    const plan = await context.authority.readSigned("artifacts/plan.json");
    if (document.implementationPlanDigest !== plan.payload.digest) {
      throw new Error("Execution plan does not bind the approved implementation plan");
    }
    const fingerprint = await context.authority.readSigned(
      "fingerprints/staticVerificationFingerprint.json",
    );
    if (document.staticVerificationDigest !== fingerprint.payload.digest) {
      throw new Error("Execution plan static verification is stale");
    }
    const normalize = (value) =>
      String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
    const protectedPaths = [
      ...Object.values(plan.payload.document.paths ?? {}).flat(),
      ...(plan.payload.document.changes ?? []).map((change) => change.path),
    ].map(normalize);
    for (const output of document.outputPaths ?? []) {
      const candidate = normalize(output);
      if (
        protectedPaths.some(
          (protectedPath) =>
            candidate === protectedPath ||
            candidate.startsWith(`${protectedPath}/`) ||
            protectedPath.startsWith(`${candidate}/`),
        )
      ) {
        throw new Error(
          `Execution output ${output} overlaps reviewed source/context scope`,
        );
      }
    }
  } else {
    const execution = await context.authority.readSigned("artifacts/execution.json");
    if (document.executionPlanDigest !== execution.payload.digest) {
      throw new Error("Mutation plan does not bind the current execution plan");
    }
    const plan = await context.authority.readSigned("artifacts/plan.json");
    const normalize = (value) =>
      String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
    const protectedPaths = [
      ...Object.values(plan.payload.document.paths ?? {}).flat(),
      ...(plan.payload.document.changes ?? []).map((change) => change.path),
    ].map(normalize);
    for (const output of document.tool?.outputDirectories ?? []) {
      const candidate = normalize(output);
      if (
        protectedPaths.some(
          (protectedPath) =>
            candidate === protectedPath ||
            candidate.startsWith(`${protectedPath}/`) ||
            protectedPath.startsWith(`${candidate}/`),
        )
      ) {
        throw new Error(
          `Mutation output ${output} overlaps reviewed source/context scope`,
        );
      }
    }
  }
  const commands =
    kind === "plan"
      ? Object.entries(document.commands).flatMap(([action, entries]) =>
          entries.map((command, commandIndex) => ({
            action,
            commandIndex,
            command,
            outputDirectories: document.generatedOutputs,
          })),
        )
      : kind === "execution"
        ? [{
            action: "test-run",
            commandIndex: 0,
            command: document.command,
            outputDirectories: document.outputPaths,
          }]
        : document.tool?.kind === "process"
          ? [{
              action: "infrastructure-mutation",
              commandIndex: 0,
              command: document.tool.command,
              outputDirectories: document.tool.outputDirectories,
            }]
          : [];
  const processBindings = [];
  for (const entry of commands) {
    const cwd = path.resolve(context.projectRoot, entry.command.cwd);
    const cwdRelative = path.relative(context.projectRoot, cwd);
    if (cwdRelative.startsWith("..") || path.isAbsolute(cwdRelative)) {
      throw new Error(`${kind} command cwd escapes the project`);
    }
    const binding = await attestProcessSpecification({
      program: entry.command.program,
      args: entry.command.args,
      cwd,
      envNames: entry.command.envNames,
      timeoutMs: entry.command.timeoutMs,
      outputLimitBytes: entry.command.outputLimitBytes,
      outputDirectories: entry.outputDirectories,
      scopeRoot: context.projectRoot,
      actionClass: entry.action,
      environment: context.env,
    });
    const executableRelative = path.relative(
      context.projectRoot,
      binding.resolvedProgram,
    );
    if (
      executableRelative === "" ||
      (!executableRelative.startsWith("..") &&
        !path.isAbsolute(executableRelative))
    ) {
      throw new Error(
        "Reviewed process executable resolves inside the project; PATH shadowing is denied",
      );
    }
    processBindings.push({
      action: entry.action,
      commandIndex: entry.commandIndex,
      commandDigest: canonicalDigest(entry.command),
      ...binding,
    });
  }
  const reviewDocument = {
    schemaVersion: "1.0",
    kind,
    projectId: context.authority.projectId,
    objectId: document[rule.id],
    artifactDigest: artifact.payload.digest,
    document,
    processBindings,
  };
  reviewDocument.digest = canonicalDigest(reviewDocument);
  const priorReview = await context.authority.readSigned(
    `artifacts/${kind}-review.json`,
    { required: false },
  );
  await context.authority.writeSigned(
    `artifacts/${kind}-review.json`,
    {
      ...reviewDocument,
      sequence: (priorReview?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: priorReview?.payload.sequence ?? -1 },
  );
  if (kind === "mutation") {
    await supersedeApprovalChallenges(context.authority, {
      kind: "execution",
      sessionId: active.attestation.sessionId,
      reason: "Mutation review requires a fresh execution challenge afterward",
    });
  }
  const {
    execution: _executionApproval,
    ...approvalDigestsWithoutExecution
  } = active.state.approvedDigests ?? {};
  const {
    mutation: _mutationApproval,
    ...approvalDigestsWithoutMutation
  } = approvalDigestsWithoutExecution;
  const approvalPatch =
    kind === "execution" || kind === "mutation"
      ? {
          approvedDigests:
            kind === "mutation"
              ? approvalDigestsWithoutMutation
              : approvalDigestsWithoutExecution,
          nextLegalAction: `Review exact ${kind} and answer its signed challenge`,
        }
      : {};
  const next =
    active.state.phase === rule.to
      ? await commitCheckpoint(
          context.authority,
          active.state,
          approvalPatch,
          { reason: `Refreshed exact ${kind} review and approval challenge` },
        )
      : await commitTransition(context.authority, active.state, rule.to, {
          reason: `Validated exact ${kind} and opened review`,
          patch: approvalPatch,
        });
  await mirrorProjectState(
    context.projectRoot,
    next,
    `Opened ${kind} review`,
  );
  return createChallenge(context, { ...active, state: next }, {
    kind: rule.approvalKind,
    objectId: document[rule.id],
    approvalDigest: reviewDocument.digest,
    reviewDocument,
  });
}

async function prepareQuery(context, active) {
  if (
    !["IMPLEMENTED_NOT_RUN", "EXECUTION_APPROVED", "DIAGNOSING", "VERIFIED"].includes(
      active.state.phase,
    )
  ) {
    throw new Error(
      "Query review requires implemented, execution-approved, diagnosing, or verified state",
    );
  }
  const artifact = await context.authority.readSigned("artifacts/query.json");
  const document = artifact.payload.document;
  if (document.taskId !== active.state.taskId) {
    throw new Error("Query taskId does not match current signed state");
  }
  const execution = await context.authority.readSigned("artifacts/execution.json");
  if (
    !safeEqualHex(
      document.executionPlanDigest,
      execution.payload.digest,
    )
  ) {
    throw new Error("Query plan does not bind the current execution plan");
  }
  const fingerprintStage =
    active.state.fingerprints?.staticVerificationFingerprint
      ? "staticVerificationFingerprint"
      : active.state.fingerprints?.onboardingFingerprint
        ? "onboardingFingerprint"
        : null;
  if (!fingerprintStage) {
    throw new Error("Query review lacks a current signed project fingerprint");
  }
  const fingerprint = await currentStoredFingerprint(
    context,
    `fingerprints/${fingerprintStage}.json`,
  );
  if (
    !safeEqualHex(document.currentFingerprintDigest, fingerprint.digest)
  ) {
    throw new Error("Query plan project fingerprint is stale");
  }
  const registry = await context.authority.readSigned(
    "integrations/capabilities.json",
  );
  const bindings = document.queries.map((query) =>
    attestQuery({
      query,
      registry: registry.payload,
      env: context.env,
      projectRoot: context.projectRoot,
    }),
  );
  const reviewDocument = {
    schemaVersion: "1.0",
    kind: "query",
    projectId: context.authority.projectId,
    objectId: document.queryPlanId,
    artifactDigest: artifact.payload.digest,
    document,
    fingerprintStage,
    capabilityRegistryDigest: canonicalDigest(registry.payload),
    bindings,
  };
  reviewDocument.digest = canonicalDigest(reviewDocument);
  const prior = await context.authority.readSigned(
    "artifacts/query-review.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "artifacts/query-review.json",
    {
      ...reviewDocument,
      sequence: (prior?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  const { query: _priorQuery, ...approvedDigests } =
    active.state.approvedDigests ?? {};
  const next = await commitCheckpoint(
    context.authority,
    active.state,
    {
      approvedDigests,
      nextLegalAction:
        "Review and answer the separate exact bounded query challenge",
    },
    { reason: "Opened a separate read-only observability query review" },
  );
  await mirrorProjectState(context.projectRoot, next, "Opened query review");
  return createChallenge(context, { ...active, state: next }, {
    kind: "query",
    objectId: document.queryPlanId,
    approvalDigest: reviewDocument.digest,
    reviewDocument,
  });
}

async function mergeClaudeBlock(target, block) {
  let existing = "";
  try {
    existing = await readFile(target, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const marker = /<!-- QAAS:START -->[\s\S]*?<!-- QAAS:END -->\r?\n?/u;
  const next = marker.test(existing)
    ? existing.replace(marker, block)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;
  await atomicWriteText(target, next, { mode: 0o600 });
}

async function canonicalizeNearest(target) {
  const suffix = [];
  let cursor = path.resolve(target);
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function commitContext(context, active) {
  if (active.state.phase !== "CONTEXT_REVIEW") {
    throw new Error("Context commit requires CONTEXT_REVIEW");
  }
  const proposal = await context.authority.readSigned("artifacts/context-proposal.json");
  const approval = await findApprovalByDigest(context.authority, {
    kind: "context",
    approvedDigest: proposal.payload.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) throw new Error("Exact context proposal is not approved");
  const prior = await context.authority.readSigned("fingerprints/context-base.json");
  const current = await createFingerprint({
    projectRoot: context.projectRoot,
    stage: "onboardingFingerprint",
    exclusions: [".claude/qaas"],
  });
  if (!compareFingerprints(prior.payload, current).equal) {
    throw new Error("Project changed after context review; context approval is stale");
  }
  const staged = await context.authority.readSigned("staging/context.json");
  validateContextBundle(context.authority.projectId, staged.payload.files);
  for (const [relative, record] of Object.entries(staged.payload.files).sort(
    ([left], [right]) => (left < right ? -1 : left > right ? 1 : 0),
  )) {
    if (!safeEqualHex(record.sha256, sha256(record.content))) {
      throw new Error(`Staged context content is corrupt: ${relative}`);
    }
    const target = path.resolve(context.projectRoot, ...relative.split("/"));
    const canonicalTarget = await canonicalizeNearest(target);
    const rel = path.relative(context.projectRoot, canonicalTarget);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`Context target escapes the project: ${relative}`);
    }
    if (relative === ".claude/CLAUDE.md") {
      await mergeClaudeBlock(canonicalTarget, record.content);
    } else {
      await atomicWriteText(canonicalTarget, record.content, { mode: 0o600 });
    }
  }
  const fingerprint = await createFingerprint({
    projectRoot: context.projectRoot,
    stage: "onboardingFingerprint",
  });
  const oldFingerprint = await context.authority.readSigned(
    "fingerprints/onboardingFingerprint.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "fingerprints/onboardingFingerprint.json",
    fingerprint,
    { expectedDigest: oldFingerprint?.digest ?? null },
  );
  const next = await commitTransition(context.authority, active.state, "PROJECT_READY", {
    reason: "Committed exact approved context bundle",
    patch: {
      contextDigest: proposal.payload.contextDigest,
      fingerprints: {
        ...active.state.fingerprints,
        onboardingFingerprint: fingerprint.digest,
      },
      nextLegalAction: "Begin one-task-at-a-time discovery",
    },
  });
  await context.authority.appendEvent("context-committed", {
    contextDigest: proposal.payload.contextDigest,
    proposalDigest: proposal.payload.digest,
    fingerprintDigest: fingerprint.digest,
  });
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Committed approved context",
  );
  return {
    phase: next.phase,
    contextDigest: next.contextDigest,
    projectFingerprintDigest: fingerprint.digest,
  };
}

async function beginTask(context, active, taskId) {
  if (!["PROJECT_READY", "VERIFIED"].includes(active.state.phase)) {
    throw new Error("A task may begin only from PROJECT_READY or VERIFIED");
  }
  let onboardingFingerprint;
  try {
    onboardingFingerprint = await currentStoredFingerprint(
      context,
      "fingerprints/onboardingFingerprint.json",
    );
  } catch (error) {
    await transitionStale(
      context,
      active.state,
      `Task start invalidated by project drift: ${error.message}`,
    );
    throw error;
  }
  const packageSnapshot = await writePackageSnapshot(
    context.authority,
    "packages/task-baseline.json",
    await computePackageSnapshot({
      projectRoot: context.projectRoot,
      env: context.env,
    }),
  );
  const next = await commitTransition(context.authority, active.state, "TASK_DISCOVERY", {
    reason: `Started bounded task ${taskId}`,
    patch: {
      taskId,
      approvedDigests: {},
      completedWork: [],
      remainingWork: [],
      evidencePaths: [],
      blocker: null,
      packageSnapshotDigest: packageSnapshot.digest,
      nextLegalAction: "Complete task discovery and stage an exact plan",
    },
  });
  await mirrorProjectState(context.projectRoot, next, "Started task discovery");
  return {
    phase: next.phase,
    taskId,
    contextDigest: next.contextDigest,
    projectFingerprintDigest: onboardingFingerprint.digest,
    packageSnapshotDigest: packageSnapshot.digest,
  };
}

async function startImplementation(context, active) {
  if (active.state.phase !== "PLAN_APPROVED") {
    throw new Error("Implementation start requires PLAN_APPROVED");
  }
  const plan = await context.authority.readSigned("artifacts/plan.json");
  const review = await context.authority.readSigned("artifacts/plan-review.json");
  if (
    !safeEqualHex(review.payload.artifactDigest, plan.payload.digest) ||
    active.state.approvedDigests?.plan !== review.payload.digest
  ) {
    throw new Error("Signed state does not contain the exact plan approval");
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "plan",
    approvedDigest: review.payload.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) throw new Error("Current lease lacks exact plan approval");
  try {
    await currentStoredFingerprint(
      context,
      "fingerprints/onboardingFingerprint.json",
    );
    const taskPackages = await context.authority.readSigned(
      "packages/task-baseline.json",
    );
    if (
      !safeEqualHex(
        plan.payload.document.packageSnapshotDigest,
        taskPackages.payload.snapshotDigest,
      )
    ) {
      throw new Error("Approved plan package snapshot is stale");
    }
    await assertCurrentPackageSnapshot({
      authority: context.authority,
      relativePath: "packages/task-baseline.json",
      projectRoot: context.projectRoot,
      env: context.env,
      expectedDigest: plan.payload.document.packageSnapshotDigest,
    });
  } catch (error) {
    await transitionStale(
      context,
      active.state,
      `Implementation start invalidated after plan review: ${error.message}`,
    );
    throw error;
  }
  const exclusions = plan.payload.document.generatedOutputs;
  const packageRecord = await context.authority.readSigned(
    "packages/task-baseline.json",
  );
  const taskBaseline = await createFingerprint({
    projectRoot: context.projectRoot,
    stage: "taskBaseline",
    exclusions,
    packageSnapshot: packageRecord.payload.snapshot,
    contextDigest: active.state.contextDigest ?? null,
  });
  for (const fingerprint of [taskBaseline]) {
    const existing = await context.authority.readSigned(
      `fingerprints/${fingerprint.stage}.json`,
      { required: false },
    );
    await context.authority.writeSigned(
      `fingerprints/${fingerprint.stage}.json`,
      fingerprint,
      { expectedDigest: existing?.digest ?? null },
    );
  }
  const next = await commitTransition(context.authority, active.state, "IMPLEMENTING", {
    reason: "Entered exact approved implementation scope",
    patch: {
      fingerprints: {
        ...active.state.fingerprints,
        taskBaseline: taskBaseline.digest,
      },
      nextLegalAction: "Apply only approved path changes",
    },
  });
  await mirrorProjectState(context.projectRoot, next, "Started implementation");
  return { phase: next.phase, taskBaseline: taskBaseline.digest };
}

async function recoverWorkflow(context, active, mode) {
  if (!["exact", "replan"].includes(mode)) {
    throw new Error("recover requires --mode exact or replan");
  }
  if (mode === "replan") {
    if (active.state.phase !== "DIAGNOSING") {
      throw new Error("Material-scope replanning is legal only from DIAGNOSING");
    }
    const next = await commitTransition(
      context.authority,
      active.state,
      "TASK_DISCOVERY",
      {
        reason: "Execution diagnosis requires a materially revised plan",
        patch: {
          approvedDigests: {},
          blocker: null,
          nextLegalAction: "Stage and review a fresh exact task plan",
        },
      },
    );
    await mirrorProjectState(context.projectRoot, next, "Returned to replanning");
    return { mode, phase: next.phase, approvalsInvalidated: true };
  }
  if (!["DIAGNOSING", "BUILD_VERIFIED"].includes(active.state.phase)) {
    throw new Error(
      "Exact-scope repair is legal only after execution or template failure",
    );
  }
  const patch = {
    approvedDigests: Object.fromEntries(
      Object.entries(active.state.approvedDigests ?? {}).filter(
        ([key]) => key === "plan",
      ),
    ),
    fingerprints: Object.fromEntries(
      Object.entries(active.state.fingerprints ?? {}).filter(
        ([key]) => key !== "staticVerificationFingerprint",
      ),
    ),
    blocker: null,
    nextLegalAction:
      "Apply only existing approved plan scope, then rerun build/template verification",
  };
  let next;
  if (active.state.phase === "DIAGNOSING") {
    next = await commitTransition(
      context.authority,
      active.state,
      "REPAIRING",
      {
        reason: "Execution diagnosis is repairable within the existing plan scope",
        patch,
      },
    );
  } else {
    next = await commitTransition(
      context.authority,
      active.state,
      "IMPLEMENTING",
      {
        reason: "Template verification failed and requires exact-scope repair",
        patch,
      },
    );
  }
  await mirrorProjectState(context.projectRoot, next, "Entered exact-scope repair");
  return { mode, phase: next.phase, approvalsInvalidated: true };
}

async function status(context) {
  const state = await context.authority.readSigned("state/current.json");
  const chain = await context.authority.verifyEventChain();
  const fingerprint = currentFingerprintHandle(state.payload);
  return {
    projectId: context.authority.projectId,
    phase: state.payload.phase,
    taskId: state.payload.taskId,
    contextDigest: state.payload.contextDigest ?? null,
    packageSnapshotDigest: state.payload.packageSnapshotDigest ?? null,
    projectFingerprint: fingerprint,
    projectFingerprintDigest: fingerprint?.digest ?? null,
    authorityCapabilities: AUTHORITY_CAPABILITIES,
    hooksAttested: state.payload.hooksAttested,
    eventChainValid: chain.valid,
    nextLegalAction: state.payload.nextLegalAction,
    resumeRequired: true,
  };
}

export async function runWorkflowAuthority(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const args = parseNamedArguments(argv);
  const command = args._[0];
  const context = await runtimeContext(env);
  if (command === "status") return status(context);
  const active = await activeSession(context, args["session-handle"]);
  switch (command) {
    case "encode": {
      const text = args.text;
      if (typeof text !== "string" || text.length === 0) {
        throw new Error("encode requires nonempty --text content");
      }
      assertNoSecrets(text, "encoded helper text");
      if (Buffer.byteLength(text, "utf8") > MAX_ARTIFACT_BYTES) {
        throw new Error("encoded helper text exceeds 1 MiB");
      }
      return {
        contentBase64: Buffer.from(text, "utf8").toString("base64"),
        transportSha256: sha256(text),
        byteLength: Buffer.byteLength(text, "utf8"),
      };
    }
    case "resume":
      return createResumeProjection(context, active);
    case "checkpoint":
      return checkpointProgress(context, active, args);
    case "discover": {
      if (active.state.phase !== "UNONBOARDED") {
        throw new Error("discover is legal only from UNONBOARDED");
      }
      const next = await commitTransition(
        context.authority,
        active.state,
        "DISCOVERING",
        {
          reason: "Started read-only project discovery",
          patch: { nextLegalAction: "Complete readiness and stage context" },
        },
      );
      const packageSnapshot = await writePackageSnapshot(
        context.authority,
        "packages/discovery.json",
        await computePackageSnapshot({
          projectRoot: context.projectRoot,
          env: context.env,
        }),
      );
      await mirrorProjectState(context.projectRoot, next, "Started discovery");
      return {
        phase: next.phase,
        packageSnapshotDigest: packageSnapshot.digest,
      };
    }
    case "prepare-readiness-fact":
      return prepareReadinessFact(context, active, args);
    case "stage-context":
      return stageContextFile(context, active, args);
    case "finalize-context":
      return finalizeContextBundle(context, active);
    case "stage":
      return stageArtifact(context, active, args);
    case "stage-capabilities":
      return stageCapabilities(context, active, args);
    case "prepare":
      if (args.kind === "context") return prepareContext(context, active);
      if (args.kind === "capabilities") {
        return prepareCapabilities(context, active);
      }
      if (args.kind === "source-checkout") {
        return prepareSourceCheckout(context, active);
      }
      if (args.kind === "source-read") {
        return prepareSourceRead(context, active, args);
      }
      if (args.kind === "query") return prepareQuery(context, active);
      if (["plan", "execution", "mutation"].includes(args.kind)) {
        return preparePlanLike(context, active, args.kind);
      }
      throw new Error("prepare kind is unsupported");
    case "commit-context":
      return commitContext(context, active);
    case "commit-capabilities":
      return commitCapabilities(context, active);
    case "begin-task":
      return beginTask(context, active, safeTaskId(args["task-id"]));
    case "start-implementation":
      return startImplementation(context, active);
    case "recover":
      return recoverWorkflow(context, active, args.mode);
    default:
      throw new Error("Unknown workflow-authority command");
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const directArguments = process.argv.slice(2);
    printJson(await runWorkflowAuthority(directArguments, process.env));
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
