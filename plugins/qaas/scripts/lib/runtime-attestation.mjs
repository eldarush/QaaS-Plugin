import { readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, sha256 } from "./canonical-json.mjs";

function ordinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

async function collectFiles(root, relative = "") {
  const directory = path.join(root, ...relative.split("/").filter(Boolean));
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((a, b) => ordinal(a.name, b.name))) {
    const child = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(root, child)));
    } else if (entry.isFile()) {
      files.push(child);
    } else {
      throw new Error(
        `Runtime enforcement bundle contains a symlink or unsupported filesystem object: ${child}`,
      );
    }
  }
  return files;
}

const REQUIRED_HOOKS = Object.freeze({
  PreToolUse: {
    matcher: "*",
    script: "pretool-safety.mjs",
    timeout: 30,
  },
  PostToolUse: {
    matcher: "*",
    script: "posttool-ledger.mjs",
    timeout: 30,
  },
  PostToolUseFailure: {
    matcher: "*",
    script: "posttool-ledger.mjs",
    timeout: 30,
  },
  SessionStart: {
    matcher: "startup|resume|clear|compact",
    script: "session-state.mjs",
    timeout: 30,
  },
  UserPromptSubmit: {
    matcher: null,
    script: "session-state.mjs",
    timeout: 10,
  },
  PreCompact: {
    matcher: "manual|auto",
    script: "session-state.mjs",
    timeout: 10,
  },
  PostCompact: {
    matcher: "manual|auto",
    script: "session-state.mjs",
    timeout: 10,
  },
  Stop: {
    matcher: null,
    script: "session-state.mjs",
    timeout: 10,
  },
  ConfigChange: {
    matcher: "user_settings|project_settings|local_settings|policy_settings|skills",
    script: "session-state.mjs",
    timeout: 10,
  },
});

export async function validateOwnHookConfiguration(pluginRoot) {
  const errors = [];
  let document;
  try {
    document = JSON.parse(
      await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
    );
  } catch (error) {
    return { valid: false, errors: [`hooks.json is unreadable: ${error.message}`] };
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).length !== 1 ||
    !document.hooks ||
    typeof document.hooks !== "object" ||
    Array.isArray(document.hooks)
  ) {
    return { valid: false, errors: ["hooks.json must contain only top-level hooks"] };
  }
  const actualEvents = Object.keys(document.hooks).sort(ordinal);
  const expectedEvents = Object.keys(REQUIRED_HOOKS).sort(ordinal);
  if (JSON.stringify(actualEvents) !== JSON.stringify(expectedEvents)) {
    errors.push("hooks.json event inventory is incomplete or has unknown events");
  }
  for (const [eventName, expected] of Object.entries(REQUIRED_HOOKS)) {
    const groups = document.hooks[eventName];
    if (!Array.isArray(groups) || groups.length !== 1) {
      errors.push(`${eventName} must have exactly one matcher group`);
      continue;
    }
    const group = groups[0];
    const allowedGroupKeys = expected.matcher === null
      ? ["hooks"]
      : ["hooks", "matcher"];
    if (
      !group ||
      typeof group !== "object" ||
      Object.keys(group).some((key) => !allowedGroupKeys.includes(key)) ||
      (expected.matcher === null
        ? Object.hasOwn(group, "matcher")
        : group.matcher !== expected.matcher) ||
      !Array.isArray(group.hooks) ||
      group.hooks.length !== 1
    ) {
      errors.push(`${eventName} matcher group does not match the required contract`);
      continue;
    }
    const handler = group.hooks[0];
    const expectedCommand =
      `/bin/sh "\${CLAUDE_PLUGIN_ROOT}/scripts/hook-launcher.sh" ` +
      `"\${CLAUDE_PLUGIN_ROOT}/scripts/${expected.script}"`;
    if (
      !handler ||
      typeof handler !== "object" ||
      Object.keys(handler).sort(ordinal).join(",") !==
        ["command", "timeout", "type"].sort(ordinal).join(",") ||
      handler.type !== "command" ||
      handler.command !== expectedCommand ||
      handler.timeout !== expected.timeout
    ) {
      errors.push(
        `${eventName} handler does not match the fixed trusted launcher command`,
      );
    }
  }
  return { valid: errors.length === 0, errors };
}

