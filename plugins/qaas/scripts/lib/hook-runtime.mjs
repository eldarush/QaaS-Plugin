import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { safeEqualHex, sha256 } from "./canonical-json.mjs";
import {
  findApprovalChallenge,
  findApprovalByDigest,
  isProtectedAuthorityPathCanonical,
  issuePreauthorization,
  openAuthority,
  registerApprovalQuestion,
  reservePreauthorization,
  toolInputDigest,
} from "./approval-authority.mjs";
import {
  compareFingerprints,
  createFingerprint,
  verifyFingerprint,
} from "./fingerprint.mjs";
import {
  attestDocumentationSourceConfiguration,
  QAAS_DOCS_CONFIGURATION_NAMES,
} from "./docs-resolver.mjs";
import {
  attestConfiguredSourceConfiguration,
} from "./source-read-adapter.mjs";
import {
  computePackageSnapshot,
  resolveProjectPackageSource,
} from "./package-snapshot.mjs";
import { analyzeMcpTool } from "./mcp-analyzer.mjs";
import {
  actionNeedsApproval,
  evaluatePhaseGate,
  requiredFingerprintStage,
} from "./phase-gate.mjs";
import {
  isCredentialBearingPath,
  secretFindings,
} from "./redact.mjs";
import { isKnownAutoMemoryPath } from "./safe-memory.mjs";
import {
  analyzeShellCommand,
  tokenizeSimpleCommand,
} from "./shell-analyzer.mjs";
import {
  canTransition,
  commitCheckpoint,
  commitTransition,
  recoverStateTransaction,
} from "./state.mjs";
import { synchronizeLease } from "./lease.mjs";
import {
  computeHookSettingsInventory,
  computeRuntimeBundle,
} from "./runtime-attestation.mjs";
import { destructiveAuthoredContentFindings } from "./authored-safety.mjs";

const SAFE_COORDINATOR_TOOLS = new Set([
  "Agent",
  "Task",
  "TaskCreate",
  "TaskUpdate",
  "TodoWrite",
  "Skill",
  "ToolSearch",
  "AskUserQuestion",
  "ExitPlanMode",
]);

const READ_TOOLS = new Set(["Read", "Glob", "Grep"]);
const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit"]);
const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell"]);
const SESSION_HANDLE_HELPERS = new Set([
  "workflow-authority.mjs",
  "run-approved.mjs",
  "docs-read.mjs",
  "source-read.mjs",
  "source-checkout.mjs",
  "query-approved.mjs",
]);

function normalize(value) {
  const resolved = path.resolve(value);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isInside(root, target) {
  const normalizedRoot = normalize(root);
  const normalizedTarget = normalize(target);
  return (
    normalizedTarget === normalizedRoot ||
    normalizedTarget.startsWith(`${normalizedRoot}${path.sep}`)
  );
}

async function canonicalizeNearest(target) {
  const absolute = path.resolve(target);
  const suffix = [];
  let cursor = absolute;
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

export function hookEnvironment(event, overrides = {}) {
  const env = overrides.env ?? process.env;
  const projectRoot = path.resolve(
    overrides.projectRoot ??
      env.CLAUDE_PROJECT_DIR ??
      event.cwd ??
      process.cwd(),
  );
  const pluginRoot = path.resolve(
    overrides.pluginRoot ??
      env.CLAUDE_PLUGIN_ROOT ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", ".."),
  );
  return {
    env,
    projectRoot,
    pluginRoot,
    pluginData: overrides.pluginData ?? env.CLAUDE_PLUGIN_DATA ?? null,
    pluginVersion: overrides.pluginVersion ?? "0.2.0",
  };
}

export function preToolDecision(
  decision,
  reason,
  additionalContext = null,
  updatedInput = null,
) {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
      ...(additionalContext ? { additionalContext } : {}),
      ...(updatedInput ? { updatedInput } : {}),
    },
  };
}

export function denyPreTool(reason) {
  return preToolDecision("deny", reason);
}

export function allowPreTool(reason, updatedInput = null) {
  return preToolDecision("allow", reason, null, updatedInput);
}

function candidatePaths(toolInput = {}) {
  const keys = [
    "file_path",
    "path",
    "notebook_path",
    "directory",
    "cwd",
    "workdir",
  ];
  return keys
    .filter((key) => typeof toolInput[key] === "string")
    .map((key) => ({ key, value: toolInput[key] }));
}

function validateNativePattern(pattern, label) {
  if (pattern === undefined) return;
  if (typeof pattern !== "string" || pattern.includes("\0")) {
    throw new Error(`${label} is invalid`);
  }
  const normalized = pattern.replaceAll("\\", "/");
  const prefix = normalized.split(/[*?[\]]/u, 1)[0];
  if (
    path.posix.isAbsolute(normalized) ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").some((segment) => segment === "..")
  ) {
    throw new Error(`${label} escapes the project`);
  }
  return prefix;
}

function assertNoDestructiveAuthoredContent(content, relativePath) {
  if (typeof content !== "string" || content.length === 0) return;
  const analysis = analyzeShellCommand(content);
  const sourceFindings = destructiveAuthoredContentFindings(
    content,
    relativePath,
  );
  if (!analysis.destructive && sourceFindings.length === 0) return;
  const isDocumentation = /\.(?:md|mdx|txt|rst)$/iu.test(relativePath);
  if (isDocumentation) {
    const unsafeLines = content
      .split(/\r?\n/u)
      .filter(
        (line) =>
          analyzeShellCommand(line).destructive ||
          destructiveAuthoredContentFindings(line, relativePath).length > 0,
      )
      .filter(
        (line) =>
          !/\bmanual user action\b/iu.test(line) ||
          !/\bnot executed by qaas\b/iu.test(line),
      );
    if (unsafeLines.length === 0) return;
  }
  throw new Error(
    `Authored content contains a high-confidence destructive operation: ${[
      ...analysis.reasons,
      ...sourceFindings.map((entry) => entry.reason),
    ].join(", ")}`,
  );
}

