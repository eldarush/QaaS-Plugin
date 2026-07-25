# Deterministic operator protocol

Use this protocol for every active QaaS workflow. It is intentionally explicit
for bounded-context models. Do not improvise a helper, argument, approval
question, phase transition, or success claim.

## Constrained-model start and resume

Apply the [128k constrained-model contract](constrained-model-operation.md).
Keep one phase active and read only the heading needed below. At session start,
resume, or post-compaction, run:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" resume --session-handle <handle>
```

Use only its signed `projection`: current opaque fingerprint and package
handles, bounded progress, recent successful read-evidence handles, staged
artifacts/topics, blocker, and exact pending action. Do not read protected or
mirrored state. If it returns an exact pending `AskUserQuestion`, issue only
that question.

After a bounded project or configured-source read needed for readiness, call
`resume` and retain the returned evidence handle. Do not invent an evidence
digest or derive one from tool output.

Before compaction, encode a small progress object and checkpoint it:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" checkpoint --session-handle <handle> --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" resume --session-handle <handle>
```

The object may contain only `completedWork`, `remainingWork`, `evidencePaths`,
`blocker`, and `nextLegalAction`. Each list is bounded to twelve concise
entries. Checkpoint before compaction; never use a conversation summary as a
replacement.

## Exact content transport

For context, readiness, plan, execution, query, mutation, capability, source,
or checkpoint content, call the plugin-provided tool
`mcp__qaas_local__encode_text` with exactly:

```json
{"text":"<exact UTF-8 content>"}
```

The plugin auto-registers this dependency-free local stdio server. It accepts
only that one field, rejects secret-like text, enforces a 32 KiB UTF-8 limit,
and returns Base64 with byte length and `transportSha256`. That checksum is
transport evidence, never the artifact `digest`; authority computes artifact
digests. Copy only `contentBase64` into the staging command. Never hand-encode
Base64 or use Bash, a pipe, heredoc, redirection, temporary project file,
command substitution, or an interpreter snippet for content transport. If the
tool is unavailable, rejects the content, or the exact artifact cannot fit
within 32 KiB without dropping required contract detail, checkpoint and stop
with `exact staging transport unavailable`.

## Invocation rule

Invoke one helper at a time with the Bash tool using this exact shape:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/<helper>.mjs" <arguments>
```

Do not add a shell operator, pipeline, redirection, command substitution,
variable assignment, wrapper shell, or second command. Pass the exact
`--session-handle` returned by `SessionStart`; never copy it into project files,
messages, plans, logs, or subagent prompts. Parse the helper's JSON response.
On `ok:false`, a nonzero exit, stale state, invalid signature, lost lease, or
unexpected phase, stop mutation and report the exact bounded error.

There are exactly two no-session bootstrap exceptions: `doctor.mjs` and
`workflow-authority.mjs status`. They are read-only, cannot activate a project,
acquire a lease, create state, or mint authority, and may run before
`SessionStart` has produced a handle. Every other helper invocation requires
the exact current session handle.

Claude Code invokes mandatory hooks with the exec-form hook contract:
`node` plus `scripts/hook-launcher.mjs` and one attested hook script argument.
The launcher accepts only the three attested scripts, reuses the current Node
executable for its child, requires no shell, and fails closed on launcher or
child failure. Doctor blocks a project-controlled `PATH` shadow before writes.

## Doctor

`/qaas:doctor` is read-only and runs exactly:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Report its actual tool, hook, authority, source, and compatibility findings.
Do not install a missing tool, reveal environment-variable values, activate a
project, or claim that an optional capability exists. A blocking doctor result
blocks write, mutation, and execution phases.

## Review transaction

Every context, capability, source-checkout, plan, execution, query, or mutation
review uses the same transaction:

1. Stage the complete schema-valid object.
2. Call `prepare --kind <kind>`.
3. Display or faithfully restate the returned `review.canonicalDocument`.
4. Invoke `AskUserQuestion` once with exactly the single returned `question`
   object—same prompt, header, options, and `multiSelect`.
5. If the answer is `Revise` or `Cancel`, let the post-tool hook record that
   exact decision and transition to the bounded safe phase. Do not call a
   commit/start/run helper. `Revise` requires a newly staged artifact and fresh
   review; `Cancel` grants no authority.
6. After `Approve`, call only the next helper named below. Conversational
   approval, a typed “yes”, or a subagent response is not authority.

Ask all discovery questions one at a time. Approval questions are also
one-question calls.

## Onboarding

1. Activation must be the exact user prompt `/qaas:onboard`. Capture the
   `SessionStart` handle and run:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" discover --session-handle <handle>
   ```

2. Perform read-only discovery. Ask for explanations and resolve every required
   readiness fact without guessing.
3. For each core or user-approved custom Markdown topic, use the exact content
   transport above, then stage the returned Base64:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage-context --session-handle <handle> --path .claude/qaas/<topic>.md --content-base64 <contentBase64>
   ```

   Stage every core topic. Do not hand-author `.claude/CLAUDE.md` or
   `context-index.json`; finalization generates their exact managed forms.

4. Finalize:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" finalize-context --session-handle <handle>
   ```

