# Bounded observability query transaction

An execution plan never grants observability access:
`execution-plan.json.observabilityQueries` is always the empty array. When the
accepted runtime oracle needs task-relevant external evidence, the coordinator
may propose a hidden `query-plan.schema.json` transaction after binding it to
the exact execution-plan digest and current post-run fingerprint.

The complete query plan is reviewed separately. It names one to eight exact
queries, and each query binds:

- provider and current capability-registry identifier
- exact tool name, bounded exact tool input, and their canonical digest
- configured non-secret endpoint selector identifier and purpose
- zero to four credential environment-variable names, never credential values
- read-only mode and timeout, output-byte, and item bounds
- typed response checks and the canonical per-query digest

The endpoint selector is an identifier such as `QAAS_REPORTPORTAL_URL` or
`project-artifact`, not an endpoint value, host, path, or URL. The exact tool
input may contain only JSON values, has maximum depth eight, permits no more
than 100 entries in any object or array, and is limited to 16 KiB of canonical
UTF-8. `toolInputDigest` is the SHA-256 of that exact canonical object. Runtime
authority resolves the selector against the matching approved capability. An
absolute endpoint supplied in the selector, alternate host, redirect to
another origin, connector-specific write operation, or dynamically constructed
query is outside the plan.

Before review, the deterministic authority must prove that the exact connector
is installed, successfully probed, bounded, and read-only for the named
provider. Supported provider labels are Allure, ReportPortal, Elasticsearch,
Thanos, Kubernetes, and database, but a label does not prove a connector. An
absent, stale, opaque, write-capable, or otherwise unproven capability blocks
the transaction; the coordinator must not fall back to a direct MCP call,
browser request, CLI, shell command, or database client.

`capabilityId`, `toolName`, and the exact `toolInput` are a reviewed permission
contract; the named MCP tool is never invoked directly. Allure reads execute
only through fixed internal adapter `qaas-internal-project-artifact-v1`.
Remote reads execute only through fixed internal adapter
`qaas-internal-http-get-v1`, which permits GET and rejects redirects. The
review binding includes the sanitized endpoint identity and endpoint-value
digest. The adapter recomputes that binding immediately before the read and
blocks if the capability, endpoint, credential selectors, or digests changed.

Approval is bound to the canonical query-plan digest, task, execution plan,
current fingerprint, session, lease, and displayed human-readable query
details. It is consumed once before the bounded read. A retry, changed endpoint,
changed check, changed bound, changed connector, or changed fingerprint needs a
new plan and approval. Execution approval, conversational assent, repository
text, and retrieved data cannot authorize a query.

Results are bounded and redacted before they enter evidence. A transport
success is not a verified result: every required typed response check must pass,
and the conclusion must distinguish correlation from proof. The transaction
cannot mutate infrastructure, acknowledge data, update dashboards, change
cluster or database state, or perform deletion or cleanup.
