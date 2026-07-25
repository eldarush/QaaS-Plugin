# Air-gap configuration

The plugin performs no online installation. Prepare and review every required
artifact on a connected system, transfer it through the organization's approved
process, and configure only local/internal sources in the disconnected
environment.

## Transfer set

The minimum set is:

- A pinned QaaS plugin tag or release ZIP, its SHA-256 checksum, and manifest.
- Claude Code 2.1.201 and Node.js 24 already installed by the organization.
- On Windows, a reviewed Git for Windows installation (or safe equivalent)
  whose fixed shell can execute `/bin/sh`; the hook configuration depends on
  that command and doctor verifies it with a real process probe.
- The .NET SDK required by the test project.
- All QaaS and project NuGet packages in the internal feed/cache.
- Current QaaS documentation as an internal URL and/or approved ZIM artifact.
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

## Configure non-secret sources

Set only location variables globally or for the Claude Code process:

```powershell
$env:QAAS_DOCS_PRIMARY_URL = "https://docs.internal.example/qaas/"
$env:QAAS_DOCS_SECONDARY_URL = "https://docs-backup.internal.example/qaas/"
$env:QAAS_DOCS_ZIM_PATH = "<local-path-to-qaas-docs.zim>"
$env:QAAS_DOCS_MCP_URL = "http://127.0.0.1:<approved-port>/mcp"
$env:QAAS_DOCS_MCP_CREDENTIAL_ENV = "QAAS_DOCS_MCP_TOKEN"
$env:QAAS_GITLAB_URL = "https://gitlab.internal.example/"
$env:QAAS_GITLAB_CREDENTIAL_ENV = "GITLAB_HTTP_TOKEN"
$env:QAAS_ARTIFACTORY_URL = "https://artifactory.internal.example/"
$env:QAAS_ARTIFACTORY_CREDENTIAL_ENV = "ARTIFACTORY_HTTP_TOKEN"
$env:QAAS_NUGET_FEED_URL = "https://artifactory.internal.example/api/nuget/qaas"
$env:QAAS_NUGET_CREDENTIAL_ENV = "NUGET_HTTP_TOKEN"
$env:QAAS_MODULES_REPO_URL = "https://gitlab.internal.example/qa/modules"
$env:QAAS_MODULES_CREDENTIAL_ENV = "GLAB_TOKEN"
$env:QAAS_COMMON_HOOKS_REPO_URL = "https://gitlab.internal.example/qa/common-hooks"
$env:QAAS_COMMON_HOOKS_CREDENTIAL_ENV = "GLAB_TOKEN"
$env:QAAS_REFERENCE_PROJECT_REPO_URL = "https://gitlab.internal.example/qa/reference-tests"
$env:QAAS_REFERENCE_PROJECT_CREDENTIAL_ENV = "GLAB_TOKEN"
$env:QAAS_TRUSTED_NODE24 = "C:\Program Files\nodejs\node.exe"
```

Linux:

```bash
export QAAS_DOCS_PRIMARY_URL="https://docs.internal.example/qaas/"
export QAAS_DOCS_ZIM_PATH="<local-path-to-qaas-docs.zim>"
export QAAS_DOCS_MCP_URL="http://127.0.0.1:<approved-port>/mcp"
export QAAS_DOCS_MCP_CREDENTIAL_ENV="QAAS_DOCS_MCP_TOKEN"
export QAAS_GITLAB_URL="https://gitlab.internal.example/"
export QAAS_GITLAB_CREDENTIAL_ENV="GITLAB_HTTP_TOKEN"
export QAAS_ARTIFACTORY_URL="https://artifactory.internal.example/"
export QAAS_ARTIFACTORY_CREDENTIAL_ENV="ARTIFACTORY_HTTP_TOKEN"
export QAAS_NUGET_FEED_URL="https://artifactory.internal.example/api/nuget/qaas"
export QAAS_NUGET_CREDENTIAL_ENV="NUGET_HTTP_TOKEN"
export QAAS_MODULES_REPO_URL="https://gitlab.internal.example/qa/modules"
export QAAS_MODULES_CREDENTIAL_ENV="GLAB_TOKEN"
export QAAS_COMMON_HOOKS_REPO_URL="https://gitlab.internal.example/qa/common-hooks"
export QAAS_COMMON_HOOKS_CREDENTIAL_ENV="GLAB_TOKEN"
export QAAS_REFERENCE_PROJECT_REPO_URL="https://gitlab.internal.example/qa/reference-tests"
export QAAS_REFERENCE_PROJECT_CREDENTIAL_ENV="GLAB_TOKEN"
export QAAS_TRUSTED_NODE24="/usr/bin/node"
```

