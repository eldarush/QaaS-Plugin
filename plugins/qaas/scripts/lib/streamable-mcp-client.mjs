import { canonicalDigest } from "./canonical-json.mjs";
import { secretFindings } from "./redact.mjs";

const PROTOCOL_VERSION = "2025-03-26";
const MAX_PROTOCOL_BYTES = 1024 * 1024;

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
  return Buffer.concat(chunks).toString("utf8");
}

function parseMessage(text) {
  const trimmed = text.trim();
  let payloadText = trimmed;
  if (!trimmed.startsWith("{")) {
    const events = trimmed
      .split(/\r?\n\r?\n/u)
      .flatMap((event) =>
        event
          .split(/\r?\n/u)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim()),
      );
    if (events.length !== 1) {
      throw new Error("MCP response must contain exactly one JSON/SSE data message");
    }
    payloadText = events[0];
  }
  const message = JSON.parse(payloadText);
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
  if (Array.isArray(result)) return result.length;
  if (!result || typeof result !== "object") return 1;
  const arrays = ["results", "items", "hits", "entries", "documents"]
    .map((key) => result[key])
    .filter(Array.isArray);
  return arrays.length === 0
    ? 1
    : Math.max(...arrays.map((entries) => entries.length));
}

export function createStreamableMcpCaller({
  env = process.env,
  timeoutMs = 10_000,
  approvedTransport = null,
} = {}) {
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
  let initialized = false;
  let liveTools = null;

  const post = async (payload, outputLimitBytes = MAX_PROTOCOL_BYTES) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    timer.unref?.();
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Accept: "application/json, text/event-stream",
          "Content-Type": "application/json",
          ...(auth.value ? { Authorization: `Bearer ${auth.value}` } : {}),
          ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`Documentation MCP returned HTTP ${response.status}`);
      }
      const nextSession = response.headers.get("mcp-session-id");
      if (nextSession) sessionId = nextSession;
      const text = await boundedResponse(
        response,
        Math.min(MAX_PROTOCOL_BYTES, outputLimitBytes),
      );
      return payload.id === undefined && text.trim() === ""
        ? null
        : parseMessage(text);
    } finally {
      clearTimeout(timer);
    }
  };

  const request = (method, params, limit) =>
    post(
      {
        jsonrpc: "2.0",
        id: ++requestId,
        method,
        params,
      },
      limit,
    );

  const initialize = async () => {
    if (initialized) return;
    const init = await request(
      "initialize",
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "qaas-docs-helper", version: "0.3.0" },
      },
      64 * 1024,
    );
    if (!sessionId) {
      throw new Error("Documentation MCP did not provide a session ID");
    }
    if (init.result?.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Documentation MCP protocol version mismatch");
    }
    await post({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    });
    const listed = await request("tools/list", {}, 256 * 1024);
    if (!Array.isArray(listed.result?.tools)) {
      throw new Error("Documentation MCP tools/list response is malformed");
    }
    liveTools = new Map(
      listed.result.tools.map((tool) => [tool.name, tool]),
    );
    initialized = true;
  };

  return async (capability, input) => {
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
}
