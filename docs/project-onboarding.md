# Project onboarding

Onboarding builds a durable, user-confirmed model of one QaaS test repository.
It is required once per project and whenever an unmapped material change makes
that model stale.

## Before starting

Run Claude Code from the repository root. Have available:

- A short description of the tested system/component and its current version.
- Developer release notes/tag, expected behavior, and test design when present.
- Supplied input/output samples and schemas/descriptors.
- Exact working restore, build, template, and run commands.
- Common Hooks and module source repositories, or confirmation they are unused.
- A similar project used as a style reference, if one exists.
- Environment ownership and the operations that QA is permitted to perform.

For a large project, use `/effort xhigh` when the installed Claude Code/model
supports it and ask Claude to **use dynamic workflow**. Read-only mapping may
use forked subagents with bounded scopes.

## Interview sequence

The coordinator asks one question per turn and follows an incomplete answer
before moving on:

1. Confirm repository and QaaS project boundaries.
2. Inventory relevant, generated, vendor, and unknown files.
3. Ask the user to explain relevant files and custom code before interpreting
   them.
4. Confirm tested-system boundary, entry/exit points, protocols, formats,
   headers, correlation, side effects, and current deployment/version.
5. Map YAML/C# configuration, anchors, merges/appends, variables, modules,
   cases, executables, sessions, and suites.
6. Map each exact command, its working directory, prerequisites, arguments,
   expected exit code, and what it runs.
7. Map existing tests and internally categorize their observed purpose as
   tentative convention evidence; do not promote an inferred category to
   behavior, acceptance, or readiness without corroboration.
8. Map samples, schemas, field meaning, modifiable/protected fields,
   nondeterminism, and variant-generation rules.
9. Map every assertion, generator, probe, processor, and other C# artifact,
   including package/source, interface, configuration record, behavior, YAML/C#
   usage, and call sites.
10. Resolve current QaaS docs and installed package provenance.
11. Confirm Common Hooks and modules repositories or that they are not used.
12. Capture environment and observability only to the extent relevant.
13. Restate the complete project model and show the proposed context diff.

The user can correct the restatement. Context is written only after explicit
approval of that exact proposal.

## Required readiness domains

Each fact has a status: `evidenced`, `user_confirmed`, `not_applicable`,
`unknown`, or `contradicted`. All required domains must be resolved:

1. Repository/project boundary.
2. Tested system/component boundary and current version.
3. Message/data flows, entry/exit points, side effects, and correlation.
4. YAML or C# style.
5. Cases, executables, suites, anchors, merge/append behavior, variables,
   modules, and overrides.
6. QaaS packages and applicable documentation.
7. Every relevant file and custom code artifact.
8. Restore, build, template, and run commands and their coverage.
9. Existing test inventory and observed categories.
10. Input/output contracts and runtime success oracle.
11. Sample meaning, schemas, mutation rules, and protected fields.
12. Common Hooks and module repositories, or explicit non-use.
13. Similar reference projects when supplied.
14. Environment identity, deployment ownership, and permitted operations.
15. Release notes/tag, test design, behavior, and samples when available.
16. Current task acceptance criteria.
17. Observability only when the current task requires it.

An inaccessible required source, contradiction, or unknown hard fact blocks
planning. The user may accept a clearly described residual risk only when it is
not a readiness requirement.

## Generated files

`CLAUDE.md` contains the short mandatory workflow and links. The topic files
under `qaas/` hold detailed facts:

- `project.md`: scope, owners, version, and purpose.
- `structure.md`: relevant files and user explanations.
- `tested-system.md`: components, flows, protocols, formats, and side effects.
- `qaas-configuration.md`: configuration style and composition behavior.
- `conventions.md`: naming, layout, YAML/C# style, and minimal-change rules.
- `commands.md`: exact commands and what each covers.
- `suites-and-cases.md`: executables, suites, cases, and observed test purpose.
- `samples.md`: sample contracts and mutation/protection rules.
- `custom-hooks.md`: complete custom-code inventory and usage.
- `modules.md`: module sources, versions, merge behavior, and provenance.
- `environments.md`: identities, ownership, deployment, and allowed operations.
- `observability.md`: task-relevant evidence sources and access rules; presence
  never proves a connector or grants query approval.
- `integrations.md`: non-secret endpoints and credential-variable names.
- `decisions.md`: confirmed decisions and evidence.
- `unknowns.md`: open and resolved questions without erasing history.
- `fingerprint.json`: the approved project/context binding.

Task-specific files under `state/tasks/<task-id>/` contain request, readiness,
plan, execution plan, optional separately reviewed query plan, approval mirror,
progress, rationale, evidence, repairs, and verdict. Execution plans keep
`observabilityQueries` empty. Large reports stay outside this folder.

If an existing `.claude/CLAUDE.md` is present, the plugin maintains only an
idempotent delimited block. It never overwrites user-owned text outside it.

## Updating context

During a later task, any unfamiliar file, hook, module, sample behavior, command,
or system change causes a stop:

1. Show the unexpected evidence.
2. Ask the user to explain/correct it.
3. Propose the smallest context delta.
4. Obtain context-delta approval.
5. Recompute fingerprints.
6. Revise any plan invalidated by the change.

Important answers are checkpointed immediately in protected staging so a
compaction or session resume does not lose them. The project mirror is updated
only through a reviewed transaction.

The plugin never reads or writes cross-project memory automatically. It may
show exact non-secret general-preference text for the user to record through
their own manual memory workflow. Project, system, sample, hook, command,
environment, endpoint, credential, acceptance, and test facts remain in the
bounded project context.
