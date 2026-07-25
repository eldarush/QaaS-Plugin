import { lstat, readdir } from "node:fs/promises";
import path from "node:path";
import {
  findApprovalByDigest,
} from "./lib/approval-authority.mjs";
import {
  safeEqualHex,
  sha256,
} from "./lib/canonical-json.mjs";
import {
  isDirectExecution,
  parseNamedArguments,
  printJson,
} from "./lib/cli.mjs";
import {
  createEvidenceEvent,
  recordEvidence,
} from "./lib/evidence.mjs";
import { runProcess } from "./lib/process-runner.mjs";
import {
  validateSourceCheckout,
} from "./lib/source-checkout-validation.mjs";
import { commitCheckpoint } from "./lib/state.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";

async function mustNotExist(target) {
  try {
    await lstat(target);
    throw new Error("Reference checkout destination already exists");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function assertBoundedCheckout(
  root,
  {
    maxFiles = 20_000,
    maxBytes = 512 * 1024 * 1024,
    maxFileBytes = 256 * 1024 * 1024,
  } = {},
) {
  let files = 0;
  let bytes = 0;
  const visit = async (target) => {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new Error("Bare checkout contains an unexpected symbolic link");
    }
    if (info.isDirectory()) {
      const entries = await readdir(target);
      for (const entry of entries.sort()) {
        await visit(path.join(target, entry));
      }
      return;
    }
    if (!info.isFile()) {
      throw new Error("Bare checkout contains a non-file filesystem object");
    }
    files += 1;
    bytes += info.size;
    if (files > maxFiles || bytes > maxBytes || info.size > maxFileBytes) {
      throw new Error("Bare checkout exceeded its reviewed file/byte safety bound");
    }
  };
  await visit(root);
  return { files, bytes };
}

async function consumeCheckoutApproval(context, state, marker) {
  const {
    "source-checkout": _consumed,
    ...approvedDigests
  } = state.approvedDigests ?? {};
  return commitCheckpoint(
    context.authority,
    state,
    {
      approvedDigests,
      completedWork: marker
        ? [...state.completedWork, marker]
        : state.completedWork,
      nextLegalAction: "Continue bounded read-only discovery",
    },
    { reason: "Consumed one-use source checkout approval" },
  );
}

export async function runSourceCheckout(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const args = parseNamedArguments(argv);
  if (
    typeof args["checkout-id"] !== "string" ||
    !/^[A-Za-z0-9._-]{1,80}$/u.test(args["checkout-id"])
  ) {
    throw new Error("--checkout-id is required");
  }
  const context = await runtimeContext(env);
  const active = await activeSession(context, args["session-handle"]);
  if (active.state.phase !== "DISCOVERING") {
    throw new Error("Reference checkout is legal only during discovery");
  }
  const artifact = await context.authority.readSigned(
    "artifacts/source-checkout.json",
  );
  const review = await context.authority.readSigned(
    "artifacts/source-checkout-review.json",
  );
  const document = artifact.payload.document;
  if (
    document.checkoutId !== args["checkout-id"] ||
    !safeEqualHex(review.payload.artifactDigest, artifact.payload.digest) ||
    !safeEqualHex(
      active.state.approvedDigests?.["source-checkout"],
      review.payload.digest,
    )
  ) {
    throw new Error("Signed source checkout review/approval is stale");
  }
  const validation = validateSourceCheckout(document, context.env);
  if (!validation.valid) {
    throw new Error(
      `Source checkout configuration changed: ${validation.errors
        .map((entry) => `${entry.path}: ${entry.message}`)
        .join("; ")}`,
    );
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "source-checkout",
    approvedDigest: review.payload.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) {
    throw new Error("Current session/lease lacks exact source checkout approval");
  }
  const expectedDestination = context.authority.resolveProtectedPath(
    `r/${artifact.payload.digest.slice(0, 24)}.git`,
  );
  if (path.resolve(review.payload.destination) !== path.resolve(expectedDestination)) {
    throw new Error("Source checkout destination differs from its signed review");
  }
  const existing = await context.authority.readSigned(
    `checkouts/${sha256(document.checkoutId)}.json`,
    { required: false },
  );
  if (existing) throw new Error("Checkout ID has already been consumed");
  await mustNotExist(expectedDestination);
  const checkoutRecordPath = `checkouts/${sha256(document.checkoutId)}.json`;
  await context.authority.writeSigned(
    checkoutRecordPath,
    {
      schemaVersion: "1.0",
      projectId: context.authority.projectId,
      checkoutId: document.checkoutId,
      source: document.source,
      repositoryUrl: document.repositoryUrl,
      ref: document.ref,
      requestedCommit: document.commit,
      destination: expectedDestination,
      reviewDigest: review.payload.digest,
      leaseId: active.lease.leaseId,
      sessionId: active.attestation.sessionId,
      status: "reserved",
      reservedAt: new Date().toISOString(),
      sequence: 0,
    },
    { expectedSequence: -1 },
  );
  await context.authority.appendEvent(
    "source-checkout-preauthorization-consumed",
    {
      checkoutId: document.checkoutId,
      reviewDigest: review.payload.digest,
      leaseId: active.lease.leaseId,
      destination: expectedDestination,
    },
  );
  const checkoutEnvironment = {
    ...context.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: document.tlsVerify ? "1" : "2",
    GIT_CONFIG_KEY_0: "http.followRedirects",
    GIT_CONFIG_VALUE_0: "false",
    ...(document.tlsVerify
      ? {}
      : {
          GIT_CONFIG_KEY_1: "http.sslVerify",
          GIT_CONFIG_VALUE_1: "false",
        }),
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_NO_LAZY_FETCH: "1",
  };
  let cloneResult;
  try {
    const binding = review.payload.cloneBinding;
    cloneResult = await runProcess({
      program: binding.resolvedProgram,
      args: review.payload.cloneCommand.args,
      cwd: context.authority.resolveProtectedPath("r"),
      envNames: [
        "GIT_TERMINAL_PROMPT",
        "GIT_LFS_SKIP_SMUDGE",
        "GIT_NO_LAZY_FETCH",
        "GIT_CONFIG_GLOBAL",
        "GIT_CONFIG_NOSYSTEM",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_KEY_0",
        "GIT_CONFIG_VALUE_0",
        ...(document.tlsVerify
          ? []
          : [
              "GIT_CONFIG_KEY_1",
              "GIT_CONFIG_VALUE_1",
            ]),
        ...(document.credentialEnv ? [document.credentialEnv] : []),
      ],
      timeoutMs: 120_000,
      outputLimitBytes: 64 * 1024,
      outputDirectories: [expectedDestination],
      scopeRoot: context.authority.resolveProtectedPath("r"),
      actionClass: "source-checkout-write",
      environment: checkoutEnvironment,
      expectedSpecDigest: binding.processSpecDigest,
      approvedExecutablePath: binding.resolvedProgram,
      expectedExecutableDigest: binding.executableDigest,
      verifyAuthorization: async (specification) =>
        safeEqualHex(specification.specDigest, binding.processSpecDigest) &&
        safeEqualHex(approval.approvedDigest, review.payload.digest),
    });
    if (cloneResult.exitCode !== 0 || cloneResult.timedOut || cloneResult.truncated) {
      throw new Error(
        `Exact bounded source clone failed: ${
          cloneResult.timedOut
            ? "timeout"
            : cloneResult.truncated
              ? "bounded output exceeded"
              : cloneResult.stderr.trim() || `exit ${cloneResult.exitCode}`
        }`,
      );
    }
    const checkoutBounds = await assertBoundedCheckout(expectedDestination);
    const verifyGit = async (revision) =>
      runProcess({
        program: review.payload.gitVerifier.resolvedProgram,
        args: [
          "--git-dir",
          expectedDestination,
          "rev-parse",
          "--verify",
          revision,
        ],
        cwd: context.authority.resolveProtectedPath("r"),
        timeoutMs: 15_000,
        outputLimitBytes: 4 * 1024,
        actionClass: "ordinary-read",
        envNames: ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_NOSYSTEM"],
        environment: checkoutEnvironment,
        approvedExecutablePath: review.payload.gitVerifier.resolvedProgram,
        expectedExecutableDigest:
          review.payload.gitVerifier.executableDigest,
      });
    const commitResult = await verifyGit(`${document.commit}^{commit}`);
    const resolvedCommit = commitResult.stdout.trim().toLowerCase();
    if (
      commitResult.exitCode !== 0 ||
      commitResult.timedOut ||
      commitResult.truncated ||
      resolvedCommit !== document.commit
    ) {
      throw new Error("Cloned source does not contain the exact approved commit");
    }
    const treeResult = await verifyGit(`${document.commit}^{tree}`);
    const treeDigest = treeResult.stdout.trim().toLowerCase();
    if (
      treeResult.exitCode !== 0 ||
      treeResult.timedOut ||
      treeResult.truncated ||
      !/^[a-f0-9]{40,64}$/u.test(treeDigest)
    ) {
      throw new Error("Cloned source tree could not be attested");
    }
    const record = {
      schemaVersion: "1.0",
      projectId: context.authority.projectId,
      checkoutId: document.checkoutId,
      source: document.source,
      repositoryUrl: document.repositoryUrl,
      ref: document.ref,
      commit: resolvedCommit,
      treeDigest,
      destination: expectedDestination,
      reviewDigest: review.payload.digest,
      cloneSpecDigest: cloneResult.specDigest,
      checkoutBounds,
      gitVerifier: review.payload.gitVerifier,
      status: "complete",
      completedAt: new Date().toISOString(),
      sequence: 1,
    };
    await context.authority.writeSigned(
      checkoutRecordPath,
      record,
      { expectedSequence: 0 },
    );
    const evidence = createEvidenceEvent({
      projectId: context.authority.projectId,
      taskId: active.state.taskId,
      type: "source-checkout",
      actionClass: "source-checkout-write",
      status: "success",
      tool: document.transport,
      inputDigest: review.payload.digest,
      outputDigest: sha256({
        commit: resolvedCommit,
        treeDigest,
        cloneSpecDigest: cloneResult.specDigest,
        checkoutBounds,
      }),
      details: {
        checkoutId: document.checkoutId,
        source: document.source,
        commit: resolvedCommit,
        treeDigest,
      },
    });
    await recordEvidence(context.authority, evidence);
    await consumeCheckoutApproval(
      context,
      active.state,
      `reference checkout ${document.checkoutId} pinned ${resolvedCommit}`,
    );
    return {
      checkoutId: document.checkoutId,
      source: document.source,
      commit: resolvedCommit,
      treeDigest,
      evidenceDigest: evidence.digest,
      approvalConsumed: true,
    };
  } catch (error) {
    const checkoutRecord = await context.authority.readSigned(
      checkoutRecordPath,
      { required: false },
    );
    if (checkoutRecord?.payload.status === "reserved") {
      await context.authority.writeSigned(
        checkoutRecordPath,
        {
          ...checkoutRecord.payload,
          status: "failed",
          failedAt: new Date().toISOString(),
          cloneSpecDigest: cloneResult?.specDigest ?? null,
          errorDigest: sha256(error.message),
          sequence: checkoutRecord.payload.sequence + 1,
        },
        { expectedSequence: checkoutRecord.payload.sequence },
      );
    }
    await context.authority.appendEvent("source-checkout-failed", {
      checkoutId: document.checkoutId,
      reviewDigest: review.payload.digest,
      cloneSpecDigest: cloneResult?.specDigest ?? null,
      errorDigest: sha256(error.message),
    });
    const current = (
      await context.authority.readSigned("state/current.json")
    ).payload;
    await consumeCheckoutApproval(context, current, null);
    throw error;
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runSourceCheckout());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
