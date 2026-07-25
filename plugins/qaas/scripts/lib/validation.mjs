import path from "node:path";
import { canonicalDigest, isSha256, safeEqualHex } from "./canonical-json.mjs";

export const READINESS_STATUSES = new Set([
  "evidenced",
  "user_confirmed",
  "not_applicable",
  "unknown",
  "contradicted",
]);

export const READY_STATUSES = new Set([
  "evidenced",
  "user_confirmed",
  "not_applicable",
]);

export const READINESS_DOMAINS = Object.freeze([
  "repository-boundary",
  "tested-system",
  "message-data-flows",
  "configuration-style",
  "qaas-configuration-semantics",
  "packages-and-docs",
  "relevant-files-and-custom-code",
  "commands",
  "existing-test-inventory",
  "contracts-and-oracle",
  "samples",
  "common-hooks-and-modules",
  "reference-projects",
  "environment-and-operations",
  "developer-inputs",
  "acceptance-criteria",
  "observability",
]);

export const EVIDENCE_REQUIRED_READINESS_DOMAINS = Object.freeze([
  "repository-boundary",
  "tested-system",
  "configuration-style",
  "qaas-configuration-semantics",
  "packages-and-docs",
  "relevant-files-and-custom-code",
  "commands",
  "existing-test-inventory",
  "contracts-and-oracle",
]);

export const NOT_APPLICABLE_READINESS_DOMAINS = Object.freeze([
  "message-data-flows",
  "samples",
  "common-hooks-and-modules",
  "reference-projects",
  "observability",
]);

export function readinessSourceClaim({
  source,
  domain = null,
  status = null,
  summary = null,
  purpose = null,
}) {
  return canonicalDigest({
    ...(purpose ? { purpose } : { domain, status, summary }),
    source: {
      kind: source.kind,
      digest: source.digest,
    },
  });
}

export function issue(pathname, message, keyword = "contract") {
  return { path: pathname, message, keyword };
}

export function isObject(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value)
  );
}

export function rejectUnknownKeys(errors, value, pathname, allowedKeys) {
  if (!isObject(value)) return;
  const allowed = new Set(allowedKeys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      errors.push(
        issue(`${pathname}.${key}`, "is not allowed", "additionalProperties"),
      );
    }
  }
}

export function validateDateTime(errors, value, pathname) {
  if (!requireString(errors, value, pathname)) return;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value))
  ) {
    errors.push(issue(pathname, "must be an RFC 3339 UTC date-time", "format"));
  }
}

export function requireString(errors, value, pathname, options = {}) {
  if (typeof value !== "string") {
    errors.push(issue(pathname, "must be a string", "type"));
    return false;
  }
  const trimmed = value.trim();
  if (options.nonEmpty !== false && trimmed.length === 0) {
    errors.push(issue(pathname, "must not be empty", "minLength"));
    return false;
  }
  if (options.pattern && !options.pattern.test(value)) {
    errors.push(issue(pathname, "has an invalid format", "pattern"));
    return false;
  }
  return true;
}

export function requireArray(errors, value, pathname, options = {}) {
  if (!Array.isArray(value)) {
    errors.push(issue(pathname, "must be an array", "type"));
    return false;
  }
  if (options.minItems && value.length < options.minItems) {
    errors.push(
      issue(pathname, `must contain at least ${options.minItems} item(s)`, "minItems"),
    );
  }
  if (options.unique) {
    const set = new Set(value.map((entry) => JSON.stringify(entry)));
    if (set.size !== value.length) {
      errors.push(issue(pathname, "must contain unique items", "uniqueItems"));
    }
  }
  return true;
}

export function validateRelativePath(value, pathname = "$.path") {
  const errors = [];
  if (!requireString(errors, value, pathname)) return errors;
  const normalized = value.replaceAll("\\", "/");
  const segments = normalized.split("/");
  if (
    path.posix.isAbsolute(normalized) ||
    normalized.includes(":") ||
    segments.some((segment) => segment === "." || segment === ".." || segment === "") ||
    segments.some((segment) => /[ .]$/u.test(segment)) ||
    segments.some((segment) =>
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(segment),
    ) ||
    normalized.includes("\0")
  ) {
    errors.push(issue(pathname, "must remain inside the project root", "scope"));
  }
  if (
    normalized === ".claude/qaas/state" ||
    normalized.startsWith(".claude/qaas/state/") ||
    normalized === ".claude/qaas/fingerprint.json"
  ) {
    errors.push(issue(pathname, "targets protected mirrored state", "protected"));
  }
  return errors;
}

export function validateDigest(errors, value, pathname) {
  if (!isSha256(value)) {
    errors.push(issue(pathname, "must be a lowercase SHA-256 digest", "pattern"));
  }
}

