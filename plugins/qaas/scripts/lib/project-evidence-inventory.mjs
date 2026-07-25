import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { redactText, secretFindings } from "./redact.mjs";

export const PROJECT_INVENTORY_LIMITS = Object.freeze({
  maxEntries: 20_000,
  maxFiles: 5_000,
  maxFileBytes: 64 * 1024,
  maxReadBytes: 4 * 1024 * 1024,
  maxPathsPerCategory: 12,
  maxEvidencePerSignal: 4,
  maxPackageReferences: 24,
  maxPathBytes: 240,
  maxMetadataBytes: 160,
  maxOutputBytes: 24 * 1024,
});

const INTERNAL_PACKAGE_CANDIDATE_LIMIT = 256;
const CASE_COLLISION_LIMIT = 8;
const SKIPPED_DIRECTORY_EVIDENCE_LIMIT = 12;

const SKIPPED_DIRECTORIES = new Set([
  ".angular",
  ".cache",
  ".git",
  ".gradle",
  ".hg",
  ".idea",
  ".next",
  ".nuget",
  ".pytest_cache",
  ".svn",
  ".terraform",
  ".vs",
  ".vscode",
  "__pycache__",
  "artifacts",
  "bin",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "obj",
  "out",
  "packages",
  "results",
  "target",
  "testresults",
  "vendor",
]);

const TEXT_EXTENSIONS = new Set([
  ".config",
  ".cs",
  ".csproj",
  ".fsproj",
  ".json",
  ".md",
  ".props",
  ".proto",
  ".service",
  ".sln",
  ".slnx",
  ".targets",
  ".textproto",
  ".txt",
  ".vbproj",
  ".xml",
  ".yaml",
  ".yml",
]);

const SAMPLE_EXTENSIONS = new Set([
  ".bin",
  ".dat",
  ".hex",
  ".json",
  ".pb",
  ".proto",
  ".textproto",
  ".xml",
]);
const BINARY_SAMPLE_EXTENSIONS = new Set([".bin", ".dat", ".hex", ".pb"]);

const PROJECT_EXTENSIONS = new Set([
  ".csproj",
  ".fsproj",
  ".sln",
  ".slnx",
  ".vbproj",
]);

const YAML_EXTENSIONS = new Set([".yaml", ".yml"]);
const CUSTOM_HOOK_NAMES = ["assertion", "generator", "probe", "processor"];

const SIGNAL_RULES = Object.freeze({
  protocols: {
    http: /\b(?:http|https|httpclient|rest)\b/iu,
    grpc: /\b(?:grpc|rpc)\b/iu,
    kafka: /\b(?:kafka|topic)\b/iu,
    rabbitmq: /\b(?:rabbitmq|rabbit|amqp|queue)\b/iu,
    "tcp-socket": /\b(?:tcp|socket)\b/iu,
  },
  serializations: {
    json: /\bjson\b|\.json\b/iu,
    xml: /\bxml\b|\.xml\b/iu,
    protobuf: /\b(?:protobuf|google\.protobuf|textproto)\b|\.proto\b/iu,
    binary: /\b(?:binary|byte array|byte\[\])\b|\.(?:bin|dat|hex)\b/iu,
  },
  infrastructure: {
    kubernetes: /\b(?:kubernetes|kubectl|helm|chart\.yaml|k8s)\b/iu,
    "vm-service": /\b(?:virtual machine|vm service|systemd|windows service)\b|\.service\b/iu,
    "physical-process": /\b(?:physical machine|bare metal|standalone process)\b/iu,
  },
  composition: {
    anchors: /(?:^|\s)&[A-Za-z0-9_-]+|(?:^|\s)\*[A-Za-z0-9_-]+|<<\s*:/mu,
    variables: /\$\{[^}\r\n]+\}|\$\([^)]+\)/u,
    modules: /\bmodules?\b/iu,
    executables: /\bexecutables?\b/iu,
    cases: /\bcases?\b/iu,
  },
  testIntents: {
    smoke: /\bsmoke\b/iu,
    systemic: /\bsystemic\b/iu,
    stress: /\b(?:stress|loadbalance|load balance)\b/iu,
    fuzz: /\b(?:fuzz|negative|malformed|invalid input)\b/iu,
    logic: /\blogic\b/iu,
  },
  observability: {
    allure: /\ballure\b/iu,
    reportportal: /\breport\s*portal\b|\breportportal\b/iu,
    elastic: /\b(?:elastic|elasticsearch)\b/iu,
    thanos: /\bthanos\b/iu,
    prometheus: /\bprometheus\b/iu,
  },
});

