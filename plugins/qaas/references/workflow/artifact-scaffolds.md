# Lifecycle artifact scaffolds

These are illustrative, non-authoritative shapes for the plugin's lifecycle
artifacts. They contain synthetic identifiers, paths, commands, evidence text,
and digests. Replace every synthetic value with current signed handles and
evidence; never copy a scaffold into a real review. The schemas and validators
remain authoritative.

These examples describe plugin authority records, not QaaS test configuration.
They deliberately contain no QaaS YAML or C# configuration keys. Use only keys
proven by current QaaS documentation when authoring a test project.

For `plan`, `execution`, and `query`, send the complete JSON without a top-level
`digest` to `workflow-authority.mjs stage`. Staging computes and inserts that
digest before validation. Do not use the encoder's `transportSha256` as that
top-level artifact digest; it may fill `changes[].targetSha256` only when its
input was that file's exact complete target content. Inner query digests are
different: compute `toolInputDigest` over the exact
`toolInput`, then `queryDigest` over the exact query without `queryDigest`.

## Readiness/context fact

A user fact is registered only in `DISCOVERING` through
`prepare-readiness-fact`; it is not written directly into project context.
The command accepts one exact readiness domain, `user_confirmed` or an allowed
`not_applicable` status, and a 1–320 character summary. The authority constructs
this semantic shape and adds its canonical `digest`:

<!-- artifact-example:readiness-fact -->
```json
{
  "schemaVersion": "1.0",
  "domain": "samples",
  "status": "user_confirmed",
  "summary": "Synthetic example: new samples are additive and the original files remain unchanged."
}
```

The user must approve the generated fact challenge. Its signed digest is then
referenced by the complete `readiness.schema.json` matrix. Only
`message-data-flows`, `samples`, `common-hooks-and-modules`,
`reference-projects`, and `observability` may be `not_applicable`. Context is
committed only after the complete readiness matrix, context bundle, restatement,
and context challenge pass. A fact approval alone authorizes no context write.

## Progress checkpoint

Checkpoint before compaction or handoff. Lists are bounded, evidence paths are
project-relative, `blocker` is `null` or one genuine blocker, and
`nextLegalAction` is always nonempty. `awaitingUser` is deliberately absent:
model checkpoints cannot set it. The Stop hook owns that protected flag after
corroborating one focused final question or consuming the protected one-use
record for the matching slash-command success phase. Phase alone is
insufficient. A pending command record survives an answer only through the
signed Stop-question/wait/answer sequence; unrelated prompts invalidate it.
The next valid lease-owner prompt clears the waiting flag.

<!-- artifact-example:progress -->
```json
{
  "completedWork": [
    "Mapped the synthetic project structure"
  ],
  "remainingWork": [
    "Confirm the output oracle"
  ],
  "evidencePaths": [
    ".claude/qaas/structure.md"
  ],
  "blocker": null,
  "nextLegalAction": "Ask the user to confirm the exact output oracle"
}
```