5. Encode the complete `readiness.schema.json` object and stage it:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind readiness --content-base64 <contentBase64>
   ```

   A `user_confirmed` or `not_applicable` domain first requires its exact
   registered fact:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare-readiness-fact --session-handle <handle> --domain <domain> --status <user_confirmed|not_applicable> --summary-base64 <contentBase64>
   ```

   Apply the review transaction to the returned single question. Use only
   successful read-evidence handles returned by `resume` for `evidenced`
   domains.

6. Run the review transaction with:

   ```text
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind context
   node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" commit-context --session-handle <handle>
   ```

   Context files are written only by `commit-context`, after the exact approval.
   End onboarding in `PROJECT_READY`; do not begin or implement a task.

## Optional capability registry

Only when a relevant installed integration has been probed and bounded, encode
an `integration-capabilities.schema.json` object and use:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage-capabilities --session-handle <handle> --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind capabilities
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" commit-capabilities --session-handle <handle>
```

Apply the review transaction. Never invent an MCP tool name or schema. For QaaS
documentation queries use the bounded helper, not a direct MCP call:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/docs-read.mjs" --session-handle <handle> --query <question>
```

An optional `--relative-url <stable-id>` may narrow a known page. `unsupported`
means stop and ask; it never means infer.

## Approved bounded source GET

Prefer current project/local content. If one exact file or API response is
needed from a user-supplied GitLab, modules, or Common Hooks HTTP(S) source,
use a signed one-use source-read transaction. First prepare the complete
request without contacting the source:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind source-read --source <gitlab|modules|common-hooks> --base-url <exact-user-supplied-base-url> --relative-url <exact-relative-path-and-query> [--credential-env <user-selected-variable-name>] [--output-limit-bytes <1..16384>] [--timeout-ms <1..60000>]
```

Apply the returned review transaction. It displays and binds the exact base
URL, relative path and non-secret query, endpoint/request digests,
credential-variable name, bounds, project, task, and phase. The signed
challenge additionally binds the active session and lease. After exact
approval, execute the same argument vector:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <gitlab|modules|common-hooks> --base-url <exact-user-supplied-base-url> --relative-url <exact-relative-path-and-query> [--credential-env <same-variable-name>] [--output-limit-bytes <same-value>] [--timeout-ms <same-value>]
```

The helper consumes approval before the network request. Replay fails. Any
changed source, path/query, credential selector, or bound fails without
contacting the source and without consuming a still-matching approval.
Credential values may exist only in the selected environment variable; signed
or high-entropy query values are rejected. This is not a general HTTP client.

## Approved reference-source checkout

Prefer existing project/local content and the approved bounded GET above. Only
during `DISCOVERING`, when understanding requires repository semantics, stage
one complete `source-checkout.schema.json` document. Its `source` is exactly
`modules`, `common-hooks`, or `reference-project`. Put the exact user-reviewed
URL directly in `repositoryUrl`; no URL environment setup is required. For a
private source, `credentialEnv` contains only the user-selected `GLAB_TOKEN` or
`GITLAB_TOKEN` variable name, never its value. The ref and commit are immutable.
Use the exact content transport, then stage it:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind source-checkout --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind source-checkout
```

Apply the review transaction. After exact approval, perform the one-use bare,
shallow, no-lazy-fetch checkout:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-checkout.mjs" --session-handle <handle> --checkout-id <checkout-id>
```

Never run a second clone/fetch command or read its protected storage directly.
Inventory and read only through:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <source> --checkout-id <checkout-id> --list
node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" --session-handle <handle> --source <source> --checkout-id <checkout-id> --path <safe-relative-path>
```

Use `git` without a credential selector when the reviewed source is public or
an existing credential helper suffices. A private checkout may use only the
user-selected `GLAB_TOKEN` or `GITLAB_TOKEN` selector with the `glab` transport;
never expose its value. TLS verification stays enabled. If and only if the
exact HTTPS Git source cannot otherwise be read, record the user's explicit
one-source, one-operation risk acknowledgement in the staged document; the
helper may apply an invocation-scoped override and never a global one.

## Planning

From `PROJECT_READY` or `VERIFIED`:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" begin-task --session-handle <handle> --task-id <stable-task-id>
```

Use the returned `projectFingerprintDigest`, `contextDigest`, and
`packageSnapshotDigest` verbatim. Never retrieve them from project state.

Interview and research until nothing required is unknown or contradicted. Encode
one complete `task-plan.schema.json` document without a `digest` field and stage
it. The authority computes and inserts the canonical artifact digest; never use
the local encoder's `transportSha256` as an artifact digest:

Immediately before staging, perform dependency closure. Map every selected QaaS
API, type, hook, module, and executable to current documentation, its providing
package or project, and compatible installed evidence. When the provider is not
proven present, the plan must modify the exact project/props/lock owner, name the
dependency change, and include restore. Do not treat a transitive reference,
future build, or later repair as closure. Refuse to prepare a plan whose selected
implementation requires an unplanned provider.

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind plan --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind plan
```

Apply the review transaction. A successful approval ends `/qaas:plan` in
`PLAN_APPROVED`. Do not start implementation in the planning command.

## Implementation and static verification

`/qaas:implement` first runs:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" start-implementation --session-handle <handle>
```

