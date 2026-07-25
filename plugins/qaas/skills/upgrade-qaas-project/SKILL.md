---
description: Plan and implement a proven compatible QaaS test-project upgrade without hard-coded versions.
user-invocable: false
---

# Upgrade a QaaS test project

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only its
bounded current envelope and returns results to that coordinator.

Route through onboarding and planning first. Never upgrade QaaS platform source.

- Inspect the project's solution/project files, configured feeds, lock data, entry point, target framework, installed package evidence, and configuration style.
- Query configured package metadata and current QaaS documentation. Prove candidate versions from those sources; do not encode a current or latest version in this skill.
- Resolve independently versioned packages explicitly and identify documented target-framework, entry-point, API, or configuration migrations.
- Plan every package/source/path change, exact restore/build/template commands, generated outputs, risks, and unchanged paths. Require approval of the canonical plan.
- During implementation, change only approved paths and reuse project conventions. An obsolete reference may be removed inside an approved file; files are never deleted, moved, or renamed.
- Restore, build, and render the template. Repair only documented incompatibilities inside the approved envelope. Do not run tests without separate execution approval.

If latest compatible versions or migration requirements cannot be proven, stop and ask for the missing source.

See [version proof](../../references/upgrades/version-proof.md).