Encode that exact object and call:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" checkpoint --session-handle <handle> --content-base64 <contentBase64>
```

## Implementation plan with C# closure

This minimal structural plan touches C#, so all eight `csharpClosure` entries
are mandatory. Every closure sentence below is synthetic scaffold text: replace
it with concrete facts plus distinct current documentation and project
evidence. `evidence-proven-inapplicable` still requires evidence; it is not a
shortcut for an unknown.

<!-- artifact-example:plan -->
```json
{
  "schemaVersion": "1.0",
  "planId": "synthetic-plan",
  "taskId": "synthetic-task",
  "createdAt": "2026-07-25T00:00:00.000Z",
  "contextDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "projectFingerprintDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "packageSnapshotDigest": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "goal": "Apply one reviewed synthetic C# test-project change",
  "acceptanceCriteria": [
    "The reviewed change builds and its rendered template has the expected artifact"
  ],
  "paths": {
    "create": [],
    "modify": [
      "Program.cs"
    ],
    "forbidden": [
      "Production"
    ],
    "unchanged": [
      ".claude/qaas"
    ]
  },
  "changes": [
    {
      "path": "Program.cs",
      "operation": "modify",
      "intent": "Apply only the exact reviewed bootstrap change",
      "targetSha256": "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    }
  ],
  "dependencies": [],
  "commands": {
    "restore": [
      {
        "program": "dotnet",
        "args": ["restore", "Fixture.csproj", "--configfile", "NuGet.Config", "--nologo"],
        "cwd": ".",
        "envNames": [],
        "shell": false,
        "timeoutMs": 60000,
        "outputLimitBytes": 16384
      }
    ],
    "build": [
      {
        "program": "dotnet",
        "args": ["build", "Fixture.csproj", "--no-restore", "--nologo"],
        "cwd": ".",
        "envNames": [],
        "shell": false,
        "timeoutMs": 60000,
        "outputLimitBytes": 16384
      }
    ],
    "template": [
      {
        "program": "dotnet",
        "args": ["run", "--project", "Fixture.csproj", "--no-build", "--", "template"],
        "cwd": ".",
        "envNames": [],
        "shell": false,
        "timeoutMs": 60000,
        "outputLimitBytes": 16384
      }
    ]
  },
  "generatedOutputs": ["bin", "obj", "rendered"],
  "expectedDiff": "Only Program.cs changes",
  "risks": [],
  "acceptedResidualRisks": [],
  "verification": {
    "restore": [
      {
        "id": "assets",
        "type": "file-not-empty",
        "path": "obj/project.assets.json"
      }
    ],
    "build": [
      {
        "id": "build",
        "type": "stdout-contains",
        "contains": "Build succeeded."
      }
    ],
    "template": [
      {
        "id": "render",
        "type": "file-not-empty",
        "path": "rendered/template.json"
      }
    ]
  },
  "warningPolicy": {
    "mode": "forbid",
    "allowedSubstrings": []
  },
  "csharpClosure": {
    "bootstrapModeAndArguments": {
      "status": "resolved",
      "facts": ["Synthetic bootstrap fact; replace with the exact documented mode and arguments."],
      "documentationEvidence": ["Replace with a current exact documentation citation for this bootstrap fact."],
      "projectEvidence": ["Replace with the exact project path and digest proving this bootstrap fact."]
    },
    "builderTypesAndSignatures": {
      "status": "evidence-proven-inapplicable",
      "facts": ["The synthetic change does not select or alter a builder type or signature."],
      "documentationEvidence": ["Replace with the documentation evidence that bounds the selected API surface."],
      "projectEvidence": ["Replace with project evidence proving no builder call is selected by this change."]
    },
    "topology": {
      "status": "resolved",
      "facts": ["The synthetic project has one reviewed entry point and one template output."],
      "documentationEvidence": ["Replace with current documentation evidence for the required topology."],
      "projectEvidence": ["Replace with exact project paths and digests proving the topology."]
    },
    "hookBasesInterfacesAndDiscovery": {
      "status": "evidence-proven-inapplicable",
      "facts": ["The synthetic change adds or modifies no custom hook."],
      "documentationEvidence": ["Replace with current documentation that defines the custom-hook boundary."],
      "projectEvidence": ["Replace with project evidence proving no custom hook is in the change scope."]
    },
    "configurationRecordAndBinding": {
      "status": "evidence-proven-inapplicable",
      "facts": ["The synthetic change adds or modifies no hook configuration record."],
      "documentationEvidence": ["Replace with current documentation that defines configuration binding."],
      "projectEvidence": ["Replace with project evidence proving no configuration record is in scope."]
    },
    "providerPackages": {
      "status": "resolved",
      "facts": ["The synthetic project file is the exact owner of every selected provider package."],
      "documentationEvidence": ["Replace with current documentation naming each selected provider package."],
      "projectEvidence": ["Replace with the package snapshot and project-file evidence for every provider."]
    },
    "yamlAndCsharpUse": {
      "status": "resolved",
      "facts": ["The synthetic change keeps bootstrap logic in C# and does not alter YAML configuration."],
      "documentationEvidence": ["Replace with current documentation proving the C# and YAML responsibilities."],
      "projectEvidence": ["Replace with exact project paths proving where each responsibility lives."]
    },
    "restoreBuildTemplateCommands": {
      "status": "resolved",
      "facts": ["The exact restore, build, and template vectors are bound in this plan."],
      "documentationEvidence": ["Replace with current documentation supporting the selected template invocation."],
      "projectEvidence": ["Replace with project evidence proving the project, config file, and command arguments."]
    }
  }
}
```

If no C#-family path is created or modified, omit `csharpClosure`; never add a
fictional closure merely to satisfy a template. Every `paths.create` and
`paths.modify` entry needs exactly one matching `changes` entry. Generated
outputs must not overlap planned source or context paths.

## Execution plan

This is a non-stress, project-default run. The configuration value must occur
at `command.args[configurationArgIndex]`. For `explicit` scope, bind every
executable, case, and session to its exact argument index. For `all` or
`project-default`, keep those lists and `argumentBindings` empty. Omit `stress`
unless the user explicitly requested it.

<!-- artifact-example:execution -->
```json
{
  "schemaVersion": "1.0",
  "executionId": "synthetic-execution",
  "taskId": "synthetic-task",
  "createdAt": "2026-07-25T00:00:00.000Z",
  "implementationPlanDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "staticVerificationDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "environment": {
    "id": "synthetic-local",
    "description": "User-confirmed synthetic local environment",
    "deploymentReadyConfirmed": true
  },
  "command": {
    "program": "dotnet",
    "args": ["run", "--project", "Fixture.csproj", "--no-build", "--", "run", "default"],
    "cwd": ".",
    "envNames": [],
    "shell": false,
    "timeoutMs": 60000,
    "outputLimitBytes": 16384
  },
  "scope": {
    "selectionMode": "project-default",
    "statement": "Run the exact approved project default",
    "executables": [],
    "cases": [],
    "sessions": [],
    "configuration": "default",
    "configurationArgIndex": 6,
    "argumentBindings": []
  },
  "sampleCount": 1,
  "stressRequested": false,
  "expectedSideEffects": [],
  "observabilityQueries": [],
  "outputPaths": ["allure-results"],
  "successChecks": [
    {
      "id": "passed",
      "type": "json-pointer-equals",
      "path": "allure-results/result.json",
      "jsonPointer": "/passed",
      "expected": true
    }
  ],
  "warningPolicy": {
    "mode": "forbid",
    "allowedSubstrings": []
  },
  "repeatCount": 1,
  "retryBudget": 0,
  "retryPassPolicy": "reject-flaky",
  "wallClockLimitMs": 60000,
  "userReviewedBudget": true,
  "outputLimitBytes": 16384,
  "noDeletionCleanup": true
}
```

`observabilityQueries` is always empty. External or local report inspection
uses a separately reviewed query plan. The exact environment, scope, expected
side effects, limits, repeats, retries, output paths, and typed checks all need
user review.

## Query plan

This synthetic local-Allure shape illustrates the digest nesting. In real work,
copy `capabilityId`, `toolName`, and input shape only from the current,
successfully probed, read-only capability registry.

<!-- artifact-example:query -->
```json
{
  "schemaVersion": "1.0",
  "queryPlanId": "synthetic-query",
  "taskId": "synthetic-task",
  "createdAt": "2026-07-25T00:00:00.000Z",
  "executionPlanDigest": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "currentFingerprintDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "queries": [
    {
      "queryId": "result",
      "provider": "allure",
      "capabilityId": "allure-project-read",
      "toolName": "mcp__qaas_allure__read_report",
      "toolInput": {
        "path": "allure-results/result.json"
      },
      "toolInputDigest": "984e9700be3e28c2bf38b2921e9d035f15beb1c36d7274a73270c104d8264c29",
      "endpointSelector": "project-artifact",
      "purpose": "Read the approved bounded Allure result",
      "credentialEnvNames": [],
      "timeoutMs": 5000,
      "outputLimitBytes": 16384,
      "itemLimit": 100,
      "readOnly": true,
      "responseChecks": [
        {
          "id": "passed",
          "type": "json-pointer-equals",
          "jsonPointer": "/passed",
          "expected": true
        }
      ],
      "queryDigest": "b8f792e5341e2a7ce95a6d739e1c48ed497c705f2826740baaf57cc48ca71f74"
    }
  ]
}
```

Remote-provider plans use the exact reviewed credential-free HTTPS or loopback
base URL, a `toolInput.relativeUrl` that remains inside it, and zero or one
credential environment-variable name. Never include a credential value.

## Revision and approval boundary

Staging validates the artifact and computes its artifact digest. `prepare`
then builds a separate review document, adds deterministic process or query
bindings, and opens a challenge for the review document's digest. Therefore:

1. Never present the artifact digest, `transportSha256`, or a handcrafted
   approval event as the approval target. Present only the challenge returned
   by `prepare`.
2. A changed path, command argument, literal token, array order, evidence
   handle, bound digest, risk, limit, check, or selected scope is a new complete
   artifact. Restage it and call `prepare` again; never patch an approved
   artifact or reuse an old challenge.
3. Planning stops at `PLAN_APPROVED`. Only `start-implementation` enters the
   exact approved implementation scope.
4. During diagnosis, `recover --mode exact` permits only the existing approved
   scope. A material change requires `recover --mode replan`, a fresh complete
   plan, and a new exact approval.

The model, repository, retrieved data, subagents, and conversational assent
cannot mint or broaden approval.
