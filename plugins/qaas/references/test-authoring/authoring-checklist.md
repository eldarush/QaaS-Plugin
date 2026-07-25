# QaaS authoring checklist

## C# implementation closure

Before a Configuration-as-Code or custom-hook plan can be finalized, reviewed,
or approved, the plan itself must contain a `csharpClosure` object with all
eight exact field names below. Each field records exact resolved values and
current-docs plus project evidence, or evidence-proven inapplicability, as
`{ status, facts, documentationEvidence, projectEvidence }`. Status is
`resolved` or `evidence-proven-inapplicable`; all three arrays contain concrete
non-placeholder statements:

- `bootstrapModeAndArguments`: bootstrap mode and arguments
- `builderTypesAndSignatures`: concrete builder types and exact public method signatures
- `topology`: metadata, data-source, session, and assertion topology
- `hookBasesInterfacesAndDiscovery`: hook bases/interfaces and discovery names
- `configurationRecordAndBinding`: configuration-record fields and binding
- `providerPackages`: provider packages
- `yamlAndCsharpUse`: exact YAML/C# use
- `restoreBuildTemplateCommands`: exact restore/build/template commands

Any missing, unknown, or contradicted item keeps discovery open one question or
one bounded docs/project query at a time. A null, placeholder, or fact elsewhere
does not fill a field. Mechanically check all eight fields before requesting
implementation-plan approval. Implementation must not discover, infer, or
invent a closure item after approval; stop and replan.

`resolved` does not mean user-originated. An implementation-local identifier or
organization choice may be resolved as a disclosed planner proposal when its
semantics and constraints are evidenced; approval authorizes it. External
behavior, contracts, QaaS constructs, and configuration meaning cannot be
resolved this way.

When active authority content-binds writes, finish these steps before approval:

- draft each planned file's exact complete target bytes without writing
- compute SHA-256 over those exact bytes
- include exactly one `write <add|modify> <path> sha256:<digest>` per write
- `add` maps only to `paths.create`; `modify` maps only to `paths.modify`
- reject missing, duplicate, or out-of-scope command paths

In every structured semantic contract, preserve disclosed literal tokens and
array order exactly. Never paraphrase, substitute synonyms, reorder, or
normalize them.

Before editing:

- readiness and exact-plan approval are current
- hook attestation, lease, fingerprint, and path scope validate
- current documentation supports every QaaS-dependent choice
- configuration composition and rendered module behavior are understood
- input, output, oracle, correlation, and sample rules are explicit
- any applicable C# implementation closure above is exact and approved
- every delay, duration, timeout, and rate follows current docs for meaning/units, direct user confirmation for intended value, and signed project/render evidence for the final configured value; existing patterns and bare numeric thresholds are not authority
- existing project patterns and reusable hooks/modules are identified

While editing:

- preserve YAML versus C# style, naming, formatting, placement, anchors, variables, and package patterns
- add the fewest files and lines needed
- avoid speculative abstraction, infrastructure, packages, test frameworks, refactors, and cleanup
- keep credential values out
- modify only approved paths
- never delete, move, or rename

After editing:

- account for every changed path and hunk
- compare the diff with the approved envelope and unchanged paths
- run only approved restore, build, and template checks
- inspect relevant errors and warnings
- compare rendered configuration to accepted intent
- retain failures and cite documentation/compatibility evidence
- state plainly that static success is not runtime proof

If implementation or repair reveals a missing C# closure item, or introduces a
new path, dependency, target, environment, command, rate, duration, timeout,
acceptance criterion, or semantic change, stop for a revised plan. Never fill
the gap during implementation.
