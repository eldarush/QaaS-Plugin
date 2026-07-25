import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalDigest,
  safeEqualHex,
  sha256,
} from "./canonical-json.mjs";
import { redactText, secretFindings } from "./redact.mjs";
import {
  matchCapabilityInput,
  validateCapabilityRegistry,
} from "./mcp-analyzer.mjs";

const DEFAULT_OUTPUT_LIMIT = 32 * 1024;
export const DEFAULT_QAAS_DOCS_URL = "https://docs.qaas.online/";
export const QAAS_DOCS_CONFIGURATION_NAMES = Object.freeze([
  "QAAS_DOCS_PRIMARY_URL",
  "QAAS_DOCS_SECONDARY_URL",
  "QAAS_DOCS_ZIM_PATH",
  "QAAS_DOCS_MCP_URL",
  "QAAS_DOCS_MCP_CREDENTIAL_ENV",
]);
const CREDENTIAL_QUERY_KEY =
  /(?:token|secret|password|api[-_]?key|signature|credential|auth)/iu;
const HIGH_ENTROPY_QUERY_VALUE =
  /^(?=.{24,256}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~+/=-]+$/u;

function assertSafeQueryValues(url, label) {
  for (const [key, value] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      throw new Error(`${label} may not contain credential query parameters`);
    }
    if (
      secretFindings(value).length > 0 ||
      HIGH_ENTROPY_QUERY_VALUE.test(value)
    ) {
      throw new Error(`${label} contains a secret-like query value`);
    }
  }
}

