import path from "node:path";
import { findApprovalByDigest } from "./lib/approval-authority.mjs";
import {
  canonicalDigest,
  safeEqualHex,
  sha256,
} from "./lib/canonical-json.mjs";
import {
  isDirectExecution,
  parseNamedArguments,
  printJson,
} from "./lib/cli.mjs";
import {
  compareFingerprints,
  createFingerprint,
} from "./lib/fingerprint.mjs";
import {
  createEvidenceEvent,
  recordEvidence,
} from "./lib/evidence.mjs";
import { mirrorProjectState } from "./lib/project-state-mirror.mjs";
import { executeQuery } from "./lib/query-read-adapter.mjs";
import { redactText } from "./lib/redact.mjs";
import { commitCheckpoint } from "./lib/state.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";

const ALLOWED_PHASES = new Set([
  "IMPLEMENTED_NOT_RUN",
  "EXECUTION_APPROVED",
  "DIAGNOSING",
  "VERIFIED",
]);

async function assertCurrentFingerprint(context, state, stage, digest) {
  const record = await context.authority.readSigned(
    `fingerprints/${stage}.json`,
  );
  if (
    !safeEqualHex(record.payload.digest, digest) ||
    !safeEqualHex(state.fingerprints?.[stage], digest)
  ) {
    throw new Error("Query fingerprint does not match current signed state");
  }
  const expected = record.payload;
  const actual = await createFingerprint({
    projectRoot: context.projectRoot,
    stage,
    relevantPaths: expected.scopePaths ?? null,
    exclusions: (expected.exclusions ?? []).filter(
      (entry) => ![".git", ".claude/qaas/state"].includes(entry),
    ),
    packageSnapshot: expected.packageSnapshot,
    contextDigest: expected.contextDigest,
    externalReferences: expected.externalReferences,
    renderedTemplate: expected.renderedTemplate,
  });
  if (!compareFingerprints(expected, actual).equal) {
    throw new Error("Query fingerprint is stale");
  }
}

async function reserveQueryApproval(context, expectedDigest) {
  const live = (
    await context.authority.readSigned("state/current.json")
  ).payload;
  if (!safeEqualHex(live.approvedDigests?.query, expectedDigest)) {
    throw new Error("Separate one-use query approval is no longer current");
  }
  const { query: _query, ...approvedDigests } = live.approvedDigests ?? {};
  const next = await commitCheckpoint(
    context.authority,
    live,
    {
      approvedDigests,
      nextLegalAction: "Finish the one in-flight bounded query transaction",
    },
    { reason: "Consumed one-use query approval before its bounded read" },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Reserved one-use bounded query transaction",
  );
  return next;
}

async function finalizeQueryApproval(
  context,
  expectedDigest,
  marker,
  successful,
) {
  const live = (
    await context.authority.readSigned("state/current.json")
  ).payload;
  const approvedDigests =
    safeEqualHex(live.approvedDigests?.query, expectedDigest)
      ? Object.fromEntries(
          Object.entries(live.approvedDigests).filter(
            ([kind]) => kind !== "query",
          ),
        )
      : live.approvedDigests;
  const next = await commitCheckpoint(
    context.authority,
    live,
    {
      approvedDigests,
      completedWork: successful
        ? [...live.completedWork, marker]
        : live.completedWork,
      blocker: successful ? live.blocker : "bounded query evidence failed",
      nextLegalAction: successful
        ? "Continue only from the current signed workflow phase"
        : "Inspect signed query evidence and prepare a fresh exact query if needed",
    },
    { reason: "Finalized consumed one-use bounded query transaction" },
  );
  await mirrorProjectState(
    context.projectRoot,
    next,
    "Finalized bounded query transaction",
  );
  return next;
}

