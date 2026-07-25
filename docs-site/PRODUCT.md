# QaaS Plugin documentation product

## Audience and job

The primary reader is a QA automation engineer working in an existing QaaS
test repository, often through a controlled or air-gapped workstation. Release
owners and security reviewers are secondary readers.

The reader must be able to:

1. Understand the plugin boundary and safety model.
2. Install it at project scope.
3. Move through onboarding, planning, implementation, execution, and diagnosis
   without confusing one approval for another.
4. Prepare a disconnected environment and know what still needs target-runtime
   acceptance.
5. Find the exact six-command reference quickly.
6. Switch between automatic, light, and dark presentation without losing
   content or keyboard context.

## Product truth

- QaaS Plugin is a Claude Code marketplace plugin for documentation-backed,
  project-specific QaaS test authoring and verification.
- It does not modify the QaaS framework or install prerequisites.
- Context writes, implementation, execution, and external evidence each have
  distinct authority.
- Agent-performed deletion, move, rename, cleanup, teardown, prune, and rollback
  are outside the boundary.
- Static success is not runtime proof.
- Hooks are workflow controls, not an operating-system sandbox.

## Surface constraints

- Visible guidance is evergreen; a configured version remains internal build
  and health metadata rather than visible page identity.
- Static hash routes and relative assets must work beneath any GitHub Pages
  repository subpath.
- The runtime makes no external resource requests.
- The rendered site has exactly one external anchor: the configured repository.
- Two reviewed local PNGs are literal terminal captures of a controlled Codex
  proxy with scripted operator input and a synthetic fixture—never customer data
  or live Claude Code/QaaS runtime evidence.
- A separate plugin-documentation catalog keeps its index and focused topic
  pages at or below 16 KiB with same-origin links beneath `catalog/`. It is not
  a substitute for the external QaaS platform/API documentation sources.
- Strict container CSP and the static Pages artifact render the same catalog
  through a local external stylesheet.
- All build, test, server, and container work stays inside `docs-site/`.
- Node.js built-ins are the only development and runtime code dependency.
