import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  access,
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  canonicalDigest,
  canonicalJson,
  sha256,
} from "../scripts/lib/canonical-json.mjs";
import {
  analyzeProcessVector,
  analyzeShellCommand,
} from "../scripts/lib/shell-analyzer.mjs";
import {
  CSHARP_CLOSURE_FIELDS,
  CSHARP_PLAN_PATH_PATTERN,
  taskPlanTouchesCSharp,
  validateTaskPlan,
} from "../scripts/lib/plan-validation.mjs";
import {
  classifyToolCall,
  hookEnvironment,
} from "../scripts/lib/hook-runtime.mjs";
import {
  analyzeMcpTool,
  validateCapabilityRegistry,
} from "../scripts/lib/mcp-analyzer.mjs";
import {
  assertCurrentDocumentationSourceConfiguration,
  attestDocumentationSourceConfiguration,
  DEFAULT_QAAS_DOCS_URL,
  resolveDocumentationQuery,
  resolveDocumentationSources,
} from "../scripts/lib/docs-resolver.mjs";
import { readConfiguredSource } from "../scripts/lib/source-read-adapter.mjs";
import {
  destructiveAuthoredContentFindings,
} from "../scripts/lib/authored-safety.mjs";
import { evaluatePhaseGate } from "../scripts/lib/phase-gate.mjs";
import { handlePreToolUse } from "../scripts/pretool-safety.mjs";
import { handlePostToolUse } from "../scripts/posttool-ledger.mjs";
import { handleSessionEvent } from "../scripts/session-state.mjs";
import {
  runWorkflowAuthority,
  runtimeContext,
} from "../scripts/workflow-authority.mjs";
import {
  enterSafetyViolationForProcessDrift,
  runApproved,
} from "../scripts/run-approved.mjs";
import { runApprovedQuery } from "../scripts/query-approved.mjs";
import { runSourceCheckout } from "../scripts/source-checkout.mjs";
import { runSourceRead } from "../scripts/source-read.mjs";
import {
  attestWindowsTreeTerminator,
  discoverProgram,
  resolveExecutablePath,
  runProcess,
} from "../scripts/lib/process-runner.mjs";
import { validateOwnHookConfiguration } from "../scripts/lib/runtime-attestation.mjs";
import { validatePlugin } from "../scripts/validate-plugin.mjs";
import { checkContextBudget } from "../scripts/check-context-budget.mjs";
import {
  createEvidenceEvent,
  recordEvidence,
} from "../scripts/lib/evidence.mjs";
import {
  createStreamableMcpCaller,
  describeMcpTransport,
} from "../scripts/lib/streamable-mcp-client.mjs";
import {
  commitTransition,
  createInitialState,
  transitionState,
} from "../scripts/lib/state.mjs";
import {
  consumePreauthorization,
  openAuthority,
  toolInputDigest,
} from "../scripts/lib/approval-authority.mjs";
import { mirrorProjectState } from "../scripts/lib/project-state-mirror.mjs";
import {
  captureProcessFingerprint,
  captureVerificationArtifacts,
  evaluateVerification,
  verifyProcessChanges,
} from "../scripts/lib/verification.mjs";
import {
  validateSourceCheckout,
} from "../scripts/lib/source-checkout-validation.mjs";
import {
  READINESS_DOMAINS,
  readinessSourceClaim,
  validateReadiness,
} from "../scripts/lib/validation.mjs";
import {
  querySpecDigest,
  validateQueryPlan,
} from "../scripts/lib/query-validation.mjs";
import {
  attestQuery,
  executeQuery,
} from "../scripts/lib/query-read-adapter.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function csharpClosureFixture() {
  const item = (fact, status = "resolved") => ({
    status,
    facts: [fact],
    documentationEvidence: [
      "Current synthetic fixture documentation proves this exact closure item.",
    ],
    projectEvidence: [
      "Reviewed fixture paths and commands prove this exact closure item.",
    ],
  });
  return {
    bootstrapModeAndArguments: item(
      "The entry point receives the reviewed template-mode argument vector.",
    ),
    builderTypesAndSignatures: item(
      "The fixture binds the reviewed BaseGenerator<TConfiguration> and public builder signatures.",
    ),
    topology: item(
      "The reviewed fixture contains one entry point and one generated template output.",
    ),
    hookBasesInterfacesAndDiscovery: item(
      "No QaaS hook is changed by this fixture plan.",
      "evidence-proven-inapplicable",
    ),
    configurationRecordAndBinding: item(
      "No hook configuration record is changed by this fixture plan.",
      "evidence-proven-inapplicable",
    ),
    providerPackages: item(
      "The reviewed project file is the exact provider-package owner.",
    ),
    yamlAndCsharpUse: item(
      "The reviewed C# entry point owns runtime bootstrap and emits the template artifact.",
    ),
    restoreBuildTemplateCommands: item(
      "The exact restore, build, and template vectors are bound in this plan.",
    ),
  };
}

function taskPlanFixture({
  changedPath = "Hooks/DeterministicAssertion.cs",
  csharpClosure,
} = {}) {
  const command = (program, args) => ({
    program,
    args,
    cwd: ".",
    envNames: [],
    shell: false,
    timeoutMs: 60_000,
    outputLimitBytes: 16_384,
  });
  const plan = {
    schemaVersion: "1.0",
    planId: "closure-contract-plan",
    taskId: "closure-contract-task",
    createdAt: "2026-07-25T00:00:00.000Z",
    contextDigest: sha256("closure-context"),
    projectFingerprintDigest: sha256("closure-project"),
    packageSnapshotDigest: sha256("closure-packages"),
    goal: "Exercise the task-plan closure contract",
    acceptanceCriteria: ["The exact planned change validates"],
    paths: {
      create: [],
      modify: [changedPath],
      forbidden: [],
      unchanged: [],
    },
    changes: [
      {
        path: changedPath,
        operation: "modify",
        intent: "Apply the exact reviewed fixture change",
      },
    ],
    dependencies: [],
    commands: {
      restore: [command("dotnet", ["restore", "Fixture.csproj", "--nologo"])],
      build: [
        command("dotnet", [
          "build",
          "Fixture.csproj",
          "--no-restore",
          "--nologo",
        ]),
      ],
      template: [
        command("dotnet", [
          "run",
          "--project",
          "Fixture.csproj",
          "--no-build",
          "--",
          "template",
        ]),
      ],
    },
    generatedOutputs: ["bin", "obj", "rendered"],
    expectedDiff: "Only the reviewed fixture path changes",
    risks: [],
    acceptedResidualRisks: [],
    verification: {
      restore: [
        {
          id: "restore-assets",
          type: "file-not-empty",
          path: "obj/project.assets.json",
        },
      ],
      build: [
        {
          id: "build-succeeded",
          type: "stdout-contains",
          contains: "Build succeeded.",
        },
      ],
      template: [
        {
          id: "template-artifact",
          type: "file-not-empty",
          path: "rendered/template.json",
        },
      ],
    },
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
    ...(csharpClosure === undefined ? {} : { csharpClosure }),
  };
  plan.digest = canonicalDigest(plan);
  return plan;
}

test("C# planning keeps an exact implementation-closure gate", async () => {
  const [workflow, csharpAuthoring, checklist] = await Promise.all([
    readFile(path.join(pluginRoot, "skills", "qaas-workflow", "SKILL.md"), "utf8"),
    readFile(
      path.join(pluginRoot, "skills", "author-qaas-csharp", "SKILL.md"),
      "utf8",
    ),
    readFile(
      path.join(
        pluginRoot,
        "references",
        "test-authoring",
        "authoring-checklist.md",
      ),
      "utf8",
    ),
  ]);
  const closureFields = [
    "bootstrapModeAndArguments",
    "builderTypesAndSignatures",
    "topology",
    "hookBasesInterfacesAndDiscovery",
    "configurationRecordAndBinding",
    "providerPackages",
    "yamlAndCsharpUse",
    "restoreBuildTemplateCommands",
  ];
  for (const text of [workflow, csharpAuthoring, checklist]) {
    const normalized = text.replace(/\s+/gu, " ");
    assert.match(normalized, /csharpClosure/u);
    for (const field of closureFields) {
      assert.match(normalized, new RegExp(`\\b${field}\\b`, "u"));
    }
  }
  assert.match(
    workflow.replace(/\s+/gu, " "),
    /Every plan touching C# MUST itself contain this exact eight-field object/u,
  );
  assert.match(
    workflow.replace(/\s+/gu, " "),
    /Reject missing\/null\/placeholder\/contradicted fields or facts elsewhere; continue one question\/query and never request approval/u,
  );
  assert.match(
    workflow.replace(/\s+/gu, " "),
    /For C#, explicitly confirm naming, immutable-record, commented-code, and unit-test-project conventions/u,
  );
  assert.match(
    csharpAuthoring.replace(/\s+/gu, " "),
    /Do not discover, infer, or invent/u,
  );
  assert.match(checklist.replace(/\s+/gu, " "), /stop for a revised plan/u);
});

test("planning separates authority facts from approval-bound local choices", async () => {
  const sources = Object.fromEntries(
    await Promise.all(
      [
        ["workflow", "skills/qaas-workflow/SKILL.md"],
        ["planner", "agents/test-planner.md"],
        [
          "checklist",
          "references/test-authoring/authoring-checklist.md",
        ],
        ["yaml", "skills/author-qaas-yaml/SKILL.md"],
      ].map(async ([name, relativePath]) => [
        name,
        (await readFile(path.join(pluginRoot, relativePath), "utf8")).replace(
          /\s+/gu,
          " ",
        ),
      ]),
    ),
  );
  for (const name of ["workflow", "planner"]) {
    assert.match(sources[name], /authority facts/iu, name);
    assert.match(sources[name], /project-local identifiers/iu, name);
    assert.match(sources[name], /plan approval/iu, name);
    assert.match(sources[name], /external (?:behavior|contract)/iu, name);
    assert.match(sources[name], /QaaS semantics/iu, name);
  }
  assert.match(
    sources.checklist,
    /`resolved` does not mean user-originated/u,
  );
  assert.match(
    sources.checklist,
    /implementation-local identifier or organization choice may be resolved as a disclosed planner proposal/u,
  );
  assert.match(sources.yaml, /Minimal local anchor/u);
  assert.match(sources.yaml, /used only after plan approval/u);
});

test("planning binds exact write bytes and preserves literal semantic order", async () => {
  const sources = Object.fromEntries(
    await Promise.all(
      [
        ["workflow", "skills/qaas-workflow/SKILL.md"],
        ["planner", "agents/test-planner.md"],
        [
          "approvals",
          "references/workflow/readiness-and-approvals.md",
        ],
        ["csharp", "skills/author-qaas-csharp/SKILL.md"],
        [
          "checklist",
          "references/test-authoring/authoring-checklist.md",
        ],
      ].map(async ([name, relativePath]) => [
        name,
        (await readFile(path.join(pluginRoot, relativePath), "utf8")).replace(
          /\s+/gu,
          " ",
        ),
      ]),
    ),
  );
  const exactWriteCommand =
    /`write <add\|modify> <path> sha256:<digest>`/u;
  for (const name of ["workflow", "planner", "approvals", "csharp", "checklist"]) {
    const text = sources[name];
    assert.match(text, /active authority/u, name);
    assert.match(text, /exact complete (?:target )?bytes/u, name);
    assert.match(text, /SHA-256/u, name);
    assert.match(text, exactWriteCommand, name);
    assert.match(text, /scop/iu, name);
    assert.match(text, /literal tokens/u, name);
    assert.match(text, /array (?:element )?order/u, name);
    assert.match(text, /paraphrase/iu, name);
    assert.match(text, /synonym/iu, name);
    assert.match(text, /reorder/iu, name);
    assert.match(text, /normaliz/iu, name);
  }
  for (const name of ["planner", "approvals", "checklist"]) {
    assert.match(
      sources[name],
      /(?:use )?`add` (?:maps )?only (?:for|to) `paths\.create`/u,
      name,
    );
    assert.match(
      sources[name],
      /(?:use )?`modify` (?:maps )?only (?:for|to) `paths\.modify`/u,
      name,
    );
  }
  assert.match(
    sources.workflow,
    /before approval draft exact complete bytes without writing/u,
  );
  assert.match(
    sources.planner,
    /draft the exact complete target bytes for every planned write without writing them/u,
  );
  assert.match(
    sources.approvals,
    /A patch, summary, partial file, prospective digest, or post-approval draft is not a content binding/u,
  );
});

