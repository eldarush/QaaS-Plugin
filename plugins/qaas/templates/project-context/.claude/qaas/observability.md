# Observability

Observability is recorded only when relevant to an accepted task. Presence here
proves neither connector availability nor query approval. Execution plans keep
`observabilityQueries` empty. Each external read requires a separate canonical
query plan, human review, current successfully probed bounded read-only
capability, and one-use signed approval. An unproven connector blocks access.
The recorded capability/tool/input is a permission contract only. Reads use the
fixed internal project-artifact or remote-GET adapter, bind a sanitized endpoint
identity/value digest, and recheck that binding immediately before access.

| Source | Exact non-secret endpoint or local selector | Credential variable name | Available evidence | Task relevance | Query constraints |
|---|---|---|---|---|---|
| {{SOURCE}} | {{ENDPOINT}} | {{CREDENTIAL_ENV_NAME}} | {{EVIDENCE_TYPE}} | {{RELEVANCE}} | {{CONSTRAINTS}} |

The endpoint column stores the exact credential-free HTTPS base URL reviewed
for the task, or `project-artifact` for local evidence. The credential column
stores only environment-variable names, never values.

## Approved interpretation rules

{{INTERPRETATION_RULES}}

## Unknowns

{{OBSERVABILITY_UNKNOWNS}}
