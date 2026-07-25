import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
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
import { DEFAULT_QAAS_DOCS_URL } from "./lib/docs-resolver.mjs";

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
const INTEGRATION_VARIABLES = Object.freeze([
  "QAAS_DOCS_PRIMARY_URL",
  "QAAS_DOCS_SECONDARY_URL",
  "QAAS_DOCS_ZIM_PATH",
  "QAAS_DOCS_MCP_URL",
  "QAAS_DOCS_MCP_CREDENTIAL_ENV",
  "QAAS_GITLAB_URL",
  "QAAS_GITLAB_CREDENTIAL_ENV",
  "QAAS_ARTIFACTORY_URL",
  "QAAS_ARTIFACTORY_CREDENTIAL_ENV",
  "QAAS_NUGET_FEED_URL",
  "QAAS_NUGET_CREDENTIAL_ENV",
  "QAAS_MODULES_REPO_URL",
  "QAAS_MODULES_CREDENTIAL_ENV",
  "QAAS_COMMON_HOOKS_REPO_URL",
  "QAAS_COMMON_HOOKS_CREDENTIAL_ENV",
  "QAAS_REFERENCE_PROJECT_REPO_URL",
  "QAAS_REFERENCE_PROJECT_CREDENTIAL_ENV",
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

function fixedLauncherNodeCandidates(env) {
  const candidates = [];
  if (
    typeof env.QAAS_TRUSTED_NODE24 === "string" &&
    path.isAbsolute(env.QAAS_TRUSTED_NODE24)
  ) {
    candidates.push({
      source: "QAAS_TRUSTED_NODE24",
      target: env.QAAS_TRUSTED_NODE24,
    });
  }
  if (process.platform === "win32") {
    const roots = new Set([
      path.parse(process.execPath).root,
      env.SystemDrive ? `${env.SystemDrive}\\` : null,
      "C:\\",
      ...Array.from(
        { length: 23 },
        (_, index) => `${String.fromCharCode("D".charCodeAt(0) + index)}:\\`,
      ),
    ]);
    for (const root of roots) {
      if (!root) continue;
      candidates.push({
        source: "fixed-launcher-path",
        target: path.join(root, "Program Files", "nodejs", "node.exe"),
      });
    }
  } else {
    for (const target of [
      "/usr/bin/node",
      "/usr/local/bin/node",
      "/opt/homebrew/bin/node",
      "/opt/local/bin/node",
    ]) {
      candidates.push({ source: "fixed-launcher-path", target });
    }
  }
  return candidates.filter(
    ({ target }, index, entries) =>
      entries.findIndex(
        (entry) => path.resolve(entry.target) === path.resolve(target),
      ) === index,
  );
}

async function diagnoseFixedLauncherNode({ env, projectRoot }) {
  const attempted = [];
  for (const candidate of fixedLauncherNodeCandidates(env)) {
    attempted.push(candidate);
    const discovery = await discoverProgram(candidate.target, {
      cwd: projectRoot,
      env,
    });
    if (!discovery.available || insideProject(projectRoot, discovery.resolvedPath)) {
      continue;
    }
    const versionProbe = await probeProgram(
      discovery.resolvedPath,
      ["--version"],
      {
        cwd: projectRoot,
        timeoutMs: 5_000,
        outputLimitBytes: 4_096,
        approvedExecutablePath: discovery.resolvedPath,
        expectedExecutableDigest: discovery.executableDigest,
      },
    );
    if (versionProbe.available && /^v?24(?:\.|$)/u.test(versionProbe.version)) {
      return {
        available: true,
        source: candidate.source,
        resolvedPath: discovery.resolvedPath,
        executableDigest: discovery.executableDigest,
        version: versionProbe.version,
        targetSatisfied: true,
        shellPathLookupUsed: false,
      };
    }
  }
  return {
    available: false,
    targetSatisfied: false,
    shellPathLookupUsed: false,
    attemptedCandidates: attempted,
    error: "No fixed or explicitly trusted Node 24 launcher runtime is available",
  };
}

function fixedHookShellCandidates(env) {
  if (process.platform !== "win32") {
    return [{ source: "fixed-posix-path", target: "/bin/sh" }];
  }
  const candidates = [];
  if (
    typeof env.CLAUDE_CODE_GIT_BASH_PATH === "string" &&
    path.isAbsolute(env.CLAUDE_CODE_GIT_BASH_PATH) &&
    /^(?:ba)?sh\.exe$/iu.test(path.basename(env.CLAUDE_CODE_GIT_BASH_PATH))
  ) {
    candidates.push({
      source: "CLAUDE_CODE_GIT_BASH_PATH",
      target: env.CLAUDE_CODE_GIT_BASH_PATH,
    });
  }
  const installRoots = [
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA, "Programs") : null,
    "C:\\Program Files",
    "C:\\Program Files (x86)",
  ].filter(Boolean);
  for (const root of installRoots) {
    for (const relative of [
      ["Git", "usr", "bin", "sh.exe"],
      ["Git", "bin", "bash.exe"],
      ["Git", "bin", "sh.exe"],
    ]) {
      candidates.push({
        source: "fixed-git-bash-path",
        target: path.join(root, ...relative),
      });
    }
  }
  return candidates.filter(
    ({ target }, index, entries) =>
      entries.findIndex(
        (entry) => path.resolve(entry.target) === path.resolve(target),
      ) === index,
  );
}

async function probeHookShellProcess(program, { cwd, env }) {
  return new Promise((resolve) => {
    let settled = false;
    const child = spawn(
      program,
      ["-c", 'test -x /bin/sh && /bin/sh -c "exit 0"'],
      {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore"],
      },
    );
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({ available: false, error: "hook shell probe timed out" });
    }, 5_000);
    child.once("error", (error) => {
      finish({ available: false, error: error.message });
    });
    child.once("close", (exitCode, signal) => {
      finish({
        available: exitCode === 0 && signal === null,
        exitCode,
        signal,
        error:
          exitCode === 0 && signal === null
            ? null
            : "candidate cannot execute the required /bin/sh command",
      });
    });
  });
}

