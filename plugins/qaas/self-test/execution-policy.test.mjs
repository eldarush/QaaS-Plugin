import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AUTOMATED_EXECUTION_POLICY,
  MAX_MANUAL_EXECUTION_EVIDENCE_BYTES,
  assertTrustedRunnerAvailable,
  manualEvidenceRelativePath,
  manualEvidenceTemplate,
  readManualExecutionEvidence,
  validateManualExecutionEvidence,
} from "../scripts/lib/execution-policy.mjs";

const REVIEW_DIGEST = "a".repeat(64);
const PROCESS_DIGEST = "b".repeat(64);
const COMMANDS = [{
  commandIndex: 0,
  processSpecDigest: PROCESS_DIGEST,
}];

test("project/external code execution is fail-closed with no unsafe override", () => {
  assert.equal(
    AUTOMATED_EXECUTION_POLICY.automatedProjectCodeExecution,
    false,
  );
  assert.equal(AUTOMATED_EXECUTION_POLICY.trustedRunnerAvailable, false);
  assert.equal(AUTOMATED_EXECUTION_POLICY.trustedRunnerMechanism, null);
  assert.equal(AUTOMATED_EXECUTION_POLICY.unsafeOverrideAllowed, false);
  assert.deepEqual(AUTOMATED_EXECUTION_POLICY.deniedActionClasses, [
    "restore",
    "build",
    "template",
    "test-run",
    "infrastructure-mutation",
  ]);
  assert.throws(
    () => assertTrustedRunnerAvailable("build"),
    (error) =>
      error.code === "TRUSTED_RUNNER_REQUIRED" &&
      /no demonstrably OS-confined trusted runner/u.test(error.message),
  );
});

test("run-approved has no child-process runner path in this release", async () => {
  const source = await readFile(
    new URL("../scripts/run-approved.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /from\s+["'][^"']*process-runner\.mjs["']/u);
  assert.doesNotMatch(source, /\brunProcess\s*\(/u);
  assert.match(
    source,
    /return prepareManualHandoff\(context, active, action\);/u,
  );
  assert.match(
    source,
    /return importManualEvidence\(context, active, action\);/u,
  );
  assert.match(source, /assertTrustedRunnerAvailable\(/u);
});

test("manual evidence binds the reviewed action, digest, command, and attestation", () => {
  const evidence = manualEvidenceTemplate({
    action: "build",
    reviewDigest: REVIEW_DIGEST,
    commands: COMMANDS,
  });
  evidence.results[0].startedAt = "2026-07-26T08:00:00.000Z";
  evidence.results[0].finishedAt = "2026-07-26T08:00:01.000Z";
  evidence.results[0].stdout = "Build succeeded.";
  const validated = validateManualExecutionEvidence(evidence, {
    action: "build",
    reviewDigest: REVIEW_DIGEST,
    commands: COMMANDS,
  });
  assert.equal(validated.userAttested, true);
  assert.equal(validated.results[0].processSpecDigest, PROCESS_DIGEST);

  const stale = structuredClone(evidence);
  stale.reviewDigest = "c".repeat(64);
  assert.throws(
    () =>
      validateManualExecutionEvidence(stale, {
        action: "build",
        reviewDigest: REVIEW_DIGEST,
        commands: COMMANDS,
      }),
    /review digest is stale/u,
  );

  const injected = structuredClone(evidence);
  injected.userAttestation = "The model says this was run.";
  assert.throws(
    () =>
      validateManualExecutionEvidence(injected, {
        action: "build",
        reviewDigest: REVIEW_DIGEST,
        commands: COMMANDS,
      }),
    /exact user-run attestation/u,
  );
});

test("manual evidence read is fixed inside the project and bounded", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qaas-manual-evidence-"));
  const relative = manualEvidenceRelativePath(REVIEW_DIGEST, "test-run");
  const target = path.join(root, ...relative.split("/"));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, '{"schemaVersion":"1.0"}', "utf8");
  assert.deepEqual(
    await readManualExecutionEvidence(root, relative),
    { schemaVersion: "1.0" },
  );

  await writeFile(
    target,
    Buffer.alloc(MAX_MANUAL_EXECUTION_EVIDENCE_BYTES + 1, 0x20),
  );
  await assert.rejects(
    readManualExecutionEvidence(root, relative),
    /exceeds 16384 bytes/u,
  );
  await assert.rejects(
    readManualExecutionEvidence(root, "../outside.json"),
    /escapes the project/u,
  );
});
