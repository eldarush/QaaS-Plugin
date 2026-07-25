---
description: Internal upgrade specialist used only when qaas-workflow delegates an approved, evidence-backed QaaS test-project and .NET/package migration.
user-invocable: false
---

# Upgrade a QaaS test project

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns results to that coordinator.

Route through onboarding and planning first. Never upgrade QaaS platform source.

- Inspect the project's solution/project files, `NuGet.Config`,
  project/props/targets restore properties, lock and restore data, entry point,
  target framework, installed package evidence, and configuration style.
- Query package metadata through the exact source evidenced by that project and
  query current QaaS documentation through the immutable distribution endpoint.
  Neither source is contacted during startup or onboarding. Prove candidate
  versions from those sources; do not encode a current or latest version in
  this skill.
- Resolve independently versioned packages explicitly and identify documented target-framework, entry-point, API, or configuration migrations.
- Plan every package/source/path change, exact restore/build/template commands, generated outputs, risks, and unchanged paths. Require approval of the canonical plan.
- During implementation, change only approved paths and reuse project conventions. An obsolete reference may be removed inside an approved file; files are never deleted, moved, or renamed.
- Obtain exact deterministic restore/build/template handoffs for the user to
  run, then import bounded evidence. The plugin never launches these processes.
  Repair only documented incompatibilities inside the approved envelope.
  Prepare a test handoff only after separate execution approval.

Do not ask for a docs URL, Artifactory URL, global GitLab URL, or global NuGet
feed. When project metadata contains no usable package source or several
candidates, stop and ask only for the exact project-specific NuGet source
selection. If migration requirements still cannot be proven, ask for the
specific missing project evidence.

See [version proof](../../references/upgrades/version-proof.md).
