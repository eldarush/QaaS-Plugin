# Internal marketplace

An internal GitLab mirror gives air-gapped users one reviewed source while
preserving the same marketplace/plugin layout as the public repository.

## Mirror policy

- Mirror only reviewed public tags and their verified release bundles.
- Keep the plugin name `qaas`, marketplace name `qaas-plugin`, author Firefly,
  and version unchanged.
- Do not add private projects, evaluations, results, credentials, internal
  endpoints, or documentation copies to the public mirror history.
- Record the public commit/tag, release ZIP SHA-256, transfer approval, and
  internal mirror commit.
- Protect the mirror's release tags and default branch.

The plugin itself never pushes to GitLab. A release owner performs mirroring
through the organization's normal process.

## Prepare on a connected system

1. Select the reviewed public tag.
2. Download the repository/release bundle and checksum.
3. Verify checksum and inspect the per-file manifest.
4. Run `npm run check` from the source checkout.
5. Transfer the approved artifacts.

Do not transfer the private evaluation lab.

## Publish internally

An internal administrator creates the GitLab project and imports/pushes the
reviewed commit and tag. Use an internal CA. If source-specific TLS verification
must be disabled, limit it to one exact invocation and document the accepted
risk; never change global Git configuration.

Users can either add the internal Git URL directly when supported by the
installed Claude Code marketplace command, or use a stable reviewed local
checkout:

```powershell
claude plugin marketplace add "<internal-marketplace-checkout>"
claude plugin install qaas@qaas-plugin --scope local
```

In the interactive Claude Code session, the equivalent is:

```text
/plugin marketplace add <internal-marketplace-checkout>
/plugin install qaas@qaas-plugin
/reload-plugins
```

Choose **Local** when the interactive installer asks for scope. Local scope is
recommended because this plugin belongs to one test repository. The checkout
path is a placeholder and must be supplied by the organization. Credentials
belong in an approved Git credential helper or separate environment variable,
never in the URL.

## Update and rollback

For an update, mirror a new reviewed tag, verify its checksum, update the stable
checkout through an administrator/user-owned operation, reload plugins, and run
`/qaas:doctor`. Active task approvals become stale across a plugin update.

For rollback, point the checkout at the prior reviewed tag through the
organization's normal Git operation, reload, and run doctor. The plugin will not
delete files, reset the checkout, or clear its data. Fresh approvals are needed.

Uninstall/removal is user-performed. Review the exact plugin and marketplace
targets in Claude Code before removing them.

## Acceptance before rollout

On the target workstation verify:

- Claude Code reports version >=2.1.180.
- The configured gateway serves MiniMax M2.7.
- The marketplace resolves exactly one `qaas` plugin at the intended tag.
- `/qaas:doctor` attests the hooks and optional-tool inventory.
- The six-command surface is exact.
- Internal docs and package sources resolve without internet access.
- A representative project completes onboarding, planning, static verification,
  approved execution, and an intentional safety denial.

Record this as target-runtime acceptance; do not treat the Codex proxy result as
a substitute.