test("valid C# task plan requires the complete nested closure contract", () => {
  const result = validateTaskPlan(
    taskPlanFixture({ csharpClosure: csharpClosureFixture() }),
  );
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test("C# task plan rejects every missing or null closure field", () => {
  for (const field of CSHARP_CLOSURE_FIELDS) {
    const missing = taskPlanFixture({ csharpClosure: csharpClosureFixture() });
    delete missing.csharpClosure[field];
    missing.digest = canonicalDigest(missing);
    const missingResult = validateTaskPlan(missing);
    assert.equal(missingResult.valid, false, `${field} must be required`);
    assert.ok(
      missingResult.errors.some(
        (entry) =>
          entry.path === `$.csharpClosure.${field}` &&
          entry.keyword === "required",
      ),
      JSON.stringify(missingResult.errors, null, 2),
    );

    const nullItem = taskPlanFixture({ csharpClosure: csharpClosureFixture() });
    nullItem.csharpClosure[field] = null;
    nullItem.digest = canonicalDigest(nullItem);
    const nullResult = validateTaskPlan(nullItem);
    assert.equal(nullResult.valid, false, `${field} must reject null`);
    assert.ok(
      nullResult.errors.some(
        (entry) =>
          entry.path === `$.csharpClosure.${field}` && entry.keyword === "type",
      ),
      JSON.stringify(nullResult.errors, null, 2),
    );
  }
});

test("C# task plan rejects placeholders in facts and both evidence arrays", () => {
  for (const property of [
    "facts",
    "documentationEvidence",
    "projectEvidence",
  ]) {
    const plan = taskPlanFixture({ csharpClosure: csharpClosureFixture() });
    plan.csharpClosure.bootstrapModeAndArguments[property] = [
      "TODO fill this later",
    ];
    plan.digest = canonicalDigest(plan);
    const result = validateTaskPlan(plan);
    assert.equal(result.valid, false, `${property} must reject placeholders`);
    assert.ok(
      result.errors.some(
        (entry) =>
          entry.path ===
            `$.csharpClosure.bootstrapModeAndArguments.${property}[0]` &&
          entry.keyword === "gate",
      ),
      JSON.stringify(result.errors, null, 2),
    );
  }
});

test("non-C# task plan may omit csharpClosure", () => {
  const plan = taskPlanFixture({ changedPath: "Tests/test.qaas.yaml" });
  assert.equal(taskPlanTouchesCSharp(plan), false);
  const result = validateTaskPlan(plan);
  assert.equal(result.valid, true, JSON.stringify(result.errors, null, 2));
});

test("task-plan schema and runtime agree on C# paths and closure fields", async () => {
  const schema = JSON.parse(
    await readFile(
      path.join(pluginRoot, "schemas", "task-plan.schema.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    schema.$defs.csharpClosure.required,
    CSHARP_CLOSURE_FIELDS,
  );
  assert.deepEqual(
    Object.keys(schema.$defs.csharpClosure.properties),
    CSHARP_CLOSURE_FIELDS,
  );
  for (const field of CSHARP_CLOSURE_FIELDS) {
    assert.equal(
      schema.$defs.csharpClosure.properties[field].$ref,
      "#/$defs/csharpClosureItem",
    );
  }
  assert.deepEqual(
    schema.$defs.csharpClosureItem.required,
    ["status", "facts", "documentationEvidence", "projectEvidence"],
  );
  assert.deepEqual(
    schema.allOf[0].then.required,
    ["csharpClosure"],
  );

  const schemaPathPattern = new RegExp(schema.$defs.csharpPath.pattern, "u");
  const cases = [
    "Hook.cs",
    "Project.CSPROJ",
    "Directory.Build.props",
    "build.targets",
    "solution.slnx",
    "Tests/test.qaas.yaml",
    "README.md",
  ];
  for (const changedPath of cases) {
    const schemaTouches = schemaPathPattern.test(changedPath);
    const runtimeTouches = CSHARP_PLAN_PATH_PATTERN.test(changedPath);
    assert.equal(runtimeTouches, schemaTouches, changedPath);
    assert.equal(
      taskPlanTouchesCSharp(taskPlanFixture({ changedPath })),
      schemaTouches,
      changedPath,
    );
    const result = validateTaskPlan(taskPlanFixture({ changedPath }));
    assert.equal(result.valid, !schemaTouches, changedPath);
  }
});

const readinessDomains = [
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
];

const coreTopics = [
  "project.md",
  "structure.md",
  "tested-system.md",
  "qaas-configuration.md",
  "conventions.md",
  "commands.md",
  "suites-and-cases.md",
  "samples.md",
  "custom-hooks.md",
  "modules.md",
  "environments.md",
  "observability.md",
  "integrations.md",
  "decisions.md",
  "unknowns.md",
];

test("readiness template, published schema, and runtime domain inventory stay aligned", async () => {
  const template = JSON.parse(
    await readFile(
      path.join(
        pluginRoot,
        "templates",
        "project-context",
        ".claude",
        "qaas",
        "state",
        "tasks",
        "_template",
        "readiness.json",
      ),
      "utf8",
    ),
  );
  const schema = JSON.parse(
    await readFile(
      path.join(pluginRoot, "schemas", "readiness.schema.json"),
      "utf8",
    ),
  );
  assert.deepEqual(
    Object.keys(template.domains).sort(),
    [...READINESS_DOMAINS].sort(),
  );
  assert.deepEqual(
    [...schema.properties.domains.required].sort(),
    [...READINESS_DOMAINS].sort(),
  );
  assert.deepEqual(
    Object.keys(schema.properties.domains.properties).sort(),
    [...READINESS_DOMAINS].sort(),
  );
  assert.deepEqual(
    Object.keys(template).sort(),
    [
      "domains",
      "finalRestatement",
      "projectId",
      "requiredSourcesEvidence",
      "schemaVersion",
      "taskId",
    ],
  );
  for (const source of [
    ...template.requiredSourcesEvidence,
    ...Object.values(template.domains).flatMap((entry) => entry.sources),
  ]) {
    assert.deepEqual(
      Object.keys(source).sort(),
      ["claimDigest", "digest", "identifier", "kind"],
    );
  }
  const missingTaskId = {
    ...template,
    projectId: "project",
  };
  delete missingTaskId.taskId;
  assert.equal(validateReadiness(missingTaskId).valid, false);
});

test("context budget measures the shipped CLAUDE template and rejects line/token mutants", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-context-budget-"));
  const copiedPlugin = path.join(root, "qaas");
  await cp(pluginRoot, copiedPlugin, { recursive: true });
  const template = path.join(
    copiedPlugin,
    "templates",
    "project-context",
    ".claude",
    "CLAUDE.md",
  );
  const project = path.join(root, "project");
  await mkdir(project);
  const baseline = await checkContextBudget({
    scriptDirectory: path.join(copiedPlugin, "scripts"),
    projectRoot: project,
  });
  assert.equal(baseline.valid, true, baseline.errors.join("; "));
  assert.ok(baseline.measured.shippedClaudeLines > 0);
  assert.ok(baseline.measured.shippedClaudeTokens > 0);
  assert.ok(
    baseline.measured.aggregateProxy >=
      baseline.measured.shippedClaudeTokens,
  );

  await writeFile(
    template,
    `${Array.from({ length: 201 }, (_, index) => `line ${index}`).join("\n")}\n`,
    "utf8",
  );
  const lineMutant = await checkContextBudget({
    scriptDirectory: path.join(copiedPlugin, "scripts"),
    projectRoot: project,
  });
  assert.equal(lineMutant.valid, false);
  assert.match(lineMutant.errors.join("; "), /shipped template.*200 lines/u);

  await writeFile(template, `# Oversized\n\n${"x".repeat(8_100)}\n`, "utf8");
  const tokenMutant = await checkContextBudget({
    scriptDirectory: path.join(copiedPlugin, "scripts"),
    projectRoot: project,
  });
  assert.equal(tokenMutant.valid, false);
  assert.match(
    tokenMutant.errors.join("; "),
    /shipped template.*2000-token proxy/u,
  );
});

test("readiness claims support tiny projects but reject blind evidence replay", () => {
  const digest = sha256("one-small-project-file");
  const source = {
    kind: "project",
    identifier: `evidence:${digest}`,
    digest,
  };
  const required = {
    ...source,
    claimDigest: readinessSourceClaim({
      source,
      purpose: "required-sources",
    }),
  };
  const domains = Object.fromEntries(
    READINESS_DOMAINS.map((domain) => {
      const status = "evidenced";
      const summary = `The one bounded file explicitly covers ${domain}.`;
      return [
        domain,
        {
          status,
          summary,
          sources: [
            {
              ...source,
              claimDigest: readinessSourceClaim({
                source,
                domain,
                status,
                summary,
              }),
            },
          ],
        },
      ];
    }),
  );
  const tinyProject = {
    schemaVersion: "1.0",
    projectId: "tiny-project",
    taskId: null,
    requiredSourcesEvidence: [required],
    finalRestatement:
      "One small, immutable project file explicitly covers every reviewed readiness domain.",
    domains,
  };
  assert.equal(validateReadiness(tinyProject).ready, true);
  const replayedClaim = domains["repository-boundary"].sources[0].claimDigest;
  const blindReplay = structuredClone(tinyProject);
  for (const domain of READINESS_DOMAINS) {
    blindReplay.domains[domain].sources[0].claimDigest = replayedClaim;
  }
  assert.equal(validateReadiness(blindReplay).valid, false);
});

test("typed verification rejects zero-exit mutants, stale artifacts, and real warnings", async () => {
  const item = await fixture("qaas-verification-");
  await mkdir(path.join(item.project, "reports"));
  const result = {
    stdout: "Build succeeded.\n    0 Warning(s)\n",
    stderr: "",
  };
  const stdoutCheck = [
    {
      id: "build-success",
      type: "stdout-contains",
      contains: "Build succeeded.",
    },
  ];
  const zeroWarningSummary = await evaluateVerification({
    projectRoot: item.project,
    results: [result],
    checks: stdoutCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
  });
  assert.equal(zeroWarningSummary.passed, true);

  const actualWarning = await evaluateVerification({
    projectRoot: item.project,
    results: [
      {
        ...result,
        stdout: `${result.stdout}warning CS0618: obsolete API\n`,
      },
    ],
    checks: stdoutCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
  });
  assert.equal(actualWarning.passed, false);

  const artifactCheck = [
    {
      id: "report-passed",
      type: "json-pointer-equals",
      path: "reports/result.json",
      jsonPointer: "/passed",
      expected: true,
    },
  ];
  const missing = await evaluateVerification({
    projectRoot: item.project,
    results: [{ stdout: "", stderr: "" }],
    checks: artifactCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
  });
  assert.equal(missing.passed, false);

  await writeFile(
    path.join(item.project, "reports", "result.json"),
    '{"passed":false}',
    "utf8",
  );
  const wrong = await evaluateVerification({
    projectRoot: item.project,
    results: [{ stdout: "", stderr: "" }],
    checks: artifactCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
  });
  assert.equal(wrong.passed, false);

  await writeFile(
    path.join(item.project, "reports", "result.json"),
    '{"passed":true}',
    "utf8",
  );
  const prior = await captureVerificationArtifacts(
    item.project,
    artifactCheck,
  );
  const stale = await evaluateVerification({
    projectRoot: item.project,
    results: [{ stdout: "", stderr: "" }],
    checks: artifactCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
    requireFreshArtifacts: true,
    priorArtifactStates: prior,
  });
  assert.equal(stale.passed, false);
  await writeFile(
    path.join(item.project, "reports", "result.json"),
    '{"passed":true,"attempt":2}',
    "utf8",
  );
  const fresh = await evaluateVerification({
    projectRoot: item.project,
    results: [{ stdout: "", stderr: "" }],
    checks: artifactCheck,
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
    requireFreshArtifacts: true,
    priorArtifactStates: prior,
  });
  assert.equal(fresh.passed, true);
});

test("query approval binds digest and signature fields in exact tool input", () => {
  const toolInput = {
    method: "GET",
    relativeUrl: "api/results",
    digest: "displayed-digest-field",
    signature: "displayed-signature-field",
  };
  const query = {
    queryId: "query-one",
    provider: "reportportal",
    capabilityId: "reportportal-read",
    toolName: "mcp__reportportal__read",
    toolInput,
    toolInputDigest: sha256(toolInput),
    endpointSelector: "QAAS_REPORTPORTAL_URL",
    purpose: "Read exact bounded launch evidence",
    credentialEnvNames: [],
    timeoutMs: 5_000,
    outputLimitBytes: 8_192,
    itemLimit: 100,
    readOnly: true,
    responseChecks: [
      { id: "status", type: "status-equals", expectedStatus: 200 },
    ],
  };
  query.queryDigest = querySpecDigest(query);
  const plan = {
    schemaVersion: "1.0",
    queryPlanId: "query-plan",
    taskId: "task",
    createdAt: new Date().toISOString(),
    executionPlanDigest: sha256("execution"),
    currentFingerprintDigest: sha256("fingerprint"),
    queries: [query],
  };
  plan.digest = canonicalDigest(plan);
  assert.equal(validateQueryPlan(plan).valid, true);
  for (const field of ["digest", "signature"]) {
    const mutant = structuredClone(plan);
    mutant.queries[0].toolInput[field] += "-changed";
    mutant.queries[0].queryDigest = querySpecDigest(mutant.queries[0]);
    mutant.digest = canonicalDigest(mutant);
    assert.equal(
      validateQueryPlan(mutant).valid,
      false,
      `${field} must remain bound by toolInputDigest`,
    );
  }
});

test("query adapter rechecks endpoint identity, deep-redacts, and rejects invalid UTF-8", async () => {
  const item = await fixture("qaas-query-adapter-");
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["method", "relativeUrl"],
    properties: {
      method: { const: "GET" },
      relativeUrl: { type: "string", maxLength: 120 },
    },
  };
  const capability = {
    id: "reportportal-read",
    logicalOperation: "observability.reportportal",
    server: "reportportal",
    tool: "read",
    classification: "read",
    inputSchema,
    schemaDigest: canonicalDigest(inputSchema),
    safeArgumentTemplate: {
      method: "GET",
      relativeUrl: "api/results",
    },
    readOnlyQueryPolicy: "http-get",
    outputLimitBytes: 16_384,
    outputLimitItems: 100,
    probePassed: true,
    userApproved: true,
  };
  const registry = {
    version: "1",
    approvedAt: new Date().toISOString(),
    capabilities: [capability],
  };
  const toolInput = { method: "GET", relativeUrl: "api/results" };
  const query = {
    queryId: "reportportal-result",
    provider: "reportportal",
    capabilityId: capability.id,
    toolName: "mcp__reportportal__read",
    toolInput,
    toolInputDigest: sha256(toolInput),
    endpointSelector: "QAAS_REPORTPORTAL_URL",
    purpose: "Read one exact bounded synthetic result",
    credentialEnvNames: ["RP_TOKEN"],
    timeoutMs: 5_000,
    outputLimitBytes: 16_384,
    itemLimit: 100,
    readOnly: true,
    responseChecks: [
      { id: "status", type: "status-equals", expectedStatus: 200 },
      {
        id: "passed",
        type: "json-pointer-equals",
        jsonPointer: "/passed",
        expected: true,
      },
      {
        id: "secret-redacted-before-check",
        type: "json-pointer-equals",
        jsonPointer: "/nested/token",
        expected: "[REDACTED_FIELD]",
      },
    ],
  };
  query.queryDigest = querySpecDigest(query);
  const env = {
    QAAS_REPORTPORTAL_URL: "http://127.0.0.1:4567/base/",
    QAAS_REPORTPORTAL_CREDENTIAL_ENV: "RP_TOKEN",
    RP_TOKEN: "low-entropy-test-value",
  };
  const binding = attestQuery({
    query,
    registry,
    env,
    projectRoot: item.project,
  });
  assert.equal(binding.adapterId, "qaas-internal-http-get-v1");
  assert.equal(
    binding.registeredPermissionContract.toolName,
    query.toolName,
  );
  assert.equal(Object.hasOwn(binding, "credentialValueDigests"), false);
  let fetchCalls = 0;
  const result = await executeQuery({
    query,
    binding,
    registry,
    projectRoot: item.project,
    env,
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(
        JSON.stringify({
          passed: true,
          nested: {
            token: "tiny-secret",
            message: "ordinary nested value",
          },
        }),
        { status: 200 },
      );
    },
  });
  assert.equal(result.verification.passed, true);
  assert.doesNotMatch(result.excerpt, /tiny-secret/u);
  assert.match(result.excerpt, /REDACTED/u);

  await assert.rejects(
    executeQuery({
      query,
      binding,
      registry,
      projectRoot: item.project,
      env: {
        ...env,
        QAAS_REPORTPORTAL_URL: "http://127.0.0.1:4568/other/",
      },
      fetchImpl: async () => {
        fetchCalls += 1;
        throw new Error("fetch must not run after endpoint drift");
      },
    }),
    /changed after exact review/u,
  );
  assert.equal(fetchCalls, 1);

  await assert.rejects(
    executeQuery({
      query,
      binding,
      registry,
      projectRoot: item.project,
      env,
      fetchImpl: async () =>
        new Response(Uint8Array.from([0xc3, 0x28]), { status: 200 }),
    }),
    /not valid UTF-8/u,
  );
});

test("post-process fingerprints allow only project-root-relative reviewed outputs", async () => {
  const item = await fixture("qaas-process-integrity-");
  await writeFile(path.join(item.project, "source.txt"), "original", "utf8");
  const beforeOutput = await captureProcessFingerprint(
    item.project,
    "taskBaseline",
  );
  await mkdir(path.join(item.project, "test-output"));
  await writeFile(
    path.join(item.project, "test-output", "result.json"),
    "{}",
    "utf8",
  );
  const allowed = await verifyProcessChanges({
    projectRoot: item.project,
    before: beforeOutput,
    allowedOutputDirectories: ["test-output"],
    protectedPaths: ["source.txt"],
    stage: "taskBaseline",
  });
  assert.equal(allowed.ok, true);
  const beforeMutation = await captureProcessFingerprint(
    item.project,
    "taskBaseline",
  );
  await writeFile(path.join(item.project, "source.txt"), "mutated", "utf8");
  const denied = await verifyProcessChanges({
    projectRoot: item.project,
    before: beforeMutation,
    allowedOutputDirectories: ["test-output"],
    protectedPaths: ["source.txt"],
    stage: "taskBaseline",
  });
  assert.equal(denied.ok, false);
  assert.deepEqual(denied.unexpected, ["source.txt"]);
});

test("Windows tree termination uses fixed System32 identity despite PATH/cwd shadowing", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows fixed-helper identity applies only on Windows");
    return;
  }
  const item = await fixture("qaas-taskkill-shadow-");
  const shadowDirectory = path.join(item.project, "shadow");
  await mkdir(shadowDirectory);
  const shadow = path.join(shadowDirectory, "taskkill.exe");
  await writeFile(shadow, "not the operating-system helper", "utf8");
  const genericShadow = await resolveExecutablePath("taskkill.exe", {
    cwd: shadowDirectory,
    env: {
      PATH: shadowDirectory,
      PATHEXT: ".EXE",
    },
  });
  assert.equal(genericShadow, await realpath(shadow));

  const helper = await attestWindowsTreeTerminator();
  assert.notEqual(
    helper.resolvedPath.toLowerCase(),
    genericShadow.toLowerCase(),
  );
  assert.equal(
    path.win32.basename(helper.resolvedPath).toLowerCase(),
    "taskkill.exe",
  );
  assert.equal(
    path.win32.dirname(helper.resolvedPath).toLowerCase(),
    helper.systemDirectory.toLowerCase(),
  );
  assert.equal(helper.executableDigest, sha256(await readFile(helper.resolvedPath)));
  assert.deepEqual(Object.keys(helper.minimalEnvironment).sort(), [
    "SystemRoot",
    "WINDIR",
  ]);
});

