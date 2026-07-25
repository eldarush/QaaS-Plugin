import { PROJECT_INVENTORY_LIMITS } from "./project-evidence-inventory.mjs";

const SELECTOR_INVENTORY_LIMIT_NAMES = Object.freeze([
  "maxEntries",
  "maxFiles",
  "maxFileBytes",
  "maxReadBytes",
  "maxPathsPerCategory",
  "maxEvidencePerSignal",
]);

const ROUTING_EVIDENCE_PATH_LIMIT = 4;

const ROUTE_DEFINITIONS = Object.freeze([
  {
    id: "http-json",
    title: "HTTP/JSON",
    inventory: (view) =>
      view.hasSignal("protocols", "http") &&
      view.hasSignal("serializations", "json")
        ? ["signal:protocols:http", "signal:serializations:json"]
        : [],
  },
  {
    id: "kafka-protobuf",
    title: "Kafka/Protobuf",
    inventory: (view) =>
      view.hasSignal("protocols", "kafka") &&
      view.hasSignal("serializations", "protobuf")
        ? ["signal:protocols:kafka", "signal:serializations:protobuf"]
        : [],
  },
  {
    id: "rabbitmq-json",
    title: "RabbitMQ/JSON",
    inventory: (view) =>
      view.hasSignal("protocols", "rabbitmq") &&
      view.hasSignal("serializations", "json")
        ? ["signal:protocols:rabbitmq", "signal:serializations:json"]
        : [],
  },
  {
    id: "grpc-protobuf-csharp",
    title: "gRPC/Protobuf C#",
    inventory: (view) =>
      view.hasSignal("protocols", "grpc") &&
      view.hasSignal("serializations", "protobuf") &&
      (view.hasFiles("csharp") || view.hasFiles("dotnetProjects"))
        ? [
            "signal:protocols:grpc",
            "signal:serializations:protobuf",
            "file-category:csharp-or-dotnet",
          ]
        : [],
  },
  {
    id: "tcp-binary",
    title: "TCP/binary",
    inventory: (view) =>
      view.hasSignal("protocols", "tcp-socket") &&
      view.hasSignal("serializations", "binary")
        ? ["signal:protocols:tcp-socket", "signal:serializations:binary"]
        : [],
  },
  {
    id: "kafka-xml",
    title: "Kafka/XML",
    inventory: (view) =>
      view.hasSignal("protocols", "kafka") &&
      view.hasSignal("serializations", "xml")
        ? ["signal:protocols:kafka", "signal:serializations:xml"]
        : [],
  },
  {
    id: "http-mocker",
    title: "HTTP mocker",
    inventory: (view) =>
      view.hasSignal("protocols", "http") &&
      view.hasSignal("extensions", "processor") &&
      view.hasFiles("customHookCode")
        ? [
            "signal:protocols:http",
            "signal:extensions:processor",
            "file-category:customHookCode",
          ]
        : [],
  },
  {
    id: "kubernetes-multi-protocol",
    title: "Kubernetes multi-protocol",
    inventory: (view) =>
      view.hasSignal("infrastructure", "kubernetes") &&
      view.signalCount("protocols") >= 2
        ? [
            "signal:infrastructure:kubernetes",
            "signal-count:protocols-at-least-two",
          ]
        : [],
  },
  {
    id: "stress-request",
    title: "Explicit stress request",
    inventory: () => [],
  },
  {
    id: "fuzz-no-output",
    title: "Fuzz or expected no output",
    inventory: () => [],
  },
  {
    id: "legacy-upgrade",
    title: "Legacy .NET/QaaS upgrade",
    inventory: (view) =>
      view.hasSignal("upgrade", "dotnet-8")
        ? ["signal:upgrade:dotnet-8"]
        : [],
  },
  {
    id: "project-local-hook",
    title: "Project-local custom hook",
    inventory: (view) =>
      view.hasFiles("customHookCode") &&
      ["assertion", "generator", "probe", "processor"].some((value) =>
        view.hasSignal("extensions", value),
      )
        ? [
            "file-category:customHookCode",
            ...["assertion", "generator", "probe", "processor"]
              .filter((value) => view.hasSignal("extensions", value))
              .map((value) => `signal:extensions:${value}`),
          ]
        : [],
  },
  {
    id: "common-hooks-modules",
    title: "Common Hooks or modules",
    inventory: (view) => {
      const cues = [];
      if (view.hasSignal("extensions", "common-hooks-package")) {
        cues.push("signal:extensions:common-hooks-package");
      }
      if (view.hasSignal("composition", "modules")) {
        cues.push("signal:composition:modules");
      }
      return cues;
    },
  },
  {
    id: "readme-only",
    title: "README-only request",
    inventory: () => [],
  },
  {
    id: "observability-diagnosis",
    title: "Allure/ReportPortal/telemetry diagnosis",
    inventory: () => [],
  },
  {
    id: "multiple-roots",
    title: "Multiple possible project roots",
    inventory: (view) =>
      view.hasSignal("repositoryShape", "multiple-dotnet-projects")
        ? ["signal:repositoryShape:multiple-dotnet-projects"]
        : [],
  },
  {
    id: "unsupported-capability",
    title: "Unsupported transport/serializer/policy",
    inventory: () => [],
  },
  {
    id: "safety-sensitive-request",
    title: "Untrusted instructions, deletion, or secrets",
    inventory: () => [],
  },
  {
    id: "path-drift",
    title: "Spaces, Unicode, case, links, or drift",
    inventory: (view) => {
      const cues = [];
      if (view.pathTrait("spaces")) cues.push("path-trait:spaces");
      if (view.pathTrait("nonAscii")) cues.push("path-trait:nonAscii");
      if (view.caseCollisionCount() > 0) {
        cues.push("path-trait:case-collision");
      }
      if (view.skippedLinkCount() > 0) {
        cues.push("count:skipped-links");
      }
      return cues;
    },
  },
  {
    id: "large-case-sensitive",
    title: "Large/case-sensitive repository",
    inventory: (view) => {
      const cues = [];
      if (view.isTruncated()) cues.push("inventory:truncated");
      if (view.fileCount() >= 200) cues.push("count:files-at-least-200");
      if (view.caseCollisionCount() > 0) {
        cues.push("path-trait:case-collision");
      }
      return cues;
    },
  },
]);

