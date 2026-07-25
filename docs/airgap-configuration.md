# Air-gap configuration

The plugin performs no online installation and needs no endpoint setup for
normal startup or onboarding. Prepare and review every required artifact on a
connected system, transfer it through the organization's approved process, and
keep the disconnected runtime on approved sources.

## Network contract

The distribution contains one centrally reviewed endpoint:

| Capability | Built-in endpoint |
| --- | --- |
| Current QaaS documentation | `https://docs.qaas.online/` |

There is no generic QaaS Artifactory endpoint. Its exact organization-specific
base URL must be reviewed for the current project and operation. The public documentation
endpoint is a zero-setup fallback behind explicitly configured internal
Helm/Kubernetes and WikiAll sources. The plugin contacts no endpoint
automatically or in the background. Loading, hooks, doctor, and general
conversation perform only local validation and digesting. Onboarding may issue
one explicit task-relevant documentation query when a missing QaaS fact
requires it. Every returned documentation or Artifactory result is capped at
16 KiB and recorded with source and excerpt digests. Documentation discovery
may inspect one same-base `llms.txt`, `sitemap.xml`, or homepage index up to
256 KiB; it never returns that index or loads `llms-full.txt`, and the selected
focused page remains subject to the 16 KiB result bound.

The plugin does not perform background network discovery or general-internet
search. Every optional external read requires an exact, user-approved,
task-relevant source.

## Transfer set

The minimum set is:

- A pinned QaaS plugin tag or release ZIP, its SHA-256 checksum, and manifest.
- Claude Code >=2.1.180 and an available Node.js runtime already installed by
  the organization. The plugin does not pin an exact Node major.
- Git only when the project or an approved reference checkout needs it.
- The .NET SDK required by the test project.
- All QaaS and project NuGet packages in the project's configured feed/cache.
- Any Common Hooks packages/source and YAML modules used by the project.
- The test repository and, when relevant, a similar reference project.

Optional tools and integrations are transferred only when a task needs them.
The plugin does not fetch Docker, Helm, kubectl, `glab`, `curl`, an MCP server,
or certificates.

## Verify the plugin

On the transfer boundary, verify the archive before extracting it:

```powershell
$expected = Get-Content "<bundle>.sha256"
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath "<bundle>").Hash.ToLowerInvariant()
$actual
```

Compare the printed digest to the checksum file through the organization's
trusted channel. The `.manifest.json` beside a release bundle contains a digest
for every bundled file. Use the equivalent `sha256sum <bundle>` on Linux.

## Documentation source selectors

Set documentation locations in the environment inherited by Claude Code or in
the organization's managed runtime:

```powershell
$env:QAAS_DOCS_HELM_URL = "https://qaas-docs.internal.example/"
$env:QAAS_DOCS_WIKIALL_URL = "https://wikiall.internal.example/qaas/"
$env:QAAS_DOCS_MCP_URL = "https://wikiall-mcp.internal.example/mcp"
$env:QAAS_DOCS_MCP_CREDENTIAL_ENV = "WIKIALL_DOCS_TOKEN"
$env:QAAS_DOCS_AIRGAP = "true"
$env:QAAS_DOCS_ZIM_PATH = "C:\approved-docs\qaas.zim"
```

The Helm URL identifies documentation already served by an approved
Helm/Kubernetes deployment; the plugin does not deploy or discover that
service. The WikiAll URL identifies its bounded HTTP mirror. The MCP URL is a
Streamable HTTP transport and is usable only when the signed capability
registry proves one complete, read-only, successfully probed
`docs.search`/`docs.read` pair. The credential selector contains only a
separate variable's name. The client accepts a standards-compliant stateless
Streamable HTTP server; when a server issues a valid session identifier, it is
bound to subsequent requests. Multi-event SSE responses are matched to the
exact request ID rather than assuming a single event.

