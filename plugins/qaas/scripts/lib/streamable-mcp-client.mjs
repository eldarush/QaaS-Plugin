import {
  canonicalDigest,
  canonicalJson,
} from "./canonical-json.mjs";
import {
  DOCS_MCP_PROBE_OPERATIONS,
  DOCS_MCP_PROBE_PROTOCOL_VERSION,
} from "./docs-mcp-probe.mjs";
import { secretFindings } from "./redact.mjs";

const PROTOCOL_VERSION = DOCS_MCP_PROBE_PROTOCOL_VERSION;
const MAX_PROTOCOL_BYTES = 1024 * 1024;
const FETCH_TRANSPORT_ERROR_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "ENOTFOUND",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function configuredEndpoint(env) {
  const raw = env.QAAS_DOCS_MCP_URL;
  if (!raw) return null;
  const endpoint = new URL(raw);
  if (!["http:", "https:"].includes(endpoint.protocol)) {
    throw new Error("QAAS_DOCS_MCP_URL must use HTTP or HTTPS");
  }
  if (endpoint.username || endpoint.password || endpoint.hash) {
    throw new Error("QAAS_DOCS_MCP_URL may not contain credentials or fragments");
  }
  for (const [key, value] of endpoint.searchParams) {
    if (
      /(?:token|secret|password|auth|credential|api[-_]?key)/iu.test(key) ||
      secretFindings(value).length > 0
    ) {
      throw new Error("QAAS_DOCS_MCP_URL may not contain credential query data");
    }
  }
  return endpoint;
}

function credential(env) {
  const name = env.QAAS_DOCS_MCP_CREDENTIAL_ENV;
  if (!name) return { name: null, value: null };
  if (
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
    /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(name)
  ) {
    throw new Error(
      "QAAS_DOCS_MCP_CREDENTIAL_ENV must name one user-selected environment variable",
    );
  }
  const value = env[name];
  if (!value) throw new Error(`Configured MCP credential variable ${name} is unset`);
  if (
    Buffer.byteLength(value, "utf8") > 8 * 1024 ||
    !/^[\x21-\x7e]+$/u.test(value)
  ) {
    throw new Error(
      `Configured MCP credential variable ${name} must contain at most 8 KiB of visible ASCII`,
    );
  }
  return { name, value };
}

function explicitLoopback(hostname) {
  return (
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

export function describeMcpTransport(env = process.env) {
  const endpoint = configuredEndpoint(env);
  const credentialEnv = env.QAAS_DOCS_MCP_CREDENTIAL_ENV ?? null;
  if (
    credentialEnv !== null &&
    (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnv) ||
      /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(credentialEnv))
  ) {
    throw new Error(
      "QAAS_DOCS_MCP_CREDENTIAL_ENV must name one user-selected environment variable",
    );
  }
  if (
    endpoint &&
    credentialEnv &&
    endpoint.protocol !== "https:" &&
    !explicitLoopback(endpoint.hostname)
  ) {
    throw new Error(
      "Documentation MCP bearer credentials require HTTPS or an explicit loopback endpoint",
    );
  }
  const description = {
    schemaVersion: "1.0",
    configured: Boolean(endpoint),
    endpoint: endpoint?.toString() ?? null,
    origin: endpoint?.origin ?? null,
    credentialEnv,
  };
  description.digest = canonicalDigest(description);
  return description;
}

async function boundedResponse(response, limitBytes) {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > limitBytes) {
    throw new Error("MCP response exceeds the deterministic byte bound");
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limitBytes) {
      await reader.cancel();
      throw new Error("MCP response exceeds the deterministic byte bound");
    }
    chunks.push(value);
  }
  return {
    bytes: total,
    text: Buffer.concat(chunks).toString("utf8"),
  };
}

function parseSseMessages(text) {
  const messages = [];
  for (const event of text.split(/\r?\n\r?\n/u)) {
    const data = event
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /u, ""))
      .join("\n");
    if (data.trim() === "") continue;
    messages.push(JSON.parse(data));
  }
  return messages;
}