export function validateCommandSpec(spec, pathname = "$.command") {
  const errors = [];
  if (!isObject(spec)) {
    return [issue(pathname, "must be an object", "type")];
  }
  const allowedKeys = new Set([
    "program",
    "args",
    "cwd",
    "envNames",
    "shell",
    "timeoutMs",
    "outputLimitBytes",
    "scriptDigest",
  ]);
  for (const key of Object.keys(spec)) {
    if (!allowedKeys.has(key)) {
      errors.push(
        issue(`${pathname}.${key}`, "is not an allowed command field", "additionalProperties"),
      );
    }
  }
  requireString(errors, spec.program, `${pathname}.program`);
  if (requireArray(errors, spec.args, `${pathname}.args`)) {
    spec.args.forEach((arg, index) =>
      requireString(errors, arg, `${pathname}.args[${index}]`, {
        nonEmpty: false,
      }),
    );
  }
  requireString(errors, spec.cwd, `${pathname}.cwd`);
  if (spec.envNames !== undefined) {
    if (requireArray(errors, spec.envNames, `${pathname}.envNames`, { unique: true })) {
      spec.envNames.forEach((name, index) => {
        requireString(
          errors,
          name,
          `${pathname}.envNames[${index}]`,
          { pattern: /^[A-Za-z_][A-Za-z0-9_]*$/u },
        );
      });
    }
  }
  if (spec.shell !== undefined && spec.shell !== false) {
    errors.push(issue(`${pathname}.shell`, "must be false when present", "const"));
  }
  if (
    !Number.isSafeInteger(spec.timeoutMs) ||
    spec.timeoutMs < 1 ||
    spec.timeoutMs > 10_800_000
  ) {
    errors.push(
      issue(
        `${pathname}.timeoutMs`,
        "must be a positive integer no greater than 10,800,000 ms",
        "range",
      ),
    );
  }
  if (
    !Number.isSafeInteger(spec.outputLimitBytes) ||
    spec.outputLimitBytes < 1 ||
    spec.outputLimitBytes > 10 * 1024 * 1024
  ) {
    errors.push(
      issue(
        `${pathname}.outputLimitBytes`,
        "must be between 1 and 10,485,760 bytes",
        "range",
      ),
    );
  }
  return errors;
}

