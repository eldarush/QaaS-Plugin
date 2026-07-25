import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { assertNoSecrets } from "./lib/redact.mjs";

const SERVER_NAME = "qaas-local";
const SERVER_VERSION = "0.4.0";
const MAX_TEXT_BYTES = 32 * 1024;
const SUPPORTED_PROTOCOL_VERSIONS = new Set([
  "2025-06-18",
  "2025-03-26",
  "2024-11-05",
]);

const ENCODE_TOOL = Object.freeze({
  name: "encode_text",
  title: "Encode exact UTF-8 text",
  description:
    "Encodes one secret-free UTF-8 string of at most 32 KiB as Base64 for QaaS staging; its transport checksum is not an artifact digest.",
  inputSchema: {
    type: "object",
    properties: {
      text: {
        type: "string",
        description: "Exact secret-free UTF-8 text to encode.",
      },
    },
    required: ["text"],
    additionalProperties: false,
  },
});

function writeMessage(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id, code, message) {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message },
  };
}

function exactTextInput(value) {
  if (
    !value ||
    Array.isArray(value) ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Object.keys(value).length !== 1 ||
    !Object.hasOwn(value, "text") ||
    typeof value.text !== "string"
  ) {
    throw new Error("encode_text requires exactly one string field named text");
  }
  const bytes = Buffer.from(value.text, "utf8");
  if (bytes.byteLength > MAX_TEXT_BYTES) {
    throw new Error("encode_text input exceeds 32 KiB");
  }
  assertNoSecrets(value.text, "encode_text input");
  return bytes;
}

function encodeToolResult(argumentsValue) {
  try {
    const bytes = exactTextInput(argumentsValue);
    const payload = {
      contentBase64: bytes.toString("base64"),
      transportSha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
      encoding: "utf8",
    };
    return {
      content: [{ type: "text", text: JSON.stringify(payload) }],
      isError: false,
    };
  } catch {
    return {
      content: [
        {
          type: "text",
          text: "encode_text rejected invalid, oversized, or secret-like input",
        },
      ],
      isError: true,
    };
  }
}

function handleRequest(message) {
  if (
    !message ||
    Array.isArray(message) ||
    typeof message !== "object" ||
    message.jsonrpc !== "2.0" ||
    typeof message.method !== "string"
  ) {
    return errorResponse(message?.id ?? null, -32600, "Invalid Request");
  }
  if (message.method === "notifications/initialized") return null;
  if (!Object.hasOwn(message, "id")) {
    return null;
  }
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested)
        ? requested
        : "2025-06-18";
      return response(message.id, {
        protocolVersion,
        capabilities: { tools: {} },
        serverInfo: {
          name: SERVER_NAME,
          version: SERVER_VERSION,
        },
      });
    }
    case "ping":
      return response(message.id, {});
    case "tools/list":
      return response(message.id, { tools: [ENCODE_TOOL] });
    case "tools/call":
      if (message.params?.name !== ENCODE_TOOL.name) {
        return errorResponse(message.id, -32602, "Unknown tool");
      }
      return response(
        message.id,
        encodeToolResult(message.params?.arguments),
      );
    default:
      return errorResponse(message.id, -32601, "Method not found");
  }
}

const lines = createInterface({
  input: process.stdin,
  crlfDelay: Infinity,
  terminal: false,
});

lines.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    writeMessage(errorResponse(null, -32700, "Parse error"));
    return;
  }
  const result = handleRequest(message);
  if (result) writeMessage(result);
});
