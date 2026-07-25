#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { fileURLToPath } from "node:url";

const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(evidenceRoot, "..", "..");
const projectRoot = path.join(evidenceRoot, "demo-project");
const pluginRoot = path.join(repositoryRoot, "plugins", "qaas");
const argumentsSet = new Set(process.argv.slice(2));
const sceneArgument = process.argv.find((argument) =>
  argument.startsWith("--scene="),
);
const scene = sceneArgument?.slice("--scene=".length) ?? "";
const scripted = argumentsSet.has("--scripted");
const hold = argumentsSet.has("--hold");

// Keep the runner tied to the recorded fixture instead of accepting arbitrary paths.
for (const requiredPath of [
  path.join(projectRoot, "service.service"),
  path.join(projectRoot, "smoke.qaas.yaml"),
  path.join(projectRoot, "TestData", "order-input.json"),
]) {
  if (!fs.existsSync(requiredPath)) {
    throw new Error(`Synthetic fixture is incomplete: ${requiredPath}`);
  }
}

if (!["workflow", "evidence"].includes(scene)) {
  process.stderr.write(
    "Usage: node interactive-demo.mjs --scene=workflow|evidence [--scripted] [--hold]\n",
  );
  process.exitCode = 2;
} else {
  await run();
}

async function run() {
  const terminal = process.stdout.isTTY;
  const ansi = {
    reset: terminal ? "\u001b[0m" : "",
    bold: terminal ? "\u001b[1m" : "",
    dim: terminal ? "\u001b[2m" : "",
    cyan: terminal ? "\u001b[38;2;93;215;190m" : "",
    blue: terminal ? "\u001b[38;2;125;190;255m" : "",
    green: terminal ? "\u001b[38;2;116;226;159m" : "",
    amber: terminal ? "\u001b[38;2;255;196;108m" : "",
    red: terminal ? "\u001b[38;2;255;128;128m" : "",
    white: terminal ? "\u001b[38;2;238;244;242m" : "",
  };

  const color = (name, value) => `${ansi[name]}${value}${ansi.reset}`;
  const line = (value = "") => process.stdout.write(`${value}\n`);
  const rule = () => line(color("dim", "─".repeat(88)));
  const pass = (value) => line(`${color("green", "✓ PASS")}  ${value}`);
  const title =
    scene === "workflow"
      ? "QaaS Plugin demo - Workflow gate"
      : "QaaS Plugin demo - Verification evidence";

  if (terminal) {
    process.stdout.write(`\u001b]0;${title}\u0007`);
    process.stdout.write("\u001b[2J\u001b[H");
  }

  line(color("bold", "QaaS PLUGIN · CONTROLLED CODEX PROXY"));
  line(
    color(
      "cyan",
      scene === "workflow"
        ? "Workflow gate · synthetic HTTP/JSON fixture"
        : "Bounded verification · synthetic HTTP/JSON fixture",
    ),
  );
  line(
    color(
      "dim",
      "Privacy boundary: no customer data · Claude Code not run · QaaS runtime not run",
    ),
  );
  rule();

  if (scene === "workflow") {
    await renderWorkflow({ color, line, pass, rule });
  } else {
    await renderEvidence({ color, line, pass, rule });
  }

  rule();
  line(
    color(
      "amber",
      "Capture boundary: scripted operator input; controlled Codex proxy; static evidence only.",
    ),
  );

  if (hold && terminal) {
    const interfaceHandle = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    await interfaceHandle.question(
      color("dim", "Capture ready. Press Enter to close this local demo. "),
    );
    interfaceHandle.close();
  }
}

