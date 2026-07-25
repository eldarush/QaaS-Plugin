import { canonicalDigest } from "./canonical-json.mjs";
import { secretFindings } from "./redact.mjs";

const DESTRUCTIVE_WORD =
  /(?:^|[_\W])(?:delete|remove|trash|destroy|uninstall|purge|truncate|drop|cleanup|clear|move|rename)(?=$|[_\W]|[A-Z])/iu;
const MUTATION_WORD =
  /(?:^|[_\W])(?:create|update|write|edit|patch|put|post|apply|deploy|restart|scale|execute|run|mutate)(?=$|[_\W]|[A-Z])/iu;
const QUERY_WRAPPER =
  /(?:query|execute|request|graphql|sql|shell|command|script|http)/iu;
const SQL_DESTRUCTIVE = /\b(?:delete\s+from|drop\s+\w+|truncate\s+\w+)\b/iu;
const SQL_MUTATION =
  /\b(?:insert|update|merge|alter|create|replace|grant|revoke|call|execute|exec|copy|vacuum|analyze|attach|detach|set)\b/iu;
const SQL_SIDE_EFFECT =
  /\b(?:into\s+(?:outfile|dumpfile)|load_file|pg_read_file|dblink|xp_cmdshell)\b/iu;
const GRAPHQL_MUTATION = /\b(?:mutation|subscription)\b/iu;

function flatten(value, path = "$", results = []) {
  if (typeof value === "string") {
    results.push({ path, value });
  } else if (Array.isArray(value)) {
    value.forEach((entry, index) => flatten(entry, `${path}[${index}]`, results));
  } else if (value && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      results.push({ path: `${path}.${key}`, value: key });
      flatten(entry, `${path}.${key}`, results);
    }
  }
  return results;
}

function collectSlotNames(value, slots = new Set()) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSlotNames(entry, slots));
  } else if (value && typeof value === "object") {
    if (typeof value.$slot === "string") slots.add(value.$slot);
    Object.values(value).forEach((entry) => collectSlotNames(entry, slots));
  }
  return slots;
}

