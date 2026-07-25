---
description: Execute only approved QaaS restore, build, template, run, and evidence checks and report an honest verdict.
user-invocable: false
---

# Verify QaaS work

`qaas-workflow` exclusively owns lifecycle phase selection, authoritative
state, readiness, reviews, and approvals. This domain skill accepts only
deterministically preauthorized actions and returns evidence to that
coordinator.

Use the deterministic preauthorization path for every approval-requiring action.

- For implementation verification, run only the plan-bound restore, build, and template commands with exact executable, argument vector, working directory, permitted environment-variable names, input hashes, and generated-output classes. Never use clean or a shell-form workaround.
- Static success requires exit code zero, no relevant error or warning, and rendered configuration matching approved intent. It is not runtime proof.
- Run a QaaS test only after a distinct current execution-plan approval. Bind environment, executable/cases/sessions/configuration, message count, repeats/retries, a reviewed wall-clock ceiling no greater than three hours, side effects, output paths, and typed oracle checks; keep `observabilityQueries` empty. Default the retry budget to three and never exceed three; propose three successful repetitions separately and review long or expensive runs explicitly. Bind stress rate, load duration, and timeout only for an explicitly requested stress test. Current docs first prove supported timing meaning and units; direct user confirmation then establishes the intended task value; signed project/render evidence finally proves the exact configured value. Reject an existing-pattern inference or bare numeric threshold.
- Query observability only through a separately reviewed one-use query plan and a current proven bounded read-only connector. An unproven connector blocks access. Do not mutate infrastructure unless separately approved. Never clean up, delete, move, or rename.
- Record sanitized command identity, timestamps, exit code, relevant excerpts, artifact paths and hashes, fingerprint revision, and each failed attempt.
- Treat expected generated outputs as evidence only when their classes were enumerated by the plan.

Stop on stale state, unauthorized output, unsupported command, secret-bearing output, or material deviation. Return the next legal action.

See [evidence and verdicts](../../references/evidence/evidence-contract.md).