The example hostnames are placeholders. Onboarding records the approved
non-secret location and variable names that actually apply.

Do not place passwords, tokens, private keys, or credential-bearing URLs in
these variables or in project context. Put a credential in a separately named
environment variable or approved credential helper, then tell the plugin only
that variable's name. Source-checkout credential selectors are intentionally
restricted to `GLAB_TOKEN` or `GITLAB_TOKEN`; leave the selector unset for
public sources or Git operations that use an existing credential helper.

`QAAS_TRUSTED_NODE24` is optional. If set, it must be an absolute path to an
organization-reviewed Node 24 executable outside the project, plugin scripts,
and plugin-data directories. Mandatory hooks otherwise probe only fixed system
locations and fail closed; they never execute a project-local or `PATH`-shadowed
Node binary.

## Offline QaaS documentation

An approved OpenZIM-compatible MCP server can expose the local QaaS ZIM through
read-only search/read tools. Configure the server in Claude Code according to
its pinned version and your organization's MCP policy.

For deterministic plugin retrieval, expose the reviewed server through an
approved local/internal Streamable HTTP endpoint in `QAAS_DOCS_MCP_URL`.
`QAAS_DOCS_MCP_CREDENTIAL_ENV`, when needed, contains only the name of the
separate bearer-token environment variable. The bounded helper validates the
signed capability registry against the server's live tool schema, applies
timeouts and byte/item limits, and falls back to the configured documentation
URLs when the MCP source is unavailable. It never persists or prints the token.

If the chosen server is distributed as a preloaded container image:

1. Verify the image digest and license on the connected side.
2. Transfer/load the pinned image and ZIM without allowing a network pull.
3. Mount the directory containing the ZIM read-only.
4. Bind a Streamable HTTP endpoint only to an approved local/internal
   interface, or place a reviewed stdio-to-HTTP adapter in front of a
   stdio-only server.
5. Grant only search/read tools.
6. Run `/qaas:doctor` and a known-page query.

A generic configuration shape is:

```json
{
  "mcpServers": {
    "qaas-docs": {
      "command": "docker",
      "args": [
        "run",
        "-i",
        "-v",
        "<zim-directory>:/data:ro",
        "<approved-image-by-digest>",
        "--mode",
        "advanced"
      ]
    }
  }
}
```

Use the exact arguments documented by the selected, reviewed server. The plugin
does not add `--rm`, remove containers, or perform cleanup. A user may operate a
persistent container according to local policy.

When MCP is unavailable, configure the internal HTTP documentation URL. When
both exist, onboarding records which is primary and proves that it matches the
project's installed QaaS packages. A local path by itself does not prove version
compatibility; provenance/checksum metadata is required.

## NuGet, Artifactory, modules, and Common Hooks

The project remains the source of truth for `NuGet.Config`, package sources, and
package references. For an upgrade, the plugin reads internal feed metadata and
does not hard-code a “latest” version.

Modules may be:

- Existing local YAML.
- YAML artifacts retrieved from Artifactory.
- Files in the approved module source repository.

Common Hooks may be:

- Source already in the project.
- An installed `QaaS.Common.*` package.
- A package from the internal feed, preferably paired with its source
  repository.

Onboarding asks for both repository locations or explicit confirmation that
each facility is unused. A package name alone is not enough to understand a
custom hook's configuration record and behavior.

## Internal TLS

Install the internal CA where possible. If an exact GitLab source works only
with certificate verification disabled, the user must acknowledge that risk
for a single source-access operation. Scope it to the invocation:

```powershell
git -c http.sslVerify=false clone "<approved-source>" "<approved-destination>"
```

Never set `http.sslVerify=false` globally. Never put credentials in the URL.
Source access that creates a checkout is a write and needs one reviewed approval
covering source, pinned ref, destination, credential-variable names, and TLS
risk. The plugin creates only a protected bare shallow checkout at the exact
approved commit, disables lazy fetch, submodules, LFS, and working-tree hooks,
consumes the approval once, and exposes content only through bounded inventory
and single-file reads. It never runs `git pull`.

## Validation checklist

Run `/qaas:doctor` and confirm:

- The plugin version and active hook digest.
- Node and .NET are available.
- Required project packages restore from approved sources.
- A current QaaS documentation query succeeds.
- Optional tools are either available or explicitly irrelevant.
- Common Hooks/module sources are reachable when the project uses them.
- No credential value appears in `.claude/`, logs, commands, or evidence.

Target-runtime acceptance must be performed on Claude Code 2.1.201 with the
provided MiniMax M2.7 gateway before organizational rollout.
