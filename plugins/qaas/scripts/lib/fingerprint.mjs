import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, canonicalJson, sha256 } from "./canonical-json.mjs";

export const FINGERPRINT_STAGES = Object.freeze([
  "onboardingFingerprint",
  "taskBaseline",
  "expectedWorkingFingerprint",
  "staticVerificationFingerprint",
]);

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeRelative(relative) {
  const slash = relative.replaceAll("\\", "/");
  return process.platform === "win32" ? slash.toLowerCase() : slash;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function validateRelativeInput(relative) {
  const normalized = relative.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.includes(":") ||
    segments.some(
      (segment) =>
        segment === "." ||
        segment === ".." ||
        (segment === "" && normalized !== ""),
    ) ||
    segments.some((segment) => /[ .]$/u.test(segment)) ||
    segments.some((segment) =>
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    normalized.includes("\0")
  ) {
    throw new Error(`Fingerprint path escapes project root: ${relative}`);
  }
  return normalized;
}

function excluded(relative, exclusions) {
  const normalized = normalizeRelative(relative);
  return exclusions.some((entry) => {
    const target = normalizeRelative(entry).replace(/\/+$/u, "");
    return normalized === target || normalized.startsWith(`${target}/`);
  });
}

async function fileHash(target, budget) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => {
      if (Date.now() > budget.deadline) {
        stream.destroy(
          new Error("Fingerprint exceeded its deterministic time budget"),
        );
        return;
      }
      hash.update(chunk);
    });
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

function consumeBudget(budget, size, relative) {
  budget.files += 1;
  budget.bytes += size;
  if (budget.files > budget.maxFiles) {
    throw new Error(
      `Fingerprint scope exceeds the ${budget.maxFiles}-file safety bound`,
    );
  }
  if (size > budget.maxFileBytes) {
    throw new Error(
      `Fingerprint file exceeds the ${budget.maxFileBytes}-byte safety bound: ${relative}`,
    );
  }
  if (budget.bytes > budget.maxTotalBytes) {
    throw new Error(
      `Fingerprint scope exceeds the ${budget.maxTotalBytes}-byte safety bound`,
    );
  }
}

async function collectPath(
  rootReal,
  target,
  relative,
  exclusions,
  visited,
  budget,
) {
  if (excluded(relative, exclusions)) return [];
  const info = await lstat(target);
  if (info.isSymbolicLink()) {
    const resolved = await realpath(target);
    if (!isInside(rootReal, resolved)) {
      throw new Error(`Symlink or reparse point escapes project root: ${relative}`);
    }
    const resolvedInfo = await stat(resolved);
    if (resolvedInfo.isDirectory()) {
      const identity = await realpath(resolved);
      if (visited.has(identity)) {
        throw new Error(`Symlink directory cycle detected at ${relative}`);
      }
      visited.add(identity);
      const entries = await readdir(resolved, { withFileTypes: true });
      const results = [];
      for (const entry of entries.sort((a, b) => compareOrdinal(a.name, b.name))) {
        const childRelative = `${relative}/${entry.name}`.replace(/^\/+/u, "");
        results.push(
          ...(await collectPath(
            rootReal,
            path.join(resolved, entry.name),
            childRelative,
            exclusions,
            visited,
            budget,
          )),
        );
      }
      visited.delete(identity);
      return results;
    }
    if (!resolvedInfo.isFile()) return [];
    consumeBudget(budget, resolvedInfo.size, relative);
    return [
      {
        path: normalizeRelative(relative),
        size: resolvedInfo.size,
        sha256: await fileHash(resolved, budget),
        linkTarget: normalizeRelative(path.relative(rootReal, resolved)),
      },
    ];
  }
  if (info.isDirectory()) {
    const identity = await realpath(target);
    if (visited.has(identity)) throw new Error(`Directory cycle at ${relative}`);
    visited.add(identity);
    const entries = await readdir(target, { withFileTypes: true });
    const results = [];
    for (const entry of entries.sort((a, b) => compareOrdinal(a.name, b.name))) {
      const childRelative = relative
        ? `${relative}/${entry.name}`
        : entry.name;
      results.push(
        ...(await collectPath(
          rootReal,
          path.join(target, entry.name),
          childRelative,
          exclusions,
          visited,
          budget,
        )),
      );
    }
    visited.delete(identity);
    return results;
  }
  if (!info.isFile()) return [];
  consumeBudget(budget, info.size, relative);
  return [
    {
      path: normalizeRelative(relative),
      size: info.size,
      sha256: await fileHash(target, budget),
    },
  ];
}

