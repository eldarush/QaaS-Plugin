# Bounded read-only observability

Only when the accepted oracle needs task-relevant external evidence, encode and
stage one complete `query-plan.schema.json` document bound to the exact
execution-plan digest and current fingerprint:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind query --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind query
```

Apply the [review transaction](review-and-safety.md#review-transaction). The
human-readable review must show every exact provider, capability ID, tool,
bounded input, exact non-secret endpoint or local selector, credential-variable
name, purpose, limit, and typed response check. Then and only then consume the
approval once:

The displayed exact tool input is limited to 16 KiB canonical UTF-8, depth
eight, and 100 entries per object or array. Its recorded `toolInputDigest` must
equal the SHA-256 of that canonical object.

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/query-approved.mjs" --session-handle <handle>
```

The exact capability must be present in the current approved registry,
successfully probed, bounded, and proven read-only for the named provider. An
absent, stale, opaque, write-capable, or otherwise unproven connector blocks
the query. Never fall back to a direct MCP call, browser request, CLI, shell
command, Kubernetes client, or database client. The capability/tool/input is a
permission contract only: execution uses fixed internal adapter
`qaas-internal-project-artifact-v1` for Allure or
`qaas-internal-http-get-v1` for remote GET. The reviewed binding includes a
sanitized endpoint identity and endpoint-value digest and is recomputed before
the read. A retry or any changed query, connector, endpoint, bound, check,
execution digest, or fingerprint requires a new plan and approval. See
[bounded query transaction](../query-plan.md).
