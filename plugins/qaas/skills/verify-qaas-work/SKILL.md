---
description: Internal verification specialist for exact user-run handoffs and bounded imported restore, build, template, execution, or evidence checks.
user-invocable: false
---

# Verify QaaS work

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. The qaas-workflow delegates only
deterministically preauthorized actions here; return evidence to that
coordinator.

Use the deterministic preauthorization path for every approval-requiring action.

- For implementation verification, obtain the deterministic handoff for each
  plan-bound restore, build, and template vector. Show its exact executable,
  arguments, working directory, environment-variable names, hashes, and output
  classes to the user. Never launch it, use clean, or use a shell-form
  workaround. Import only the helper's fixed bounded evidence file.
- Static success requires exit code zero, no relevant error or warning, and rendered configuration matching approved intent. It is not runtime proof.
- Prepare a QaaS user-run handoff only after a distinct current execution-plan
  approval. Bind environment, executable/cases/sessions/configuration, message
  count, repeats/retries, a reviewed wall-clock ceiling no greater than three
  hours, side effects, output paths, and typed oracle checks; keep
  `observabilityQueries` empty. Default the retry budget to three and never
  exceed three; propose three successful repetitions separately and review
  long or expensive runs explicitly. Bind stress rate, load duration, and
  timeout only for an explicitly requested stress test. Require docs-proven
  timing meaning/unit, user-confirmed intent, the exact approved value in
  implementation, and signed template-render evidence of the configured
  value; only user-run runtime evidence can describe observed behavior. Reject
  an existing-pattern inference or bare numeric threshold.
- Query observability only through a separately reviewed one-use query plan and a current proven bounded read-only connector. An unproven connector blocks access. Do not mutate infrastructure unless separately approved. Never clean up, delete, move, or rename.
- Record sanitized user-attested command identity, timestamps, exit code,
  relevant excerpts, artifact paths and hashes, fingerprint revision, and each
  failed attempt. Never label it trusted-runner or automated evidence.
- Treat expected generated outputs as evidence only when their classes were enumerated by the plan.

Stop on stale state, unauthorized output, unsupported command, secret-bearing output, or material deviation. Return the next legal action.

See [evidence and verdicts](../../references/evidence/evidence-contract.md).
