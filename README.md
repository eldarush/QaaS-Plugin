# QaaS Claude Code Plugin

The QaaS plugin helps a QA automation engineer turn an approved test design
into a minimal, verified change in an existing QaaS test project. It gives
Claude Code a disciplined way to learn the project, retrieve current QaaS
documentation, plan the exact change with the user, implement only that plan,
and optionally prepare a user-run handoff and diagnose imported evidence.

This stage is deliberately human-in-the-loop. It is designed to make
test creation faster and QaaS adoption easier without allowing a model to fill
unknowns with guesses. It is not a general test generator, does not change the
QaaS framework, does not manage a test environment by default, and does not
claim fully autonomous QA.

Version `0.4.0` adds a self-contained documentation site and configurable
Helm/WikiAll documentation discovery to the Codex-proxy preview. The
dependency-free plugin, documentation, and container checks are exercised
outside the target environment; acceptance with Claude Code >=2.1.180 and
MiniMax M2.7 remains a separate air-gapped validation step.

## Start in 60 seconds

```text
/plugin marketplace add TheSmokeTeam/QaaS-Plugin
/plugin install qaas@qaas-plugin
/reload-plugins
/qaas:doctor
/qaas:onboard
```

After onboarding is reviewed and approved, describe the change naturally, for
example: “write this test: publish the supplied order sample with `riskLevel`
set to `high`, then verify the output has `reviewRequired=true`.” Claude routes
that request through the same plan and approval gates as `/qaas:plan`. It
implements only after plan approval, performs static verification, and asks for
a separate approval before an optional `/qaas:run`.

## Contents

