---
description: Manually review a separately approved QaaS execution plan, receive its exact user-run command handoff, and import bounded evidence.
disable-model-invocation: true
---

# Run

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `run`
- `provenance`: `manual:/qaas:run`
- `arguments`: `$ARGUMENTS`

Do not treat implementation approval as execution approval, and do not widen
the reviewed command, environment, evidence, or side-effect scope. This release
has no OS-confined trusted runner: never launch the reviewed command. Show its
exact vector for the user to run, then import only the fixed bounded evidence
file returned by the deterministic helper.
