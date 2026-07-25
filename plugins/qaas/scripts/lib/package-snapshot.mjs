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
    /\.(?:csproj|fsproj|vbproj|props|targets|sln|slnx)$/iu.test(basename)
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

function decodeXmlAttribute(value) {
  return String(value)
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function xmlAttributes(text) {
  const attributes = new Map();
  const attribute =
    /([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu;
  for (const match of text.matchAll(attribute)) {
    attributes.set(
      match[1].toLowerCase(),
      decodeXmlAttribute(match[2] ?? match[3]),
    );
  }
  return attributes;
}

function packageSourceRecord({
  file,
  name,
  value,
  declaredBy,
}) {
  const source = decodeXmlAttribute(value).trim();
  if (!source) return null;
  if (source.includes("$(") || source.includes("%(")) {
    return {
      file,
      name,
      declaredBy,
      kind: "unresolved-project-expression",
      valueDigest: sha256(source),
    };
  }
  let url;
  try {
    url = new URL(source);
  } catch {
    return {
      file,
      name,
      declaredBy,
      kind: "local-or-relative",
      value: source.replaceAll("\\", "/"),
      valueDigest: sha256(source),
    };
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    return {
      file,
      name,
      declaredBy,
      kind: "local-or-relative",
      value: source,
      valueDigest: sha256(source),
    };
  }
  if (url.username || url.password) {
    throw new Error(`Package source may not contain credentials: ${file}`);
  }
  return {
    file,
    name,
    declaredBy,
    kind: "http",
    url: url.toString(),
    urlDigest: sha256(url.toString()),
    protocol: url.protocol,
    origin: url.origin,
    pathDigest: sha256(url.pathname),
  };
}

function packageSources(relative, text) {
  const sources = [];
  const basename = path.posix.basename(relative).toLowerCase();
  if (basename === "nuget.config") {
    const packageSourcesBlock =
      /<packageSources\b[^>]*>([\s\S]*?)<\/packageSources>/iu.exec(text)?.[1] ??
      "";
    const add = /<add\b([^>]*)\/?>/giu;
    for (const match of packageSourcesBlock.matchAll(add)) {
      const attributes = xmlAttributes(match[1]);
      const key = attributes.get("key");
      const value = attributes.get("value");
      if (!key || !value) continue;
      const record = packageSourceRecord({
        file: relative,
        name: key.trim(),
        value,
        declaredBy: "NuGet.Config/packageSources",
      });
      if (record) sources.push(record);
    }
  }
  if (/\.(?:csproj|fsproj|vbproj|props|targets)$/iu.test(relative)) {
    const restoreProperty =
      /<(RestoreSources|RestoreAdditionalProjectSources)\b[^>]*>([\s\S]*?)<\/\1>/giu;
    for (const match of text.matchAll(restoreProperty)) {
      const values = decodeXmlAttribute(match[2])
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean);
      values.forEach((value, index) => {
        const record = packageSourceRecord({
          file: relative,
          name: `${match[1]}:${index + 1}`,
          value,
          declaredBy: `MSBuild/${match[1]}`,
        });
        if (record) sources.push(record);
      });
    }
  }
  return sources;
}

function singleConfiguredFeed(sources) {
  const remote = sources.filter((source) => source.kind === "http");
  if (remote.length !== 1) return null;
  const [source] = remote;
  return {
    configuredBy: source.declaredBy,
    sourceName: source.name,
    file: source.file,
    protocol: source.protocol,
    origin: source.origin,
    pathDigest: source.pathDigest,
    urlDigest: source.urlDigest,
  };
}

export function resolveProjectPackageSource(snapshot, selector = null) {
  const remote = (snapshot?.packageSources ?? []).filter(
    (source) => source.kind === "http",
  );
  const matches =
    selector === null
      ? remote
      : remote.filter(
          (source) =>
            source.name === selector ||
            source.urlDigest === selector ||
            source.url === selector,
        );
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(
      "No matching HTTP NuGet source is evidenced by current project package metadata",
    );
  }
  throw new Error(
    "Multiple project NuGet sources are evidenced; select one project-specific source",
  );
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
  const discoveredPackageSources = [];
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
    const text = bytes.toString("utf8");
    files.push({
      path: candidate.relative,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
    if (/\.(?:csproj|fsproj|vbproj|props|targets)$/iu.test(candidate.relative)) {
      for (const reference of packageReferences(text)) {
        graph.push({ file: candidate.relative, ...reference });
      }
    }
    discoveredPackageSources.push(
      ...packageSources(candidate.relative, text),
    );
  }
  const normalizedPackageSources = [
    ...new Map(
      discoveredPackageSources.map((source) => [
        canonicalDigest(source),
        source,
      ]),
    ).values(),
  ].sort((left, right) =>
    `${left.file}:${left.name}`.localeCompare(
      `${right.file}:${right.name}`,
      "en",
    ),
  );
  const snapshot = {
    schemaVersion: "1.0",
    projectRootDigest: sha256(canonicalRoot),
    files,
    graph,
    packageSources: normalizedPackageSources,
    configuredFeed: singleConfiguredFeed(normalizedPackageSources),
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