Use native `Write` only for an approved new path and native `Edit` only for an
approved existing path. Do not use shell writes. Apply only the exact approved
diff envelope. Then execute only the plan's preapproved deterministic actions:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action restore
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action build
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action template
```

Run only actions present in the plan and in its recorded order. Never substitute
a command. Template success yields `IMPLEMENTED_NOT_RUN`; report it as static
evidence, not runtime proof.

If build/template verification fails and the repair remains exactly inside the
approved plan envelope:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" recover --session-handle <handle> --mode exact
```

Repair, then repeat the approved static actions. A material change requires a
fresh plan; do not stretch the old approval.

## Execution

From `IMPLEMENTED_NOT_RUN`, encode and stage one complete
`execution-plan.schema.json` document:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind execution --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind execution
```

Apply the review transaction, then and only then run:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action test-run
```

The execution plan's `observabilityQueries` array must be empty. Execution
approval authorizes only the exact QaaS run and its bounded project artifacts;
it cannot authorize Allure, ReportPortal, Elasticsearch, Thanos, Kubernetes, or
database access.

If the user-requested test needs a non-deleting infrastructure mutation, the
execution plan must exist first. While in `EXECUTION_REVIEW`, encode and stage
the complete `mutation-plan.schema.json`, then prepare it:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind mutation --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind mutation
```

Apply the mutation review transaction. A mutation review supersedes the
earlier execution challenge, so after mutation approval prepare and approve the
execution plan again. Only with both exact approvals may the mutation run:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind execution
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action mutation
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action test-run
```

Run mutation before `test-run`. A failed mutation enters diagnosis and blocks
the test. Never add a mutation because it might help; use this path only for an
exact user-requested non-deleting action.

Use only the exact approved environment, command, cases, limits, evidence
sources produced by the run, repeats, and retry budget. Do not query
observability or mutate infrastructure through execution authority.

## Bounded read-only observability

Only when the accepted oracle needs task-relevant external evidence, encode and
stage one complete `query-plan.schema.json` document bound to the exact
execution-plan digest and current fingerprint:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind query --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind query
```

Apply the review transaction. The human-readable review must show every exact
provider, capability ID, tool, bounded input, exact non-secret endpoint or local selector,
credential-variable name, purpose, limit, and typed response check. Then and
only then consume the approval once:

The displayed exact tool input is limited to 16 KiB canonical UTF-8, depth
eight, and 100 entries per object or array. Its recorded `toolInputDigest` must
equal the SHA-256 of that canonical object.

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/query-approved.mjs" --session-handle <handle>
```

The exact capability must be present in the current approved registry,
successfully probed, bounded, and proven read-only for the named provider. An
absent, stale, opaque, write-capable, or otherwise unproven connector blocks
the query. Never fall back to a direct MCP call, browser request, CLI, shell
command, Kubernetes client, or database client. The capability/tool/input is a
permission contract only: execution uses fixed internal adapter
`qaas-internal-project-artifact-v1` for Allure or
`qaas-internal-http-get-v1` for remote GET. The reviewed binding includes a
sanitized endpoint identity and endpoint-value digest and is recomputed before
the read. A retry or any changed query, connector, endpoint, bound, check,
execution digest, or fingerprint requires a new plan and approval. See
[bounded query transaction](query-plan.md).

## Diagnosis and recovery

Classify failure using only approved evidence. If the fix stays inside the
existing plan's paths and semantics:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" recover --session-handle <handle> --mode exact
```

This enters `REPAIRING`; edit only existing approved scope, then rerun build and
template before requesting another execution review.

If new paths, packages, commands, semantics, targets, or environment scope are
needed:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" recover --session-handle <handle> --mode replan
```

This returns to `TASK_DISCOVERY` and invalidates prior execution authority.
Never repair an unrecognized change. Stop and ask the user to explain it.

## Memory boundary

Keep all project, system, sample, hook, command, environment, test, and
acceptance facts under committed `.claude/qaas/` context. Cross-project memory
is optional and manual: propose only a non-secret general preference,
shared-nonsecret repository convention, or workflow preference, show the exact
text, and require explicit user approval before the user records it through
their normal Claude memory workflow. Never auto-write an unknown memory path,
and never put project-specific facts or credential values in memory.

## Status and stop rules

Read signed status with:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" status
```

This is the second read-only no-session bootstrap exception described above.
It reports existing signed state but cannot initialize or repair it.

Stop instead of guessing when a schema rejects, documentation is unsupported,
project/context fingerprints differ, a required capability is absent, the
lease or attestation is stale, the user revises/cancels, the request requires
deletion/move/rename, or QaaS cannot support the behavior through documented
configuration or an external assertion/generator/probe/processor.
