# Diagnosis and recovery

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
