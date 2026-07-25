import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { safeEqualHex } from "./canonical-json.mjs";
import { assertNoSecrets } from "./redact.mjs";

export const MAX_MANUAL_EXECUTION_EVIDENCE_BYTES = 16 * 1024;
const MAX_MANUAL_OUTPUT_BYTES = 12 * 1024;
const MANUAL_ATTESTATION =
  "I ran the exact reviewed command vector outside the QaaS plugin.";

export const AUTOMATED_EXECUTION_POLICY = Object.freeze({
  schemaVersion: "1.0",
  automatedProjectCodeExecution: false,
  trustedRunnerRequired: true,
  trustedRunnerAvailable: false,
  trustedRunnerMechanism: null,
  unsafeOverrideAllowed: false,
  deniedActionClasses: Object.freeze([
    "restore",
    "build",
    "template",
    "test-run",
    "infrastructure-mutation",
  ]),
  fallback: "user-run-and-bounded-evidence-import",
  reason:
    "This release has no demonstrably OS-confined trusted runner for project or external code.",
});

export function assertTrustedRunnerAvailable(actionClass) {
  if (
    AUTOMATED_EXECUTION_POLICY.trustedRunnerAvailable === true &&
    typeof AUTOMATED_EXECUTION_POLICY.trustedRunnerMechanism === "string"
  ) {
    return;
  }
  const error = new Error(
    `Automatic ${actionClass} execution is disabled: ${AUTOMATED_EXECUTION_POLICY.reason}`,
  );
  error.code = "TRUSTED_RUNNER_REQUIRED";
  throw error;
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function exactKeys(value, expected, label) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new Error(`${label} must be a plain object`);
  }
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${label} fields must be exactly: ${wanted.join(", ")}`);
  }
}

function validTimestamp(value) {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function manualEvidenceRelativePath(reviewDigest, action) {
  if (!/^[a-f0-9]{64}$/u.test(reviewDigest)) {
    throw new Error("Manual evidence requires an exact review digest");
  }
  if (!/^(?:restore|build|template|test-run|mutation)$/u.test(action)) {
    throw new Error("Manual evidence action is unsupported");
  }
  return `.qaas-user-evidence/${reviewDigest}-${action}.json`;
}

export function manualEvidenceTemplate({
  action,
  reviewDigest,
  commands,
}) {
  return {
    schemaVersion: "1.0",
    action,
    reviewDigest,
    userAttestation: MANUAL_ATTESTATION,
    results: commands.map((command, index) => ({
      commandIndex: command.commandIndex,
      attempt: index + 1,
      processSpecDigest: command.processSpecDigest,
      exitCode: 0,
      startedAt: "2026-01-01T00:00:00.000Z",
      finishedAt: "2026-01-01T00:00:00.000Z",
      stdout: "",
      stderr: "",
    })),
  };
}

export function validateManualExecutionEvidence(
  document,
  {
    action,
    reviewDigest,
    commands,
    maximumAttempts = commands.length,
  },
) {
  exactKeys(
    document,
    [
      "schemaVersion",
      "action",
      "reviewDigest",
      "userAttestation",
      "results",
    ],
    "manual execution evidence",
  );
  if (document.schemaVersion !== "1.0") {
    throw new Error("Manual execution evidence schemaVersion must be 1.0");
  }
  if (document.action !== action) {
    throw new Error("Manual execution evidence action does not match the handoff");
  }
  if (!safeEqualHex(document.reviewDigest, reviewDigest)) {
    throw new Error("Manual execution evidence review digest is stale");
  }
  if (document.userAttestation !== MANUAL_ATTESTATION) {
    throw new Error(
      "Manual execution evidence lacks the exact user-run attestation",
    );
  }
  if (
    !Array.isArray(document.results) ||
    document.results.length < 1 ||
    document.results.length > maximumAttempts
  ) {
    throw new Error(
      `Manual execution evidence must contain 1-${maximumAttempts} bounded results`,
    );
  }
  if (action !== "test-run" && document.results.length !== commands.length) {
    throw new Error(
      "Manual execution evidence must contain one result for every reviewed command",
    );
  }
  let outputBytes = 0;
  const normalized = document.results.map((result, index) => {
    exactKeys(
      result,
      [
        "commandIndex",
        "attempt",
        "processSpecDigest",
        "exitCode",
        "startedAt",
        "finishedAt",
        "stdout",
        "stderr",
      ],
      `manual execution result ${index}`,
    );
    const command =
      action === "test-run"
        ? commands[0]
        : commands.find((entry) => entry.commandIndex === result.commandIndex);
    if (
      !command ||
      !Number.isInteger(result.commandIndex) ||
      result.commandIndex !== command.commandIndex ||
      !safeEqualHex(result.processSpecDigest, command.processSpecDigest)
    ) {
      throw new Error(
        `Manual execution result ${index} does not bind a reviewed command`,
      );
    }
    if (
      !Number.isInteger(result.attempt) ||
      result.attempt !== index + 1
    ) {
      throw new Error(
        `Manual execution result ${index} has a non-sequential attempt number`,
      );
    }
    if (
      !Number.isInteger(result.exitCode) ||
      result.exitCode < -2147483648 ||
      result.exitCode > 4294967295
    ) {
      throw new Error(`Manual execution result ${index} has an invalid exit code`);
    }
    if (
      !validTimestamp(result.startedAt) ||
      !validTimestamp(result.finishedAt) ||
      Date.parse(result.finishedAt) < Date.parse(result.startedAt)
    ) {
      throw new Error(
        `Manual execution result ${index} has invalid timestamps`,
      );
    }
    if (typeof result.stdout !== "string" || typeof result.stderr !== "string") {
      throw new Error(
        `Manual execution result ${index} output must be UTF-8 text`,
      );
    }
    outputBytes += Buffer.byteLength(result.stdout, "utf8");
    outputBytes += Buffer.byteLength(result.stderr, "utf8");
    return { ...result };
  });
  if (outputBytes > MAX_MANUAL_OUTPUT_BYTES) {
    throw new Error(
      `Manual execution output exceeds ${MAX_MANUAL_OUTPUT_BYTES} bytes`,
    );
  }
  assertNoSecrets(document, "manual execution evidence");
  return {
    schemaVersion: "1.0",
    action,
    reviewDigest,
    userAttested: true,
    results: normalized,
  };
}

export async function readManualExecutionEvidence(
  projectRoot,
  relativePath,
) {
  const root = path.resolve(projectRoot);
  const target = path.resolve(
    root,
    ...String(relativePath).replaceAll("\\", "/").split("/"),
  );
  if (!isInside(root, target) || target === root) {
    throw new Error("Manual evidence path escapes the project");
  }
  let cursor = root;
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) {
      throw new Error("Manual evidence path may not follow a symlink");
    }
  }
  const info = await lstat(target);
  if (!info.isFile()) {
    throw new Error("Manual evidence must be one regular file");
  }
  if (info.size > MAX_MANUAL_EXECUTION_EVIDENCE_BYTES) {
    throw new Error(
      `Manual evidence exceeds ${MAX_MANUAL_EXECUTION_EVIDENCE_BYTES} bytes`,
    );
  }
  const bytes = await readFile(target);
  const text = bytes.toString("utf8");
  if (Buffer.byteLength(text, "utf8") !== bytes.byteLength || text.includes("\uFFFD")) {
    throw new Error("Manual evidence must be valid UTF-8");
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Manual evidence is invalid JSON: ${error.message}`);
  }
}
