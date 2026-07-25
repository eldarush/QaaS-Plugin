import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openAuthority } from "./lib/approval-authority.mjs";
import { isDirectExecution, printJson } from "./lib/cli.mjs";
import { compareFingerprints, createFingerprint, verifyFingerprint } from "./lib/fingerprint.mjs";
import { discoverProgram, probeProgram } from "./lib/process-runner.mjs";
import {
  computeHookSettingsInventory,
  computeRuntimeBundle,
  validateOwnHookConfiguration,
} from "./lib/runtime-attestation.mjs";
import { validateCapabilityRegistry } from "./lib/mcp-analyzer.mjs";
import { validateState } from "./lib/state.mjs";
import { checkContextBudget } from "./check-context-budget.mjs";
import { validatePlugin } from "./validate-plugin.mjs";
import { isProjectActivated } from "./lib/activation.mjs";
import { AUTOMATED_EXECUTION_POLICY } from "./lib/execution-policy.mjs";
import {
  attestDocumentationSourceConfiguration,
  DEFAULT_QAAS_DOCS_URL,
} from "./lib/docs-resolver.mjs";

const PROGRAMS = Object.freeze([
  "node",
  "claude",
  "dotnet",
  "git",
  "helm",
  "docker",
  "kubectl",
  "glab",
  "curl",
]);
const VERSION_ARGUMENTS = Object.freeze({
  node: ["--version"],
  claude: ["--version"],
  dotnet: ["--version"],
  git: ["--version"],
  helm: ["version", "--short"],
  docker: ["--version"],
  kubectl: ["version", "--client=true"],
  glab: ["--version"],
  curl: ["--version"],
});
export const MINIMUM_CLAUDE_CODE_VERSION = "2.1.180";

export function parseSemanticVersion(value) {
  if (typeof value !== "string") return null;
  const match = value.match(
    /(?:^|[^0-9A-Za-z-])v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?=$|[^0-9A-Za-z.+-])/u,
  );
  if (!match) return null;
  const core = match.slice(1, 4).map(Number);
  if (core.some((part) => !Number.isSafeInteger(part))) return null;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => part.length === 0)) return null;
  return { core, prerelease };
}

function comparePrerelease(left, right) {
  if (left.length === 0 || right.length === 0) {
    return left.length === right.length ? 0 : left.length === 0 ? 1 : -1;
  }
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] === undefined) return -1;
    if (right[index] === undefined) return 1;
    if (left[index] === right[index]) continue;
    const leftNumeric = /^\d+$/u.test(left[index]);
    const rightNumeric = /^\d+$/u.test(right[index]);
    if (leftNumeric && rightNumeric) {
      if (left[index].length !== right[index].length) {
        return left[index].length < right[index].length ? -1 : 1;
      }
      return left[index] < right[index] ? -1 : 1;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left[index] < right[index] ? -1 : 1;
  }
  return 0;
}

