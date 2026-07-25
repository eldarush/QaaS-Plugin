# Integrations

Store only approved non-secret identifiers and environment-variable names, never credential values.

| Logical capability | Source/server identifier | Read/write classification | Endpoint selector identifier | Credential variable names | Approved schema/adapter | Probe result |
|---|---|---|---|---|---|---|
| {{CAPABILITY}} | {{SOURCE}} | {{CLASSIFICATION}} | {{ENDPOINT_SELECTOR_ID}} | {{ENV_NAMES}} | {{ADAPTER_OR_SCHEMA}} | {{PROBE_RESULT}} |

An endpoint selector is a non-secret identifier such as
`QAAS_REPORTPORTAL_URL` or `project-artifact`, never the resolved URL, path,
host, or credential. A recorded capability does not grant access; each external
read needs its own current one-use query-plan approval.

## Documentation sources

{{PRIMARY_SECONDARY_AND_OFFLINE_DOC_SOURCES}}

## Repository and package sources

{{GITLAB_ARTIFACTORY_NUGET_MODULE_AND_HOOK_SOURCES}}
