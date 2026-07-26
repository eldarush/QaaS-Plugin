# Documentation source configuration

The plugin has exactly two documentation environment variables:

1. `QAAS_DOCS_HELM_URL`: the QaaS documentation base URL served by the
   organization's Helm/Kubernetes deployment.
2. `QAAS_DOCS_WIKIALL_URL`: the WikiAll URL used both as the optional
   Streamable HTTP MCP endpoint and as the WikiAll HTTP documentation mirror.

Set either or both in the environment that starts Claude Code. The plugin does
not load `.env` files or write environment settings.

```powershell
$env:QAAS_DOCS_HELM_URL = "https://qaas-docs.internal.example/"
$env:QAAS_DOCS_WIKIALL_URL = "https://wikiall.internal.example/qaas/"
```

```bash
export QAAS_DOCS_HELM_URL="https://qaas-docs.internal.example/"
export QAAS_DOCS_WIKIALL_URL="https://wikiall.internal.example/qaas/"
```

Values must be absolute HTTP or HTTPS URLs without credentials, fragments, or
credential-like query data. The WikiAll MCP endpoint must be available without
an application-supplied bearer credential. Do not place secrets in either URL.

The resolver tries one approved WikiAll MCP `docs.search`/`docs.read` capability
pair, Helm HTTP, WikiAll HTTP, then the built-in
`https://docs.qaas.online/` distribution source. In a disconnected environment,
the unreachable public source fails normally; no separate mode selector is
required.

WikiAll MCP bootstrap remains an explicit, one-use, user-reviewed schema probe.
`docs-mcp-discover.mjs` performs only `initialize`,
`notifications/initialized`, and bounded `tools/list`; it cannot invoke a tool
or retry a failed transaction. Signed evidence binds the shared WikiAll URL,
server name, protocol/session mode, bounds, exact tool names, schemas, and
schema digests. The first functional call occurs only after the capability
review is approved and committed.

The packaged `.mcp.json` remains limited to the fixed `qaas_local` safety
encoder. When Claude Code also needs a WikiAll server declaration, use the same
canonical variable in the user's local MCP configuration or a reviewed project
configuration:

```json
{
  "mcpServers": {
    "wikiall_docs": {
      "type": "http",
      "url": "${QAAS_DOCS_WIKIALL_URL}"
    }
  }
}
```

Server presence alone is not authority. The plugin uses WikiAll MCP only after
the exact live schemas have been probed, bounded, reviewed, and committed as
one signed read-only capability pair.

After approved onboarding, `.claude/qaas/integrations.md` may record exact
non-secret endpoint identities, capability IDs, schema digests, and probe
results. `/qaas:doctor` validates and digests both configured selectors without
contacting a source. Only an explicit `docs-read.mjs` query performs a bounded
network read.

HTTP search checks same-base `llms.txt`, `sitemap.xml`, and the homepage in that
order. Index input is capped at 256 KiB; candidate output and a focused page are
each capped at 16 KiB. Credential-bearing links, origin/base-path escapes,
malformed responses, and bound violations fail closed. Only genuine
availability failures advance to the next source.