function normalizeRelative(value) {
  return value.replaceAll("\\", "/");
}

export function isPathInsideProject(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function pushUniqueBounded(target, value, maximum, onDrop) {
  if (target.includes(value)) return;
  if (target.length >= maximum) {
    onDrop();
    return;
  }
  target.push(value);
}

function addSignal(signals, group, value, evidence, dropped) {
  signals[group] ??= {};
  signals[group][value] ??= [];
  pushUniqueBounded(
    signals[group][value],
    evidence,
    PROJECT_INVENTORY_LIMITS.maxEvidencePerSignal,
    () => {
      dropped.signalEvidence += 1;
    },
  );
}

function boundedUtf8(value, maximumBytes) {
  const original = String(value);
  const withoutControls = original
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ")
    .replace(
      /\b(?:https?|ftp|file):\/\/[^\s"'<>]+/giu,
      "[url-redacted]",
    );
  if (Buffer.byteLength(withoutControls, "utf8") <= maximumBytes) {
    return {
      value: withoutControls,
      sanitized: withoutControls !== original,
      truncated: false,
    };
  }

  const suffix = "…";
  const suffixBytes = Buffer.byteLength(suffix, "utf8");
  let bounded = "";
  let bytes = 0;
  for (const character of withoutControls) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (bytes + characterBytes + suffixBytes > maximumBytes) break;
    bounded += character;
    bytes += characterBytes;
  }
  return {
    value: `${bounded}${suffix}`,
    sanitized: withoutControls !== original,
    truncated: true,
  };
}

function outputPath(value, dropped) {
  const normalized = normalizeRelative(value);
  const redacted = redactText(normalized);
  if (redacted !== normalized) dropped.sanitizedPaths += 1;
  const bounded = boundedUtf8(
    redacted,
    PROJECT_INVENTORY_LIMITS.maxPathBytes,
  );
  if (bounded.sanitized) dropped.sanitizedStrings += 1;
  if (bounded.truncated) dropped.truncatedStrings += 1;
  return bounded.value;
}

function containsSecretLikeValue(value) {
  return (
    typeof value === "string" &&
    (redactText(value) !== value || secretFindings(value).length > 0)
  );
}

export async function readFileBounded(filePath, maximumBytes) {
  if (
    !Number.isSafeInteger(maximumBytes) ||
    maximumBytes < 0 ||
    maximumBytes > PROJECT_INVENTORY_LIMITS.maxFileBytes
  ) {
    throw new TypeError(
      `maximumBytes must be an integer from 0 through ${PROJECT_INVENTORY_LIMITS.maxFileBytes}`,
    );
  }

  const handle = await open(filePath, "r");
  try {
    const allocation = Buffer.allocUnsafe(maximumBytes + 1);
    let totalBytes = 0;
    while (totalBytes < allocation.byteLength) {
      const { bytesRead } = await handle.read(
        allocation,
        totalBytes,
        allocation.byteLength - totalBytes,
        totalBytes,
      );
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
    }
    return {
      buffer: allocation.subarray(0, Math.min(totalBytes, maximumBytes)),
      exceeded: totalBytes > maximumBytes,
    };
  } finally {
    await handle.close();
  }
}

function signalDocument(signals, dropped) {
  return Object.fromEntries(
    Object.entries(signals)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([group, values]) => [
        group,
        Object.entries(values)
          .sort(([left], [right]) => left.localeCompare(right, "en"))
          .map(([value, evidence]) => ({
            value,
            evidence: [...new Set(evidence.map((item) => outputPath(item, dropped)))]
              .sort(),
          })),
      ]),
  );
}

