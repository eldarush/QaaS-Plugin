import { canonicalDigest, isSha256, safeEqualHex } from "./canonical-json.mjs";
import { secretFindings } from "./redact.mjs";
import { analyzeProcessVector } from "./shell-analyzer.mjs";
import {
  isObject,
  issue,
  rejectUnknownKeys,
  requireArray,
  requireString,
  validateCommandSpec,
  validateDigest,
  validateDateTime,
  validateRelativePath,
} from "./validation.mjs";

function validateCommon(document, kind) {
  const errors = [];
  if (!isObject(document)) {
    return [issue("$", `${kind} must be an object`, "type")];
  }
  if (document.schemaVersion !== "1.0") {
    errors.push(issue("$.schemaVersion", "must equal 1.0", "const"));
  }
  if (document.status === "template-only") {
    errors.push(issue("$.status", "template placeholder is not approvable", "gate"));
  }
  for (const finding of secretFindings(document)) {
    errors.push(
      issue(finding.path, `contains ${finding.type} secret-like data`, "secret"),
    );
  }
  return errors;
}

function validateStringList(errors, value, pathname, { minItems = 0 } = {}) {
  if (requireArray(errors, value, pathname, { minItems })) {
    value.forEach((entry, index) =>
      requireString(errors, entry, `${pathname}[${index}]`),
    );
  }
}

function validatePathList(errors, value, pathname) {
  if (requireArray(errors, value, pathname, { unique: true })) {
    value.forEach((entry, index) =>
      errors.push(...validateRelativePath(entry, `${pathname}[${index}]`)),
    );
  }
}

const CHECK_TYPES = new Set([
  "stdout-contains",
  "stderr-contains",
  "file-exists",
  "file-not-empty",
  "file-sha256",
  "text-file-contains",
  "json-pointer-equals",
]);
const ARTIFACT_CHECK_TYPES = new Set([
  "file-exists",
  "file-not-empty",
  "file-sha256",
  "text-file-contains",
  "json-pointer-equals",
]);

export const CSHARP_CLOSURE_FIELDS = Object.freeze([
  "bootstrapModeAndArguments",
  "builderTypesAndSignatures",
  "topology",
  "hookBasesInterfacesAndDiscovery",
  "configurationRecordAndBinding",
  "providerPackages",
  "yamlAndCsharpUse",
  "restoreBuildTemplateCommands",
]);

export const CSHARP_PLAN_PATH_PATTERN =
  /\.(?:cs|csproj|csx|props|targets|sln|slnx)$/iu;

const CSHARP_CLOSURE_STATUSES = new Set([
  "resolved",
  "evidence-proven-inapplicable",
]);
const CSHARP_PLACEHOLDER_PREFIX =
  /^(?:todo|tbd|unknown|pending|placeholder|n\/?a|none|null|not applicable|not set|to be (?:determined|confirmed)|fill(?: this)? (?:later|in)|\?+)(?:\s|$|[:_-])/iu;
const CSHARP_TEMPLATE_MARKER =
  /\{\{[^{}]+\}\}|<\s*(?:todo|tbd|unknown|pending|placeholder|replace(?:-?me)?|value|name|type|path)(?:\s+[^<>]*)?>|\[(?:todo|tbd|unknown|pending|placeholder)[^\]]*\]/iu;

export function taskPlanTouchesCSharp(document) {
  if (!isObject(document?.paths)) return false;
  return ["create", "modify"].some((group) =>
    (document.paths[group] ?? []).some(
      (entry) =>
        typeof entry === "string" && CSHARP_PLAN_PATH_PATTERN.test(entry),
    ),
  );
}

function validateCsharpClosureText(errors, value, pathname) {
  if (!requireString(errors, value, pathname)) return;
  const trimmed = value.trim();
  if (trimmed.length < 8) {
    errors.push(
      issue(pathname, "must contain a concrete evidence-bearing statement", "minLength"),
    );
  }
  if (trimmed.length > 4_096) {
    errors.push(issue(pathname, "must contain at most 4,096 characters", "maxLength"));
  }
  if (
    CSHARP_PLACEHOLDER_PREFIX.test(trimmed) ||
    CSHARP_TEMPLATE_MARKER.test(trimmed)
  ) {
    errors.push(
      issue(pathname, "must not contain a null, unknown, or template placeholder", "gate"),
    );
  }
}

function validateCsharpClosureList(errors, value, pathname) {
  if (!requireArray(errors, value, pathname, { minItems: 1, unique: true })) {
    return;
  }
  if (value.length > 16) {
    errors.push(issue(pathname, "must contain at most 16 items", "maxItems"));
  }
  value.forEach((entry, index) =>
    validateCsharpClosureText(errors, entry, `${pathname}[${index}]`),
  );
}

