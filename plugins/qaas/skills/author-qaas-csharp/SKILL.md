---
description: Author the minimal approved C#-based QaaS test change using current docs and existing project conventions.
user-invocable: false
---

# Author QaaS C#

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns results to that coordinator.

If invoked outside an implementation or approved repair phase, return control to `qaas-workflow` without writing.

- Require complete readiness, a fresh approved plan, active hook attestation, and exact approved paths.
- Prove every QaaS API, type, package, and configuration decision from current documentation plus installed project evidence. Never rely on remembered signatures.
- Before writing, require the approved plan itself to contain
  `csharpClosure` with exactly these named fields:
  `bootstrapModeAndArguments`, `builderTypesAndSignatures`, `topology`,
  `hookBasesInterfacesAndDiscovery`, `configurationRecordAndBinding`,
  `providerPackages`, `yamlAndCsharpUse`, and
  `restoreBuildTemplateCommands`. Each field is
  `{ status, facts, documentationEvidence, projectEvidence }`; status is
  `resolved` or `evidence-proven-inapplicable`, and every array contains
  concrete non-placeholder statements. Facts elsewhere do not satisfy a field.
- Require current-docs proof plus project evidence for every closure item,
  including a compatible installed provider or the approved owner-path/package
  change and restore action. If anything is absent, unknown, contradicted, or
  newly needed, write nothing and return to one-question/one-query planning for
  a revised approval. Do not discover, infer, or invent closure after approval.
- When active authority content-binds writes, require the approved exact
  complete target bytes, their SHA-256, and one matching
  `write <add|modify> <path> sha256:<digest>` command per scoped write. Do not
  redraft content after approval.
- Preserve disclosed literal tokens and array order exactly in structured
  semantic contracts; never paraphrase, substitute synonyms, reorder, or
  normalize them.
- Preserve the existing target framework, entry-point style, project layout, naming, formatting, nullable policy, dependency pattern, and YAML/C# boundary.
- Reuse project helpers and installed hook/module infrastructure. Add no speculative abstraction or new unit-test framework.
- Modify only approved paths and package references. Never modify QaaS platform source.
- Never delete, move, or rename files. Do not leave commented-out code.
- Keep credential values out of source, commands, context, and evidence.

Return changed paths, reason per path, cited compatibility evidence, and verification still required.

See [authoring checklist](../../references/test-authoring/authoring-checklist.md).
