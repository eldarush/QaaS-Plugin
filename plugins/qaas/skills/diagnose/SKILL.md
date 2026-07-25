---
description: Manually diagnose a QaaS failure from approved evidence and route any repair through its gates.
disable-model-invocation: true
---

# Diagnose

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `diagnose`
- `provenance`: `manual:/qaas:diagnose`
- `arguments`: `$ARGUMENTS`

Diagnosis is read-only unless an existing approved plan covers the exact repair paths and semantics.