export function validateCapabilityRegistry(registry) {
  const errors = [];
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) {
    return { valid: false, errors: ["registry must be an object"] };
  }
  if (typeof registry.version !== "string" || !registry.version) {
    errors.push("version is required");
  }
  for (const key of Object.keys(registry)) {
    if (!["version", "approvedAt", "capabilities"].includes(key)) {
      errors.push(`unknown registry field: ${key}`);
    }
  }
  if (
    typeof registry.approvedAt !== "string" ||
    !Number.isFinite(Date.parse(registry.approvedAt))
  ) {
    errors.push("approvedAt must be an RFC 3339 date-time");
  }
  if (!Array.isArray(registry.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    const ids = new Set();
    const toolTuples = new Set();
    registry.capabilities.forEach((capability, index) => {
      const prefix = `capabilities[${index}]`;
      if (!capability || typeof capability !== "object") {
        errors.push(`${prefix} must be an object`);
        return;
      }
      const allowedFields = new Set([
        "id",
        "logicalOperation",
        "server",
        "tool",
        "classification",
        "inputSchema",
        "schemaDigest",
        "safeArgumentTemplate",
        "readOnlyQueryPolicy",
        "outputLimitBytes",
        "outputLimitItems",
        "probePassed",
        "probeEvidenceDigest",
        "userApproved",
      ]);
      for (const key of Object.keys(capability)) {
        if (!allowedFields.has(key)) {
          errors.push(`${prefix}.${key} is not allowed`);
        }
      }
      for (const field of [
        "id",
        "logicalOperation",
        "server",
        "tool",
        "classification",
      ]) {
        if (typeof capability[field] !== "string" || !capability[field]) {
          errors.push(`${prefix}.${field} is required`);
        }
      }
      if (!["read", "mutation"].includes(capability.classification)) {
        errors.push(`${prefix}.classification must be read or mutation`);
      }
      if (ids.has(capability.id)) errors.push(`${prefix}.id must be unique`);
      ids.add(capability.id);
      const tuple = `${capability.server}\0${capability.tool}`;
      if (toolTuples.has(tuple)) {
        errors.push(`${prefix} duplicates an existing server/tool tuple`);
      }
      toolTuples.add(tuple);
      if (capability.userApproved !== true) {
        errors.push(`${prefix}.userApproved must be true`);
      }
      if (!Number.isInteger(capability.outputLimitBytes) || capability.outputLimitBytes < 1) {
        errors.push(`${prefix}.outputLimitBytes must be a positive integer`);
      }
      if (!capability.inputSchema || typeof capability.inputSchema !== "object") {
        errors.push(`${prefix}.inputSchema is required`);
      }
      if (capability.safeArgumentTemplate === undefined) {
        errors.push(`${prefix}.safeArgumentTemplate is required`);
      } else if (capability.logicalOperation?.startsWith("docs.")) {
        const slots = collectSlotNames(capability.safeArgumentTemplate);
        const requiredSlot =
          capability.logicalOperation === "docs.search"
            ? "query"
            : capability.logicalOperation === "docs.read"
              ? "identifier"
              : null;
        const allowedSlots =
          capability.logicalOperation === "docs.search"
            ? new Set(["query", "limit"])
            : capability.logicalOperation === "docs.read"
              ? new Set(["identifier", "limit"])
              : new Set();
        if (!requiredSlot || !slots.has(requiredSlot)) {
          errors.push(
            `${prefix}.safeArgumentTemplate lacks the canonical ${requiredSlot ?? "supported"} slot`,
          );
        }
        for (const slot of slots) {
          if (!allowedSlots.has(slot)) {
            errors.push(
              `${prefix}.safeArgumentTemplate uses unsupported docs slot ${slot}`,
            );
          }
        }
      }
      if (typeof capability.schemaDigest !== "string") {
        errors.push(`${prefix}.schemaDigest is required`);
      } else if (
        capability.inputSchema &&
        canonicalDigest(capability.inputSchema) !== capability.schemaDigest
      ) {
        errors.push(`${prefix}.schemaDigest does not match inputSchema`);
      }
      if (typeof capability.probePassed !== "boolean") {
        errors.push(`${prefix}.probePassed must be a boolean`);
      }
      if (
        ["docs.search", "docs.read"].includes(capability.logicalOperation) &&
        capability.probePassed === true &&
        (
          typeof capability.probeEvidenceDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(capability.probeEvidenceDigest)
        )
      ) {
        errors.push(
          `${prefix}.probeEvidenceDigest must bind a bounded documentation MCP schema probe`,
        );
      } else if (
        capability.probeEvidenceDigest !== undefined &&
        (
          typeof capability.probeEvidenceDigest !== "string" ||
          !/^[a-f0-9]{64}$/u.test(capability.probeEvidenceDigest)
        )
      ) {
        errors.push(`${prefix}.probeEvidenceDigest must be SHA-256`);
      }
      if (
        !Number.isInteger(capability.outputLimitItems) ||
        capability.outputLimitItems < 1
      ) {
        errors.push(`${prefix}.outputLimitItems must be a positive integer`);
      }
    });
  }
  return { valid: errors.length === 0, errors };
}

function findCapability(registry, server, tool) {
  return registry?.capabilities?.find(
    (entry) => entry.server === server && entry.tool === tool,
  );
}

function matchesPrimitiveType(value, type) {
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") {
    return value !== null && typeof value === "object" && !Array.isArray(value);
  }
  if (type === "integer") return Number.isSafeInteger(value);
  return typeof value === type;
}

