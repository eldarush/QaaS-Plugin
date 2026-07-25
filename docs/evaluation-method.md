# Evaluation method

The public repository validates deterministic plugin contracts. A separate
private lab challenges end-to-end behavior without publishing system fixtures,
oracles, fault mutants, transcripts, raw results, or credentials.

## Public checks

`npm run check` performs:

- Version consistency across the version source, marketplace, plugin manifest,
  and package metadata.
- JSON/schema and Claude skill/agent frontmatter checks.
- Exactly-six-visible-command enumeration.
- Hook configuration and referenced-script checks.
- Markdown link and progressive-disclosure checks.
- Context-budget checks.
- Unit tests for canonicalization, signing, state transitions, leases,
  fingerprints, redaction, shell/MCP classification, and phase gates.
- Hook-contract simulations for allowed, denied, stale, replay, and malformed
  events.
- Deterministic release ZIP generation and file checksums.

GitHub runs these dependency-free checks on Windows and Linux. If a compatible
Claude CLI is present in a future acceptance environment,
`claude plugin validate --strict` is an additional gate; it is not simulated as
a passed target-runtime result.

## Private lab profiles

The private lab provides:

1. `process-lite`: deterministic local processes/test doubles for fast mapping,
   plan, mutation, and evidence scenarios.
2. `compose-full`: a persistent stack for broker, telemetry, and offline
   documentation scenarios.
3. `kind-full`: optional Kubernetes/Helm scenarios when an existing Docker,
   kubectl, and kind-compatible environment is available.

The lab controller never grants candidate agents deletion or teardown. Runs are
isolated by seed, run ID, tenant/topic/queue names, and correlation fields.
Cleanup is a separately documented user action.

## Synthetic QaaS fixtures

Private starter/golden projects cover YAML and C# configuration; cases,
executables, sessions, anchors, variables, merges/appends, modules, samples,
local/shared hooks, and available Mocker behavior. Sample formats include JSON,
XML, Protobuf, and binary data. Evidence fixtures include version-pinned Allure
and ReportPortal shapes.

A release-required scenario is admitted only when the QaaS behavior is proven
by current documentation and accessible package/runtime evidence. The lab does
not turn a plausible YAML key into a product claim.

## Scenario groups

The challenge corpus includes:

- Installation, discovery, and command-surface checks.
- Complete and incomplete onboarding.
- Existing `CLAUDE.md` preservation.
- Ambiguous project and unexpected-change handling.
- YAML/C# test authoring and minimal-change behavior.
- Sample mutation and protected-field rules.
- Custom hook reuse/authoring and unsupported-capability refusal.
- Module/Common Hooks provenance.
- Package upgrade planning.
- Static build/template verification.
- Run approval, long-run/retry review, and runtime diagnosis.
- Allure/ReportPortal parsing and optional telemetry queries through a distinct
  one-use query-plan approval, including unproven-connector and direct-fallback
  denial.
- Stale approvals, replay, concurrency, crash recovery, and tampered state.
- Direct/indirect deletion, prompt injection, secrets, and opaque-tool attacks.
- Missing optional tools and offline docs fallback.
- README/documentation tasks.

Fault mutants prove that evaluators fail when an expected guard or behavior is
broken. Results are seed-reproducible and machine-readable.

## Codex proxy agent army

Independent agents assume bounded roles: simulated QA user, project mapper,
QaaS docs researcher, planner, implementer, safety adversary, runtime verifier,
diagnostician, and minimalist reviewer. Agents receive only the context
available to the corresponding Claude stage. Fresh agents forward-test skills
to expose hidden assumptions.

This proxy can find workflow and prompt defects, but it cannot establish
MiniMax M2.7 quality or Claude Code 2.1.201 hook semantics. The public preview
therefore makes no pass-rate, speed, coverage, scenario-count, or comparative
performance claim.

## Release gates

A candidate is blocked by:

- Any invented QaaS key, package, hook, command, or capability.
- Fewer/more than six visible commands.
- Mutation before a current signed approval.
- Agent-directed deletion.
- Secret or private-lab leakage.
- A bypass through shell, PowerShell, MCP, subagent, prompt injection, replay,
  concurrency, or stale state.
- Failure to preserve existing project conventions/user-owned context.
- A nondeterministic package.
- Public/private boundary violations.

The final organizational gate is a manual acceptance run in the actual
air-gapped Claude Code 2.1.201 + MiniMax M2.7 environment using approved
internal docs, packages, and representative projects.
