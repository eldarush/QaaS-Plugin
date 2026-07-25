import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution, printJson } from "./lib/cli.mjs";
import { validateOwnHookConfiguration } from "./lib/runtime-attestation.mjs";

const PUBLIC_SKILLS = Object.freeze([
  "onboard",
  "plan",
  "implement",
  "run",
  "diagnose",
  "doctor",
]);
const SCHEMAS = Object.freeze([
  "context-index.schema.json",
  "readiness.schema.json",
  "fingerprint.schema.json",
  "task-plan.schema.json",
  "execution-plan.schema.json",
  "mutation-plan.schema.json",
  "query-plan.schema.json",
  "integration-capabilities.schema.json",
  "source-checkout.schema.json",
  "approval-event.schema.json",
  "evidence-event.schema.json",
  "verdict.schema.json",
]);
const REQUIRED_SCRIPTS = Object.freeze([
  "doctor.mjs",
  "hook-launcher.mjs",
  "interview-routes.mjs",
  "project-inventory.mjs",
  "validate-readiness.mjs",
  "validate-plan.mjs",
  "validate-execution-plan.mjs",
  "validate-mutation-plan.mjs",
  "validate-plugin.mjs",
  "check-context-budget.mjs",
  "pretool-safety.mjs",
  "posttool-ledger.mjs",
  "session-state.mjs",
  "workflow-authority.mjs",
  "local-encode-mcp.mjs",
  "run-approved.mjs",
  "query-approved.mjs",
  "docs-read.mjs",
  "source-read.mjs",
  "source-checkout.mjs",
]);
const REQUIRED_SUPPORT_FILES = Object.freeze([
  "scripts/lib/project-evidence-inventory.mjs",
  "scripts/lib/interview-route-selector.mjs",
  "references/project-mapping/interview-routing.md",
]);

async function exists(target) {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function existsEntry(target) {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function jsonFile(target, errors, label) {
  try {
    return JSON.parse(await readFile(target, "utf8"));
  } catch (error) {
    errors.push(`${label} is invalid JSON: ${error.message}`);
    return null;
  }
}

function exactKeys(value, keys) {
  return (
    value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    JSON.stringify(Object.keys(value).sort()) ===
      JSON.stringify([...keys].sort())
  );
}

function frontmatter(text) {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  if (lines[0] !== "---") throw new Error("missing opening frontmatter delimiter");
  const end = lines.indexOf("---", 1);
  if (end < 0) throw new Error("missing closing frontmatter delimiter");
  const result = {};
  for (const line of lines.slice(1, end)) {
    const separator = line.indexOf(":");
    if (separator < 1) throw new Error(`invalid frontmatter line: ${line}`);
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    result[key] =
      raw === "true" ? true : raw === "false" ? false : raw;
  }
  return result;
}

async function validateLinks(file, root, errors) {
  const text = await readFile(file, "utf8");
  for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
    const target = match[1].split("#", 1)[0];
    if (!target || /^[a-z][a-z0-9+.-]*:/iu.test(target)) continue;
    const resolved = path.resolve(path.dirname(file), decodeURIComponent(target));
    const relative = path.relative(root, resolved);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      errors.push(`${path.relative(root, file)} has an escaping link: ${target}`);
    } else if (!(await exists(resolved))) {
      errors.push(`${path.relative(root, file)} has a broken link: ${target}`);
    }
  }
}

