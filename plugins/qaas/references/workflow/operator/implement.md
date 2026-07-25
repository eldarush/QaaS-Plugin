# Implementation and static verification

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