function parseMessage(text, expectedId) {
  const trimmed = text.trim();
  const parsed =
    trimmed.startsWith("{") || trimmed.startsWith("[")
      ? JSON.parse(trimmed)
      : parseSseMessages(trimmed);
  const messages = Array.isArray(parsed) ? parsed : [parsed];
  if (expectedId === undefined) {
    const error = messages.find((message) => message?.error);
    if (error) {
      throw new Error(
        `MCP JSON-RPC error ${error.error.code ?? "unknown"}: ${String(
          error.error.message ?? "request failed",
        ).slice(0, 240)}`,
      );
    }
    return null;
  }
  const matching = messages.filter((message) => message?.id === expectedId);
  if (matching.length !== 1) {
    throw new Error(
      `MCP response must contain exactly one JSON-RPC result for request ${expectedId}`,
    );
  }
  const [message] = matching;
  if (message.error) {
    throw new Error(
      `MCP JSON-RPC error ${message.error.code ?? "unknown"}: ${String(
        message.error.message ?? "request failed",
      ).slice(0, 240)}`,
    );
  }
  return message;
}

function toolResult(message) {
  if (message.result?.isError === true) {
    throw new Error("Documentation MCP tool reported an error");
  }
  const blocks = message.result?.content;
  if (!Array.isArray(blocks)) return message.result;
  const textBlocks = blocks.filter((entry) => entry?.type === "text");
  if (textBlocks.length !== 1 || typeof textBlocks[0].text !== "string") {
    throw new Error("Documentation MCP must return exactly one text content block");
  }
  try {
    return JSON.parse(textBlocks[0].text);
  } catch {
    return textBlocks[0].text;
  }
}

function apparentItemCount(result) {
  let maximum = 1;
  const visit = (value) => {
    if (Array.isArray(value)) {
      maximum = Math.max(maximum, value.length);
      for (const entry of value) visit(entry);
      return;
    }
    if (!value || typeof value !== "object") return;
    for (const entry of Object.values(value)) visit(entry);
  };
  visit(result);
  return maximum;
}