export async function runApprovedQuery(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const args = parseNamedArguments(argv);
  const context = await runtimeContext(env);
  const active = await activeSession(context, args["session-handle"]);
  if (!ALLOWED_PHASES.has(active.state.phase)) {
    throw new Error(`Query is not legal from ${active.state.phase}`);
  }
  const artifact = await context.authority.readSigned("artifacts/query.json");
  const review = await context.authority.readSigned(
    "artifacts/query-review.json",
  );
  if (
    !safeEqualHex(review.payload.artifactDigest, artifact.payload.digest) ||
    !safeEqualHex(active.state.approvedDigests?.query, review.payload.digest)
  ) {
    throw new Error("Signed state lacks the exact separate query approval");
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "query",
    approvedDigest: review.payload.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) {
    throw new Error("Current session/lease lacks exact query approval");
  }
  if (
    artifact.payload.document.taskId !== active.state.taskId ||
    review.payload.document.queryPlanId !==
      artifact.payload.document.queryPlanId ||
    !safeEqualHex(
      review.payload.document.currentFingerprintDigest,
      artifact.payload.document.currentFingerprintDigest,
    )
  ) {
    throw new Error("Query review no longer binds the current task/artifact");
  }
  await assertCurrentFingerprint(
    context,
    active.state,
    review.payload.fingerprintStage,
    artifact.payload.document.currentFingerprintDigest,
  );
  const registry = await context.authority.readSigned(
    "integrations/capabilities.json",
  );
  if (
    !safeEqualHex(
      canonicalDigest(registry.payload),
      review.payload.capabilityRegistryDigest,
    )
  ) {
    throw new Error("Capability registry changed after exact query review");
  }
  const marker = `approved query ${review.payload.digest} completed`;
  if (active.state.completedWork.includes(marker)) {
    throw new Error("Exact approved query has already been consumed");
  }
  await reserveQueryApproval(context, review.payload.digest);
  const results = [];
  let successful = false;
  try {
    for (const [index, query] of artifact.payload.document.queries.entries()) {
      let result;
      let status = "failure";
      try {
        result = await executeQuery({
          query,
          binding: review.payload.bindings[index],
          registry: registry.payload,
          projectRoot: context.projectRoot,
          env: context.env,
        });
        status = result.verification.passed ? "success" : "failure";
      } catch (error) {
        result = {
          queryId: query.queryId,
          provider: query.provider,
          queryDigest: query.queryDigest,
          status: null,
          byteLength: 0,
          outputDigest: sha256(redactText(error.message)),
          verification: {
            passed: false,
            outcomes: [],
            error: redactText(error.message),
          },
          excerpt: null,
        };
      }
      const evidence = createEvidenceEvent({
        projectId: context.authority.projectId,
        taskId: active.state.taskId,
        type: "approved-query",
        actionClass: "observability-query",
        status,
        tool: review.payload.bindings[index].adapterId,
        inputDigest: query.toolInputDigest,
        outputDigest: result.outputDigest,
        paths:
          query.provider === "allure" ? [query.toolInput.path] : [],
        excerpt: result.excerpt,
        details: {
          queryPlanDigest: review.payload.digest,
          queryDigest: query.queryDigest,
          capabilityId: query.capabilityId,
          permissionContractToolName: query.toolName,
          adapterId: review.payload.bindings[index].adapterId,
          provider: query.provider,
          responseStatus: result.status,
          byteLength: result.byteLength,
          verification: result.verification,
        },
      });
      await recordEvidence(context.authority, evidence, {
        projectRoot: context.projectRoot,
        mirrorPath: path.join(
          context.projectRoot,
          ".claude",
          "qaas",
          "state",
          "tasks",
          active.state.taskId,
          "evidence.jsonl",
        ),
      });
      results.push({ ...result, evidenceDigest: evidence.digest });
      if (!result.verification.passed) break;
    }
    successful =
      results.length === artifact.payload.document.queries.length &&
      results.every((entry) => entry.verification.passed);
    return {
      action: "observability-query",
      successful,
      oneUseApprovalConsumed: true,
      queryPlanId: artifact.payload.document.queryPlanId,
      results,
    };
  } finally {
    await finalizeQueryApproval(
      context,
      review.payload.digest,
      marker,
      successful,
    );
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runApprovedQuery());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
