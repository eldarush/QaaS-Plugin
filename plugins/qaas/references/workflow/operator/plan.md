# Planning

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

Require the active signed projection to report
`authorityCapabilities.writeContentBinding: true`. Before staging, draft each
planned file's exact complete target bytes without writing to the project.
Pass each exact UTF-8 target, including line endings and any BOM, to
`mcp__qaas_local__encode_text`; never calculate SHA-256 mentally. For this
exact-file input only, copy the returned `transportSha256` into that entry's
`changes[].targetSha256`. It is not the top-level plan artifact `digest`.
Operation `create` maps only to
`paths.create`; `modify` maps only to `paths.modify`. Do not substitute a
command string, patch digest, or post-approval draft.

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

Apply the [review transaction](review-and-safety.md#review-transaction). A
successful approval ends `/qaas:plan` in `PLAN_APPROVED`. Do not start
implementation in the planning command.