function validateCsharpClosure(errors, document) {
  const required = taskPlanTouchesCSharp(document);
  const closure = document.csharpClosure;
  if (closure === undefined) {
    if (required) {
      errors.push(
        issue(
          "$.csharpClosure",
          "is required when paths.create or paths.modify touches C#/.NET source or project metadata",
          "required",
        ),
      );
    }
    return;
  }
  if (!isObject(closure)) {
    errors.push(issue("$.csharpClosure", "must be an object", "type"));
    return;
  }
  rejectUnknownKeys(errors, closure, "$.csharpClosure", CSHARP_CLOSURE_FIELDS);
  for (const field of CSHARP_CLOSURE_FIELDS) {
    const pathname = `$.csharpClosure.${field}`;
    if (!Object.hasOwn(closure, field)) {
      errors.push(issue(pathname, "is required", "required"));
      continue;
    }
    const item = closure[field];
    if (!isObject(item)) {
      errors.push(issue(pathname, "must be an object", "type"));
      continue;
    }
    rejectUnknownKeys(errors, item, pathname, [
      "status",
      "facts",
      "documentationEvidence",
      "projectEvidence",
    ]);
    if (!CSHARP_CLOSURE_STATUSES.has(item.status)) {
      errors.push(
        issue(
          `${pathname}.status`,
          "must be resolved or evidence-proven-inapplicable",
          "enum",
        ),
      );
    }
    validateCsharpClosureList(errors, item.facts, `${pathname}.facts`);
    validateCsharpClosureList(
      errors,
      item.documentationEvidence,
      `${pathname}.documentationEvidence`,
    );
    validateCsharpClosureList(
      errors,
      item.projectEvidence,
      `${pathname}.projectEvidence`,
    );
  }
}

function validateVerificationChecks(
  errors,
  checks,
  pathname,
  { requireArtifact = false } = {},
) {
  if (!requireArray(errors, checks, pathname, { minItems: 1, unique: true })) {
    return;
  }
  if (checks.length > 32) {
    errors.push(issue(pathname, "must contain at most 32 checks", "maxItems"));
  }
  let hasArtifact = false;
  checks.forEach((check, index) => {
    const checkPath = `${pathname}[${index}]`;
    if (!isObject(check)) {
      errors.push(issue(checkPath, "must be an object", "type"));
      return;
    }
    rejectUnknownKeys(errors, check, checkPath, [
      "id",
      "type",
      "path",
      "contains",
      "sha256",
      "jsonPointer",
      "expected",
      "caseSensitive",
    ]);
    requireString(errors, check.id, `${checkPath}.id`);
    if (!CHECK_TYPES.has(check.type)) {
      errors.push(issue(`${checkPath}.type`, "has an unsupported check type", "enum"));
      return;
    }
    hasArtifact ||= ARTIFACT_CHECK_TYPES.has(check.type);
    if (ARTIFACT_CHECK_TYPES.has(check.type)) {
      errors.push(...validateRelativePath(check.path, `${checkPath}.path`));
    } else if (check.path !== undefined) {
      errors.push(issue(`${checkPath}.path`, "is not allowed for this check", "gate"));
    }
    if (
      ["stdout-contains", "stderr-contains", "text-file-contains"].includes(
        check.type,
      )
    ) {
      requireString(errors, check.contains, `${checkPath}.contains`);
      if (typeof check.contains === "string" && check.contains.length > 512) {
        errors.push(
          issue(`${checkPath}.contains`, "must contain at most 512 characters", "maxLength"),
        );
      }
    } else if (check.contains !== undefined) {
      errors.push(issue(`${checkPath}.contains`, "is not allowed for this check", "gate"));
    }
    if (check.type === "file-sha256") {
      validateDigest(errors, check.sha256, `${checkPath}.sha256`);
    } else if (check.sha256 !== undefined) {
      errors.push(issue(`${checkPath}.sha256`, "is not allowed for this check", "gate"));
    }
    if (check.type === "json-pointer-equals") {
      if (
        !requireString(errors, check.jsonPointer, `${checkPath}.jsonPointer`) ||
        !check.jsonPointer.startsWith("/")
      ) {
        errors.push(
          issue(`${checkPath}.jsonPointer`, "must be an absolute JSON pointer", "format"),
        );
      }
      if (!Object.hasOwn(check, "expected")) {
        errors.push(issue(`${checkPath}.expected`, "is required", "required"));
      } else {
        try {
          const encodedExpected = JSON.stringify(check.expected);
          if (typeof encodedExpected !== "string") {
            errors.push(issue(`${checkPath}.expected`, "must be JSON", "type"));
          } else if (encodedExpected.length > 4096) {
            errors.push(
              issue(`${checkPath}.expected`, "exceeds 4096 bytes", "maxLength"),
            );
          }
        } catch {
          errors.push(issue(`${checkPath}.expected`, "must be JSON", "type"));
        }
      }
    } else if (check.jsonPointer !== undefined || check.expected !== undefined) {
      errors.push(issue(checkPath, "JSON fields are allowed only for json-pointer-equals", "gate"));
    }
    if (
      check.caseSensitive !== undefined &&
      typeof check.caseSensitive !== "boolean"
    ) {
      errors.push(issue(`${checkPath}.caseSensitive`, "must be boolean", "type"));
    }
  });
  if (requireArtifact && !hasArtifact) {
    errors.push(
      issue(pathname, "template verification requires an artifact-byte check", "oracle"),
    );
  }
}

