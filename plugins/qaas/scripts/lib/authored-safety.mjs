import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const EXECUTABLE_TEXT_EXTENSION =
  /\.(?:ya?ml|json|xml|cs|fs|vb|props|targets|ps1|sh|cmd|bat|sql|config)$/iu;
const EXCLUDED_DIRECTORY = new Set([
  ".git",
  "bin",
  "obj",
  "node_modules",
  ".claude/qaas/state",
]);

const DESTRUCTIVE_SOURCE_RULES = Object.freeze([
  [
    "MSBuild destructive task",
    /<(?:Delete|RemoveDir)\b/iu,
  ],
  [
    "MSBuild destructive Exec command",
    /<Exec\b[^>]*\bCommand\s*=\s*(?:"[^"]*\b(?:del|erase|rd|rmdir|rm|Remove-Item|unlink|shred)\b[^"]*"|'[^']*\b(?:del|erase|rd|rmdir|rm|Remove-Item|unlink|shred)\b[^']*')/iu,
  ],
  [
    "filesystem deletion API",
    /\b(?:System\.)?IO\.(?:File|Directory)\.Delete\s*\(|\b(?:File|Directory)\.Delete\s*\(|\b(?:Remove-Item|rm|rmdir|unlink|shred)\b/iu,
  ],
  [
    "database destructive statement",
    /\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA|INDEX)|TRUNCATE\s+TABLE|DELETE\s+FROM)\b/iu,
  ],
  [
    "broker/index destructive operation",
    /\b(?:delete|purge|drop|truncate|cleanup|remove)[A-Za-z0-9_-]*(?:queue|exchange|topic|index|database|schema|table)\b/iu,
  ],
  [
    "container/orchestrator destructive operation",
    /\b(?:kubectl\s+delete|docker\s+(?:compose\s+down|rm|rmi)|helm\s+(?:uninstall|delete))\b/iu,
  ],
  [
    "recursive cleanup intent",
    /\b(?:recursive\s*[:=]\s*true|deleteRecursively|removeRecursively|cleanupAsync|purgeAsync)\b/iu,
  ],
  [
    "destructive child process",
    /\b(?:Process\.Start|child_process|execSync|Invoke-Expression)\b[\s\S]{0,240}\b(?:delete|remove|purge|drop|truncate|cleanup|rm|rmdir)\b/iu,
  ],
]);

function normalizedRelative(root, target) {
  return path.relative(root, target).replaceAll("\\", "/");
}

function excluded(relative) {
  const normalized = relative.replaceAll("\\", "/");
  return [...EXCLUDED_DIRECTORY].some(
    (entry) =>
      normalized === entry || normalized.startsWith(`${entry}/`),
  );
}

export function destructiveAuthoredContentFindings(text, identifier = "<input>") {
  if (typeof text !== "string") return [];
  return DESTRUCTIVE_SOURCE_RULES.filter(([, pattern]) => pattern.test(text)).map(
    ([reason]) => ({ identifier, reason }),
  );
}

export async function scanProjectExecutableInputs({
  projectRoot,
  additionalPaths = [],
  maxFiles = 2_000,
  maxTotalBytes = 8 * 1024 * 1024,
  maxFileBytes = 1024 * 1024,
}) {
  const root = await realpath(path.resolve(projectRoot));
  const findings = [];
  const visited = new Set();
  let files = 0;
  let bytes = 0;

  const visit = async (target) => {
    const resolved = await realpath(target);
    const relative = normalizedRelative(root, resolved);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      excluded(relative)
    ) {
      if (relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error("Executable-input scan escaped the project root");
      }
      return;
    }
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new Error(`Executable-input scan rejects symlinks: ${relative}`);
    }
    if (info.isDirectory()) {
      if (visited.has(resolved)) {
        throw new Error(`Executable-input directory cycle: ${relative}`);
      }
      visited.add(resolved);
      const entries = await readdir(resolved, { withFileTypes: true });
      for (const entry of entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        await visit(path.join(resolved, entry.name));
      }
      visited.delete(resolved);
      return;
    }
    if (!info.isFile() || !EXECUTABLE_TEXT_EXTENSION.test(relative)) return;
    files += 1;
    bytes += info.size;
    if (files > maxFiles || bytes > maxTotalBytes || info.size > maxFileBytes) {
      throw new Error(
        "Executable-input scan exceeded its deterministic file/byte bound",
      );
    }
    const text = await readFile(resolved, "utf8");
    findings.push(...destructiveAuthoredContentFindings(text, relative));
  };

  await visit(root);
  for (const relative of additionalPaths) {
    if (
      typeof relative !== "string" ||
      relative.includes("\0") ||
      path.isAbsolute(relative) ||
      relative.replaceAll("\\", "/").split("/").includes("..")
    ) {
      throw new Error(`Unsafe additional executable-input path: ${relative}`);
    }
    try {
      await visit(path.resolve(root, relative));
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return {
    safe: findings.length === 0,
    findings,
    scannedFiles: files,
    scannedBytes: bytes,
    limitation:
      "Static source/config scanning cannot prove opaque prebuilt hooks or packages deletion-free; organizational package review remains required.",
  };
}
