# Lifecycle states

The deterministic state engine, not model prose, authorizes transitions.
Domain skills return bounded evidence or proposed actions to `qaas-workflow`;
they never select a lifecycle phase, read or change authoritative state, grant
readiness, recognize approval, or perform a transition.

| Phase | Normal states | Allowed outcome |
|---|---|---|
| `doctor` | any | same state plus read-only findings |
| `onboard` | `UNONBOARDED`, `DISCOVERING`, `CONTEXT_REVIEW`, `STALE` | `PROJECT_READY` after approved context |
| `plan` | `PROJECT_READY`, `TASK_DISCOVERY`, `PLAN_REVIEW` | `PLAN_APPROVED` after exact-plan approval |
| `implement` | `PLAN_APPROVED`, `IMPLEMENTING`, `BUILD_VERIFIED`, `TEMPLATE_VERIFIED` | `IMPLEMENTED_NOT_RUN` |
| `run` | `IMPLEMENTED_NOT_RUN`, `EXECUTION_REVIEW`, `MUTATION_REVIEW`, `MUTATION_APPROVED`, `EXECUTION_APPROVED`, `EXECUTING` | `VERIFIED` or `DIAGNOSING` |
| `diagnose` | `EXECUTING`, `DIAGNOSING`, `REPAIRING` | diagnosis, approved repair loop, revised plan, or blocker |

An unexpected relevant change transitions to `STALE`, revokes dependent approvals, and permits read-only investigation. The coordinator shows changed paths, reopens affected context with one question at a time, and obtains a new plan approval when scope or semantics changed.

An unauthorized approval-requiring action, protected-state change, or integrity failure transitions to `SAFETY_VIOLATION`. Only ordinary read-only investigation remains legal.

`BLOCKED` is valid only when no safe, in-scope, evidence-producing action remains. Missing facts, inaccessible required sources, unsupported QaaS capability, required deletion, or required scope expansion are genuine examples.

Before a major transition or compaction, checkpoint sanitized phase, approved digests, completed and remaining work, evidence paths, decisions, blocker, and next legal action through the deterministic handler. Resume must revalidate signatures, lease, hook attestation, required fingerprint, and approvals.
