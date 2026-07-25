# Doctor

`/qaas:doctor` is read-only and runs exactly:

```text
node "${CLAUDE_PLUGIN_ROOT}/scripts/doctor.mjs"
```

Report its actual tool, hook, authority, source, and compatibility findings.
Do not install a missing tool, reveal environment-variable values, activate a
project, or claim that an optional capability exists. A blocking doctor result
blocks write, mutation, and execution phases.
