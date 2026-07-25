import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  classifyToolCall,
  hookEnvironment,
} from "../scripts/lib/hook-runtime.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const routeScript = path.join(
  pluginRoot,
  "scripts",
  "interview-routes.mjs",
);

function runRouteCli(projectRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [routeScript, ...args], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectRoot },
      shell: false,
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function httpJsonFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-route-cli-"));
  await writeFile(
    path.join(root, "smoke.qaas.yaml"),
    "protocol: http\nserialization: json\n",
    "utf8",
  );
  return root;
}

test("shipped CLI derives bounded inventory routes from CLAUDE_PROJECT_DIR", async () => {
  const projectRoot = await httpJsonFixture();
  const result = await runRouteCli(projectRoot, ["--mode", "inventory"]);
  assert.equal(result.code, 0, result.stderr);
  assert.ok(Buffer.byteLength(result.stdout, "utf8") <= 24 * 1024);

  const routing = JSON.parse(result.stdout);
  assert.deepEqual(
    Object.keys(routing).sort(),
    [
      "authority",
      "reportingTruncated",
      "requiredInterpretation",
      "routes",
      "schemaVersion",
    ],
  );
  assert.equal(routing.authority, "routing-only-no-readiness");
  const route = routing.routes.find(({ id }) => id === "http-json");
  assert.ok(route);
  assert.deepEqual(
    route.provenance.map(({ kind, authority }) => ({ kind, authority })),
    [
      {
        kind: "bounded-tentative-inventory",
        authority: "candidate-evidence-only",
      },
    ],
  );
  assert.doesNotMatch(result.stdout, /CLAUDE_PROJECT_DIR|smoke\.qaas\.yaml":/u);
});

test("shipped CLI adds one through three normal-dialogue routes with explicit provenance", async () => {
  const projectRoot = await httpJsonFixture();
  const result = await runRouteCli(projectRoot, [
    "--mode",
    "inventory-and-user-intents",
    "--intent",
    "http-json",
    "--intent",
    "stress-request",
    "--intent",
    "fuzz-no-output",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const routing = JSON.parse(result.stdout);
  assert.deepEqual(
    routing.routes.map(({ id }) => id),
    ["http-json", "stress-request", "fuzz-no-output"],
  );
  const route = routing.routes.find(
    ({ id }) => id === "http-json",
  );
  assert.deepEqual(
    route.provenance.map(({ kind, authority }) => ({ kind, authority })),
    [
      {
        kind: "bounded-tentative-inventory",
        authority: "candidate-evidence-only",
      },
      {
        kind: "direct-user-intent",
        authority: "direct-user-dialogue",
      },
    ],
  );
  for (const explicitRouteId of ["stress-request", "fuzz-no-output"]) {
    const explicitRoute = routing.routes.find(({ id }) => id === explicitRouteId);
    assert.deepEqual(explicitRoute.provenance, [
      {
        kind: "direct-user-intent",
        authority: "direct-user-dialogue",
        cues: [explicitRouteId],
      },
    ]);
  }

  for (const rejectedArguments of [
    [
      "--mode",
      "inventory-and-user-intents",
      "--intent",
      "stress-request",
      "--intent",
      "stress-request",
    ],
    [
      "--mode",
      "inventory-and-user-intents",
      "--intent",
      "stress-request",
      "--intent",
      "fuzz-no-output",
      "--intent",
      "readme-only",
      "--intent",
      "observability-diagnosis",
    ],
    ["--mode", "inventory-and-user-intents", "--intent", "not-a-route"],
    ["--mode", "inventory-and-user-intents", "--intent", '{"id":"http-json"}'],
    ["--mode", "inventory-and-user-intents", "--intent", "eval(route)"],
    ["--mode", "runtime-evidence"],
  ]) {
    const rejected = await runRouteCli(projectRoot, rejectedArguments);
    assert.notEqual(rejected.code, 0);
    assert.match(
      rejected.stderr,
      /accepts exactly|unknown intent or flag|intent IDs must be unique/iu,
    );
  }
});

test("safety hook exposes the CLI only as the fixed read-only plugin helper", async () => {
  const projectRoot = await httpJsonFixture();
  for (const command of [
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/interview-routes.mjs" --mode inventory',
    'node "${CLAUDE_PLUGIN_ROOT}/scripts/interview-routes.mjs" --mode inventory-and-user-intents --intent stress-request --intent fuzz-no-output',
  ]) {
    const event = {
      hook_event_name: "PreToolUse",
      session_id: "interview-route-helper-session",
      tool_use_id: `route-${command.length}`,
      tool_name: "Bash",
      tool_input: { command },
    };
    const context = hookEnvironment(event, {
      projectRoot,
      pluginRoot,
      env: { CLAUDE_PROJECT_DIR: projectRoot },
    });
    const classification = await classifyToolCall(event, context);
    assert.equal(classification.actionClass, "ordinary-read");
    assert.equal(classification.helper, "interview-routes.mjs");
    assert.match(
      classification.updatedInput.command,
      /interview-routes\.mjs/u,
    );
  }

  const directEvent = {
    hook_event_name: "PreToolUse",
    session_id: "interview-route-helper-session",
    tool_use_id: "route-direct-path",
    tool_name: "Bash",
    tool_input: {
      command: `node "${routeScript}" --mode inventory`,
    },
  };
  const context = hookEnvironment(directEvent, {
    projectRoot,
    pluginRoot,
    env: { CLAUDE_PROJECT_DIR: projectRoot },
  });
  await assert.rejects(
    classifyToolCall(directEvent, context),
    /direct shell execution is denied|shell request is opaque/iu,
  );
});
