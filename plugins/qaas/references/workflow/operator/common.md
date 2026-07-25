# Common session and invocation rules

## Constrained-model start and resume

Apply the [128k constrained-model contract](../constrained-model-operation.md).
Keep one phase active and read only the procedure needed from the
[protocol index](../operator-protocol.md). At session start, resume, or
post-compaction, run:

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
command substitution, or an interpreter snippet for content transport.

Never truncate, paraphrase, or split one schema document to fit. If an exact
artifact exceeds 32 KiB, checkpoint it unstaged and offer two or three
non-overlapping smaller task scopes only when each preserves full acceptance
and dependency closure under a separate plan/approval. After the user chooses,
plan one scope at a time. If the artifact is indivisible, or the tool is
unavailable or rejects safe content, stop with
`exact staging transport unavailable`.

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
## Status and stop rules

Read signed status with:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" status
```

This is the second read-only no-session bootstrap exception described above.
It reports existing signed state but cannot initialize or repair it.

Before ending a turn, continue the exact signed next action. A model progress
checkpoint cannot set `awaitingUser`. When input is required, make the final
response exactly one focused question; the Stop hook corroborates
`last_assistant_message` and writes the protected waiting flag. It also owns
waiting at `PROJECT_READY`, `PLAN_APPROVED`, or `IMPLEMENTED_NOT_RUN` only when
the current interaction has the matching protected, session-bound, one-use
record minted from exact `/qaas:onboard`, `/qaas:plan`, or `/qaas:implement`
invocation. Stop consumes that record; replay fails, and the next unrelated
lease-owner prompt invalidates it. An answer preserves it only across the
signed sequence created by a Stop-corroborated question and the hook-owned
waiting flag; further question/answer turns use the same rule. The next valid
lease-owner prompt clears the waiting flag. A raw blocker, phase alone,
self-asserted flag, malformed or multiple question, or unfinished nonterminal
work cannot authorize Stop. Only
`BLOCKED`, `SAFETY_VIOLATION`, and `VERIFIED` are terminal Stop phases;
`stop_hook_active` remains the recursion guard.
Stop instead of guessing when a schema rejects, documentation is unsupported,
project/context fingerprints differ, a required capability is absent, the
lease or attestation is stale, the user revises/cancels, the request requires
deletion/move/rename, or QaaS cannot support the behavior through documented
configuration or an external assertion/generator/probe/processor.
