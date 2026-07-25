# Constrained-model operation

Use this contract for the 128k target model. The goal is to keep the active
working set below 32k tokens, leaving at least 96k tokens for conversation,
tool evidence, and compaction safety.

## One-phase working set

Keep exactly one lifecycle phase active. Load:

1. the `qaas-workflow` coordinator;
2. the thin manual wrapper, when one was invoked;
3. this reference;
4. `operator/common.md` and the one phase procedure linked by
   `operator-protocol.md`;
5. at most one additional phase or domain reference;
6. at most one specialist skill or one bounded subagent prompt; and
7. only the indexed project topic needed for the current decision.

After recording signed handles and durable progress, stop carrying or rereading
prior-phase detail. Never preload all references, all project topics, a full
report, or `llms-full.txt`. Search first and read a bounded excerpt.

## Phase routing

| Phase | Primary reference | Optional one-at-a-time reference | Allowed agent |
|---|---|---|---|
| `doctor` | `operator-protocol.md#doctor` | none | none |
| `onboard` | `project-context.md` | `project-model.md`, then documentation provenance only when needed | `project-mapper` or `configuration-tracer`, one bounded slice at a time |
| `plan` | `readiness-and-approvals.md` | one authoring, sample, module, upgrade, or documentation reference | `test-planner` or `docs-researcher`, never concurrently |
| `implement` | one selected authoring reference | `authoring-checklist.md` or evidence contract | `test-implementer`, then `minimalist-reviewer` |
| `run` | `evidence-contract.md` | `query-plan.md` only if the accepted oracle needs external evidence | `verifier` |
| `diagnose` | `evidence-contract.md` | one authoring reference only after exact-scope recovery | `diagnostician`; `test-implementer` only after recovery validates |

`operator-protocol.md` is only the one-hop index. Load its common rules plus the
single linked procedure for the current phase, not every operator file.

## Bounded subagents

The coordinator owns phase, questions, readiness, approvals, transitions, and
conclusions. Give a subagent one canonical root, one path/source slice, one
question, exclusions, supplied evidence handles, and one output contract.
Never include a session handle. Run no more than two read-only mapping forks at
once, reconcile each result before another fork, and keep every response at or
below 500 words. A writing or command agent receives only an already validated
exact envelope; it cannot approve or broaden it.

Suggest `/effort xhigh` when available and the phrase **use dynamic workflow**
only for large onboarding or a genuinely complex approved implementation. Do
not recommend them for doctor, ordinary planning, run, or diagnosis.

## Compaction

Before manual or anticipated automatic compaction:

1. record confirmed facts as signed readiness/evidence handles;
2. stage completed artifacts;
3. call the deterministic progress checkpoint helper with completed work,
   remaining work, evidence paths, blocker, and next legal action; and
4. verify that `resume` returns a signed bounded projection.

After resume, use only that projection plus the current indexed topic. Reissue
only the exact pending action returned by authority. Do not reconstruct a
question, digest, path, command, or fact from the conversation summary.

## Content transport

Use only the plugin-provided `mcp__qaas_local__encode_text` tool to encode
authored staging content. Call it with exactly:

```json
{"text":"<exact UTF-8 content>"}
```

The local stdio server is auto-registered by the plugin, accepts at most 32 KiB
of secret-free UTF-8, and returns Base64 plus its byte length and
`transportSha256`. That checksum proves only the transported UTF-8 bytes; it is
never a plan/artifact `digest`. Copy only the returned `contentBase64` into the
relevant staging helper. Do not hand-encode Base64 or use Bash, a pipe, heredoc,
redirection, temporary project file, command substitution, or an interpreter
snippet for content transport.

Never truncate, paraphrase, or split one schema document to fit. If an exact
artifact exceeds 32 KiB, checkpoint it unstaged and offer two or three
non-overlapping smaller task scopes only when each preserves full acceptance
and dependency closure under a separate plan/approval. After the user chooses,
plan one scope at a time. If the artifact is indivisible, or the tool is
unavailable or rejects safe content, report
`exact staging transport unavailable`.
