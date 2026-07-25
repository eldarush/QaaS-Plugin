---
description: Manually run the non-mutating QaaS plugin capability, safety, and configuration check.
disable-model-invocation: true
---

# Doctor

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `doctor`
- `provenance`: `manual:/qaas:doctor`
- `arguments`: `$ARGUMENTS`

Doctor is read-only: it must not install tools, enumerate credential values, change configuration, or repair the project.
