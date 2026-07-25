import { isDirectExecution, parseNamedArguments, printJson } from "./lib/cli.mjs";
import {
  canonicalDigest,
  safeEqualHex,
  sha256,
} from "./lib/canonical-json.mjs";
import {
  consumeApproval,
  findApprovalByDigest,
} from "./lib/approval-authority.mjs";
import { runProcess } from "./lib/process-runner.mjs";
import {
  isCredentialBearingPath,
  redactText,
} from "./lib/redact.mjs";
import { readConfiguredSource } from "./lib/source-read-adapter.mjs";
import { resolveSourceReadRequest } from "./lib/source-read-request.mjs";
import { commitCheckpoint } from "./lib/state.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";

function safeCheckoutPath(value) {
  const relative = String(value ?? "").replaceAll("\\", "/");
  return (
    relative.length >= 1 &&
    relative.length <= 500 &&
    !relative.includes("\0") &&
    !relative.startsWith("/") &&
    !relative.endsWith("/") &&
    !relative
      .split("/")
      .some((entry) => entry === ".." || entry === "." || entry === "") &&
    !relative.includes(":")
  );
}

function assertPublicCheckoutPath(relative) {
  const basename = relative.split("/").at(-1) ?? "";
  if (
    isCredentialBearingPath(relative) ||
    /(?:^|[._-])(?:token|secret|password|credentials?|private[_-]?key)(?:[._-]|$)/iu.test(
      basename,
    ) ||
    redactText(relative) !== relative
  ) {
    throw new Error("Approved checkout contains a credential-like path");
  }
}

async function loadCheckoutRecord(context, checkoutId, source) {
  const record = (
    await context.authority.readSigned(
      `checkouts/${sha256(checkoutId)}.json`,
    )
  ).payload;
  if (
    record.status !== "complete" ||
    record.checkoutId !== checkoutId ||
    record.source !== source
  ) {
    throw new Error("Checkout record does not match the requested approved source");
  }
  return record;
}

