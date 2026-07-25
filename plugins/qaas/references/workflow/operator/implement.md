# Implementation and static verification

`/qaas:implement` first runs:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" start-implementation --session-handle <handle>
```

Use native `Write` only for an approved absent `create` path and native `Edit`
only for an approved existing `modify` path. The edit's `old_string` must occur
exactly once; never use `NotebookEdit` or a multi-match `replace_all`. Do not
redraft target content after approval or use shell writes. The pre-tool hook
reconstructs the complete resulting bytes and requires the approved
`changes[].targetSha256`. Apply only the exact approved diff envelope. Then
prepare only the plan's preapproved exact user-run handoffs:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action restore
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action build
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action template
```

These helpers never launch the commands. Each returns the signed resolved
executable, argument vector, working directory, environment-variable names,
executable/process digests, output bounds, one fixed evidence path, and a JSON
template. Show that exact vector to the user. After the user runs it outside
the plugin and creates the returned evidence file, import it with:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/run-approved.mjs" --session-handle <handle> --action <restore|build|template> --import-evidence
```

Use only actions present in the plan and in its recorded order. Never
substitute or launch a command. Restore/build imports may advance the next
handoff. Successful template evidence advances to `IMPLEMENTED_NOT_RUN`, but
remains explicitly user-attested evidence rather than trusted-runner or runtime
proof.

If build/template verification fails and the repair remains exactly inside the
approved plan envelope and reaches the same approved target bytes:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/workflow-authority.mjs" recover --session-handle <handle> --mode exact
```

Retry the exact approved target, then prepare fresh user-run handoffs and
import their bounded evidence. Any different target bytes require a fresh plan
even when the path and intent stay the same; do not stretch the old approval.
