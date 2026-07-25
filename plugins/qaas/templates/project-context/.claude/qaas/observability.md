# Observability

Observability is recorded only when relevant to an accepted task. Presence here
proves neither connector availability nor query approval. Execution plans keep
`observabilityQueries` empty. Each external read requires a separate canonical
query plan, human review, current successfully probed bounded read-only
capability, and one-use signed approval. An unproven connector blocks access.
The recorded capability/tool/input is a permission contract only. Reads use the
fixed internal project-artifact or remote-GET adapter, bind a sanitized endpoint
identity/value digest, and recheck that binding immediately before access.

| Source | Non-secret endpoint identifier | Credential variable name | Available evidence | Task relevance | Query constraints |
|---|---|---|---|---|---|
| {{SOURCE}} | {{ENDPOINT}} | {{CREDENTIAL_ENV_NAME}} | {{EVIDENCE_TYPE}} | {{RELEVANCE}} | {{CONSTRAINTS}} |

The endpoint column stores only a non-secret configured selector identifier,
never a resolved URL or credential. The credential column stores only
environment-variable names.

## Approved interpretation rules

{{INTERPRETATION_RULES}}

## Unknowns

{{OBSERVABILITY_UNKNOWNS}}
