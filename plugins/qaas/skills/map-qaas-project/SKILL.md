---
description: Build a read-only evidence map and readiness matrix for an existing QaaS test repository.
user-invocable: false
---

# Map a QaaS project

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill returns bounded
findings to that coordinator and never grants readiness itself.

Run only under the onboarding phase. Before context approval, do not write anywhere in the project.

- Canonicalize one test-repository boundary and reject paths that escape it.
- Inventory files as relevant, generated, vendor, or unknown. Do not silently dismiss unknown groups.
- Ask the user, through the coordinator, for a short explanation before semantically interpreting each relevant file or custom-code group. One question per turn; follow up incomplete answers.
- Map YAML or C# style, configuration composition, suites, cases, executables, anchors, variables, modules, samples, custom hooks, package evidence, exact commands, environments, tested flows, success oracles, and conventions without inventing semantics.
- Obtain Common Hooks and module repositories, or explicit confirmation that each is unused. Similar projects are optional read-only style evidence.
- Record contradictions and unknowns rather than resolving them from filenames, comments, or README claims.
- Label every model-derived classification or relationship as tentative convention evidence until current documentation, signed runtime/project evidence, or direct user clarification corroborates it. A tentative inference cannot set a readiness domain to `evidenced`, `user_confirmed`, or `not_applicable`.
- Delegate large read-only inventories to `project-mapper` or `configuration-tracer`; they cannot question the user or grant readiness.

Return concise findings with file paths and evidence locations. Populate readiness statuses only as `evidenced`, `user_confirmed`, `not_applicable`, `unknown`, or `contradicted`. Readiness is complete only when all required items are in the first three states, no conflict remains, required sources are accessible, and the user approves the complete restatement.

See [project mapping contract](../../references/project-mapping/project-model.md).
