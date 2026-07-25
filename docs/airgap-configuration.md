# Air-gap configuration

The plugin performs no online installation and needs no endpoint setup for
normal startup or onboarding. Prepare and review every required artifact on a
connected system, transfer it through the organization's approved process, and
keep the disconnected runtime on approved sources.

## Network contract

The distribution contains two centrally reviewed endpoints:

| Capability | Built-in endpoint |
| --- | --- |
| Current QaaS documentation | `https://docs.qaas.online/` |
| QaaS Artifactory reads | `https://jfrog.com/artifactory/` |

They are runtime-immutable and have no environment-variable overrides. The
plugin contacts neither endpoint automatically or in the background. Loading,
hooks, doctor, and general conversation do not contact them. Onboarding may
issue an explicit task-relevant documentation query when a missing QaaS fact
requires one. Every bounded documentation or Artifactory response is capped at
16 KiB and recorded with endpoint and excerpt digests.

An organization-specific disconnected distribution may replace these values
only as a reviewed distribution-build change in
`plugins/qaas/scripts/lib/built-in-endpoints.mjs`. Do not patch them per
project, add a runtime override, or prompt users for replacements.

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

## Optional project-specific sources

Do not configure a docs URL, Artifactory URL, or NuGet feed URL. NuGet sources
are derived from the target project's `NuGet.Config`, project/props/targets
restore properties, and restore evidence. If that metadata has no usable HTTP
source or contains several candidates, the plugin asks only for the exact
project-specific source selection.

GitLab, module, and Common Hooks bounded HTTP reads take the exact approved
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
also provision a reviewed local ZIM artifact or read-only OpenZIM-compatible
MCP capability for a disconnected deployment. This is optional infrastructure,
not an onboarding question and not a runtime replacement for the built-in
endpoint.

The MCP capability must be pinned, expose only bounded search/read operations,
and use an exact approved local or internal endpoint. If a preloaded container
is used:

1. Verify its image digest and license on the connected side.
2. Transfer the image and ZIM without allowing a network pull.
3. Mount the ZIM directory read-only.
4. Bind only an approved local/internal interface.
5. Grant only search/read tools.
6. Run `/qaas:doctor` and one explicit known-page query.

The plugin does not add destructive container flags, remove containers, or
perform cleanup. A local artifact by itself does not prove version
compatibility; retain its checksum and provenance.

## NuGet, Artifactory, modules, and Common Hooks

The project remains the source of truth for package sources, package
references, and lock/restore evidence. For an upgrade, the plugin reads exact
project-derived feed metadata and never hard-codes a “latest” version.

Modules may be existing local YAML, artifacts retrieved through the built-in
Artifactory endpoint, or files in an exact approved module repository. Common
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

Target-runtime acceptance must be performed on Claude Code >=2.1.180 with the
provided MiniMax M2.7 gateway before organizational rollout.