/**
 * Hashes the complete deterministic enforcement bundle, not only hooks.json.
 * Self-tests and fixtures are intentionally outside scripts/hooks and are not
 * runtime authority.
 */
export async function computeRuntimeBundle({
  pluginRoot,
  pluginVersion,
  stateFormatVersion = "1.0",
}) {
  const canonicalRoot = await realpath(path.resolve(pluginRoot));
  const hookValidation = await validateOwnHookConfiguration(canonicalRoot);
  if (!hookValidation.valid) {
    throw new Error(
      `Mandatory hook configuration is invalid: ${hookValidation.errors.join("; ")}`,
    );
  }
  const relativeFiles = [
    ...(await collectFiles(path.join(canonicalRoot, "scripts"))).map(
      (entry) => `scripts/${entry}`,
    ),
    ...(await collectFiles(path.join(canonicalRoot, "hooks"))).map(
      (entry) => `hooks/${entry}`,
    ),
  ].sort(ordinal);
  const files = [];
  for (const relative of relativeFiles) {
    const bytes = await readFile(path.join(canonicalRoot, ...relative.split("/")));
    files.push({
      path: relative,
      size: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const bundle = {
    schemaVersion: "1.0",
    pluginVersion,
    stateFormatVersion,
    files,
  };
  bundle.digest = canonicalDigest(bundle);
  return bundle;
}

export async function computeHookSettingsInventory({
  projectRoot,
  userHome = null,
}) {
  const managedCandidates =
    process.platform === "win32"
      ? [
          path.join(
            process.env.ProgramFiles ?? "C:\\Program Files",
            "ClaudeCode",
            "managed-settings.json",
          ),
          path.join(
            process.env.ProgramData ?? "C:\\ProgramData",
            "ClaudeCode",
            "managed-settings.json",
          ),
        ]
      : process.platform === "darwin"
        ? ["/Library/Application Support/ClaudeCode/managed-settings.json"]
        : ["/etc/claude-code/managed-settings.json"];
  const candidates = [
    {
      target: path.join(projectRoot, ".claude", "settings.json"),
      scope: "project",
    },
    {
      target: path.join(projectRoot, ".claude", "settings.local.json"),
      scope: "local",
    },
    ...(userHome
      ? [{
          target: path.join(userHome, ".claude", "settings.json"),
          scope: "user",
        }]
      : []),
    ...managedCandidates.map((target) => ({ target, scope: "policy" })),
  ];
  const files = [];
  let hookCount = 0;
  let disableAllHooks = false;
  const enabledCompanionPlugins = new Set();
  for (const candidate of candidates) {
    try {
      const bytes = await readFile(candidate.target);
      let parsed;
      try {
        parsed = JSON.parse(bytes.toString("utf8"));
      } catch {
        return {
          valid: false,
          unknownSideEffectingHooks: true,
          error: `Invalid ${candidate.scope} settings JSON`,
        };
      }
      const hooks = parsed?.hooks;
      if (parsed?.disableAllHooks === true) disableAllHooks = true;
      if (hooks && typeof hooks === "object") {
        hookCount += Object.values(hooks).reduce(
          (total, entries) => total + (Array.isArray(entries) ? entries.length : 0),
          0,
        );
      }
      if (
        parsed?.enabledPlugins &&
        typeof parsed.enabledPlugins === "object" &&
        !Array.isArray(parsed.enabledPlugins)
      ) {
        for (const [pluginId, enabled] of Object.entries(
          parsed.enabledPlugins,
        )) {
          if (enabled === true && pluginId !== "qaas@qaas-plugin") {
            enabledCompanionPlugins.add(pluginId);
          }
        }
      }
      files.push({
        scope: candidate.scope,
        sha256: sha256(bytes),
        hasHooks: Boolean(hooks && Object.keys(hooks).length > 0),
        enabledCompanionPluginCount: enabledCompanionPlugins.size,
      });
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  const inventory = {
    schemaVersion: "1.0",
    files,
    hookCount,
    enabledCompanionPluginCount: enabledCompanionPlugins.size,
    disableAllHooks,
    inventoryScopes: ["policy", "user", "project", "local", "enabledPlugins"],
    unknownSideEffectingHooks:
      hookCount > 0 || enabledCompanionPlugins.size > 0,
  };
  inventory.digest = canonicalDigest(inventory);
  return { valid: true, ...inventory };
}
