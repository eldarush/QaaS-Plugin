import {
  canonicalDigest,
  canonicalJson,
  isSha256,
  safeEqualHex,
} from "./canonical-json.mjs";

export const DOCS_MCP_PROBE_PROTOCOL_VERSION = "2025-03-26";
export const DOCS_MCP_PROBE_DEFINITION =
  "one-attempt initialize plus tools/list schema discovery; transaction-wide timeout and aggregate response-byte bound; no tools/call";
export const DOCS_MCP_PROBE_OPERATIONS = Object.freeze([
  "initialize",
  "notifications/initialized",
  "tools/list",
]);
export const DEFAULT_DOCS_MCP_PROBE_BOUNDS = Object.freeze({
  timeoutMs: 10_000,
  outputLimitBytes: 64 * 1024,
  requestLimit: DOCS_MCP_PROBE_OPERATIONS.length,
  toolLimit: 64,
  schemaLimitBytes: 16 * 1024,
});

function boundedInteger(value, fallback, minimum, maximum, label) {
  const resolved = value === undefined ? fallback : Number(value);
  if (
    !Number.isSafeInteger(resolved) ||
    resolved < minimum ||
    resolved > maximum
  ) {
    throw new Error(
      `${label} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return resolved;
}

export function docsMcpProbeRequest(args = {}) {
  const server = args.server;
  if (
    typeof server !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(server)
  ) {
    throw new Error(
      "Documentation MCP discovery requires --server with the exact reviewed MCP server name",
    );
  }
  return {
    server,
    bounds: {
      timeoutMs: boundedInteger(
        args["timeout-ms"],
        DEFAULT_DOCS_MCP_PROBE_BOUNDS.timeoutMs,
        1,
        60_000,
        "--timeout-ms",
      ),
      outputLimitBytes: boundedInteger(
        args["output-limit-bytes"],
        DEFAULT_DOCS_MCP_PROBE_BOUNDS.outputLimitBytes,
        1_024,
        256 * 1024,
        "--output-limit-bytes",
      ),
      requestLimit: DEFAULT_DOCS_MCP_PROBE_BOUNDS.requestLimit,
      toolLimit: boundedInteger(
        args["tool-limit"],
        DEFAULT_DOCS_MCP_PROBE_BOUNDS.toolLimit,
        1,
        256,
        "--tool-limit",
      ),
      schemaLimitBytes: boundedInteger(
        args["schema-limit-bytes"],
        DEFAULT_DOCS_MCP_PROBE_BOUNDS.schemaLimitBytes,
        256,
        64 * 1024,
        "--schema-limit-bytes",
      ),
    },
  };
}

export function createDocsMcpProbeReview({
  projectId,
  phase,
  transport,
  request,
}) {
  if (
    !transport ||
    transport.configured !== true ||
    typeof transport.endpoint !== "string"
  ) {
    throw new Error(
      "Documentation MCP discovery requires QAAS_DOCS_MCP_URL",
    );
  }
  const review = {
    schemaVersion: "1.0",
    kind: "docs-mcp-probe",
    projectId,
    phase,
    oneUse: true,
    server: request.server,
    transport,
    transportDigest: canonicalDigest(transport),
    protocolVersion: DOCS_MCP_PROBE_PROTOCOL_VERSION,
    operations: [...DOCS_MCP_PROBE_OPERATIONS],
    bounds: { ...request.bounds },
    probeDefinition: DOCS_MCP_PROBE_DEFINITION,
    toolsCallPermitted: false,
    credentialValuesPersisted: false,
  };
  review.digest = canonicalDigest(review);
  return review;
}

function exactKeys(value, allowed, label, errors) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${label}.${key} is not allowed`);
  }
}

