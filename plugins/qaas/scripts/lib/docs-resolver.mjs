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
import {
  assertDocsCapabilitiesBacked,
} from "./docs-mcp-probe.mjs";
import {
  BUILT_IN_QAAS_DOCS_URL,
  builtInEndpoint,
} from "./built-in-endpoints.mjs";
import { assertCredentialFreeQueryParameters } from "./url-safety.mjs";

const DEFAULT_OUTPUT_LIMIT = 16 * 1024;
const DOCUMENTATION_INDEX_INPUT_LIMIT = 256 * 1024;
const MAX_DOCUMENTATION_URL_BYTES = 4 * 1024;
export const DEFAULT_QAAS_DOCS_URL = BUILT_IN_QAAS_DOCS_URL;
export const QAAS_DOCS_CONFIGURATION_NAMES = Object.freeze([
  "QAAS_DOCS_HELM_URL",
  "QAAS_DOCS_WIKIALL_URL",
  "QAAS_DOCS_MCP_URL",
  "QAAS_DOCS_MCP_CREDENTIAL_ENV",
  "QAAS_DOCS_AIRGAP",
  "QAAS_DOCS_ZIM_PATH",
  "QAAS_DOCS_PRIMARY_URL",
  "QAAS_DOCS_SECONDARY_URL",
]);
export const QAAS_DOCS_RESOLUTION_ORDER = Object.freeze([
  "wikiall-mcp",
  "helm-http",
  "wikiall-http",
  "built-in-public",
]);
export const QAAS_DOCS_AIRGAP_RESOLUTION_ORDER = Object.freeze([
  "wikiall-mcp",
  "helm-http",
  "wikiall-http",
]);
export const QAAS_DOCS_DEPRECATED_ALIASES = Object.freeze({
  QAAS_DOCS_PRIMARY_URL: "QAAS_DOCS_HELM_URL",
  QAAS_DOCS_SECONDARY_URL: "QAAS_DOCS_WIKIALL_URL",
});

function configuredUrl(name, value) {
  if (!value) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_DOCUMENTATION_URL_BYTES) {
    throw new Error(`${name} exceeds the 4 KiB URL bound`);
  }
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
  if (url.hash) {
    throw new Error(`${name} may not contain a fragment`);
  }
  assertCredentialFreeQueryParameters(url, name);
  return url.toString();
}

function urlIdentity(url) {
  const parsed = new URL(url);
  return {
    protocol: parsed.protocol,
    origin: parsed.origin,
    pathname: parsed.pathname,
    queryParameterNames: [...parsed.searchParams.keys()].sort(),
    urlDigest: sha256(parsed.toString()),
  };
}

function configuredDocsUrl(name, alias, env) {
  const configuredRaw = env[name];
  const aliasRaw = env[alias];
  const configured = configuredRaw
    ? configuredUrl(name, configuredRaw)
    : null;
  const deprecated = aliasRaw
    ? configuredUrl(alias, aliasRaw)
    : null;
  if (configured && deprecated && configured !== deprecated) {
    throw new Error(
      `${name} conflicts with deprecated ${alias}; keep only the canonical selector`,
    );
  }
  return configured ?? deprecated;
}

function configuredDocsUrlIdentity(name, alias, env) {
  const selected = configuredDocsUrl(name, alias, env);
  const selectorPresent = Object.hasOwn(env, name);
  const aliasPresent = Object.hasOwn(env, alias);
  return {
    selector: name,
    selectorPresent,
    selectorValueDigest:
      selectorPresent ? sha256(String(env[name])) : null,
    deprecatedAlias: {
      selector: alias,
      selectorPresent: aliasPresent,
      selectorValueDigest:
        aliasPresent ? sha256(String(env[alias])) : null,
      selected: !env[name] && Boolean(env[alias]),
    },
    selectedBy: env[name] ? name : env[alias] ? alias : null,
    effective: selected ? urlIdentity(selected) : null,
  };
}

function builtInDocsIdentity() {
  const endpoint = builtInEndpoint("docs");
  return {
    selector: "built-in:qaas-docs",
    selectorPresent: true,
    selectorValueDigest: endpoint.urlDigest,
    effective: urlIdentity(endpoint.url),
  };
}