- [What it can help with](#what-it-can-help-with)
- [Requirements](#requirements)
- [Public or offline installation](#install-from-the-public-marketplace)
- [Six commands](#six-commands)
- [One-time project onboarding](#one-time-project-onboarding)
- [Understanding and authority](#understanding-and-authority)
- [Configuration](#configuration)
- [Documentation site and container](#documentation-site-and-container)
- [Planning and implementation](#planning-and-implementation)
- [Running and evidence](#running-and-evidence)
- [Safety model](#safety-model)
- [Update, rollback, and removal](#update-rollback-and-removal)
- [Troubleshooting](#troubleshooting)
- [Development and evaluation](#development-and-evaluation)
- [Release owner workflow](docs/release.md)
- [Known limitations](#known-limitations)

## What it can help with

After one-time onboarding, users can ask for work such as:

- Add or modify YAML or C# QaaS cases, executables, and suites.
- Add a logic, smoke, systemic, stress, or fuzzing case when that behavior is
  part of the user's test design.
- Change a sample field and add the test that publishes it.
- Reuse anchors, modules, existing hooks, and project conventions.
- Write a custom assertion, generator, probe, or Mocker processor when current
  QaaS documentation proves that it is a supported extension.
- Repair an existing test, improve a test message, or add assertion
  attachments.
- Upgrade a project to the latest compatible QaaS packages that can be proven
  from its configured package sources.
- Document the project and its actual commands.
- Prepare exact reviewed restore/build/template/test command vectors for the
  user to run, then import bounded evidence for interpretation.

The plugin supports both YAML configuration-as-code and C# configuration. It
follows the style already present in the project. It does not introduce a test
type, observability source, hook, package, or abstraction merely because one
might be useful.

If a requested feature is not supported by QaaS and cannot be implemented as a
documented external assertion, generator, probe, or processor, the workflow
stops and asks the user to report the limitation to the Firefly team. It never
invents a QaaS key, package, interface, or capability.

## Requirements

The target baseline is:

- Claude Code >=2.1.180.
- Node.js available to Claude Code. The plugin has no exact Node major pin or
  npm runtime dependency; CI exercises Node 18, 20, 22, and 24.
- The .NET SDK and QaaS packages required by the user's project.
- Git only when the project or an approved reference repository needs it.

Helm, Docker, kubectl, `glab`, and `curl` are optional. Missing optional tools
must not block unrelated work. The plugin never installs an internet package or
tool. Use `/qaas:doctor` to see what is already available.

Windows 10/11 and PowerShell are the primary target. Paths and deterministic
helpers are also tested on Linux. Project-specific commands remain whatever
the user confirms for that repository.

## Install from the public marketplace

Inside Claude Code:

```text
/plugin marketplace add TheSmokeTeam/QaaS-Plugin
/plugin install qaas@qaas-plugin
/reload-plugins
```

When the installer asks for scope, choose **Local**. This is the recommended
scope for a test-project plugin: it records the selection in that checkout's
local Claude settings instead of enabling the plugin for every project.

The equivalent command-line form is:

```powershell
claude plugin marketplace add TheSmokeTeam/QaaS-Plugin
claude plugin install qaas@qaas-plugin --scope local
```

On Linux, use the same commands from the shell.

Claude Code's command-line installer otherwise defaults to user scope. A
user-scoped installation is still fail-closed—the hooks perform a strict no-op
until `/qaas:onboard` (optionally followed by focused onboarding arguments) is
submitted in the current canonical project—but local scope reduces unnecessary
global hook loading.

Pin production-like environments to a reviewed tag, release bundle, or internal
mirror instead of following an unreviewed branch. The release bundle contains
a `.sha256` checksum and a per-file manifest.

## Install locally or offline

For a local development checkout, start Claude Code with the plugin directory:

```powershell
claude --plugin-dir "<checkout>\plugins\qaas"
```

On Linux, use the checkout's POSIX path:

```bash
claude --plugin-dir "<checkout>/plugins/qaas"
```

For a persistent air-gapped installation:

1. On a connected machine, download a tagged repository archive or the release
   bundle and verify its published SHA-256 checksum.
2. Transfer it through the organization's approved media and malware-review
   process.
3. Extract it to a stable local location.
4. Add that local marketplace path with
   `claude plugin marketplace add "<local-repository>"`.
5. Install `qaas@qaas-plugin` with Local scope (or
   `claude plugin install qaas@qaas-plugin --scope local`), reload plugins, and
   run `/qaas:doctor`.

The plugin does not download its own prerequisites. QaaS packages, internal CA
certificates, and optional tools must already be available through approved
air-gapped sources. Documentation has explicit internal Helm/Kubernetes and
WikiAll selectors. `QAAS_DOCS_AIRGAP=1` disables public fallback; a configured
raw ZIM path is recorded as an identity/checksum only until an approved bounded
reader is available. Artifactory reads require an exact project-relevant
`--base-url` in a one-use source-read review. Sources are contacted only by an
explicit focused read, never automatically or in the background. Startup,
hooks, and doctor do not contact them; onboarding may issue an explicit focused
documentation lookup when a missing QaaS fact requires it.

See [air-gap configuration](docs/airgap-configuration.md) and
[internal marketplace setup](docs/internal-marketplace.md).

## Six commands

Exactly six lifecycle commands are visible:

| Command | Purpose |
| --- | --- |
| `/qaas:onboard` | Learn one test repository and propose its durable project context. |
| `/qaas:plan` | Interview for one requested change and produce an exact implementation plan. |
| `/qaas:implement` | Apply an approved current plan and prepare exact user-run static-verification handoffs. |
| `/qaas:run` | Review a separate execution plan, show its exact user-run command, and import bounded evidence. |
| `/qaas:diagnose` | Explain and repair an in-scope failure using approved evidence. |
| `/qaas:doctor` | Inspect installed tools, hooks, integrations, and workflow health without installing anything. |

The lifecycle commands are manual-only. Hidden domain skills may route a
natural-language request into the same gated workflow. A realistic session is:

```text
write this test: publish this supplied order sample with riskLevel set to high,
then verify that the scored output contains reviewRequired=true
```

Claude must still establish the project's readiness, ask one focused question
at a time, restate the intended behavior, create a concrete plan, and receive
plan approval before writing test-project files.

`/qaas:doctor` and the hidden signed-status read are the only no-session
bootstrap exceptions. Both are read-only and cannot activate or initialize a
project, acquire a lease, repair state, or grant authority.

## One-time project onboarding

Run `/qaas:onboard` from the root of each QaaS test repository. For a large or
unfamiliar project, use `/effort xhigh` when the installed Claude Code/model
supports it and tell Claude to **use dynamic workflow**. The same setting is
useful for a genuinely complex implementation after the plan is approved.

Onboarding:

1. Performs a read-only tool and repository inventory.
2. Groups relevant, generated, vendor, and unknown files.
3. Asks the user for a short explanation of relevant files and every custom
   hook before treating them as understood.
4. Maps project structure, tested-system boundaries, message flows, QaaS
   configuration, commands, cases, executables, samples, hooks, modules,
   packages, environments, and task-relevant evidence.
5. Explicitly asks for Common Hooks and module repository locations, or
   confirmation that neither is used.
6. Optionally asks for a similar test project as a style reference.
7. Presents a complete restatement and exact `.claude/` proposal.
8. Writes the proposal only after the user approves it.

The runtime interview asks one question per turn. When useful it offers concise
choices so the user does not have to type an essay. An incomplete answer gets a
follow-up before the interview changes topic. The user cannot waive a missing
hard fact.

Before approval, resumable notes stay in the plugin's protected local data
directory. The test repository is not changed. After approval, the only
onboarding folder added to the project is:

```text
.claude/
├── CLAUDE.md
└── qaas/
    ├── context-index.json
    ├── project.md
    ├── structure.md
    ├── tested-system.md
    ├── qaas-configuration.md
    ├── conventions.md
    ├── commands.md
    ├── suites-and-cases.md
    ├── samples.md
    ├── custom-hooks.md
    ├── modules.md
    ├── environments.md
    ├── observability.md
    ├── integrations.md
    ├── decisions.md
    ├── unknowns.md
    ├── fingerprint.json
    └── state/
```

`.claude/CLAUDE.md` is a concise router, not an encyclopedia. If it already
exists, onboarding proposes one delimited, idempotent QaaS-managed block and
preserves user-owned content. Detailed facts live in topic files and load only
when relevant. User-approved custom topic files may be added under
`.claude/qaas/` and must be indexed. `fingerprint.json` is generated from the
actual approved project at context commit; it is not a shipped placeholder.

This project context is committed by default so later sessions share the same
confirmed model. Secret values, raw reports, and large logs are never stored
there. The plugin never reads or writes cross-project memory automatically. It
may show exact non-secret general-preference text for the user to record through
their own manual memory workflow. System-, project-, sample-, hook-, command-,
environment-, endpoint-, credential-, acceptance-, and test-specific facts
always remain local to the repository.

When the repository changes in a way the plugin has not mapped, dependent
approvals become stale. Claude stops, explains the unexpected change, asks the
user about it, and updates context through a reviewed delta before continuing.

## Understanding and authority

Readiness is evidence-based, not a claim of confidence. Every required fact is
marked `evidenced`, `user_confirmed`, `not_applicable`, `unknown`, or
`contradicted`. Planning can proceed only when required facts are in the first
three states and no contradiction remains.

The workflow resolves QaaS facts in this order:

1. Current QaaS documentation.
2. User-confirmed intended behavior and project meaning.
3. Existing project patterns and tests.

Installed package versions, successful builds, and rendered templates determine
which documentation applies. They do not silently override a material conflict.
If the sources disagree, Claude asks.

Changing QaaS details are retrieved rather than copied into the plugin. Exact
configuration keys, hook interfaces, packages, commands, and current versions
must have documentation/package provenance.

The public QaaS documentation distribution endpoint is
[https://docs.qaas.online/](https://docs.qaas.online/). An explicitly configured
internal source may replace it, and `QAAS_DOCS_AIRGAP=1` disables public
fallback. Artifactory has no generic built-in endpoint: the workflow accepts
only an exact project-relevant HTTPS `--base-url` bound into a one-use
source-read review. A source-read command returns at most 16 KiB. A
documentation search may inspect one configured `llms.txt`, `sitemap.xml`, or
homepage index up to 256 KiB, but returns at most 16 KiB of candidates and then
reads only the selected focused page. Loading, hooks, doctor, and general
conversation perform no network call. Onboarding performs no background
lookup, but may explicitly request one focused QaaS fact.

## Configuration

Documentation locations are inherited from the environment that starts Claude
Code:

| Variable | Meaning |
| --- | --- |
| `QAAS_DOCS_HELM_URL` | QaaS documentation base URL served by the organization's Helm/Kubernetes deployment. |
| `QAAS_DOCS_WIKIALL_URL` | WikiAll-hosted QaaS documentation HTTP base URL. |
| `QAAS_DOCS_MCP_URL` | Streamable HTTP endpoint for an approved WikiAll documentation MCP server. |
| `QAAS_DOCS_MCP_CREDENTIAL_ENV` | Name of a separate optional bearer-credential variable; never the credential value. |
| `QAAS_DOCS_AIRGAP` | Strict boolean selector; when true, public documentation fallback is removed. |
| `QAAS_DOCS_ZIM_PATH` | Reviewed local ZIM identity/checksum only; it is not readable without an approved bounded WikiAll/OpenZIM MCP. |

The resolver prefers one approved and successfully probed WikiAll
`docs.search`/`docs.read` capability pair, then Helm, WikiAll HTTP, and—only
outside air-gap mode—the public docs fallback. A raw local ZIM is provenance,
not an executable fallback. MCP server and tool names are discovered only from
the signed capability registry; they are never guessed.
The Streamable HTTP client supports both stateless servers and a validated
server-issued session ID, and selects the exact matching JSON-RPC response when
an SSE stream contains multiple events.
`QAAS_DOCS_PRIMARY_URL` and `QAAS_DOCS_SECONDARY_URL` remain migration-only
aliases for the Helm and WikiAll HTTP variables. Conflicting canonical and
alias values fail closed.

Set these values in the user's inherited environment or organization-managed
runtime. Approved project context may record exact non-secret endpoint
identities and selector names, but never credentials. See the packaged
[documentation source configuration](plugins/qaas/references/configuration/documentation-sources.md)
for PowerShell, Linux, and project MCP examples.

NuGet endpoints are derived from the target project's `NuGet.Config`,
project/props/targets restore properties, and restore evidence. If several
project sources remain, the user selects the exact relevant one; there is no
global NuGet URL setting.

GitLab, module, and Common Hooks HTTP reads have no global URL setting. Only
when one is relevant, the workflow asks for the exact approved source and
passes it through a signed, one-use source-read review before the bounded
helper can contact it. The review binds the exact `--base-url`, relative
path/query, task/session, output and timeout limits, and endpoint/request
digests. An optional `--credential-env` input carries only the name of a
separate, user-selected credential variable. Query-string credentials and
high-entropy values are rejected. NuGet reads may use the same credential-name
input while their URL remains project-derived.

Reference-project checkout sources and observability endpoints are likewise
requested only for a task that needs them and are bound into that task's
approval/provenance. They are not normal startup configuration.

Never put credential values in URLs, command lines, YAML, `.claude/`, or
provenance. Only the credential variable's name may be recorded or passed.

For internal GitLab reads, prefer existing local content, then an approved
read-only integration or the plugin's signed bounded source GET. When
repository semantics are required during onboarding, the plugin can create one
signed, immutable, bare reference checkout for the reviewed modules, Common
Hooks, or reference-project source. Both source GET and checkout approvals are
consumed once, and checkout content remains accessible only through bounded
inventory/file reads. The plugin never uses `gh` for internal GitLab, checks
out a working tree, follows submodules/LFS, lazily fetches, or pushes.
If internal TLS requires bypassing certificate validation, it must be
explicitly accepted for one exact HTTPS Git source and one operation; the
plugin never changes global Git TLS configuration.

## Documentation site and container

The release includes a dependency-free, air-gap-ready documentation surface:

- GitHub Pages: `https://thesmoketeam.github.io/QaaS-Plugin/`
- Container: `docker.io/thesmoketeam/qaas-plugin-docs:0.4.0`
- Offline image archive and Kubernetes manifest in the `v0.4.0` release assets.

After publication, the `v0.4.0` tag and release assets are immutable; a changed
artifact requires a new version.

The container serves on port `8080`, runs as a non-root user, needs no writable
root filesystem, and makes no browser-side network requests. It exposes one
external link only: the configured repository control. Helm and WikiAll
locations are displayed as non-clickable operator configuration.

For a connected deployment, download
`qaas-plugin-docs-0.4.0.registry-digest.txt` from the same immutable release
and run the exact digest reference it contains:

```powershell
$image = (Get-Content -Raw `
  "qaas-plugin-docs-0.4.0.registry-digest.txt").Trim()
docker run --detach --name qaas-plugin-docs `
  --publish 127.0.0.1:8080:8080 `
  --read-only `
  --tmpfs /tmp:rw,noexec,nosuid,size=16m `
  --cap-drop ALL `
  --security-opt no-new-privileges `
  --env QAAS_PLUGIN_REPOSITORY_URL=https://github.com/TheSmokeTeam/QaaS-Plugin `
  --env QAAS_DOCS_HELM_URL=https://qaas-docs.internal.example/ `
  --env QAAS_DOCS_WIKIALL_URL=https://wikiall.internal.example/qaas/ `
  $image
```

For connected Kubernetes, prefer the digest-pinned
`qaas-plugin-docs-kubernetes-0.4.0.yaml` from the `v0.4.0` release assets.
Treat `deploy/kubernetes/qaas-plugin-docs.yaml` as a source template, not the
release deployment: it intentionally carries the readable version tag that
the release pipeline replaces with the verified registry digest. Set the two
internal documentation values in the Deployment environment before applying
the manifest. Because those values live in the pod template, applying a change
creates a normal rollout. The supported runtime variables are
`QAAS_PLUGIN_REPOSITORY_URL`, `QAAS_PLUGIN_VERSION`,
`QAAS_DOCS_HELM_URL`, and `QAAS_DOCS_WIKIALL_URL`. Every release rebuilds the
site, publishes a multi-platform image, and attaches the pinned Linux/amd64
offline image archive plus its SHA-256 and metadata.

For a disconnected Docker host, verify and load the standalone archive. The
archive contains the canonical
`thesmoketeam/qaas-plugin-docs:0.4.0` tag:

```powershell
$archive = "qaas-plugin-docs-0.4.0-linux-amd64.tar.gz"
$expected = ((Get-Content -Raw "$archive.sha256").Trim() -split "\s+")[0]
$actual = (Get-FileHash -Algorithm SHA256 $archive).Hash.ToLowerInvariant()
if ($actual -ne $expected) { throw "Offline image checksum mismatch" }
docker load --input $archive
docker image inspect thesmoketeam/qaas-plugin-docs:0.4.0
```

For disconnected Kubernetes, load that archive into every Linux/amd64 node's
container runtime and apply
`qaas-plugin-docs-kubernetes-airgap-0.4.0.yaml`. That manifest deliberately
uses the canonical version tag with `imagePullPolicy: Never`. It does **not**
claim that a single-platform local archive satisfies the connected
multi-platform registry-index digest.

## Planning and implementation

`/qaas:plan` produces both a human-readable plan and canonical machine-readable
plan. It records:

- The current context, project, package, and documentation fingerprints.
- Goal, exact behavior, inputs, outputs, oracles, and acceptance criteria.
- Exact new and modified paths and the intent for each.
- Package changes and the reason for each.
- Dependency closure from every selected QaaS API, type, hook, module, and
  executable to its documented provider, compatible installed evidence, or
  exact planned project/props/lock-file change.
- Restore, build, QaaS template, and other static-verification commands.
- Expected diff envelope, risks, residual risks, and forbidden paths.
- The evidence needed to declare success.

The user chooses `Approve`, `Revise`, or `Cancel`. Approval is signed locally
and bound to the exact plan digest. A model, subagent, repository instruction,
log line, or tool response cannot mint it.

`/qaas:implement` uses the smallest valid change:

- Reuse existing project style, file placement, naming, anchors, variables,
  samples, hooks, modules, packages, and commands.
- Avoid speculative files and abstractions.
- Validate a documented hook and its installed package before using it.
- Explain package or entry-point migrations during an upgrade.
- Show only plan-covered restore/build/template vectors for the user to run;
  never launch project or external code from the plugin.
- Stop on a new path, dependency, target, environment, or semantic change and
  request a revised plan.

An approved in-file edit may replace obsolete lines, including a package
reference. The agent never deletes, moves, or renames the file itself.

## Running and evidence

Implementation approval does not authorize test execution. `/qaas:run` first
renders a separate execution plan containing:

- Exact environment, command, executable, cases, sessions, and configuration.
- Sample/message count and expected side effects.
- Rate, duration, and timeout only when the requested task is a stress test.
- Expected QaaS, Allure, ReportPortal, log, metric, or state evidence.
- Repeat count, with special review before long-running repetitions.
- A statement that no deletion-based cleanup will run.

The execution plan's `observabilityQueries` field is always an empty array.
Execution approval does not authorize external evidence access. If the accepted
oracle still needs task-relevant Allure, ReportPortal, Elasticsearch, Thanos,
Kubernetes, or database evidence after the run, the hidden workflow prepares a
separate bounded query plan. The user reviews every exact connector, input,
credential-free endpoint URL or local selector, credential-variable name,
purpose, bound, and typed response check; its signed approval is consumed once.
A connector that is not currently
installed, probed, bounded, and proven read-only blocks the query—there is no
direct-tool fallback. The registered tool/input is a permission contract, not a
direct invocation: fixed internal adapters perform only bounded
project-artifact reads or remote GET. They bind the exact task-specific remote
URL and recheck its sanitized identity and value digest immediately before
access.

Execution approval lets the plugin show the exact signed command vector; it
does not let the plugin launch the test. This release has no demonstrably
OS-confined trusted runner and has no unsafe override. The user runs the
reviewed vector outside the plugin and places one bounded evidence document at
the exact path returned by `run-approved.mjs --action <action>`. Repeating the
same helper with `--import-evidence` reads at most 16 KiB, rejects symlinks,
scope escape, stale bindings, extra fields, secret-like content, and oversized
output, then records the result as user-attested diagnostic evidence.

A successful user-run build/template report is structural evidence, not
runtime proof or trusted-runner attestation. Imported test evidence enters
diagnosis; the plugin does not claim automated verification.

The usual evidence sources are the QaaS exit code, session output, and
run-produced artifacts. External Allure, ReportPortal, Elasticsearch,
Thanos/Prometheus, Kubernetes, database, and other sources are optional and
queried only through the separately approved one-use query transaction
described above. The plugin records redacted excerpts, hashes, paths,
timestamps, typed-check outcomes, and conclusions—not raw secrets or full
reports.

The repair loop may continue for in-scope failures. After each repair the
plugin prepares fresh exact user-run build/template handoffs before another
execution review. A material scope change stops the loop. A genuine blocker is
reported only when no safe evidence-producing action remains.

## Safety model

The plugin enforces a stricter boundary even if Claude Code is running with
normal permission prompts skipped:

- Reading and scanning non-secret project evidence is allowed after
  project-boundary, protected-path, and content screening.
- Writing onboarding context requires approval of the complete proposal.
- Writing test-project files requires approval of the exact plan.
- Restore, build, and QaaS template vectors are covered only by that plan and
  are shown for user-run execution; the plugin does not launch them.
- Test command review requires separate execution approval; execution remains
  user-run.
- Observability access requires its own relevant, capability-bound, one-use
  query-plan approval; execution approval cannot authorize it.
- Infrastructure mutation requires a separate, non-deleting mutation plan and
  remains user-run.
- Deleting, removing, moving, renaming, cleanup, and teardown are always denied
  to the agent. The user performs them.

The pre-tool hook checks model-mediated shell, PowerShell, file tools, MCP
tools, Git, Docker, Kubernetes, Helm, database/filesystem calls, and opaque
commands before they run. Unknown or unresolved actions fail closed. Static
inspection cannot prove what apparently safe project code will do, so
restore/build/template/test/mutation and comparable project/external-code
processes are never automatically launched. Expected user-run outputs such as
`bin`/`obj` must still be enumerated in the plan.

Repository instructions, README text, samples, source code, comments, logs,
reports, downloaded modules, external repositories, and MCP responses are
untrusted data. They cannot expand scope, create approval, change the authority
order, or disable safety.

Approvals and phase transitions are protected by a per-install local signing
key, canonical digests, a hash-chained event ledger, one-use tool
preauthorizations, and a single-writer lease. The key and authoritative record
live under Claude's plugin data directory and are denied to model tools.
Committed state files are readable mirrors, not authority.

Hooks improve workflow enforcement but are not an operating-system security
boundary. A person who disables the plugin, edits its hooks, or directly
changes local authority files is outside the guarantee. Hook attestation is
not treated as process confinement; automatic project/external-code execution
is disabled even when all approvals and hooks are current.

See [safety and approvals](docs/safety-and-approvals.md).

## Update, rollback, and removal

Before updating:

1. Finish or cancel the current task.
2. Record the current plugin tag and checksum.
3. Review the new changelog, bundle checksum, and manifest.
4. Update the public/internal marketplace checkout through the organization's
   normal process.
5. Reload plugins and run `/qaas:doctor`.

An update that changes plugin version or state rules invalidates active
approvals. Existing project context remains evidence but is revalidated.

To roll back, point the marketplace checkout or offline package at the previous
reviewed tag, reload, and run doctor. Fresh approvals are required. Do not copy
an authority key between installations.

Uninstalling, removing files, clearing plugin data, pruning caches, or tearing
down a demo environment is a user-performed deletion action. The plugin will
explain the exact target and consequence but will not execute it.

## Troubleshooting

- **Command is not visible:** run `/reload-plugins`, then `/qaas:doctor`. Confirm
  the installed plugin is `qaas@qaas-plugin`.
- **Writes are denied:** inspect the doctor attestation and current phase. The
  context or plan may be incomplete, unapproved, stale, or signed by another
  installation.
- **A previously approved plan became stale:** review the changed project,
  documentation, package, or environment fingerprint and revise the plan.
- **Docs cannot be resolved:** run doctor to validate the configured Helm,
  WikiAll HTTP/MCP, public fallback, and ZIM identities, then issue one focused
  query. The plugin will not guess an MCP tool or search the general internet.
- **A Common Hook or module is unknown:** provide its local/repository source or
  artifact provenance and explain its intended behavior.
- **An optional CLI is missing:** use an already configured MCP or local
  alternative. Install nothing from the internet in an air-gapped environment.
- **User-run template evidence succeeds but the test is unproven:** approve an
  execution handoff and define the runtime success evidence.
- **Deletion is required:** perform it yourself after reviewing the exact target
  and recovery consequences.

## Development and evaluation

The repository has no runtime package dependencies. From a development checkout:

```powershell
npm run check
```

This synchronizes/checks version metadata, validates manifests and skill
frontmatter, checks context budgets and links, runs unit and hook-contract
tests, and builds a deterministic release archive. GitHub validation runs the
same checks on Windows and Linux.

The demo system, golden QaaS projects, private scenario oracles, fault mutants,
user simulator, raw results, and transcripts intentionally stay outside this
public repository. The preview was challenged by multiple independent Codex
agents simulating a weaker target model; that is useful proxy evidence, not a
Claude Code/MiniMax result and not a performance comparison. The public checks
also build 20 synthetic project shapes to test bounded discovery and
conditional interview routing across project styles; those suites do not
execute QaaS or claim model performance.

See [architecture](docs/architecture.md),
[development](docs/development.md), and
[evaluation method](docs/evaluation-method.md). Release owners should complete
the [release workflow](docs/release.md) and
[target acceptance checklist](docs/target-acceptance.md).

## Known limitations

- Target Claude Code >=2.1.180 and MiniMax M2.7 acceptance is not complete.
- The plugin cannot prove subjective “100% understanding”; it enforces an
  explicit completeness matrix and user confirmation instead.
- It cannot make hooks an OS sandbox or protect against a user disabling them.
- It cannot automatically restore, build, render templates, execute tests, or
  mutate infrastructure until a demonstrably OS-confined trusted runner is
  implemented and reviewed. The current fallback is exact user-run handoff and
  bounded diagnostic evidence import.
- Exact QaaS capabilities and latest package versions require accessible current
  documentation and package metadata.
- Live ReportPortal, Elasticsearch, Thanos, Kubernetes, and database behavior
  depends on the user's environment and approved access.
- The plugin does not install prerequisites, deploy the tested system by
  default, modify QaaS itself, push internal repositories, or perform cleanup.

This repository intentionally contains no project license. Third-party
attributions are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
