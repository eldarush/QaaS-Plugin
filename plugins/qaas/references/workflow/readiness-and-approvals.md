# Readiness and approvals

For compact validator-aligned shapes and the artifact-versus-review digest
boundary, load [lifecycle artifact scaffolds](artifact-scaffolds.md).

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

The signed active authority projection exposes
`authorityCapabilities.writeContentBinding`; it must be `true` or
implementation planning stops. Before approval, the planner drafts exact
complete target bytes without writing to the project and computes SHA-256 over
those exact UTF-8 bytes, including line endings and any BOM. Every
`changes[].targetSha256` carries the one digest for its entry; operation `create` maps
only to `paths.create` and `modify` only to `paths.modify`. The signed review
binds the ordered `{ path, operation, targetSha256 }` set with the complete
plan. No planned path may be missing, duplicated, stale, or out of scope. A
command string, patch, summary, partial file, prospective digest, or
post-approval draft is not a content binding.

One plan approval covers all of its exact write bindings; there is no per-file
approval prompt. During implementation, `Write` is valid only for an absent
create path. `Edit` is valid only for an existing modify path and an
`old_string` that occurs exactly once; the pre-tool hook reconstructs the full
resulting bytes and compares their SHA-256 with the signed target. Missing or
multi-match text, changed bytes, the wrong path/operation, or a stale digest is
denied. `NotebookEdit` is denied because complete target notebook bytes cannot
be reconstructed deterministically.

This contract permits one finalizing write call per path. A modify path must
reach its approved final bytes with one unique-match bounded `Edit`; a
different second hunk or repair target requires a revised plan. This deliberate
constraint trades multi-step editing convenience for a byte-exact approval
that a weak model cannot silently widen.

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
`observabilityQueries` array is always empty. It authorizes an exact user-run
handoff, not plugin process execution. This release has no demonstrably
OS-confined trusted runner and no unsafe override.

Read-only observability requires a third, separate query-plan approval after
the exact connector has been successfully probed and proven bounded and
read-only. It binds the execution-plan digest, current fingerprint, one to eight
exact tool inputs and their digests, exact non-secret endpoints or local selectors,
credential-variable names, limits, purposes, typed response checks, and
canonical query-plan digest. The approval is consumed once by the hidden query
transaction. An unproven connector blocks access; execution approval cannot be
reused.

Every execution window has a reviewed wall-clock ceiling of no more than three hours. This ceiling is a safety maximum, not a default load duration. The retry budget defaults to three and may not exceed three; separately propose three successful repetitions by default. The user reviews the retry/repeat count, expected cost, and ceiling before approval, with explicit attention to long or expensive runs. Rate, load duration, and test timeout are added only when the user explicitly requested stress behavior.

Every delay, duration, timeout, rate, and wall-clock field records its unit and
stage-specific evidence. Current docs prove supported meaning/unit; the user
confirms the intended value; the plan binds that intent without claiming the
new value is already configured; implementation writes it; bounded
user-attested template-render evidence may then support the configured value;
user-run runtime evidence alone describes observed behavior. Existing
configuration may corroborate current behavior but
cannot choose intent. An inference or copied value is tentative only. Take
particular care with milliseconds versus seconds. A bare numeric threshold is
never copied into context, plan, configuration, command, or verdict.

A non-deleting infrastructure mutation requires a separate plan naming exact
tool, resource, action, environment, side effects, rollback limitation, and
verification. It can never authorize deletion or plugin-side execution; the
only current path is an exact user-run handoff followed by bounded evidence
import.

Only deterministic capture of an exact `Approve` response for the registered question ID, nonce, and current digest may mint approval. A verified literal manual command fallback may be used only when raw command provenance is reliable. Model, repository, tool, or subagent text is never approval.

One top-level session holds the signed write lease. A takeover invalidates prior approvals. Subagents may receive bounded work under current scope but cannot mint or broaden authority.
