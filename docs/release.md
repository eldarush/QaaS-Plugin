# Release owner workflow

This runbook publishes one stable plugin version as an immutable GitHub
pre-release, GitHub Pages deployment, multi-platform Docker Hub image, connected
digest-pinned Kubernetes manifest, and standalone Linux/amd64 air-gap archive.
Publication is supported only from `TheSmokeTeam/QaaS-Plugin`.

## One-time repository preparation

Before creating a release tag:

1. Create or confirm the public canonical GitHub repository
   `TheSmokeTeam/QaaS-Plugin`.
2. Enable GitHub immutable releases for that repository.
3. Configure GitHub Pages to deploy through GitHub Actions and confirm its URL
   is `https://thesmoketeam.github.io/QaaS-Plugin/`.
4. Create the public Docker Hub repository
   `thesmoketeam/qaas-plugin-docs`.
5. Add repository secrets `DOCKER_USERNAME` and `DOCKER_PASSWORD`. Use a
   Docker Hub access token restricted to the publication account rather than an
   account password.
6. Add `RELEASE_ADMIN_TOKEN`, a fine-grained GitHub token restricted to this
   repository with **Administration: read-only** permission. GitHub requires
   admin-read access for the immutable-release status endpoint; the automatic
   workflow token cannot request that permission. Do not grant this token write
   access.
7. Protect `main` and release tags from deletion or retargeting by ordinary
   contributors. Limit workflow and secret administration to release owners.

Prove the GitHub settings without changing them:

```powershell
gh api repos/TheSmokeTeam/QaaS-Plugin/immutable-releases --jq .enabled
gh api repos/TheSmokeTeam/QaaS-Plugin/pages `
  --jq '{build_type,html_url,status}'
gh secret list --repo TheSmokeTeam/QaaS-Plugin
docker buildx imagetools inspect `
  docker.io/thesmoketeam/qaas-plugin-docs:0.4.0
```

For an unpublished version, the final command is expected to report
`manifest unknown`. Authentication, permission, timeout, and rate-limit errors
are not evidence that a tag is absent.

## Prepare the version

1. Set the stable `X.Y.Z` value in `version.json`.
2. Run `npm run sync-version`.
3. Review every changed version-bearing file and release note.
4. Run `npm run check`.
5. Run actionlint and strict kubeconform through the pinned validation
   containers in `.github/workflows/validate.yml`.
6. Complete the target acceptance items required for a public preview.
7. Merge the exact release commit to canonical `main` and wait for both
   `validate.yml` and `docs-pages.yml` to succeed for that commit.

Create `vX.Y.Z` only after those checks. Do not reuse or retarget a release tag.
The release workflow requires the tag to resolve to a commit reachable from
canonical `main` and requires `version.json` to match it exactly.

## Publish

Pushing the tag starts `.github/workflows/release.yml`. A manual rerun may
select the same existing tag through `workflow_dispatch`.

The workflow stops before Docker mutation unless it proves:

- it is running in the canonical repository;
- immutable releases are enabled;
- the remote tag still resolves to the checked commit;
- Pages successfully deployed that commit at the canonical URL;
- any existing release is either absent, a recoverable prerelease draft with
  only expected assets, or an exact immutable prerelease.

If no release exists, the workflow reserves an empty draft before Docker
publication. If one of the two immutable Docker tags exists after an interrupted
push, the workflow verifies its labels, platforms, subject binding, provenance,
source revision, and SPDX SBOM before attaching the missing tag to the same
digest. It never overwrites a conflicting tag.

Do not manually upload, replace, or delete draft assets while the workflow is
running. A rerun first verifies every existing expected asset byte-for-byte,
uploads only missing assets, downloads and verifies the exact final set, and
only then publishes the draft.

## Verify the published result

Confirm the release is an immutable prerelease and has exactly the asset names
listed by `node tools/release-assets.mjs X.Y.Z`:

```powershell
gh api repos/TheSmokeTeam/QaaS-Plugin/releases/tags/vX.Y.Z `
  --jq '{draft,prerelease,immutable,assets:[.assets[].name]}'
```

Download all assets into an empty directory, then verify the aggregate checksum:

```powershell
gh release download vX.Y.Z --repo TheSmokeTeam/QaaS-Plugin
sha256sum --check "qaas-plugin-X.Y.Z-release.sha256"
```

Read `qaas-plugin-docs-X.Y.Z.registry-digest.txt` and inspect that exact digest:

```powershell
$image = (Get-Content -Raw `
  "qaas-plugin-docs-X.Y.Z.registry-digest.txt").Trim()
$env:QAAS_PLUGIN_DOCS_REGISTRY_REFERENCE = $image
$env:QAAS_PLUGIN_VERSION = "X.Y.Z"
$env:QAAS_PLUGIN_SOURCE_REVISION = "<40-character-release-commit>"
$env:QAAS_PLUGIN_SOURCE_URL = "https://github.com/TheSmokeTeam/QaaS-Plugin"
node tools/verify-docs-registry-image.mjs
```

Verify the connected Kubernetes manifest contains that exact registry index
digest. Separately verify the air-gap manifest uses
`imagePullPolicy: Never`, then checksum, load, and smoke-test the offline archive
on Linux/amd64. Loading the standalone archive does not satisfy the connected
multi-platform registry-index digest; use the dedicated air-gap manifest.

## Recovery boundary

GitHub and Docker Hub do not offer one atomic cross-registry transaction. The
workflow therefore reserves a recoverable GitHub draft, rechecks the remote tag
and release state immediately before Docker mutation, repairs only a missing
alias to an already verified digest, and makes every release-asset upload
idempotent.

If a privileged administrator retargets a tag, changes a Docker tag, disables
immutable releases, or modifies the draft concurrently after its final check,
stop publication and investigate. Do not delete or overwrite evidence. Restore
the intended external state through the repository's audited administrator
process, then rerun the same tag only when every existing immutable byte and
digest matches; otherwise publish a new version.