export const INTERVIEW_ROUTES = Object.freeze(
  ROUTE_DEFINITIONS.map(({ id, title }) => Object.freeze({ id, title })),
);

export const DIRECT_USER_INTENTS = Object.freeze(
  INTERVIEW_ROUTES.map(({ id }) => id),
);

const ROUTE_BY_ID = new Map(ROUTE_DEFINITIONS.map((route) => [route.id, route]));
const DIRECT_INTENT_SET = new Set(DIRECT_USER_INTENTS);

function assertPlainObject(value, label) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype &&
      Object.getPrototypeOf(value) !== null)
  ) {
    throw new TypeError(`${label} must be a plain object`);
  }
}

function assertExactKeys(value, allowedKeys, label) {
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`${label} contains unsupported field ${key}`);
    }
  }
}

function assertBoundedString(value, label, maximum = 1_024) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new TypeError(`${label} must be a non-empty bounded string`);
  }
}

function assertBoundedInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 0 through ${maximum}`);
  }
}

function assertStringArray(value, label, maximum) {
  if (!Array.isArray(value) || value.length > maximum) {
    throw new TypeError(`${label} must be an array with at most ${maximum} entries`);
  }
  value.forEach((entry, index) =>
    assertBoundedString(entry, `${label}[${index}]`),
  );
}

function assertInventory(inventory) {
  assertPlainObject(inventory, "inventory");
  if (inventory.authority !== "candidate-evidence-only") {
    throw new Error("inventory authority must be candidate-evidence-only");
  }
  if (typeof inventory.truncated !== "boolean") {
    throw new TypeError("inventory.truncated must be boolean");
  }

  assertPlainObject(inventory.limits, "inventory.limits");
  for (const name of SELECTOR_INVENTORY_LIMIT_NAMES) {
    const hardLimit = PROJECT_INVENTORY_LIMITS[name];
    const configured = inventory.limits[name];
    if (
      !Number.isSafeInteger(configured) ||
      configured <= 0 ||
      configured > hardLimit
    ) {
      throw new Error(`inventory.limits.${name} exceeds the trusted bound`);
    }
  }

  assertPlainObject(inventory.counts, "inventory.counts");
  assertBoundedInteger(
    inventory.counts.entriesSeen,
    "inventory.counts.entriesSeen",
    inventory.limits.maxEntries,
  );
  assertBoundedInteger(
    inventory.counts.filesSeen,
    "inventory.counts.filesSeen",
    Math.min(inventory.limits.maxFiles, inventory.counts.entriesSeen),
  );
  assertBoundedInteger(
    inventory.counts.filesRead,
    "inventory.counts.filesRead",
    inventory.counts.filesSeen,
  );
  assertBoundedInteger(
    inventory.counts.bytesRead,
    "inventory.counts.bytesRead",
    inventory.limits.maxReadBytes,
  );
  for (const name of ["skippedDirectories", "skippedLinks"]) {
    assertBoundedInteger(
      inventory.counts[name],
      `inventory.counts.${name}`,
      inventory.counts.entriesSeen,
    );
  }
  assertBoundedInteger(
    inventory.counts.skippedOversizedFiles,
    "inventory.counts.skippedOversizedFiles",
    inventory.counts.filesSeen,
  );
  assertBoundedInteger(
    inventory.counts.skippedUnreadableEntries,
    "inventory.counts.skippedUnreadableEntries",
    Math.min(
      Number.MAX_SAFE_INTEGER,
      inventory.counts.entriesSeen + 1,
    ),
  );
  assertBoundedInteger(
    inventory.counts.skippedAfterLimit,
    "inventory.counts.skippedAfterLimit",
    inventory.limits.maxEntries - inventory.counts.entriesSeen,
  );
  if (typeof inventory.counts.skippedAfterLimitCapped !== "boolean") {
    throw new TypeError(
      "inventory.counts.skippedAfterLimitCapped must be boolean",
    );
  }

  assertPlainObject(inventory.files, "inventory.files");
  if (Object.keys(inventory.files).length > 64) {
    throw new Error("inventory.files has too many categories");
  }
  for (const [category, paths] of Object.entries(inventory.files)) {
    assertBoundedString(category, "inventory file category", 128);
    assertStringArray(
      paths,
      `inventory.files.${category}`,
      inventory.limits.maxPathsPerCategory,
    );
  }

  assertPlainObject(inventory.signals, "inventory.signals");
  if (Object.keys(inventory.signals).length > 32) {
    throw new Error("inventory.signals has too many groups");
  }
  for (const [group, entries] of Object.entries(inventory.signals)) {
    assertBoundedString(group, "inventory signal group", 128);
    if (!Array.isArray(entries) || entries.length > 64) {
      throw new Error(`inventory.signals.${group} is not bounded`);
    }
    for (const [index, entry] of entries.entries()) {
      assertPlainObject(entry, `inventory.signals.${group}[${index}]`);
      assertExactKeys(
        entry,
        new Set(["value", "evidence"]),
        `inventory.signals.${group}[${index}]`,
      );
      assertBoundedString(
        entry.value,
        `inventory.signals.${group}[${index}].value`,
        128,
      );
      assertStringArray(
        entry.evidence,
        `inventory.signals.${group}[${index}].evidence`,
        inventory.limits.maxEvidencePerSignal,
      );
    }
  }

  assertPlainObject(inventory.pathTraits, "inventory.pathTraits");
  if (
    typeof inventory.pathTraits.spaces !== "boolean" ||
    typeof inventory.pathTraits.nonAscii !== "boolean"
  ) {
    throw new TypeError("inventory path flags must be boolean");
  }
  assertStringArray(
    inventory.pathTraits.caseCollisionCandidates,
    "inventory.pathTraits.caseCollisionCandidates",
    8,
  );
}

function inventoryView(inventory) {
  const values = new Map();
  const evidenceByCue = new Map();
  for (const [group, entries] of Object.entries(inventory.signals)) {
    const groupValues = new Set();
    for (const entry of entries) {
      groupValues.add(entry.value);
      evidenceByCue.set(`signal:${group}:${entry.value}`, entry.evidence);
    }
    values.set(group, groupValues);
  }

  return Object.freeze({
    hasSignal: (group, value) => values.get(group)?.has(value) ?? false,
    signalCount: (group) => values.get(group)?.size ?? 0,
    hasFiles: (category) => (inventory.files[category]?.length ?? 0) > 0,
    pathTrait: (trait) => inventory.pathTraits[trait] === true,
    caseCollisionCount: () =>
      inventory.pathTraits.caseCollisionCandidates.length,
    skippedLinkCount: () => inventory.counts.skippedLinks,
    fileCount: () => inventory.counts.filesSeen,
    isTruncated: () => inventory.truncated,
    evidenceForCue: (cue) => evidenceByCue.get(cue) ?? [],
  });
}

function validateDirectUserIntent(source, sourceIndex) {
  assertExactKeys(
    source,
    new Set(["kind", "intents"]),
    `sources[${sourceIndex}]`,
  );
  if (
    !Array.isArray(source.intents) ||
    source.intents.length < 1 ||
    source.intents.length > 3
  ) {
    throw new Error("direct-user-intent requires 1 through 3 bounded intents");
  }
  if (new Set(source.intents).size !== source.intents.length) {
    throw new Error("direct-user-intent intents must be unique");
  }
  for (const intent of source.intents) {
    if (!DIRECT_INTENT_SET.has(intent)) {
      throw new Error(`Unsupported direct user intent ${String(intent)}`);
    }
  }
}

function unique(values) {
  return [...new Set(values)];
}

function inventoryEvidencePaths(view, cues) {
  return unique(cues.flatMap((cue) => view.evidenceForCue(cue))).slice(
    0,
    ROUTING_EVIDENCE_PATH_LIMIT,
  );
}

/**
 * Selects interview routes from an explicit, discriminated cue union.
 *
 * Callers must create direct-user-intent only from normal user dialogue.
 * Repository bytes belong only in the bounded inventory producer; this
 * selector never parses them. Runtime and drift evidence stay in protected
 * workflow/phase authority and are not accepted by this routing API.
 */
export function selectInterviewRoutes(sources) {
  if (!Array.isArray(sources) || sources.length === 0 || sources.length > 2) {
    throw new TypeError("sources must contain 1 or 2 bounded cue sources");
  }

  const selected = new Map();
  let directSourceCount = 0;
  let inventorySourceCount = 0;

  function addRoute(routeId, provenance) {
    const definition = ROUTE_BY_ID.get(routeId);
    if (!definition) throw new Error(`Unknown interview route ${routeId}`);
    const entry = selected.get(routeId) ?? {
      id: routeId,
      title: definition.title,
      provenance: [],
    };
    entry.provenance.push(provenance);
    selected.set(routeId, entry);
  }

  for (const [sourceIndex, source] of sources.entries()) {
    assertPlainObject(source, `sources[${sourceIndex}]`);

    if (source.kind === "direct-user-intent") {
      directSourceCount += 1;
      if (directSourceCount > 1) {
        throw new Error("at most one direct-user-intent source is allowed");
      }
      validateDirectUserIntent(source, sourceIndex);
      for (const intent of source.intents) {
        addRoute(intent, {
          kind: "direct-user-intent",
          authority: "direct-user-dialogue",
          cues: [intent],
        });
      }
      continue;
    }

    if (source.kind === "bounded-tentative-inventory") {
      inventorySourceCount += 1;
      if (inventorySourceCount > 1) {
        throw new Error(
          "at most one bounded-tentative-inventory source is allowed",
        );
      }
      assertExactKeys(
        source,
        new Set(["kind", "inventory"]),
        `sources[${sourceIndex}]`,
      );
      assertInventory(source.inventory);
      const view = inventoryView(source.inventory);
      for (const definition of ROUTE_DEFINITIONS) {
        const cues = definition.inventory(view);
        if (cues.length === 0) continue;
        addRoute(definition.id, {
          kind: "bounded-tentative-inventory",
          authority: "candidate-evidence-only",
          cues,
          evidencePaths: inventoryEvidencePaths(view, cues),
        });
      }
      continue;
    }

    throw new Error(`Unsupported cue source kind ${String(source.kind)}`);
  }

  return {
    schemaVersion: "1.0.0",
    authority: "routing-only-no-readiness",
    routes: ROUTE_DEFINITIONS.filter(({ id }) => selected.has(id)).map(
      ({ id }) => selected.get(id),
    ),
    requiredInterpretation:
      "Ask only matched routes. Inventory provenance remains tentative; route selection never grants readiness, approval, or behavioral truth.",
  };
}
