# Development

## Prerequisites

- Node.js 24; other Node major versions are outside the preview's validated
  baseline.
- A working `/bin/sh` for hook process tests. On Windows this is normally the
  fixed Git for Windows shell used by Claude Code.
- Git for source control.
- No npm runtime dependencies.

The public test suite does not require QaaS packages, Docker, .NET, Claude Code,
or network access. Those belong to target acceptance or the private lab.

## Repository layout

- `.claude-plugin/marketplace.json`: marketplace containing one plugin.
- `plugins/qaas/.claude-plugin/plugin.json`: plugin identity.
- `plugins/qaas/skills/`: six visible wrappers and hidden skills.
- `plugins/qaas/agents/`: bounded subagent definitions.
- `plugins/qaas/hooks/hooks.json`: lifecycle/tool hook registration.
- `plugins/qaas/scripts/`: dependency-free authority, validation, and hook code.
- `plugins/qaas/schemas/`: machine-readable artifact contracts.
- `plugins/qaas/templates/`: generated project-context templates.
- `plugins/qaas/references/`: one-hop workflow/domain references.
- `plugins/qaas/self-test/`: public synthetic contract tests.
- `docs/`: operator and design documentation.
- `tools/`: version synchronization and deterministic packaging.

## Validate

```powershell
npm run check-version
npm run validate
npm test
npm run package
```

Or run all checks:

```powershell
npm run check
```

Linux uses the same commands.

The plugin validator also runs from Claude Code's installed plugin-only cache,
where repository-level `package.json`, `version.json`, and marketplace metadata
are intentionally absent. Those cross-file version/source checks run only when
the validator detects the surrounding source-repository layout; the installed
layout is validated from `plugin.json` and the packaged plugin contents.

When a compatible target CLI is already installed, also run:

```powershell
claude plugin validate --strict .
```

Do not install it merely to make a local proxy test appear stronger. Record
whether this was an actual target-runtime check.

## Versioning

`version.json` is the single version source. Change it, then run:

```powershell
npm run sync-version
```

The script updates `package.json`, the plugin manifest, and marketplace
metadata. CI runs `--check` and rejects drift.

## Deterministic package

`npm run package` creates:

- `dist/qaas-plugin-<version>.zip`
- `dist/qaas-plugin-<version>.zip.sha256`
- `dist/qaas-plugin-<version>.zip.manifest.json`

Entries are sorted, timestamps are fixed, and file hashes are recorded.
Building twice from identical public sources must produce the same digest.
Distribution output is not committed.

The packager rejects a project `LICENSE`, private-lab marker, or distribution
recursion. A release audit additionally checks for credentials, raw results,
private paths, and internal endpoints.

## Skill authoring rules

- Keep the six lifecycle wrappers small and `disable-model-invocation: true`.
- Set `user-invocable: false` on every internal skill.
- Omit redundant plugin skill `name` frontmatter for 2.1.201 compatibility.
- Put stable process rules in `SKILL.md`; retrieve changing QaaS facts.
- Link references one hop from the skill and load only what is relevant.
- Use imperative instructions and explicit stop conditions.
- Do not expose hidden chain-of-thought; request concise evidence/rationale.
- Forward-test a changed skill with a fresh bounded agent.

## Runtime-code rules

- Use Node built-ins only.
- Canonicalize before hashing or signing.
- Normalize Windows/Linux paths without weakening boundary checks.
- Treat missing/unknown/malformed input as deny, stale, or invalid.
- Never log an authority key, credential value, full prompt, or raw tool body.
- Make state changes atomic and compare-and-swap guarded.
- Test replay, concurrency, crash window, prompt injection, and every
  delete/move/cleanup surface changed by a patch.

## Pull-request/release checklist

1. Confirm the change stays inside the public boundary.
2. Run all checks on Windows.
3. Review the exact six visible commands.
4. Inspect manifests/frontmatter/hooks and documentation links.
5. Run the relevant private proxy scenarios without copying results into public
   history.
6. Build the archive twice and compare SHA-256.
7. Audit tracked files for secrets, internal endpoints, local absolute paths,
   private fixtures/results, and any `LICENSE`.
8. Validate on Linux CI.
9. Tag the version and publish the bundle/checksum as a pre-release until target
   Claude Code/MiniMax acceptance is complete.

## No-deletion development policy

Plugin behavior never directs deletion. Development automation also does not
clean worktrees, remove build outputs, tear down containers, or reset Git.
If an unwanted material file is present in a release candidate, stop and ask a
human to remove it before publishing.