async function diagnoseHookShell({ env, projectRoot, pluginRoot }) {
  const attempted = [];
  for (const candidate of fixedHookShellCandidates(env)) {
    const discovery = await discoverProgram(candidate.target, {
      cwd: projectRoot,
      env,
    });
    const attempt = {
      ...candidate,
      available: discovery.available,
      error: discovery.error ?? null,
    };
    attempted.push(attempt);
    if (
      !discovery.available ||
      insideProject(projectRoot, discovery.resolvedPath) ||
      insideProject(pluginRoot, discovery.resolvedPath)
    ) {
      continue;
    }
    const probe = await probeHookShellProcess(discovery.resolvedPath, {
      cwd: projectRoot,
      env,
    });
    attempt.probe = probe;
    if (probe.available) {
      return {
        available: true,
        requiredCommand: "/bin/sh",
        source: candidate.source,
        resolvedPath: discovery.resolvedPath,
        executableDigest: discovery.executableDigest,
        actualProcessProbe: true,
      };
    }
  }
  return {
    available: false,
    requiredCommand: "/bin/sh",
    actualProcessProbe: true,
    attemptedCandidates: attempted,
    error:
      process.platform === "win32"
        ? "Git Bash with a working /bin/sh is required for QaaS hooks on Windows"
        : "A working /bin/sh is required for QaaS hooks",
  };
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
  const plugin = await validatePlugin({
    scriptDirectory: path.join(pluginRoot, "scripts"),
  });
  const effectivePluginVersion = pluginVersion ?? plugin.version;
  const [contextBudget, ownHooks, runtimeBundle, settings, hookShell] =
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
      diagnoseHookShell({ env, projectRoot, pluginRoot }),
    ]);
  const tools = {};
  for (const program of PROGRAMS) {
    const discovery = await discoverProgram(program, { cwd: projectRoot, env });
    if (!discovery.available) {
      tools[program] = discovery;
      continue;
    }
    if (insideProject(projectRoot, discovery.resolvedPath)) {
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
          ? probe.available && /^v?24(?:\.|$)/u.test(probe.version)
          : program === "claude"
            ? probe.available && /\b2\.1\.201\b/u.test(probe.version)
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
  const hookLauncherRuntime = await diagnoseFixedLauncherNode({
    env,
    projectRoot,
  });
  const integrations = Object.fromEntries(
    INTEGRATION_VARIABLES.map((name) => [name, Boolean(env[name])]),
  );
  const authority = await authorityDiagnostics({
    env,
    projectRoot,
    pluginVersion: effectivePluginVersion,
  });
  const blocking = [];
  if (!plugin.valid) blocking.push("plugin contract validation failed");
  if (!ownHooks.valid) blocking.push("mandatory hook configuration is invalid");
  if (runtimeBundle.error) blocking.push("runtime enforcement bundle cannot be hashed");
  if (settings.disableAllHooks) blocking.push("disableAllHooks is active");
  if (settings.unknownSideEffectingHooks) {
    blocking.push("other settings-defined hooks make write/run safety unverified");
  }
  if (!hookLauncherRuntime.available) {
    blocking.push(
      "Node 24 is unavailable through the fixed QaaS hook-launcher paths",
    );
  }
  if (!hookShell.available) {
    blocking.push(
      process.platform === "win32"
        ? "Git Bash /bin/sh is unavailable for mandatory QaaS hooks"
        : "/bin/sh is unavailable for mandatory QaaS hooks",
    );
  }
  if (
    tools.claude.available &&
    tools.claude.versionProbe?.available &&
    tools.claude.targetSatisfied !== true
  ) {
    blocking.push("Installed Claude Code does not match target 2.1.201");
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
      claudeCode: "2.1.201",
      node: "24.x",
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
        "Opaque prebuilt QaaS hooks/packages cannot be proven deletion-free locally; use an organizationally reviewed package allowlist.",
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
      publicDefault: DEFAULT_QAAS_DOCS_URL,
      primaryConfigured: Boolean(env.QAAS_DOCS_PRIMARY_URL),
      streamableMcpConfigured: Boolean(env.QAAS_DOCS_MCP_URL),
    },
    plugin,
    contextBudget,
    hooks: {
      own: ownHooks,
      settings,
      runtimeBundleDigest: runtimeBundle.digest ?? null,
      completeCompanionPluginAndEnterpriseInventory: false,
      limitation:
        "Claude Code 2.1.201 does not expose a complete companion-plugin/enterprise-hook inventory to this plugin; managed deployment must verify /hooks and policy.",
    },
    tools,
    hookShell,
    projectNodeShadow,
    projectNodeShadowIgnoredByFixedLauncher: projectNodeShadow,
    hookLauncherRuntime,
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
