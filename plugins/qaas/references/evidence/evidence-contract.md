# Evidence and verdict contract

For each approved action, retain sanitized:

- action class and plan/approval digest
- exact executable/argument identity or read capability
- working directory and permitted environment-variable names
- phase, lease, fingerprint revision, timestamps, and exit code
- bounded relevant excerpts
- output paths, classes, and hashes
- expected versus observed result
- failed attempts and repair revision

Never store raw prompts, credential values, unresolved variable-expanded commands, raw MCP payloads, complete reports, or large logs.

External observability evidence additionally records the canonical query-plan
and per-query digests, exact approved capability/tool identity, exact
credential-free endpoint or local selector, credential-variable names, applied bounds,
typed-check outcomes, redacted excerpt/hash, and one-use approval consumption.
It never records a resolved secret-bearing endpoint, credential value, or raw
tool response. Execution evidence alone cannot authorize the query.

Automatic static verification is unavailable in this release because no
demonstrably OS-confined trusted runner exists. A user may run the exact
reviewed restore/build/template vectors and provide the helper's bounded
evidence document. Record it as user-attested diagnostic evidence; do not label
it trusted-runner or automated proof.

Runtime evidence likewise comes only from an exact user-run handoff and bounded
import. Import enters diagnosis and cannot produce an automated `VERIFIED`
claim. A zero process exit alone does not prove tested-system success when the
oracle requires outputs, assertions, absence checks, or other evidence.

Diagnosis classifies evidence as test, configuration, hook, tested-system, deployment, environment, tooling, or unknown. Correlation is not proof; state uncertainty and alternatives. Disclose earlier failures even after a successful retry.

A final verdict identifies validated scope, static and runtime evidence separately, limitations, failed attempts, residual risk, and next legal action.