function validateAgainstInputSchema(value, schema, path = "$", errors = []) {
  if (!schema || typeof schema !== "object") {
    errors.push(`${path}: schema is missing`);
    return errors;
  }
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.length > 0 && !types.some((type) => matchesPrimitiveType(value, type))) {
    errors.push(`${path}: type does not match ${types.join("|")}`);
    return errors;
  }
  if (Object.hasOwn(schema, "const") && value !== schema.const) {
    errors.push(`${path}: value does not match const`);
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => entry === value)) {
    errors.push(`${path}: value is outside enum`);
  }
  if (typeof value === "string") {
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) {
      errors.push(`${path}: string exceeds maxLength`);
    }
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) {
      errors.push(`${path}: string is shorter than minLength`);
    }
    if (schema.pattern) {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) {
          errors.push(`${path}: string does not match pattern`);
        }
      } catch {
        errors.push(`${path}: registry contains an invalid pattern`);
      }
    }
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      errors.push(`${path}: array exceeds maxItems`);
    }
    if (schema.items) {
      value.forEach((entry, index) =>
        validateAgainstInputSchema(entry, schema.items, `${path}[${index}]`, errors),
      );
    }
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    for (const required of schema.required ?? []) {
      if (!Object.hasOwn(value, required)) {
        errors.push(`${path}.${required}: required property is missing`);
      }
    }
    for (const [key, entry] of Object.entries(value)) {
      if (Object.hasOwn(properties, key)) {
        validateAgainstInputSchema(entry, properties[key], `${path}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${path}.${key}: additional property is not allowed`);
      } else if (
        schema.additionalProperties &&
        typeof schema.additionalProperties === "object"
      ) {
        validateAgainstInputSchema(
          entry,
          schema.additionalProperties,
          `${path}.${key}`,
          errors,
        );
      }
    }
  }
  return errors;
}

function matchTemplate(value, template, path = "$", errors = []) {
  if (
    template &&
    typeof template === "object" &&
    !Array.isArray(template) &&
    Object.hasOwn(template, "$slot")
  ) {
    if (typeof template.$slot !== "string" || template.$slot.length === 0) {
      errors.push(`${path}: slot name is invalid`);
      return errors;
    }
    if (template.type && !matchesPrimitiveType(value, template.type)) {
      errors.push(`${path}: slot ${template.$slot} has the wrong type`);
    }
    if (
      typeof value === "string" &&
      Number.isInteger(template.maxLength) &&
      value.length > template.maxLength
    ) {
      errors.push(`${path}: slot ${template.$slot} exceeds maxLength`);
    }
    if (
      Array.isArray(template.enum) &&
      !template.enum.some((entry) => entry === value)
    ) {
      errors.push(`${path}: slot ${template.$slot} is outside its enum`);
    }
    return errors;
  }
  if (Array.isArray(template)) {
    if (!Array.isArray(value) || value.length !== template.length) {
      errors.push(`${path}: array does not match the exact safe template`);
      return errors;
    }
    template.forEach((entry, index) =>
      matchTemplate(value[index], entry, `${path}[${index}]`, errors),
    );
    return errors;
  }
  if (template && typeof template === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      errors.push(`${path}: object does not match the safe template`);
      return errors;
    }
    const templateKeys = Object.keys(template);
    const valueKeys = Object.keys(value);
    for (const key of valueKeys) {
      if (!templateKeys.includes(key)) {
        errors.push(`${path}.${key}: extra key is not allowed by the safe template`);
      }
    }
    for (const key of templateKeys) {
      if (!Object.hasOwn(value, key)) {
        errors.push(`${path}.${key}: template key is missing`);
      } else {
        matchTemplate(value[key], template[key], `${path}.${key}`, errors);
      }
    }
    return errors;
  }
  if (value !== template) errors.push(`${path}: value does not match safe constant`);
  return errors;
}

export function matchCapabilityInput(capability, input) {
  const errors = [
    ...validateAgainstInputSchema(input, capability.inputSchema),
  ];
  if (capability.safeArgumentTemplate === undefined) {
    errors.push("$: safeArgumentTemplate is missing");
  } else {
    matchTemplate(input, capability.safeArgumentTemplate, "$", errors);
  }
  return { valid: errors.length === 0, errors };
}

function queryCandidates(input, path = "$", results = []) {
  if (!input || typeof input !== "object") return results;
  for (const [key, value] of Object.entries(input)) {
    const childPath = `${path}.${key}`;
    if (
      typeof value === "string" &&
      /(?:query|sql|statement|graphql|body|request)/iu.test(key)
    ) {
      results.push({ path: childPath, value });
    } else if (value && typeof value === "object") {
      queryCandidates(value, childPath, results);
    }
  }
  return results;
}