export function createStreamableMcpCaller({
  env = process.env,
  timeoutMs = 10_000,
  approvedTransport = null,
  toolListOutputLimitBytes = 256 * 1024,
  toolLimit = 256,
  schemaLimitBytes = 64 * 1024,
} = {}) {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000 ||
    !Number.isSafeInteger(toolListOutputLimitBytes) ||
    toolListOutputLimitBytes < 1_024 ||
    toolListOutputLimitBytes > 256 * 1024 ||
    !Number.isSafeInteger(toolLimit) ||
    toolLimit < 1 ||
    toolLimit > 256 ||
    !Number.isSafeInteger(schemaLimitBytes) ||
    schemaLimitBytes < 256 ||
    schemaLimitBytes > 64 * 1024
  ) {
    throw new Error("Documentation MCP discovery bounds are invalid");
  }
  const endpoint = configuredEndpoint(env);
  if (!endpoint) return null;
  const currentTransport = describeMcpTransport(env);
  if (
    !approvedTransport ||
    canonicalDigest(approvedTransport) !== canonicalDigest(currentTransport)
  ) {
    throw new Error(
      "Documentation MCP endpoint/origin and credential selector lack exact signed approval",
    );
  }
  const auth = credential(env);
  let requestId = 0;
  let sessionId = null;
  let negotiatedProtocolVersion = null;
  let initialized = false;
  let liveTools = null;
  let discoveredTools = null;

  const post = async (
    payload,
    outputLimitBytes = MAX_PROTOCOL_BYTES,
    transactionBudget = null,
  ) => {
    const requestTimeoutMs = transactionBudget
      ? transactionBudget.deadlineMs - Date.now()
      : timeoutMs;
    if (requestTimeoutMs <= 0) {
      throw new Error(
        "Documentation MCP discovery exceeded the reviewed transaction timeout",
      );
    }
    if (transactionBudget) {
      if (transactionBudget.remainingRequests <= 0) {
        throw new Error(
          "Documentation MCP discovery exceeded the reviewed request limit",
        );
      }
      transactionBudget.remainingRequests -= 1;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    timer.unref?.();
    const requestUsedSession = sessionId !== null;
    try {
      let response;
      try {
        response = await fetch(endpoint, {
          method: "POST",
          redirect: "error",
          signal: controller.signal,
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
            ...(auth.value ? { Authorization: `Bearer ${auth.value}` } : {}),
            ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
            ...(negotiatedProtocolVersion
              ? { "MCP-Protocol-Version": negotiatedProtocolVersion }
              : {}),
          },
          body: JSON.stringify(payload),
        });
      } catch (error) {
        if (error?.name === "AbortError") {
          error.mcpAvailability = "timeout";
          throw error;
        }
        if (FETCH_TRANSPORT_ERROR_CODES.has(error?.cause?.code)) {
          const transportError = new Error(
            "Documentation MCP transport is unavailable",
          );
          transportError.mcpAvailability = "unavailable";
          throw transportError;
        }
        throw error;
      }
      if (!response.ok) {
        const error = new Error(
          `Documentation MCP returned HTTP ${response.status}`,
        );
        error.mcpStatus = response.status;
        error.requestUsedSession = requestUsedSession;
        if (
          response.status === 404 ||
          response.status === 408 ||
          response.status === 425 ||
          response.status === 429 ||
          response.status >= 500
        ) {
          error.mcpAvailability =
            response.status === 408 ? "timeout" : "unavailable";
        }
        throw error;
      }
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) {
        if (
          nextSession.length > 1024 ||
          !/^[\x21-\x7e]+$/u.test(nextSession)
        ) {
          throw new Error(
            "Documentation MCP returned an invalid session identifier",
          );
        }
        sessionId = nextSession;
      }
      let bounded;
      try {
        bounded = await boundedResponse(
          response,
          Math.min(
            MAX_PROTOCOL_BYTES,
            outputLimitBytes,
            transactionBudget?.remainingBytes ?? MAX_PROTOCOL_BYTES,
          ),
        );
      } catch (error) {
        if (error?.name === "AbortError") {
          error.mcpAvailability = "timeout";
        }
        throw error;
      }
      if (transactionBudget) {
        transactionBudget.remainingBytes -= bounded.bytes;
      }
      const { text } = bounded;
      return payload.id === undefined && text.trim() === ""
        ? null
        : parseMessage(text, payload.id);
    } finally {
      clearTimeout(timer);
    }
  };

  const request = (
    method,
    params,
    limit,
    transactionBudget = null,
  ) =>
    post(
      {
        jsonrpc: "2.0",
        id: ++requestId,
        method,
        params,
      },
      limit,
      transactionBudget,
    );

  const initialize = async (transactionBudget = null) => {
    if (initialized) {
      if (transactionBudget) {
        throw new Error(
          "Documentation MCP discovery requires a fresh transport transaction",
        );
      }
      return;
    }
    const init = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "qaas-docs-helper", version: "0.4.0" },
      },
      64 * 1024,
      transactionBudget,
    );
    if (init.result?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Documentation MCP protocol version mismatch");
    }
    negotiatedProtocolVersion = init.result.protocolVersion;
    await post(
      {
        jsonrpc: "2.0",
        method: "notifications/initialized",
      },
      MAX_PROTOCOL_BYTES,
      transactionBudget,
    );
    const listed = await request(
      "tools/list",
      {},
      toolListOutputLimitBytes,
      transactionBudget,
    );
    if (!Array.isArray(listed.result?.tools)) {
      throw new Error("Documentation MCP tools/list response is malformed");
    }
    if (
      listed.result.nextCursor !== undefined &&
      listed.result.nextCursor !== null
    ) {
      throw new Error(
        "Documentation MCP tools/list pagination exceeds the single bounded discovery transaction",
      );
    }
    if (listed.result.tools.length > toolLimit) {
      throw new Error(
        "Documentation MCP tools/list exceeds the reviewed tool limit",
      );
    }
    const names = new Set();
    discoveredTools = listed.result.tools.map((tool, index) => {
      if (
        !tool ||
        typeof tool !== "object" ||
        Array.isArray(tool) ||
        typeof tool.name !== "string" ||
        tool.name.length < 1 ||
        tool.name.length > 128 ||
        !/^[\x21-\x7e]+$/u.test(tool.name) ||
        !tool.inputSchema ||
        typeof tool.inputSchema !== "object" ||
        Array.isArray(tool.inputSchema)
      ) {
        throw new Error(
          `Documentation MCP tools/list entry ${index} is malformed`,
        );
      }
      if (names.has(tool.name)) {
        throw new Error(
          `Documentation MCP tools/list duplicates tool ${tool.name}`,
        );
      }
      names.add(tool.name);
      const schemaBytes = Buffer.byteLength(
        canonicalJson(tool.inputSchema),
        "utf8",
      );
      if (schemaBytes > schemaLimitBytes) {
        throw new Error(
          `Documentation MCP input schema exceeds the reviewed byte limit for ${tool.name}`,
        );
      }
      return {
        name: tool.name,
        inputSchema: tool.inputSchema,
        schemaDigest: canonicalDigest(tool.inputSchema),
        schemaBytes,
      };
    });
    liveTools = new Map(
      listed.result.tools.map((tool) => [tool.name, tool]),
    );
    initialized = true;
  };

  const callOnce = async (capability, input) => {
    await initialize();
    const live = liveTools.get(capability.tool);
    if (!live) {
      throw new Error(`Reviewed documentation MCP tool is unavailable: ${capability.tool}`);
    }
    if (
      !live.inputSchema ||
      canonicalDigest(live.inputSchema) !== capability.schemaDigest
    ) {
      throw new Error(
        `Live MCP schema differs from the signed registry for ${capability.tool}`,
      );
    }
    const message = await request(
      "tools/call",
      { name: capability.tool, arguments: input },
      Math.min(
        MAX_PROTOCOL_BYTES,
        capability.outputLimitBytes + 64 * 1024,
      ),
    );
    const result = toolResult(message);
    if (
      Buffer.byteLength(JSON.stringify(result), "utf8") >
      capability.outputLimitBytes
    ) {
      throw new Error("MCP tool result exceeds its signed output byte bound");
    }
    if (apparentItemCount(result) > capability.outputLimitItems) {
      throw new Error("MCP tool result exceeds its signed output item bound");
    }
    return result;
  };

  const withSessionRecovery = async (operation) => {
    try {
      return await operation();
    } catch (error) {
      if (
        error?.mcpStatus !== 404 ||
        error?.requestUsedSession !== true
      ) {
        throw error;
      }
      sessionId = null;
      negotiatedProtocolVersion = null;
      initialized = false;
      liveTools = null;
      discoveredTools = null;
      return operation();
    }
  };
  const caller = (capability, input) =>
    withSessionRecovery(() => callOnce(capability, input));
  Object.defineProperty(caller, "discover", {
    enumerable: false,
    value: async () => {
      const transactionBudget = {
        deadlineMs: Date.now() + timeoutMs,
        remainingBytes: toolListOutputLimitBytes,
        remainingRequests: DOCS_MCP_PROBE_OPERATIONS.length,
      };
      await initialize(transactionBudget);
      if (Date.now() > transactionBudget.deadlineMs) {
        throw new Error(
          "Documentation MCP discovery exceeded the reviewed transaction timeout",
        );
      }
      if (transactionBudget.remainingRequests !== 0) {
        throw new Error(
          "Documentation MCP discovery did not complete the reviewed request sequence",
        );
      }
      return {
        protocolVersion: negotiatedProtocolVersion,
        sessionMode: sessionId === null ? "stateless" : "stateful",
        tools: discoveredTools.map((tool) => structuredClone(tool)),
      };
    },
  });
  return caller;
}

export async function discoverStreamableMcpTools(options = {}) {
  const caller = createStreamableMcpCaller(options);
  if (!caller) {
    throw new Error("Documentation MCP discovery requires QAAS_DOCS_MCP_URL");
  }
  return caller.discover();
}