async function renderWorkflow({ color, line, pass, rule }) {
  line(`${color("blue", "Operator >")} Add one HTTP/JSON smoke fixture.`);
  line(
    "           Preserve protected-demo-id; set riskLevel=high; oracle reviewRequired=true.",
  );
  line();

  const questions = [
    ["Active local pattern: smoke.qaas.yaml?", "Yes"],
    ["May protected-demo-id change?", "No"],
    ["Common Hooks or modules?", "Neither"],
    ["Stop before any QaaS runtime?", "Yes"],
  ];

  const interfaceHandle =
    scripted || !process.stdin.isTTY
      ? null
      : readline.createInterface({ input: process.stdin, output: process.stdout });

  for (const [question, controlledAnswer] of questions) {
    if (interfaceHandle) {
      line(`${color("cyan", "Codex >")} ${question}`);
      await interfaceHandle.question(`${color("blue", "Operator >")} `);
    } else {
      line(
        `${color("cyan", "Codex >")} ${question}  ${color("blue", "Operator >")} ${controlledAnswer}`,
      );
    }
  }
  line();
  line(color("bold", "READ-ONLY PROJECT MAP"));
  const inventory = runJson(process.execPath, [
    path.join(pluginRoot, "scripts", "project-inventory.mjs"),
  ]);
  const routes = runJson(process.execPath, [
    path.join(pluginRoot, "scripts", "interview-routes.mjs"),
    "--mode",
    "inventory-and-user-intents",
    "--intent",
    "http-json",
  ]);
  const protocols = signalValues(inventory, "protocols");
  const serializations = signalValues(inventory, "serializations");
  const intents = signalValues(inventory, "testIntents");

  pass(
    `project-inventory.mjs · ${inventory.counts.filesSeen} files · ${protocols}/${serializations}`,
  );
  pass(
    `interview-routes.mjs · ${routes.routes[0]?.title ?? "route unavailable"} · authority=${routes.authority}`,
  );
  line(
    color(
      "dim",
      `Candidate evidence only · intent=${intents} · reportingTruncated=${inventory.reportingTruncated}`,
    ),
  );

  rule();
  line(color("bold", "EXACT CHANGE PROPOSED"));
  line("  + Cases/order-review.qaas.yaml       observed YAML pattern");
  line("  + TestData/order-review-input.json  protected id + riskLevel=high");
  line("  + Expected/order-review-output.json reviewRequired=true");
  line("  = Three baseline files remain byte-for-byte unchanged");
  line("  ! No packages, framework, environment, deletion, or QaaS run");
  if (interfaceHandle) {
    line(`${color("cyan", "Codex >")} Approve, Revise, or Cancel?`);
    await interfaceHandle.question(`${color("blue", "Operator >")} `);
    interfaceHandle.close();
  } else {
    line(
      `${color("cyan", "Codex >")} Approve, Revise, or Cancel?  ${color("blue", "Operator >")} Approve`,
    );
  }
  line(
    color(
      "amber",
      "Gate recorded for this demo plan only; no signed plugin approval was created.",
    ),
  );
}

async function renderEvidence({ color, line, pass, rule }) {
  line(color("bold", "ACTUAL LOCAL CHECKS"));
  line(
    color(
      "dim",
      "Running repository scripts against validation/docs-demo-session/demo-project",
    ),
  );
  line();

  const fixture = runJson(process.execPath, [
    path.join(evidenceRoot, "verify-demo.mjs"),
    "--fixture-only",
  ]);
  pass(
    `baseline SHA-256 unchanged · ${fixture.checks.baselineSha256} files`,
  );
  pass(
    `observed YAML lines present · ${fixture.checks.observedYamlPatternLines} lines`,
  );
  pass(`input JSON · ${fixture.checks.inputJson}`);
  pass(`expected JSON · ${fixture.checks.expectedJson}`);

  const projectShape = runCommand(process.execPath, [
    "--test",
    "--test-name-pattern=^D20-01",
    path.join(pluginRoot, "self-test", "project-diversity.test.mjs"),
  ]);
  const planContracts = runCommand(process.execPath, [
    "--test",
    "--test-name-pattern=^planning (separates authority facts from approval-bound local choices|binds exact write bytes and preserves literal semantic order)$",
    path.join(pluginRoot, "self-test", "runtime.test.mjs"),
  ]);
  pass(
    `focused project-shape contracts · ${countPassed(projectShape.stdout)} passed`,
  );
  pass(
    `focused plan contracts · ${countPassed(planContracts.stdout)} passed`,
  );

  rule();
  line(color("bold", "BOUNDED RESULT"));
  line(`${color("green", "STATIC VERIFICATION PASSED")} · exit code 0`);
  line("Proves: approved synthetic file bytes and focused repository contracts.");
  line("Does not prove: QaaS semantics, target behavior, or a successful QaaS run.");
  line();
  line(
    `${color("cyan", "Codex    >")} Runtime remains unverified. A separate run plan and approval`,
  );
  line("           would be required before any runtime claim.");
}

function signalValues(inventory, key) {
  const values = (inventory.signals?.[key] ?? []).map((item) => item.value);
  return values.length > 0 ? values.join(",") : "unknown";
}

function countPassed(output) {
  const match = output.match(/(?:#|\u2139)\s+pass\s+(\d+)/u);
  return match?.[1] ?? "unknown";
}

function runJson(command, argumentsList) {
  const result = runCommand(command, argumentsList);
  try {
    return JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Expected JSON from ${path.basename(argumentsList[0])}`, {
      cause: error,
    });
  }
}

function runCommand(command, argumentsList) {
  const result = spawnSync(command, argumentsList, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      CLAUDE_PROJECT_DIR: projectRoot,
      CLAUDE_PLUGIN_ROOT: pluginRoot,
      NO_COLOR: "1",
    },
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const diagnostic = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(
      `${path.basename(command)} exited ${result.status}\n${diagnostic}`,
    );
  }
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}