function configuredAirgapIdentity(env) {
  const selector = "QAAS_DOCS_AIRGAP";
  const selectorPresent = Object.hasOwn(env, selector);
  const raw = selectorPresent ? String(env[selector]).trim().toLowerCase() : "";
  let enabled = false;
  if (raw) {
    if (["true", "1", "yes"].includes(raw)) enabled = true;
    else if (!["false", "0", "no"].includes(raw)) {
      throw new Error(
        "QAAS_DOCS_AIRGAP must be true/false, 1/0, or yes/no",
      );
    }
  }
  return {
    selector,
    selectorPresent,
    selectorValueDigest:
      selectorPresent ? sha256(String(env[selector])) : null,
    enabled,
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

function configuredMcpCredentialSelector(env, mcpUrl) {
  const selector = env.QAAS_DOCS_MCP_CREDENTIAL_ENV ?? null;
  if (
    selector !== null &&
    (
      typeof selector !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(selector) ||
      /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(selector)
    )
  ) {
    throw new Error(
      "QAAS_DOCS_MCP_CREDENTIAL_ENV must name one safe credential variable",
    );
  }
  if (selector && !mcpUrl) {
    throw new Error(
      "QAAS_DOCS_MCP_CREDENTIAL_ENV requires QAAS_DOCS_MCP_URL",
    );
  }
  if (selector && mcpUrl) {
    const endpoint = new URL(mcpUrl);
    const loopback =
      endpoint.hostname === "127.0.0.1" ||
      endpoint.hostname === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/u.test(endpoint.hostname);
    if (endpoint.protocol !== "https:" && !loopback) {
      throw new Error(
        "Documentation MCP bearer credentials require HTTPS or an explicit loopback endpoint",
      );
    }
  }
  return selector;
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
  const airgap = configuredAirgapIdentity(env);
  const mcp = configuredMcpIdentity(env);
  const credentialSelector = configuredMcpCredentialSelector(
    env,
    env.QAAS_DOCS_MCP_URL
      ? configuredUrl("QAAS_DOCS_MCP_URL", env.QAAS_DOCS_MCP_URL)
      : null,
  );
  const attestation = {
    schemaVersion: "1.0",
    configurationNames: [...QAAS_DOCS_CONFIGURATION_NAMES],
    deprecatedAliases: { ...QAAS_DOCS_DEPRECATED_ALIASES },
    resolutionOrder: [
      ...(airgap.enabled
        ? QAAS_DOCS_AIRGAP_RESOLUTION_ORDER
        : QAAS_DOCS_RESOLUTION_ORDER),
    ],
    builtInEndpoints: {
      docs: builtInEndpoint("docs"),
    },
    builtInEndpointDigests: {
      docs: canonicalDigest(builtInEndpoint("docs")),
    },
    helm: configuredDocsUrlIdentity(
      "QAAS_DOCS_HELM_URL",
      "QAAS_DOCS_PRIMARY_URL",
      env,
    ),
    wikiAll: configuredDocsUrlIdentity(
      "QAAS_DOCS_WIKIALL_URL",
      "QAAS_DOCS_SECONDARY_URL",
      env,
    ),
    public: builtInDocsIdentity(),
    airgap,
    zim: await configuredZimIdentity(env),
    mcp,
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
  attestation.selectedSourceDigests = {
    "wikiall-mcp": attestation.mcp.effective?.urlDigest ?? null,
    "helm-http": attestation.helm.effective?.urlDigest ?? null,
    "wikiall-http": attestation.wikiAll.effective?.urlDigest ?? null,
    "built-in-public": airgap.enabled
      ? null
      : attestation.public.effective.urlDigest,
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
  probeEvidence = null,
  approvedTransport = null,
} = {}) {
  const airgap = configuredAirgapIdentity(env);
  let mcp = null;
  if (capabilityRegistry) {
    const validation = validateCapabilityRegistry(capabilityRegistry);
    if (!validation.valid) {
      throw new Error(
        `Invalid integration capability registry: ${validation.errors.join("; ")}`,
      );
    }
    assertDocsCapabilitiesBacked({
      registry: capabilityRegistry,
      evidence: probeEvidence,
      transport: approvedTransport,
    });
    const docsCapabilities = capabilityRegistry.capabilities.filter(
      (entry) =>
        ["docs.search", "docs.read"].includes(entry.logicalOperation) &&
        entry.classification === "read" &&
        entry.probePassed === true &&
        entry.userApproved === true,
    );
    const byServer = new Map();
    for (const capability of docsCapabilities) {
      const pair = byServer.get(capability.server) ?? {
        search: [],
        read: [],
      };
      if (capability.logicalOperation === "docs.search") {
        pair.search.push(capability);
      } else {
        pair.read.push(capability);
      }
      byServer.set(capability.server, pair);
    }
    const completePairs = [...byServer.values()].filter(
      (pair) => pair.search.length > 0 && pair.read.length > 0,
    );
    if (
      completePairs.length > 1 ||
      completePairs.some(
        (pair) => pair.search.length !== 1 || pair.read.length !== 1,
      )
    ) {
      throw new Error(
        "Multiple approved documentation MCP capability pairs are ambiguous",
      );
    }
    if (completePairs.length === 1) {
      mcp = {
        search: completePairs[0].search[0],
        read: completePairs[0].read[0],
      };
    }
  }
  const mcpUrl = configuredUrl(
    "QAAS_DOCS_MCP_URL",
    env.QAAS_DOCS_MCP_URL,
  );
  configuredMcpCredentialSelector(env, mcpUrl);
  const helmUrl = configuredDocsUrl(
    "QAAS_DOCS_HELM_URL",
    "QAAS_DOCS_PRIMARY_URL",
    env,
  );
  const wikiAllUrl = configuredDocsUrl(
    "QAAS_DOCS_WIKIALL_URL",
    "QAAS_DOCS_SECONDARY_URL",
    env,
  );
  const orderedHttpSources = [
    { source: "helm-http", baseUrl: helmUrl },
    { source: "wikiall-http", baseUrl: wikiAllUrl },
    ...(airgap.enabled
      ? []
      : [{ source: "built-in-public", baseUrl: DEFAULT_QAAS_DOCS_URL }]),
  ].filter((entry) => entry.baseUrl);
  const seen = new Set();
  const httpSources = orderedHttpSources.filter((entry) => {
    if (seen.has(entry.baseUrl)) return false;
    seen.add(entry.baseUrl);
    return true;
  });
  return {
    mcp,
    builtInEndpoints: {
      docs: builtInEndpoint("docs"),
    },
    resolutionOrder: [
      ...(airgap.enabled
        ? QAAS_DOCS_AIRGAP_RESOLUTION_ORDER
        : QAAS_DOCS_RESOLUTION_ORDER),
    ],
    airgap,
    mcpUrl,
    helmUrl,
    wikiAllUrl,
    builtInUrl: airgap.enabled ? null : DEFAULT_QAAS_DOCS_URL,
    httpSources,
    primaryUrl: httpSources[0]?.baseUrl ?? null,
    secondaryUrl: httpSources[1]?.baseUrl ?? null,
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
  assertCredentialFreeQueryParameters(requested, "Documentation request");
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
      headers: {
        Accept:
          "text/plain, text/markdown, text/html, application/xml, application/json",
      },
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

function isMcpAvailabilityError(error) {
  if (error?.name === "AbortError") return true;
  return ["timeout", "unavailable"].includes(error?.mcpAvailability);
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

function normalizedSearchTokens(value) {
  return String(value)
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((term) => term.length >= 2)
    .map((term) => {
      if (term.length > 4 && term.endsWith("ies")) {
        return `${term.slice(0, -3)}y`;
      }
      if (term.length > 3 && term.endsWith("s") && !term.endsWith("ss")) {
        return term.slice(0, -1);
      }
      return term;
    });
}

function scopedIndexTarget(href, base) {
  let target;
  try {
    target = new URL(href, base);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(target.protocol)) return null;
  if (target.username || target.password) return null;
  try {
    assertCredentialFreeQueryParameters(target, "Documentation index link");
  } catch {
    return null;
  }
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  if (target.origin !== base.origin) {
    const publishedPrefix = "/qaas-docs/";
    if (!target.pathname.startsWith(publishedPrefix)) return null;
    const transplanted = new URL(base);
    transplanted.pathname =
      `${basePath}${target.pathname.slice(publishedPrefix.length)}`;
    target = transplanted;
  }
  if (
    target.pathname !== base.pathname &&
    !target.pathname.startsWith(basePath)
  ) {
    return null;
  }
  target.username = "";
  target.password = "";
  target.search = "";
  target.hash = "";
  return target;
}

function searchIndexCandidates(html, baseUrl, query, limit = 10) {
  const base = new URL(baseUrl);
  const terms = [...new Set(normalizedSearchTokens(query))].slice(0, 12);
  const candidates = [];
  const addCandidate = (href, rawTitle) => {
    const target = scopedIndexTarget(href, base);
    if (!target) return;
    const targetUrl = target.toString();
    if (
      Buffer.byteLength(targetUrl, "utf8") >
      MAX_DOCUMENTATION_URL_BYTES
    ) {
      return;
    }
    const title = stripMarkup(rawTitle).slice(0, 240);
    let decodedPath = target.pathname;
    try {
      decodedPath = decodeURIComponent(target.pathname);
    } catch {
      // Preserve the validated encoded path when it contains malformed escapes.
    }
    const tokens = new Set(normalizedSearchTokens(`${title} ${decodedPath}`));
    const score = terms.reduce(
      (total, term) => total + (tokens.has(term) ? 1 : 0),
      0,
    );
    if (terms.length > 0 && score === 0) return;
    candidates.push({
      title: title || path.posix.basename(target.pathname) || "documentation",
      url: targetUrl,
      score,
    });
  };
  const anchor =
    /<a\b[^>]*\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))[^>]*>([\s\S]*?)<\/a>/giu;
  for (const match of html.matchAll(anchor)) {
    addCandidate(match[1] ?? match[2] ?? match[3] ?? "", match[4]);
  }
  const markdownLink = /\[([^\]\r\n]{1,240})\]\(([^)\s]+)\)/gu;
  for (const match of html.matchAll(markdownLink)) {
    addCandidate(match[2], match[1]);
  }
  const sitemapLocation = /<loc>\s*([^<\s]+)\s*<\/loc>/giu;
  for (const match of html.matchAll(sitemapLocation)) {
    addCandidate(match[1], match[1]);
  }
  return [...new Map(candidates.map((entry) => [entry.url, entry])).values()]
    .sort(
      (left, right) =>
        right.score - left.score ||
        (left.url < right.url ? -1 : left.url > right.url ? 1 : 0),
    )
    .slice(0, limit);
}

function documentationHttpStatus(error) {
  const match = String(error?.message ?? "").match(
    /Documentation source returned HTTP (\d{3})/u,
  );
  return match ? Number(match[1]) : null;
}

function isHttpDocumentationAvailabilityError(error) {
  if (error?.name === "AbortError") return true;
  const status = documentationHttpStatus(error);
  if (
    status === 404 ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status !== null && status >= 500)
  ) {
    return true;
  }
  return /(?:fetch failed|ECONN|ENOTFOUND|EAI_AGAIN|network|socket)/iu.test(
    String(error?.message ?? ""),
  );
}

function documentationAvailabilityCategory(error) {
  if (
    error?.name === "AbortError" ||
    /timed?\s*out/iu.test(String(error?.message ?? ""))
  ) {
    return "timeout";
  }
  return documentationHttpStatus(error) === null ? "unavailable" : "http-error";
}

function documentationIndexUrl(baseUrl, name) {
  const base = new URL(baseUrl);
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  base.pathname = `${basePath}${name}`;
  base.search = "";
  base.hash = "";
  return base.toString();
}

export async function searchConfiguredDocumentationIndex(
  baseUrl,
  query,
  { outputLimitBytes = DEFAULT_OUTPUT_LIMIT, timeoutMs = 10_000 } = {},
) {
  if (
    typeof baseUrl !== "string" ||
    Buffer.byteLength(baseUrl, "utf8") > MAX_DOCUMENTATION_URL_BYTES
  ) {
    throw new Error("Documentation base URL exceeds the 4 KiB URL bound");
  }
  const effectiveOutputLimitBytes = Math.min(
    outputLimitBytes,
    DEFAULT_OUTPUT_LIMIT,
  );
  const indexes = [
    { kind: "llms", url: documentationIndexUrl(baseUrl, "llms.txt") },
    { kind: "sitemap", url: documentationIndexUrl(baseUrl, "sitemap.xml") },
    { kind: "homepage", url: baseUrl },
  ];
  let selected = null;
  let lastAvailabilityError = null;
  for (const index of indexes) {
    let text;
    try {
      text = await fetchBounded(index.url, {
        outputLimitBytes: DOCUMENTATION_INDEX_INPUT_LIMIT,
        timeoutMs,
        allowedBase: baseUrl,
      });
    } catch (error) {
      if (!isHttpDocumentationAvailabilityError(error)) throw error;
      lastAvailabilityError = error;
      continue;
    }
    const candidates = searchIndexCandidates(text, baseUrl, query);
    selected = { ...index, candidates };
    if (candidates.length > 0) break;
  }
  if (!selected) {
    throw (
      lastAvailabilityError ??
      new Error("Documentation index is unavailable")
    );
  }
  const matchedCandidates = selected.candidates;
  const baseResult = {
    kind: "configured-url-search",
    baseUrl,
    queryDigest: sha256(query.trim()),
    indexKind: selected.kind,
    requiresFocusedPage: true,
  };
  let candidates = [];
  for (const candidate of matchedCandidates) {
    const tentativeCandidates = [...candidates, candidate];
    const candidatePayload = JSON.stringify(tentativeCandidates);
    const tentativeResult = {
      ...baseResult,
      candidateCount: tentativeCandidates.length,
      candidates: tentativeCandidates,
      excerptHash: sha256(candidatePayload),
      truncated: tentativeCandidates.length < matchedCandidates.length,
      byteLength: Buffer.byteLength(candidatePayload, "utf8"),
    };
    if (
      Buffer.byteLength(JSON.stringify(tentativeResult), "utf8") >
      effectiveOutputLimitBytes
    ) {
      break;
    }
    candidates = tentativeCandidates;
  }
  const candidatePayload = JSON.stringify(candidates);
  const result = {
    ...baseResult,
    candidateCount: candidates.length,
    candidates,
    excerptHash: sha256(candidatePayload),
    truncated: candidates.length < matchedCandidates.length,
    byteLength: Buffer.byteLength(candidatePayload, "utf8"),
  };
  if (
    Buffer.byteLength(JSON.stringify(result), "utf8") >
    effectiveOutputLimitBytes
  ) {
    throw new Error(
      "Documentation search result exceeds the configured output bound",
    );
  }
  return result;
}

function boundResolvedSearchResult(result, outputLimitBytes) {
  const bounded = {
    ...result,
    candidates: [...result.candidates],
  };
  const refreshCandidateMetadata = () => {
    const payload = JSON.stringify(bounded.candidates);
    bounded.candidateCount = bounded.candidates.length;
    bounded.excerptHash = sha256(payload);
    bounded.byteLength = Buffer.byteLength(payload, "utf8");
  };
  refreshCandidateMetadata();
  while (
    bounded.candidates.length > 0 &&
    Buffer.byteLength(JSON.stringify(bounded), "utf8") > outputLimitBytes
  ) {
    bounded.candidates.pop();
    refreshCandidateMetadata();
    bounded.truncated = true;
  }
  if (Buffer.byteLength(JSON.stringify(bounded), "utf8") > outputLimitBytes) {
    throw new Error(
      "Documentation search result exceeds the configured output bound",
    );
  }
  return bounded;
}

function documentationUrlWithinBase(candidateUrl, baseUrl) {
  let candidate;
  let base;
  try {
    candidate = new URL(candidateUrl);
    base = new URL(baseUrl);
  } catch {
    return false;
  }
  const basePath = base.pathname.endsWith("/")
    ? base.pathname
    : `${base.pathname}/`;
  return (
    candidate.origin === base.origin &&
    (candidate.pathname === base.pathname ||
      candidate.pathname.startsWith(basePath))
  );
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
  selectedSource = null,
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
  const effectiveOutputLimitBytes = Math.min(
    outputLimitBytes,
    DEFAULT_OUTPUT_LIMIT,
  );
  if (
    selectedSource !== null &&
    (typeof selectedSource !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(selectedSource))
  ) {
    throw new Error("Documentation selectedSource is invalid");
  }
  const failures = [];
  if (
    sources.mcp &&
    typeof callMcp === "function" &&
    selectedSource === null
  ) {
    try {
      const capability = relativeUrl ? sources.mcp.read : sources.mcp.search;
      const input = capabilityInput(
        capability,
        relativeUrl
          ? {
              identifier: relativeUrl,
              limit: Math.min(
                effectiveOutputLimitBytes,
                capability.outputLimitBytes,
              ),
            }
          : {
              query,
              limit: Math.min(10, capability.outputLimitItems ?? 10),
            },
      );
      const results = await callMcp(capability, input);
      const boundedSearch = boundedExcerpt(
        JSON.stringify(results),
        Math.min(effectiveOutputLimitBytes, capability.outputLimitBytes),
      );
      return {
        kind: relativeUrl ? "mcp-read" : "mcp-search",
        source: "wikiall-mcp",
        capabilityId: capability.id,
        ...boundedSearch,
      };
    } catch (error) {
      if (!isMcpAvailabilityError(error)) throw error;
      failures.push({
        source: "wikiall-mcp",
        category:
          error?.name === "AbortError" ||
          error?.mcpAvailability === "timeout"
            ? "timeout"
            : "unavailable",
      });
    }
  }
  const httpSources = Array.isArray(sources.httpSources)
    ? sources.httpSources
    : [
        { source: "primary", baseUrl: sources.primaryUrl },
        { source: "secondary", baseUrl: sources.secondaryUrl },
      ].filter((entry) => entry.baseUrl);
  let focusedHttpSources = httpSources;
  if (relativeUrl && selectedSource !== null) {
    focusedHttpSources = httpSources.filter(
      (entry) => entry.source === selectedSource,
    );
    if (focusedHttpSources.length !== 1) {
      throw new Error(
        `Focused documentation source is unavailable: ${selectedSource}`,
      );
    }
  } else if (relativeUrl) {
    let absoluteUrl = null;
    try {
      absoluteUrl = new URL(relativeUrl).toString();
    } catch {
      // A relative identifier is safe only when one HTTP source is available.
    }
    if (absoluteUrl) {
      focusedHttpSources = httpSources.filter((entry) =>
        documentationUrlWithinBase(absoluteUrl, entry.baseUrl),
      );
      if (focusedHttpSources.length !== 1) {
        throw new Error(
          "Focused documentation URL must match exactly one configured source",
        );
      }
    } else if (httpSources.length !== 1) {
      throw new Error(
        "Relative documentation identifiers require an exact selectedSource",
      );
    }
  }
  for (const { source, baseUrl } of focusedHttpSources) {
    if (!relativeUrl) {
      try {
        const searchResult = await searchConfiguredDocumentationIndex(
          baseUrl,
          query,
          {
            outputLimitBytes: effectiveOutputLimitBytes,
            timeoutMs,
          },
        );
        return boundResolvedSearchResult({
          ...searchResult,
          candidates: searchResult.candidates.map((candidate) => ({
            ...candidate,
            source,
          })),
          source,
          priorFailures: failures,
        }, effectiveOutputLimitBytes);
      } catch (error) {
        if (!isHttpDocumentationAvailabilityError(error)) throw error;
        failures.push({
          source,
          category: documentationAvailabilityCategory(error),
        });
        continue;
      }
    }
    try {
      const text = await fetchBounded(relativeUrl, {
        outputLimitBytes: effectiveOutputLimitBytes,
        timeoutMs,
        allowedBase: baseUrl,
      });
      return {
        kind: "http-read",
        sourceKind: source,
        source: new URL(relativeUrl, baseUrl).toString(),
        ...boundedExcerpt(text, effectiveOutputLimitBytes),
        priorFailures: failures,
      };
    } catch (error) {
      if (!isHttpDocumentationAvailabilityError(error)) throw error;
      failures.push({
        source,
        category: documentationAvailabilityCategory(error),
      });
    }
  }
  if (sources.zimPath) {
    throw new Error(
      "QAAS_DOCS_ZIM_PATH identifies an artifact but is not a documentation reader; configure an approved OpenZIM/WikiAll MCP with QAAS_DOCS_MCP_URL",
    );
  }
  if (failures.length > 0) {
    throw new Error(
      `Configured QaaS documentation sources were unavailable: ${failures
        .map((failure) => `${failure.source}:${failure.category}`)
        .join(", ")}`,
    );
  }
  throw new Error(
    sources.airgap?.enabled
      ? "No configured air-gapped QaaS documentation source is available; public fallback is disabled"
      : "The built-in QaaS documentation source is unavailable.",
  );
}
