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

Static verification requires successful approved restore/build/template checks, no relevant error or warning, and a rendered configuration matching intent. Label it `implemented, not run`.

Runtime verification additionally requires the exact approved run and agreed oracle. A zero process exit alone does not prove tested-system success when the oracle requires outputs, assertions, absence checks, or other evidence.

Diagnosis classifies evidence as test, configuration, hook, tested-system, deployment, environment, tooling, or unknown. Correlation is not proof; state uncertainty and alternatives. Disclose earlier failures even after a successful retry.

A final verdict identifies validated scope, static and runtime evidence separately, limitations, failed attempts, residual risk, and next legal action.