function configuredUrl(name, value) {
  if (!value) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a valid URL`);
  }
  if (!["https:", "http:"].includes(url.protocol)) {
    throw new Error(`${name} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${name} may not contain credentials`);
  }
  assertSafeQueryValues(url, name);
  return url.toString();
}

function configuredUrlIdentity(name, value, fallback = null) {
  const selectorPresent = Object.hasOwn(value.env, name);
  const raw = value.env[name];
  const selected = raw ?? fallback;
  const configured = configuredUrl(name, selected);
  if (!configured) {
    return {
      selector: name,
      selectorPresent,
      selectorValueDigest:
        selectorPresent ? sha256(String(raw)) : null,
      effective: null,
    };
  }
  const url = new URL(configured);
  return {
    selector: name,
    selectorPresent,
    selectorValueDigest:
      selectorPresent ? sha256(String(raw)) : null,
    effective: {
      protocol: url.protocol,
      origin: url.origin,
      pathname: url.pathname,
      queryParameterNames: [...url.searchParams.keys()].sort(),
      urlDigest: sha256(url.toString()),
    },
  };
}

function configuredMcpIdentity(env) {
  const name = "QAAS_DOCS_MCP_URL";
  const selectorPresent = Object.hasOwn(env, name);
  const raw = env[name];
  if (!raw) {
    return {
      selector: name,
      selectorPresent,
      selectorValueDigest:
        selectorPresent ? sha256(String(raw)) : null,
      effective: null,
    };
  }
  const configured = configuredUrl(name, raw);
  const url = new URL(configured);
  if (url.hash) {
    throw new Error("QAAS_DOCS_MCP_URL may not contain a fragment");
  }
  return {
    selector: name,
    selectorPresent,
    selectorValueDigest: sha256(String(raw)),
    effective: {
      protocol: url.protocol,
      origin: url.origin,
      pathname: url.pathname,
      queryParameterNames: [...url.searchParams.keys()].sort(),
      urlDigest: sha256(url.toString()),
    },
  };
}

async function configuredZimIdentity(env) {
  const name = "QAAS_DOCS_ZIM_PATH";
  const selectorPresent = Object.hasOwn(env, name);
  const raw = env[name];
  if (!raw) {
    return {
      selector: name,
      selectorPresent,
      selectorValueDigest:
        selectorPresent ? sha256(String(raw)) : null,
      state: "absent",
    };
  }
  const requestedPath = path.resolve(String(raw));
  const lexicalInfo = await lstat(requestedPath);
  if (lexicalInfo.isSymbolicLink()) {
    throw new Error("QAAS_DOCS_ZIM_PATH may not be a symbolic link");
  }
  const canonicalPath = await realpath(requestedPath);
  const info = await stat(canonicalPath, { bigint: true });
  if (!info.isFile()) {
    throw new Error("QAAS_DOCS_ZIM_PATH must identify one ordinary file");
  }
  const size = Number(info.size);
  if (!Number.isSafeInteger(size)) {
    throw new Error("QAAS_DOCS_ZIM_PATH size exceeds the safe identity bound");
  }
  return {
    selector: name,
    selectorPresent,
    selectorValueDigest: sha256(String(raw)),
    state: "file",
    realPath: canonicalPath,
    size,
    sha256: await hashFileStreaming(canonicalPath),
    fileFingerprint: {
      device: String(info.dev),
      inode: String(info.ino),
      mode: Number(info.mode),
      modifiedNanoseconds: String(info.mtimeNs),
    },
  };
}

export async function attestDocumentationSourceConfiguration(
  env = process.env,
) {
  const credentialSelector = env.QAAS_DOCS_MCP_CREDENTIAL_ENV ?? null;
  if (
    credentialSelector !== null &&
    (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialSelector) ||
      /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(credentialSelector)
    )
  ) {
    throw new Error(
      "QAAS_DOCS_MCP_CREDENTIAL_ENV must name one safe credential variable",
    );
  }
  const attestation = {
    schemaVersion: "1.0",
    configurationNames: [...QAAS_DOCS_CONFIGURATION_NAMES],
    primary: configuredUrlIdentity(
      "QAAS_DOCS_PRIMARY_URL",
      { env },
      DEFAULT_QAAS_DOCS_URL,
    ),
    secondary: configuredUrlIdentity(
      "QAAS_DOCS_SECONDARY_URL",
      { env },
    ),
    zim: await configuredZimIdentity(env),
    mcp: configuredMcpIdentity(env),
    mcpCredential: {
      selector: "QAAS_DOCS_MCP_CREDENTIAL_ENV",
      selectorPresent: Object.hasOwn(
        env,
        "QAAS_DOCS_MCP_CREDENTIAL_ENV",
      ),
      selectedEnvironmentName: credentialSelector,
      selectedValueAvailable:
        credentialSelector === null
          ? null
          : Boolean(env[credentialSelector]),
    },
  };
  attestation.digest = canonicalDigest(attestation);
  return attestation;
}

export async function assertCurrentDocumentationSourceConfiguration(
  expected,
  env = process.env,
) {
  if (
    !expected ||
    !safeEqualHex(expected.digest, canonicalDigest(expected))
  ) {
    throw new Error("Signed documentation source configuration is malformed");
  }
  const current = await attestDocumentationSourceConfiguration(env);
  if (!safeEqualHex(current.digest, expected.digest)) {
    throw new Error(
      "Documentation source selector, endpoint, or local ZIM identity changed",
    );
  }
  return current;
}

export function resolveDocumentationSources({
  env = process.env,
  capabilityRegistry = null,
} = {}) {
  let mcp = null;
  if (capabilityRegistry) {
    const validation = validateCapabilityRegistry(capabilityRegistry);
    if (!validation.valid) {
      throw new Error(
        `Invalid integration capability registry: ${validation.errors.join("; ")}`,
      );
    }
    const search = capabilityRegistry.capabilities.find(
      (entry) =>
        entry.logicalOperation === "docs.search" &&
        entry.classification === "read" &&
        entry.probePassed === true,
    );
    const read = capabilityRegistry.capabilities.find(
      (entry) =>
        entry.logicalOperation === "docs.read" &&
        entry.classification === "read" &&
        entry.probePassed === true,
    );
    if (search && read) mcp = { search, read };
  }
  return {
    mcp,
    primaryUrl: configuredUrl(
      "QAAS_DOCS_PRIMARY_URL",
      env.QAAS_DOCS_PRIMARY_URL ?? DEFAULT_QAAS_DOCS_URL,
    ),
    secondaryUrl: configuredUrl(
      "QAAS_DOCS_SECONDARY_URL",
      env.QAAS_DOCS_SECONDARY_URL,
    ),
    zimPath: env.QAAS_DOCS_ZIM_PATH
      ? path.resolve(env.QAAS_DOCS_ZIM_PATH)
      : null,
  };
}

export function boundedExcerpt(text, limit = DEFAULT_OUTPUT_LIMIT) {
  const value = redactText(String(text));
  const truncated = Buffer.byteLength(value, "utf8") > limit;
  let excerpt = value;
  if (truncated) {
    excerpt = Buffer.from(value, "utf8").subarray(0, limit).toString("utf8");
    while (Buffer.byteLength(excerpt, "utf8") > limit) {
      excerpt = excerpt.slice(0, -1);
    }
  }
  return {
    excerpt,
    excerptHash: sha256(excerpt),
    truncated,
    byteLength: Buffer.byteLength(excerpt, "utf8"),
  };
}

export function createDocumentationProvenance({
  source,
  identifier,
  title,
  retrievedAt = new Date().toISOString(),
  projectPackageVersion,
  conclusion,
  artifactDigest = null,
  pageIdentifier = null,
  excerpt,
  packageLockDigest = null,
  compatibilityDecision = null,
}) {
  if (secretFindings({ source, identifier, title, conclusion, excerpt }).length) {
    throw new Error("Documentation provenance contains credential-like data");
  }
  const bounded = boundedExcerpt(excerpt);
  const record = {
    schemaVersion: "1.0",
    source,
    identifier,
    title,
    retrievedAt,
    projectPackageVersion,
    conclusion,
    artifactDigest,
    pageIdentifier,
    excerptHash: bounded.excerptHash,
    packageLockDigest,
    compatibilityDecision,
  };
  record.digest = canonicalDigest(record);
  return { record, excerpt: bounded.excerpt };
}

async function fetchBounded(url, { outputLimitBytes, timeoutMs, allowedBase }) {
  if (
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 1024 * 1024
  ) {
    throw new Error("Documentation outputLimitBytes must be between 1 and 1,048,576");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Documentation timeoutMs must be between 1 and 60,000");
  }
  const requested = new URL(url, allowedBase);
  const base = new URL(allowedBase);
  if (requested.username || requested.password) {
    throw new Error("Documentation request may not contain credentials");
  }
  assertSafeQueryValues(requested, "Documentation request");
  if (requested.origin !== base.origin) {
    throw new Error("Documentation request escaped its configured origin");
  }
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  if (
    requested.pathname !== base.pathname &&
    !requested.pathname.startsWith(basePath)
  ) {
    throw new Error("Documentation request escaped its configured base path");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(requested, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: { Accept: "text/plain, text/html, application/json" },
    });
    if (!response.ok) {
      throw new Error(`Documentation source returned HTTP ${response.status}`);
    }
    const contentLength = Number(response.headers.get("content-length") ?? 0);
    if (contentLength > outputLimitBytes) {
      throw new Error("Documentation response exceeds the configured output bound");
    }
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > outputLimitBytes) {
        await reader.cancel();
        throw new Error("Documentation response exceeds the configured output bound");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally {
    clearTimeout(timer);
  }
}

export function materializeCapabilityTemplate(template, bindings) {
  if (
    template &&
    typeof template === "object" &&
    !Array.isArray(template) &&
    typeof template.$slot === "string"
  ) {
    const allowedKeys = new Set(["$slot", "type", "maxLength", "enum"]);
    if (Object.keys(template).some((key) => !allowedKeys.has(key))) {
      throw new Error(`Unsupported reviewed slot constraint: ${template.$slot}`);
    }
    if (!Object.hasOwn(bindings, template.$slot)) {
      throw new Error(`Missing reviewed capability slot: ${template.$slot}`);
    }
    return bindings[template.$slot];
  }
  if (Array.isArray(template)) {
    return template.map((entry) =>
      materializeCapabilityTemplate(entry, bindings),
    );
  }
  if (template && typeof template === "object") {
    return Object.fromEntries(
      Object.entries(template).map(([key, value]) => [
        key,
        materializeCapabilityTemplate(value, bindings),
      ]),
    );
  }
  return template;
}

function capabilityInput(capability, bindings) {
  const input = materializeCapabilityTemplate(
    capability.safeArgumentTemplate,
    bindings,
  );
  const validation = matchCapabilityInput(capability, input);
  if (!validation.valid) {
    throw new Error(
      `Materialized capability input violates its signed contract: ${validation.errors.join("; ")}`,
    );
  }
  return input;
}

function stripMarkup(value) {
  return String(value)
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/&(?:nbsp|amp|lt|gt|quot|#39);/giu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function searchIndexCandidates(html, baseUrl, query, limit = 10) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  const terms = [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}]+/u))]
    .filter((term) => term.length >= 2)
    .slice(0, 12);
  const candidates = [];
  const anchor =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(anchor)) {
    const href = match[1] ?? match[2] ?? match[3] ?? "";
    let target;
    try {
      target = new URL(href, base);
    } catch {
      continue;
    }
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.origin !== base.origin ||
      (target.pathname !== base.pathname &&
        !target.pathname.startsWith(basePath))
    ) {
      continue;
    }
    target.username = "";
    target.password = "";
    target.search = "";
    target.hash = "";
    const title = stripMarkup(match[4]).slice(0, 240);
    const haystack = `${title} ${decodeURIComponent(target.pathname)}`.toLowerCase();
    const score = terms.reduce(
      (total, term) => total + (haystack.includes(term) ? 1 : 0),
      0,
    );
    if (terms.length > 0 && score === 0) continue;
    candidates.push({
      title: title || path.posix.basename(target.pathname) || "documentation",
      url: target.toString(),
      score,
    });
  }
  return [...new Map(candidates.map((entry) => [entry.url, entry])).values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.url < right.url ? -1 : left.url > right.url ? 1 : 0),
    )
    .slice(0, limit);
}

export async function searchConfiguredDocumentationIndex(
  baseUrl,
  query,
  { outputLimitBytes = DEFAULT_OUTPUT_LIMIT, timeoutMs = 10_000 } = {},
) {
  const text = await fetchBounded(baseUrl, {
    outputLimitBytes,
    timeoutMs,
    allowedBase: baseUrl,
  });
  const candidates = searchIndexCandidates(text, baseUrl, query);
  const bounded = boundedExcerpt(JSON.stringify(candidates), outputLimitBytes);
  return {
    kind: "configured-url-search",
    baseUrl,
    queryDigest: sha256(query.trim()),
    candidateCount: candidates.length,
    candidates,
    excerptHash: bounded.excerptHash,
    truncated: bounded.truncated,
    byteLength: bounded.byteLength,
    requiresFocusedPage: true,
  };
}

async function hashFileStreaming(
  target,
  {
    maxBytes = 256 * 1024 * 1024,
    timeoutMs = 60_000,
  } = {},
) {
  const info = await stat(target);
  if (!info.isFile() || info.size > maxBytes) {
    throw new Error(
      "Offline documentation artifact exceeds the bounded hashing limit",
    );
  }
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    let total = 0;
    const timer = setTimeout(() => {
      stream.destroy(
        new Error("Offline documentation artifact hashing timed out"),
      );
    }, timeoutMs);
    timer.unref?.();
    stream.on("data", (chunk) => {
      total += chunk.byteLength;
      if (total > maxBytes) {
        stream.destroy(
          new Error("Offline documentation artifact exceeds the hashing bound"),
        );
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("close", () => clearTimeout(timer));
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

/**
 * Searches before reading. MCP execution is injected because the hook must use
 * the host's exact, approved MCP contract rather than guess a tool name.
 */
export async function resolveDocumentationQuery({
  query,
  sources,
  callMcp = null,
  relativeUrl = null,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT,
  timeoutMs = 10_000,
}) {
  if (typeof query !== "string" || query.trim() === "") {
    throw new Error("A focused documentation query is required");
  }
  if (
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 1024 * 1024
  ) {
    throw new Error("Documentation outputLimitBytes must be between 1 and 1,048,576");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Documentation timeoutMs must be between 1 and 60,000");
  }
  if (sources.mcp && typeof callMcp === "function") {
    const capability = relativeUrl ? sources.mcp.read : sources.mcp.search;
    const input = capabilityInput(
      capability,
      relativeUrl
        ? {
            identifier: relativeUrl,
            limit: Math.min(outputLimitBytes, capability.outputLimitBytes),
          }
        : {
            query,
            limit: Math.min(10, capability.outputLimitItems ?? 10),
          },
    );
    const results = await callMcp(capability, input);
    const boundedSearch = boundedExcerpt(
      JSON.stringify(results),
      Math.min(outputLimitBytes, capability.outputLimitBytes),
    );
    return {
      kind: relativeUrl ? "mcp-read" : "mcp-search",
      capabilityId: capability.id,
      ...boundedSearch,
    };
  }
  const failures = [];
  for (const baseUrl of [sources.primaryUrl, sources.secondaryUrl]) {
    if (!baseUrl) continue;
    if (!relativeUrl) {
      try {
        return {
          ...(await searchConfiguredDocumentationIndex(baseUrl, query, {
            outputLimitBytes,
            timeoutMs,
          })),
          priorFailures: failures,
        };
      } catch (error) {
        failures.push({
          source: baseUrl === sources.primaryUrl ? "primary" : "secondary",
          category:
            error?.name === "AbortError"
              ? "timeout"
              : /HTTP \d{3}/u.test(error.message)
                ? "http-error"
                : /base path|origin/u.test(error.message)
                  ? "scope-error"
                  : "unavailable",
        });
        continue;
      }
    }
    try {
      const text = await fetchBounded(relativeUrl, {
        outputLimitBytes,
        timeoutMs,
        allowedBase: baseUrl,
      });
      return {
        kind: "http-read",
        source: new URL(relativeUrl, baseUrl).toString(),
        ...boundedExcerpt(text, outputLimitBytes),
        priorFailures: failures,
      };
    } catch (error) {
      failures.push({
        source: baseUrl === sources.primaryUrl ? "primary" : "secondary",
        category:
          error?.name === "AbortError"
            ? "timeout"
            : /HTTP \d{3}/u.test(error.message)
              ? "http-error"
              : /base path|origin/u.test(error.message)
                ? "scope-error"
                : "unavailable",
      });
    }
  }
  if (sources.zimPath) {
    const resolved = await realpath(sources.zimPath);
    return {
      kind: "zim-available",
      path: resolved,
      artifactDigest: await hashFileStreaming(resolved),
      requiresApprovedReader: true,
      priorFailures: failures,
    };
  }
  if (failures.length > 0) {
    throw new Error(
      `Configured QaaS documentation sources were unavailable: ${failures
        .map((failure) => `${failure.source}:${failure.category}`)
        .join(", ")}`,
    );
  }
  throw new Error(
    "No QaaS documentation source is configured. Provide an approved read-only docs MCP or QAAS_DOCS_PRIMARY_URL.",
  );
}
