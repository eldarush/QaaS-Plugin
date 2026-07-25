# Integrations

Store only approved non-secret identifiers and environment-variable names, never credential values.

| Logical capability | Source/server identifier | Read/write classification | Exact non-secret endpoint or local selector | Credential variable names | Approved schema/adapter | Probe result |
|---|---|---|---|---|---|---|
| {{CAPABILITY}} | {{SOURCE}} | {{CLASSIFICATION}} | {{ENDPOINT_SELECTOR_ID}} | {{ENV_NAMES}} | {{ADAPTER_OR_SCHEMA}} | {{PROBE_RESULT}} |

For observability, record the exact credential-free HTTPS base URL supplied for
the approved task, or `project-artifact` for local evidence. Never record a URL
containing credentials. A recorded capability does not grant access; each
external read needs its own current one-use query-plan approval.

## Built-in distribution endpoints

| Logical capability | Immutable endpoint | Network use |
|---|---|---|
| QaaS documentation | `https://docs.qaas.online/` | Explicit focused documentation query only |
| QaaS Artifactory | `https://jfrog.com/artifactory/` | Explicit focused Artifactory query only |

These values require no project setup and are not onboarding questions.
Startup, hooks, doctor, and general conversation do not contact them.

## Optional project-specific sources

{{EXACT_USER_APPROVED_GITLAB_MODULE_HOOK_REFERENCE_AND_OBSERVABILITY_SOURCES}}

GitLab, module, and Common Hooks bounded reads receive an exact reviewed
`--base-url` only when the current task needs that source. An optional
`--credential-env` contains only the selected credential variable's name.
Neither input is global startup configuration.

NuGet endpoints are derived from the target project's `NuGet.Config`, restore
properties, and restore evidence. If several sources are evidenced, record the
user's exact project-specific selection. Do not record or request a global docs,
Artifactory, or NuGet URL.
