# Changelog

## 0.2.0 — Air-gap and constrained-model hardening

- Removed exact Node-major and shell requirements; hook execution now uses
  Claude Code's cross-platform exec form and supports Claude Code 2.1.180+.
- Added immutable built-in QaaS documentation and Artifactory endpoints,
  project-derived NuGet sources, and task-specific reviewed source URLs.
- Added dependency-free package auditing and offline restore/build/run policy.
- Added a local byte-exact content encoder, bounded signed resume projections,
  and phase budgets for 128k-context weaker models.
- Added exact endpoint provenance, redirect-resistant reference checkouts, and
  task-specific observability URL binding.
- Added signed one-use reviews for user-supplied source GETs, with
  retry-safe approval retirement and credential-query rejection.
- Added an explicit constrained-model authority capability, canonical
  authority-owned artifact digests, and a 32 KiB transport-only encoder.
- Expanded Windows/Linux and Node 18/20/22/24 validation coverage.

This release remains a Codex-proxy preview until it passes the target
MiniMax M2.7 and internal air-gapped acceptance checklist.

## 0.1.0 — Codex-proxy preview

- Added six user-facing QaaS lifecycle commands.
- Added project onboarding and durable `.claude/qaas/` context templates.
- Added documentation-backed planning, implementation, execution, and diagnosis workflows.
- Added deterministic approval, phase, fingerprint, lease, ledger, redaction, and no-deletion guards.
- Added dependency-free validation, self-tests, and reproducible packaging.
- Added Windows-first, Linux-compatible installation and air-gap documentation.

This preview was exercised with a private Codex proxy evaluation. It has not yet
been accepted on the target Claude Code >=2.1.180 and MiniMax M2.7 environment.