async function validateProjectPath(
  candidate,
  context,
  { write = false, allowOmitted = false } = {},
) {
  if (!candidate && allowOmitted) return { path: context.projectRoot };
  if (typeof candidate !== "string" || candidate.includes("\0")) {
    throw new Error("Tool path is invalid");
  }
  if (/[*?[\]]/u.test(candidate)) {
    throw new Error("Tool base paths may not contain wildcard aliases");
  }
  const withoutRoot = candidate.slice(path.parse(candidate).root.length);
  const lexicalSegments = withoutRoot.split(/[\\/]+/u).filter(Boolean);
  if (
    lexicalSegments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        segment.includes(":") ||
        /[ .]$/u.test(segment) ||
        /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    )
  ) {
    throw new Error(
      "Tool path contains traversal, alternate-stream, trailing-dot/space, or reserved-device syntax",
    );
  }
  const absolute = path.isAbsolute(candidate)
    ? path.resolve(candidate)
    : path.resolve(context.projectRoot, candidate);
  const canonical = await canonicalizeNearest(absolute);
  const canonicalRoot = await canonicalizeNearest(context.projectRoot);
  if (!isInside(canonicalRoot, canonical)) {
    throw new Error("Tool path escapes the current project");
  }
  if (
    await isProtectedAuthorityPathCanonical(canonical, {
      pluginData: context.pluginData,
      projectRoot: canonicalRoot,
    })
  ) {
    throw new Error("Protected QaaS authority/state path is unavailable to model tools");
  }
  const slash = canonical.replaceAll("\\", "/").toLowerCase();
  const relativeSlash = path
    .relative(canonicalRoot, canonical)
    .replaceAll("\\", "/")
    .toLowerCase();
  if (write && (relativeSlash === ".git" || relativeSlash.startsWith(".git/"))) {
    throw new Error("Writes to Git metadata are denied");
  }
  if (
    write &&
    (slash.includes("/.claude/settings.json") ||
      slash.includes("/.claude/settings.local.json") ||
      slash.includes("/hooks/hooks.json"))
  ) {
    throw new Error("Safety hook configuration is protected");
  }
  if (write && isKnownAutoMemoryPath(canonical, context.env.USERPROFILE ?? context.env.HOME)) {
    throw new Error("Direct model writes to automatic memory are denied");
  }
  return { path: canonical, projectRoot: canonicalRoot };
}

function parseMcpToolName(toolName) {
  if (!toolName.startsWith("mcp__")) return null;
  const body = toolName.slice("mcp__".length);
  const separator = body.indexOf("__");
  if (separator < 1 || separator === body.length - 2) return null;
  return {
    server: body.slice(0, separator),
    tool: body.slice(separator + 2),
  };
}

const LOCAL_ENCODER_TOOL_NAME = "mcp__qaas_local__encode_text";
const LOCAL_ENCODER_MAX_BYTES = 32 * 1024;

function classifyLocalEncoder(toolName, input) {
  if (toolName !== LOCAL_ENCODER_TOOL_NAME) return null;
  if (
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype ||
    Object.keys(input).length !== 1 ||
    !Object.hasOwn(input, "text") ||
    typeof input.text !== "string"
  ) {
    throw new Error(
      "Local encoder requires exactly one string field named text",
    );
  }
  if (Buffer.byteLength(input.text, "utf8") > LOCAL_ENCODER_MAX_BYTES) {
    throw new Error("Local encoder input exceeds 32 KiB");
  }
  if (secretFindings(input.text).length > 0) {
    throw new Error("Local encoder input contains credential-like data");
  }
  return {
    actionClass: "ordinary-read",
    helper: "qaas-local-encode-text",
  };
}

const READ_ONLY_HELPERS = new Set([
  "doctor.mjs",
  "validate-readiness.mjs",
  "validate-plan.mjs",
  "validate-execution-plan.mjs",
  "validate-mutation-plan.mjs",
  "validate-plugin.mjs",
  "check-context-budget.mjs",
  "docs-read.mjs",
  "source-read.mjs",
  "source-checkout.mjs",
  "workflow-authority.mjs",
  "run-approved.mjs",
  "query-approved.mjs",
]);

function quoteProcessArgument(value) {
  if (process.platform === "win32") {
    return `"${String(value).replaceAll('"', '\\"')}"`;
  }
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function helperNamedArgument(args, name) {
  const flag = `--${name}`;
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    const token = args[index];
    if (token === flag) {
      const value = args[index + 1];
      if (typeof value !== "string" || value.startsWith("--")) {
        throw new Error(`${flag} requires one value`);
      }
      values.push(value);
      index += 1;
    } else if (token.startsWith(`${flag}=`)) {
      values.push(token.slice(flag.length + 1));
    }
  }
  if (values.length > 1) {
    throw new Error(`${flag} may be specified only once`);
  }
  return values[0] ?? null;
}

