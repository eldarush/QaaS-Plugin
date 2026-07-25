import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { safeEqualHex, sha256 } from "./canonical-json.mjs";
import {
  compareFingerprints,
  createFingerprint,
} from "./fingerprint.mjs";

const MAX_VERIFICATION_FILE_BYTES = 1024 * 1024;
const ARTIFACT_CHECK_TYPES = new Set([
  "file-exists",
  "file-not-empty",
  "file-sha256",
  "text-file-contains",
  "json-pointer-equals",
]);

function inside(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function safeVerificationFile(projectRoot, relative) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(root, ...relative.replaceAll("\\", "/").split("/"));
  if (!inside(root, target)) {
    throw new Error(`Verification path escapes the project: ${relative}`);
  }
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error(`Verification path follows a symlink: ${relative}`);
    }
  }
  const info = await lstat(target);
  if (!info.isFile() || info.size > MAX_VERIFICATION_FILE_BYTES) {
    throw new Error(
      `Verification artifact must be a file no larger than ${MAX_VERIFICATION_FILE_BYTES} bytes: ${relative}`,
    );
  }
  return { target, info };
}

function includesText(haystack, needle, caseSensitive = true) {
  if (caseSensitive) return haystack.includes(needle);
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function jsonPointer(value, pointer) {
  if (pointer === "") return value;
  let current = value;
  for (const encoded of pointer.slice(1).split("/")) {
    const key = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (
      current === null ||
      typeof current !== "object" ||
      !Object.hasOwn(current, key)
    ) {
      return { missing: true };
    }
    current = current[key];
  }
  return { missing: false, value: current };
}

function normalizedRelative(value) {
  const slash = String(value).replaceAll("\\", "/").replace(/^\.\/+/u, "");
  return process.platform === "win32" ? slash.toLowerCase() : slash;
}

export async function captureVerificationArtifacts(projectRoot, checks) {
  const states = {};
  for (const check of checks) {
    if (!ARTIFACT_CHECK_TYPES.has(check.type)) continue;
    const key = normalizedRelative(check.path);
    try {
      const { target, info } = await safeVerificationFile(
        projectRoot,
        check.path,
      );
      const bytes = await readFile(target);
      states[key] = {
        exists: true,
        size: info.size,
        mtimeMs: info.mtimeMs,
        sha256: sha256(bytes),
      };
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      states[key] = { exists: false };
    }
  }
  return states;
}

function warningFailures(results, policy) {
  const lines = results
    .flatMap((result) => `${result.stdout}\n${result.stderr}`.split(/\r?\n/u))
    .filter((line) => {
      if (!/\bwarn(?:ing)?s?\b/iu.test(line)) return false;
      const withoutZeroSummaries = line
        .replace(/\b0\s+warning(?:s|\(s\))?\b/giu, "")
        .replace(/\bwarning(?:s|\(s\))?\s*:\s*0\b/giu, "");
      return /\bwarn(?:ing)?s?\b/iu.test(withoutZeroSummaries);
    });
  if (lines.length === 0) return [];
  if (policy.mode === "forbid") {
    return lines.map((line) => `unapproved warning: ${line.slice(0, 240)}`);
  }
  return lines
    .filter(
      (line) =>
        !(policy.allowedSubstrings ?? []).some((allowed) =>
          line.includes(allowed),
        ),
    )
    .map((line) => `warning is not allow-listed: ${line.slice(0, 240)}`);
}

export async function evaluateVerification({
  projectRoot,
  results,
  checks,
  warningPolicy,
  changedPaths = [],
  requireFreshArtifacts = false,
  priorArtifactStates = {},
}) {
  const failures = warningFailures(results, warningPolicy);
  const outcomes = [];
  const stdout = results.map((result) => result.stdout).join("\n");
  const stderr = results.map((result) => result.stderr).join("\n");
  for (const check of checks) {
    let passed = false;
    let actualDigest = null;
    let evaluationError = null;
    try {
      if (check.type === "stdout-contains") {
        passed = includesText(
          stdout,
          check.contains,
          check.caseSensitive !== false,
        );
      } else if (check.type === "stderr-contains") {
        passed = includesText(
          stderr,
          check.contains,
          check.caseSensitive !== false,
        );
      } else {
        const { target, info } = await safeVerificationFile(
          projectRoot,
          check.path,
        );
        if (check.type === "file-exists") {
          passed = true;
        } else if (check.type === "file-not-empty") {
          passed = info.size > 0;
        } else {
          const bytes = await readFile(target);
          actualDigest = sha256(bytes);
          if (check.type === "file-sha256") {
            passed = safeEqualHex(actualDigest, check.sha256);
          } else if (check.type === "text-file-contains") {
            const text = bytes.toString("utf8");
            passed =
              !text.includes("\uFFFD") &&
              includesText(
                text,
                check.contains,
                check.caseSensitive !== false,
              );
          } else if (check.type === "json-pointer-equals") {
            const parsed = JSON.parse(bytes.toString("utf8"));
            const actual = jsonPointer(parsed, check.jsonPointer);
            passed =
              !actual.missing &&
              JSON.stringify(actual.value) === JSON.stringify(check.expected);
          }
        }
        if (
          passed &&
          requireFreshArtifacts
        ) {
          if (actualDigest === null) {
            actualDigest = sha256(await readFile(target));
          }
          const prior = priorArtifactStates[normalizedRelative(check.path)];
          const pathChanged = changedPaths
            .map(normalizedRelative)
            .includes(normalizedRelative(check.path));
          const fresh =
            prior?.exists !== true ||
            prior.sha256 !== actualDigest ||
            prior.size !== info.size ||
            prior.mtimeMs !== info.mtimeMs ||
            pathChanged;
          if (!fresh) {
            passed = false;
            evaluationError =
              "artifact bytes/timestamp were not created or refreshed by this run";
          }
        }
      }
    } catch (error) {
      evaluationError = error.message;
    }
    if (!passed) {
      failures.push(
        `${check.id}: ${evaluationError ?? "predicate did not match"}`,
      );
    }
    outcomes.push({
      id: check.id,
      type: check.type,
      passed,
      actualDigest,
    });
  }
  return {
    passed: failures.length === 0,
    failures,
    outcomes,
    outcomeDigest: sha256(outcomes),
  };
}

export async function captureProcessFingerprint(projectRoot, stage) {
  return createFingerprint({
    projectRoot,
    stage,
    exclusions: [".claude/qaas/state"],
  });
}

export async function verifyProcessChanges({
  projectRoot,
  before,
  allowedOutputDirectories,
  protectedPaths = [],
  stage,
}) {
  const after = await captureProcessFingerprint(projectRoot, stage);
  const comparison = compareFingerprints(before, after);
  const root = path.resolve(projectRoot);
  const protectedAbsolute = protectedPaths.map((entry) =>
    path.resolve(root, ...String(entry).replaceAll("\\", "/").split("/")),
  );
  const invalidOutputDirectories = [];
  const allowed = allowedOutputDirectories.map((entry) => {
    const directory = path.resolve(
      root,
      ...String(entry).replaceAll("\\", "/").split("/"),
    );
    if (
      !inside(root, directory) ||
      directory === root ||
      protectedAbsolute.some(
        (protectedPath) =>
          inside(protectedPath, directory) || inside(directory, protectedPath),
      )
    ) {
      invalidOutputDirectories.push(entry);
    }
    return directory;
  });
  const changed = [
    ...comparison.added,
    ...comparison.removed,
    ...comparison.changed,
  ];
  const unexpected = changed.filter((relative) => {
    const target = path.resolve(projectRoot, ...relative.split("/"));
    return !allowed.some((directory) => inside(directory, target));
  });
  return {
    ok: unexpected.length === 0 && invalidOutputDirectories.length === 0,
    beforeDigest: before.digest,
    afterDigest: after.digest,
    changed,
    unexpected,
    invalidOutputDirectories,
  };
}
