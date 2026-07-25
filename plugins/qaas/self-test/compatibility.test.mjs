import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  compareSemanticVersions,
  MINIMUM_CLAUDE_CODE_VERSION,
  supportsClaudeCodeVersion,
} from "../scripts/doctor.mjs";
import { validateOwnHookConfiguration } from "../scripts/lib/runtime-attestation.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(pluginRoot, "..", "..");

function spawnObserved(program, args, { stdin = "" } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, {
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({
        exitCode,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(stdin);
  });
}

test("Claude Code compatibility uses a dependency-free semver floor without an upper cap", () => {
  assert.equal(MINIMUM_CLAUDE_CODE_VERSION, "2.1.180");
  assert.equal(supportsClaudeCodeVersion("2.1.179"), false);
  assert.equal(supportsClaudeCodeVersion("2.1.180-rc.1"), false);
  assert.equal(supportsClaudeCodeVersion("2.1.180"), true);
  assert.equal(supportsClaudeCodeVersion("Claude Code 2.1.181"), true);
  assert.equal(supportsClaudeCodeVersion("2.2.0"), true);
  assert.equal(supportsClaudeCodeVersion("3.0.0"), true);
  assert.equal(supportsClaudeCodeVersion("not-a-version"), false);
  assert.equal(compareSemanticVersions("2.10.0", "2.9.99"), 1);
});

test("every registered hook uses the exec-form Node launcher contract", async () => {
  const validation = await validateOwnHookConfiguration(pluginRoot);
  assert.deepEqual(validation, { valid: true, errors: [] });

  const document = JSON.parse(
    await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  );
  for (const groups of Object.values(document.hooks)) {
    for (const group of groups) {
      for (const handler of group.hooks) {
        assert.equal(handler.type, "command");
        assert.equal(handler.command, "node");
        assert.equal(handler.args.length, 2);
        assert.equal(
          handler.args[0],
          "${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.mjs",
        );
        assert.match(
          handler.args[1],
          /^\$\{CLAUDE_PLUGIN_ROOT\}\/scripts\/(?:pretool-safety|posttool-ledger|session-state)\.mjs$/u,
        );
        assert.doesNotMatch(JSON.stringify(handler), /\/bin\/sh|\.sh\b/u);
      }
    }
  }
});

test("Node hook launcher preserves streams and fails closed", async (t) => {
  const fixtureRoot = await mkdtemp(
    path.join(os.tmpdir(), "qaas-node-launcher-"),
  );
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const launcher = path.join(fixtureRoot, "hook-launcher.mjs");
  const passingHook = path.join(fixtureRoot, "pretool-safety.mjs");
  const blockingHook = path.join(fixtureRoot, "posttool-ledger.mjs");
  await copyFile(
    path.join(pluginRoot, "scripts", "hook-launcher.mjs"),
    launcher,
  );
  await writeFile(
    passingHook,
    [
      "const chunks = [];",
      "for await (const chunk of process.stdin) chunks.push(chunk);",
      "process.stdout.write(Buffer.concat(chunks));",
      "",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    blockingHook,
    [
      'process.stdout.write("partial-output");',
      'process.stderr.write("synthetic-hook-failure\\n");',
      "process.exitCode = 7;",
      "",
    ].join("\n"),
    "utf8",
  );

  const payload = '{"hook_event_name":"PreToolUse"}\n';
  const passing = await spawnObserved(
    process.execPath,
    [launcher, passingHook],
    { stdin: payload },
  );
  assert.equal(passing.exitCode, 0);
  assert.equal(passing.signal, null);
  assert.equal(passing.stdout, payload);
  assert.equal(passing.stderr, "");

  const blocking = await spawnObserved(
    process.execPath,
    [launcher, blockingHook],
  );
  assert.equal(blocking.exitCode, 2);
  assert.equal(blocking.signal, null);
  assert.equal(blocking.stdout, "partial-output");
  assert.match(blocking.stderr, /synthetic-hook-failure/u);
  assert.match(blocking.stderr, /failed closed \(exit 7\)/u);

  const rejected = await spawnObserved(
    process.execPath,
    [launcher, path.join(fixtureRoot, "unknown.mjs")],
  );
  assert.equal(rejected.exitCode, 2);
  assert.match(rejected.stderr, /rejected an unknown script/u);
});

test("runtime configuration has no Node pin or shell dependency", async () => {
  let packageDocument = null;
  try {
    packageDocument = JSON.parse(
      await readFile(path.join(repositoryRoot, "package.json"), "utf8"),
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (packageDocument) {
    assert.equal(packageDocument.engines?.node, undefined);
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      assert.equal(packageDocument[field], undefined);
    }
  }

  const runtimeSources = await Promise.all(
    [
      "doctor.mjs",
      "hook-launcher.mjs",
      "hook-launcher.sh",
      "lib/runtime-attestation.mjs",
      "validate-plugin.mjs",
    ].map((relative) =>
      readFile(path.join(pluginRoot, "scripts", relative), "utf8")
    ),
  );
  assert.doesNotMatch(
    runtimeSources.join("\n"),
    /QAAS_TRUSTED_NODE|Node 24|24\.x|v24\./u,
  );
  assert.doesNotMatch(runtimeSources[0], /\/bin\/sh|Git Bash/u);

  for (const match of runtimeSources[1].matchAll(
    /^\s*import\b.*?\bfrom\s+["']([^"']+)["'];?$/gmu,
  )) {
    assert.match(match[1], /^node:/u);
  }

  let workflow = null;
  try {
    workflow = await readFile(
      path.join(repositoryRoot, ".github", "workflows", "validate.yml"),
      "utf8",
    );
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (workflow) {
    for (const version of ["18", "20", "22", "24"]) {
      assert.match(workflow, new RegExp(`- "${version}"`, "u"));
    }
    assert.match(workflow, /node-version:\s*\$\{\{\s*matrix\.node\s*\}\}/u);
    assert.match(workflow, /windows-latest/u);
    assert.match(workflow, /ubuntu-latest/u);
  }
});