function isCiWorkflow(lowerPath, basename) {
  return (
    lowerPath.startsWith(".github/workflows/") ||
    basename === ".gitlab-ci.yml" ||
    basename === ".gitlab-ci.yaml" ||
    basename === "azure-pipelines.yml" ||
    basename === "azure-pipelines.yaml" ||
    basename === "jenkinsfile"
  );
}

function isComposeFile(basename) {
  return /^(?:docker-)?compose(?:\.[a-z0-9_.-]+)?\.ya?ml$/u.test(basename);
}

function isHighConfidenceQaaSYaml(lowerPath, basename, segments) {
  return (
    /(?:^|[._-])qaas(?:[._-]|$)/u.test(basename) ||
    segments.includes("qaas") ||
    lowerPath.startsWith("qaas/")
  );
}

function categoryFor(relativePath) {
  const slash = normalizeRelative(relativePath);
  const lower = slash.toLowerCase();
  const extension = path.extname(lower);
  const basename = path.basename(lower);
  const segments = lower.split("/");

  if (isCiWorkflow(lower, basename)) return "ciWorkflows";
  if (PROJECT_EXTENSIONS.has(extension)) return "dotnetProjects";
  if (
    basename === "nuget.config" ||
    [".props", ".targets"].includes(extension)
  ) {
    return "packageConfiguration";
  }
  if (
    extension === ".cs" &&
    CUSTOM_HOOK_NAMES.some((name) => basename.includes(name))
  ) {
    return "customHookCode";
  }
  if (
    segments.some((segment) => ["samples", "testdata"].includes(segment)) ||
    BINARY_SAMPLE_EXTENSIONS.has(extension) ||
    (SAMPLE_EXTENSIONS.has(extension) &&
      /(?:sample|request|response|input|output|message|event|order)/u.test(
        basename,
      ))
  ) {
    return "samples";
  }
  if (
    basename === "chart.yaml" ||
    basename === "dockerfile" ||
    isComposeFile(basename) ||
    extension === ".service" ||
    segments.some((segment) =>
      ["deploy", "deployment", "helm", "k8s", "kubernetes"].includes(segment),
    )
  ) {
    return "infrastructure";
  }
  if (YAML_EXTENSIONS.has(extension)) {
    return isHighConfidenceQaaSYaml(lower, basename, segments)
      ? "qaasConfiguration"
      : "yamlCandidates";
  }
  if ([".md", ".txt"].includes(extension)) return "documentation";
  if (extension === ".cs") return "csharp";
  return "otherRelevant";
}

function addPathTrait(pathTraits, relativePath) {
  if (relativePath.includes(" ")) pathTraits.spaces = true;
  if (/[^\u0000-\u007f]/u.test(relativePath)) pathTraits.nonAscii = true;
}

function isEvidenceDocument(relativePath) {
  const segments = normalizeRelative(relativePath).toLowerCase().split("/");
  return segments.some((segment) =>
    ["allure-results", "evidence", "reports", "results", "testresults"].includes(
      segment,
    ),
  );
}

function inspectEvidenceDocument({ relativePath, text, signals, dropped }) {
  for (const [value, expression] of Object.entries(
    SIGNAL_RULES.observability,
  )) {
    if (expression.test(text)) {
      addSignal(signals, "observability", value, relativePath, dropped);
    }
  }
}