test("kill deadline exhaustion commits SAFETY_VIOLATION", async () => {
  const item = await fixture("qaas-kill-deadline-");
  const authority = await openAuthority({
    pluginData: item.pluginData,
    projectRoot: item.project,
    pluginVersion: "0.1.0",
    create: true,
  });
  const state = {
    ...createInitialState({ projectId: authority.projectId }),
    phase: "EXECUTING",
    taskId: "task",
  };
  await authority.writeSigned("state/current.json", state, {
    expectedSequence: -1,
  });
  const next = await enterSafetyViolationForProcessDrift(
    { authority, projectRoot: item.project },
    state,
    "test-run",
    [{
      killDeadlineExceeded: true,
      integrity: {
        unexpected: [],
        invalidOutputDirectories: [],
      },
    }],
  );
  assert.equal(next.phase, "SAFETY_VIOLATION");
  assert.match(next.blocker, /hard kill deadline/u);
  const stored = await authority.readSigned("state/current.json");
  assert.equal(stored.payload.phase, "SAFETY_VIOLATION");
});

async function fixture(prefix = "qaas-self-test-") {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  const project = path.join(root, "project");
  const pluginData = path.join(root, "plugin-data");
  await mkdir(project);
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_PLUGIN_ROOT: pluginRoot,
    CLAUDE_PLUGIN_DATA: pluginData,
  };
  return { root, project, pluginData, env };
}

function sessionEvent(sessionId, prompt) {
  return {
    hook_event_name: "UserPromptSubmit",
    session_id: sessionId,
    prompt,
  };
}

function sessionHandleFrom(output) {
  const text = output?.hookSpecificOutput?.additionalContext ?? "";
  const match = text.match(/\bSession handle: ([a-f0-9]{48})\b/u);
  assert.ok(match, `missing session handle in ${text}`);
  return match[1];
}

