# Documentation demo-session evidence pack

This directory contains a privacy-safe, controlled Codex proxy session recorded
in a real Windows terminal. It uses a derivative of the repository's public
synthetic D20-01 project-shape fixture and includes the exact local commands and
captured results.

Start with:

- `session-transcript.md` — the source dialogue covering focused intake, one-question-at-a-time mapping, approval, and bounded verification.
- `interactive-demo.mjs` — the deterministic interactive terminal runner. `--scripted` supplies the declared operator answers while still executing the real local inventory, routing, fixture, and focused contract checks.
- `capture-terminal-window.ps1` — the read-only Windows capture helper. It selects one exact visible `pwsh` window, verifies the synthetic title, captures its DPI-aware window bounds, and removes only the DWM shadow pixels.
- `evidence.json` — machine-readable provenance, commands, hashes, results, and claim boundaries.
- `proxy-plan.json` — exact controlled plan and approval-gate fixture.
- `baseline-manifest.json` — pre-change SHA-256 values.
- `raw/` — unabridged command outputs, including the transparently recorded timed-out attempt.
- `demo-project/` — synthetic baseline and the three approved fixture-level additions.

Reproduce the dependency-free static check from the repository root:

```powershell
node validation/docs-demo-session/verify-demo.mjs
```

The documentation publishes literal terminal-window PNGs at
`docs-site/src/assets/demo/`. Their runner and capture-tool hashes, terminal
process IDs, window titles, capture timestamps, privacy crop, dimensions, and
SHA-256 values are recorded in `evidence.json`.

The capture sequence used a visible 110-column by 30-line PowerShell terminal:

```powershell
$command = "mode.com con cols=110 lines=30 | Out-Null; node validation/docs-demo-session/interactive-demo.mjs --scene=workflow --scripted --hold"
$terminal = Start-Process pwsh.exe -WorkingDirectory $PWD -ArgumentList @("-NoLogo", "-NoExit", "-Command", $command) -PassThru
& validation/docs-demo-session/capture-terminal-window.ps1 -TargetProcessId $terminal.Id -OutputPath docs-site/src/assets/demo/workflow-capture.png
```

The evidence scene used the same sequence with `--scene=evidence`. Computer Use
was used only to inspect available windows; it supplied no terminal input
because its safety policy prohibits terminal automation. The read-only helper
captured the actual visible terminal after the scripted runner completed.

The successful result proves only that the recorded baseline files are unchanged, the two new JSON files parse and match their approved values, and the new YAML contains the five already-observed pattern lines.

No Claude Code session, QaaS runtime, target service, broker, environment, or external oracle was executed. Inventory and routing output remain candidate/routing evidence; they do not grant readiness or establish QaaS semantics. The approval response is scripted demo input, not a live human or signed plugin approval.