export function validateDocsMcpProbeEvidence(evidence) {
  const errors = [];
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return { valid: false, errors: ["probe evidence must be an object"] };
  }
  exactKeys(
    evidence,
    new Set([
      "schemaVersion",
      "projectId",
      "server",
      "transportDigest",
      "protocolVersion",
      "sessionMode",
      "operations",
      "bounds",
      "probeDefinition",
      "passed",
      "toolsCallPerformed",
      "probedAt",
      "tools",
      "digest",
    ]),
    "probe",
    errors,
  );
  if (evidence.schemaVersion !== "1.0") {
    errors.push("probe.schemaVersion must be 1.0");
  }
  if (typeof evidence.projectId !== "string" || evidence.projectId === "") {
    errors.push("probe.projectId is required");
  }
  if (
    typeof evidence.server !== "string" ||
    !/^[A-Za-z0-9._-]{1,64}$/u.test(evidence.server)
  ) {
    errors.push("probe.server is invalid");
  }
  if (!isSha256(evidence.transportDigest)) {
    errors.push("probe.transportDigest must be SHA-256");
  }
  if (evidence.protocolVersion !== DOCS_MCP_PROBE_PROTOCOL_VERSION) {
    errors.push("probe.protocolVersion is unsupported");
  }
  if (!["stateful", "stateless"].includes(evidence.sessionMode)) {
    errors.push("probe.sessionMode must be stateful or stateless");
  }
  if (
    canonicalJson(evidence.operations ?? null) !==
    canonicalJson(DOCS_MCP_PROBE_OPERATIONS)
  ) {
    errors.push("probe.operations must be the discovery-only operation set");
  }
  if (evidence.probeDefinition !== DOCS_MCP_PROBE_DEFINITION) {
    errors.push("probe.probeDefinition is invalid");
  }
  if (evidence.passed !== true) errors.push("probe.passed must be true");
  if (evidence.toolsCallPerformed !== false) {
    errors.push("probe.toolsCallPerformed must be false");
  }
  if (
    typeof evidence.probedAt !== "string" ||
    !Number.isFinite(Date.parse(evidence.probedAt))
  ) {
    errors.push("probe.probedAt must be an RFC 3339 date-time");
  }
  if (
    !evidence.bounds ||
    typeof evidence.bounds !== "object" ||
    Array.isArray(evidence.bounds)
  ) {
    errors.push("probe.bounds must be an object");
  } else {
    exactKeys(
      evidence.bounds,
      new Set([
        "timeoutMs",
        "outputLimitBytes",
        "requestLimit",
        "toolLimit",
        "schemaLimitBytes",
      ]),
      "probe.bounds",
      errors,
    );
    if (
      evidence.bounds.requestLimit !==
      DEFAULT_DOCS_MCP_PROBE_BOUNDS.requestLimit
    ) {
      errors.push(
        `probe.bounds.requestLimit must be ${DEFAULT_DOCS_MCP_PROBE_BOUNDS.requestLimit}`,
      );
    }
  }
  let request;
  try {
    request = docsMcpProbeRequest({
      server: evidence.server,
      "timeout-ms": evidence.bounds?.timeoutMs,
      "output-limit-bytes": evidence.bounds?.outputLimitBytes,
      "tool-limit": evidence.bounds?.toolLimit,
      "schema-limit-bytes": evidence.bounds?.schemaLimitBytes,
    });
  } catch (error) {
    errors.push(`probe.bounds are invalid: ${error.message}`);
  }
  if (!Array.isArray(evidence.tools)) {
    errors.push("probe.tools must be an array");
  } else {
    const names = new Set();
    if (request && evidence.tools.length > request.bounds.toolLimit) {
      errors.push("probe.tools exceeds the reviewed tool limit");
    }
    evidence.tools.forEach((tool, index) => {
      const label = `probe.tools[${index}]`;
      if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
        errors.push(`${label} must be an object`);
        return;
      }
      exactKeys(
        tool,
        new Set(["name", "inputSchema", "schemaDigest", "schemaBytes"]),
        label,
        errors,
      );
      if (
        typeof tool.name !== "string" ||
        tool.name.length < 1 ||
        tool.name.length > 128 ||
        !/^[\x21-\x7e]+$/u.test(tool.name)
      ) {
        errors.push(`${label}.name is invalid`);
      } else if (names.has(tool.name)) {
        errors.push(`${label}.name is duplicated`);
      } else {
        names.add(tool.name);
      }
      if (
        !tool.inputSchema ||
        typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema)
      ) {
        errors.push(`${label}.inputSchema must be an object`);
      } else {
        const schemaBytes = Buffer.byteLength(
          canonicalJson(tool.inputSchema),
          "utf8",
        );
        if (schemaBytes !== tool.schemaBytes) {
          errors.push(`${label}.schemaBytes is incorrect`);
        }
        if (request && schemaBytes > request.bounds.schemaLimitBytes) {
          errors.push(`${label}.inputSchema exceeds the reviewed byte limit`);
        }
        if (
          !isSha256(tool.schemaDigest) ||
          !safeEqualHex(
            tool.schemaDigest,
            canonicalDigest(tool.inputSchema),
          )
        ) {
          errors.push(`${label}.schemaDigest does not match inputSchema`);
        }
      }
    });
  }
  if (
    !isSha256(evidence.digest) ||
    !safeEqualHex(evidence.digest, canonicalDigest(evidence))
  ) {
    errors.push("probe.digest is missing or stale");
  }
  if (
    request &&
    Buffer.byteLength(canonicalJson(evidence), "utf8") >
      request.bounds.outputLimitBytes
  ) {
    errors.push("probe evidence exceeds the reviewed output byte limit");
  }
  return { valid: errors.length === 0, errors };
}

export function assertDocsCapabilitiesBacked({
  registry,
  evidence,
  transport,
  projectId = null,
}) {
  const capabilities = registry?.capabilities?.filter(
    (entry) =>
      ["docs.search", "docs.read"].includes(entry.logicalOperation) &&
      entry.probePassed === true,
  ) ?? [];
  if (capabilities.length === 0) return null;
  const validation = validateDocsMcpProbeEvidence(evidence);
  if (!validation.valid) {
    throw new Error(
      `Documentation MCP capabilities lack valid probe evidence: ${validation.errors.join("; ")}`,
    );
  }
  if (projectId !== null && evidence.projectId !== projectId) {
    throw new Error("Documentation MCP probe belongs to a different project");
  }
  if (
    !transport ||
    !safeEqualHex(
      evidence.transportDigest,
      canonicalDigest(transport),
    )
  ) {
    throw new Error(
      "Documentation MCP probe transport differs from the reviewed transport",
    );
  }
  const tools = new Map(evidence.tools.map((entry) => [entry.name, entry]));
  for (const capability of capabilities) {
    const tool = tools.get(capability.tool);
    if (
      capability.server !== evidence.server ||
      !safeEqualHex(capability.probeEvidenceDigest, evidence.digest) ||
      !tool ||
      !safeEqualHex(tool.schemaDigest, capability.schemaDigest)
    ) {
      throw new Error(
        `Documentation capability ${capability.id} is not backed by the current bounded schema probe`,
      );
    }
  }
  return evidence;
}