export function compareSemanticVersions(leftValue, rightValue) {
  const left = parseSemanticVersion(leftValue);
  const right = parseSemanticVersion(rightValue);
  if (!left || !right) return null;
  for (let index = 0; index < left.core.length; index += 1) {
    if (left.core[index] === right.core[index]) continue;
    return left.core[index] < right.core[index] ? -1 : 1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

export function supportsClaudeCodeVersion(value) {
  const comparison = compareSemanticVersions(
    value,
    MINIMUM_CLAUDE_CODE_VERSION,
  );
  return comparison !== null && comparison >= 0;
}

async function pathIsFile(target) {
  try {
    return (await stat(target)).isFile();
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function insideProject(projectRoot, target) {
  const relative = path.relative(projectRoot, target);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function authorityDiagnostics({ env, projectRoot, pluginVersion }) {
  if (!env.CLAUDE_PLUGIN_DATA) {
    return {
      initialized: false,
      valid: false,
      reason: "CLAUDE_PLUGIN_DATA is unavailable",
    };
  }
  let authority;
  try {
    authority = await openAuthority({
      pluginData: env.CLAUDE_PLUGIN_DATA,
      projectRoot,
      pluginVersion,
      create: false,
    });
  } catch (error) {
    return {
      initialized: !/No protected authority exists/u.test(error.message),
      valid: false,
      reason: error.message,
      versionMismatch: error?.code === "AUTHORITY_VERSION_MISMATCH",
    };
  }
  const chain = await authority.verifyEventChain();
  const activated = await isProjectActivated(authority);
  const stateRecord = await authority.readSigned("state/current.json", {
    required: false,
  });
  const stateValidity = stateRecord
    ? validateState(stateRecord.payload)
    : { valid: false, errors: ["state is missing"] };
  let fingerprint = { checked: false, fresh: null, errors: [] };
  const stage =
    stateRecord?.payload.phase === "EXECUTING"
      ? "staticVerificationFingerprint"
      : stateRecord?.payload.fingerprints?.expectedWorkingFingerprint
        ? "expectedWorkingFingerprint"
        : stateRecord?.payload.fingerprints?.taskBaseline
          ? "taskBaseline"
          : stateRecord?.payload.fingerprints?.onboardingFingerprint
            ? "onboardingFingerprint"
            : null;
  if (stage) {
    try {
      const record = await authority.readSigned(`fingerprints/${stage}.json`);
      const validity = verifyFingerprint(record.payload);
      if (!validity.valid) throw new Error(validity.errors.join("; "));
      const actual = await createFingerprint({
        projectRoot,
        stage,
        relevantPaths: record.payload.scopePaths ?? null,
        exclusions: (record.payload.exclusions ?? []).filter(
          (entry) => ![".git", ".claude/qaas/state"].includes(entry),
        ),
        packageSnapshot: record.payload.packageSnapshot,
        contextDigest: record.payload.contextDigest,
        externalReferences: record.payload.externalReferences,
        renderedTemplate: record.payload.renderedTemplate,
      });
      const comparison = compareFingerprints(record.payload, actual);
      fingerprint = {
        checked: true,
        stage,
        fresh: comparison.equal,
        errors: comparison.equal
          ? []
          : [
              `added=${comparison.added.join(",")}`,
              `removed=${comparison.removed.join(",")}`,
              `changed=${comparison.changed.join(",")}`,
            ],
      };
    } catch (error) {
      fingerprint = { checked: true, stage, fresh: false, errors: [error.message] };
    }
  }
  let capabilities = { present: false, valid: null, errors: [] };
  const registry = await authority.readSigned("integrations/capabilities.json", {
    required: false,
  });
  if (registry) {
    const validation = validateCapabilityRegistry(registry.payload);
    capabilities = {
      present: true,
      valid: validation.valid,
      errors: validation.errors,
      count: registry.payload.capabilities?.length ?? 0,
    };
  }
  let privatePermissions = null;
  if (process.platform !== "win32") {
    privatePermissions =
      ((await stat(authority.root)).mode & 0o077) === 0;
  }
  return {
    initialized: true,
    activated,
    valid: chain.valid && stateValidity.valid,
    projectId: authority.projectId,
    eventChain: chain,
    state: stateRecord
      ? {
          phase: stateRecord.payload.phase,
          taskId: stateRecord.payload.taskId,
          hooksAttested: stateRecord.payload.hooksAttested,
          validity: stateValidity,
        }
      : null,
    fingerprint,
    capabilities,
    privatePermissions,
  };
}

export async function runDoctor({
  env = process.env,
  projectRoot = path.resolve(
    process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  ),
  pluginRoot = path.resolve(
    process.env.CLAUDE_PLUGIN_ROOT ??
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
  ),
  pluginVersion = null,
} = {}) {
  const canonicalProjectRoot = await realpath(projectRoot).catch(() =>
    path.resolve(projectRoot)
  );
  const plugin = await validatePlugin({
    scriptDirectory: path.join(pluginRoot, "scripts"),
  });
  const effectivePluginVersion = pluginVersion ?? plugin.version;
  const [
    contextBudget,
    ownHooks,
    runtimeBundle,
    settings,
    documentationConfiguration,
  ] =
    await Promise.all([
      checkContextBudget({
        projectRoot,
        scriptDirectory: path.join(pluginRoot, "scripts"),
      }),
      validateOwnHookConfiguration(pluginRoot),
      computeRuntimeBundle({
        pluginRoot,
        pluginVersion: effectivePluginVersion,
      }).catch((error) => ({
        error: error.message,
      })),
      computeHookSettingsInventory({
        projectRoot,
        userHome: env.USERPROFILE ?? env.HOME ?? null,
      }),
      attestDocumentationSourceConfiguration(env)
        .then((attestation) => ({
          valid: true,
          attestation,
        }))
        .catch((error) => ({
          valid: false,
          error: error.message,
        })),
    ]);
  const tools = {};
  for (const program of PROGRAMS) {
    const discovery = await discoverProgram(program, { cwd: projectRoot, env });
    if (!discovery.available) {
      tools[program] = discovery;
      continue;
    }
    if (insideProject(canonicalProjectRoot, discovery.resolvedPath)) {
      tools[program] = {
        available: false,
        error: "project-controlled PATH shadow denied",
        shadowedPath: discovery.resolvedPath,
      };
      continue;
    }
    const probe = await probeProgram(
      discovery.resolvedPath,
      VERSION_ARGUMENTS[program],
      {
        cwd: projectRoot,
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
        approvedExecutablePath: discovery.resolvedPath,
        expectedExecutableDigest: discovery.executableDigest,
      },
    );
    tools[program] = {
      ...discovery,
      versionProbe: probe,
      version: probe.available ? probe.version : null,
      targetSatisfied:
        program === "node"
          ? probe.available
          : program === "claude"
            ? probe.available && supportsClaudeCodeVersion(probe.version)
            : null,
    };
  }
  const shadowNames =
    process.platform === "win32"
      ? ["node.exe", "node.cmd", "node.bat", "node.com"]
      : ["node"];
  const projectNodeShadow = (
    await Promise.all(
      shadowNames.map((name) => pathIsFile(path.join(projectRoot, name))),
    )
  ).some(Boolean);
  const projectNodePathShadow = Boolean(tools.node?.shadowedPath);
  const hookRuntime = {
    available:
      tools.node?.available === true &&
      tools.node?.versionProbe?.available === true,
    resolvedPath: tools.node?.resolvedPath ?? null,
    executableDigest: tools.node?.executableDigest ?? null,
    version: tools.node?.version ?? null,
    projectPathShadowDenied: projectNodePathShadow,
    shellRequired: false,
  };
  const integrations = {
    zeroSetupCoreEndpoints: true,
    projectNuGetSourcesDerived: true,
    taskSpecificSourcesRequestedOnlyWhenNeeded: true,
    credentialValuesInspected: false,
  };
  const authority = await authorityDiagnostics({
    env,
    projectRoot,
    pluginVersion: effectivePluginVersion,
  });
  const blocking = [];
  if (!plugin.valid) blocking.push("plugin contract validation failed");
  if (!ownHooks.valid) blocking.push("mandatory hook configuration is invalid");
  if (runtimeBundle.error) blocking.push("runtime enforcement bundle cannot be hashed");
  if (!documentationConfiguration.valid) {
    blocking.push("documentation source configuration is invalid");
  }
  if (settings.disableAllHooks) blocking.push("disableAllHooks is active");
  if (settings.unknownSideEffectingHooks) {
    blocking.push("other settings-defined hooks make write/run safety unverified");
  }
  if (!hookRuntime.available) {
    blocking.push(
      projectNodePathShadow
        ? "project-controlled Node PATH shadow denies the mandatory hook runtime"
        : "Node.js is unavailable for mandatory QaaS hooks",
    );
  }
  if (
    tools.claude.available &&
    tools.claude.targetSatisfied !== true
  ) {
    blocking.push(
      `Installed Claude Code is older than supported floor ${MINIMUM_CLAUDE_CODE_VERSION} or its version cannot be verified`,
    );
  }
  if (authority.initialized && !authority.valid) {
    blocking.push("protected authority integrity is invalid");
  }
  if (authority.initialized && authority.activated !== true) {
    blocking.push("project authority exists but explicit QaaS activation is absent");
  }
  return {
    ok: blocking.length === 0,
    mode: "read-only",
    targetRuntime: {
      claudeCode: `>=${MINIMUM_CLAUDE_CODE_VERSION}`,
      node: "available",
      postCompact: true,
      postToolUseFailure: true,
      userPromptExpansion: false,
      userPromptExpansionFallback:
        "Direct slash-expansion provenance approval is disabled; approvals use exact AskUserQuestion challenges only.",
    },
    deletionSafety: {
      staticExecutableInputScan: true,
      opaquePrebuiltBehaviorProvable: false,
      limitation:
        "Static source scanning cannot prove indirect behavior. This release does not automatically execute project/external code.",
    },
    projectCodeExecution: {
      ...AUTOMATED_EXECUTION_POLICY,
      exactReviewedCommandHandoff: true,
      boundedUserEvidenceImport: true,
      importedEvidenceAuthority: "user-attested-diagnostic",
    },
    sourceCheckout: {
      automatedCheckoutEnabled: true,
      sources: ["modules", "common-hooks", "reference-project"],
      immutableCommitRequired: true,
      signedExactApprovalRequired: true,
      oneUseApproval: true,
      boundedBareCheckout: true,
      tlsVerificationDefault: true,
      tlsOverrideRequiresExplicitRiskAcknowledgement: true,
      supportedOnboardingPath:
        "Stage and approve one exact source-checkout artifact, run the one-use helper, then use bounded offline inventory/file reads from the signed immutable commit.",
    },
    documentationSources: {
      builtIn: DEFAULT_QAAS_DOCS_URL,
      zeroSetup: true,
      zeroSetupPublicFallback:
        documentationConfiguration.valid &&
        documentationConfiguration.attestation.airgap?.enabled !== true,
      resolutionOrder:
        documentationConfiguration.valid
          ? [...documentationConfiguration.attestation.resolutionOrder]
          : [],
      configuration: documentationConfiguration,
      accessedOnlyByExplicitBoundedQuery: true,
    },
    plugin,
    contextBudget,
    hooks: {
      own: ownHooks,
      settings,
      runtimeBundleDigest: runtimeBundle.digest ?? null,
      completeCompanionPluginAndEnterpriseInventory: false,
      limitation:
        "Claude Code does not expose a complete companion-plugin/enterprise-hook inventory to this plugin; managed deployment must verify /hooks and policy.",
    },
    tools,
    projectNodeShadow,
    projectNodePathShadow,
    hookRuntime,
    integrations,
    authority,
    blocking,
    optionalMissing: PROGRAMS.filter(
      (name) => name !== "node" && !tools[name].available,
    ),
    installsPerformed: false,
    secretEnvironmentValuesEnumerated: false,
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    const result = await runDoctor();
    printJson(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    printJson({ ok: false, mode: "read-only", error: error.message });
    process.exitCode = 1;
  }
}
