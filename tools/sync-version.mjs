#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..");
const versionPath = path.join(repositoryRoot, "version.json");
const pluginManifestPath = path.join(
  repositoryRoot,
  "plugins",
  "qaas",
  ".claude-plugin",
  "plugin.json",
);
const marketplacePath = path.join(
  repositoryRoot,
  ".claude-plugin",
  "marketplace.json",
);
const packagePath = path.join(repositoryRoot, "package.json");
const runtimeVersionTargets = [
  {
    path: path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      "scripts",
      "workflow-authority.mjs",
    ),
    pattern: /const PLUGIN_VERSION = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?";/u,
    replacement: () => `const PLUGIN_VERSION = "${desiredVersion}";`,
  },
  {
    path: path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      "scripts",
      "lib",
      "approval-authority.mjs",
    ),
    pattern: /pluginVersion = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?",/u,
    replacement: () => `pluginVersion = "${desiredVersion}",`,
  },
  {
    path: path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      "scripts",
      "lib",
      "hook-runtime.mjs",
    ),
    pattern:
      /pluginVersion: overrides\.pluginVersion \?\? "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?",/u,
    replacement: () =>
      `pluginVersion: overrides.pluginVersion ?? "${desiredVersion}",`,
  },
  {
    path: path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      "scripts",
      "local-encode-mcp.mjs",
    ),
    pattern: /const SERVER_VERSION = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?";/u,
    replacement: () => `const SERVER_VERSION = "${desiredVersion}";`,
  },
  {
    path: path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      "scripts",
      "lib",
      "streamable-mcp-client.mjs",
    ),
    pattern:
      /clientInfo: \{ name: "qaas-docs-helper", version: "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?" \},/u,
    replacement: () =>
      `clientInfo: { name: "qaas-docs-helper", version: "${desiredVersion}" },`,
  },
];
const checkOnly = process.argv.includes("--check");

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

const versionDocument = readJson(versionPath);
if (
  typeof versionDocument.version !== "string" ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(versionDocument.version)
) {
  throw new Error("version.json must contain one valid semantic version.");
}

const desiredVersion = versionDocument.version;
const updates = [];

function synchronize(filePath, update) {
  const current = readJson(filePath);
  const desired = structuredClone(current);
  update(desired);
  if (stableJson(current) === stableJson(desired)) {
    return;
  }

  if (checkOnly) {
    updates.push(path.relative(repositoryRoot, filePath));
    return;
  }

  fs.writeFileSync(filePath, stableJson(desired), "utf8");
}

function synchronizeRuntimeVersion({ path: filePath, pattern, replacement }) {
  const current = fs.readFileSync(filePath, "utf8");
  const globalFlags = pattern.flags.includes("g")
    ? pattern.flags
    : `${pattern.flags}g`;
  const matches = [...current.matchAll(new RegExp(pattern.source, globalFlags))];
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one runtime version marker in ${path.relative(
        repositoryRoot,
        filePath,
      )}; found ${matches.length}.`,
    );
  }
  const desired = current.replace(pattern, replacement);
  if (current === desired) return;
  if (checkOnly) {
    updates.push(path.relative(repositoryRoot, filePath));
    return;
  }
  fs.writeFileSync(filePath, desired, "utf8");
}

synchronize(pluginManifestPath, (manifest) => {
  manifest.version = desiredVersion;
});

synchronize(marketplacePath, (marketplace) => {
  marketplace.metadata ??= {};
  marketplace.metadata.version = desiredVersion;
  const qaasPlugins = (marketplace.plugins ?? []).filter(
    (plugin) => plugin.name === "qaas",
  );
  if (qaasPlugins.length !== 1) {
    throw new Error(
      `Marketplace must contain exactly one qaas plugin; found ${qaasPlugins.length}.`,
    );
  }
  qaasPlugins[0].version = desiredVersion;
});

synchronize(packagePath, (packageDocument) => {
  packageDocument.version = desiredVersion;
});
for (const target of runtimeVersionTargets) {
  synchronizeRuntimeVersion(target);
}

if (checkOnly && updates.length > 0) {
  throw new Error(
    `Version ${desiredVersion} is not synchronized in: ${updates.join(", ")}`,
  );
}

if (checkOnly) {
  process.stdout.write(`Version ${desiredVersion} is synchronized.\n`);
} else {
  process.stdout.write(`Synchronized version ${desiredVersion}.\n`);
}