export function validateReadiness(document) {
  const errors = [];
  if (!isObject(document)) {
    return { valid: false, ready: false, errors: [issue("$", "must be an object", "type")] };
  }
  rejectUnknownKeys(errors, document, "$", [
    "schemaVersion",
    "projectId",
    "taskId",
    "requiredSourcesEvidence",
    "finalRestatement",
    "domains",
  ]);
  requireString(errors, document.schemaVersion, "$.schemaVersion");
  if (document.schemaVersion !== "1.0") {
    errors.push(issue("$.schemaVersion", "must equal 1.0", "const"));
  }
  requireString(errors, document.projectId, "$.projectId");
  if (
    !Object.hasOwn(document, "taskId") ||
    (
      document.taskId !== null &&
      (typeof document.taskId !== "string" || document.taskId.trim() === "")
    )
  ) {
    errors.push(issue("$.taskId", "must be a non-empty string or null", "type"));
  }
  if (
    !requireString(
      errors,
      document.finalRestatement,
      "$.finalRestatement",
    ) ||
    document.finalRestatement.length < 20 ||
    document.finalRestatement.length > 1200
  ) {
    errors.push(
      issue(
        "$.finalRestatement",
        "must contain 20-1200 characters for the final human review",
        "range",
      ),
    );
  }
  const validateSource = (
    source,
    pathname,
    {
      allowUser = true,
      domain = null,
      status = null,
      summary = null,
      purpose = null,
    } = {},
  ) => {
    if (!isObject(source)) {
      errors.push(issue(pathname, "must be an object", "type"));
      return;
    }
    rejectUnknownKeys(errors, source, pathname, [
      "kind",
      "identifier",
      "digest",
      "claimDigest",
    ]);
    const allowedKinds = allowUser
      ? ["docs", "user", "project", "runtime", "package"]
      : ["docs", "project", "runtime", "package"];
    if (!allowedKinds.includes(source.kind)) {
      errors.push(issue(`${pathname}.kind`, "has an invalid source kind", "enum"));
    }
    requireString(errors, source.identifier, `${pathname}.identifier`);
    if (
      typeof source.identifier === "string" &&
      source.identifier.length > 240
    ) {
      errors.push(
        issue(
          `${pathname}.identifier`,
          "must contain at most 240 characters",
          "maxLength",
        ),
      );
    }
    validateDigest(errors, source.digest, `${pathname}.digest`);
    validateDigest(errors, source.claimDigest, `${pathname}.claimDigest`);
    if (
      isSha256(source.claimDigest) &&
      !safeEqualHex(
        source.claimDigest,
        readinessSourceClaim({
          source,
          domain,
          status,
          summary,
          purpose,
        }),
      )
    ) {
      errors.push(
        issue(
          `${pathname}.claimDigest`,
          "does not bind this exact domain/status/summary and evidence digest",
          "provenance",
        ),
      );
    }
    if (
      source.kind === "user" &&
      source.identifier !== `readiness-fact:${source.digest}`
    ) {
      errors.push(
        issue(
          `${pathname}.identifier`,
          "must bind the exact registered readiness-fact digest",
          "provenance",
        ),
      );
    }
    if (
      source.kind !== "user" &&
      source.identifier !== `evidence:${source.digest}` &&
      !(
        source.kind === "package" &&
        source.identifier === `package-snapshot:${source.digest}`
      )
    ) {
      errors.push(
        issue(
          `${pathname}.identifier`,
          "must bind a signed evidence or package snapshot digest",
          "provenance",
        ),
      );
    }
  };
  if (
    requireArray(
      errors,
      document.requiredSourcesEvidence,
      "$.requiredSourcesEvidence",
      { minItems: 1, unique: true },
    )
  ) {
    if (document.requiredSourcesEvidence.length > 16) {
      errors.push(
        issue("$.requiredSourcesEvidence", "must contain at most 16 entries", "maxItems"),
      );
    }
    document.requiredSourcesEvidence.forEach((source, index) =>
      validateSource(
        source,
        `$.requiredSourcesEvidence[${index}]`,
        { allowUser: false, purpose: "required-sources" },
      ),
    );
  }
  if (!isObject(document.domains)) {
    errors.push(issue("$.domains", "must be an object", "type"));
  } else {
    for (const domain of READINESS_DOMAINS) {
      const entry = document.domains[domain];
      if (!isObject(entry)) {
        errors.push(issue(`$.domains.${domain}`, "is required", "required"));
        continue;
      }
      if (!READINESS_STATUSES.has(entry.status)) {
        errors.push(
          issue(
            `$.domains.${domain}.status`,
            `must be one of ${[...READINESS_STATUSES].join(", ")}`,
            "enum",
          ),
        );
      }
      rejectUnknownKeys(errors, entry, `$.domains.${domain}`, [
        "status",
        "summary",
        "sources",
      ]);
      requireString(errors, entry.summary, `$.domains.${domain}.summary`);
      if (typeof entry.summary === "string" && entry.summary.length > 320) {
        errors.push(
          issue(
            `$.domains.${domain}.summary`,
            "must contain at most 320 characters",
            "maxLength",
          ),
        );
      }
      if (!Array.isArray(entry.sources)) {
        errors.push(issue(`$.domains.${domain}.sources`, "must be an array", "type"));
      } else if (entry.sources.length === 0) {
        errors.push(
          issue(
            `$.domains.${domain}.sources`,
            "must cite at least one source",
            "minItems",
          ),
        );
      }
      if (Array.isArray(entry.sources)) {
        if (entry.sources.length > 8) {
          errors.push(
            issue(
              `$.domains.${domain}.sources`,
              "must contain at most 8 entries",
              "maxItems",
            ),
          );
        }
        entry.sources.forEach((source, index) =>
          validateSource(source, `$.domains.${domain}.sources[${index}]`, {
            domain,
            status: entry.status,
            summary: entry.summary,
          }),
        );
        if (
          ["user_confirmed", "not_applicable"].includes(entry.status) &&
          !(
            entry.sources.length === 1 &&
            entry.sources[0]?.kind === "user"
          )
        ) {
          errors.push(
            issue(
              `$.domains.${domain}.sources`,
              `${entry.status} requires exactly one registered user fact`,
              "provenance",
            ),
          );
        }
        if (
          entry.status === "evidenced" &&
          entry.sources.some((source) => source?.kind === "user")
        ) {
          errors.push(
            issue(
              `$.domains.${domain}.sources`,
              "evidenced domains require non-user signed evidence",
              "provenance",
            ),
          );
        }
      }
      if (
        EVIDENCE_REQUIRED_READINESS_DOMAINS.includes(domain) &&
        entry.status !== "evidenced"
      ) {
        errors.push(
          issue(
            `$.domains.${domain}.status`,
            "this core domain must be evidenced",
            "mastery",
          ),
        );
      }
      if (
        entry.status === "not_applicable" &&
        !NOT_APPLICABLE_READINESS_DOMAINS.includes(domain)
      ) {
        errors.push(
          issue(
            `$.domains.${domain}.status`,
            "not_applicable is not permitted for this core domain",
            "mastery",
          ),
        );
      }
    }
    for (const domain of Object.keys(document.domains)) {
      if (!READINESS_DOMAINS.includes(domain)) {
        errors.push(issue(`$.domains.${domain}`, "is not a recognized domain", "additionalProperties"));
      }
    }
  }
  const evidencedCount = READINESS_DOMAINS.filter(
    (domain) => document.domains?.[domain]?.status === "evidenced",
  ).length;
  if (evidencedCount < 9) {
    errors.push(
      issue(
        "$.domains",
        "at least nine core domains must be backed by signed evidence",
        "mastery",
      ),
    );
  }
  const ready =
    errors.length === 0 &&
    READINESS_DOMAINS.every((domain) =>
      READY_STATUSES.has(document.domains?.[domain]?.status),
    );
  return { valid: errors.length === 0, ready, errors };
}

export function formatValidationResult(kind, result, extra = {}) {
  return {
    kind,
    valid: result.valid,
    ...(Object.hasOwn(result, "ready") ? { ready: result.ready } : {}),
    errors: result.errors,
    ...extra,
  };
}
