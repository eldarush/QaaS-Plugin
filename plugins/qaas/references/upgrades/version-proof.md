# Upgrade version proof

No package version is current merely because it appears in this plugin, model memory, or an example.

Current QaaS documentation uses the attested source order: a proven WikiAll MCP
pair, `QAAS_DOCS_HELM_URL`, `QAAS_DOCS_WIKIALL_URL`, then the public
`https://docs.qaas.online/` fallback. The WikiAll selector supplies both its
optional Streamable HTTP MCP endpoint and its HTTP mirror.
QaaS Artifactory reads use the exact project-relevant organization base URL in
one reviewed request; no generic public Artifactory endpoint exists. Every
source is contacted only by an explicit focused query.

NuGet source evidence comes from the target project's `NuGet.Config`,
project/props/targets restore properties, lock data, and restore metadata. Do
not infer or invent a feed URL. If project metadata has no usable HTTP source or
contains several candidates, ask only for the exact project-specific source
selection.

For each package or target-framework change, record:

- current project/lock/configured-feed evidence
- configured source and retrieval timestamp
- available-version metadata or immutable artifact digest
- applicable current QaaS documentation
- compatibility constraints and decision
- independently versioned dependencies
- required entry-point, API, target-framework, or configuration migration
- exact planned file and source changes
- exact restore/build/template user-run handoffs and bounded imported evidence

If latest compatible cannot be proven, ask for the specific missing project
evidence. Documentation URL configuration uses only the canonical approved
selectors; never improvise another source, ask for a replacement Artifactory
URL, use general-internet discovery, or fetch or modify QaaS platform source.

Upgrade approval must bind every source, package, path, command, generated-output class, risk, and unchanged path. Static verification does not authorize execution.
