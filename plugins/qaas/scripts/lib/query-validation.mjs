import {
  canonicalDigest,
  canonicalJson,
  isSha256,
  safeEqualHex,
  sha256,
} from "./canonical-json.mjs";
import { secretFindings } from "./redact.mjs";
import { assertCredentialFreeQueryParameters } from "./url-safety.mjs";
import {
  isObject,
  issue,
  rejectUnknownKeys,
  requireArray,
  requireString,
  validateDateTime,
  validateDigest,
} from "./validation.mjs";

const PROVIDERS = new Set([
  "allure",
  "reportportal",
  "elastic",
  "thanos",
  "kubernetes",
  "database",
]);

function validateToolInputBounds(value, pathname, errors, depth = 0) {
  if (depth > 8) {
    errors.push(issue(pathname, "exceeds maximum JSON depth 8", "maxDepth"));
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 100) {
      errors.push(issue(pathname, "array exceeds 100 items", "maxItems"));
    }
    value.forEach((entry, index) =>
      validateToolInputBounds(entry, `${pathname}[${index}]`, errors, depth + 1),
    );
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    if (entries.length > 100) {
      errors.push(issue(pathname, "object exceeds 100 fields", "maxProperties"));
    }
    entries.forEach(([key, entry]) =>
      validateToolInputBounds(entry, `${pathname}.${key}`, errors, depth + 1),
    );
  }
}

export function querySpecDigest(query) {
  const { queryDigest: _digest, ...content } = query;
  return canonicalDigest(content);
}

