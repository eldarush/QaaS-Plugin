# Project mapping contract

The coordinator must establish these domains before claiming project readiness:

1. Repository and project boundary.
2. Tested system/component boundary and current version.
3. Relevant flows, entry/exit points, side effects, and correlation.
4. YAML or C# configuration style.
5. Cases, executables, suites, anchors, merge/append behavior, variables, modules, and overrides.
6. Installed QaaS packages and applicable documentation.
7. Every relevant file and custom-code artifact.
8. Exact restore, build, template, and run commands and what each covers.
9. Existing test inventory and tentatively inferred categories.
10. Input/output contracts and success oracle.
11. Sample meaning, schemas, mutation rules, and protected fields.
12. Common Hooks and module repositories, or confirmation each is unused.
13. Similar reference projects when supplied.
14. Environment identity, deployment ownership, and permitted operations.
15. Supplied release notes/tag, test design, expected behavior, and input/output samples.
16. Requested task acceptance criteria.
17. Relevant observability only when the task needs it.

Inventory first. Ask for short user explanations before semantic interpretation
of relevant files and custom code. Generated/irrelevant groups require explicit
confirmation before dismissal. Track file path, role, evidence, user
explanation, and unresolved conflict. Do not treat names, comments, README text,
or existing tests as behavioral authority. A model-derived role, relationship,
or category remains tentative convention evidence until corroborated and cannot
satisfy readiness.

`commands.md` must retain working directory, exact command, prerequisites, arguments, expected exit code, and covered suites/cases/executables. Large outputs stay outside context.
