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

synchronize(pluginManifestPath, (manifest) => {
  manifest.version = desiredVersion;
});

synchronize(marketplacePath, (marketplace) => {
  marketplace.metadata ??= {};
  marketplace.metadata.version = desiredVersion;
  for (const plugin of marketplace.plugins ?? []) {
    if (plugin.name === "qaas") {
      plugin.version = desiredVersion;
    }
  }
});

synchronize(packagePath, (packageDocument) => {
  packageDocument.version = desiredVersion;
});

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
