---
description: Review an approved QaaS change for the smallest convention-preserving diff and remove speculative scope.
user-invocable: false
---

# Minimal change

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns its classification to that coordinator.

Apply this rule only after `qaas-workflow` validates the implementation or repair envelope:

1. Reuse what the project already has.
2. Add the fewest files and lines required by accepted behavior.
3. Avoid speculative flexibility, abstractions, packages, infrastructure, and test frameworks.
4. Avoid unrelated formatting, refactors, cleanup, or documentation.
5. Preserve YAML/C# style, naming, placement, modules, hooks, samples, and command conventions.
6. Explain each changed path and why it is necessary.
7. Flag a diff that exceeds the approved envelope or is materially larger than expected; do not rationalize it after the fact.
8. Never delete, clear, move, or rename. Approved edits may remove obsolete content inside a retained file.

Classify each proposed hunk as required, convention-preserving support, or unnecessary. Remove only unnecessary newly proposed edits when doing so stays inside the approved file operation; never revert user work. If uncertainty remains, report it to the coordinator rather than editing.

This skill carries stable minimalism process only. It does not provide QaaS syntax, versions, or package facts.

See [authoring checklist](../../references/test-authoring/authoring-checklist.md).
