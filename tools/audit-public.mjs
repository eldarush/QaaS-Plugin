#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const toolDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(toolDirectory, "..");
const ignoredTopLevel = new Set([".git", "dist"]);
const allowedTopLevel = new Set([
  ".claude-plugin",
  ".github",
  "plugins",
  "docs",
  "tools",
  ".gitattributes",
  ".gitignore",
  "README.md",
  "CHANGELOG.md",
  "THIRD_PARTY_NOTICES.md",
  "version.json",
  "package.json",
]);
const errors = [];

function walk(directory, relativeBase = "") {
  const files = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    if (relativeBase === "" && ignoredTopLevel.has(entry.name)) continue;
    const relativePath = path.posix.join(
      relativeBase,
      entry.name.replaceAll("\\", "/"),
    );
    const absolutePath = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      errors.push(`${relativePath}: symbolic links are forbidden in public source`);
    } else if (entry.isDirectory()) {
      files.push(...walk(absolutePath, relativePath));
    } else if (entry.isFile()) {
      files.push({ relativePath, absolutePath });
    }
  }
  return files;
}

const files = walk(repositoryRoot);
for (const { relativePath, absolutePath } of files) {
  const basename = path.posix.basename(relativePath);
  const topLevel = relativePath.split("/")[0];
  if (!allowedTopLevel.has(topLevel)) {
    errors.push(`${relativePath}: path is outside the public source allowlist`);
  }
  if (/^licen[cs]e(?:\.|$)/iu.test(basename)) {
    errors.push(`${relativePath}: project LICENSE files are forbidden`);
  }
  if (
    basename === ".env" ||
    basename.startsWith(".env.") ||
    [".log", ".zim", ".pfx", ".p12", ".pem", ".key"].some((extension) =>
      basename.toLowerCase().endsWith(extension),
    ) ||
    ["credentials.json", "secrets.json", ".npmrc", ".pypirc"].includes(
      basename.toLowerCase(),
    )
  ) {
    errors.push(`${relativePath}: credential, raw log, or private artifact file`);
  }
  const size = fs.statSync(absolutePath).size;
  if (size > 1024 * 1024) {
    errors.push(`${relativePath}: public source file exceeds 1 MiB`);
  }
  if (size === 0) errors.push(`${relativePath}: empty source file`);

  if (size > 512 * 1024) continue;
  const content = fs.readFileSync(absolutePath, "utf8");
  if (relativePath === "tools/audit-public.mjs") continue;
  const forbiddenContent = [
    ["private lab marker", /QaaS-Plugin-Lab|prototype-reference/iu],
    ["Windows user path", /[A-Za-z]:[\\/]Users[\\/]/u],
    ["implementation drive path", /D:\\QaaS\\/iu],
    ["Unix home path", /\/home\/[A-Za-z0-9._-]+\//u],
    ["macOS user path", /\/Users\/[A-Za-z0-9._-]+\//u],
    ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
    ["GitHub token", /\bgh[opsu]_[A-Za-z0-9]{30,}\b/u],
    ["GitHub fine-grained token", /\bgithub_pat_[A-Za-z0-9_]{20,}\b/u],
    ["GitLab token", /\bglpat-[A-Za-z0-9_-]{12,}\b/u],
    ["API key token", /\bsk-[A-Za-z0-9_-]{20,}\b/u],
    ["AWS access key", /\bAKIA[A-Z0-9]{16}\b/u],
    ["JWT", /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u],
    ["authorization value", /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}\b/u],
    ["credential-bearing URL", /https?:\/\/[^/\s:@]+:[^/\s@]+@/u],
  ];
  for (const [label, pattern] of forbiddenContent) {
    if (pattern.test(content)) errors.push(`${relativePath}: ${label}`);
  }
}

const marketplace = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, ".claude-plugin", "marketplace.json"),
    "utf8",
  ),
);
const plugin = JSON.parse(
  fs.readFileSync(
    path.join(
      repositoryRoot,
      "plugins",
      "qaas",
      ".claude-plugin",
      "plugin.json",
    ),
    "utf8",
  ),
);
if (Object.hasOwn(plugin, "license")) {
  errors.push("plugins/qaas/.claude-plugin/plugin.json: license field is forbidden");
}
if ((marketplace.plugins ?? []).some((entry) => Object.hasOwn(entry, "license"))) {
  errors.push(".claude-plugin/marketplace.json: plugin license field is forbidden");
}
const packageManifest = JSON.parse(
  fs.readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
);
if (Object.hasOwn(packageManifest, "license")) {
  errors.push("package.json: license field is forbidden");
}
for (const field of [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
]) {
  if (Object.hasOwn(packageManifest, field)) {
    errors.push(`package.json: ${field} is forbidden; the plugin is dependency-free`);
  }
}

const packageManagerArtifacts = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
]);
for (const { relativePath } of files) {
  const segments = relativePath.split("/");
  if (segments.includes("node_modules")) {
    errors.push(`${relativePath}: node_modules content is forbidden`);
  }
  if (packageManagerArtifacts.has(path.posix.basename(relativePath))) {
    errors.push(`${relativePath}: package-manager lockfiles are forbidden`);
  }
}

function isLocalOrBuiltInSpecifier(specifier) {
  return (
    specifier.startsWith("node:") ||
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file:")
  );
}

for (const { relativePath, absolutePath } of files) {
  if (!/\.(?:mjs|js|cjs)$/iu.test(relativePath)) continue;
  const content = fs.readFileSync(absolutePath, "utf8");
  const importPatterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of importPatterns) {
    for (const match of content.matchAll(pattern)) {
      const specifier = match[1];
      if (!isLocalOrBuiltInSpecifier(specifier)) {
        errors.push(
          `${relativePath}: third-party module import is forbidden (${specifier})`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  process.stderr.write(`Public-tree audit failed:\n- ${errors.join("\n- ")}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`Public-tree audit passed (${files.length} files).\n`);
}