function base64Json(value) {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

async function spawnCapture(program, args, options = {}) {
  const child = spawn(program, args, {
    windowsHide: true,
    shell: false,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode] = await once(child, "close");
  const result = {
    exitCode,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
  if (exitCode !== 0) {
    throw new Error(
      `${program} ${args.join(" ")} failed: ${result.stderr}`,
    );
  }
  return result;
}

async function spawnObserved(program, args, options = {}) {
  const child = spawn(program, args, {
    windowsHide: true,
    shell: false,
    ...options,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  const [exitCode, signal] = await once(child, "close");
  return {
    exitCode,
    signal,
    stdout: Buffer.concat(stdout).toString("utf8"),
    stderr: Buffer.concat(stderr).toString("utf8"),
  };
}

async function answerQuestion({
  env,
  sessionId,
  question,
  toolUseId,
  decision,
}) {
  const pre = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: { questions: [question] },
    },
    { env },
  );
  assert.equal(
    pre.hookSpecificOutput.permissionDecision,
    "allow",
    pre.hookSpecificOutput.permissionDecisionReason,
  );
  const post = await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "AskUserQuestion",
      tool_use_id: toolUseId,
      tool_input: { questions: [question] },
      tool_response: {
        answers: { [question.question]: decision },
      },
    },
    { env },
  );
  assert.equal(post.hookSpecificOutput.hookEventName, "PostToolUse");
  return post;
}

async function approveQuestion(options) {
  return answerQuestion({ ...options, decision: "Approve" });
}

test("canonical JSON, hashes, and destructive analyzers are deterministic", () => {
  assert.equal(canonicalJson({ z: 1, a: [true, null] }), '{"a":[true,null],"z":1}');
  assert.equal(
    canonicalDigest({ digest: "ignored", b: 2, a: 1 }),
    canonicalDigest({ a: 1, b: 2 }),
  );
  assert.throws(() => canonicalJson({ bad: Number.NaN }), /Non-finite/u);
  assert.equal(analyzeShellCommand("rm -rf ./cache").destructive, true);
  assert.equal(
    analyzeProcessVector("unknown-helper", ["--version"]).opaque,
    true,
  );
  assert.ok(
    destructiveAuthoredContentFindings(
      'Directory.Delete("cache", recursive: true);',
      "Hook.cs",
    ).length > 0,
  );
  assert.ok(
    destructiveAuthoredContentFindings(
      '<Target BeforeTargets="Build"><RemoveDir Directories="cache" /><Delete Files="state.json" /></Target>',
      "Project.targets",
    ).some((entry) => entry.reason === "MSBuild destructive task"),
  );
});

test("generic tool calls cannot impersonate the signed one-use source checkout helper", () => {
  const result = evaluatePhaseGate({
    phase: "DISCOVERING",
    actionClass: "source-checkout-write",
    hasApproval: true,
    hooksAttested: true,
  });
  assert.equal(result.allowed, false);
});

test("diagnosis supports exact repair and material-scope replanning transitions", () => {
  const initial = createInitialState({ projectId: "project" });
  const diagnosing = {
    ...initial,
    phase: "DIAGNOSING",
    sequence: 12,
    taskId: "task",
  };
  assert.equal(
    transitionState(diagnosing, "REPAIRING", {
      reason: "repair within exact scope",
    }).state.phase,
    "REPAIRING",
  );
  assert.equal(
    transitionState(diagnosing, "TASK_DISCOVERY", {
      reason: "material scope changed",
    }).state.phase,
    "TASK_DISCOVERY",
  );
});

test("signed event chain reconciles a durable valid tail after head-write loss", async () => {
  const item = await fixture("qaas-chain-");
  const authority = await openAuthority({
    pluginData: item.pluginData,
    projectRoot: item.project,
    pluginVersion: "0.1.0",
    create: true,
  });
  await authority.appendEvent("first", { value: 1 });
  const headPath = authority.resolveProtectedPath("events/head.json");
  const firstHead = await readFile(headPath, "utf8");
  await authority.appendEvent("second", { value: 2 });
  await writeFile(headPath, firstHead, "utf8");
  await authority.appendEvent("third", { value: 3 });
  const result = await authority.verifyEventChain();
  assert.equal(result.valid, true, result.errors.join("; "));
  assert.equal(result.count, 3);
});

test("project mirrors reject protected-state symlink and junction escapes", async () => {
  const item = await fixture("qaas-mirror-link-");
  const outside = path.join(item.root, "outside");
  const qaasDirectory = path.join(item.project, ".claude", "qaas");
  await mkdir(outside, { recursive: true });
  await mkdir(qaasDirectory, { recursive: true });
  await symlink(
    outside,
    path.join(qaasDirectory, "state"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const state = {
    ...createInitialState({ projectId: "mirror-project" }),
    phase: "PROJECT_READY",
    sequence: 1,
    contextDigest: sha256("approved-context"),
    updatedAt: new Date().toISOString(),
  };
  await assert.rejects(
    mirrorProjectState(item.project, state, "must not escape"),
    /symbolic link or junction/u,
  );
  await assert.rejects(
    access(path.join(outside, "current.json")),
    /ENOENT/u,
  );
});

test("reserved preauthorization cannot survive lease replacement", async () => {
  const item = await fixture("qaas-reserved-lease-");
  const authority = await openAuthority({
    pluginData: item.pluginData,
    projectRoot: item.project,
    pluginVersion: "0.1.0",
    create: true,
  });
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  const lease = (leaseId, sessionId, sequence) => ({
    schemaVersion: "1.0",
    projectId: authority.projectId,
    leaseId,
    sessionId,
    taskId: "task",
    phase: "IMPLEMENTING",
    eventSequence: 0,
    heartbeatAt: now.toISOString(),
    expiresAt,
    status: "active",
    takeoverOf: null,
    sequence,
  });
  await authority.writeSigned(
    "lease/current.json",
    lease("old-lease", "old-session", 0),
    { expectedSequence: -1 },
  );
  const event = {
    session_id: "old-session",
    tool_use_id: "reserved-tool",
    tool_name: "Write",
    tool_input: { file_path: "approved.txt", content: "safe" },
  };
  await authority.writeSigned(
    `preauthorizations/${sha256(event.tool_use_id)}.json`,
    {
      schemaVersion: "1.0",
      projectId: authority.projectId,
      pluginVersion: "0.1.0",
      tokenId: "reserved-token",
      toolUseId: event.tool_use_id,
      toolName: event.tool_name,
      toolInputDigest: toolInputDigest(event.tool_name, event.tool_input),
      actionClass: "project-write",
      approvalDigest: sha256("approval"),
      approvalId: "approval",
      approvalObjectId: "plan",
      sessionId: "old-session",
      leaseId: "old-lease",
      fingerprintStage: "taskBaseline",
      fingerprintDigest: sha256("fingerprint"),
      phase: "IMPLEMENTING",
      scope: { allowedPaths: ["approved.txt"] },
      status: "reserved",
      issuedAt: now.toISOString(),
      reservedAt: now.toISOString(),
      expiresAt,
      sequence: 1,
    },
    { expectedSequence: -1 },
  );
  await authority.writeSigned(
    "lease/current.json",
    lease("new-lease", "new-session", 1),
    { expectedSequence: 0 },
  );
  await assert.rejects(
    consumePreauthorization(authority, event),
    /active unexpired lease/u,
  );
});

test("MCP templates bind canonical logical slots even under non-query field names", async () => {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["searchText", "maximum"],
    properties: {
      searchText: { type: "string", maxLength: 100 },
      maximum: { type: "integer" },
    },
  };
  const search = {
    id: "docs-search",
    logicalOperation: "docs.search",
    server: "docs",
    tool: "find",
    classification: "read",
    inputSchema,
    schemaDigest: canonicalDigest(inputSchema),
    safeArgumentTemplate: {
      searchText: { $slot: "query", type: "string", maxLength: 100 },
      maximum: { $slot: "limit", type: "integer" },
    },
    outputLimitBytes: 4096,
    outputLimitItems: 3,
    probePassed: true,
    userApproved: true,
  };
  const readSchema = {
    type: "object",
    additionalProperties: false,
    required: ["page"],
    properties: { page: { type: "string" } },
  };
  const registry = {
    version: "1",
    approvedAt: new Date().toISOString(),
    capabilities: [
      search,
      {
        id: "docs-read",
        logicalOperation: "docs.read",
        server: "docs",
        tool: "read",
        classification: "read",
        inputSchema: readSchema,
        schemaDigest: canonicalDigest(readSchema),
        safeArgumentTemplate: {
          page: { $slot: "identifier", type: "string" },
        },
        outputLimitBytes: 4096,
        outputLimitItems: 1,
        probePassed: true,
        userApproved: true,
      },
    ],
  };
  assert.deepEqual(validateCapabilityRegistry(registry), {
    valid: true,
    errors: [],
  });
  let observed = null;
  const result = await resolveDocumentationQuery({
    query: "rate policy",
    sources: resolveDocumentationSources({
      env: { QAAS_DOCS_PRIMARY_URL: "" },
      capabilityRegistry: registry,
    }),
    callMcp: async (_capability, input) => {
      observed = input;
      return [{ id: "rate" }];
    },
  });
  assert.deepEqual(observed, { searchText: "rate policy", maximum: 3 });
  assert.equal(result.kind, "mcp-search");
  const destructive = analyzeMcpTool(
    {
      server: "db",
      tool: "query",
      input: { sql: "DROP TABLE evidence" },
    },
    null,
  );
  assert.equal(destructive.decision, "deny");
});

test("public documentation has a safe default and bounded URL search/failover", async (t) => {
  assert.equal(
    resolveDocumentationSources({ env: {} }).primaryUrl,
    DEFAULT_QAAS_DOCS_URL,
  );
  const server = http.createServer((request, response) => {
    if (request.url === "/bad/") {
      response.writeHead(503).end("no");
      return;
    }
    if (request.url === "/docs/") {
      response
        .writeHead(200, { "Content-Type": "text/html" })
        .end('<a href="rate-policy.html">Rate policy</a>');
      return;
    }
    response.writeHead(200).end("bounded page");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const result = await resolveDocumentationQuery({
    query: "rate policy",
    sources: {
      mcp: null,
      primaryUrl: `http://127.0.0.1:${port}/bad/`,
      secondaryUrl: `http://127.0.0.1:${port}/docs/`,
      zimPath: null,
    },
  });
  assert.equal(result.kind, "configured-url-search");
  assert.equal(result.candidateCount, 1);
  assert.equal(result.priorFailures[0].source, "primary");
  await assert.rejects(
    resolveDocumentationQuery({
      query: "bounds",
      sources: {
        mcp: null,
        primaryUrl: `http://127.0.0.1:${port}/docs/`,
        secondaryUrl: null,
        zimPath: null,
      },
      outputLimitBytes: Number.NaN,
    }),
    /outputLimitBytes/u,
  );
  await assert.rejects(
    resolveDocumentationQuery({
      query: "bounds",
      sources: {
        mcp: null,
        primaryUrl: `http://127.0.0.1:${port}/docs/`,
        secondaryUrl: null,
        zimPath: null,
      },
      timeoutMs: 60_001,
    }),
    /timeoutMs/u,
  );
});

test("documentation provenance binds every resolver selector and local ZIM bytes", async () => {
  const item = await fixture("qaas-docs-identity-");
  const firstZim = path.join(item.project, "current-docs.zim");
  const secondZim = path.join(item.project, "alternate-docs.zim");
  await writeFile(firstZim, "bounded documentation bytes", "utf8");
  await writeFile(secondZim, "bounded documentation bytes", "utf8");
  const env = {
    QAAS_DOCS_PRIMARY_URL: "https://primary.example.test/docs/",
    QAAS_DOCS_SECONDARY_URL: "https://secondary.example.test/docs/",
    QAAS_DOCS_ZIM_PATH: firstZim,
    QAAS_DOCS_MCP_URL: "https://mcp.example.test/read/",
    QAAS_DOCS_MCP_CREDENTIAL_ENV: "DOCS_READ_IDENTITY",
    DOCS_READ_IDENTITY: "available",
    DOCS_READ_IDENTITY_TWO: "available",
  };
  const expected = await attestDocumentationSourceConfiguration(env);
  assert.equal(expected.zim.state, "file");
  assert.equal(expected.zim.realPath, await realpath(firstZim));
  assert.equal(expected.zim.size, Buffer.byteLength("bounded documentation bytes"));
  assert.ok(expected.zim.sha256);
  assert.deepEqual(expected.configurationNames, [
    "QAAS_DOCS_PRIMARY_URL",
    "QAAS_DOCS_SECONDARY_URL",
    "QAAS_DOCS_ZIM_PATH",
    "QAAS_DOCS_MCP_URL",
    "QAAS_DOCS_MCP_CREDENTIAL_ENV",
  ]);
  assert.equal(expected.configurationNames.includes("QAAS_DOCS_URL"), false);
  await assertCurrentDocumentationSourceConfiguration(expected, env);
  const helperEvent = {
    hook_event_name: "PreToolUse",
    session_id: "docs-provenance-session",
    tool_name: "Bash",
    tool_use_id: "docs-provenance-read",
    tool_input: {
      command:
        `node "\${CLAUDE_PLUGIN_ROOT}/scripts/docs-read.mjs" ` +
        `--session-handle ${"a".repeat(48)} --query bounds`,
    },
  };
  const helperContext = hookEnvironment(helperEvent, {
    env: {
      ...item.env,
      ...env,
    },
  });
  const helperClassification = await classifyToolCall(
    helperEvent,
    helperContext,
  );
  assert.equal(helperClassification.actionClass, "configured-source-read");
  assert.deepEqual(
    helperClassification.sourceProvenance.configurationNames,
    expected.configurationNames,
  );
  assert.equal(
    helperClassification.sourceProvenance.configurationDigest,
    expected.digest,
  );
  assert.equal(
    helperClassification.sourceProvenance.documentationConfiguration.zim.sha256,
    expected.zim.sha256,
  );

  const selectorMutants = [
    {
      ...env,
      QAAS_DOCS_PRIMARY_URL: "https://changed-primary.example.test/docs/",
    },
    {
      ...env,
      QAAS_DOCS_SECONDARY_URL:
        "https://changed-secondary.example.test/docs/",
    },
    {
      ...env,
      QAAS_DOCS_MCP_URL: "https://changed-mcp.example.test/read/",
    },
    {
      ...env,
      QAAS_DOCS_MCP_CREDENTIAL_ENV: "DOCS_READ_IDENTITY_TWO",
    },
    {
      ...env,
      QAAS_DOCS_ZIM_PATH: secondZim,
    },
  ];
  for (const mutant of selectorMutants) {
    await assert.rejects(
      assertCurrentDocumentationSourceConfiguration(expected, mutant),
      /selector, endpoint, or local ZIM identity changed/u,
    );
  }
  await writeFile(firstZim, "mutated documentation bytes", "utf8");
  await assert.rejects(
    assertCurrentDocumentationSourceConfiguration(expected, env),
    /selector, endpoint, or local ZIM identity changed/u,
  );
  const absent = await attestDocumentationSourceConfiguration({});
  assert.equal(absent.zim.state, "absent");
  assert.equal(absent.primary.effective.urlDigest, sha256(DEFAULT_QAAS_DOCS_URL));
});

test("configured source provenance never persists query values", async (t) => {
  let observedAuthorization = null;
  const server = http.createServer((request, response) => {
    observedAuthorization = request.headers.authorization ?? null;
    response.writeHead(200, { "Content-Type": "text/plain" }).end("module");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const port = server.address().port;
  const result = await readConfiguredSource({
    source: "modules",
    relativeUrl: "items?id=public-name",
    env: { QAAS_MODULES_REPO_URL: `http://127.0.0.1:${port}/` },
  });
  assert.equal(result.provenance.identifier.includes("?"), false);
  assert.deepEqual(result.provenance.queryParameterNames, ["id"]);
  const loopbackToken = ["loopback", "only", "test", "token"].join("-");
  const loopbackCredentialed = await readConfiguredSource({
    source: "modules",
    relativeUrl: "items",
    env: {
      QAAS_MODULES_REPO_URL: `http://127.0.0.1:${port}/`,
      QAAS_MODULES_CREDENTIAL_ENV: "MODULE_TEST_TOKEN",
      MODULE_TEST_TOKEN: loopbackToken,
    },
  });
  assert.equal(loopbackCredentialed.provenance.credentialEnv, "MODULE_TEST_TOKEN");
  assert.equal(observedAuthorization, `Bearer ${loopbackToken}`);
  await assert.rejects(
    readConfiguredSource({
      source: "modules",
      relativeUrl: "items",
      env: {
        QAAS_MODULES_REPO_URL: "http://modules.example.test/",
        QAAS_MODULES_CREDENTIAL_ENV: "MODULE_TEST_TOKEN",
        MODULE_TEST_TOKEN: "plaintext-remote-token",
      },
    }),
    /must use HTTPS or an explicit loopback/u,
  );
  await assert.rejects(
    readConfiguredSource({
      source: "modules",
      relativeUrl: "items",
      credentialEnv: "GITHUB_TOKEN",
      env: {
        QAAS_MODULES_REPO_URL: `http://127.0.0.1:${port}/`,
        GITHUB_TOKEN: "model-selected-secret",
      },
    }),
    /must match user configuration/u,
  );
  await assert.rejects(
    readConfiguredSource({
      source: "common-hooks",
      relativeUrl: "items?id=AbCdEfGhIjKlMnOpQrStUvWx123456",
      env: {
        QAAS_COMMON_HOOKS_REPO_URL: `http://127.0.0.1:${port}/`,
      },
    }),
    /secret-like query value/u,
  );
});

test("source checkout is exact, one-use, bare, and readable only through bounds", { timeout: 60_000 }, async (t) => {
  const git = await discoverProgram("git");
  if (!git.available) {
    t.skip("git is unavailable");
    return;
  }
  const item = await fixture("qaas-source-checkout-");
  const sourceRepository = path.join(item.root, "reference-source");
  await mkdir(sourceRepository);
  await spawnCapture(
    git.resolvedPath,
    ["init", "--initial-branch", "main"],
    { cwd: sourceRepository, env: item.env },
  );
  await spawnCapture(
    git.resolvedPath,
    ["config", "user.email", "qaas-self-test@example.invalid"],
    { cwd: sourceRepository, env: item.env },
  );
  await spawnCapture(
    git.resolvedPath,
    ["config", "user.name", "QaaS Self Test"],
    { cwd: sourceRepository, env: item.env },
  );
  await writeFile(
    path.join(sourceRepository, "style.md"),
    "# Reference style\n\nBounded source evidence.\n",
    "utf8",
  );
  await writeFile(
    path.join(sourceRepository, "large.txt"),
    "bounded-content\n".repeat(1_024),
    "utf8",
  );
  await writeFile(
    path.join(sourceRepository, "binary.bin"),
    Buffer.from([0x51, 0x61, 0x61, 0x53, 0x00, 0xff]),
  );
  await spawnCapture(git.resolvedPath, ["add", "style.md", "large.txt", "binary.bin"], {
    cwd: sourceRepository,
    env: item.env,
  });
  await spawnCapture(git.resolvedPath, ["commit", "-m", "reference"], {
    cwd: sourceRepository,
    env: item.env,
  });
  const commit = (
    await spawnCapture(git.resolvedPath, ["rev-parse", "HEAD"], {
      cwd: sourceRepository,
      env: item.env,
    })
  ).stdout.trim();
  item.env.QAAS_REFERENCE_PROJECT_REPO_URL =
    pathToFileURL(sourceRepository).toString();
  const untrustedGitHome = path.join(item.root, "untrusted-git-home");
  await mkdir(untrustedGitHome);
  await writeFile(
    path.join(untrustedGitHome, ".gitconfig"),
    `[url "file:///definitely-missing/"]\n\tinsteadOf = ${item.env.QAAS_REFERENCE_PROJECT_REPO_URL}\n[http]\n\tsslVerify = false\n`,
    "utf8",
  );
  item.env.HOME = untrustedGitHome;
  const sessionId = "source-checkout-session";
  const activated = await handleSessionEvent(
    sessionEvent(sessionId, "/qaas:onboard"),
    { env: item.env },
  );
  const handle = sessionHandleFrom(activated);
  await runWorkflowAuthority(
    ["discover", "--session-handle", handle],
    item.env,
  );
  const manifest = {
    schemaVersion: "1.0",
    checkoutId: "style-reference",
    createdAt: new Date().toISOString(),
    source: "reference-project",
    repositoryUrl: item.env.QAAS_REFERENCE_PROJECT_REPO_URL,
    ref: "main",
    commit,
    transport: "git",
    credentialEnv: null,
    tlsVerify: true,
    tlsRiskAcknowledgement: null,
  };
  const computed = { ...manifest };
  computed.digest = canonicalDigest(computed);
  assert.equal(
    validateSourceCheckout(computed, item.env).valid,
    true,
  );
  await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "source-checkout",
      "--content-base64",
      base64Json(manifest),
    ],
    item.env,
  );
  const review = await runWorkflowAuthority(
    [
      "prepare",
      "--session-handle",
      handle,
      "--kind",
      "source-checkout",
    ],
    item.env,
  );
  const reviewDocument = JSON.parse(review.review.canonicalDocument);
  assert.equal(reviewDocument.document.commit, commit);
  assert.equal(reviewDocument.cloneBinding.actionClass, "source-checkout-write");
  await approveQuestion({
    env: item.env,
    sessionId,
    question: review.question,
    toolUseId: "approve-source-checkout",
  });
  const checkedOut = await runSourceCheckout(
    [
      "--session-handle",
      handle,
      "--checkout-id",
      "style-reference",
    ],
    item.env,
  );
  assert.equal(checkedOut.commit, commit);
  assert.equal(checkedOut.approvalConsumed, true);
  const read = await runSourceRead(
    [
      "--session-handle",
      handle,
      "--source",
      "reference-project",
      "--checkout-id",
      "style-reference",
      "--path",
      "style.md",
      "--output-limit-bytes",
      "4096",
    ],
    item.env,
  );
  assert.match(read.excerpt, /Bounded source evidence/u);
  assert.equal(read.provenance.commit, commit);
  const inventory = await runSourceRead(
    [
      "--session-handle",
      handle,
      "--source",
      "reference-project",
      "--checkout-id",
      "style-reference",
      "--list",
      "--item-limit",
      "10",
    ],
    item.env,
  );
  assert.deepEqual(
    inventory.paths,
    ["binary.bin", "large.txt", "style.md"],
  );
  await assert.rejects(
    runSourceRead(
      [
        "--session-handle",
        handle,
        "--source",
        "reference-project",
        "--checkout-id",
        "style-reference",
        "--path",
        "missing.md",
      ],
      item.env,
    ),
    /file read failed/u,
  );
  await assert.rejects(
    runSourceRead(
      [
        "--session-handle",
        handle,
        "--source",
        "reference-project",
        "--checkout-id",
        "style-reference",
        "--path",
        "large.txt",
        "--output-limit-bytes",
        "64",
      ],
      item.env,
    ),
    /exceeded its bound/u,
  );
  await assert.rejects(
    runSourceRead(
      [
        "--session-handle",
        handle,
        "--source",
        "reference-project",
        "--checkout-id",
        "style-reference",
        "--path",
        "binary.bin",
      ],
      item.env,
    ),
    /binary or not valid UTF-8/u,
  );
  await assert.rejects(
    runSourceCheckout(
      [
        "--session-handle",
        handle,
        "--checkout-id",
        "style-reference",
      ],
      item.env,
    ),
    /approval is stale|already been consumed/u,
  );
  assert.deepEqual(await readdir(item.project), []);
});

test("bounded Streamable HTTP MCP uses the exact live signed tool schema", async (t) => {
  assert.throws(
    () =>
      describeMcpTransport({
        QAAS_DOCS_MCP_URL: "http://docs.example.test/mcp",
        QAAS_DOCS_MCP_CREDENTIAL_ENV: "DOCS_TOKEN",
      }),
    /require HTTPS or an explicit loopback/u,
  );
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["searchText"],
    properties: { searchText: { type: "string" } },
  };
  const capability = {
    id: "offline-search",
    logicalOperation: "docs.search",
    server: "openzim",
    tool: "zim_search",
    classification: "read",
    inputSchema,
    schemaDigest: canonicalDigest(inputSchema),
    safeArgumentTemplate: {
      searchText: { $slot: "query", type: "string" },
    },
    outputLimitBytes: 4096,
    outputLimitItems: 5,
    probePassed: true,
    userApproved: true,
  };
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    response.setHeader("mcp-session-id", "bounded-session");
    if (message.method === "notifications/initialized") {
      response.writeHead(202).end();
    } else if (message.method === "initialize") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: { protocolVersion: "2025-03-26", capabilities: {} },
        }),
      );
    } else if (message.method === "tools/list") {
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{ name: "zim_search", inputSchema }],
          },
        }),
      );
    } else {
      assert.equal(
        request.headers.authorization,
        ["Bearer", "local-secret-value"].join(" "),
      );
      response.writeHead(200, { "Content-Type": "application/json" }).end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({ results: [{ path: "qaas/index.html" }] }),
              },
            ],
          },
        }),
      );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const mcpEnv = {
      QAAS_DOCS_MCP_URL: `http://127.0.0.1:${server.address().port}/mcp`,
      QAAS_DOCS_MCP_CREDENTIAL_ENV: "OPENZIM_TEST_TOKEN",
      OPENZIM_TEST_TOKEN: "local-secret-value",
  };
  const caller = createStreamableMcpCaller({
    env: mcpEnv,
    approvedTransport: describeMcpTransport(mcpEnv),
  });
  const result = await caller(capability, { searchText: "configuration" });
  assert.deepEqual(result, {
    results: [{ path: "qaas/index.html" }],
  });
});

