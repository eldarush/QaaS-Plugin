---
description: Manually review or execute a separately approved QaaS test execution plan.
disable-model-invocation: true
---

# Run

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `run`
- `provenance`: `manual:/qaas:run`
- `arguments`: `$ARGUMENTS`

Do not treat implementation approval as execution approval, and do not widen the reviewed command, environment, evidence, or side-effect scope.
