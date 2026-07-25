# Documentation source configuration

The plugin resolves one focused QaaS documentation query in this order:

1. One approved, successfully probed WikiAll MCP `docs.search`/`docs.read`
   capability pair from the signed capability registry.
2. `QAAS_DOCS_HELM_URL`, the base URL of QaaS documentation served by the
   organization's Helm/Kubernetes deployment.
3. `QAAS_DOCS_WIKIALL_URL`, the base URL of a WikiAll-hosted HTTP mirror.
4. The public `https://docs.qaas.online/` distribution default, unless
   `QAAS_DOCS_AIRGAP=true`.

Set only the sources the deployment actually provides. Values are inherited
from the environment that starts Claude Code; the plugin does not load `.env`
files or write environment settings. In a disconnected deployment, set
`QAAS_DOCS_AIRGAP=true`; public fallback is then absent rather than attempted.

```powershell
$env:QAAS_DOCS_HELM_URL = "https://qaas-docs.internal.example/"
$env:QAAS_DOCS_WIKIALL_URL = "https://wikiall.internal.example/qaas/"
$env:QAAS_DOCS_MCP_URL = "https://wikiall-mcp.internal.example/mcp"
$env:QAAS_DOCS_MCP_CREDENTIAL_ENV = "WIKIALL_DOCS_TOKEN"
$env:QAAS_DOCS_AIRGAP = "true"
$env:QAAS_DOCS_ZIM_PATH = "C:\approved-docs\qaas.zim"
```

```bash
export QAAS_DOCS_HELM_URL="https://qaas-docs.internal.example/"
export QAAS_DOCS_WIKIALL_URL="https://wikiall.internal.example/qaas/"
export QAAS_DOCS_MCP_URL="https://wikiall-mcp.internal.example/mcp"
export QAAS_DOCS_MCP_CREDENTIAL_ENV="WIKIALL_DOCS_TOKEN"
export QAAS_DOCS_AIRGAP="true"
export QAAS_DOCS_ZIM_PATH="/opt/approved-docs/qaas.zim"
```

`QAAS_DOCS_ZIM_PATH` records and revalidates one local artifact identity only.
It is not a reader or fallback. To query that artifact, expose it through the
approved OpenZIM/WikiAll MCP configured by `QAAS_DOCS_MCP_URL`. If no bounded
reader is configured, the plugin stops instead of pretending the ZIM was read.

`QAAS_DOCS_MCP_CREDENTIAL_ENV` contains only the name of a separate bearer
credential variable. Never put its value in a URL, project file, command,
capability registry, or QaaS context. A credentialed MCP transport must use
HTTPS or an explicit loopback endpoint. Unauthenticated deployments omit it.
The transport may be stateless. If the server returns a valid
`Mcp-Session-Id`, the helper includes it on later requests; it never requires
one. JSON and multi-event SSE responses are accepted only when exactly one
response matches the current JSON-RPC request ID.

WikiAll MCP bootstrap is an explicit, one-use, user-reviewed schema probe.
`docs-mcp-discover.mjs` performs only `initialize`,
`notifications/initialized`, and bounded `tools/list`; it cannot invoke a
tool or retry a failed transaction. The reviewed timeout covers the complete
three-operation transaction, and the reviewed output limit is an aggregate
cap across all three response bodies. The fixed reviewed request limit is
three. The signed evidence binds the
endpoint/credential-selector identity, server name, negotiated protocol,
stateful/stateless mode, bounds, exact tool names, input schemas, and schema
digests. In a capability,
`probePassed: true` means this schema probe succeeded; the accompanying
`probeEvidenceDigest` must match. It does not claim that `docs.search` or
`docs.read` has already executed. The first functional call occurs only after
the capability review is approved and committed.

The packaged `.mcp.json` remains limited to the fixed `qaas_local` safety
encoder. If the organization also exposes WikiAll to Claude Code for capability
discovery, place the non-secret server declaration in the user's local MCP
configuration or an explicitly reviewed project `.mcp.json`, for example:

```json
{
  "mcpServers": {
    "wikiall_docs": {
      "type": "http",
      "url": "${QAAS_DOCS_MCP_URL}"
    }
  }
}
```

Adapt authentication only through the pinned server's reviewed configuration;
do not commit a credential. Server presence alone is not authority. The plugin
uses WikiAll only after the exact live tool schemas have been probed, bounded,
reviewed, and committed as one signed read-only capability pair. Tool names and
input fields are copied from that registry and are never guessed.

After approved onboarding, `.claude/qaas/integrations.md` may record the exact
non-secret endpoint identities, selector names, capability IDs, schema digests,
and probe result. It must not contain credential values. `/qaas:doctor` validates
and digests the configured selectors without contacting any source; only an
explicit `docs-read.mjs` query performs a bounded network read.

HTTP search checks same-base `llms.txt`, `sitemap.xml`, and the homepage in
that order. An index input is capped at 256 KiB and never returned to the
model; candidate output and the subsequent focused page are each capped at
16 KiB. Credential-bearing links, origin/base-path escapes, malformed
responses, and bound violations fail closed. Only genuine availability errors
advance to the next configured source.

Every HTTP candidate includes its exact source selector. A focused HTTP read
must pass the returned absolute URL and selector together; the resolver reads
only that source and rejects configuration drift instead of retrying a
higher-priority mirror. WikiAll MCP identifiers remain bound to the signed
`docs.read` capability and do not use an HTTP source selector.

For migration only, `QAAS_DOCS_PRIMARY_URL` is a deprecated alias for
`QAAS_DOCS_HELM_URL`, and `QAAS_DOCS_SECONDARY_URL` is a deprecated alias for
`QAAS_DOCS_WIKIALL_URL`. A canonical selector and its alias may coexist only
when they normalize to the same URL; a conflict fails closed.