export function validateQueryPlan(document) {
  const errors = [];
  if (!isObject(document)) {
    return { valid: false, errors: [issue("$", "must be an object", "type")] };
  }
  rejectUnknownKeys(errors, document, "$", [
    "schemaVersion",
    "queryPlanId",
    "taskId",
    "createdAt",
    "executionPlanDigest",
    "currentFingerprintDigest",
    "queries",
    "digest",
  ]);
  if (document.schemaVersion !== "1.0") {
    errors.push(issue("$.schemaVersion", "must equal 1.0", "const"));
  }
  for (const field of ["queryPlanId", "taskId"]) {
    requireString(errors, document[field], `$.${field}`);
  }
  validateDateTime(errors, document.createdAt, "$.createdAt");
  validateDigest(errors, document.executionPlanDigest, "$.executionPlanDigest");
  validateDigest(
    errors,
    document.currentFingerprintDigest,
    "$.currentFingerprintDigest",
  );
  if (requireArray(errors, document.queries, "$.queries", { minItems: 1 })) {
    if (document.queries.length > 8) {
      errors.push(issue("$.queries", "must contain at most 8 queries", "maxItems"));
    }
    const ids = new Set();
    document.queries.forEach((query, index) => {
      const pathname = `$.queries[${index}]`;
      if (!isObject(query)) {
        errors.push(issue(pathname, "must be an object", "type"));
        return;
      }
      rejectUnknownKeys(errors, query, pathname, [
        "queryId",
        "provider",
        "capabilityId",
        "toolName",
        "toolInput",
        "toolInputDigest",
        "endpointSelector",
        "purpose",
        "credentialEnvNames",
        "timeoutMs",
        "outputLimitBytes",
        "itemLimit",
        "readOnly",
        "responseChecks",
        "queryDigest",
      ]);
      for (const field of [
        "queryId",
        "capabilityId",
        "toolName",
        "endpointSelector",
        "purpose",
      ]) {
        requireString(errors, query[field], `${pathname}.${field}`);
      }
      if (
        typeof query.purpose === "string" &&
        query.purpose.length > 512
      ) {
        errors.push(
          issue(`${pathname}.purpose`, "must contain at most 512 characters", "maxLength"),
        );
      }
      if (
        typeof query.toolName === "string" &&
        !/^[A-Za-z0-9_.:-]{1,200}$/u.test(query.toolName)
      ) {
        errors.push(issue(`${pathname}.toolName`, "has an unsafe format", "format"));
      }
      if (!isObject(query.toolInput)) {
        errors.push(issue(`${pathname}.toolInput`, "must be an object", "type"));
      } else {
        validateToolInputBounds(
          query.toolInput,
          `${pathname}.toolInput`,
          errors,
        );
        if (
          Buffer.byteLength(canonicalJson(query.toolInput), "utf8") >
          16 * 1024
        ) {
          errors.push(
            issue(
              `${pathname}.toolInput`,
              "exceeds the 16 KiB review bound",
              "maxLength",
            ),
          );
        }
      }
      validateDigest(
        errors,
        query.toolInputDigest,
        `${pathname}.toolInputDigest`,
      );
      if (
        isObject(query.toolInput) &&
        isSha256(query.toolInputDigest) &&
        !safeEqualHex(query.toolInputDigest, sha256(query.toolInput))
      ) {
        errors.push(
          issue(
            `${pathname}.toolInputDigest`,
            "does not bind the exact displayed tool input",
            "integrity",
          ),
        );
      }
      if (ids.has(query.queryId)) {
        errors.push(issue(`${pathname}.queryId`, "must be unique", "uniqueItems"));
      }
      ids.add(query.queryId);
      if (!PROVIDERS.has(query.provider)) {
        errors.push(issue(`${pathname}.provider`, "is unsupported", "enum"));
      }
      if (
        typeof query.endpointSelector === "string" &&
        query.endpointSelector !== "project-artifact"
      ) {
        try {
          const endpoint = new URL(query.endpointSelector);
          const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(
            endpoint.hostname.toLowerCase(),
          );
          if (
            !["http:", "https:"].includes(endpoint.protocol) ||
            endpoint.username ||
            endpoint.password ||
            endpoint.search ||
            endpoint.hash ||
            (endpoint.protocol !== "https:" && !loopback)
          ) {
            throw new Error("unsafe endpoint");
          }
        } catch {
          errors.push(
            issue(
              `${pathname}.endpointSelector`,
              "must be project-artifact or one exact credential-free user-approved HTTPS/loopback base URL",
              "format",
            ),
          );
        }
      }
      if (
        query.provider === "allure" &&
        query.endpointSelector !== "project-artifact"
      ) {
        errors.push(
          issue(
            `${pathname}.endpointSelector`,
            "must be project-artifact for Allure",
            "const",
          ),
        );
      }
      if (
        query.provider !== "allure" &&
        query.endpointSelector === "project-artifact"
      ) {
        errors.push(
          issue(
            `${pathname}.endpointSelector`,
            "must be the exact approved provider base URL",
            "format",
          ),
        );
      }
      if (
        query.provider !== "allure" &&
        typeof query.endpointSelector === "string" &&
        query.endpointSelector !== "project-artifact" &&
        isObject(query.toolInput)
      ) {
        if (typeof query.toolInput.relativeUrl !== "string") {
          errors.push(
            issue(
              `${pathname}.toolInput.relativeUrl`,
              "is required for the fixed HTTP GET adapter",
              "required",
            ),
          );
        } else {
          try {
            const base = new URL(query.endpointSelector);
            const requested = new URL(query.toolInput.relativeUrl, base);
            const basePath = base.pathname.endsWith("/")
              ? base.pathname
              : `${base.pathname}/`;
            if (
              requested.origin !== base.origin ||
              (
                requested.pathname !== base.pathname &&
                !requested.pathname.startsWith(basePath)
              ) ||
              requested.username ||
              requested.password ||
              requested.hash
            ) {
              throw new Error("escapes the approved endpoint");
            }
            assertCredentialFreeQueryParameters(requested, "Query URL");
          } catch (error) {
            errors.push(
              issue(
                `${pathname}.toolInput.relativeUrl`,
                `must remain inside the approved endpoint and contain no credential-like query data: ${error.message}`,
                "format",
              ),
            );
          }
        }
      }
      if (
        !Array.isArray(query.credentialEnvNames) ||
        query.credentialEnvNames.length > 1 ||
        new Set(query.credentialEnvNames).size !==
          query.credentialEnvNames.length ||
        query.credentialEnvNames.some(
          (name) =>
            typeof name !== "string" ||
            !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
            /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(name),
        )
      ) {
        errors.push(
          issue(
            `${pathname}.credentialEnvNames`,
            "must contain at most one safe user-selected bearer-token environment-variable name",
            "format",
          ),
        );
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
      if (query.readOnly !== true) {
        errors.push(issue(`${pathname}.readOnly`, "must be true", "const"));
      }
      if (
        requireArray(
          errors,
          query.responseChecks,
          `${pathname}.responseChecks`,
          { minItems: 1 },
        )
      ) {
        if (query.responseChecks.length > 16) {
          errors.push(
            issue(`${pathname}.responseChecks`, "must have at most 16 checks", "maxItems"),
          );
        }
        const checkIds = new Set();
        query.responseChecks.forEach((check, checkIndex) => {
          const checkPath = `${pathname}.responseChecks[${checkIndex}]`;
          if (!isObject(check)) {
            errors.push(issue(checkPath, "must be an object", "type"));
            return;
          }
          const fieldsByType = {
            "status-equals": ["id", "type", "expectedStatus"],
            "body-contains": ["id", "type", "contains"],
            "json-pointer-equals": [
              "id",
              "type",
              "jsonPointer",
              "expected",
            ],
          };
          rejectUnknownKeys(
            errors,
            check,
            checkPath,
            fieldsByType[check.type] ?? ["id", "type"],
          );
          requireString(errors, check.id, `${checkPath}.id`);
          if (checkIds.has(check.id)) {
            errors.push(issue(`${checkPath}.id`, "must be unique", "uniqueItems"));
          }
          checkIds.add(check.id);
          if (
            ![
              "status-equals",
              "body-contains",
              "json-pointer-equals",
            ].includes(check.type)
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
      }
      validateDigest(errors, query.queryDigest, `${pathname}.queryDigest`);
      if (
        isSha256(query.queryDigest) &&
        !safeEqualHex(query.queryDigest, querySpecDigest(query))
      ) {
        errors.push(
          issue(`${pathname}.queryDigest`, "does not bind exact query fields", "integrity"),
        );
      }
    });
  }
  for (const finding of secretFindings(document)) {
    errors.push(
      issue(finding.path, `contains ${finding.type} secret-like data`, "secret"),
    );
  }
  const computedDigest = canonicalDigest(document);
  if (
    !isSha256(document.digest) ||
    !safeEqualHex(document.digest, computedDigest)
  ) {
    errors.push(issue("$.digest", "does not match canonical query plan", "integrity"));
  }
  return { valid: errors.length === 0, errors, computedDigest };
}