test("unactivated user-scope hooks are strict no-ops with zero project writes", async () => {
  const item = await fixture("qaas-inactive-");
  const syntheticCredential = ["glpat", "AbCdEfGhIjKlMnOp"].join("-");
  const before = await readdir(item.project);
  assert.deepEqual(
    await handlePreToolUse(
      {
        hook_event_name: "PreToolUse",
        session_id: "inactive",
        tool_name: "Bash",
        tool_use_id: "inactive-tool",
        tool_input: { command: "rm -rf unrelated" },
      },
      { env: item.env },
    ),
    {},
  );
  assert.deepEqual(
    await handleSessionEvent(
      sessionEvent("inactive", `token=${syntheticCredential}`),
      { env: item.env },
    ),
    {},
  );
  assert.deepEqual(
    await handleSessionEvent(
      {
        hook_event_name: "ConfigChange",
        session_id: "inactive",
        source: "skills",
        content: "disableAllHooks",
      },
      { env: item.env },
    ),
    {},
  );
  assert.deepEqual(
    await handlePostToolUse(
      {
        hook_event_name: "PostToolUse",
        session_id: "inactive",
        tool_name: "Bash",
        tool_use_id: "inactive-tool",
        tool_input: { command: "anything" },
        tool_response: { stdout: `token=${syntheticCredential}` },
      },
      { env: item.env },
    ),
    {},
  );
  assert.deepEqual(await readdir(item.project), before);
});

test("activation is explicit and session handles cannot leave exact helper fields", async () => {
  const item = await fixture("qaas-activation-");
  const activated = await handleSessionEvent(
    sessionEvent("active-session", "/qaas:onboard"),
    { env: item.env },
  );
  const handle = sessionHandleFrom(activated);
  assert.deepEqual(await readdir(item.project), []);
  const denied = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Write",
      tool_use_id: "leak",
      tool_input: { file_path: "leak.txt", content: `handle=${handle}` },
    },
    { env: item.env },
  );
  assert.equal(denied.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    denied.hookSpecificOutput.permissionDecisionReason,
    /bearer capability/u,
  );
  const encodedLeak = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Write",
      tool_use_id: "encoded-leak",
      tool_input: {
        file_path: "encoded.txt",
        content: Buffer.from(handle, "utf8").toString("base64"),
      },
    },
    { env: item.env },
  );
  assert.equal(encodedLeak.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    encodedLeak.hookSpecificOutput.permissionDecisionReason,
    /bearer capability/u,
  );
  const reversedLeak = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Write",
      tool_use_id: "reversed-leak",
      tool_input: {
        file_path: "reversed.txt",
        content: [...handle].reverse().join(""),
      },
    },
    { env: item.env },
  );
  assert.equal(reversedLeak.hookSpecificOutput.permissionDecision, "deny");
  const fragmentedLeak = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Write",
      tool_use_id: "fragmented-leak",
      tool_input: {
        file_path: "fragmented.txt",
        content: [
          handle.slice(0, 12),
          handle.slice(12, 29),
          handle.slice(29),
        ],
      },
    },
    { env: item.env },
  );
  assert.equal(fragmentedLeak.hookSpecificOutput.permissionDecision, "deny");
  const destructiveWrite = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Write",
      tool_use_id: "destructive-content",
      tool_input: {
        file_path: "Hook.cs",
        content: 'System.IO.Directory.Delete("state", true);',
      },
    },
    { env: item.env },
  );
  assert.equal(
    destructiveWrite.hookSpecificOutput.permissionDecision,
    "deny",
  );
  assert.match(
    destructiveWrite.hookSpecificOutput.permissionDecisionReason,
    /destructive operation/u,
  );
  await writeFile(path.join(item.project, "existing.txt"), "whole file", "utf8");
  const wholesaleEdit = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Edit",
      tool_use_id: "wholesale-edit",
      tool_input: {
        file_path: "existing.txt",
        old_string: "whole file",
        new_string: "replacement",
      },
    },
    { env: item.env },
  );
  assert.equal(wholesaleEdit.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    wholesaleEdit.hookSpecificOutput.permissionDecisionReason,
    /Whole-file replacement/u,
  );
  const multiQuestion = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "AskUserQuestion",
      tool_use_id: "too-many",
      tool_input: {
        questions: [
          { question: "one", header: "One", options: [], multiSelect: false },
          { question: "two", header: "Two", options: [], multiSelect: false },
        ],
      },
    },
    { env: item.env },
  );
  assert.equal(multiQuestion.hookSpecificOutput.permissionDecision, "deny");
  assert.match(
    multiQuestion.hookSpecificOutput.permissionDecisionReason,
    /exactly one/u,
  );
  const allowed = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: "active-session",
      tool_name: "Bash",
      tool_use_id: "helper",
      tool_input: {
        command:
          `node "\${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" ` +
          `status --session-handle ${handle}`,
      },
    },
    { env: item.env },
  );
  assert.equal(allowed.hookSpecificOutput.permissionDecision, "allow");
});

test("ordinary prose cannot activate an unonboarded project", async () => {
  for (const prompt of [
    "activate qaas",
    "activate qaas for this project",
    "activate qaas for the current project",
  ]) {
    const item = await fixture("qaas-no-prose-activation-");
    assert.deepEqual(
      await handleSessionEvent(sessionEvent("inactive-session", prompt), {
        env: item.env,
      }),
      {},
    );
    await assert.rejects(access(item.pluginData), { code: "ENOENT" });
    assert.deepEqual(await readdir(item.project), []);
  }
});

