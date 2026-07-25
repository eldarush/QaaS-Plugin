---
description: Manually onboard the current QaaS test project and create approved project-local context.
disable-model-invocation: true
---

# Onboard

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `onboard`
- `provenance`: `manual:/qaas:onboard`
- `arguments`: `$ARGUMENTS`

Do not reinterpret the phase or bypass its doctor, readiness, review, approval, or fingerprint gates.
