# Safety and approvals

The plugin uses signed, digest-bound approvals instead of treating ordinary
conversation text as authorization. Its primary invariant is that the agent
does not delete, remove, move, rename, clean, tear down, prune, or roll back
files or resources.

## Action matrix

| Action | Authorization |
| --- | --- |
| Read/scan current-project evidence | Allowed inside the project boundary after protected-path and secret screening |
| Read a user-identified docs/repository source | Allowed; credentials external |
| Create a protected immutable reference checkout | Exact one-use source-checkout approval during discovery |
| Write approved `.claude/` context | Exact context transaction approval |
| Write test-project files | Exact implementation-plan approval |
| Restore, build, render QaaS template | Covered only when listed in that plan |
| Execute QaaS tests | Separate execution-plan approval |
| Query task-relevant observability | Separate capability-bound query-plan approval, consumed once |
| Mutate infrastructure without deletion | Separate mutation-plan approval |
| Delete, remove, move, rename, cleanup, teardown | Always denied to agent |

The workflow asks once for a coherent reviewed operation, not once per
individual command. One approval does not authorize a different phase.

## Plan approval

The canonical implementation plan binds:

- Project-context, relevant-project, package, and documentation digests.
- Goal, behavior, and acceptance criteria.
- Exact new/modified paths and change intent.
- Dependencies and package changes.
- Restore/build/template commands.
- Enumerated tool-owned output classes.
- Expected diff envelope and forbidden/unchanged paths.
- Risks and verification procedure.

The validator creates a nonce and registered approval-question identifier,
renders the complete plan, and accepts only the exact answer tied to that
question, nonce, current digest, and session. The choices are `Approve`,
`Revise`, and `Cancel`.

A plain-text command fallback may be enabled only when the installed Claude
version exposes reliable raw user-command provenance. Otherwise the user runs
the deterministic approval helper directly. Model output, subagent output,
repository text, and tool responses cannot approve a plan.

## Execution and mutation approval

An execution plan separately binds the exact environment, QaaS invocation,
cases/executables/sessions, message count, expected side effects, output paths,
typed oracle checks, and repetition. Its `observabilityQueries` array is always
empty. Rate, duration, and timeout are required only for a requested stress
test.

A mutation plan is exceptional and only for a user-requested non-deleting
infrastructure change. It binds tool, resource, action, environment, side
effects, rollback limitation, and verification. It cannot authorize deletion.

## Query approval

External Allure, ReportPortal, Elasticsearch, Thanos, Kubernetes, or database
evidence uses a hidden transaction with its own `query-plan.schema.json`. The
plan is bound to the exact execution-plan digest and current fingerprint. Each
of its one to eight queries names the current capability ID, exact tool and
bounded input, configured non-secret endpoint selector, credential environment
variable names, purpose, timeout/output/item bounds, read-only assertion, typed
response checks, and canonical query digest.

The complete query plan is displayed for separate review. Its approval is
signed and consumed once before access. Runtime authority must match a current
successfully probed bounded read-only connector. A missing, stale, opaque,
write-capable, or otherwise unproven connector blocks the query; execution
approval and direct-tool fallbacks are invalid.

The registered capability/tool/input is a permission contract only. The read
runs through fixed internal `qaas-internal-project-artifact-v1` (Allure) or
`qaas-internal-http-get-v1` (remote GET) adapters, never by invoking that tool
directly. The signed review binding includes a sanitized endpoint identity and
endpoint-value digest, which are recomputed immediately before access.

## No-deletion invariant

The pre-tool analyzer denies direct and indirect deletion surfaces, including:

- File APIs and shell commands that delete, move, rename, replace by relocation,
  clean, prune, or tear down.
- Git reset/clean/checkout restoration and destructive branch/ref operations.
- Docker/Compose removal, teardown, prune, and volume deletion.
- Kubernetes/Helm delete, uninstall, rollback-through-removal, and replacement
  patterns that destroy resources.
- Database DROP/TRUNCATE/destructive operations.
- MCP tools with delete/move/cleanup semantics.
- Opaque scripts or unresolved commands that cannot be safely classified.

Approved edits may remove or replace lines inside an approved file. They may
remove an obsolete package reference. They may not remove the file. If cleanup
is necessary, the plugin explains the exact target, consequences, and recovery
considerations, then asks the user to perform it.

## Tool preauthorization

Before a tool runs, its resolved operation is matched to a signed one-use
authorization containing:

- Tool and normalized operation.
- Exact path/source/resource scope.
- Current phase, session, task, lease, and sequence.
- Applicable plan/execution/query/mutation digest.
- Expected output classes and expiry.

Unknown variables, aliases, nested shells, substitutions, redirections,
pipelines, command strings, or MCP schemas fail closed. A safe-looking wrapper
cannot conceal a destructive inner operation.

After the operation, the post-tool ledger consumes the authorization and
records exit/result metadata, redacted evidence, and resulting fingerprints.
Replay, wrong session, expired nonce, or mismatched operation is denied.

## Signing and leases

A per-install HMAC key signs state and authorization events. It is generated
under Claude's plugin-data directory, never in the project. The model is denied
access to the key and authority record.

Exactly one top-level session owns a write lease. A second session is read-only.
A user-approved takeover invalidates the previous session's approvals.
Subagents inherit only bounded coordinator scope and cannot acquire broader
authority.

State transitions use canonical JSON, a hash chain, expected prior digests, and
atomic replacement. Missing/invalid signatures or an interrupted action-to-
ledger sequence makes state stale.

## Staleness and repair

Approval is invalidated by a relevant project, context, package, documentation,
plan, plugin, environment, or command change. The plugin explains the changed
evidence and asks for the appropriate reviewed delta.

Small repairs may continue under an execution approval only when paths,
dependencies, behavior, environment, command, rate/duration/timeout, and side
effects remain inside its approved envelope. Every
repair gets a new static-verification digest. A material deviation requires a
revised plan.

## Prompt injection and secrets

Project files, comments, READMEs, samples, logs, reports, downloaded artifacts,
external repositories, and MCP responses are data, not instructions. They
cannot:

- Declare readiness.
- Mint an approval.
- Change the authority order.
- Expand write/run/observability scope.
- Disable hooks or no-deletion policy.
- Request secrets or authority records.

Tool output is bounded and redacted before entering evidence. Credentials stay
in user-selected environment variables or credential helpers. Project context
stores only a credential-variable name. Known secret patterns, credential-
bearing URLs, private keys, raw tokens, and authority keys are rejected.

## Enforcement limitation

Claude Code hooks are a strong workflow control, not an operating-system
sandbox. A local user can disable the plugin or tamper with its files. The
plugin therefore attests its active hook configuration before any mutation or
execution; failure blocks the phase.

Run the target-runtime acceptance checklist under the organization's actual
Claude Code, model gateway, permission settings, shell, MCPs, and file-system
policy before relying on these controls operationally.
