---
description: Manually implement a fresh approved QaaS plan and perform static verification.
disable-model-invocation: true
---

# Implement

Invoke the hidden plugin skill `qaas:qaas-workflow` (directory `qaas-workflow`) with:

- `phase`: `implement`
- `provenance`: `manual:/qaas:implement`
- `arguments`: `$ARGUMENTS`

Do not proceed unless the workflow validates the current plan identifier, approval digest, lease, hook attestation, and project fingerprint.
