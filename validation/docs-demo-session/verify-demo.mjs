#!/usr/bin/env node

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const evidenceRoot = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(evidenceRoot, "demo-project");
const baseline = JSON.parse(
  fs.readFileSync(path.join(evidenceRoot, "baseline-manifest.json"), "utf8"),
);
const evidence = JSON.parse(
  fs.readFileSync(path.join(evidenceRoot, "evidence.json"), "utf8"),
);
const repositoryRoot = path.resolve(evidenceRoot, "..", "..");
const fixtureOnly = process.argv.includes("--fixture-only");

function read(relativePath) {
  return fs.readFileSync(
    path.join(projectRoot, ...relativePath.split("/")),
  );
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest("hex");
}

function verifyPngCapture(capture) {
  assert.match(capture.captureId, /^(?:workflow|evidence)-terminal$/u);
  assert.match(
    capture.source,
    /^node interactive-demo\.mjs --scene=(?:workflow|evidence) --scripted --hold$/u,
  );
  assert.match(capture.captureMechanism, /actual visible terminal/u);
  assert.equal(capture.terminal.processName, "pwsh");
  assert.match(
    capture.terminal.windowTitle,
    /^QaaS Plugin demo - (?:Workflow gate|Verification evidence)$/u,
  );
  assert.ok(
    Number.isFinite(Date.parse(capture.terminal.capturedAt)),
    `invalid capture timestamp: ${capture.captureId}`,
  );
  assert.deepEqual(capture.cropPixels, {
    left: 10,
    top: 0,
    right: 10,
    bottom: 10,
  });

  const capturePath = path.resolve(evidenceRoot, capture.output);
  assert.ok(
    capturePath.startsWith(`${repositoryRoot}${path.sep}`),
    `capture escaped repository: ${capture.output}`,
  );

  const contents = fs.readFileSync(capturePath);
  assert.deepEqual(
    contents.subarray(0, 8),
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    `not a PNG: ${capture.output}`,
  );
  assert.equal(sha256(contents), capture.sha256, `capture changed: ${capture.output}`);
  assert.equal(contents.readUInt32BE(16), capture.width, `width changed: ${capture.output}`);
  assert.equal(contents.readUInt32BE(20), capture.height, `height changed: ${capture.output}`);
}

for (const captureTool of evidence.captureTools) {
  const toolPath = path.resolve(evidenceRoot, captureTool.path);
  assert.ok(
    toolPath.startsWith(`${evidenceRoot}${path.sep}`),
    `capture tool escaped evidence root: ${captureTool.path}`,
  );
  assert.equal(
    sha256(fs.readFileSync(toolPath)),
    captureTool.sha256,
    `capture tool changed: ${captureTool.path}`,
  );
}

for (const file of baseline.files) {
  assert.equal(
    sha256(read(file.path)),
    file.sha256,
    `baseline file changed: ${file.path}`,
  );
}

const yaml = read("Cases/order-review.qaas.yaml").toString("utf8");
for (const exactLine of [
  "protocol: http",
  "serialization: json",
  "kind: smoke",
  "base: &base",
  "  delay: 250 ms",
]) {
  assert.ok(yaml.split(/\r?\n/u).includes(exactLine), `missing ${exactLine}`);
}

const input = JSON.parse(
  read("TestData/order-review-input.json").toString("utf8"),
);
const expected = JSON.parse(
  read("Expected/order-review-output.json").toString("utf8"),
);
assert.deepEqual(input, {
  id: "protected-demo-id",
  riskLevel: "high",
});
assert.deepEqual(expected, {
  reviewRequired: true,
});

if (!fixtureOnly) {
  for (const capture of evidence.documentationCaptures) {
    verifyPngCapture(capture);
  }
}

process.stdout.write(
  `${JSON.stringify(
    {
      status: "passed",
      scope: "static synthetic fixture verification",
      checks: {
        baselineSha256: baseline.files.length,
        observedYamlPatternLines: 5,
        inputJson: "parsed-and-matched",
        expectedJson: "parsed-and-matched",
        documentationCaptures: fixtureOnly
          ? "skipped-by-fixture-only-mode"
          : evidence.documentationCaptures.length,
        captureTools: evidence.captureTools.length,
      },
      claudeCodeExecuted: false,
      qaasRuntimeExecuted: false,
    },
    null,
    2,
  )}\n`,
);
