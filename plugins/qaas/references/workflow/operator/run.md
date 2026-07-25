# Execution

From `IMPLEMENTED_NOT_RUN`, encode and stage one complete
`execution-plan.schema.json` document:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind execution --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind execution
```

Apply the [review transaction](review-and-safety.md#review-transaction), then
obtain the exact user-run handoff:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action test-run
```

The helper launches no process. Show its exact signed vector to the user. After
the user runs it outside the plugin and creates the fixed evidence document
returned by the helper, import it with the same command plus
`--import-evidence`. The bounded import enters diagnosis and never claims
trusted-runner or automated runtime verification.

The execution plan's `observabilityQueries` array must be empty. Execution
approval authorizes only the exact QaaS user-run handoff and its bounded
project artifacts; it cannot authorize Allure, ReportPortal, Elasticsearch,
Thanos, Kubernetes, or database access.

If the user-requested test needs a non-deleting infrastructure mutation, the
execution plan must exist first. While in `EXECUTION_REVIEW`, encode and stage
the complete `mutation-plan.schema.json`, then prepare it:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" stage --session-handle <handle> --kind mutation --content-base64 <contentBase64>
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind mutation
```

Apply the mutation
[review transaction](review-and-safety.md#review-transaction). A mutation
review supersedes the earlier execution challenge, so after mutation approval
prepare and approve the execution plan again. Only with both exact approvals
may the user receive the mutation handoff:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" prepare --session-handle <handle> --kind execution
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action mutation
```

The user runs the exact mutation vector outside the plugin and creates the
returned bounded evidence file. Import it with `--action mutation
--import-evidence`; only a successful bounded import leaves the exact execution
review available for a later `test-run` handoff. A failed import enters
diagnosis and blocks the test. Never add a mutation because it might help; use
this path only for an exact user-requested non-deleting action.

Use only the exact approved environment, command, cases, limits, evidence
sources produced by the user's run, repeats, and retry budget. Do not query
observability or mutate infrastructure through execution authority.
