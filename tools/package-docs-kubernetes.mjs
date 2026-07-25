#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..");
const distributionDirectory = path.join(repositoryRoot, "dist");
const version = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "version.json"), "utf8"),
).version;
const digest = process.env.QAAS_PLUGIN_DOCS_REGISTRY_DIGEST ?? "";

if (!/^sha256:[0-9a-f]{64}$/u.test(digest)) {
  throw new Error(
    "QAAS_PLUGIN_DOCS_REGISTRY_DIGEST must be an exact sha256 registry digest.",
  );
}

const sourcePath = path.join(
  repositoryRoot,
  "deploy",
  "kubernetes",
  "qaas-plugin-docs.yaml",
);
const outputPath = path.join(
  distributionDirectory,
  `qaas-plugin-docs-kubernetes-${version}.yaml`,
);
const airgapOutputPath = path.join(
  distributionDirectory,
  `qaas-plugin-docs-kubernetes-airgap-${version}.yaml`,
);
const expectedImage =
  `image: docker.io/thesmoketeam/qaas-plugin-docs:${version}`;
const pinnedImage =
  `image: docker.io/thesmoketeam/qaas-plugin-docs@${digest}`;
const source = fs.readFileSync(sourcePath, "utf8");
const occurrences = source.split(expectedImage).length - 1;
const pullPolicy = "imagePullPolicy: IfNotPresent";
const pullPolicyOccurrences = source.split(pullPolicy).length - 1;

if (occurrences !== 1) {
  throw new Error(
    `Expected exactly one ${expectedImage} entry, found ${occurrences}.`,
  );
}
if (pullPolicyOccurrences !== 1) {
  throw new Error(
    `Expected exactly one ${pullPolicy} entry, found ${pullPolicyOccurrences}.`,
  );
}

fs.mkdirSync(distributionDirectory, { recursive: true });
fs.writeFileSync(
  outputPath,
  source.replace(expectedImage, pinnedImage),
  "utf8",
);
fs.writeFileSync(
  airgapOutputPath,
  [
    "# Load the matching linux/amd64 release archive into every target node.",
    "# This offline manifest deliberately uses imagePullPolicy: Never and is",
    "# separate from the registry-index digest-pinned connected manifest.",
    source.replace(pullPolicy, "imagePullPolicy: Never").trimEnd(),
    "",
  ].join("\n"),
  "utf8",
);
process.stdout.write(
  `Created dist/${path.basename(outputPath)} pinned to ${digest} and ` +
    `dist/${path.basename(airgapOutputPath)} for preloaded air-gap nodes.\n`,
);
