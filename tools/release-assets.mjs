#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";
import path from "node:path";

export function releaseAssetNames(version) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    throw new Error("Release asset version must be a stable X.Y.Z version.");
  }

  return Object.freeze([
    `qaas-plugin-${version}.zip`,
    `qaas-plugin-${version}.zip.sha256`,
    `qaas-plugin-${version}.zip.manifest.json`,
  ]);
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const version = process.argv[2] ?? "";
    const assets = releaseAssetNames(version);
    process.stdout.write(
      process.argv.includes("--json")
        ? `${JSON.stringify(assets)}\n`
        : `${assets.join("\n")}\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