Resolution order is WikiAll MCP, Helm HTTP, WikiAll HTTP, then the public
built-in fallback. `QAAS_DOCS_AIRGAP=true` removes that public fallback
entirely. A raw ZIM path binds only the local artifact identity; queries require
the approved OpenZIM/WikiAll MCP and never pretend to read the file directly.
Invalid, credential-bearing, fragment-bearing, or
conflicting URLs fail closed before a request. `QAAS_DOCS_PRIMARY_URL` and
`QAAS_DOCS_SECONDARY_URL` are deprecated aliases for the Helm and WikiAll HTTP
selectors.

See the packaged [documentation source reference](../plugins/qaas/references/configuration/documentation-sources.md)
for Linux and project MCP examples.

## Optional project-specific sources

Do not configure a global NuGet feed URL. NuGet sources are
derived from the target project's `NuGet.Config`, project/props/targets restore
properties, and restore evidence. If that metadata has no usable HTTP source or
contains several candidates, the plugin asks only for the exact
project-specific source selection.

GitLab, Artifactory, module, and Common Hooks bounded HTTP reads take the exact approved
source through a signed, one-use source-read review. The workflow requests that
URL only when the source is relevant, and binds the base URL, relative
path/query, task/session, endpoint/request digests, output bound, and timeout
before access. It may also pass `--credential-env` with the name of a separate
credential variable; the token itself never enters the command or project
context. Credential-like query keys and high-entropy query values are rejected.
NuGet may use the same credential-name input, but its URL still comes only from
project metadata.

Reference-project checkout and observability locations follow the same
task-relevant rule: use the exact user-approved source in the one operation
that needs it, bind it into approval/provenance, and do not require global
preconfiguration. Leave irrelevant sources absent.

## Optional offline documentation mirror

The built-in docs endpoint requires no setup. A distribution administrator may
instead provision WikiAll with a reviewed local ZIM artifact and a read-only
OpenZIM-compatible MCP capability for a disconnected deployment. This is
optional infrastructure and is configured only when the deployment provides
it.

The MCP capability must be pinned, expose only bounded search/read operations,
and use an exact approved local or internal endpoint. If a preloaded container
is used:

1. Verify its image digest and license on the connected side.
2. Transfer the image and ZIM without allowing a network pull.
3. Mount the ZIM directory read-only.
4. Bind only an approved local/internal interface.
5. Grant only search/read tools.
6. Configure the non-secret selectors above, register and approve the exact
   probed capability schemas, then run `/qaas:doctor` and one explicit
   known-page query.

The plugin does not add destructive container flags, remove containers, or
perform cleanup. A local artifact by itself does not prove version
compatibility; retain its checksum and provenance.

## NuGet, Artifactory, modules, and Common Hooks

The project remains the source of truth for package sources, package
references, and lock/restore evidence. For an upgrade, the plugin reads exact
project-derived feed metadata and never hard-codes a “latest” version.

Modules may be existing local YAML, artifacts retrieved through the exact
reviewed organization Artifactory endpoint, or files in an exact approved
module repository. Common
Hooks may be source already in the project, an installed `QaaS.Common.*`
package, or a package paired with its exact source repository.

Ask for module or Common Hooks locations only when the project uses that
facility. A package name alone is not enough to establish a custom hook's
configuration record and behavior.

## Internal TLS

Install the internal CA where possible. If one exact Git source works only with
certificate verification disabled, the user must acknowledge that risk for a
single source-access operation:

```powershell
git -c http.sslVerify=false clone "<exact-approved-source>" "<approved-destination>"
```

Never disable TLS verification globally or put credentials in the URL.
Checkout creation requires one reviewed approval binding the exact source,
pinned ref, destination, credential-variable names, and TLS risk. The plugin
creates only a protected bare shallow checkout, disables lazy fetch,
submodules, LFS, and working-tree hooks, and exposes content only through
bounded inventory and single-file reads.

## Validation checklist

Run `/qaas:doctor` and confirm:

- The plugin version and active hook digest.
- Node and .NET are available.
- Startup and doctor generated no network request.
- Required project packages restore from project-configured sources.
- One explicit current QaaS documentation query succeeds when egress is
  available.
- Optional tools and sources are available only when the current task needs
  them.
- No credential value appears in `.claude/`, logs, commands, or evidence.

Target-runtime acceptance must be performed on the organization's qualified
Claude Code build with the provided MiniMax gateway before rollout.
