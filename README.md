# QaaS Plugin for Claude Code

Firefly's local-first Claude Code plugin for planning, implementing, running,
and diagnosing QaaS tests. It learns each test repository before editing,
uses QaaS documentation as authority, and stops when required facts are
missing.

## Start in 60 seconds

Add this repository as a marketplace, then install the plugin:

```text
/plugin marketplace add TheSmokeTeam/QaaS-Plugin
/plugin install qaas@qaas-plugin
```

For the strongest onboarding, select `/effort xhigh` and tell Claude to
**use dynamic workflow**. Then run:

```text
/qaas:doctor
/qaas:onboard
```

Onboarding scans the current project, interviews you one question at a time,
and writes the approved project model under `.claude/qaas/`.

## Contents

- [Documentation sources](#documentation-sources)
- [Workflow](#workflow)
- [Commands](#commands)
- [Safety](#safety)
- [Local validation](#local-validation)

## Documentation sources

There are exactly two QaaS documentation variables:

| Variable | Purpose |
| --- | --- |
| `QAAS_DOCS_HELM_URL` | Base URL of the QaaS documentation deployment. |
| `QAAS_DOCS_WIKIALL_URL` | WikiAll documentation URL or approved Streamable HTTP MCP endpoint. |

PowerShell:

```powershell
$env:QAAS_DOCS_HELM_URL = "https://qaas-docs.internal.example/"
$env:QAAS_DOCS_WIKIALL_URL = "https://wikiall.internal.example/qaas/"
```

Linux:

```bash
export QAAS_DOCS_HELM_URL="https://qaas-docs.internal.example/"
export QAAS_DOCS_WIKIALL_URL="https://wikiall.internal.example/qaas/"
```

Both variables are optional. When configured, they take priority over the
built-in public QaaS documentation URL. The WikiAll value can be used as an
HTTP mirror or probed as an MCP endpoint after approval. URLs must use HTTP or
HTTPS and must not contain credentials.

## Workflow

1. `/qaas:doctor` checks the local toolchain and plugin integrity.
2. `/qaas:onboard` maps the repository, tested system, samples, hooks,
   modules, commands, conventions, and verification signals.
3. Claude asks for missing facts one question at a time and records only
   approved project facts.
4. `/qaas:plan` produces an exact file-and-behavior plan for review.
5. `/qaas:implement` applies the approved minimal change.
6. `/qaas:run` requests execution approval, runs only the approved commands,
   and evaluates the agreed evidence.
7. `/qaas:diagnose` investigates failures without guessing whether the
   problem is the test, environment, or system under test.

If the repository changes in an unexplained way, the workflow becomes stale
and returns to clarification before further implementation.

## Commands

| Command | Purpose |
| --- | --- |
| `/qaas:doctor` | Check plugin, runtime, and documentation configuration. |
| `/qaas:onboard` | Build or refresh project understanding. |
| `/qaas:plan` | Create a reviewable implementation or repair plan. |
| `/qaas:implement` | Apply an approved plan with minimal changes. |
| `/qaas:run` | Execute and verify an approved test command. |
| `/qaas:diagnose` | Investigate failed builds, templates, runs, or assertions. |

Natural requests such as “add this logic case,” “write a custom assertion,”
“fix this test,” or “upgrade this project” route through the same gates.

## Safety

- Project reads are allowed during onboarding.
- No implementation starts without complete project context and an approved
  plan.
- Build, template, and test execution use explicit reviewed commands.
- Observability and infrastructure access require separate approval.
- Deletion is never performed by the plugin.
- QaaS documentation outranks user descriptions, which outrank patterns in
  existing tests.
- Unsupported QaaS behavior is reported instead of invented.

The plugin works locally and does not require GitHub, GitLab, Docker,
Kubernetes, or internet access at runtime. It uses integrations only when
they are already available and the user authorizes them.

## Local validation

Node.js is the only repository validation dependency:

```text
npm run check
```

The command validates manifests and authored instructions, runs the complete
self-test suite, audits the public tree, checks context budgets, and creates a
deterministic plugin ZIP under `dist/`.

The repository intentionally has no project license. Required third-party
attribution is retained in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