export async function createFingerprint({
  projectRoot,
  stage,
  relevantPaths = null,
  exclusions = [],
  packageSnapshot = null,
  contextDigest = null,
  externalReferences = [],
  renderedTemplate = null,
  createdAt = new Date().toISOString(),
  maxFiles = 10_000,
  maxTotalBytes = 64 * 1024 * 1024,
  maxFileBytes = 16 * 1024 * 1024,
  maxDurationMs = 15_000,
}) {
  if (!FINGERPRINT_STAGES.includes(stage)) {
    throw new Error(`Unknown fingerprint stage: ${stage}`);
  }
  const rootReal = await realpath(path.resolve(projectRoot));
  const effectiveExclusions = [
    ".git",
    ".claude/qaas/state",
    ".claude/qaas/fingerprint.json",
    ".qaas-user-evidence",
    ...exclusions.map(validateRelativeInput),
  ];
  const pathsToCollect =
    relevantPaths === null
      ? [""]
      : [...new Set(relevantPaths.map(validateRelativeInput))].sort();
  const entries = [];
  for (const [name, value] of Object.entries({
    maxFiles,
    maxTotalBytes,
    maxFileBytes,
    maxDurationMs,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${name} must be a positive safe integer`);
    }
  }
  const budget = {
    files: 0,
    bytes: 0,
    maxFiles,
    maxTotalBytes,
    maxFileBytes,
    deadline: Date.now() + maxDurationMs,
  };
  for (const relative of pathsToCollect) {
    const target = path.resolve(rootReal, ...relative.split("/").filter(Boolean));
    if (!isInside(rootReal, target)) {
      throw new Error(`Fingerprint target escapes project root: ${relative}`);
    }
    entries.push(
      ...(await collectPath(
        rootReal,
        target,
        relative,
        effectiveExclusions,
        new Set(),
        budget,
      )),
    );
  }
  const deduplicated = [
    ...new Map(entries.map((entry) => [entry.path, entry])).values(),
  ].sort((a, b) => compareOrdinal(a.path, b.path));
  const fingerprint = {
    schemaVersion: "1.0",
    stage,
    projectRoot:
      process.platform === "win32" ? rootReal.toLowerCase() : rootReal,
    createdAt,
    entries: deduplicated,
    scopePaths:
      relevantPaths === null
        ? null
        : [...new Set(relevantPaths.map(validateRelativeInput))].sort(),
    exclusions: [...new Set(effectiveExclusions)].sort(),
    packageSnapshot,
    contextDigest,
    externalReferences: [...externalReferences].sort((a, b) =>
      compareOrdinal(canonicalJson(a), canonicalJson(b)),
    ),
    renderedTemplate:
      stage === "staticVerificationFingerprint" ? renderedTemplate : null,
  };
  fingerprint.digest = canonicalDigest(fingerprint, ["digest", "createdAt"]);
  return fingerprint;
}

export function verifyFingerprint(fingerprint) {
  const errors = [];
  if (!fingerprint || typeof fingerprint !== "object") {
    return { valid: false, errors: ["fingerprint must be an object"] };
  }
  if (!FINGERPRINT_STAGES.includes(fingerprint.stage)) {
    errors.push("unknown fingerprint stage");
  }
  if (!Array.isArray(fingerprint.entries)) errors.push("entries must be an array");
  else {
    const paths = new Set();
    for (const [index, entry] of fingerprint.entries.entries()) {
      if (!entry || typeof entry !== "object") {
        errors.push(`entries[${index}] must be an object`);
        continue;
      }
      if (
        typeof entry.path !== "string" ||
        entry.path.includes("\0") ||
        path.posix.isAbsolute(entry.path.replaceAll("\\", "/")) ||
        /^[A-Za-z]:[\\/]/u.test(entry.path) ||
        entry.path.replaceAll("\\", "/").split("/").includes("..")
      ) {
        errors.push(`entries[${index}].path is not a safe relative path`);
      }
      const comparisonPath =
        process.platform === "win32" ? entry.path.toLowerCase() : entry.path;
      if (paths.has(comparisonPath)) errors.push(`duplicate path: ${entry.path}`);
      paths.add(comparisonPath);
      if (!/^[a-f0-9]{64}$/u.test(entry.sha256 ?? "")) {
        errors.push(`entries[${index}].sha256 is invalid`);
      }
    }
  }
  if (
    fingerprint.scopePaths !== undefined &&
    fingerprint.scopePaths !== null &&
    !Array.isArray(fingerprint.scopePaths)
  ) {
    errors.push("scopePaths must be null or an array");
  }
  if (
    fingerprint.exclusions !== undefined &&
    !Array.isArray(fingerprint.exclusions)
  ) {
    errors.push("exclusions must be an array");
  }
  const digest = canonicalDigest(fingerprint, ["digest", "createdAt"]);
  if (fingerprint.digest !== digest) errors.push("fingerprint digest mismatch");
  return { valid: errors.length === 0, errors, digest };
}

export function compareFingerprints(expected, actual) {
  const expectedMap = new Map(expected.entries.map((entry) => [entry.path, entry]));
  const actualMap = new Map(actual.entries.map((entry) => [entry.path, entry]));
  const added = [];
  const removed = [];
  const changed = [];
  for (const [entryPath, entry] of actualMap) {
    const prior = expectedMap.get(entryPath);
    if (!prior) added.push(entryPath);
    else if (
      prior.sha256 !== entry.sha256 ||
      prior.size !== entry.size ||
      prior.linkTarget !== entry.linkTarget
    ) {
      changed.push(entryPath);
    }
  }
  for (const entryPath of expectedMap.keys()) {
    if (!actualMap.has(entryPath)) removed.push(entryPath);
  }
  const metadataChanged =
    sha256({
      packageSnapshot: expected.packageSnapshot,
      contextDigest: expected.contextDigest,
      externalReferences: expected.externalReferences,
      renderedTemplate: expected.renderedTemplate,
    }) !==
    sha256({
      packageSnapshot: actual.packageSnapshot,
      contextDigest: actual.contextDigest,
      externalReferences: actual.externalReferences,
      renderedTemplate: actual.renderedTemplate,
    });
  return {
    equal:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      !metadataChanged,
    added,
    removed,
    changed,
    metadataChanged,
  };
}
