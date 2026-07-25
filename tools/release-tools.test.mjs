import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./release-assets.mjs";
import {
  verifyManifestDocument,
  verifyProvenanceDocument,
  verifySbomDocument,
} from "./verify-docs-registry-image.mjs";

const sha = (digit) => `sha256:${digit.repeat(64)}`;
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("release asset inventory is exact and includes both Kubernetes modes", () => {
  const assets = releaseAssetNames("0.4.0");
  assert.equal(assets.length, 10);
  assert.equal(new Set(assets).size, assets.length);
  assert.ok(assets.includes("qaas-plugin-docs-kubernetes-0.4.0.yaml"));
  assert.ok(
    assets.includes("qaas-plugin-docs-kubernetes-airgap-0.4.0.yaml"),
  );
  assert.throws(() => releaseAssetNames("../0.4.0"), /stable X.Y.Z/);
});

test("manifest verification binds one attestation to each required subject", () => {
  const platforms = verifyManifestDocument({
    manifests: [
      {
        digest: sha("a"),
        platform: { os: "linux", architecture: "amd64" },
      },
      {
        digest: sha("b"),
        platform: { os: "linux", architecture: "arm64" },
      },
      {
        digest: sha("c"),
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": sha("a"),
        },
      },
      {
        digest: sha("d"),
        annotations: {
          "vnd.docker.reference.type": "attestation-manifest",
          "vnd.docker.reference.digest": sha("b"),
        },
      },
    ],
  });
  assert.deepEqual(
    platforms.map(({ name, digest }) => ({ name, digest })),
    [
      { name: "linux/amd64", digest: sha("a") },
      { name: "linux/arm64", digest: sha("b") },
    ],
  );

  assert.throws(
    () =>
      verifyManifestDocument({
        manifests: [
          {
            digest: sha("a"),
            platform: { os: "linux", architecture: "amd64" },
          },
          {
            digest: sha("b"),
            platform: { os: "linux", architecture: "arm64" },
          },
        ],
      }),
    /subject-bound attestation/,
  );
});

test("provenance verification requires canonical source and exact revision", () => {
  const revision = "1".repeat(40);
  const document = {
    SLSA: {
      buildType: "https://mobyproject.org/buildkit@v1",
      invocation: {
        configSource: {
          entryPoint: "Dockerfile",
        },
        parameters: {
          frontend: "dockerfile.v0",
          args: {
            "label:org.opencontainers.image.source":
              "https://github.com/TheSmokeTeam/QaaS-Plugin",
            "label:org.opencontainers.image.revision": revision,
          },
        },
      },
    },
  };

  verifyProvenanceDocument(document, {
    platform: "linux/amd64",
    source: "https://github.com/TheSmokeTeam/QaaS-Plugin",
    revision,
  });
  assert.throws(
    () =>
      verifyProvenanceDocument(document, {
        platform: "linux/amd64",
        source: "https://github.com/TheSmokeTeam/Other",
        revision,
      }),
    /not bound to source/,
  );
  assert.throws(
    () =>
      verifyProvenanceDocument(document, {
        platform: "linux/amd64",
        source: "https://github.com/TheSmokeTeam/QaaS-Plugin",
        revision: "2".repeat(40),
      }),
    /not bound to revision/,
  );
});

test("SBOM verification requires a populated SPDX document", () => {
  verifySbomDocument(
    {
      SPDX: {
        spdxVersion: "SPDX-2.3",
        SPDXID: "SPDXRef-DOCUMENT",
        dataLicense: "CC0-1.0",
        documentNamespace: "https://example.invalid/spdx/document",
        packages: [{ name: "node" }],
      },
    },
    "linux/amd64",
  );
  assert.throws(
    () => verifySbomDocument({ SPDX: { packages: [] } }, "linux/amd64"),
    /invalid SPDX document identity/,
  );
});

test("publication workflows retain fail-closed ordering and pinned linting", () => {
  const release = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const validation = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "validate.yml"),
    "utf8",
  );
  const githubPreflight = release.indexOf(
    "Prove GitHub publication prerequisites",
  );
  const registryMutation = release.indexOf(
    "Build and push multi-platform documentation image",
  );
  assert.ok(githubPreflight >= 0 && githubPreflight < registryMutation);
  assert.match(release, /CANONICAL_REPOSITORY: TheSmokeTeam\/QaaS-Plugin/u);
  assert.match(release, /RELEASE_ADMIN_TOKEN/u);
  assert.match(release, /verify-docs-registry-image\.mjs/u);
  assert.match(release, /rewrite-timestamp=true/u);
  assert.doesNotMatch(release, /qaas-plugin-docs:preview/u);
  assert.match(
    validation,
    /rhysd\/actionlint@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9/u,
  );
});
