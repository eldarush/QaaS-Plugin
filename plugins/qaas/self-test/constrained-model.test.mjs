import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkContextBudget } from "../scripts/check-context-budget.mjs";
import {
  classifyToolCall,
  hookEnvironment,
} from "../scripts/lib/hook-runtime.mjs";
import { validatePlugin } from "../scripts/validate-plugin.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const serverScript = path.join(
  pluginRoot,
  "scripts",
  "local-encode-mcp.mjs",
);

function startServer(t) {
  const child = spawn(process.execPath, [serverScript], {
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
    terminal: false,
  });
  const pending = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  lines.on("line", (line) => {
    const waiter = pending.shift();
    if (waiter) waiter.resolve(JSON.parse(line));
  });
  child.once("error", (error) => {
    while (pending.length > 0) pending.shift().reject(error);
  });
  child.once("exit", (code, signal) => {
    const error = new Error(
      `local MCP server exited (${signal ?? code}): ${stderr}`,
    );
    while (pending.length > 0) pending.shift().reject(error);
  });
  t.after(() => {
    lines.close();
    child.kill();
  });

  return {
    notify(message) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    request(message) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(new Error(`timed out waiting for ${message.method}`));
        }, 3_000);
        pending.push({
          resolve(value) {
            clearTimeout(timer);
            resolve(value);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        child.stdin.write(`${JSON.stringify(message)}\n`);
      });
    },
  };
}

test("local MCP encoder initializes, lists one tool, and preserves exact bytes", async (t) => {
  const server = startServer(t);
  const initialized = await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "qaas-self-test", version: "0.1.0" },
    },
  });
  assert.equal(initialized.result.protocolVersion, "2025-03-26");
  assert.equal(initialized.result.serverInfo.name, "qaas-local");
  assert.deepEqual(initialized.result.capabilities, { tools: {} });

  server.notify({
    jsonrpc: "2.0",
    method: "notifications/initialized",
  });
  const listed = await server.request({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });
  assert.equal(listed.result.tools.length, 1);
  assert.equal(listed.result.tools[0].name, "encode_text");
  assert.deepEqual(listed.result.tools[0].inputSchema.required, ["text"]);
  assert.equal(
    listed.result.tools[0].inputSchema.additionalProperties,
    false,
  );

  const corpus = [
    "# Exact payload",
    "",
    "| syntax | value |",
    "| --- | --- |",
    "| PowerShell | `$env:QAAS_VALUE` |",
    "| YAML | `*anchor` and `&alias` |",
    "| C# | `IEnumerable<T>` |",
    "",
    '{"items":["a","b"],"nested":{"enabled":true}}',
    "עברית, Ελληνικά, 日本語, emoji: 🧪",
    "quotes: \"double\" and 'single'",
    "tabs:\tremain\tliteral",
    "final line",
  ].join("\r\n");
  const called = await server.request({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "encode_text",
      arguments: { text: corpus },
    },
  });
  assert.equal(called.result.isError, false);
  assert.equal(called.result.content.length, 1);
  const encoded = JSON.parse(called.result.content[0].text);
  assert.equal(encoded.encoding, "utf8");
  assert.equal(encoded.byteLength, Buffer.byteLength(corpus, "utf8"));
  assert.deepEqual(
    Buffer.from(encoded.contentBase64, "base64"),
    Buffer.from(corpus, "utf8"),
  );
  assert.match(encoded.transportSha256, /^[a-f0-9]{64}$/u);
  assert.equal(Object.hasOwn(encoded, "sha256"), false);
});

test("local MCP encoder rejects extra fields, oversized text, and secrets", async (t) => {
  const server = startServer(t);
  await server.request({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "qaas-self-test", version: "0.1.0" },
    },
  });
  for (const [id, argumentsValue] of [
    [2, { text: "safe", extra: true }],
    [3, { text: "x".repeat(32 * 1024 + 1) }],
    [
      4,
      {
        text: [
          "Authorization:",
          ["Bea", "rer"].join(""),
          "abcdefghijklmnopqrstuvwxyz",
        ].join(" "),
      },
    ],
  ]) {
    const result = await server.request({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: "encode_text", arguments: argumentsValue },
    });
    assert.equal(result.result.isError, true);
    assert.doesNotMatch(result.result.content[0].text, /Bearer|abcdefgh/u);
  }
});

test("safety hook allows only the exact local encoder MCP call", async () => {
  const baseEvent = {
    hook_event_name: "PreToolUse",
    session_id: "constrained-model-session",
    tool_use_id: "local-encoder-call",
  };
  const exactEvent = {
    ...baseEvent,
    tool_name: "mcp__qaas_local__encode_text",
    tool_input: { text: "line one\n| exact | markdown |\nline three" },
  };
  const context = hookEnvironment(exactEvent, {
    projectRoot: process.cwd(),
    pluginRoot,
    env: {},
  });
  const allowed = await classifyToolCall(exactEvent, context);
  assert.equal(allowed.actionClass, "ordinary-read");
  assert.equal(allowed.helper, "qaas-local-encode-text");

  await assert.rejects(
    classifyToolCall(
      {
        ...exactEvent,
        tool_use_id: "local-encoder-extra",
        tool_input: { text: "safe", extra: true },
      },
      context,
    ),
    /exactly one string field/u,
  );
  await assert.rejects(
    classifyToolCall(
      {
        ...baseEvent,
        tool_use_id: "other-mcp-call",
        tool_name: "mcp__qaas_local__another_tool",
        tool_input: { text: "safe" },
      },
      context,
    ),
    /requires protected capability authority/u,
  );
});

test("plugin validation and weak-model phase budgets include the local encoder", async () => {
  const validation = await validatePlugin();
  assert.deepEqual(validation.errors, []);
  assert.equal(validation.valid, true);

  const budget = await checkContextBudget({
    projectRoot: path.resolve(pluginRoot, "..", ".."),
  });
  assert.deepEqual(budget.errors, []);
  assert.equal(budget.valid, true);
  assert.equal(budget.budgets.localEncoderToolTokenReserve, 256);
  assert.ok(
    Object.values(budget.measured.phaseCosts).every((cost) => cost <= 32_000),
  );
});