test("exact onboarding deterministically recovers BLOCKED and STALE state", async () => {
  const item = await fixture("qaas-recovery-");
  const sessionId = "recovery-session";
  const activated = await handleSessionEvent(
    sessionEvent(sessionId, "/qaas:onboard"),
    { env: item.env },
  );
  const handle = sessionHandleFrom(activated);
  await runWorkflowAuthority(
    ["discover", "--session-handle", handle],
    item.env,
  );
  const context = await runtimeContext(item.env);
  let state = (
    await context.authority.readSigned("state/current.json")
  ).payload;
  state = await commitTransition(context.authority, state, "BLOCKED", {
    reason: "Synthetic blocked recovery fixture",
    patch: {
      taskId: "blocked-task",
      approvedDigests: { plan: sha256("blocked-plan") },
      fingerprints: { taskBaseline: sha256("blocked-fingerprint") },
      completedWork: ["stale work"],
      remainingWork: ["blocked work"],
      evidencePaths: ["old/evidence.jsonl"],
      blocker: "synthetic blocker",
    },
  });
  await handleSessionEvent(
    sessionEvent(sessionId, "/qaas:onboard"),
    { env: item.env },
  );
  state = (
    await context.authority.readSigned("state/current.json")
  ).payload;
  assert.equal(state.phase, "DISCOVERING");
  assert.equal(state.taskId, null);
  assert.deepEqual(state.approvedDigests, {});
  assert.deepEqual(state.fingerprints, {});
  assert.deepEqual(state.completedWork, []);
  assert.deepEqual(state.remainingWork, []);
  assert.deepEqual(state.evidencePaths, []);
  assert.equal(state.blocker, null);

  state = await commitTransition(context.authority, state, "BLOCKED", {
    reason: "Prepare stale recovery fixture",
  });
  state = await commitTransition(context.authority, state, "TASK_DISCOVERY", {
    reason: "Synthetic task state",
    patch: {
      taskId: "stale-task",
      fingerprints: { onboardingFingerprint: sha256("old-project") },
    },
  });
  await commitTransition(context.authority, state, "STALE", {
    reason: "Synthetic project drift",
    patch: { blocker: "project drift" },
  });
  await handleSessionEvent(
    sessionEvent(sessionId, "/qaas:onboard"),
    { env: item.env },
  );
  state = (
    await context.authority.readSigned("state/current.json")
  ).payload;
  assert.equal(state.phase, "DISCOVERING");
  assert.equal(state.taskId, null);
  assert.deepEqual(state.approvedDigests, {});
  assert.deepEqual(state.fingerprints, {});
  assert.equal(state.blocker, null);
});

test(
  "validator and doctor operate from a plugin-only installed cache",
  { timeout: 60_000 },
  async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "qaas-installed-cache-"),
    );
    const installedPluginRoot = path.join(
      root,
      "cache",
      "qaas-plugin",
      "qaas",
      "0.1.0",
    );
    await mkdir(path.dirname(installedPluginRoot), { recursive: true });
    await cp(pluginRoot, installedPluginRoot, { recursive: true });

    const unrelatedAncestor = path.resolve(installedPluginRoot, "..", "..");
    await writeFile(
      path.join(unrelatedAncestor, "version.json"),
      '{"version":"99.0.0"}\n',
      "utf8",
    );
    await writeFile(
      path.join(unrelatedAncestor, "package.json"),
      '{"version":"99.0.0"}\n',
      "utf8",
    );
    await mkdir(path.join(unrelatedAncestor, ".claude-plugin"));
    await writeFile(
      path.join(unrelatedAncestor, ".claude-plugin", "marketplace.json"),
      '{"metadata":{"version":"99.0.0"},"plugins":[]}\n',
      "utf8",
    );

    const cacheKey = `${Date.now()}-${Math.random()}`;
    const installedValidator = await import(
      `${pathToFileURL(
        path.join(installedPluginRoot, "scripts", "validate-plugin.mjs"),
      ).href}?cache=${cacheKey}`
    );
    const validation = await installedValidator.validatePlugin();
    assert.equal(validation.valid, true, validation.errors.join("; "));
    assert.equal(validation.layout, "installed-plugin-cache");
    assert.equal(validation.sourceRepositoryChecksApplied, false);
    assert.equal(validation.repositoryRoot, null);
    assert.equal(validation.pluginRoot, installedPluginRoot);
    assert.equal(validation.version, "0.1.0");

    const projectRoot = path.join(root, "project");
    await mkdir(projectRoot);
    const installedDoctor = await import(
      `${pathToFileURL(
        path.join(installedPluginRoot, "scripts", "doctor.mjs"),
      ).href}?cache=${cacheKey}`
    );
    const doctor = await installedDoctor.runDoctor({
      env: {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: installedPluginRoot,
        CLAUDE_PROJECT_DIR: projectRoot,
        CLAUDE_PLUGIN_DATA: path.join(root, "plugin-data"),
        QAAS_TRUSTED_NODE24: process.execPath,
      },
      projectRoot,
      pluginRoot: installedPluginRoot,
    });
    assert.equal(doctor.plugin.valid, true, doctor.plugin.errors.join("; "));
    assert.equal(doctor.plugin.layout, "installed-plugin-cache");
    assert.equal(doctor.plugin.pluginRoot, installedPluginRoot);
    assert.equal(doctor.contextBudget.valid, true);
    assert.equal(doctor.hooks.own.valid, true);
    assert.equal(doctor.hookShell.actualProcessProbe, true);
    assert.equal(doctor.hookShell.available, true, doctor.hookShell.error);
  },
);

test("source repository layout retains marketplace/version checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-source-layout-"));
  const sourcePluginRoot = path.join(root, "plugins", "qaas");
  await mkdir(path.dirname(sourcePluginRoot), { recursive: true });
  await cp(pluginRoot, sourcePluginRoot, { recursive: true });
  await writeFile(
    path.join(root, "version.json"),
    '{"version":"9.9.9"}\n',
    "utf8",
  );
  await writeFile(
    path.join(root, "package.json"),
    '{"version":"9.9.9"}\n',
    "utf8",
  );
  await mkdir(path.join(root, ".claude-plugin"));
  await writeFile(
    path.join(root, ".claude-plugin", "marketplace.json"),
    JSON.stringify({
      metadata: { version: "9.9.9" },
      plugins: [{
        name: "qaas",
        source: "./plugins/qaas",
        version: "9.9.9",
      }],
    }),
    "utf8",
  );
  const validation = await validatePlugin({
    scriptDirectory: path.join(sourcePluginRoot, "scripts"),
  });
  assert.equal(validation.layout, "source-repository");
  assert.equal(validation.sourceRepositoryChecksApplied, true);
  assert.equal(validation.valid, false);
  assert.match(validation.errors.join("; "), /versions must match/u);
});

test("direct validator recognizes an extracted packaged marketplace bundle", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-bundle-layout-"));
  const bundledPluginRoot = path.join(root, "plugins", "qaas");
  await mkdir(path.dirname(bundledPluginRoot), { recursive: true });
  await cp(pluginRoot, bundledPluginRoot, { recursive: true });
  await mkdir(path.join(root, ".claude-plugin"));
  await cp(
    path.resolve(pluginRoot, "..", "..", ".claude-plugin", "marketplace.json"),
    path.join(root, ".claude-plugin", "marketplace.json"),
  );
  await cp(
    path.resolve(pluginRoot, "..", "..", "version.json"),
    path.join(root, "version.json"),
  );
  const validation = await validatePlugin({
    scriptDirectory: path.join(bundledPluginRoot, "scripts"),
  });
  assert.equal(validation.valid, true, validation.errors.join("; "));
  assert.equal(validation.layout, "packaged-marketplace-bundle");
  assert.equal(validation.sourceRepositoryChecksApplied, false);
  assert.equal(validation.packagedBundleChecksApplied, true);

  const direct = await spawnCapture(
    process.execPath,
    [path.join(bundledPluginRoot, "scripts", "validate-plugin.mjs")],
    { cwd: root },
  );
  assert.equal(direct.exitCode, 0, direct.stderr || direct.stdout);
  const directResult = JSON.parse(direct.stdout);
  assert.equal(directResult.valid, true);
  assert.equal(directResult.layout, "packaged-marketplace-bundle");
});

