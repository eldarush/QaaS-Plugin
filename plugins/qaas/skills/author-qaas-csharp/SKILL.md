---
description: Internal implementation specialist used only when qaas-workflow delegates an approved C#-based QaaS test-project change with current documentation and project conventions.
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
- Read the signed active authority projection's
  `authorityCapabilities.writeContentBinding`. It is `false` in this release,
  so do not require or invent target bytes. Only if a future active authority
  reports `true`, require the approved exact complete target bytes, their
  SHA-256, and one matching
  `write <add|modify> <path> sha256:<digest>` command per scoped write. Do not
  redraft content after approval.
- Preserve disclosed literal tokens and array order exactly in structured
  semantic contracts; never paraphrase, substitute synonyms, reorder, or
  normalize them.
- When current documentation shows a C# declaration, copy that declaration
  shape exactly: attributes, accessibility, modifiers, type, property/accessor
  form, initializer, and constructor form. Do not substitute an
  equivalent-looking C# idiom or add undocumented attributes, modifiers, or
  declaration features. For example, an init-only property documented with a
  validation attribute does not authorize adding C# `required`.
- For a hook, implement every accepted semantic outcome and its observable
  failure/pass behavior. Never use a stub, no-op, `yield break`, unconditional
  pass/success return, or other placeholder body in place of the exact oracle.
- Preserve the existing target framework, entry-point style, project layout, naming, formatting, nullable policy, dependency pattern, and YAML/C# boundary.
- Reuse project helpers and installed hook/module infrastructure. Add no speculative abstraction or new unit-test framework.
- Modify only approved paths and package references. Never modify QaaS platform source.
- Never delete, move, or rename files. Do not leave commented-out code.
- Keep credential values out of source, commands, context, and evidence.

Return changed paths, reason per path, cited compatibility evidence, and verification still required.

See [authoring checklist](../../references/test-authoring/authoring-checklist.md).