function parseAttributes(value) {
  const attributes = {};
  const expression =
    /([A-Za-z_:][A-Za-z0-9_.:-]*)\s*=\s*(["'])([\s\S]*?)\2/gu;
  for (const match of value.matchAll(expression)) {
    attributes[match[1].toLowerCase()] = match[3];
  }
  return attributes;
}

function xmlElements(text, tagName) {
  const withoutComments = text.replace(/<!--[\s\S]*?-->/gu, "");
  const expression = new RegExp(
    `<${tagName}\\b([^>]*?)(?:\\/\\s*>|>([\\s\\S]*?)<\\/${tagName}\\s*>)`,
    "giu",
  );
  return [...withoutComments.matchAll(expression)].map((match) => ({
    attributes: parseAttributes(match[1]),
    body: match[2] ?? "",
  }));
}

function nestedVersion(body) {
  return body.match(/<Version\b[^>]*>([\s\S]*?)<\/Version\s*>/iu)?.[1]?.trim();
}

function sanitizePackageId(value) {
  if (typeof value !== "string") return null;
  const candidate = value.trim();
  if (
    candidate.length < 1 ||
    candidate.length > 100 ||
    /[\u0000-\u001f\u007f]/u.test(candidate) ||
    /\b(?:https?|ftp|file):\/\//iu.test(candidate) ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,98}[A-Za-z0-9])?$/u.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function sanitizePackageVersion(value) {
  if (value === undefined || value === null || value.trim() === "") return null;
  const candidate = value.trim();
  if (
    Buffer.byteLength(candidate, "utf8") >
      PROJECT_INVENTORY_LIMITS.maxMetadataBytes ||
    /[\u0000-\u001f\u007f]/u.test(candidate) ||
    /\b(?:https?|ftp|file):\/\//iu.test(candidate) ||
    !/^[A-Za-z0-9*+_.\-,()[\]{}$<>=!~^|: ]+$/u.test(candidate)
  ) {
    return null;
  }
  return candidate;
}

function registerPackageCandidate({
  type,
  attributes,
  body,
  relativePath,
  packageCandidates,
  centralVersions,
  dropped,
}) {
  const rawName = attributes.include ?? attributes.update;
  if (containsSecretLikeValue(rawName)) {
    dropped.invalidPackageIds += 1;
    dropped.sensitivePackageIds += 1;
    return;
  }
  const name = sanitizePackageId(rawName);
  if (!name) {
    dropped.invalidPackageIds += 1;
    return;
  }

  const attributeVersion = attributes.version;
  const childVersion = nestedVersion(body);
  const rawVersion = attributeVersion ?? childVersion;
  const sensitiveVersion = containsSecretLikeValue(rawVersion);
  if (sensitiveVersion) {
    dropped.sensitivePackageVersions += 1;
  }
  const version = sensitiveVersion ? null : sanitizePackageVersion(rawVersion);
  if (rawVersion !== undefined && rawVersion !== null && version === null) {
    dropped.invalidPackageVersions += 1;
  }
  const versionSource =
    attributeVersion !== undefined
      ? "attribute"
      : childVersion !== undefined
        ? "nested"
        : "unresolved";

  if (type === "PackageVersion" && version !== null) {
    const key = name.toLowerCase();
    if (!centralVersions.has(key)) {
      centralVersions.set(key, { name, version, evidence: relativePath });
    }
  }

  if (packageCandidates.length >= INTERNAL_PACKAGE_CANDIDATE_LIMIT) {
    dropped.packageReferences += 1;
    return;
  }
  packageCandidates.push({
    type,
    name,
    version,
    versionSource,
    evidence: relativePath,
    hadInvalidVersion:
      rawVersion !== undefined && rawVersion !== null && version === null,
  });
}

function inspectPackageMetadata({
  relativePath,
  text,
  packageCandidates,
  centralVersions,
  dropped,
}) {
  const extension = path.extname(relativePath).toLowerCase();
  const basename = path.basename(relativePath).toLowerCase();
  if (
    ![".csproj", ".fsproj", ".vbproj", ".props"].includes(extension) &&
    basename !== "directory.packages.props"
  ) {
    return;
  }

  for (const element of xmlElements(text, "PackageReference")) {
    registerPackageCandidate({
      type: "PackageReference",
      ...element,
      relativePath,
      packageCandidates,
      centralVersions,
      dropped,
    });
  }
  for (const element of xmlElements(text, "PackageVersion")) {
    registerPackageCandidate({
      type: "PackageVersion",
      ...element,
      relativePath,
      packageCandidates,
      centralVersions,
      dropped,
    });
  }
}

function inspectText({
  relativePath,
  text,
  includePathSignals,
  signals,
  packageCandidates,
  centralVersions,
  dropped,
}) {
  const searchable = includePathSignals ? `${relativePath}\n${text}` : text;
  for (const [group, rules] of Object.entries(SIGNAL_RULES)) {
    for (const [value, expression] of Object.entries(rules)) {
      if (expression.test(searchable)) {
        addSignal(signals, group, value, relativePath, dropped);
      }
    }
  }

  const basename = path.basename(relativePath).toLowerCase();
  for (const hookName of CUSTOM_HOOK_NAMES) {
    if (
      basename.includes(hookName) ||
      new RegExp(`\\bI${hookName}\\b|\\b${hookName}\\b`, "iu").test(text)
    ) {
      addSignal(signals, "extensions", hookName, relativePath, dropped);
    }
  }
  if (/\bQaaS\.Common\.[A-Za-z0-9_.-]+\b/iu.test(text)) {
    addSignal(
      signals,
      "extensions",
      "common-hooks-package",
      relativePath,
      dropped,
    );
  }
  if (/\bnet8\.0\b/iu.test(text)) {
    addSignal(signals, "upgrade", "dotnet-8", relativePath, dropped);
  }

  inspectPackageMetadata({
    relativePath,
    text,
    packageCandidates,
    centralVersions,
    dropped,
  });
}

function packageDocument(packageCandidates, centralVersions, dropped) {
  const unique = new Map();
  for (const candidate of packageCandidates) {
    let version = candidate.version;
    let versionSource = candidate.versionSource;
    if (
      candidate.type === "PackageReference" &&
      version === null &&
      !candidate.hadInvalidVersion
    ) {
      const central = centralVersions.get(candidate.name.toLowerCase());
      if (central) {
        version = central.version;
        versionSource = "central";
      }
    } else if (candidate.type === "PackageVersion") {
      versionSource = "PackageVersion";
    }

    const evidence = outputPath(candidate.evidence, dropped);
    const record = {
      name: candidate.name,
      version,
      versionSource,
      evidence,
    };
    const key = JSON.stringify(record);
    if (!unique.has(key)) unique.set(key, record);
  }

  const sorted = [...unique.values()].sort((left, right) =>
    `${left.name}:${left.version ?? ""}:${left.versionSource}:${left.evidence}`.localeCompare(
      `${right.name}:${right.version ?? ""}:${right.versionSource}:${right.evidence}`,
      "en",
    ),
  );
  if (sorted.length > PROJECT_INVENTORY_LIMITS.maxPackageReferences) {
    dropped.packageReferences +=
      sorted.length - PROJECT_INVENTORY_LIMITS.maxPackageReferences;
  }
  return sorted.slice(0, PROJECT_INVENTORY_LIMITS.maxPackageReferences);
}

function serializedBytes(report) {
  return Buffer.byteLength(`${JSON.stringify(report, null, 2)}\n`, "utf8");
}

function pruneReportToBudget(report) {
  const dropLastFrom = (collection, droppedKey) => {
    for (const value of Object.values(collection).reverse()) {
      if (Array.isArray(value) && value.length > 1) {
        value.pop();
        report.dropped[droppedKey] += 1;
        report.dropped.outputItems += 1;
        return true;
      }
    }
    return false;
  };

  while (serializedBytes(report) > PROJECT_INVENTORY_LIMITS.maxOutputBytes) {
    let changed = false;

    for (const group of Object.values(report.signals).reverse()) {
      for (const signal of [...group].reverse()) {
        if (signal.evidence.length > 1) {
          signal.evidence.pop();
          report.dropped.signalEvidence += 1;
          report.dropped.outputItems += 1;
          changed = true;
          break;
        }
      }
      if (changed) break;
    }
    if (!changed) changed = dropLastFrom(report.files, "filePaths");
    if (!changed && report.packageReferences.length > 0) {
      report.packageReferences.pop();
      report.dropped.packageReferences += 1;
      report.dropped.outputItems += 1;
      changed = true;
    }
    if (
      !changed &&
      report.pathTraits.caseCollisionCandidates.length > 0
    ) {
      report.pathTraits.caseCollisionCandidates.pop();
      report.dropped.caseCollisionCandidates += 1;
      report.dropped.outputItems += 1;
      changed = true;
    }
    if (
      !changed &&
      report.skipped.generatedOrVendorDirectories.length > 0
    ) {
      report.skipped.generatedOrVendorDirectories.pop();
      report.dropped.skippedDirectoryPaths += 1;
      report.dropped.outputItems += 1;
      changed = true;
    }
    if (!changed) {
      for (const groupName of Object.keys(report.signals).reverse()) {
        const group = report.signals[groupName];
        if (group.length > 0) {
          group.pop();
          report.dropped.signals += 1;
          report.dropped.outputItems += 1;
          changed = true;
          if (group.length === 0) delete report.signals[groupName];
          break;
        }
      }
    }
    if (!changed) {
      for (const category of Object.keys(report.files).reverse()) {
        const values = report.files[category];
        if (values.length > 0) {
          values.pop();
          report.dropped.filePaths += 1;
          report.dropped.outputItems += 1;
          changed = true;
          if (values.length === 0) delete report.files[category];
          break;
        }
      }
    }
    if (!changed) break;
    report.reportingTruncated = true;
    report.truncated = true;
  }
  return report;
}

export function serializeProjectInventory(inventory) {
  const output = `${JSON.stringify(inventory, null, 2)}\n`;
  if (
    Buffer.byteLength(output, "utf8") <=
    PROJECT_INVENTORY_LIMITS.maxOutputBytes
  ) {
    return output;
  }

  return `${JSON.stringify(
    {
      schemaVersion: "1.1.0",
      authority: "candidate-evidence-only",
      root: ".",
      truncated: true,
      reportingTruncated: true,
      dropped: { outputItems: 1 },
      requiredInterpretation:
        "Inventory output was reduced. Treat every surviving item as tentative and ask the user before assigning semantics.",
    },
    null,
    2,
  )}\n`;
}

export async function inventoryProject(projectRoot) {
  const canonicalRoot = await realpath(path.resolve(projectRoot));
  const categories = {};
  const signals = {};
  const packageCandidates = [];
  const centralVersions = new Map();
  const skippedDirectories = [];
  const pathTraits = {
    spaces: false,
    nonAscii: false,
    caseCollisionCandidates: [],
  };
  const seenCasePaths = new Map();
  const counts = {
    entriesSeen: 0,
    filesSeen: 0,
    filesRead: 0,
    bytesRead: 0,
    skippedDirectories: 0,
    skippedLinks: 0,
    skippedOversizedFiles: 0,
    skippedUnreadableEntries: 0,
    skippedAfterLimit: 0,
    skippedAfterLimitCapped: false,
  };
  const dropped = {
    filePaths: 0,
    signalEvidence: 0,
    signals: 0,
    packageReferences: 0,
    caseCollisionCandidates: 0,
    skippedDirectoryPaths: 0,
    invalidPackageIds: 0,
    invalidPackageVersions: 0,
    sensitivePackageIds: 0,
    sensitivePackageVersions: 0,
    sanitizedPaths: 0,
    sanitizedStrings: 0,
    truncatedStrings: 0,
    outputItems: 0,
  };
  let scanTruncated = false;

  async function walk(directory) {
    if (
      counts.filesSeen >= PROJECT_INVENTORY_LIMITS.maxFiles ||
      counts.entriesSeen >= PROJECT_INVENTORY_LIMITS.maxEntries
    ) {
      scanTruncated = true;
      return;
    }

    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      counts.skippedUnreadableEntries += 1;
      scanTruncated = true;
      return;
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (let index = 0; index < entries.length; index += 1) {
      if (
        counts.filesSeen >= PROJECT_INVENTORY_LIMITS.maxFiles ||
        counts.entriesSeen >= PROJECT_INVENTORY_LIMITS.maxEntries
      ) {
        scanTruncated = true;
        const unvisitedHere = entries.length - index;
        const reportableRemaining = Math.max(
          0,
          PROJECT_INVENTORY_LIMITS.maxEntries -
            counts.entriesSeen -
            counts.skippedAfterLimit,
        );
        counts.skippedAfterLimit += Math.min(
          unvisitedHere,
          reportableRemaining,
        );
        if (unvisitedHere > reportableRemaining) {
          counts.skippedAfterLimitCapped = true;
        }
        return;
      }

      const entry = entries[index];
      counts.entriesSeen += 1;
      const absolutePath = path.join(directory, entry.name);
      const relativePath = normalizeRelative(
        path.relative(canonicalRoot, absolutePath),
      );

      if (
        entry.isDirectory() &&
        SKIPPED_DIRECTORIES.has(entry.name.toLowerCase())
      ) {
        counts.skippedDirectories += 1;
        pushUniqueBounded(
          skippedDirectories,
          relativePath,
          SKIPPED_DIRECTORY_EVIDENCE_LIMIT,
          () => {
            dropped.skippedDirectoryPaths += 1;
          },
        );
        continue;
      }

      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch {
        counts.skippedUnreadableEntries += 1;
        scanTruncated = true;
        continue;
      }
      if (entry.isSymbolicLink() || metadata.isSymbolicLink()) {
        counts.skippedLinks += 1;
        continue;
      }
      if (metadata.isDirectory()) {
        let canonicalDirectory;
        try {
          canonicalDirectory = await realpath(absolutePath);
        } catch {
          counts.skippedUnreadableEntries += 1;
          scanTruncated = true;
          continue;
        }
        if (!isPathInsideProject(canonicalRoot, canonicalDirectory)) {
          counts.skippedLinks += 1;
          continue;
        }
        await walk(canonicalDirectory);
        continue;
      }
      if (
        !metadata.isFile() ||
        !isPathInsideProject(canonicalRoot, absolutePath)
      ) {
        continue;
      }

      counts.filesSeen += 1;
      addPathTrait(pathTraits, relativePath);
      const folded =
        process.platform === "win32"
          ? relativePath.toLocaleLowerCase("en-US")
          : relativePath.toLowerCase();
      const prior = seenCasePaths.get(folded);
      if (prior && prior !== relativePath) {
        pushUniqueBounded(
          pathTraits.caseCollisionCandidates,
          prior,
          CASE_COLLISION_LIMIT,
          () => {
            dropped.caseCollisionCandidates += 1;
          },
        );
        pushUniqueBounded(
          pathTraits.caseCollisionCandidates,
          relativePath,
          CASE_COLLISION_LIMIT,
          () => {
            dropped.caseCollisionCandidates += 1;
          },
        );
      } else {
        seenCasePaths.set(folded, relativePath);
      }

      const category = categoryFor(relativePath);
      categories[category] ??= [];
      pushUniqueBounded(
        categories[category],
        relativePath,
        PROJECT_INVENTORY_LIMITS.maxPathsPerCategory,
        () => {
          dropped.filePaths += 1;
        },
      );

      const extension = path.extname(relativePath).toLowerCase();
      if (category === "documentation" && !isEvidenceDocument(relativePath)) {
        continue;
      }
      if (!TEXT_EXTENSIONS.has(extension)) {
        inspectText({
          relativePath,
          text: "",
          includePathSignals: true,
          signals,
          packageCandidates,
          centralVersions,
          dropped,
        });
        continue;
      }
      if (
        metadata.size > PROJECT_INVENTORY_LIMITS.maxFileBytes ||
        counts.bytesRead + metadata.size >
          PROJECT_INVENTORY_LIMITS.maxReadBytes
      ) {
        counts.skippedOversizedFiles += 1;
        scanTruncated = true;
        continue;
      }

      let boundedRead;
      try {
        const remainingAggregateBytes =
          PROJECT_INVENTORY_LIMITS.maxReadBytes - counts.bytesRead;
        const allowedBytes = Math.min(
          PROJECT_INVENTORY_LIMITS.maxFileBytes,
          Math.max(0, remainingAggregateBytes),
        );
        boundedRead = await readFileBounded(absolutePath, allowedBytes);
      } catch {
        counts.skippedUnreadableEntries += 1;
        scanTruncated = true;
        continue;
      }
      if (
        boundedRead.exceeded ||
        counts.bytesRead + boundedRead.buffer.byteLength >
          PROJECT_INVENTORY_LIMITS.maxReadBytes
      ) {
        counts.skippedOversizedFiles += 1;
        scanTruncated = true;
        continue;
      }
      const text = boundedRead.buffer.toString("utf8");
      counts.filesRead += 1;
      counts.bytesRead += boundedRead.buffer.byteLength;
      if (category === "documentation") {
        inspectEvidenceDocument({
          relativePath,
          text,
          signals,
          dropped,
        });
        continue;
      }
      inspectText({
        relativePath,
        text,
        includePathSignals: true,
        signals,
        packageCandidates,
        centralVersions,
        dropped,
      });
    }
  }

  await walk(canonicalRoot);
  if ((categories.qaasConfiguration?.length ?? 0) > 1) {
    addSignal(
      signals,
      "composition",
      "multiple-configuration-files",
      categories.qaasConfiguration[0],
      dropped,
    );
  }
  if ((categories.dotnetProjects?.length ?? 0) > 1) {
    addSignal(
      signals,
      "repositoryShape",
      "multiple-dotnet-projects",
      categories.dotnetProjects[0],
      dropped,
    );
  }

  const files = Object.fromEntries(
    Object.entries(categories)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([category, values]) => [
        category,
        [...new Set(values.map((value) => outputPath(value, dropped)))].sort(),
      ]),
  );
  const report = {
    schemaVersion: "1.1.0",
    authority: "candidate-evidence-only",
    root: ".",
    limits: PROJECT_INVENTORY_LIMITS,
    truncated: scanTruncated,
    reportingTruncated: false,
    counts,
    dropped,
    skipped: {
      generatedOrVendorDirectories: [
        ...new Set(
          skippedDirectories.map((value) => outputPath(value, dropped)),
        ),
      ].sort(),
    },
    pathTraits: {
      ...pathTraits,
      caseCollisionCandidates: [
        ...new Set(
          pathTraits.caseCollisionCandidates.map((value) =>
            outputPath(value, dropped),
          ),
        ),
      ].sort(),
    },
    files,
    signals: signalDocument(signals, dropped),
    packageReferences: packageDocument(
      packageCandidates,
      centralVersions,
      dropped,
    ),
    requiredInterpretation:
      "Treat every role and signal as tentative. Ask for the user's short explanation before assigning semantics; documentation and approved evidence still govern readiness.",
  };

  report.reportingTruncated =
    dropped.filePaths > 0 ||
    dropped.signalEvidence > 0 ||
    dropped.packageReferences > 0 ||
    dropped.caseCollisionCandidates > 0 ||
    dropped.skippedDirectoryPaths > 0 ||
    dropped.invalidPackageIds > 0 ||
    dropped.invalidPackageVersions > 0 ||
    dropped.sensitivePackageIds > 0 ||
    dropped.sensitivePackageVersions > 0 ||
    dropped.sanitizedPaths > 0 ||
    dropped.sanitizedStrings > 0 ||
    dropped.truncatedStrings > 0;
  if (report.reportingTruncated) report.truncated = true;
  return pruneReportToBudget(report);
}
