#!/usr/bin/env node

import { spawn } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const expectedPlatforms = Object.freeze(["linux/amd64", "linux/arm64"]);
const digestPattern = /^sha256:[0-9a-f]{64}$/u;

function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) {
        resolve(output);
      } else {
        reject(
          new Error(
            errorOutput ||
              `docker ${args.slice(0, 3).join(" ")} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

function parseJson(text, description) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${description} is not valid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function collectScalarEntries(value, entries = [], keyPath = []) {
  if (Array.isArray(value)) {
    value.forEach((item, index) =>
      collectScalarEntries(item, entries, [...keyPath, String(index)]),
    );
  } else if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) =>
      collectScalarEntries(item, entries, [...keyPath, key]),
    );
  } else if (typeof value === "string") {
    entries.push({ keyPath, value });
  }
  return entries;
}

function normalizeRepositorySource(value) {
  return value
    .trim()
    .replace(/^git\+/u, "")
    .replace(/\.git$/u, "")
    .replace(/\/$/u, "")
    .toLowerCase();
}

export function verifyProvenanceDocument(
  document,
  { platform, source, revision },
) {
  const predicate = document?.SLSA;
  if (!predicate || typeof predicate !== "object") {
    throw new Error(`${platform} provenance does not contain a SLSA predicate.`);
  }

  const entries = collectScalarEntries(predicate);
  const normalizedSource = normalizeRepositorySource(source);
  const hasSource = entries.some(({ keyPath, value }) => {
    const key = keyPath.at(-1)?.toLowerCase() ?? "";
    return (
      [
        "source",
        "repository",
        "uri",
        "label:org.opencontainers.image.source",
      ].includes(key) &&
      normalizeRepositorySource(value) === normalizedSource
    );
  });
  if (!hasSource) {
    throw new Error(
      `${platform} provenance is not bound to source ${source}.`,
    );
  }

  const hasRevision = entries.some(({ keyPath, value }) => {
    const key = keyPath.at(-1)?.toLowerCase() ?? "";
    return (
      [
        "revision",
        "commit",
        "sha",
        "label:org.opencontainers.image.revision",
      ].includes(key) && value === revision
    );
  });
  if (!hasRevision) {
    throw new Error(
      `${platform} provenance is not bound to revision ${revision}.`,
    );
  }

  const buildType =
    predicate.buildDefinition?.buildType ?? predicate.buildType ?? "";
  if (
    typeof buildType !== "string" ||
    (!buildType.includes("buildkit") && !buildType.includes("mobyproject.org"))
  ) {
    throw new Error(`${platform} provenance has an unexpected build type.`);
  }
}

export function verifySbomDocument(document, platform) {
  const spdx = document?.SPDX;
  if (!spdx || typeof spdx !== "object") {
    throw new Error(`${platform} SBOM does not contain an SPDX document.`);
  }
  if (
    typeof spdx.spdxVersion !== "string" ||
    !spdx.spdxVersion.startsWith("SPDX-") ||
    spdx.SPDXID !== "SPDXRef-DOCUMENT" ||
    spdx.dataLicense !== "CC0-1.0" ||
    typeof spdx.documentNamespace !== "string" ||
    spdx.documentNamespace.length === 0
  ) {
    throw new Error(`${platform} SBOM has an invalid SPDX document identity.`);
  }
  if (!Array.isArray(spdx.packages) || spdx.packages.length === 0) {
    throw new Error(`${platform} SBOM does not enumerate any packages.`);
  }
}

export function verifyManifestDocument(manifest) {
  const entries = manifest?.manifests;
  if (!Array.isArray(entries)) {
    throw new Error("Registry reference is not a multi-platform OCI index.");
  }

  return expectedPlatforms.map((platformName) => {
    const [os, architecture] = platformName.split("/");
    const platforms = entries.filter(
      (entry) =>
        entry.platform?.os === os &&
        entry.platform?.architecture === architecture,
    );
    if (platforms.length !== 1 || !digestPattern.test(platforms[0].digest)) {
      throw new Error(
        `Registry index must contain exactly one ${platformName} manifest.`,
      );
    }

    const attestations = entries.filter(
      (entry) =>
        entry.annotations?.["vnd.docker.reference.type"] ===
          "attestation-manifest" &&
        entry.annotations?.["vnd.docker.reference.digest"] ===
          platforms[0].digest,
    );
    if (
      attestations.length !== 1 ||
      !digestPattern.test(attestations[0].digest)
    ) {
      throw new Error(
        `Registry index must contain exactly one subject-bound attestation for ${platformName}.`,
      );
    }

    return Object.freeze({
      name: platformName,
      digest: platforms[0].digest,
      attestationDigest: attestations[0].digest,
    });
  });
}

async function inspectJson(reference, template, description) {
  const output = await docker([
    "buildx",
    "imagetools",
    "inspect",
    reference,
    "--format",
    template,
  ]);
  return parseJson(output, description);
}

export async function verifyRegistryImage({
  reference,
  version,
  revision,
  source,
}) {
  if (!/@sha256:[0-9a-f]{64}$/u.test(reference)) {
    throw new Error("Registry verification requires an exact digest reference.");
  }
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/u.test(version)) {
    throw new Error("Registry verification requires a stable X.Y.Z version.");
  }
  if (!/^[0-9a-f]{40}$/u.test(revision)) {
    throw new Error("Registry verification requires a full Git commit.");
  }
  if (
    normalizeRepositorySource(source) !==
    "https://github.com/thesmoketeam/qaas-plugin"
  ) {
    throw new Error("Registry verification requires the canonical source.");
  }

  const manifest = await inspectJson(
    reference,
    "{{json .Manifest}}",
    "registry manifest",
  );
  const platforms = verifyManifestDocument(manifest);

  for (const platform of platforms) {
    const labels = await inspectJson(
      `${reference.split("@")[0]}@${platform.digest}`,
      "{{json .Image.Config.Labels}}",
      `${platform.name} labels`,
    );
    const expectedLabels = {
      "org.opencontainers.image.title": "qaas-plugin-docs",
      "org.opencontainers.image.version": version,
      "org.opencontainers.image.source": source,
      "org.opencontainers.image.revision": revision,
    };
    for (const [name, expected] of Object.entries(expectedLabels)) {
      if (labels?.[name] !== expected) {
        throw new Error(
          `${platform.name} label ${name}=${JSON.stringify(
            labels?.[name],
          )}; expected ${expected}.`,
        );
      }
    }

    const provenance = await inspectJson(
      reference,
      `{{json (index .Provenance "${platform.name}")}}`,
      `${platform.name} provenance`,
    );
    verifyProvenanceDocument(provenance, {
      platform: platform.name,
      source,
      revision,
    });

    const sbom = await inspectJson(
      reference,
      `{{json (index .SBOM "${platform.name}")}}`,
      `${platform.name} SBOM`,
    );
    verifySbomDocument(sbom, platform.name);
  }

  process.stdout.write(
    `Verified provenance, SPDX SBOM, labels, and subjects for ${reference}.\n`,
  );
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    await verifyRegistryImage({
      reference: process.env.QAAS_PLUGIN_DOCS_REGISTRY_REFERENCE ?? "",
      version: process.env.QAAS_PLUGIN_VERSION ?? "",
      revision: process.env.QAAS_PLUGIN_SOURCE_REVISION ?? "",
      source:
        process.env.QAAS_PLUGIN_SOURCE_URL ??
        "https://github.com/TheSmokeTeam/QaaS-Plugin",
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
