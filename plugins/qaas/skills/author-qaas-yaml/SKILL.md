---
description: Author the minimal approved YAML-based QaaS test change using current docs and existing project conventions.
user-invocable: false
---

# Author QaaS YAML

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns results to that coordinator.

If invoked outside an implementation or approved repair phase, return control to `qaas-workflow` without writing.

- Require complete readiness, a fresh approved plan, active hook attestation, and exact approved paths.
- Retrieve current documentation for each QaaS-dependent construct. Never invent a key, shape, default, anchor behavior, merge rule, variable, module, executable, case, or command.
- Read the actual resolved module/configuration evidence before editing. Preserve the project's YAML formatting, naming, file placement, append/merge/override style, anchors, aliases, and variable conventions.
- Change only what the acceptance criteria require. Reuse existing modules, hooks, samples, and patterns before adding anything.
- Do not convert YAML to C#, add speculative infrastructure, widen the suite, or introduce unrelated cleanup.
- Never delete, move, or rename a file. A required rename is a new approved path followed by a user-performed removal.
- Keep secrets out of YAML and evidence; store only approved environment-variable names.

Return changed paths, reason per path, documentation provenance, assumptions eliminated, and verification still required.

See [authoring checklist](../../references/test-authoring/authoring-checklist.md).
