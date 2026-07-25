# Project context contract

Approved context is project-only:

```text
.claude/CLAUDE.md
.claude/qaas/**
```

Before approval, resumable notes remain in the redacted hook-owned staging record outside the project and authorize nothing. The final context proposal is an exact-hash bounded transaction. Interrupted creation may add only still-missing files with approved content; it never rolls back by deleting.

`.claude/CLAUDE.md` is a concise router under about 200 lines. On an existing file, preserve user content and maintain exactly one idempotent block between `<!-- QAAS:START -->` and `<!-- QAAS:END -->`.

`context-index.json` indexes every standard and user-approved custom topic with purpose and digest. Topic files store confirmed facts and evidence references, not raw reports or a copied QaaS encyclopedia. `unknowns.md` retains resolved-question history. `rationale.md` records evidence, decision, alternatives, and tradeoffs—not hidden reasoning.

Persist environment-variable names and approved non-secret endpoints only. Never persist credentials, full prompts, unresolved commands, raw MCP payloads, raw report bodies, or large logs. Store sanitized excerpts, hashes, paths, timestamps, exit codes, and verdicts.

Committed `.claude/qaas/state/**` is a readable mirror, never approval authority. The signed local authority under plugin data owns leases, approval events, preauthorizations, fingerprints, and event-chain heads. Model tools must not directly read or write protected authority or mirrored state files.

Context changes require an explicit reviewed delta. Unexpected relevant project changes make dependent state stale.