async function classifyPluginHelper(command, input, context) {
  const tokenized = tokenizeSimpleCommand(command);
  if (!tokenized.ok || tokenized.tokens.length < 2) return null;
  const [nodeToken, scriptToken, ...args] = tokenized.tokens;
  if (nodeToken.toLowerCase() !== "node") return null;
  const normalizedScript = scriptToken.replaceAll("\\", "/");
  const placeholderPrefix = "${CLAUDE_PLUGIN_ROOT}/scripts/";
  if (!normalizedScript.startsWith(placeholderPrefix)) return null;
  const helper = normalizedScript.slice(placeholderPrefix.length);
  if (!READ_ONLY_HELPERS.has(helper) || helper.includes("/")) return null;
  for (const arg of args) {
    if (/[$`<>;|*[\]~\r\n\0]/u.test(arg)) {
      throw new Error("Plugin helper argument contains shell syntax");
    }
  }
  const validatorHelpers = new Set([
    "validate-readiness.mjs",
    "validate-plan.mjs",
    "validate-execution-plan.mjs",
    "validate-mutation-plan.mjs",
  ]);
  if (validatorHelpers.has(helper)) {
    const positional = args.find((arg) => !arg.startsWith("--"));
    if (positional) await validateProjectPath(positional, context);
  }
  const absoluteScript = path.join(context.pluginRoot, "scripts", helper);
  const rewritten = [
    quoteProcessArgument(process.execPath),
    quoteProcessArgument(absoluteScript),
    ...args.map(quoteProcessArgument),
  ].join(" ");
  const configuredSource = ["docs-read.mjs", "source-read.mjs"].includes(
    helper,
  );
  const source =
    helperNamedArgument(args, "source") ??
    (helper === "docs-read.mjs" ? "qaas-docs" : null);
  const sourceConfigurationNames = {
    gitlab: [],
    artifactory: [],
    nuget: [],
    modules: [],
    "common-hooks": [],
    "qaas-docs": [...QAAS_DOCS_CONFIGURATION_NAMES],
  };
  const documentationConfiguration =
    source === "qaas-docs"
      ? await attestDocumentationSourceConfiguration(context.env)
      : null;
  const reviewedBaseUrl = helperNamedArgument(args, "base-url");
  let projectBaseUrl = reviewedBaseUrl;
  const credentialEnv = helperNamedArgument(args, "credential-env");
  if (source === "nuget") {
    if (reviewedBaseUrl !== null) {
      throw new Error(
        "NuGet base URLs must come from current project package metadata",
      );
    }
    const packageSnapshot = await computePackageSnapshot({
      projectRoot: context.projectRoot,
      env: context.env,
    });
    projectBaseUrl = resolveProjectPackageSource(
      packageSnapshot,
      helperNamedArgument(args, "package-source"),
    ).url;
  }
  const configuredHttpSources = new Set([
    "gitlab",
    "artifactory",
    "nuget",
    "modules",
    "common-hooks",
  ]);
  const endpointConfiguration =
    source && configuredHttpSources.has(source)
      ? attestConfiguredSourceConfiguration({
          source,
          env: context.env,
          projectBaseUrl,
          credentialEnv,
          allowLegacyEnvironment: false,
        })
      : null;
  const configurationNames =
    endpointConfiguration?.configurationNames ??
    sourceConfigurationNames[source] ??
    [];
  const configurationDigest =
    documentationConfiguration?.digest ??
    sha256(
      Object.fromEntries(
        configurationNames.map((name) => [
          name,
          Object.hasOwn(context.env, name)
            ? sha256(String(context.env[name]))
            : null,
        ]),
      ),
    );
  return {
    actionClass:
      helper === "query-approved.mjs"
        ? "observability-query"
        : configuredSource
          ? "configured-source-read"
          : "ordinary-read",
    helper,
    ...(configuredSource
      ? {
          sourceProvenance: {
            category: "docs",
            source,
            locatorDigest: sha256({
              helper,
              args,
              configurationDigest,
              endpointDigest:
                endpointConfiguration?.endpointDigest ??
                documentationConfiguration?.builtInEndpointDigests?.docs ??
                null,
            }),
            configurationNames,
            configurationDigest,
            reviewedInputDigest: endpointConfiguration
              ? sha256({
                  baseUrl: projectBaseUrl,
                  credentialEnv,
                  packageSource: helperNamedArgument(
                    args,
                    "package-source",
                  ),
                })
              : null,
            ...(documentationConfiguration
              ? { documentationConfiguration }
              : {}),
            ...(endpointConfiguration
              ? { endpointConfiguration }
              : {}),
            immutableLocator: true,
          },
        }
      : {}),
    updatedInput: {
      ...input,
      command: rewritten,
    },
  };
}

async function loadCapabilityRegistry(authority) {
  const record = await authority.readSigned("integrations/capabilities.json", {
    required: false,
  });
  return record?.payload ?? null;
}

async function assertSessionHandleIsScoped(
  event,
  authority,
  serializedInput,
) {
  if (!authority) return;
  const attestation = await authority.readSigned("attestations/hooks.json", {
    required: false,
  });
  if (
    !attestation ||
    attestation.payload.sessionId !== event.session_id ||
    typeof attestation.payload.sessionHandleDigest !== "string"
  ) {
    return;
  }
  const handleDigest = attestation.payload.sessionHandleDigest;
  const rawCandidates = [
    ...new Set(serializedInput.match(/\b[a-f0-9]{48}\b/gu) ?? []),
  ].filter((candidate) =>
    safeEqualHex(sha256(candidate), handleDigest),
  );
  const reversedCandidates = [
    ...new Set(serializedInput.match(/\b[a-f0-9]{48}\b/gu) ?? []),
  ].filter((candidate) =>
    safeEqualHex(sha256([...candidate].reverse().join("")), handleDigest),
  );
  const encodedCandidates = [
    ...new Set(
      serializedInput.match(
        /\b[A-Za-z0-9+/_-]{64}(?:={0,2})?\b/gu,
      ) ?? [],
    ),
  ].filter((candidate) => {
    try {
      const decoded = Buffer.from(candidate, "base64url").toString("utf8");
      return (
        /^[a-f0-9]{48}$/u.test(decoded) &&
        safeEqualHex(sha256(decoded), handleDigest)
      );
    } catch {
      return false;
    }
  });
  const strings = [];
  const joinedStrings = [];
  const collectStrings = (value) => {
    if (strings.length > 512) return;
    if (typeof value === "string") {
      strings.push(value.slice(0, 128 * 1024));
      return;
    }
    if (Array.isArray(value)) {
      if (value.length <= 64 && value.every((entry) => typeof entry === "string")) {
        joinedStrings.push(value.join(""));
      }
      value.forEach(collectStrings);
      return;
    }
    if (value && typeof value === "object") {
      const values = Object.values(value);
      if (
        values.length <= 64 &&
        values.length > 1 &&
        values.every((entry) => typeof entry === "string")
      ) {
        joinedStrings.push(values.join(""));
      }
      values.forEach(collectStrings);
    }
  };
  collectStrings(event.tool_input);
  const transformedValues = new Set(joinedStrings);
  for (const value of strings) {
    try {
      transformedValues.add(decodeURIComponent(value));
    } catch {
      // Invalid percent encoding is not a useful handle transform.
    }
    try {
      const url = new URL(value, "https://qaas.invalid/");
      if ([...url.searchParams.values()].length > 1) {
        transformedValues.add([...url.searchParams.values()].join(""));
      }
    } catch {
      // Non-URL strings are evaluated through the other bounded transforms.
    }
  }
  const fragmentedCandidates = [...transformedValues].filter((candidate) => {
    if (!/^[a-f0-9]{48}$/u.test(candidate)) return false;
    return (
      safeEqualHex(sha256(candidate), handleDigest) ||
      safeEqualHex(sha256([...candidate].reverse().join("")), handleDigest)
    );
  });
  if (
    rawCandidates.length === 0 &&
    reversedCandidates.length === 0 &&
    encodedCandidates.length === 0 &&
    fragmentedCandidates.length === 0
  ) {
    return;
  }
  if (
    rawCandidates.length !== 1 ||
    reversedCandidates.length > 0 ||
    encodedCandidates.length > 0 ||
    fragmentedCandidates.length > 0 ||
    !SHELL_TOOLS.has(event.tool_name)
  ) {
    throw new Error(
      "The session handle is a protected bearer capability and may appear only in one exact QaaS helper argument",
    );
  }
  const tokenized = tokenizeSimpleCommand(event.tool_input.command);
  if (!tokenized.ok || tokenized.tokens.length < 4) {
    throw new Error("Session-handle helper invocation is malformed");
  }
  const script = tokenized.tokens[1].replaceAll("\\", "/");
  const prefix = "${CLAUDE_PLUGIN_ROOT}/scripts/";
  const helper = script.startsWith(prefix) ? script.slice(prefix.length) : "";
  const handleIndexes = tokenized.tokens
    .map((token, index) => (token === rawCandidates[0] ? index : -1))
    .filter((index) => index >= 0);
  if (
    tokenized.tokens[0].toLowerCase() !== "node" ||
    !SESSION_HANDLE_HELPERS.has(helper) ||
    handleIndexes.length !== 1 ||
    handleIndexes[0] < 1 ||
    tokenized.tokens[handleIndexes[0] - 1] !== "--session-handle"
  ) {
    throw new Error(
      "Session handle use is outside the exact --session-handle QaaS helper field",
    );
  }
}

async function classifyAskUserQuestion(event, authority) {
  if (
    Object.keys(event.tool_input).length !== 1 ||
    !Object.hasOwn(event.tool_input, "questions")
  ) {
    throw new Error("AskUserQuestion approval input may contain only questions");
  }
  const questions = event.tool_input?.questions;
  if (!Array.isArray(questions) || questions.length !== 1) {
    throw new Error(
      "Active QaaS workflows permit exactly one AskUserQuestion question per tool call",
    );
  }
  const question = questions[0];
  const prompt = question?.question;
  const questionId = question?.header;
  if (typeof prompt !== "string" || typeof questionId !== "string") {
    return {
      actionClass: "ordinary-read",
      approvalQuestion: null,
    };
  }
  if (!authority) {
    return {
      actionClass: "ordinary-read",
      approvalQuestion: null,
    };
  }
  const challenge = await findApprovalChallenge(authority, {
    sessionId: event.session_id,
    question,
  });
  if (!challenge) {
    return {
      actionClass: "ordinary-read",
      approvalQuestion: null,
    };
  }
  await registerApprovalQuestion(authority, challenge.challengeId, {
    sessionId: event.session_id,
    toolUseId: event.tool_use_id,
    question,
  });
  return {
    actionClass: "ordinary-read",
    approvalQuestion: challenge.challengeId,
  };
}

export async function classifyToolCall(event, context, authority = null) {
  if (
    !event ||
    event.hook_event_name !== "PreToolUse" ||
    typeof event.tool_name !== "string" ||
    !event.tool_input ||
    typeof event.tool_input !== "object" ||
    typeof event.tool_use_id !== "string"
  ) {
    throw new Error("Malformed PreToolUse event");
  }
  const toolName = event.tool_name;
  const input = event.tool_input;
  const serialized = JSON.stringify(input);
  await assertSessionHandleIsScoped(event, authority, serialized);
  let registeredQuestion = null;
  if (toolName === "AskUserQuestion") {
    registeredQuestion = await classifyAskUserQuestion(event, authority);
    if (registeredQuestion.approvalQuestion) {
      return registeredQuestion;
    }
  }
  const comparableInput = serialized
    .replaceAll("\\\\", "/")
    .replaceAll("\\", "/")
    .toLowerCase();
  const comparablePluginData = context.pluginData
    ?.replaceAll("\\", "/")
    .toLowerCase();
  if (
    context.pluginData &&
    (comparableInput.includes(comparablePluginData) ||
      /(?:claude_plugin_data|\$env:claude_plugin_data|%claude_plugin_data%)/iu.test(
        serialized,
      ))
  ) {
    throw new Error("Tool input references protected plugin authority data");
  }
  if (READ_TOOLS.has(toolName)) {
    const paths = candidatePaths(input);
    if (paths.length === 0) {
      await validateProjectPath(context.projectRoot, context);
    }
    for (const candidate of paths) {
      const checked = await validateProjectPath(candidate.value, context);
      if (
        toolName === "Read" &&
        isCredentialBearingPath(checked.path)
      ) {
        throw new Error(
          "Potentially credential-bearing files require a redacting wrapper",
        );
      }
    }
    if (toolName === "Glob") {
      const prefix = validateNativePattern(input.pattern, "Glob pattern");
      if (prefix) await validateProjectPath(prefix, context);
    }
    if (toolName === "Grep") {
      validateNativePattern(input.glob, "Grep glob");
      validateNativePattern(input.include, "Grep include");
      validateNativePattern(input.exclude, "Grep exclude");
      const grepPath = paths.find((entry) => entry.key === "path")?.value;
      if (!grepPath) {
        throw new Error(
          "Native Grep must target one exact pre-screened file; use the redacting search wrapper for directories",
        );
      }
      const checked = await validateProjectPath(grepPath, context);
      const info = await stat(checked.path);
      if (!info.isFile() || info.size > 2 * 1024 * 1024) {
        throw new Error(
          "Native Grep target must be one file no larger than 2 MiB",
        );
      }
      const content = await readFile(checked.path, "utf8");
      if (secretFindings(content).length > 0) {
        throw new Error("Grep target contains credential-like data; use the redacting search wrapper");
      }
    }
    if (toolName === "Read") {
      const readPath = paths[0]?.value;
      if (!readPath) throw new Error("Read requires one exact file path");
      const checked = await validateProjectPath(readPath, context);
      let content;
      try {
        const info = await stat(checked.path);
        if (!info.isFile() || info.size > 2 * 1024 * 1024) {
          throw new Error("Native Read is limited to one file no larger than 2 MiB");
        }
        content = await readFile(checked.path, "utf8");
      } catch (error) {
        if (error?.code !== "EISDIR") throw error;
      }
      if (content !== undefined && secretFindings(content).length > 0) {
        throw new Error("File content contains credential-like data; use a redacting wrapper");
      }
    }
    const readProofs = [];
    if (["Read", "Grep"].includes(toolName)) {
      for (const candidate of paths) {
        const checked = await validateProjectPath(candidate.value, context);
        const info = await stat(checked.path);
        if (!info.isFile()) continue;
        const bytes = await readFile(checked.path);
        readProofs.push({
          path: path
            .relative(checked.projectRoot, checked.path)
            .replaceAll("\\", "/"),
          size: bytes.byteLength,
          sha256: sha256(bytes),
        });
      }
    }
    return {
      actionClass: "ordinary-read",
      paths,
      ...(readProofs.length > 0
        ? {
            sourceProvenance: {
              category: "project",
              locators: readProofs.map((entry) => entry.path),
              locatorDigest: sha256(readProofs),
              readProofs,
              immutableLocator: true,
            },
          }
        : {}),
    };
  }
  if (WRITE_TOOLS.has(toolName)) {
    const paths = candidatePaths(input);
    if (paths.length !== 1) throw new Error(`${toolName} requires one exact project path`);
    const checked = await validateProjectPath(paths[0].value, context, {
      write: true,
    });
    if (toolName === "NotebookEdit" && input.edit_mode === "delete") {
      throw new Error("Notebook cell deletion is denied");
    }
    if (
      (toolName === "Write" &&
        (typeof input.content !== "string" || input.content.length === 0)) ||
      (toolName === "NotebookEdit" &&
        typeof input.cell_source === "string" &&
        input.cell_source.length === 0)
    ) {
      throw new Error("Clearing or truncating project content is denied");
    }
    if (
      toolName === "Edit" &&
      typeof input.new_string === "string" &&
      input.new_string.length === 0
    ) {
      if (typeof input.old_string !== "string" || input.old_string.length === 0) {
        throw new Error("Empty edit replacement is malformed");
      }
      const existing = await readFile(checked.path, "utf8");
      const next = input.replace_all
        ? existing.split(input.old_string).join("")
        : existing.replace(input.old_string, "");
      if (next.length === 0) {
        throw new Error("Edit would clear or truncate the complete file");
      }
    }
    for (const field of ["content", "new_string", "cell_source"]) {
      if (
        typeof input[field] === "string" &&
        secretFindings(input[field]).length > 0
      ) {
        throw new Error("Project writes may not persist credential-like content");
      }
    }
    const relative = path
      .relative(checked.projectRoot, checked.path)
      .replaceAll("\\", "/");
    if (
      toolName === "Edit" &&
      typeof input.old_string === "string" &&
      input.old_string.length > 0
    ) {
      const existing = await readFile(checked.path, "utf8");
      if (
        input.old_string === existing &&
        relative.toLowerCase() !== ".claude/claude.md"
      ) {
        throw new Error(
          "Whole-file replacement through Edit is denied; apply a bounded minimal diff",
        );
      }
    }
    for (const field of ["content", "new_string", "cell_source"]) {
      assertNoDestructiveAuthoredContent(input[field], relative);
    }
    if (relative.toLowerCase() === ".claude/claude.md") {
      const markerBlock =
        /^<!-- QAAS:START -->[\s\S]*<!-- QAAS:END -->$/u;
      if (toolName === "Write") {
        try {
          await stat(checked.path);
          throw new Error(
            "Existing .claude/CLAUDE.md may not be replaced; edit only its QaaS marker block",
          );
        } catch (error) {
          if (error?.code !== "ENOENT") throw error;
        }
        if (!markerBlock.test(input.content)) {
          throw new Error(
            "New .claude/CLAUDE.md must contain only one complete QaaS marker block",
          );
        }
      } else if (
        toolName !== "Edit" ||
        !markerBlock.test(input.old_string ?? "") ||
        !markerBlock.test(input.new_string ?? "")
      ) {
        throw new Error(
          "Existing .claude/CLAUDE.md edits must replace only the complete QaaS marker block",
        );
      }
    }
    if (
      relative.startsWith(".claude/") &&
      relative !== ".claude/CLAUDE.md" &&
      !relative.startsWith(".claude/qaas/")
    ) {
      throw new Error(
        "QaaS project context writes are limited to .claude/CLAUDE.md and .claude/qaas/**",
      );
    }
    return {
      actionClass: relative === ".claude" || relative.startsWith(".claude/")
        ? "context-write"
        : "project-write",
      paths: [{ value: checked.path }],
    };
  }
  if (SHELL_TOOLS.has(toolName)) {
    const command = input.command;
    const analysis = analyzeShellCommand(command);
    if (analysis.destructive) {
      throw new Error(
        `Shell request is destructive: ${analysis.reasons.join(", ")}`,
      );
    }
    const helper = await classifyPluginHelper(command, input, context);
    if (helper) return helper;
    if (analysis.opaque) {
      throw new Error(
        `Shell request is opaque: ${analysis.reasons.join(", ")}`,
      );
    }
    throw new Error(
      "Direct shell execution is denied; use an exact hash-attested QaaS helper/process wrapper",
    );
  }
  const mcp = parseMcpToolName(toolName);
  if (mcp) {
    const localEncoder = classifyLocalEncoder(toolName, input);
    if (localEncoder) return localEncoder;
    if (!authority) throw new Error("MCP use requires protected capability authority");
    const registry = await loadCapabilityRegistry(authority);
    const analysis = analyzeMcpTool(
      { server: mcp.server, tool: mcp.tool, input },
      registry,
    );
    if (analysis.destructive || analysis.opaque) {
      throw new Error(`MCP request denied: ${analysis.reasons.join(", ")}`);
    }
    throw new Error(
      "Direct MCP calls are disabled in v0.1 because Claude Code cannot enforce a pre-model response byte/item bound; use a bounded QaaS adapter",
    );
  }
  if (toolName === "AskUserQuestion") {
    return registeredQuestion;
  }
  if (SAFE_COORDINATOR_TOOLS.has(toolName)) {
    return { actionClass: "ordinary-read" };
  }
  throw new Error(`Unrecognized tool is denied by the QaaS safety hook: ${toolName}`);
}

function approvalDigestFor(state, actionClass) {
  const key =
    actionClass === "context-write"
      ? "context"
      : actionClass === "test-run"
        ? "execution"
        : actionClass === "observability-query"
          ? "query"
        : actionClass === "infrastructure-mutation"
          ? "mutation"
          : "plan";
  return (
    state.approvedDigests?.[key] ??
    state.approvedDigests?.[`${key}Digest`] ??
    null
  );
}

async function preauthorizationScope(authority, actionClass, approvalDigest) {
  if (["project-write", "restore", "build", "template", "source-checkout-write"].includes(
    actionClass,
  )) {
    const plan = await authority.readSigned("artifacts/plan.json");
    const review = await authority.readSigned("artifacts/plan-review.json");
    if (
      !safeEqualHex(review.payload.artifactDigest, plan.payload.digest) ||
      !safeEqualHex(review.payload.digest, approvalDigest)
    ) {
      throw new Error("Approved implementation plan artifact is stale");
    }
    return {
      allowedPaths: [
        ...(plan.payload.document.paths?.create ?? []),
        ...(plan.payload.document.paths?.modify ?? []),
      ],
      createPaths: plan.payload.document.paths?.create ?? [],
      modifyPaths: plan.payload.document.paths?.modify ?? [],
      generatedOutputs: plan.payload.document.generatedOutputs ?? [],
      planId: plan.payload.document.planId,
    };
  }
  if (actionClass === "test-run") {
    const execution = await authority.readSigned("artifacts/execution.json");
    const review = await authority.readSigned("artifacts/execution-review.json");
    if (
      !safeEqualHex(review.payload.artifactDigest, execution.payload.digest) ||
      !safeEqualHex(review.payload.digest, approvalDigest)
    ) {
      throw new Error("Approved execution plan artifact is stale");
    }
    return {
      outputPaths: execution.payload.document.outputPaths ?? [],
      executionId: execution.payload.document.executionId,
    };
  }
  if (actionClass === "observability-query") {
    const query = await authority.readSigned("artifacts/query.json");
    const review = await authority.readSigned("artifacts/query-review.json");
    if (
      !safeEqualHex(review.payload.artifactDigest, query.payload.digest) ||
      !safeEqualHex(review.payload.digest, approvalDigest)
    ) {
      throw new Error("Approved query plan artifact is stale");
    }
    return {
      queryPlanId: query.payload.document.queryPlanId,
      queryDigests: query.payload.document.queries.map(
        (entry) => entry.queryDigest,
      ),
      toolInputDigests: query.payload.document.queries.map(
        (entry) => entry.toolInputDigest,
      ),
    };
  }
  if (actionClass === "infrastructure-mutation") {
    const mutation = await authority.readSigned("artifacts/mutation.json");
    const review = await authority.readSigned("artifacts/mutation-review.json");
    if (
      !safeEqualHex(review.payload.artifactDigest, mutation.payload.digest) ||
      !safeEqualHex(review.payload.digest, approvalDigest)
    ) {
      throw new Error("Approved mutation plan artifact is stale");
    }
    return { mutationId: mutation.payload.document.mutationId };
  }
  throw new Error(`No deterministic preauthorization scope for ${actionClass}`);
}

async function hooksAttested(authority, event, context) {
  const record = await authority.readSigned("attestations/hooks.json", {
    required: false,
  });
  if (!record) return false;
  let runtimeBundle;
  let settings;
  try {
    runtimeBundle = await computeRuntimeBundle({
      pluginRoot: context.pluginRoot,
      pluginVersion: context.pluginVersion,
    });
    settings = await computeHookSettingsInventory({
      projectRoot: context.projectRoot,
      userHome: context.env.USERPROFILE ?? context.env.HOME ?? null,
    });
  } catch {
    return false;
  }
  return (
    record.payload.sessionId === event.session_id &&
    record.payload.projectId === authority.projectId &&
    record.payload.pluginVersion === context.pluginVersion &&
    record.payload.runtimeBundleDigest === runtimeBundle.digest &&
    record.payload.settingsDigest === settings.digest &&
    settings.valid === true &&
    settings.unknownSideEffectingHooks === false &&
    Number.isFinite(Date.parse(record.payload.expiresAt)) &&
    Date.parse(record.payload.expiresAt) > Date.now() &&
    record.payload.status === "active"
  );
}

async function recheckFingerprint(authority, state, stage, context) {
  const record = await authority.readSigned(`fingerprints/${stage}.json`);
  const expected = record.payload;
  const validity = verifyFingerprint(expected);
  if (!validity.valid) {
    throw new Error(`Stored ${stage} is invalid: ${validity.errors.join("; ")}`);
  }
  const stateDigest = state.fingerprints?.[stage];
  const expectedStateDigest =
    typeof stateDigest === "string" ? stateDigest : stateDigest?.digest;
  if (expectedStateDigest !== expected.digest) {
    throw new Error(`${stage} does not match signed current state`);
  }
  const actual = await createFingerprint({
    projectRoot: context.projectRoot,
    stage,
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
      `Project fingerprint is stale: added=${comparison.added.join(",")}; removed=${comparison.removed.join(",")}; changed=${comparison.changed.join(",")}`,
    );
    error.code = "STALE";
    error.comparison = comparison;
    throw error;
  }
  return expected;
}

export async function restrictState(authority, target, reason) {
  const record = await authority.readSigned("state/current.json", {
    required: false,
  });
  if (!record || record.payload.phase === target) return;
  if (canTransition(record.payload.phase, target)) {
    await commitTransition(authority, record.payload, target, {
      reason,
      expectedSequence: record.payload.sequence,
    });
  } else {
    await authority.appendEvent("security-violation", {
      reason,
      priorPhase: record.payload.phase,
      requestedRestrictedState: target,
    });
  }
}

export async function authorizeToolCall(event, context, authority, classification) {
  await recoverStateTransaction(authority);
  await authority.appendEvent("authorization-integrity-check", {
    toolUseId: event.tool_use_id,
    toolName: event.tool_name,
    inputDigest: toolInputDigest(event.tool_name, event.tool_input),
  });
  const eventChain = await authority.verifyEventChain();
  if (!eventChain.valid) {
    throw new Error(
      `Authoritative event-chain integrity failed: ${eventChain.errors.join("; ")}`,
    );
  }
  const stateRecord = await authority.readSigned("state/current.json");
  const state = stateRecord.payload;
  const hasAuthorizedWrite = Boolean(
    state.fingerprints?.expectedWorkingFingerprint,
  );
  const expectedStage = requiredFingerprintStage(classification.actionClass, {
    hasAuthorizedWrite,
    phase: state.phase,
  });
  const approvalDigest = approvalDigestFor(state, classification.actionClass);
  if (!approvalDigest) {
    throw new Error(`${classification.actionClass} has no current signed approval`);
  }
  const lease = await synchronizeLease(authority, {
    sessionId: event.session_id,
    taskId: state.taskId ?? "__onboarding__",
    phase: state.phase,
  });
  const attested = state.hooksAttested === true &&
    (await hooksAttested(authority, event, context));
  const fingerprint = await recheckFingerprint(
    authority,
    state,
    expectedStage,
    context,
  );
  const gate = evaluatePhaseGate({
    phase: state.phase,
    actionClass: classification.actionClass,
    hasApproval: true,
    hooksAttested: attested,
    integrityValid: true,
    mutationApproved: Boolean(approvalDigestFor(state, "infrastructure-mutation")),
  });
  if (!gate.allowed) throw new Error(gate.reasons.join("; "));
  const expectations = {
    actionClass: classification.actionClass,
    phase: state.phase,
    approvalDigest,
    leaseId: lease.leaseId,
    fingerprintStage: expectedStage,
    fingerprintDigest: fingerprint.digest,
    pluginVersion: context.pluginVersion,
  };
  let token;
  try {
    token = await reservePreauthorization(authority, event, expectations);
  } catch (error) {
    if (!/Missing signed authority record: preauthorizations\//u.test(error.message)) {
      throw error;
    }
    const approvalKind =
      classification.actionClass === "context-write"
        ? "context"
        : classification.actionClass === "test-run"
          ? "execution"
          : classification.actionClass === "observability-query"
            ? "query"
          : classification.actionClass === "infrastructure-mutation"
            ? "mutation"
            : "plan";
    const approval = await findApprovalByDigest(authority, {
      kind: approvalKind,
      approvedDigest: approvalDigest,
      sessionId: event.session_id,
      leaseId: lease.leaseId,
    });
    if (!approval) {
      throw new Error("No exact signed approval can issue this preauthorization");
    }
    const scope = await preauthorizationScope(
      authority,
      classification.actionClass,
      approvalDigest,
    );
    await issuePreauthorization(authority, {
      toolUseId: event.tool_use_id,
      toolName: event.tool_name,
      toolInput: event.tool_input,
      actionClass: classification.actionClass,
      approvalDigest,
      approvalId: approval.approvalId,
      approvalObjectId: approval.objectId,
      sessionId: event.session_id,
      leaseId: lease.leaseId,
      fingerprintStage: expectedStage,
      fingerprintDigest: fingerprint.digest,
      phase: state.phase,
      scope,
      expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    });
    token = await reservePreauthorization(authority, event, expectations);
  }
  if (["context-write", "project-write"].includes(token.actionClass)) {
    if (!Array.isArray(token.scope?.allowedPaths) || token.scope.allowedPaths.length === 0) {
      throw new Error(`${token.actionClass} token lacks exact allowedPaths`);
    }
    const allowed = new Set(
      token.scope.allowedPaths.map((entry) =>
        process.platform === "win32"
          ? entry.replaceAll("\\", "/").toLowerCase()
          : entry.replaceAll("\\", "/"),
      ),
    );
    for (const target of classification.paths ?? []) {
      const relative = path
        .relative(context.projectRoot, target.value)
        .replaceAll("\\", "/");
      const comparable =
        process.platform === "win32" ? relative.toLowerCase() : relative;
      if (!allowed.has(comparable)) {
        throw new Error(`Tool target is outside signed allowedPaths: ${relative}`);
      }
      if (token.actionClass === "project-write") {
        const normalizeScopePath = (entry) =>
          process.platform === "win32"
            ? entry.replaceAll("\\", "/").toLowerCase()
            : entry.replaceAll("\\", "/");
        const createPaths = new Set(
          (token.scope.createPaths ?? []).map(normalizeScopePath),
        );
        const modifyPaths = new Set(
          (token.scope.modifyPaths ?? []).map(normalizeScopePath),
        );
        let exists = true;
        try {
          await stat(target.value);
        } catch (error) {
          if (error?.code === "ENOENT") exists = false;
          else throw error;
        }
        if (event.tool_name === "Write" && (!createPaths.has(comparable) || exists)) {
          throw new Error(
            "Write is permitted only for an approved create path that does not yet exist",
          );
        }
        if (
          ["Edit", "NotebookEdit"].includes(event.tool_name) &&
          (!modifyPaths.has(comparable) || !exists)
        ) {
          throw new Error(
            `${event.tool_name} is permitted only for an approved existing modify path`,
          );
        }
      }
    }
  }
  return token;
}

export async function openExistingAuthority(event, context) {
  if (!context.pluginData) return null;
  try {
    return await openAuthority({
      pluginData: context.pluginData,
      projectRoot: context.projectRoot,
      pluginVersion: context.pluginVersion,
      create: false,
    });
  } catch (error) {
    if (
      error?.code === "ENOENT" ||
      /No protected authority exists|ENOENT/u.test(error.message)
    ) {
      return null;
    }
    throw error;
  }
}

export async function recordSecurityDenial(
  authority,
  event,
  reason,
  code = "DENIED",
) {
  if (!authority) return;
  await authority.appendEvent(
    "security-denial",
    {
      code,
      toolName: event.tool_name ?? null,
      toolUseId: event.tool_use_id ?? null,
      inputDigest:
        event.tool_name && event.tool_input
          ? toolInputDigest(event.tool_name, event.tool_input)
          : null,
      reason,
    },
    {
      log: "events/security-events.jsonl",
      head: "events/security-head.json",
      lock: "events/security-chain.lock",
    },
  );
}

export async function updateWorkingFingerprint(
  authority,
  state,
  token,
  context,
) {
  if (!["context-write", "project-write"].includes(token.actionClass)) return state;
  const stage =
    token.actionClass === "context-write"
      ? "onboardingFingerprint"
      : "expectedWorkingFingerprint";
  const priorRecord = await authority.readSigned(
    `fingerprints/${token.fingerprintStage}.json`,
  );
  const prior = priorRecord.payload;
  const next = await createFingerprint({
    projectRoot: context.projectRoot,
    stage,
    relevantPaths: prior.scopePaths ?? null,
    exclusions: (prior.exclusions ?? []).filter(
      (entry) => ![".git", ".claude/qaas/state"].includes(entry),
    ),
    packageSnapshot: prior.packageSnapshot,
    contextDigest: prior.contextDigest,
    externalReferences: prior.externalReferences,
    renderedTemplate: null,
  });
  const comparison = compareFingerprints(prior, next);
  const normalizeRelative = (value) => {
    const slash = value.replaceAll("\\", "/");
    return process.platform === "win32" ? slash.toLowerCase() : slash;
  };
  const exact = new Set(
    (token.scope?.allowedPaths ?? []).map(normalizeRelative),
  );
  const generated = (token.scope?.generatedOutputs ?? []).map(normalizeRelative);
  const allowedChange = (entry) => {
    const normalized = normalizeRelative(entry);
    return (
      exact.has(normalized) ||
      generated.some(
        (prefix) =>
          normalized === prefix || normalized.startsWith(`${prefix}/`),
      )
    );
  };
  const unexpected = [
    ...comparison.added,
    ...comparison.changed,
    ...comparison.removed,
  ].filter((entry) => !allowedChange(entry));
  if (unexpected.length > 0) {
    const error = new Error(
      `Post-write fingerprint contains unapproved changes: ${unexpected.join(", ")}`,
    );
    error.code = "SAFETY_VIOLATION";
    throw error;
  }
  if (
    comparison.removed.some(
      (entry) => !generated.some((prefix) => {
        const normalized = normalizeRelative(entry);
        return normalized === prefix || normalized.startsWith(`${prefix}/`);
      }),
    )
  ) {
    const error = new Error("Authorized project/context write removed a managed file");
    error.code = "SAFETY_VIOLATION";
    throw error;
  }
  const existing = await authority.readSigned(`fingerprints/${stage}.json`, {
    required: false,
  });
  await authority.writeSigned(`fingerprints/${stage}.json`, next, {
    expectedDigest: existing?.digest ?? null,
  });
  return commitCheckpoint(
    authority,
    state,
    {
      fingerprints: {
        ...state.fingerprints,
        [stage]: next.digest,
      },
    },
    {
      reason: `Advanced ${stage} after authorized ${token.actionClass}`,
    },
  );
}

export { actionNeedsApproval };