function validateWarningPolicy(errors, policy, pathname) {
  if (!isObject(policy)) {
    errors.push(issue(pathname, "must be an object", "type"));
    return;
  }
  rejectUnknownKeys(errors, policy, pathname, ["mode", "allowedSubstrings"]);
  if (!["forbid", "allow-listed"].includes(policy.mode)) {
    errors.push(issue(`${pathname}.mode`, "must be forbid or allow-listed", "enum"));
  }
  validateStringList(
    errors,
    policy.allowedSubstrings,
    `${pathname}.allowedSubstrings`,
  );
  if (
    policy.mode === "forbid" &&
    Array.isArray(policy.allowedSubstrings) &&
    policy.allowedSubstrings.length > 0
  ) {
    errors.push(
      issue(
        `${pathname}.allowedSubstrings`,
        "must be empty when all warnings are forbidden",
        "gate",
      ),
    );
  }
}

function pathsOverlap(left, right) {
  const normalize = (value) => value.replaceAll("\\", "/").replace(/\/+$/u, "");
  const a = normalize(left);
  const b = normalize(right);
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

function checkPathIsInsideOutput(checkPath, outputs) {
  const normalize = (value) =>
    String(value).replaceAll("\\", "/").replace(/\/+$/u, "");
  const target = normalize(checkPath);
  return outputs.some((output) => {
    const root = normalize(output);
    return target === root || target.startsWith(`${root}/`);
  });
}

function validateCheckOutputBindings(errors, checks, outputs, pathname) {
  for (const [index, check] of (checks ?? []).entries()) {
    if (
      ARTIFACT_CHECK_TYPES.has(check?.type) &&
      !checkPathIsInsideOutput(check.path, outputs ?? [])
    ) {
      errors.push(
        issue(
          `${pathname}[${index}].path`,
          "must be inside a reviewed generated/output directory",
          "binding",
        ),
      );
    }
  }
}

function validateOutputIsolation(errors, outputs, protectedPaths, pathname) {
  for (const [index, output] of (outputs ?? []).entries()) {
    const normalized = String(output).replaceAll("\\", "/");
    const outputRoot = normalized.split("/")[0];
    if (
      !/(?:bin|obj|out|output|result|report|artifact|render|generated|temp|tmp|log|allure|coverage)/iu.test(
        outputRoot,
      )
    ) {
      errors.push(
        issue(
          `${pathname}[${index}]`,
          "must use a dedicated generated/output directory",
          "scope",
        ),
      );
    }
    if (
      normalized === ".claude" ||
      normalized.startsWith(".claude/") ||
      normalized === ".git" ||
      normalized.startsWith(".git/")
    ) {
      errors.push(
        issue(`${pathname}[${index}]`, "may not target .claude or .git", "scope"),
      );
    }
    for (const protectedPath of protectedPaths) {
      if (pathsOverlap(normalized, protectedPath)) {
        errors.push(
          issue(
            `${pathname}[${index}]`,
            `overlaps protected/planned path ${protectedPath}`,
            "scope",
          ),
        );
      }
    }
  }
}

function validateCommands(errors, commands, pathname, expectedActionClass) {
  if (!Array.isArray(commands)) {
    errors.push(issue(pathname, "must be an array", "type"));
    return;
  }
  commands.forEach((command, index) => {
    const commandPath = `${pathname}[${index}]`;
    errors.push(...validateCommandSpec(command, commandPath));
    if (isObject(command) && typeof command.program === "string" && Array.isArray(command.args)) {
      const analysis = analyzeProcessVector(command.program, command.args);
      if (analysis.destructive || analysis.opaque) {
        errors.push(
          issue(
            commandPath,
            `command is destructive or opaque: ${analysis.reasons.join(", ")}`,
            "safety",
          ),
        );
      } else if (analysis.actionClass !== expectedActionClass) {
        errors.push(
          issue(
            commandPath,
            `command class ${analysis.actionClass} does not match required ${expectedActionClass}`,
            "actionClass",
          ),
        );
      }
    }
  });
}

function verifyDocumentDigest(errors, document) {
  const computedDigest = canonicalDigest(document);
  if (!isSha256(document.digest)) {
    errors.push(issue("$.digest", "must be a lowercase SHA-256 digest", "pattern"));
  } else if (!safeEqualHex(document.digest, computedDigest)) {
    errors.push(issue("$.digest", "does not match canonical plan content", "integrity"));
  }
  return computedDigest;
}

export function validateTaskPlan(document) {
  const errors = validateCommon(document, "task plan");
  if (!isObject(document)) return { valid: false, errors, computedDigest: null };
  rejectUnknownKeys(errors, document, "$", [
    "schemaVersion",
    "planId",
    "taskId",
    "createdAt",
    "contextDigest",
    "projectFingerprintDigest",
    "packageSnapshotDigest",
    "goal",
    "acceptanceCriteria",
    "paths",
    "changes",
    "dependencies",
    "commands",
    "generatedOutputs",
    "expectedDiff",
    "risks",
    "acceptedResidualRisks",
    "verification",
    "warningPolicy",
    "csharpClosure",
    "digest",
  ]);
  for (const field of ["planId", "taskId", "goal", "expectedDiff"]) {
    requireString(errors, document[field], `$.${field}`);
  }
  validateDateTime(errors, document.createdAt, "$.createdAt");
  for (const field of [
    "contextDigest",
    "projectFingerprintDigest",
    "packageSnapshotDigest",
  ]) {
    validateDigest(errors, document[field], `$.${field}`);
  }
  validateStringList(errors, document.acceptanceCriteria, "$.acceptanceCriteria", {
    minItems: 1,
  });
  if (!isObject(document.paths)) {
    errors.push(issue("$.paths", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.paths, "$.paths", [
      "create",
      "modify",
      "forbidden",
      "unchanged",
    ]);
    for (const group of ["create", "modify", "forbidden", "unchanged"]) {
      validatePathList(errors, document.paths[group], `$.paths.${group}`);
    }
    const groups = ["create", "modify", "forbidden", "unchanged"];
    for (let left = 0; left < groups.length; left += 1) {
      for (let right = left + 1; right < groups.length; right += 1) {
        const overlap = (document.paths[groups[left]] ?? []).filter((entry) =>
          (document.paths[groups[right]] ?? []).includes(entry),
        );
        if (overlap.length) {
          errors.push(
            issue(
              "$.paths",
              `${groups[left]} and ${groups[right]} overlap: ${overlap.join(", ")}`,
              "scope",
            ),
          );
        }
      }
    }
  }
  if (requireArray(errors, document.changes, "$.changes", { minItems: 1 })) {
    const seen = new Set();
    document.changes.forEach((change, index) => {
      const pathname = `$.changes[${index}]`;
      if (!isObject(change)) {
        errors.push(issue(pathname, "must be an object", "type"));
        return;
      }
      rejectUnknownKeys(errors, change, pathname, [
        "path",
        "operation",
        "intent",
      ]);
      errors.push(...validateRelativePath(change.path, `${pathname}.path`));
      if (!["create", "modify"].includes(change.operation)) {
        errors.push(issue(`${pathname}.operation`, "must be create or modify", "enum"));
      }
      requireString(errors, change.intent, `${pathname}.intent`);
      if (seen.has(change.path)) {
        errors.push(issue(`${pathname}.path`, "duplicates another change", "uniqueItems"));
      }
      seen.add(change.path);
      if (
        change.operation &&
        !document.paths?.[change.operation]?.includes(change.path)
      ) {
        errors.push(
          issue(
            `${pathname}.path`,
            `is not listed in paths.${change.operation}`,
            "scope",
          ),
        );
      }
      if (document.paths?.forbidden?.includes(change.path)) {
        errors.push(issue(`${pathname}.path`, "is forbidden", "scope"));
      }
    });
    for (const group of ["create", "modify"]) {
      for (const plannedPath of document.paths?.[group] ?? []) {
        if (
          !document.changes.some(
            (change) =>
              change.path === plannedPath && change.operation === group,
          )
        ) {
          errors.push(
            issue(
              `$.paths.${group}`,
              `${plannedPath} lacks a matching change intent`,
              "scope",
            ),
          );
        }
      }
    }
  }
  if (!Array.isArray(document.dependencies)) {
    errors.push(issue("$.dependencies", "must be an array", "type"));
  } else {
    document.dependencies.forEach((dependency, index) => {
      if (!isObject(dependency)) {
        errors.push(issue(`$.dependencies[${index}]`, "must be an object", "type"));
        return;
      }
      rejectUnknownKeys(errors, dependency, `$.dependencies[${index}]`, [
        "name",
        "change",
        "source",
      ]);
      for (const field of ["name", "change", "source"]) {
        requireString(
          errors,
          dependency[field],
          `$.dependencies[${index}].${field}`,
        );
      }
    });
  }
  if (!isObject(document.commands)) {
    errors.push(issue("$.commands", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.commands, "$.commands", [
      "restore",
      "build",
      "template",
    ]);
    validateCommands(
      errors,
      document.commands.restore,
      "$.commands.restore",
      "restore",
    );
    validateCommands(
      errors,
      document.commands.build,
      "$.commands.build",
      "build",
    );
    validateCommands(
      errors,
      document.commands.template,
      "$.commands.template",
      "template",
    );
    if (!Array.isArray(document.commands.build) || document.commands.build.length === 0) {
      errors.push(issue("$.commands.build", "requires at least one exact build command", "minItems"));
    }
    if (!Array.isArray(document.commands.template) || document.commands.template.length === 0) {
      errors.push(issue("$.commands.template", "requires at least one exact template command", "minItems"));
    }
  }
  validatePathList(errors, document.generatedOutputs, "$.generatedOutputs");
  validateOutputIsolation(
    errors,
    document.generatedOutputs,
    [
      ...Object.values(document.paths ?? {}).flat(),
      ...((document.changes ?? []).map((change) => change?.path).filter(Boolean)),
    ],
    "$.generatedOutputs",
  );
  validateStringList(errors, document.risks, "$.risks");
  validateStringList(
    errors,
    document.acceptedResidualRisks,
    "$.acceptedResidualRisks",
  );
  if (!isObject(document.verification)) {
    errors.push(issue("$.verification", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.verification, "$.verification", [
      "restore",
      "build",
      "template",
    ]);
    for (const action of ["restore", "build", "template"]) {
      const commands = document.commands?.[action] ?? [];
      if (commands.length === 0) {
        if (
          !Array.isArray(document.verification[action]) ||
          document.verification[action].length !== 0
        ) {
          errors.push(
            issue(
              `$.verification.${action}`,
              "must be empty when no command is approved",
              "binding",
            ),
          );
        }
      } else {
        validateVerificationChecks(
          errors,
          document.verification[action],
          `$.verification.${action}`,
          { requireArtifact: action === "template" },
        );
        validateCheckOutputBindings(
          errors,
          document.verification[action],
          document.generatedOutputs,
          `$.verification.${action}`,
        );
      }
    }
  }
  validateWarningPolicy(errors, document.warningPolicy, "$.warningPolicy");
  validateCsharpClosure(errors, document);
  const computedDigest = verifyDocumentDigest(errors, document);
  return { valid: errors.length === 0, errors, computedDigest };
}

export function validateExecutionPlan(document) {
  const errors = validateCommon(document, "execution plan");
  if (!isObject(document)) return { valid: false, errors, computedDigest: null };
  rejectUnknownKeys(errors, document, "$", [
    "schemaVersion",
    "executionId",
    "taskId",
    "createdAt",
    "implementationPlanDigest",
    "staticVerificationDigest",
    "environment",
    "command",
    "scope",
    "sampleCount",
    "stressRequested",
    "stress",
    "expectedSideEffects",
    "observabilityQueries",
    "outputPaths",
    "successChecks",
    "warningPolicy",
    "repeatCount",
    "retryBudget",
    "retryPassPolicy",
    "wallClockLimitMs",
    "userReviewedBudget",
    "outputLimitBytes",
    "noDeletionCleanup",
    "mutationPlanDigest",
    "digest",
  ]);
  for (const field of ["executionId", "taskId"]) {
    requireString(errors, document[field], `$.${field}`);
  }
  validateDateTime(errors, document.createdAt, "$.createdAt");
  for (const field of ["implementationPlanDigest", "staticVerificationDigest"]) {
    validateDigest(errors, document[field], `$.${field}`);
  }
  if (!isObject(document.environment)) {
    errors.push(issue("$.environment", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.environment, "$.environment", [
      "id",
      "description",
      "deploymentReadyConfirmed",
    ]);
    requireString(errors, document.environment.id, "$.environment.id");
    requireString(
      errors,
      document.environment.description,
      "$.environment.description",
    );
    if (document.environment.deploymentReadyConfirmed !== true) {
      errors.push(
        issue(
          "$.environment.deploymentReadyConfirmed",
          "must be directly confirmed",
          "const",
        ),
      );
    }
  }
  errors.push(...validateCommandSpec(document.command, "$.command"));
  if (
    isObject(document.command) &&
    typeof document.command.program === "string" &&
    Array.isArray(document.command.args)
  ) {
    const analysis = analyzeProcessVector(
      document.command.program,
      document.command.args,
    );
    if (analysis.destructive || analysis.opaque) {
      errors.push(
        issue(
          "$.command",
          `execution command is destructive or opaque: ${analysis.reasons.join(", ")}`,
          "safety",
        ),
      );
    } else if (analysis.actionClass !== "test-run") {
      errors.push(
        issue(
          "$.command",
          `execution command must classify exactly as test-run, found ${analysis.actionClass}`,
          "actionClass",
        ),
      );
    }
  }
  if (!isObject(document.scope)) {
    errors.push(issue("$.scope", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.scope, "$.scope", [
      "selectionMode",
      "statement",
      "executables",
      "cases",
      "sessions",
      "configuration",
      "configurationArgIndex",
      "argumentBindings",
    ]);
    if (!["explicit", "all", "project-default"].includes(document.scope.selectionMode)) {
      errors.push(
        issue(
          "$.scope.selectionMode",
          "must be explicit, all, or project-default",
          "enum",
        ),
      );
    }
    requireString(errors, document.scope.statement, "$.scope.statement");
    for (const field of ["executables", "cases", "sessions"]) {
      validateStringList(errors, document.scope[field], `$.scope.${field}`);
    }
    requireString(errors, document.scope.configuration, "$.scope.configuration");
    if (
      !Number.isSafeInteger(document.scope.configurationArgIndex) ||
      document.scope.configurationArgIndex < 0 ||
      document.command?.args?.[document.scope.configurationArgIndex] !==
        document.scope.configuration
    ) {
      errors.push(
        issue(
          "$.scope.configurationArgIndex",
          "must point to the exact configuration value in command.args",
          "binding",
        ),
      );
    }
    if (!Array.isArray(document.scope.argumentBindings)) {
      errors.push(issue("$.scope.argumentBindings", "must be an array", "type"));
    } else {
      const bindingKeys = new Set();
      const bindingIndexes = new Set();
      document.scope.argumentBindings.forEach((binding, index) => {
        const pathname = `$.scope.argumentBindings[${index}]`;
        if (!isObject(binding)) {
          errors.push(issue(pathname, "must be an object", "type"));
          return;
        }
        rejectUnknownKeys(errors, binding, pathname, [
          "kind",
          "value",
          "argIndex",
        ]);
        if (!["executable", "case", "session", "configuration"].includes(binding.kind)) {
          errors.push(issue(`${pathname}.kind`, "has an invalid selection kind", "enum"));
        }
        requireString(errors, binding.value, `${pathname}.value`);
        if (!Number.isSafeInteger(binding.argIndex) || binding.argIndex < 0) {
          errors.push(issue(`${pathname}.argIndex`, "must be a non-negative integer", "minimum"));
        } else if (document.command?.args?.[binding.argIndex] !== binding.value) {
          errors.push(
            issue(
              `${pathname}.argIndex`,
              "does not point to the exact selected value in command.args",
              "binding",
            ),
          );
        }
        if (bindingIndexes.has(binding.argIndex)) {
          errors.push(
            issue(
              `${pathname}.argIndex`,
              "duplicates another argument binding index",
              "uniqueItems",
            ),
          );
        }
        bindingIndexes.add(binding.argIndex);
        const key = `${binding.kind}:${binding.value}`;
        if (bindingKeys.has(key)) {
          errors.push(issue(pathname, "duplicates another argument binding", "uniqueItems"));
        }
        bindingKeys.add(key);
      });
      if (document.scope.selectionMode === "explicit") {
        const expectedBindingKeys = new Set();
        for (const [field, kind] of [
          ["executables", "executable"],
          ["cases", "case"],
          ["sessions", "session"],
        ]) {
          for (const value of document.scope[field] ?? []) {
            expectedBindingKeys.add(`${kind}:${value}`);
            if (!bindingKeys.has(`${kind}:${value}`)) {
              errors.push(
                issue(
                  `$.scope.${field}`,
                  `${value} lacks an exact command argument binding`,
                  "binding",
                ),
              );
            }
          }
        }
        for (const key of bindingKeys) {
          if (!expectedBindingKeys.has(key)) {
            errors.push(
              issue(
                "$.scope.argumentBindings",
                `binding ${key} is not declared in explicit scope`,
                "scope",
              ),
            );
          }
        }
      } else if (
        ["executables", "cases", "sessions"].some(
          (field) => (document.scope[field] ?? []).length > 0,
        ) ||
        document.scope.argumentBindings.length > 0
      ) {
        errors.push(
          issue(
            "$.scope",
            "all/project-default selection must not invent explicit selections",
            "scope",
          ),
        );
      }
    }
  }
  if (!Number.isSafeInteger(document.sampleCount) || document.sampleCount < 0) {
    errors.push(issue("$.sampleCount", "must be a non-negative integer", "minimum"));
  }
  if (typeof document.stressRequested !== "boolean") {
    errors.push(issue("$.stressRequested", "must be a boolean", "type"));
  } else if (document.stressRequested) {
    if (!isObject(document.stress)) {
      errors.push(issue("$.stress", "is required for a requested stress test", "required"));
    } else {
      rejectUnknownKeys(errors, document.stress, "$.stress", [
        "rate",
        "durationMs",
        "timeoutMs",
        "durationEvidence",
        "timeoutEvidence",
      ]);
      if (!isObject(document.stress.rate)) {
        errors.push(issue("$.stress.rate", "must bind value, unit, and evidence", "type"));
      } else {
        rejectUnknownKeys(errors, document.stress.rate, "$.stress.rate", [
          "value",
          "unit",
          "evidence",
        ]);
        if (!(document.stress.rate.value > 0)) {
          errors.push(issue("$.stress.rate.value", "must be positive", "exclusiveMinimum"));
        }
        requireString(errors, document.stress.rate.unit, "$.stress.rate.unit");
        requireString(errors, document.stress.rate.evidence, "$.stress.rate.evidence");
      }
      for (const field of ["durationMs", "timeoutMs"]) {
        if (
          !Number.isSafeInteger(document.stress[field]) ||
          document.stress[field] < 1 ||
          document.stress[field] > 10_800_000
        ) {
          errors.push(
            issue(
              `$.stress.${field}`,
              "must be a positive integer no greater than 10,800,000 ms",
              "range",
            ),
          );
        }
      }
      requireString(
        errors,
        document.stress.durationEvidence,
        "$.stress.durationEvidence",
      );
      requireString(
        errors,
        document.stress.timeoutEvidence,
        "$.stress.timeoutEvidence",
      );
    }
  } else if (document.stress !== undefined) {
    errors.push(issue("$.stress", "must be omitted unless stress was requested", "gate"));
  }
  validateStringList(errors, document.expectedSideEffects, "$.expectedSideEffects");
  if (!Array.isArray(document.observabilityQueries)) {
    errors.push(issue("$.observabilityQueries", "must be an array", "type"));
  } else {
    if (document.observabilityQueries.length > 0) {
      errors.push(
        issue(
          "$.observabilityQueries",
          "must be empty in v0.1; observability requires a separate one-use query review/approval transaction and may not inherit execution approval",
          "deferred",
        ),
      );
    }
    document.observabilityQueries.forEach((query, index) => {
      const pathname = `$.observabilityQueries[${index}]`;
      if (!isObject(query)) {
        errors.push(issue(pathname, "must be an object", "type"));
        return;
      }
      rejectUnknownKeys(errors, query, pathname, [
        "id",
        "provider",
        "capabilityId",
        "relativeUrl",
        "queryDigest",
        "purpose",
        "readOnly",
        "timeoutMs",
        "outputLimitBytes",
        "itemLimit",
        "checks",
      ]);
      requireString(errors, query.id, `${pathname}.id`);
      if (
        !["reportportal", "elastic", "thanos", "kubernetes"].includes(
          query.provider,
        )
      ) {
        errors.push(issue(`${pathname}.provider`, "is unsupported", "enum"));
      }
      requireString(errors, query.capabilityId, `${pathname}.capabilityId`);
      validateDigest(errors, query.queryDigest, `${pathname}.queryDigest`);
      requireString(errors, query.relativeUrl, `${pathname}.relativeUrl`);
      if (
        typeof query.relativeUrl === "string" &&
        (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(query.relativeUrl) ||
          query.relativeUrl.startsWith("//") ||
          query.relativeUrl.length > 2_048)
      ) {
        errors.push(
          issue(`${pathname}.relativeUrl`, "must be one bounded relative URL", "format"),
        );
      }
      requireString(errors, query.purpose, `${pathname}.purpose`);
      if (query.readOnly !== true) {
        errors.push(issue(`${pathname}.readOnly`, "must be true", "const"));
      }
      for (const [field, maximum] of [
        ["timeoutMs", 60_000],
        ["outputLimitBytes", 1024 * 1024],
        ["itemLimit", 10_000],
      ]) {
        if (
          !Number.isSafeInteger(query[field]) ||
          query[field] < 1 ||
          query[field] > maximum
        ) {
          errors.push(
            issue(
              `${pathname}.${field}`,
              `must be between 1 and ${maximum}`,
              "range",
            ),
          );
        }
      }
      if (!requireArray(errors, query.checks, `${pathname}.checks`, { minItems: 1 })) {
        return;
      }
      query.checks.forEach((check, checkIndex) => {
        const checkPath = `${pathname}.checks[${checkIndex}]`;
        if (!isObject(check)) {
          errors.push(issue(checkPath, "must be an object", "type"));
          return;
        }
        rejectUnknownKeys(errors, check, checkPath, [
          "id",
          "type",
          "expectedStatus",
          "contains",
          "jsonPointer",
          "expected",
        ]);
        requireString(errors, check.id, `${checkPath}.id`);
        if (
          !["status-equals", "body-contains", "json-pointer-equals"].includes(
            check.type,
          )
        ) {
          errors.push(issue(`${checkPath}.type`, "is unsupported", "enum"));
        }
        if (
          check.type === "status-equals" &&
          (!Number.isSafeInteger(check.expectedStatus) ||
            check.expectedStatus < 100 ||
            check.expectedStatus > 599)
        ) {
          errors.push(
            issue(`${checkPath}.expectedStatus`, "must be an HTTP status", "range"),
          );
        }
        if (check.type === "body-contains") {
          requireString(errors, check.contains, `${checkPath}.contains`);
        }
        if (check.type === "json-pointer-equals") {
          if (
            !requireString(errors, check.jsonPointer, `${checkPath}.jsonPointer`) ||
            !check.jsonPointer.startsWith("/")
          ) {
            errors.push(
              issue(`${checkPath}.jsonPointer`, "must be an absolute JSON pointer", "format"),
            );
          }
          if (!Object.hasOwn(check, "expected")) {
            errors.push(issue(`${checkPath}.expected`, "is required", "required"));
          }
        }
      });
    });
  }
  validatePathList(errors, document.outputPaths, "$.outputPaths");
  validateOutputIsolation(errors, document.outputPaths, [], "$.outputPaths");
  validateVerificationChecks(
    errors,
    document.successChecks,
    "$.successChecks",
  );
  validateCheckOutputBindings(
    errors,
    document.successChecks,
    document.outputPaths,
    "$.successChecks",
  );
  validateWarningPolicy(errors, document.warningPolicy, "$.warningPolicy");
  if (
    !Number.isSafeInteger(document.repeatCount) ||
    document.repeatCount < 1 ||
    document.repeatCount > 3
  ) {
    errors.push(issue("$.repeatCount", "must be between 1 and 3", "range"));
  }
  if (
    !Number.isSafeInteger(document.retryBudget) ||
    document.retryBudget < 0 ||
    document.retryBudget > 3
  ) {
    errors.push(issue("$.retryBudget", "must be between 0 and 3", "range"));
  }
  if (document.retryPassPolicy !== "reject-flaky") {
    errors.push(
      issue(
        "$.retryPassPolicy",
        "must be reject-flaky; retry passes are never clean verification",
        "const",
      ),
    );
  }
  if (
    !Number.isSafeInteger(document.wallClockLimitMs) ||
    document.wallClockLimitMs < 1 ||
    document.wallClockLimitMs > 10_800_000
  ) {
    errors.push(
      issue(
        "$.wallClockLimitMs",
        "must be between 1 and 10,800,000 ms",
        "range",
      ),
    );
  }
  if (document.userReviewedBudget !== true) {
    errors.push(
      issue(
        "$.userReviewedBudget",
        "the repeat/retry/time budget must be explicitly reviewed",
        "const",
      ),
    );
  }
  if (
    !Number.isSafeInteger(document.outputLimitBytes) ||
    document.outputLimitBytes < 1 ||
    document.outputLimitBytes > 10 * 1024 * 1024
  ) {
    errors.push(
      issue(
        "$.outputLimitBytes",
        "must be between 1 and 10,485,760 bytes",
        "range",
      ),
    );
  }
  if (
    Number.isSafeInteger(document.command?.timeoutMs) &&
    Number.isSafeInteger(document.wallClockLimitMs) &&
    document.command.timeoutMs > document.wallClockLimitMs
  ) {
    errors.push(
      issue(
        "$.command.timeoutMs",
        "may not exceed the reviewed wall-clock limit",
        "range",
      ),
    );
  }
  if (
    Number.isSafeInteger(document.command?.outputLimitBytes) &&
    Number.isSafeInteger(document.outputLimitBytes) &&
    document.command.outputLimitBytes !== document.outputLimitBytes
  ) {
    errors.push(
      issue(
        "$.command.outputLimitBytes",
        "must equal the execution plan output bound",
        "binding",
      ),
    );
  }
  if (document.noDeletionCleanup !== true) {
    errors.push(issue("$.noDeletionCleanup", "must be true", "const"));
  }
  if (
    document.mutationPlanDigest !== undefined &&
    document.mutationPlanDigest !== null
  ) {
    validateDigest(errors, document.mutationPlanDigest, "$.mutationPlanDigest");
  }
  const computedDigest = verifyDocumentDigest(errors, document);
  return { valid: errors.length === 0, errors, computedDigest };
}

const DESTRUCTIVE_ACTION =
  /(?:delete|remove|trash|destroy|uninstall|purge|truncate|drop|clear|cleanup|move|rename)/iu;

export function validateMutationPlan(document) {
  const errors = validateCommon(document, "mutation plan");
  if (!isObject(document)) return { valid: false, errors, computedDigest: null };
  rejectUnknownKeys(errors, document, "$", [
    "schemaVersion",
    "mutationId",
    "taskId",
    "createdAt",
    "executionPlanDigest",
    "resource",
    "action",
    "environment",
    "tool",
    "expectedSideEffects",
    "rollbackLimitation",
    "successChecks",
    "warningPolicy",
    "noDeletion",
    "digest",
  ]);
  for (const field of [
    "mutationId",
    "taskId",
    "resource",
    "action",
    "environment",
    "rollbackLimitation",
  ]) {
    requireString(errors, document[field], `$.${field}`);
  }
  validateDateTime(errors, document.createdAt, "$.createdAt");
  validateDigest(errors, document.executionPlanDigest, "$.executionPlanDigest");
  if (DESTRUCTIVE_ACTION.test(document.action ?? "")) {
    errors.push(issue("$.action", "destructive and move/rename actions are never approvable", "safety"));
  }
  if (!isObject(document.tool)) {
    errors.push(issue("$.tool", "must be an object", "type"));
  } else {
    rejectUnknownKeys(errors, document.tool, "$.tool", [
      "kind",
      "name",
      "inputDigest",
      "command",
      "outputDirectories",
    ]);
    if (document.tool.kind !== "process") {
      errors.push(
        issue(
          "$.tool.kind",
          "v0.1 supports only exact bounded process mutations",
          "enum",
        ),
      );
    }
    requireString(errors, document.tool.name, "$.tool.name");
    validateDigest(errors, document.tool.inputDigest, "$.tool.inputDigest");
    errors.push(
      ...validateCommandSpec(document.tool.command, "$.tool.command"),
    );
    validatePathList(
      errors,
      document.tool.outputDirectories,
      "$.tool.outputDirectories",
    );
    validateOutputIsolation(
      errors,
      document.tool.outputDirectories,
      [],
      "$.tool.outputDirectories",
    );
    if (
      document.tool.command?.program !== document.tool.name
    ) {
      errors.push(
        issue(
          "$.tool.name",
          "must equal the exact process command program",
          "binding",
        ),
      );
    }
    if (
      isObject(document.tool.command) &&
      typeof document.tool.command.program === "string" &&
      Array.isArray(document.tool.command.args)
    ) {
      const analysis = analyzeProcessVector(
        document.tool.command.program,
        document.tool.command.args,
      );
      if (
        analysis.destructive ||
        analysis.opaque ||
        analysis.actionClass !== "infrastructure-mutation"
      ) {
        errors.push(
          issue(
            "$.tool.command",
            `must be one non-destructive infrastructure mutation: ${analysis.reasons.join(", ")}`,
            "safety",
          ),
        );
      }
    }
    const computedInputDigest = canonicalDigest({
      name: document.tool.name,
      command: document.tool.command,
      outputDirectories: document.tool.outputDirectories,
    });
    if (
      isSha256(document.tool.inputDigest) &&
      !safeEqualHex(document.tool.inputDigest, computedInputDigest)
    ) {
      errors.push(
        issue(
          "$.tool.inputDigest",
          "does not bind the exact mutation command and outputs",
          "integrity",
        ),
      );
    }
    if (DESTRUCTIVE_ACTION.test(document.tool.name ?? "")) {
      errors.push(issue("$.tool.name", "names a destructive operation", "safety"));
    }
  }
  validateStringList(
    errors,
    document.expectedSideEffects,
    "$.expectedSideEffects",
    { minItems: 1 },
  );
  validateVerificationChecks(
    errors,
    document.successChecks,
    "$.successChecks",
  );
  validateCheckOutputBindings(
    errors,
    document.successChecks,
    document.tool?.outputDirectories,
    "$.successChecks",
  );
  validateWarningPolicy(errors, document.warningPolicy, "$.warningPolicy");
  if (document.noDeletion !== true) {
    errors.push(issue("$.noDeletion", "must be true", "const"));
  }
  const computedDigest = verifyDocumentDigest(errors, document);
  return { valid: errors.length === 0, errors, computedDigest };
}
