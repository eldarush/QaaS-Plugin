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
