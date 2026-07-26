import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAssetNames } from "./release-assets.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

test("release asset inventory contains only the plugin package", () => {
  assert.deepEqual(releaseAssetNames("0.4.0"), [
    "qaas-plugin-0.4.0.zip",
    "qaas-plugin-0.4.0.zip.sha256",
    "qaas-plugin-0.4.0.zip.manifest.json",
  ]);
  assert.throws(() => releaseAssetNames("../0.4.0"), /stable X.Y.Z/);
});

test("workflows validate and publish without documentation deployment", () => {
  const release = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "release.yml"),
    "utf8",
  );
  const validation = fs.readFileSync(
    path.join(repositoryRoot, ".github", "workflows", "validate.yml"),
    "utf8",
  );

  assert.match(release, /CANONICAL_REPOSITORY: TheSmokeTeam\/QaaS-Plugin/u);
  assert.match(release, /npm run check/u);
  assert.match(release, /release-assets\.mjs/u);
  assert.match(release, /immutable/u);
  assert.doesNotMatch(
    `${release}\n${validation}`,
    /docs-site|qaas-plugin-docs|DOCKER_PASSWORD|RELEASE_ADMIN_TOKEN/u,
  );
  assert.match(
    validation,
    /rhysd\/actionlint@sha256:887a259a5a534f3c4f36cb02dca341673c6089431057242cdc931e9f133147e9/u,
  );
});
