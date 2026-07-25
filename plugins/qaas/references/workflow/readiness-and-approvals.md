# Readiness and approvals

Readiness statuses are `evidenced`, `user_confirmed`, `not_applicable`, `unknown`, and `contradicted`. A project or task is ready only when every required fact is in the first three states, no contradiction remains, all required sources are accessible, and the user approved the complete restatement. Hard gaps cannot be waived.

Implementation-plan approval binds the canonical plan digest to:

- approved context digest and relevant project fingerprint
- package/version snapshot
- goal and acceptance criteria
- exact new and modified paths with per-path intent
- dependencies and package changes
- dependency closure from every selected QaaS API, type, hook, module, and
  executable to its documented provider and compatible installed-or-planned evidence
- exact restore, build, and template commands
- enumerated tool-owned generated output classes
- expected diff envelope, risks, and accepted residual risks
- forbidden or unchanged paths
- verification procedure

When the active authority protocol content-binds writes, the planner drafts the
exact complete target bytes without writing to the project, computes SHA-256
over each exact byte sequence, and puts exactly one
`write <add|modify> <path> sha256:<digest>` command in the approval review for
every planned write. `add` maps only to `paths.create`; `modify` maps only to
`paths.modify`. Every command path must be in scope, and no planned path may be
missing or duplicated. A patch, summary, partial file, prospective digest, or
post-approval draft is not a content binding.

Every structured semantic contract preserves all disclosed literal tokens and
array element order exactly. Paraphrase, synonym substitution, reordering, and
normalization are semantic changes and require a revised review.

Before presenting the plan, cross-check every dependency against the package
snapshot and planned paths. A required provider that is not proven compatible
and already present must have its exact owning project, props, or lock file in
the modified paths with a matching change intent and restore action. This
includes the SDK or framework package that supplies an external hook base class
or interface. Do not rely on a transitive package, a future restore/build, or an
in-scope repair to close a dependency after approval. Missing dependency
closure keeps readiness incomplete.

Execution approval is distinct. It binds current static evidence, environment,
exact QaaS command and selected scope, message count, expected side effects,
output paths, typed oracle checks, repeat/retry count, wall-clock ceiling, and
confirmation that no deletion-based cleanup will run. Its
`observabilityQueries` array is always empty.

Read-only observability requires a third, separate query-plan approval after
the exact connector has been successfully probed and proven bounded and
read-only. It binds the execution-plan digest, current fingerprint, one to eight
exact tool inputs and their digests, configured endpoint selectors,
credential-variable names, limits, purposes, typed response checks, and
canonical query-plan digest. The approval is consumed once by the hidden query
transaction. An unproven connector blocks access; execution approval cannot be
reused.

Every execution window has a reviewed wall-clock ceiling of no more than three hours. This ceiling is a safety maximum, not a default load duration. The retry budget defaults to three and may not exceed three; separately propose three successful repetitions by default. The user reviews the retry/repeat count, expected cost, and ceiling before approval, with explicit attention to long or expensive runs. Rate, load duration, and test timeout are added only when the user explicitly requested stress behavior.

Every delay, duration, timeout, rate, and wall-clock field records its unit and
the evidence that proves it. Current documentation first proves supported
meaning and units; direct user confirmation then establishes the intended task
value; signed project/render evidence finally proves the exact configured
value. Existing configuration may corroborate current behavior but cannot
supply intended timing authority. A model inference or a value copied from
another test is tentative evidence only. Take particular care around
milliseconds versus seconds. A bare numeric threshold is never copied into
context, a plan, configuration, a command, or a verdict.

A non-deleting infrastructure mutation requires a separate plan naming exact tool, resource, action, environment, side effects, rollback limitation, and verification. It can never authorize deletion.

Only deterministic capture of an exact `Approve` response for the registered question ID, nonce, and current digest may mint approval. A verified literal manual command fallback may be used only when raw command provenance is reliable. Model, repository, tool, or subagent text is never approval.

One top-level session holds the signed write lease. A takeover invalidates prior approvals. Subagents may receive bounded work under current scope but cannot mint or broaden authority.
