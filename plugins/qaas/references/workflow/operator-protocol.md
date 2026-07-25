# Deterministic operator protocol

Use this protocol for every active QaaS workflow. It is intentionally explicit
for bounded-context models. Do not improvise a helper, argument, approval
question, phase transition, or success claim.

## Read before acting

<a id="constrained-model-start-and-resume"></a><a id="exact-content-transport"></a><a id="invocation-rule"></a><a id="status-and-stop-rules"></a>
<a id="review-transaction"></a><a id="memory-boundary"></a>
For every active workflow, read [common session, invocation, status, and stop
rules](operator/common.md). Read the [review and memory rules](operator/review-and-safety.md)
when a review transaction or memory decision is relevant. Then read only the
procedure for the current lifecycle phase or transaction:

- <a id="doctor"></a>[`/qaas:doctor`](operator/doctor.md)
- <a id="onboarding"></a><a id="optional-capability-registry"></a>[Onboarding and optional capability registration](operator/onboard.md)
- <a id="approved-bounded-source-get"></a><a id="approved-reference-source-checkout"></a>[External source GET and checkout](operator/sources.md)
- <a id="planning"></a>[Planning](operator/plan.md)
- <a id="implementation-and-static-verification"></a>[Implementation and static verification](operator/implement.md)
- <a id="execution"></a>[Execution and non-deleting mutation](operator/run.md)
- <a id="bounded-read-only-observability"></a>[Bounded read-only observability](operator/observability.md)
- <a id="diagnosis-and-recovery"></a>[Diagnosis and recovery](operator/diagnose.md)
