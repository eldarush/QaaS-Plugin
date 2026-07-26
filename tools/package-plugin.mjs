#!/usr/bin/env node

import crypto from "node:crypto";
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

const fixedFiles = [
  ".claude-plugin/marketplace.json",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "version.json",
];

function collectFiles(directory, prefix) {
  const result = [];
  for (const entry of fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name.localeCompare(right.name, "en"))) {
    const absolutePath = path.join(directory, entry.name);
    const relativePath = `${prefix}/${entry.name}`.replaceAll("\\", "/");
    if (entry.isSymbolicLink()) {
      throw new Error(`Symbolic links are not packageable: ${relativePath}`);
    } else if (entry.isDirectory()) {
      result.push(...collectFiles(absolutePath, relativePath));
    } else if (entry.isFile()) {
      result.push(relativePath);
    }
  }
  return result;
}

const relativeFiles = [
  ...fixedFiles,
  ...collectFiles(path.join(repositoryRoot, "plugins", "qaas"), "plugins/qaas"),
].sort((left, right) => left.localeCompare(right, "en"));

for (const relativePath of relativeFiles) {
  const basename = path.posix.basename(relativePath);
  if (
    /^licen[cs]e(?:\.|$)/iu.test(basename) ||
    relativePath.startsWith("dist/") ||
    relativePath.split("/").includes("node_modules") ||
    [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
    ].includes(basename) ||
    relativePath.includes(["QaaS", "Plugin", "Lab"].join("-"))
  ) {
    throw new Error(`Disallowed package entry: ${relativePath}`);
  }
}

function assertDependencyFreeJavaScript(relativePath, data) {
  if (!/\.(?:mjs|js|cjs)$/iu.test(relativePath)) return;
  const text = data.toString("utf8");
  const patterns = [
    /\b(?:import|export)\s+(?:[\s\S]*?\s+from\s+)?["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (
        !specifier.startsWith("node:") &&
        !specifier.startsWith("./") &&
        !specifier.startsWith("../") &&
        !specifier.startsWith("/") &&
        !specifier.startsWith("file:")
      ) {
        throw new Error(
          `Third-party module import is not packageable: ${relativePath} -> ${specifier}`,
        );
      }
    }
  }
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) !== 0 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function localHeader(name, data, checksum) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0x0021, 12);
  header.writeUInt32LE(checksum, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(nameBuffer.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, nameBuffer]);
}

function centralHeader(name, data, checksum, offset) {
  const nameBuffer = Buffer.from(name, "utf8");
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(0x0314, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(0x0021, 14);
  header.writeUInt32LE(checksum, 16);
  header.writeUInt32LE(data.length, 20);
  header.writeUInt32LE(data.length, 24);
  header.writeUInt16LE(nameBuffer.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(offset, 42);
  return Buffer.concat([header, nameBuffer]);
}

const localParts = [];
const centralParts = [];
const fileManifest = [];
let currentOffset = 0;

for (const relativePath of relativeFiles) {
  const data = fs.readFileSync(path.join(repositoryRoot, ...relativePath.split("/")));
  assertDependencyFreeJavaScript(relativePath, data);
  const checksum = crc32(data);
  const header = localHeader(relativePath, data, checksum);
  localParts.push(header, data);
  centralParts.push(centralHeader(relativePath, data, checksum, currentOffset));
  currentOffset += header.length + data.length;
  fileManifest.push({
    path: relativePath,
    bytes: data.length,
    sha256: crypto.createHash("sha256").update(data).digest("hex"),
  });
}

const centralDirectory = Buffer.concat(centralParts);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(relativeFiles.length, 8);
end.writeUInt16LE(relativeFiles.length, 10);
end.writeUInt32LE(centralDirectory.length, 12);
end.writeUInt32LE(currentOffset, 16);
end.writeUInt16LE(0, 20);

const archive = Buffer.concat([...localParts, centralDirectory, end]);
const archiveName = `qaas-plugin-${version}.zip`;
const archivePath = path.join(distributionDirectory, archiveName);
const archiveDigest = crypto.createHash("sha256").update(archive).digest("hex");

fs.mkdirSync(distributionDirectory, { recursive: true });
fs.writeFileSync(archivePath, archive);
fs.writeFileSync(
  `${archivePath}.sha256`,
  `${archiveDigest}  ${archiveName}\n`,
  "utf8",
);
fs.writeFileSync(
  `${archivePath}.manifest.json`,
  `${JSON.stringify(
    {
      formatVersion: 1,
      pluginVersion: version,
      archive: archiveName,
      sha256: archiveDigest,
      files: fileManifest,
    },
    null,
    2,
  )}\n`,
  "utf8",
);

process.stdout.write(
  `Created ${path.relative(repositoryRoot, archivePath)} (${archiveDigest}).\n`,
);
