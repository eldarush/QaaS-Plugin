# Integrations

Store only approved non-secret identifiers and environment-variable names, never credential values.

| Logical capability | Source/server identifier | Read/write classification | Exact non-secret endpoint or local selector | Credential variable names | Approved schema/adapter | Probe result |
|---|---|---|---|---|---|---|
| {{CAPABILITY}} | {{SOURCE}} | {{CLASSIFICATION}} | {{ENDPOINT_SELECTOR_ID}} | {{ENV_NAMES}} | {{ADAPTER_OR_SCHEMA}} | {{PROBE_RESULT}} |

For observability, record the exact credential-free HTTPS base URL supplied for
the approved task, or `project-artifact` for local evidence. Never record a URL
containing credentials. A recorded capability does not grant access; each
external read needs its own current one-use query-plan approval.

## Documentation sources

| Priority | Source | Configuration selector | Exact approved non-secret identity |
|---|---|---|---|
| 1 | Proven WikiAll MCP `docs.search`/`docs.read` pair | `QAAS_DOCS_WIKIALL_URL` | {{WIKIALL_MCP_ENDPOINT_CAPABILITY_AND_SCHEMA_DIGESTS_OR_NOT_CONFIGURED}} |
| 2 | Helm/Kubernetes QaaS docs | `QAAS_DOCS_HELM_URL` | {{QAAS_DOCS_HELM_ENDPOINT_OR_NOT_CONFIGURED}} |
| 3 | WikiAll HTTP docs | `QAAS_DOCS_WIKIALL_URL` | {{QAAS_DOCS_WIKIALL_ENDPOINT_OR_NOT_CONFIGURED}} |
| 4 | Public distribution fallback | built in | `https://docs.qaas.online/` |

Record only endpoint identities, selector names, capability/schema digests,
and probe results approved during onboarding. Never record a credential value.
Startup, hooks, doctor, and general conversation contact none of these sources;
only one explicit focused documentation query may read them.

## Other project endpoints

| Logical capability | Exact reviewed endpoint | Network use |
|---|---|---|
| QaaS Artifactory | {{QAAS_ARTIFACTORY_ENDPOINT_OR_NOT_CONFIGURED}} | Explicit focused, one-use approved Artifactory query only |

## Optional project-specific sources

{{EXACT_USER_APPROVED_GITLAB_MODULE_HOOK_REFERENCE_AND_OBSERVABILITY_SOURCES}}

GitLab, Artifactory, module, and Common Hooks bounded reads receive an exact reviewed
`--base-url` only when the current task needs that source. An optional
`--credential-env` contains only the selected credential variable's name.
Neither input is global startup configuration.

NuGet endpoints are derived from the target project's `NuGet.Config`, restore
properties, and restore evidence. If several sources are evidenced, record the
user's exact project-specific selection. Artifactory has no public distribution
default. Ask for one reviewed Artifactory `--base-url` and optional credential
variable name only when the current task needs it.
