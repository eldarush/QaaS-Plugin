import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import {
  canonicalDigest,
  canonicalJson,
  safeEqualHex,
  sha256,
} from "./canonical-json.mjs";
import {
  analyzeMcpTool,
  validateCapabilityRegistry,
} from "./mcp-analyzer.mjs";
import { toolInputDigest } from "./approval-authority.mjs";
import { redactText } from "./redact.mjs";
import { assertCredentialFreeQueryParameters } from "./url-safety.mjs";

const HTTP_PROVIDERS = new Set([
  "reportportal",
  "elastic",
  "thanos",
  "kubernetes",
]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function capabilityFor(query, registry) {
  const validation = validateCapabilityRegistry(registry);
  if (!validation.valid) {
    throw new Error(`Capability registry is invalid: ${validation.errors.join("; ")}`);
  }
  const capability = registry.capabilities.find(
    (entry) => entry.id === query.capabilityId,
  );
  if (
    !capability ||
    capability.classification !== "read" ||
    capability.userApproved !== true ||
    capability.probePassed !== true ||
    capability.logicalOperation !== `observability.${query.provider}` ||
    query.toolName !== `mcp__${capability.server}__${capability.tool}`
  ) {
    throw new Error("Query does not bind one current approved read-only capability");
  }
  const analysis = analyzeMcpTool(
    {
      server: capability.server,
      tool: capability.tool,
      input: query.toolInput,
    },
    registry,
  );
  if (analysis.destructive || analysis.opaque || analysis.decision !== "allow") {
    throw new Error(
      `Capability cannot prove this exact query read-only: ${analysis.reasons.join("; ")}`,
    );
  }
  if (
    query.outputLimitBytes > capability.outputLimitBytes ||
    query.itemLimit > capability.outputLimitItems
  ) {
    throw new Error("Query bounds exceed the approved capability bounds");
  }
  return capability;
}

function expectedCredentialNames(query) {
  if (query.provider === "allure") return [];
  if (!HTTP_PROVIDERS.has(query.provider)) {
    throw new Error(
      `No proven read-only adapter is available for provider ${query.provider}`,
    );
  }
  return [...query.credentialEnvNames];
}

function endpointProof(query, env, projectRoot) {
  if (query.provider === "allure") {
    if (typeof projectRoot !== "string" || projectRoot.length === 0) {
      throw new Error("Allure query attestation requires the project root");
    }
    return {
      adapterId: "qaas-internal-project-artifact-v1",
      endpointIdentity: {
        selector: "project-artifact",
        projectRootDigest: sha256(path.resolve(projectRoot)),
      },
      endpointValueDigest: sha256(path.resolve(projectRoot)),
    };
  }
  const raw = query.endpointSelector;
  const base = new URL(raw);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("Query base endpoint must be credential-free HTTP(S)");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    base.hostname.toLowerCase(),
  );
  if (base.protocol !== "https:" && !loopback) {
    throw new Error("Remote query endpoint must use HTTPS or explicit loopback");
  }
  return {
    adapterId: "qaas-internal-http-get-v1",
    endpointIdentity: {
      selector: "exact-user-approved-url",
      protocol: base.protocol,
      origin: base.origin,
      basePath: base.pathname,
    },
    endpointValueDigest: sha256(raw),
  };
}

export function attestQuery({
  query,
  registry,
  env = process.env,
  projectRoot,
}) {
  const capability = capabilityFor(query, registry);
  const credentialEnvNames = expectedCredentialNames(query);
  if (
    canonicalDigest(query.credentialEnvNames) !==
    canonicalDigest(credentialEnvNames)
  ) {
    throw new Error("Query credential environment names changed or were not reviewed");
  }
  if (credentialEnvNames.some((name) => !env[name])) {
    throw new Error("A reviewed query credential environment variable is unavailable");
  }
  if (
    query.provider === "allure" &&
    (
      query.endpointSelector !== "project-artifact" ||
      capability.readOnlyQueryPolicy !== "exact-template" ||
      typeof query.toolInput.path !== "string"
    )
  ) {
    throw new Error("Allure query requires an exact project-artifact path template");
  }
  if (
    query.provider !== "allure" &&
    (
      capability.readOnlyQueryPolicy !== "http-get" ||
      query.toolInput.method !== "GET" ||
      typeof query.toolInput.relativeUrl !== "string"
    )
  ) {
    throw new Error("Remote observability queries require exact HTTP GET capability input");
  }
  const endpoint = endpointProof(query, env, projectRoot);
  if (query.provider !== "allure") {
    safeRemoteUrl(query);
  }
  return {
    schemaVersion: "1.0",
    queryDigest: query.queryDigest,
    capabilityDigest: canonicalDigest(capability),
    toolName: query.toolName,
    toolInputDigest: query.toolInputDigest,
    preauthorizationToolInputDigest: toolInputDigest(
      query.toolName,
      query.toolInput,
    ),
    endpointSelector: query.endpointSelector,
    ...endpoint,
    registeredPermissionContract: {
      capabilityId: query.capabilityId,
      toolName: query.toolName,
      note:
        "The fixed internal adapter executes; this connector name is the reviewed permission contract.",
    },
    credentialEnvNames,
  };
}

function countItems(value, budget) {
  if (Array.isArray(value)) {
    budget.count += value.length;
    if (budget.count > budget.limit) {
      throw new Error("Query response exceeded its reviewed item bound");
    }
    value.forEach((entry) => countItems(entry, budget));
  } else if (value && typeof value === "object") {
    const values = Object.values(value);
    budget.count += values.length;
    if (budget.count > budget.limit) {
      throw new Error("Query response exceeded its reviewed item bound");
    }
    values.forEach((entry) => countItems(entry, budget));
  }
}

