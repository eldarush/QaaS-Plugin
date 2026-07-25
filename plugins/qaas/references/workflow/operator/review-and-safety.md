# Review and memory rules

## Review transaction

Every context, capability, source-checkout, plan, execution, query, or mutation
review uses the same transaction:

1. Stage the complete schema-valid object.
2. Call `prepare --kind <kind>`.
3. Display or faithfully restate the returned `review.canonicalDocument`.
4. Invoke `AskUserQuestion` once with exactly the single returned `question`
   object—same prompt, header, options, and `multiSelect`.
5. If the answer is `Revise` or `Cancel`, let the post-tool hook record that
   exact decision and transition to the bounded safe phase. Do not call a
   commit/start/run helper. `Revise` requires a newly staged artifact and fresh
   review; `Cancel` grants no authority.
6. After `Approve`, call only the next helper named by the applicable procedure
   in the [protocol index](../operator-protocol.md). Conversational approval, a
   typed “yes”, or a subagent response is not authority.

Ask all discovery questions one at a time. Approval questions are also
one-question calls.

## Memory boundary

Keep all project, system, sample, hook, command, environment, test, and
acceptance facts under committed `.claude/qaas/` context. Cross-project memory
is optional and manual: propose only a non-secret general preference,
shared-nonsecret repository convention, or workflow preference, show the exact
text, and require explicit user approval before the user records it through
their normal Claude memory workflow. Never auto-write an unknown memory path,
and never put project-specific facts or credential values in memory.
