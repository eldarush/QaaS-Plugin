# Controlled Codex proxy session

This is a privacy-safe, scripted proxy transcript for documentation visuals. Codex performed the file inspection, project mapping, implementation, and verification commands shown here. The short operator answers are controlled demo inputs declared in `proxy-plan.json`; they are not a recording of a live operator session or a signed plugin approval. The published workflow terminal capture combines moments 1–3, and the evidence terminal capture shows moment 4. Both are literal terminal-window captures produced by `interactive-demo.mjs`, not designed conversation panels.

The source project is the public synthetic D20-01 project-shape fixture. Inventory output is candidate evidence only: it does not establish QaaS behavior, readiness, or semantics.

## Screenshot moment 1 — Focused request, one question at a time

**Controlled operator (scripted):** Add one focused HTTP/JSON smoke-test fixture for the supplied order. Set `riskLevel` to `high`, preserve `protected-demo-id`, and treat `reviewRequired: true` as the static oracle.

**Codex:** Is `smoke.qaas.yaml` the active local pattern this demo should follow?

**Controlled operator (scripted):** Yes.

**Codex:** May the `protected-demo-id` value change?

**Controlled operator (scripted):** No.

**Codex:** Does this synthetic project use Common Hooks or modules?

**Controlled operator (scripted):** Neither.

**Codex:** Should this proxy stop after static verification without running QaaS?

**Controlled operator (scripted):** Yes.

## Screenshot moment 2 — Project mapped, authority kept narrow

**Codex:** I found one VM service file, one YAML configuration, and one JSON sample. The inventory tentatively routes this as HTTP/JSON smoke work. Those cues are candidate evidence only, so the operator answers above remain the authority for this controlled fixture.

Actual commands:

```powershell
$env:CLAUDE_PROJECT_DIR=(Resolve-Path 'validation/docs-demo-session/demo-project').Path
$env:CLAUDE_PLUGIN_ROOT=(Resolve-Path 'plugins/qaas').Path
node "$env:CLAUDE_PLUGIN_ROOT/scripts/project-inventory.mjs"
node "$env:CLAUDE_PLUGIN_ROOT/scripts/interview-routes.mjs" --mode inventory-and-user-intents --intent http-json
```

Actual results:

```text
inventory: authority=candidate-evidence-only; filesSeen=3; protocols=http; serializations=json; testIntents=smoke
route: authority=routing-only-no-readiness; route=HTTP/JSON; reportingTruncated=false
```

The complete command output is preserved in `raw/project-inventory.before.json` and `raw/interview-routes.json`.

## Screenshot moment 3 — Approval gate before writes

**Codex:** Proposed controlled change:

- Create `demo-project/Cases/order-review.qaas.yaml` from the five already-observed YAML pattern lines.
- Create `demo-project/TestData/order-review-input.json` with the protected identifier and `riskLevel: high`.
- Create `demo-project/Expected/order-review-output.json` with `reviewRequired: true`.
- Leave the three baseline files byte-for-byte unchanged.
- Do not change packages, the QaaS framework, or the environment; do not run QaaS.
- Verify baseline SHA-256 values, parse and match both JSON files, and check the observed YAML lines.

Choose **Approve**, **Revise**, or **Cancel**.

**Controlled operator (scripted):** Approve.

The exact proxy plan is `proxy-plan.json`. This controlled response is visual evidence of the gate, not a signed approval created by the plugin.

## Screenshot moment 4 — Implemented, then verified with bounded claims

**Codex:** Created the three approved fixture files. Static verification passed: all three baseline SHA-256 values are unchanged, both new JSON files parse and match the approved values, and the new YAML contains the five observed pattern lines.

Actual command:

```powershell
node validation/docs-demo-session/verify-demo.mjs --fixture-only
```

Actual result:

```json
{
  "status": "passed",
  "scope": "static synthetic fixture verification",
  "checks": {
    "baselineSha256": 3,
    "observedYamlPatternLines": 5,
    "inputJson": "parsed-and-matched",
    "expectedJson": "parsed-and-matched"
  },
  "claudeCodeExecuted": false,
  "qaasRuntimeExecuted": false
}
```

Two focused public-fixture tests passed and two focused plan-contract tests passed; their exact output is in `raw/`. The full verifier was run separately after capture to bind both PNG hashes and both capture-tool hashes. A separate integrated workflow test reached its 120-second timeout and was stopped, so it is recorded in `raw/runtime-e2e-attempt.txt` and is not counted as evidence.

No Claude Code session, QaaS runtime, target service, broker, environment, or external oracle was executed. This pack proves only the controlled Codex flow and the listed static checks.