export async function validatePlugin({
  scriptDirectory = path.dirname(fileURLToPath(import.meta.url)),
} = {}) {
  const errors = [];
  const resolvedScripts = path.resolve(scriptDirectory);
  const pluginRoot = path.resolve(resolvedScripts, "..");
  if (
    path.basename(resolvedScripts) !== "scripts" ||
    path.resolve(pluginRoot, "scripts") !== resolvedScripts
  ) {
    errors.push(
      "validator root invariant failed: scripts must be directly inside the plugin root",
    );
  }
  const manifest = await jsonFile(
    path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    errors,
    "plugin.json",
  );
  const version = manifest?.version;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)
  ) {
    errors.push("plugin.json must contain one semantic version");
  }
  if (manifest?.name !== "qaas") {
    errors.push("plugin manifest name must be qaas");
  }
  const mcpConfiguration = await jsonFile(
    path.join(pluginRoot, ".mcp.json"),
    errors,
    ".mcp.json",
  );
  const localMcp = mcpConfiguration?.mcpServers?.qaas_local;
  if (!exactKeys(mcpConfiguration, ["mcpServers"])) {
    errors.push(".mcp.json must contain only mcpServers");
  }
  if (!exactKeys(mcpConfiguration?.mcpServers, ["qaas_local"])) {
    errors.push(".mcp.json must register exactly the qaas_local server");
  }
  if (
    !exactKeys(localMcp, ["command", "args", "cwd"]) ||
    localMcp?.command !== "node" ||
    JSON.stringify(localMcp?.args) !==
      JSON.stringify([
        "${CLAUDE_PLUGIN_ROOT}/scripts/local-encode-mcp.mjs",
      ]) ||
    localMcp?.cwd !== "${CLAUDE_PLUGIN_ROOT}"
  ) {
    errors.push(
      ".mcp.json qaas_local must be the fixed local stdio encoder configuration",
    );
  }

  const sourceRepositoryCandidate = path.resolve(pluginRoot, "..", "..");
  const sourceRepositoryShape =
    path.resolve(sourceRepositoryCandidate, "plugins", "qaas") === pluginRoot;
  const sourceRepositoryMarkers = sourceRepositoryShape
    ? {
        git: await existsEntry(
          path.join(sourceRepositoryCandidate, ".git"),
        ),
        version: await exists(
          path.join(sourceRepositoryCandidate, "version.json"),
        ),
        package: await exists(
          path.join(sourceRepositoryCandidate, "package.json"),
        ),
        marketplace: await exists(
          path.join(
            sourceRepositoryCandidate,
            ".claude-plugin",
            "marketplace.json",
          ),
        ),
      }
    : {
        git: false,
        version: false,
        package: false,
        marketplace: false,
      };
  const sourceRepositoryPresent =
    sourceRepositoryShape &&
    (sourceRepositoryMarkers.git || sourceRepositoryMarkers.package);
  const packagedBundlePresent =
    sourceRepositoryShape &&
    !sourceRepositoryPresent &&
    sourceRepositoryMarkers.version &&
    sourceRepositoryMarkers.marketplace;
  const partialRootLayout =
    sourceRepositoryShape &&
    !sourceRepositoryPresent &&
    !packagedBundlePresent &&
    Object.values(sourceRepositoryMarkers).some(Boolean);
  if (partialRootLayout) {
    errors.push(
      "partial repository/bundle layout lacks deterministic source or packaged-bundle markers",
    );
  }
  const repositoryRoot = sourceRepositoryPresent || packagedBundlePresent
    ? sourceRepositoryCandidate
    : null;
  if (sourceRepositoryPresent) {
    const versionDocument = await jsonFile(
      path.join(repositoryRoot, "version.json"),
      errors,
      "version.json",
    );
    const packageDocument = await jsonFile(
      path.join(repositoryRoot, "package.json"),
      errors,
      "package.json",
    );
    const marketplace = await jsonFile(
      path.join(repositoryRoot, ".claude-plugin", "marketplace.json"),
      errors,
      "marketplace.json",
    );
    if (
      versionDocument?.version !== version ||
      packageDocument?.version !== version ||
      marketplace?.metadata?.version !== version ||
      marketplace?.plugins?.length !== 1 ||
      marketplace.plugins[0]?.version !== version
    ) {
      errors.push(
        "package, plugin, marketplace, and version.json versions must match",
      );
    }
    if (packageDocument?.engines?.node !== undefined) {
      errors.push("package.json must not pin a Node.js engine");
    }
    for (const field of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
      "peerDependencies",
    ]) {
      if (
        packageDocument?.[field] &&
        Object.keys(packageDocument[field]).length > 0
      ) {
        errors.push(
          `package.json ${field} must stay empty for the dependency-free runtime`,
        );
      }
    }
    if (
      marketplace?.plugins?.[0]?.name !== "qaas" ||
      marketplace?.plugins?.[0]?.source !== "./plugins/qaas"
    ) {
      errors.push("plugin and marketplace identity/source are inconsistent");
    }
  } else if (packagedBundlePresent) {
    const versionDocument = await jsonFile(
      path.join(repositoryRoot, "version.json"),
      errors,
      "bundle version.json",
    );
    const marketplace = await jsonFile(
      path.join(repositoryRoot, ".claude-plugin", "marketplace.json"),
      errors,
      "bundle marketplace.json",
    );
    if (
      versionDocument?.version !== version ||
      marketplace?.metadata?.version !== version ||
      marketplace?.plugins?.length !== 1 ||
      marketplace.plugins[0]?.version !== version
    ) {
      errors.push(
        "plugin, packaged marketplace, and bundle version.json versions must match",
      );
    }
    if (
      marketplace?.plugins?.[0]?.name !== "qaas" ||
      marketplace?.plugins?.[0]?.source !== "./plugins/qaas"
    ) {
      errors.push(
        "packaged plugin and marketplace identity/source are inconsistent",
      );
    }
  }
  const skillsDirectory = path.join(pluginRoot, "skills");
  let skillEntries = [];
  try {
    skillEntries = (await readdir(skillsDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    errors.push(`skills directory is unavailable: ${error.message}`);
  }
  const visible = [];
  for (const skillName of skillEntries) {
    const skillFile = path.join(skillsDirectory, skillName, "SKILL.md");
    if (!(await exists(skillFile))) {
      errors.push(`skill ${skillName} lacks SKILL.md`);
      continue;
    }
    let metadata;
    try {
      metadata = frontmatter(await readFile(skillFile, "utf8"));
    } catch (error) {
      errors.push(`skill ${skillName}: ${error.message}`);
      continue;
    }
    if (typeof metadata.description !== "string" || !metadata.description) {
      errors.push(`skill ${skillName} lacks a description`);
    }
    if (metadata["user-invocable"] !== false) visible.push(skillName);
    if (
      skillName === "qaas-workflow" &&
      metadata["allowed-tools"] !== "mcp__qaas_local__encode_text"
    ) {
      errors.push(
        "qaas-workflow must allow only mcp__qaas_local__encode_text",
      );
    }
    if (PUBLIC_SKILLS.includes(skillName)) {
      if (metadata["disable-model-invocation"] !== true) {
        errors.push(`public skill ${skillName} must disable model invocation`);
      }
    } else if (metadata["user-invocable"] !== false) {
      errors.push(`hidden skill ${skillName} must set user-invocable: false`);
    }
  }
  if (
    JSON.stringify(visible.sort()) !==
    JSON.stringify([...PUBLIC_SKILLS].sort())
  ) {
    errors.push(
      `exactly six visible skills are required: ${PUBLIC_SKILLS.join(", ")}`,
    );
  }
  if (!skillEntries.includes("qaas-workflow")) {
    errors.push("hidden qaas-workflow lifecycle router is missing");
  }
  for (const schema of SCHEMAS) {
    const document = await jsonFile(
      path.join(pluginRoot, "schemas", schema),
      errors,
      `schema ${schema}`,
    );
    if (
      document &&
      (document.$schema !== "https://json-schema.org/draft/2020-12/schema" ||
        document.type !== "object")
    ) {
      errors.push(`schema ${schema} must be a draft-2020-12 object schema`);
    }
  }
  const schemaNames = (
    await readdir(path.join(pluginRoot, "schemas"), { withFileTypes: true })
  )
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name)
    .sort();
  if (
    JSON.stringify(schemaNames) !== JSON.stringify([...SCHEMAS].sort())
  ) {
    errors.push(
      `schema inventory must match the ${SCHEMAS.length} published schemas exactly`,
    );
  }
  for (const script of REQUIRED_SCRIPTS) {
    if (!(await exists(path.join(pluginRoot, "scripts", script)))) {
      errors.push(`required script is missing: scripts/${script}`);
    }
  }
  for (const relativePath of REQUIRED_SUPPORT_FILES) {
    if (!(await exists(path.join(pluginRoot, relativePath)))) {
      errors.push(`required support file is missing: ${relativePath}`);
    }
  }
  const hooks = await validateOwnHookConfiguration(pluginRoot);
  errors.push(...hooks.errors);
  const agentsDirectory = path.join(pluginRoot, "agents");
  for (const entry of await readdir(agentsDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(path.join(agentsDirectory, entry.name), "utf8");
    if (/^model\s*:/mu.test(text)) {
      errors.push(`agent ${entry.name} must inherit the configured model`);
    }
  }
  for (const file of skillEntries.map((name) =>
    path.join(skillsDirectory, name, "SKILL.md")
  )) {
    if (await exists(file)) await validateLinks(file, pluginRoot, errors);
  }
  if (repositoryRoot) {
    const readme = path.join(repositoryRoot, "README.md");
    if (await exists(readme)) {
      await validateLinks(readme, repositoryRoot, errors);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    repositoryRoot,
    pluginRoot,
    layout: sourceRepositoryPresent
      ? "source-repository"
      : packagedBundlePresent
        ? "packaged-marketplace-bundle"
        : "installed-plugin-cache",
    sourceRepositoryChecksApplied: sourceRepositoryPresent,
    packagedBundleChecksApplied: packagedBundlePresent,
    version,
    visibleSkills: visible.sort(),
    targetRuntime: "Claude Code >=2.1.180",
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await validatePlugin();
  printJson(result);
  process.exitCode = result.valid ? 0 : 1;
}