function validateReadOnlyQueryContract(capability, input, tool) {
  const generic =
    QUERY_WRAPPER.test(tool) ||
    QUERY_WRAPPER.test(capability.logicalOperation ?? "");
  if (!generic || capability.logicalOperation?.startsWith("docs.")) {
    return [];
  }
  const candidates = queryCandidates(input);
  const policy = capability.readOnlyQueryPolicy;
  if (policy === "exact-template") {
    const templateText = JSON.stringify(capability.safeArgumentTemplate);
    if (templateText.includes('"$slot"')) {
      return ["exact-template policy may not use a free-form query slot"];
    }
    return [];
  }
  if (policy === "http-get") {
    const methods = flatten(input)
      .filter((entry) => /method/iu.test(entry.path))
      .map((entry) => entry.value.toUpperCase());
    return methods.length > 0 && methods.every((method) => ["GET", "HEAD"].includes(method))
      ? []
      : ["HTTP read wrapper is not bound to GET/HEAD"];
  }
  if (policy === "sql-select") {
    return [
      "free-form SQL read classification is disabled in v0.1; use an exact constant template or an independently attested read-only adapter",
    ];
  }
  if (policy === "graphql-query") {
    return [
      "free-form GraphQL read classification is disabled in v0.1; use an exact constant template or an independently attested read-only adapter",
    ];
  }
  return ["generic query/request wrapper lacks a deterministic read-only query policy"];
}

export function analyzeMcpTool({ server, tool, input }, registry = null) {
  const strings = flatten({ server, tool, input });
  const destructiveReasons = [];
  const mutationHints = [];
  for (const entry of strings) {
    if (DESTRUCTIVE_WORD.test(entry.value)) {
      destructiveReasons.push(`destructive token at ${entry.path}`);
    }
    if (SQL_DESTRUCTIVE.test(entry.value)) {
      destructiveReasons.push(`destructive query at ${entry.path}`);
    }
    if (
      /\bDELETE\b/u.test(entry.value) &&
      /(?:method|http|request|\$\.input)/iu.test(entry.path)
    ) {
      destructiveReasons.push(`HTTP DELETE at ${entry.path}`);
    }
    if (MUTATION_WORD.test(entry.value)) mutationHints.push(entry.path);
  }
  const secretLike = secretFindings(input);
  const capability = findCapability(registry, server, tool);
  const unknown = !capability;
  let opaque = unknown || secretLike.length > 0;
  const reasons = [...destructiveReasons];
  if (unknown) reasons.push("tool is absent from the approved capability registry");
  if (secretLike.length > 0) reasons.push("input contains a credential literal");
  if (capability) {
    const inputMatch = matchCapabilityInput(capability, input);
    if (!inputMatch.valid) {
      opaque = true;
      reasons.push(...inputMatch.errors.map((error) => `input contract: ${error}`));
    }
    const queryErrors = validateReadOnlyQueryContract(capability, input, tool);
    if (queryErrors.length > 0) {
      opaque = true;
      reasons.push(...queryErrors.map((error) => `query contract: ${error}`));
    }
  }
  if (
    capability?.classification === "read" &&
    (mutationHints.length > 0 || QUERY_WRAPPER.test(tool)) &&
    capability.safeArgumentTemplate === undefined
  ) {
    opaque = true;
    reasons.push("generic read wrapper lacks a reviewed safe argument template");
  }
  if (
    capability?.classification === "read" &&
    !capability.logicalOperation?.startsWith("docs.") &&
    mutationHints.length > 0
  ) {
    opaque = true;
    reasons.push("read capability input contains mutation semantics");
  }
  if (
    capability?.classification === "read" &&
    capability.probePassed !== true
  ) {
    opaque = true;
    reasons.push("read-only capability probe has not passed");
  }
  const destructive = destructiveReasons.length > 0;
  const actionClass =
    capability?.classification === "mutation"
      ? "infrastructure-mutation"
      : capability?.logicalOperation?.startsWith("docs.")
        ? "configured-source-read"
        : capability?.classification === "read"
          ? "configured-source-read"
          : "unknown";
  return {
    decision:
      destructive || opaque
        ? "deny"
        : capability.classification === "read"
          ? "allow"
          : "review",
    destructive,
    opaque,
    reasons: [...new Set(reasons)],
    actionClass,
    capabilityId: capability?.id ?? null,
    outputLimitBytes: capability?.outputLimitBytes ?? 0,
  };
}
