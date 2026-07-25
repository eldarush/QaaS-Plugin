import path from "node:path";
import { canonicalDigest } from "./canonical-json.mjs";
import { assertNoSecrets, secretFindings } from "./redact.mjs";

const ALLOWED_CATEGORIES = new Set([
  "general-preference",
  "shared-nonsecret-repository",
  "workflow-preference",
]);

const PROJECT_FACT =
  /\b(?:this project|tested system|test case|executable|sample payload|expected output|acceptance criteria|environment identity|qaas package version|customer|production endpoint)\b/iu;

export function validateSafeMemoryEntry(entry) {
  const errors = [];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return { valid: false, errors: ["entry must be an object"] };
  }
  if (!ALLOWED_CATEGORIES.has(entry.category)) {
    errors.push("category is not eligible for cross-project memory");
  }
  if (typeof entry.text !== "string" || entry.text.trim() === "") {
    errors.push("text is required");
  } else {
    if (PROJECT_FACT.test(entry.text)) {
      errors.push("project, system, or test facts belong in .claude/qaas");
    }
    if (secretFindings(entry.text).length > 0) {
      errors.push("text contains credential-like data");
    }
    try {
      const urls = entry.text.match(/[a-z][a-z0-9+.-]*:\/\/\S+/giu) ?? [];
      for (const candidate of urls) {
        const url = new URL(candidate.replace(/[),.;]+$/u, ""));
        if (url.username || url.password) errors.push("credential-bearing URL is denied");
      }
    } catch {
      errors.push("text contains an invalid URL");
    }
  }
  if (entry.userApproved !== true) {
    errors.push("explicit user approval is required");
  }
  return { valid: errors.length === 0, errors };
}

export function createSafeMemoryRecord(entry) {
  const result = validateSafeMemoryEntry(entry);
  if (!result.valid) {
    throw new Error(`Unsafe memory entry: ${result.errors.join("; ")}`);
  }
  const record = {
    schemaVersion: "1.0",
    category: entry.category,
    text: entry.text.trim(),
    approvedAt: entry.approvedAt ?? new Date().toISOString(),
    approvalSource: entry.approvalSource ?? "direct-user",
  };
  assertNoSecrets(record);
  record.digest = canonicalDigest(record);
  return record;
}

export function isKnownAutoMemoryPath(candidate, userHome = null) {
  const resolved = path.resolve(candidate);
  const normalized =
    process.platform === "win32" ? resolved.toLowerCase() : resolved;
  const fragments = [
    `${path.sep}.claude${path.sep}memory${path.sep}`,
    `${path.sep}.claude${path.sep}projects${path.sep}`,
    `${path.sep}claude${path.sep}memory${path.sep}`,
  ].map((entry) =>
    process.platform === "win32" ? entry.toLowerCase() : entry,
  );
  if (fragments.some((fragment) => normalized.includes(fragment))) return true;
  if (userHome) {
    const memoryRoot = path.resolve(userHome, ".claude", "memory");
    const comparable =
      process.platform === "win32" ? memoryRoot.toLowerCase() : memoryRoot;
    return normalized === comparable || normalized.startsWith(`${comparable}${path.sep}`);
  }
  return false;
}