function pointer(value, jsonPointer) {
  let current = value;
  for (const encoded of jsonPointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    ) {
      return { missing: true };
    }
    current = current[key];
  }
  return { missing: false, value: current };
}

function verifyResponse(query, status, text) {
  let json;
  const outcomes = query.responseChecks.map((check) => {
    let passed = false;
    if (check.type === "status-equals") {
      passed = status === check.expectedStatus;
    } else if (check.type === "body-contains") {
      passed = text.includes(check.contains);
    } else {
      try {
        json ??= JSON.parse(text);
        const actual = pointer(json, check.jsonPointer);
        passed =
          !actual.missing &&
          JSON.stringify(actual.value) === JSON.stringify(check.expected);
      } catch {
        passed = false;
      }
    }
    return { id: check.id, type: check.type, passed };
  });
  return {
    passed: outcomes.every((entry) => entry.passed),
    outcomes,
  };
}

const SENSITIVE_FIELD =
  /(?:token|secret|password|passwd|api[-_]?key|authorization|credential|cookie|private[-_]?key)/iu;

function deepRedactJson(value, key = "") {
  if (SENSITIVE_FIELD.test(key)) return "[REDACTED_FIELD]";
  if (Array.isArray(value)) {
    return value.map((entry) => deepRedactJson(entry));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entry]) => [
        entryKey,
        deepRedactJson(entry, entryKey),
      ]),
    );
  }
  return typeof value === "string" ? redactText(value) : value;
}

function redactStructuredText(text) {
  try {
    const parsed = JSON.parse(text);
    const redacted = deepRedactJson(parsed);
    return { text: canonicalJson(redacted), parsed: redacted };
  } catch (error) {
    if (!/Unexpected token|JSON|position|end of JSON/iu.test(error.message)) {
      throw error;
    }
  }
  const xmlRedacted = text
    .replace(
      /<(token|secret|password|passwd|authorization|credential|cookie|private[-_]?key)(\b[^>]*)>[\s\S]*?<\/\1>/giu,
      "<$1$2>[REDACTED_FIELD]</$1>",
    )
    .replace(
      /\b(token|secret|password|passwd|authorization|credential|cookie|private[-_]?key)\s*=\s*("[^"]*"|'[^']*')/giu,
      '$1="[REDACTED_FIELD]"',
    );
  return { text: redactText(xmlRedacted), parsed: null };
}

function decodeUtf8Strict(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Query response is not valid UTF-8 text");
  }
}

async function readAllure(query, projectRoot) {
  const root = await realpath(path.resolve(projectRoot));
  const target = path.resolve(root, query.toolInput.path);
  if (!inside(root, target)) {
    throw new Error("Allure artifact path escapes the project");
  }
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error("Allure artifact path may not follow a symlink");
    }
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > query.outputLimitBytes) {
    throw new Error("Allure artifact is absent or exceeds its reviewed byte bound");
  }
  return { status: 200, bytes: await readFile(target) };
}

function safeRemoteUrl(query) {
  const base = new URL(query.endpointSelector);
  if (
    !["http:", "https:"].includes(base.protocol) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash
  ) {
    throw new Error("Query base endpoint must be credential-free HTTP(S)");
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
    base.hostname.toLowerCase(),
  );
  if (base.protocol !== "https:" && !loopback) {
    throw new Error("Remote query endpoint must use HTTPS or explicit loopback");
  }
  const relative = query.toolInput.relativeUrl;
  const requested = new URL(relative, base);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (
    requested.origin !== base.origin ||
    (
      requested.pathname !== base.pathname &&
      !requested.pathname.startsWith(basePath)
    ) ||
    requested.username ||
    requested.password
  ) {
    throw new Error("Query URL escapes its configured provider endpoint");
  }
  assertCredentialFreeQueryParameters(requested, "Query URL");
  return requested;
}

async function readRemote(query, env, fetchImpl) {
  const url = safeRemoteUrl(query);
  const credentialName = query.credentialEnvNames[0] ?? null;
  const credential = credentialName ? env[credentialName] : null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), query.timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: credential ? { Authorization: `Bearer ${credential}` } : {},
    });
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > query.outputLimitBytes) {
      throw new Error("Query response exceeds its reviewed byte bound");
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > query.outputLimitBytes) {
        await reader.cancel();
        throw new Error("Query response exceeds its reviewed byte bound");
      }
      chunks.push(value);
    }
    return { status: response.status, bytes: Buffer.concat(chunks) };
  } finally {
    clearTimeout(timer);
  }
}

export async function executeQuery({
  query,
  binding,
  registry,
  projectRoot,
  env = process.env,
  fetchImpl = fetch,
}) {
  const current = attestQuery({ query, registry, env, projectRoot });
  if (!safeEqualHex(canonicalDigest(current), canonicalDigest(binding))) {
    throw new Error("Query capability/configuration changed after exact review");
  }
  const response =
    query.provider === "allure"
      ? await readAllure(query, projectRoot)
      : await readRemote(query, env, fetchImpl);
  if (response.bytes.includes(0)) {
    throw new Error("Binary query responses are unsupported");
  }
  const redacted = redactStructuredText(decodeUtf8Strict(response.bytes));
  const text = redacted.text;
  const parsed = redacted.parsed;
  if (parsed !== null) {
    countItems(parsed, { count: 0, limit: query.itemLimit });
  }
  const verification = verifyResponse(query, response.status, text);
  return {
    queryId: query.queryId,
    provider: query.provider,
    queryDigest: query.queryDigest,
    status: response.status,
    byteLength: Buffer.byteLength(text, "utf8"),
    outputDigest: sha256(text),
    verification,
    excerpt: text.slice(0, 2_048),
  };
}
