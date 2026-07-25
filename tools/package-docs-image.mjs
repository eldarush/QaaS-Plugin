#!/usr/bin/env node

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..");
const distributionDirectory = path.join(repositoryRoot, "dist");
const version = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "version.json"), "utf8"),
).version;
const canonicalImage =
  `docker.io/thesmoketeam/qaas-plugin-docs:${version}`;
const image = process.env.QAAS_PLUGIN_DOCS_IMAGE ?? canonicalImage;
const sourceRevision = process.env.QAAS_PLUGIN_SOURCE_REVISION ?? null;
const sourceArchive = process.env.QAAS_PLUGIN_DOCS_SOURCE_TAR
  ? path.resolve(repositoryRoot, process.env.QAAS_PLUGIN_DOCS_SOURCE_TAR)
  : null;
const archiveName = `qaas-plugin-docs-${version}-linux-amd64.tar.gz`;
const archivePath = path.join(distributionDirectory, archiveName);

if (
  sourceRevision !== null &&
  !/^[0-9a-f]{40}$/u.test(sourceRevision)
) {
  throw new Error(
    "QAAS_PLUGIN_SOURCE_REVISION must be an exact lowercase 40-character Git commit.",
  );
}
if (image !== canonicalImage) {
  throw new Error(
    `QAAS_PLUGIN_DOCS_IMAGE must be the canonical offline tag ${canonicalImage}.`,
  );
}
if (
  sourceArchive !== null &&
  (path.relative(distributionDirectory, sourceArchive).startsWith("..") ||
    path.isAbsolute(path.relative(distributionDirectory, sourceArchive)))
) {
  throw new Error(
    "QAAS_PLUGIN_DOCS_SOURCE_TAR must stay inside the distribution directory.",
  );
}

function docker(args, { capture = true } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", args, {
      cwd: repositoryRoot,
      stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
      windowsHide: true,
    });
    if (!capture) {
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code === 0) resolve("");
        else reject(new Error(`docker ${args[0]} exited with code ${code}`));
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("exit", (code) => {
      const output = Buffer.concat(stdout).toString("utf8");
      const errorOutput = Buffer.concat(stderr).toString("utf8").trim();
      if (code === 0) resolve(output);
      else {
        reject(
          new Error(
            errorOutput || `docker ${args[0]} exited with code ${code}`,
          ),
        );
      }
    });
  });
}

async function saveCompressedImage() {
  if (sourceArchive !== null) {
    await pipeline(
      fs.createReadStream(sourceArchive),
      createGzip({ level: 9, mtime: 0 }),
      fs.createWriteStream(archivePath, { flags: "w" }),
    );
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn("docker", ["image", "save", image], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output = fs.createWriteStream(archivePath, { flags: "w" });
    const gzip = createGzip({ level: 9, mtime: 0 });
    const stderr = [];
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.stdout.pipe(gzip).pipe(output);

    let childCode = null;
    let outputClosed = false;
    const finish = () => {
      if (!outputClosed || childCode === null) return;
      if (childCode === 0) resolve();
      else {
        reject(
          new Error(
            Buffer.concat(stderr).toString("utf8").trim() ||
              `docker image save exited with code ${childCode}`,
          ),
        );
      }
    };
    child.once("error", reject);
    gzip.once("error", reject);
    output.once("error", reject);
    child.once("exit", (code) => {
      childCode = code;
      finish();
    });
    output.once("close", () => {
      outputClosed = true;
      finish();
    });
  });
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  hash.update(fs.readFileSync(filePath));
  return hash.digest("hex");
}

fs.mkdirSync(distributionDirectory, { recursive: true });

const inspected = JSON.parse(
  await docker(["image", "inspect", image, "--format", "{{json .}}"]),
);
const labels = inspected.Config?.Labels ?? {};
const expectedLabels = {
  "org.opencontainers.image.title": "qaas-plugin-docs",
  "org.opencontainers.image.version": version,
  "org.opencontainers.image.source":
    "https://github.com/TheSmokeTeam/QaaS-Plugin",
  ...(sourceRevision
    ? { "org.opencontainers.image.revision": sourceRevision }
    : {}),
};
for (const [name, expected] of Object.entries(expectedLabels)) {
  if (labels[name] !== expected) {
    throw new Error(
      `Image ${image} has ${name}=${JSON.stringify(labels[name])}; expected ${JSON.stringify(expected)}`,
    );
  }
}
if (inspected.Os !== "linux" || inspected.Architecture !== "amd64") {
  throw new Error(
    `Release archive must be linux/amd64, got ${inspected.Os}/${inspected.Architecture}`,
  );
}
if (inspected.Config?.User !== "1000:1000") {
  throw new Error(
    `Release image must default to user 1000:1000, got ${JSON.stringify(inspected.Config?.User)}`,
  );
}
if (!Object.hasOwn(inspected.Config?.ExposedPorts ?? {}, "8080/tcp")) {
  throw new Error("Release image must expose 8080/tcp");
}
const expectedHealthcheck = ["CMD", "node", "scripts/healthcheck.mjs"];
if (
  JSON.stringify(inspected.Config?.Healthcheck?.Test) !==
  JSON.stringify(expectedHealthcheck)
) {
  throw new Error("Release image healthcheck contract is missing or changed");
}

await saveCompressedImage();
const digest = sha256File(archivePath);
fs.writeFileSync(
  `${archivePath}.sha256`,
  `${digest}  ${archiveName}\n`,
  "utf8",
);
fs.writeFileSync(
  `${archivePath}.metadata.json`,
  `${JSON.stringify(
    {
      formatVersion: 1,
      pluginVersion: version,
      image,
      imageId: inspected.Id,
      sourceArchiveFormat:
        sourceArchive === null ? "docker-image-save" : "docker-archive",
      deploymentContract: {
        mode: "standalone-linux-amd64",
        registryIndexDigestSatisfied: false,
        kubernetesManifest:
          `qaas-plugin-docs-kubernetes-airgap-${version}.yaml`,
        imagePullPolicy: "Never",
      },
      architecture: inspected.Architecture,
      os: inspected.Os,
      archive: archiveName,
      archiveSha256: digest,
      runtime: {
        user: inspected.Config.User,
        exposedPorts: Object.keys(inspected.Config.ExposedPorts ?? {}).sort(),
        healthcheck: inspected.Config.Healthcheck.Test,
      },
      labels: Object.fromEntries(
        Object.keys(expectedLabels)
          .sort((left, right) => left.localeCompare(right, "en"))
          .map((name) => [name, labels[name]]),
      ),
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(`Created dist/${archiveName} (${digest}).\n`);