test("hook inventory includes target events and ConfigChange skills", async () => {
  const validation = await validateOwnHookConfiguration(pluginRoot);
  assert.deepEqual(validation, { valid: true, errors: [] });
  const hooks = JSON.parse(
    await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  );
  assert.match(hooks.hooks.ConfigChange[0].matcher, /skills/u);
  assert.ok(hooks.hooks.PostCompact);
  assert.ok(hooks.hooks.PostToolUseFailure);
  const launcher = await readFile(
    path.join(pluginRoot, "scripts", "hook-launcher.sh"),
  );
  assert.equal(launcher.includes(0x0d), false);
  const possibleSourceRoot = path.resolve(pluginRoot, "..", "..");
  try {
    await access(path.join(possibleSourceRoot, "package.json"));
    const attributes = await readFile(
      path.join(possibleSourceRoot, ".gitattributes"),
      "utf8",
    );
    assert.match(attributes, /^\*\.sh text eol=lf$/mu);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
});

test("hook launcher maps every launcher and Node failure to exit 2", async (t) => {
  const shell =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
      : "/bin/sh";
  try {
    await access(shell);
  } catch {
    t.skip("the mandatory target hook shell is unavailable");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-launcher-fail-"));
  const scripts = path.join(root, "scripts");
  const project = path.join(root, "project");
  const pluginData = path.join(root, "plugin-data");
  await mkdir(scripts);
  await mkdir(project);
  await mkdir(pluginData);
  const launcher = path.join(scripts, "hook-launcher.sh");
  const pretool = path.join(scripts, "pretool-safety.mjs");
  await cp(path.join(pluginRoot, "scripts", "hook-launcher.sh"), launcher);
  await writeFile(
    pretool,
    'process.stderr.write("synthetic Node hook failure\\n"); process.exit(7);\n',
    "utf8",
  );
  const env = {
    ...process.env,
    CLAUDE_PROJECT_DIR: project,
    CLAUDE_PLUGIN_DATA: pluginData,
    QAAS_TRUSTED_NODE24: process.execPath,
  };
  const cases = [
    { label: "missing argument", args: [launcher] },
    {
      label: "too many arguments",
      args: [launcher, pretool, pretool],
    },
    {
      label: "unknown script",
      args: [launcher, path.join(scripts, "unknown.mjs")],
    },
    {
      label: "script outside launcher directory",
      args: [
        launcher,
        path.join(pluginRoot, "scripts", "pretool-safety.mjs"),
      ],
    },
    {
      label: "missing script directory",
      args: [
        launcher,
        path.join(root, "missing", "pretool-safety.mjs"),
      ],
    },
    { label: "Node hook process failure", args: [launcher, pretool] },
  ];
  for (const scenario of cases) {
    const result = await spawnObserved(shell, scenario.args, {
      cwd: project,
      env,
    });
    assert.equal(
      result.exitCode,
      2,
      `${scenario.label}: exit=${result.exitCode}; stderr=${result.stderr}`,
    );
    assert.equal(result.signal, null, scenario.label);
  }
});

test("fixed hook launcher ignores project-local Node PATH shadows", async (t) => {
  const item = await fixture("qaas-launcher-shadow-");
  const shell =
    process.platform === "win32"
      ? "C:\\Program Files\\Git\\usr\\bin\\sh.exe"
      : "/bin/sh";
  try {
    await access(shell);
  } catch {
    t.skip("the target Claude hook shell is unavailable");
    return;
  }
  const shadow = path.join(item.project, "node");
  await writeFile(shadow, "#!/bin/sh\nexit 99\n", "utf8");
  await chmod(shadow, 0o755);
  if (process.platform === "win32") {
    await writeFile(
      path.join(item.project, "node.cmd"),
      "@echo off\r\nexit /b 99\r\n",
      "utf8",
    );
  }
  const hooks = JSON.parse(
    await readFile(path.join(pluginRoot, "hooks", "hooks.json"), "utf8"),
  );
  const command = hooks.hooks.PreToolUse[0].hooks[0].command.replaceAll(
    "${CLAUDE_PLUGIN_ROOT}",
    pluginRoot,
  );
  const child = spawn(shell, ["-c", command], {
    cwd: item.project,
    env: {
      ...item.env,
      PATH: `${item.project}${path.delimiter}${item.env.PATH ?? ""}`,
      QAAS_TRUSTED_NODE24: process.execPath,
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  child.stdin.end(
    JSON.stringify({
      hook_event_name: "PreToolUse",
      session_id: "launcher-session",
      tool_name: "Read",
      tool_use_id: "launcher-read",
      tool_input: { file_path: path.join(item.project, "missing.txt") },
    }),
  );
  const [exitCode] = await once(child, "close");
  assert.equal(
    exitCode,
    0,
    Buffer.concat(stderr).toString("utf8"),
  );
  assert.deepEqual(
    JSON.parse(Buffer.concat(stdout).toString("utf8")),
    {},
  );
});

test("approved workflow reaches build, template, and verified execution", { timeout: 120_000 }, async (t) => {
  const item = await fixture("qaas-e2e-");
  const dotnet = await discoverProgram("dotnet", {
    cwd: item.project,
    env: item.env,
  });
  if (!dotnet.available) {
    t.skip("local .NET SDK is unavailable");
    return;
  }
  const sdkProbe = await runProcess({
    program: dotnet.resolvedPath,
    args: ["--version"],
    cwd: item.project,
    timeoutMs: 5000,
    outputLimitBytes: 1024,
    actionClass: "ordinary-read",
    approvedExecutablePath: dotnet.resolvedPath,
    expectedExecutableDigest: dotnet.executableDigest,
  });
  const sdkMajor = Number.parseInt(sdkProbe.stdout, 10);
  assert.ok(Number.isSafeInteger(sdkMajor) && sdkMajor >= 8);
  await writeFile(
    path.join(item.project, "SelfTest.csproj"),
    `<Project Sdk="Microsoft.NET.Sdk"><PropertyGroup><OutputType>Exe</OutputType><TargetFramework>net${sdkMajor}.0</TargetFramework></PropertyGroup></Project>`,
    "utf8",
  );
  await writeFile(
    path.join(item.project, "Program.cs"),
    `if (args.Length > 1 && args[1] == "hang")
{
    System.Threading.Thread.Sleep(System.Threading.Timeout.Infinite);
}
else if (args.Length > 0 && args[0] == "template")
{
    System.IO.Directory.CreateDirectory("rendered");
    System.IO.File.WriteAllText("rendered/template.json", "{\\"status\\":\\"ok\\"}");
    System.Console.WriteLine("qaas-template-ok");
}
else
{
    System.IO.Directory.CreateDirectory("allure-results");
    System.IO.File.WriteAllText("allure-results/report.json", "{\\"passed\\":true}");
    System.Console.WriteLine("qaas-self-test-ok");
}`,
    "utf8",
  );
  const readinessInputDirectory = path.join(
    item.project,
    "readiness-inputs",
  );
  await mkdir(readinessInputDirectory);
  const readinessInputContents = new Map();
  for (const domain of readinessDomains) {
    const content = `Bounded project evidence for ${domain}.\n`;
    readinessInputContents.set(domain, content);
    await writeFile(
      path.join(readinessInputDirectory, `${domain}.txt`),
      content,
      "utf8",
    );
  }
  const sessionId = "e2e-session";
  const activated = await handleSessionEvent(
    sessionEvent(sessionId, "/qaas:onboard"),
    { env: item.env },
  );
  const handle = sessionHandleFrom(activated);
  const discovery = await runWorkflowAuthority(
    ["discover", "--session-handle", handle],
    item.env,
  );
  for (const topic of coreTopics) {
    const content = `# ${topic}\n\nEvidence for ${topic}.\n`;
    await runWorkflowAuthority(
      [
        "stage-context",
        "--session-handle",
        handle,
        "--path",
        `.claude/qaas/${topic}`,
        "--content-base64",
        Buffer.from(content).toString("base64"),
      ],
      item.env,
    );
  }
  await runWorkflowAuthority(
    [
      "stage-context",
      "--session-handle",
      handle,
      "--path",
      ".claude/qaas/custom/team/contract.md",
      "--content-base64",
      Buffer.from("# Team contract\n\nCustom evidence.\n").toString("base64"),
    ],
    item.env,
  );
  await assert.rejects(
    runWorkflowAuthority(
      [
        "stage-context",
        "--session-handle",
        handle,
        "--path",
        ".claude/qaas/state/escape.md",
        "--content-base64",
        Buffer.from("blocked").toString("base64"),
      ],
      item.env,
    ),
    /allowlist/u,
  );
  const finalized = await runWorkflowAuthority(
    ["finalize-context", "--session-handle", handle],
    item.env,
  );
  assert.equal(finalized.topicCount, coreTopics.length + 1);
  const context = await runtimeContext(item.env);
  const allureInputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["path"],
    properties: {
      path: { const: "allure-results/report.json" },
    },
  };
  const capabilityRegistry = {
    version: "self-test-1",
    approvedAt: new Date().toISOString(),
    capabilities: [
      {
        id: "allure-report-read",
        logicalOperation: "observability.allure",
        server: "qaas-allure",
        tool: "read-report",
        classification: "read",
        inputSchema: allureInputSchema,
        schemaDigest: canonicalDigest(allureInputSchema),
        safeArgumentTemplate: { path: "allure-results/report.json" },
        readOnlyQueryPolicy: "exact-template",
        outputLimitBytes: 16_384,
        outputLimitItems: 100,
        probePassed: true,
        userApproved: true,
      },
    ],
  };
  await runWorkflowAuthority(
    [
      "stage-capabilities",
      "--session-handle",
      handle,
      "--content-base64",
      base64Json(capabilityRegistry),
    ],
    item.env,
  );
  const capabilityReview = await runWorkflowAuthority(
    [
      "prepare",
      "--session-handle",
      handle,
      "--kind",
      "capabilities",
    ],
    item.env,
  );
  await approveQuestion({
    env: item.env,
    sessionId,
    question: capabilityReview.question,
    toolUseId: "approve-e2e-capabilities",
  });
  await runWorkflowAuthority(
    ["commit-capabilities", "--session-handle", handle],
    item.env,
  );
  const projectSources = new Map();
  for (const domain of readinessDomains) {
    const relativePath = `readiness-inputs/${domain}.txt`;
    const content = readinessInputContents.get(domain);
    const readProofs = [
      {
        path: relativePath,
        size: Buffer.byteLength(content, "utf8"),
        sha256: sha256(content),
      },
    ];
    const discoveryEvidence = createEvidenceEvent({
      projectId: context.authority.projectId,
      taskId: null,
      type: "readiness-discovery",
      actionClass: "ordinary-read",
      status: "success",
      tool: "Read",
      inputDigest: sha256({ domain, relativePath }),
      outputDigest: sha256({ domain, content }),
      paths: [relativePath],
      details: {
        provenance: {
          category: "project",
          locators: [relativePath],
          locatorDigest: sha256(readProofs),
          readProofs,
          immutableLocator: true,
        },
      },
    });
    await recordEvidence(context.authority, discoveryEvidence);
    projectSources.set(domain, {
      kind: "project",
      identifier: `evidence:${discoveryEvidence.digest}`,
      digest: discoveryEvidence.digest,
    });
  }
  const packageSource = {
    kind: "package",
    identifier: `package-snapshot:${discovery.packageSnapshotDigest}`,
    digest: discovery.packageSnapshotDigest,
  };
  const claimedSource = (source, domain, status, summary) => ({
    ...source,
    claimDigest: readinessSourceClaim({
      source,
      domain,
      status,
      summary,
    }),
  });
  const requiredSource = (source) => ({
    ...source,
    claimDigest: readinessSourceClaim({
      source,
      purpose: "required-sources",
    }),
  });
  const readiness = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    taskId: null,
    finalRestatement:
      "The bounded self-test project, commands, package graph, oracle, and runtime constraints were read and are ready for exact review.",
    requiredSourcesEvidence: [
      requiredSource(projectSources.get("repository-boundary")),
      requiredSource(packageSource),
    ],
    domains: Object.fromEntries(
      readinessDomains.map((domain) => {
        const status = "evidenced";
        const summary = `Signed bounded evidence was reviewed for ${domain}.`;
        const source =
          domain === "packages-and-docs"
            ? packageSource
            : projectSources.get(domain);
        return [
          domain,
          {
            status,
            summary,
            sources: [claimedSource(source, domain, status, summary)],
          },
        ];
      }),
    ),
  };
  await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "readiness",
      "--content-base64",
      base64Json(readiness),
    ],
    item.env,
  );
  const contextReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "context"],
    item.env,
  );
  assert.equal(
    canonicalDigest(JSON.parse(contextReview.review.canonicalDocument)),
    contextReview.review.approvalDigest,
  );
  const challenge = (
    await context.authority.readSigned(
      `approval-challenges/${sha256(contextReview.challengeId)}.json`,
    )
  ).payload;
  const reviewLease = (
    await context.authority.readSigned("lease/current.json")
  ).payload;
  assert.ok(
    Date.parse(reviewLease.expiresAt) > Date.parse(challenge.expiresAt),
    "lease must outlive the exact review challenge",
  );
  assert.equal(
    await import("node:fs/promises").then(({ stat }) =>
      stat(path.join(item.project, ".claude")).then(
        () => true,
        () => false,
      ),
    ),
    false,
    "no project context may be written before approval",
  );
  await approveQuestion({
    env: item.env,
    sessionId,
    question: contextReview.question,
    toolUseId: "approve-context",
  });
  const committed = await runWorkflowAuthority(
    ["commit-context", "--session-handle", handle],
    item.env,
  );
  assert.equal(committed.phase, "PROJECT_READY");
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(item.project, ".claude", "qaas", "context-index.json"),
        "utf8",
      ),
    ).contextDigest,
    committed.contextDigest,
  );
  assert.equal(
    JSON.parse(
      await readFile(
        path.join(item.project, ".claude", "qaas", "state", "current.json"),
        "utf8",
      ),
    ).phase,
    "PROJECT_READY",
  );
  const begun = await runWorkflowAuthority(
    ["begin-task", "--session-handle", handle, "--task-id", "self-test-task"],
    item.env,
  );
  const onboarding = (
    await context.authority.readSigned(
      "fingerprints/onboardingFingerprint.json",
    )
  ).payload;
  const command = (program, args) => ({
    program,
    args,
    cwd: ".",
    envNames: ["USERPROFILE", "APPDATA", "LOCALAPPDATA"],
    shell: false,
    timeoutMs: 60_000,
    outputLimitBytes: 16_384,
  });
  const plan = {
    schemaVersion: "1.0",
    planId: "self-test-plan",
    taskId: "self-test-task",
    createdAt: new Date().toISOString(),
    contextDigest: committed.contextDigest,
    projectFingerprintDigest: onboarding.digest,
    packageSnapshotDigest: begun.packageSnapshotDigest,
    goal: "Exercise the exact approved runtime",
    acceptanceCriteria: ["Build, template, and run succeed"],
    paths: {
      create: [],
      modify: ["Program.cs", "SelfTest.csproj"],
      forbidden: [],
      unchanged: [],
    },
    changes: [
      {
        path: "Program.cs",
        operation: "modify",
        intent: "Keep the deterministic self-test program",
      },
      {
        path: "SelfTest.csproj",
        operation: "modify",
        intent: "Keep the deterministic SDK project definition",
      },
    ],
    dependencies: [],
    csharpClosure: csharpClosureFixture(),
    commands: {
      restore: [
        command("dotnet", ["restore", "SelfTest.csproj", "--nologo"]),
      ],
      build: [
        command("dotnet", [
          "build",
          "SelfTest.csproj",
          "--no-restore",
          "--nologo",
        ]),
      ],
      template: [
        command("dotnet", [
          "run",
          "--project",
          "SelfTest.csproj",
          "--no-build",
          "--",
          "template",
        ]),
      ],
    },
    generatedOutputs: ["bin", "obj", "rendered"],
    expectedDiff: "No source diff; only excluded build outputs",
    risks: [],
    acceptedResidualRisks: [
      "Opaque .NET SDK internals remain an organizational trust boundary",
    ],
    verification: {
      restore: [
        {
          id: "restore-assets",
          type: "file-not-empty",
          path: "obj/project.assets.json",
        },
      ],
      build: [
        {
          id: "build-succeeded",
          type: "stdout-contains",
          contains: "Build succeeded.",
        },
      ],
      template: [
        {
          id: "template-status",
          type: "json-pointer-equals",
          path: "rendered/template.json",
          jsonPointer: "/status",
          expected: "ok",
        },
      ],
    },
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
  };
  const stagedPlan = await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "plan",
      "--content-base64",
      base64Json(plan),
    ],
    item.env,
  );
  const planReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "plan"],
    item.env,
  );
  const planReviewDocument = JSON.parse(planReview.review.canonicalDocument);
  assert.equal(planReviewDocument.artifactDigest, stagedPlan.digest);
  assert.equal(planReviewDocument.processBindings.length, 3);
  assert.equal(
    canonicalDigest(planReviewDocument),
    planReview.review.approvalDigest,
  );
  await answerQuestion({
    env: item.env,
    sessionId,
    question: planReview.question,
    toolUseId: "revise-plan",
    decision: "Revise",
  });
  assert.equal(
    (await context.authority.readSigned("state/current.json")).payload.phase,
    "TASK_DISCOVERY",
  );
  const restagedPlan = await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "plan",
      "--content-base64",
      base64Json(plan),
    ],
    item.env,
  );
  assert.equal(restagedPlan.digest, stagedPlan.digest);
  const refreshedPlanReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "plan"],
    item.env,
  );
  assert.notEqual(refreshedPlanReview.challengeId, planReview.challengeId);
  await approveQuestion({
    env: item.env,
    sessionId,
    question: refreshedPlanReview.question,
    toolUseId: "approve-plan",
  });
  await runWorkflowAuthority(
    ["start-implementation", "--session-handle", handle],
    item.env,
  );
  const originalAppData = item.env.APPDATA;
  item.env.APPDATA = `${originalAppData ?? "appdata"}-changed-after-approval`;
  await assert.rejects(
    runApproved(
      ["--session-handle", handle, "--action", "restore"],
      item.env,
    ),
    /process specification does not match/u,
  );
  if (originalAppData === undefined) delete item.env.APPDATA;
  else item.env.APPDATA = originalAppData;
  const restored = await runApproved(
    ["--session-handle", handle, "--action", "restore"],
    item.env,
  );
  assert.equal(restored.successful, true, JSON.stringify(restored, null, 2));
  const built = await runApproved(
    ["--session-handle", handle, "--action", "build"],
    item.env,
  );
  assert.equal(built.phase, "BUILD_VERIFIED", JSON.stringify(built, null, 2));
  const templated = await runApproved(
    ["--session-handle", handle, "--action", "template"],
    item.env,
  );
  assert.equal(
    templated.phase,
    "IMPLEMENTED_NOT_RUN",
    JSON.stringify(templated, null, 2),
  );
  const timedOutTree = await runProcess({
    program: dotnet.resolvedPath,
    args: [
      "run",
      "--project",
      "SelfTest.csproj",
      "--no-build",
      "--",
      "run",
      "hang",
    ],
    cwd: item.project,
    envNames: ["USERPROFILE", "APPDATA", "LOCALAPPDATA"],
    timeoutMs: 500,
    outputLimitBytes: 4_096,
    outputDirectories: ["bin", "obj"],
    scopeRoot: item.project,
    actionClass: "test-run",
    approvedExecutablePath: dotnet.resolvedPath,
    expectedExecutableDigest: dotnet.executableDigest,
    verifyAuthorization: async () => true,
  });
  assert.equal(timedOutTree.timedOut, true);
  assert.equal(timedOutTree.killDeadlineExceeded, false);
  const staticFingerprint = (
    await context.authority.readSigned(
      "fingerprints/staticVerificationFingerprint.json",
    )
  ).payload;
  const execution = {
    schemaVersion: "1.0",
    executionId: "self-test-execution",
    taskId: "self-test-task",
    createdAt: new Date().toISOString(),
    implementationPlanDigest: stagedPlan.digest,
    staticVerificationDigest: staticFingerprint.digest,
    environment: {
      id: "local-self-test",
      description: "Local deterministic self-test process",
      deploymentReadyConfirmed: true,
    },
    command: command("dotnet", [
      "run",
      "--project",
      "SelfTest.csproj",
      "--no-build",
      "--",
      "run",
      "default",
    ]),
    scope: {
      selectionMode: "project-default",
      statement: "Run the approved self-test default",
      executables: [],
      cases: [],
      sessions: [],
      configuration: "default",
      configurationArgIndex: 6,
      argumentBindings: [],
    },
    sampleCount: 1,
    stressRequested: false,
    expectedSideEffects: [],
    observabilityQueries: [],
    outputPaths: ["allure-results"],
    successChecks: [
      {
        id: "runtime-report",
        type: "json-pointer-equals",
        path: "allure-results/report.json",
        jsonPointer: "/passed",
        expected: true,
      },
    ],
    warningPolicy: { mode: "forbid", allowedSubstrings: [] },
    repeatCount: 1,
    retryBudget: 0,
    retryPassPolicy: "reject-flaky",
    wallClockLimitMs: 60_000,
    userReviewedBudget: true,
    outputLimitBytes: 16_384,
    noDeletionCleanup: true,
  };
  const stagedExecution = await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "execution",
      "--content-base64",
      base64Json(execution),
    ],
    item.env,
  );
  const executionReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "execution"],
    item.env,
  );
  const executionReviewDocument = JSON.parse(
    executionReview.review.canonicalDocument,
  );
  assert.equal(executionReviewDocument.artifactDigest, stagedExecution.digest);
  assert.equal(executionReviewDocument.processBindings.length, 1);
  assert.equal(
    canonicalDigest(executionReviewDocument),
    executionReview.review.approvalDigest,
  );
  await answerQuestion({
    env: item.env,
    sessionId,
    question: executionReview.question,
    toolUseId: "cancel-execution",
    decision: "Cancel",
  });
  assert.equal(
    (await context.authority.readSigned("state/current.json")).payload.phase,
    "IMPLEMENTED_NOT_RUN",
  );
  let liveExecutionReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "execution"],
    item.env,
  );
  assert.notEqual(liveExecutionReview.challengeId, executionReview.challengeId);
  const curl = await discoverProgram("curl", {
    cwd: item.project,
    env: item.env,
  });
  let mutationServer = null;
  let mutationRequestCount = 0;
  if (curl.available) {
    mutationServer = http.createServer(async (request, response) => {
      for await (const _chunk of request) {
        // Drain the exact bounded request body.
      }
      mutationRequestCount += 1;
      response.writeHead(200, { "Content-Type": "text/plain" }).end("created");
    });
    mutationServer.listen(0, "127.0.0.1");
    await once(mutationServer, "listening");
    t.after(() => mutationServer.close());
    const mutationCommand = command("curl", [
      "--silent",
      "--show-error",
      "--request",
      "POST",
      "--data",
      "{}",
      `http://127.0.0.1:${mutationServer.address().port}/fixture`,
    ]);
    const mutationTool = {
      kind: "process",
      name: "curl",
      command: mutationCommand,
      outputDirectories: [],
    };
    mutationTool.inputDigest = canonicalDigest({
      name: mutationTool.name,
      command: mutationTool.command,
      outputDirectories: mutationTool.outputDirectories,
    });
    const mutation = {
      schemaVersion: "1.0",
      mutationId: "self-test-mutation",
      taskId: "self-test-task",
      createdAt: new Date().toISOString(),
      executionPlanDigest: stagedExecution.digest,
      tool: mutationTool,
      resource: "local self-test fixture",
      action: "create bounded fixture",
      environment: "loopback self-test server",
      expectedSideEffects: ["one loopback POST creates one fixture"],
      rollbackLimitation: "No automatic cleanup is permitted",
      successChecks: [
        {
          id: "mutation-created",
          type: "stdout-contains",
          contains: "created",
        },
      ],
      warningPolicy: { mode: "forbid", allowedSubstrings: [] },
      noDeletion: true,
    };
    await runWorkflowAuthority(
      [
        "stage",
        "--session-handle",
        handle,
        "--kind",
        "mutation",
        "--content-base64",
        base64Json(mutation),
      ],
      item.env,
    );
    const mutationReview = await runWorkflowAuthority(
      ["prepare", "--session-handle", handle, "--kind", "mutation"],
      item.env,
    );
    await approveQuestion({
      env: item.env,
      sessionId,
      question: mutationReview.question,
      toolUseId: "approve-mutation",
    });
    const supersededExecutionChallenge = (
      await context.authority.readSigned(
        `approval-challenges/${sha256(liveExecutionReview.challengeId)}.json`,
      )
    ).payload;
    assert.equal(
      supersededExecutionChallenge.status,
      "superseded",
    );
    const priorExecutionChallengeId = liveExecutionReview.challengeId;
    liveExecutionReview = await runWorkflowAuthority(
      ["prepare", "--session-handle", handle, "--kind", "execution"],
      item.env,
    );
    assert.notEqual(
      liveExecutionReview.challengeId,
      priorExecutionChallengeId,
    );
  }
  await approveQuestion({
    env: item.env,
    sessionId,
    question: liveExecutionReview.question,
    toolUseId: "approve-execution",
  });
  if (curl.available) {
    const mutated = await runApproved(
      ["--session-handle", handle, "--action", "mutation"],
      item.env,
    );
    assert.equal(mutated.phase, "EXECUTION_APPROVED");
    assert.equal(mutated.successful, true);
    assert.equal(mutationRequestCount, 1);
    await assert.rejects(
      runApproved(
        ["--session-handle", handle, "--action", "mutation"],
        item.env,
      ),
      /already been executed/u,
    );
  }
  const originalProgram = await readFile(
    path.join(item.project, "Program.cs"),
    "utf8",
  );
  await writeFile(
    path.join(item.project, "Program.cs"),
    `${originalProgram}\n// stale after execution approval\n`,
    "utf8",
  );
  await assert.rejects(
    runApproved(
      ["--session-handle", handle, "--action", "test-run"],
      item.env,
    ),
    /fingerprint is stale/u,
  );
  await writeFile(path.join(item.project, "Program.cs"), originalProgram, "utf8");
  const executed = await runApproved(
    ["--session-handle", handle, "--action", "test-run"],
    item.env,
  );
  assert.equal(executed.phase, "VERIFIED");
  assert.equal(executed.successful, true);
  await writeFile(
    path.join(item.project, "allure-results", "report.json"),
    '{"passed":true,"token":"synthetic-sensitive-value"}',
    "utf8",
  );
  const verifiedFingerprint = (
    await context.authority.readSigned(
      "fingerprints/onboardingFingerprint.json",
    )
  ).payload;
  const exactToolInput = { path: "allure-results/report.json" };
  const query = {
    queryId: "allure-result",
    provider: "allure",
    capabilityId: "allure-report-read",
    toolName: "mcp__qaas-allure__read-report",
    toolInput: exactToolInput,
    toolInputDigest: sha256(exactToolInput),
    endpointSelector: "project-artifact",
    purpose: "Read the exact bounded generated test report",
    credentialEnvNames: [],
    timeoutMs: 5_000,
    outputLimitBytes: 16_384,
    itemLimit: 100,
    readOnly: true,
    responseChecks: [
      {
        id: "report-passed",
        type: "json-pointer-equals",
        jsonPointer: "/passed",
        expected: true,
      },
    ],
  };
  query.queryDigest = querySpecDigest(query);
  const queryPlan = {
    schemaVersion: "1.0",
    queryPlanId: "self-test-query-plan",
    taskId: "self-test-task",
    createdAt: new Date().toISOString(),
    executionPlanDigest: stagedExecution.digest,
    currentFingerprintDigest: verifiedFingerprint.digest,
    queries: [query],
  };
  await runWorkflowAuthority(
    [
      "stage",
      "--session-handle",
      handle,
      "--kind",
      "query",
      "--content-base64",
      base64Json(queryPlan),
    ],
    item.env,
  );
  const queryReview = await runWorkflowAuthority(
    ["prepare", "--session-handle", handle, "--kind", "query"],
    item.env,
  );
  assert.match(queryReview.question.question, /toolInputDigest/u);
  assert.match(queryReview.question.question, /mcp__qaas-allure__read-report/u);
  await approveQuestion({
    env: item.env,
    sessionId,
    question: queryReview.question,
    toolUseId: "approve-query",
  });
  const queryCommand =
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/query-approved.mjs" ` +
    `--session-handle ${handle}`;
  const queryToolUseId = "execute-approved-query";
  const queryPreTool = await handlePreToolUse(
    {
      hook_event_name: "PreToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: queryToolUseId,
      tool_input: { command: queryCommand },
    },
    { env: item.env },
  );
  assert.equal(
    queryPreTool.hookSpecificOutput.permissionDecision,
    "allow",
  );
  const queried = await runApprovedQuery(
    ["--session-handle", handle],
    item.env,
  );
  assert.equal(queried.successful, true, JSON.stringify(queried, null, 2));
  assert.equal(queried.oneUseApprovalConsumed, true);
  assert.doesNotMatch(
    queried.results[0].excerpt,
    /synthetic-sensitive-value/u,
  );
  assert.match(queried.results[0].excerpt, /REDACTED_FIELD/u);
  const queryEvidence = await context.authority.readSigned(
    `evidence/records/${queried.results[0].evidenceDigest}.json`,
  );
  assert.equal(
    queryEvidence.payload.event.tool,
    "qaas-internal-project-artifact-v1",
  );
  assert.equal(
    queryEvidence.payload.event.details.permissionContractToolName,
    "mcp__qaas-allure__read-report",
  );
  await handlePostToolUse(
    {
      hook_event_name: "PostToolUse",
      session_id: sessionId,
      tool_name: "Bash",
      tool_use_id: queryToolUseId,
      tool_input: { command: queryCommand },
      tool_response: queried,
    },
    { env: item.env },
  );
  await assert.rejects(
    runApprovedQuery(["--session-handle", handle], item.env),
    /lacks the exact separate query approval/u,
  );
});

test("process runner binds an absolute executable digest and bounded output", async () => {
  const discovered = await discoverProgram("node");
  assert.equal(discovered.available, true);
  const result = await runProcess({
    program: discovered.resolvedPath,
    args: ["--version"],
    cwd: process.cwd(),
    outputLimitBytes: 1024,
    timeoutMs: 5000,
    actionClass: "ordinary-read",
    approvedExecutablePath: discovered.resolvedPath,
    expectedExecutableDigest: discovered.executableDigest,
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /^v\d+/u);
  assert.ok(result.specDigest);
});