function checkoutReadEnvironment(context) {
  return {
    ...context.env,
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
}

async function listApprovedCheckout(args, context, checkoutId, record) {
  if (args.path !== undefined) {
    throw new Error("Checkout inventory does not accept --path");
  }
  const itemLimit =
    args["item-limit"] === undefined ? 2_000 : Number(args["item-limit"]);
  const outputLimitBytes =
    args["output-limit-bytes"] === undefined
      ? 1024 * 1024
      : Number(args["output-limit-bytes"]);
  const timeoutMs =
    args["timeout-ms"] === undefined ? 10_000 : Number(args["timeout-ms"]);
  if (
    !Number.isSafeInteger(itemLimit) ||
    itemLimit < 1 ||
    itemLimit > 10_000 ||
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Checkout inventory bounds are invalid");
  }
  const result = await runProcess({
    program: record.gitVerifier.resolvedProgram,
    args: [
      "--git-dir",
      record.destination,
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      record.commit,
    ],
    cwd: context.authority.resolveProtectedPath("r"),
    envNames: [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_LAZY_FETCH",
      "GIT_TERMINAL_PROMPT",
    ],
    timeoutMs,
    outputLimitBytes,
    actionClass: "ordinary-read",
    environment: checkoutReadEnvironment(context),
    approvedExecutablePath: record.gitVerifier.resolvedProgram,
    expectedExecutableDigest: record.gitVerifier.executableDigest,
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new Error("Approved checkout inventory failed or exceeded its byte bound");
  }
  if (result.stdout.includes("\uFFFD")) {
    throw new Error("Approved checkout inventory is not valid UTF-8");
  }
  const paths = result.stdout.endsWith("\0")
    ? result.stdout.slice(0, -1).split("\0")
    : result.stdout.length === 0
      ? []
      : result.stdout.split("\0");
  if (paths.length > itemLimit) {
    throw new Error("Approved checkout inventory exceeded its item bound");
  }
  for (const relative of paths) {
    if (!safeCheckoutPath(relative)) {
      throw new Error("Approved checkout inventory contains an unsafe path");
    }
    assertPublicCheckoutPath(relative);
  }
  return {
    provenance: {
      schemaVersion: "1.0",
      source: record.source,
      checkoutId,
      identifier: `${record.source}:${record.commit}:inventory`,
      commit: record.commit,
      treeDigest: record.treeDigest,
      retrievedAt: new Date().toISOString(),
      itemCount: paths.length,
      inventoryDigest: sha256(paths),
    },
    paths,
  };
}

async function readApprovedCheckout(args, env) {
  const context = await runtimeContext(env);
  await activeSession(context, args["session-handle"]);
  const checkoutId = args["checkout-id"];
  const relative = String(args.path ?? "").replaceAll("\\", "/");
  if (
    typeof checkoutId !== "string" ||
    !/^[A-Za-z0-9._-]{1,80}$/u.test(checkoutId)
  ) {
    throw new Error("Approved checkout read requires a safe checkout ID");
  }
  const record = await loadCheckoutRecord(context, checkoutId, args.source);
  if (args.list === true) {
    return listApprovedCheckout(args, context, checkoutId, record);
  }
  if (!safeCheckoutPath(relative)) {
    throw new Error("Approved checkout read requires a safe path");
  }
  assertPublicCheckoutPath(relative);
  const outputLimitBytes =
    args["output-limit-bytes"] === undefined
      ? 32 * 1024
      : Number(args["output-limit-bytes"]);
  const timeoutMs =
    args["timeout-ms"] === undefined ? 10_000 : Number(args["timeout-ms"]);
  if (
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 1024 * 1024 ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("Checkout read bounds are invalid");
  }
  const result = await runProcess({
    program: record.gitVerifier.resolvedProgram,
    args: [
      "--git-dir",
      record.destination,
      "show",
      `${record.commit}:${relative}`,
    ],
    cwd: context.authority.resolveProtectedPath("r"),
    envNames: [
      "GIT_CONFIG_GLOBAL",
      "GIT_CONFIG_NOSYSTEM",
      "GIT_NO_LAZY_FETCH",
      "GIT_TERMINAL_PROMPT",
    ],
    timeoutMs,
    outputLimitBytes,
    actionClass: "ordinary-read",
    environment: checkoutReadEnvironment(context),
    approvedExecutablePath: record.gitVerifier.resolvedProgram,
    expectedExecutableDigest: record.gitVerifier.executableDigest,
  });
  if (result.exitCode !== 0 || result.timedOut || result.truncated) {
    throw new Error("Approved checkout file read failed or exceeded its bound");
  }
  if (result.stdout.includes("\0") || result.stdout.includes("\uFFFD")) {
    throw new Error("Approved checkout file is binary or not valid UTF-8");
  }
  const excerpt = redactText(result.stdout);
  return {
    provenance: {
      schemaVersion: "1.0",
      source: record.source,
      checkoutId,
      identifier: `${record.source}:${record.commit}:${relative}`,
      commit: record.commit,
      treeDigest: record.treeDigest,
      retrievedAt: new Date().toISOString(),
      excerptHash: sha256(excerpt),
      byteLength: Buffer.byteLength(excerpt, "utf8"),
    },
    excerpt,
  };
}

async function consumeExactSourceReadApproval(
  context,
  active,
  request,
) {
  const review = await context.authority.readSigned(
    "artifacts/source-read-review.json",
  );
  const {
    sequence: _reviewSequence,
    ...reviewDocument
  } = review.payload;
  if (
    reviewDocument.kind !== "source-read" ||
    reviewDocument.projectId !== context.authority.projectId ||
    reviewDocument.taskId !== (active.state.taskId ?? null) ||
    reviewDocument.phase !== active.state.phase ||
    reviewDocument.oneUse !== true ||
    !safeEqualHex(
      reviewDocument.requestDigest,
      canonicalDigest(request.description),
    ) ||
    !safeEqualHex(
      reviewDocument.digest,
      canonicalDigest(reviewDocument),
    ) ||
    !safeEqualHex(
      active.state.approvedDigests?.["source-read"],
      reviewDocument.digest,
    )
  ) {
    throw new Error(
      "Exact source-read review, task binding, or approval is stale",
    );
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "source-read",
    approvedDigest: reviewDocument.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) {
    throw new Error(
      "Current session/lease lacks exact one-use source-read approval",
    );
  }
  await consumeApproval(context.authority, approval, {
    reason: "one-use source-read retrieval",
  });
  const {
    "source-read": _consumed,
    ...approvedDigests
  } = active.state.approvedDigests ?? {};
  await commitCheckpoint(
    context.authority,
    active.state,
    {
      approvedDigests,
      nextLegalAction:
        "Continue only with the bounded result of the approved source read",
    },
    { reason: "Consumed exact one-use source-read approval before retrieval" },
  );
}

export async function runSourceRead(argv = process.argv.slice(2), env = process.env) {
  const args = parseNamedArguments(argv);
  if (args["checkout-id"] !== undefined) {
    return readApprovedCheckout(args, env);
  }
  const context = await runtimeContext(env);
  const active = await activeSession(context, args["session-handle"]);
  const request = await resolveSourceReadRequest({
    args,
    env,
    projectRoot: context.projectRoot,
  });
  if (request.requiresExactApproval) {
    await consumeExactSourceReadApproval(context, active, request);
  }
  const result = await readConfiguredSource({
    source: args.source,
    relativeUrl: args["relative-url"],
    credentialEnv: args["credential-env"] ?? null,
    projectBaseUrl: request.projectBaseUrl,
    outputLimitBytes: request.description.outputLimitBytes,
    timeoutMs: request.description.timeoutMs,
    env,
    allowLegacyEnvironment: false,
  });
  return {
    ...result,
    approvalConsumed: request.requiresExactApproval,
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runSourceRead());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
