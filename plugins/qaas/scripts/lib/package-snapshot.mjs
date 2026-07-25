import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, safeEqualHex, sha256 } from "./canonical-json.mjs";
import { assertNoSecrets } from "./redact.mjs";

const SKIP_DIRECTORIES = new Set([
  ".git",
  ".claude",
  "bin",
  "obj",
  "node_modules",
  "packages",
]);
const PACKAGE_FILES = new Set([
  "directory.packages.props",
  "directory.build.props",
  "directory.build.targets",
  "nuget.config",
  "packages.lock.json",
  "global.json",
]);

function isPackageMetadata(relative) {
  const basename = path.posix.basename(relative).toLowerCase();
  return (
    PACKAGE_FILES.has(basename) ||
    /\.(?:csproj|fsproj|vbproj|sln|slnx)$/iu.test(basename)
  );
}

function normalizeRelative(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

function packageReferences(text) {
  const references = [];
  const pattern =
    /<(?:PackageReference|PackageVersion)\b[^>]*\bInclude\s*=\s*"([^"]+)"[^>]*?(?:\bVersion\s*=\s*"([^"]+)")?[^>]*>/giu;
  for (const match of text.matchAll(pattern)) {
    references.push({
      name: match[1],
      version: match[2] ?? null,
    });
  }
  return references.sort((left, right) =>
    left.name === right.name
      ? String(left.version).localeCompare(String(right.version), "en")
      : left.name.localeCompare(right.name, "en"),
  );
}

function configuredFeedProof(env) {
  const value = env.QAAS_NUGET_FEED_URL;
  if (!value) return null;
  const url = new URL(value);
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(
      "QAAS_NUGET_FEED_URL must be credential-free HTTP(S) without query or fragment",
    );
  }
  return {
    configuredBy: "QAAS_NUGET_FEED_URL",
    protocol: url.protocol,
    origin: url.origin,
    pathDigest: sha256(url.pathname),
  };
}

export async function computePackageSnapshot({
  projectRoot,
  env = process.env,
  maxFiles = 200,
  maxBytes = 16 * 1024 * 1024,
}) {
  const canonicalRoot = path.resolve(projectRoot);
  const candidates = [];
  const visit = async (directory) => {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort(
      (left, right) => left.name.localeCompare(right.name, "en"),
    )) {
      const target = path.join(directory, entry.name);
      const relative = normalizeRelative(canonicalRoot, target);
      if (entry.isSymbolicLink()) {
        if (isPackageMetadata(relative)) {
          throw new Error(`Package metadata may not be a symlink: ${relative}`);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) {
          await visit(target);
        }
      } else if (entry.isFile() && isPackageMetadata(relative)) {
        candidates.push({ target, relative });
      }
    }
  };
  await visit(canonicalRoot);
  if (candidates.length > maxFiles) {
    throw new Error("Package metadata file count exceeds the snapshot bound");
  }
  let totalBytes = 0;
  const files = [];
  const graph = [];
  for (const candidate of candidates.sort((left, right) =>
    left.relative.localeCompare(right.relative, "en"),
  )) {
    const info = await lstat(candidate.target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error(`Package metadata changed during snapshot: ${candidate.relative}`);
    }
    totalBytes += info.size;
    if (totalBytes > maxBytes) {
      throw new Error("Package metadata bytes exceed the snapshot bound");
    }
    const bytes = await readFile(candidate.target);
    files.push({
      path: candidate.relative,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
    if (/\.(?:csproj|fsproj|vbproj|props)$/iu.test(candidate.relative)) {
      for (const reference of packageReferences(bytes.toString("utf8"))) {
        graph.push({ file: candidate.relative, ...reference });
      }
    }
  }
  const snapshot = {
    schemaVersion: "1.0",
    projectRootDigest: sha256(canonicalRoot),
    files,
    graph,
    configuredFeed: configuredFeedProof(env),
    bounds: {
      fileCount: files.length,
      totalBytes,
      maxFiles,
      maxBytes,
    },
  };
  assertNoSecrets(snapshot, "package snapshot");
  snapshot.digest = canonicalDigest(snapshot);
  return snapshot;
}

export async function writePackageSnapshot(
  authority,
  relativePath,
  snapshot,
) {
  const prior = await authority.readSigned(relativePath, { required: false });
  await authority.writeSigned(
    relativePath,
    {
      schemaVersion: "1.0",
      projectId: authority.projectId,
      snapshot,
      snapshotDigest: snapshot.digest,
      sequence: (prior?.payload.sequence ?? -1) + 1,
    },
    { expectedSequence: prior?.payload.sequence ?? -1 },
  );
  return snapshot;
}

export async function assertCurrentPackageSnapshot({
  authority,
  relativePath,
  projectRoot,
  env = process.env,
  expectedDigest,
}) {
  const record = await authority.readSigned(relativePath);
  const current = await computePackageSnapshot({ projectRoot, env });
  if (
    !safeEqualHex(record.payload.snapshotDigest, expectedDigest) ||
    !safeEqualHex(record.payload.snapshot.digest, expectedDigest) ||
    !safeEqualHex(current.digest, expectedDigest)
  ) {
    throw new Error("Package graph/feed snapshot is stale");
  }
  return current;
}
