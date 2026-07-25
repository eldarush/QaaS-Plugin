import {
  consumeApproval,
  findApprovalByDigest,
} from "./lib/approval-authority.mjs";
import {
  canonicalDigest,
  canonicalJson,
  safeEqualHex,
} from "./lib/canonical-json.mjs";
import {
  createDocsMcpProbeReview,
  docsMcpProbeRequest,
  DOCS_MCP_PROBE_DEFINITION,
  DOCS_MCP_PROBE_OPERATIONS,
  validateDocsMcpProbeEvidence,
} from "./lib/docs-mcp-probe.mjs";
import {
  isDirectExecution,
  parseNamedArguments,
  printJson,
} from "./lib/cli.mjs";
import { assertNoSecrets } from "./lib/redact.mjs";
import {
  describeMcpTransport,
  discoverStreamableMcpTools,
} from "./lib/streamable-mcp-client.mjs";
import { commitCheckpoint } from "./lib/state.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";

function withoutProbeApproval(state) {
  const {
    "docs-mcp-probe": _consumed,
    ...approvedDigests
  } = state.approvedDigests ?? {};
  return approvedDigests;
}

async function currentProbeEvidence(context) {
  const evidence = (
    await context.authority.readSigned("integrations/docs-mcp-probe.json")
  ).payload;
  const validation = validateDocsMcpProbeEvidence(evidence);
  if (!validation.valid) {
    throw new Error(
      `Stored documentation MCP probe is invalid: ${validation.errors.join("; ")}`,
    );
  }
  if (
    evidence.projectId !== context.authority.projectId ||
    !safeEqualHex(
      evidence.transportDigest,
      canonicalDigest(describeMcpTransport(context.env)),
    )
  ) {
    throw new Error(
      "Stored documentation MCP probe does not match this project and transport",
    );
  }
  return evidence;
}

async function showProbedTool(args, context) {
  const name = args["show-tool"];
  if (
    typeof name !== "string" ||
    name.length < 1 ||
    name.length > 128 ||
    !/^[\x21-\x7e]+$/u.test(name)
  ) {
    throw new Error("--show-tool requires one exact probed tool name");
  }
  const evidence = await currentProbeEvidence(context);
  const matches = evidence.tools.filter((tool) => tool.name === name);
  if (matches.length !== 1) {
    throw new Error(`Exact probed documentation MCP tool is unavailable: ${name}`);
  }
  return {
    probeEvidenceDigest: evidence.digest,
    server: evidence.server,
    tool: matches[0],
    probeDefinition: evidence.probeDefinition,
    toolsCallPerformed: false,
  };
}

async function consumeProbeApproval(context, active, review) {
  if (
    review.kind !== "docs-mcp-probe" ||
    review.projectId !== context.authority.projectId ||
    review.phase !== active.state.phase ||
    review.oneUse !== true ||
    !safeEqualHex(review.digest, canonicalDigest(review)) ||
    !safeEqualHex(
      active.state.approvedDigests?.["docs-mcp-probe"],
      review.digest,
    )
  ) {
    throw new Error(
      "Exact documentation MCP probe review or approval is stale",
    );
  }
  const approval = await findApprovalByDigest(context.authority, {
    kind: "docs-mcp-probe",
    approvedDigest: review.digest,
    sessionId: active.attestation.sessionId,
    leaseId: active.lease.leaseId,
  });
  if (!approval) {
    throw new Error(
      "Current session/lease lacks exact one-use documentation MCP probe approval",
    );
  }
  await consumeApproval(context.authority, approval, {
    reason: "one-use bounded documentation MCP schema discovery",
  });
  await commitCheckpoint(
    context.authority,
    active.state,
    {
      approvedDigests: withoutProbeApproval(active.state),
      nextLegalAction:
        "Review the bounded MCP schema probe before staging capabilities",
    },
    {
      reason:
        "Consumed exact one-use documentation MCP probe approval before network access",
    },
  );
}

export async function runDocsMcpDiscover(
  argv = process.argv.slice(2),
  env = process.env,
) {
  const args = parseNamedArguments(argv);
  const context = await runtimeContext(env);
  const active = await activeSession(context, args["session-handle"]);
  if (args["show-tool"] !== undefined) {
    return showProbedTool(args, context);
  }
  const request = docsMcpProbeRequest(args);
  const transport = describeMcpTransport(env);
  const expectedReview = createDocsMcpProbeReview({
    projectId: context.authority.projectId,
    phase: active.state.phase,
    transport,
    request,
  });
  const reviewRecord = await context.authority.readSigned(
    "artifacts/docs-mcp-probe-review.json",
  );
  const {
    sequence: _reviewSequence,
    ...review
  } = reviewRecord.payload;
  if (
    !safeEqualHex(review.digest, expectedReview.digest) ||
    canonicalJson(review) !== canonicalJson(expectedReview)
  ) {
    throw new Error(
      "Documentation MCP probe arguments or transport differ from the exact review",
    );
  }
  await consumeProbeApproval(context, active, review);
  const discovery = await discoverStreamableMcpTools({
    env,
    timeoutMs: request.bounds.timeoutMs,
    approvedTransport: review.transport,
    toolListOutputLimitBytes: request.bounds.outputLimitBytes,
    toolLimit: request.bounds.toolLimit,
    schemaLimitBytes: request.bounds.schemaLimitBytes,
  });
  const evidence = {
    schemaVersion: "1.0",
    projectId: context.authority.projectId,
    server: request.server,
    transportDigest: review.transportDigest,
    protocolVersion: discovery.protocolVersion,
    sessionMode: discovery.sessionMode,
    operations: [...DOCS_MCP_PROBE_OPERATIONS],
    bounds: { ...request.bounds },
    probeDefinition: DOCS_MCP_PROBE_DEFINITION,
    passed: true,
    toolsCallPerformed: false,
    probedAt: new Date().toISOString(),
    tools: discovery.tools,
  };
  evidence.digest = canonicalDigest(evidence);
  const validation = validateDocsMcpProbeEvidence(evidence);
  if (!validation.valid) {
    throw new Error(
      `Documentation MCP probe evidence is invalid: ${validation.errors.join("; ")}`,
    );
  }
  assertNoSecrets(evidence, "documentation MCP probe evidence");
  const prior = await context.authority.readSigned(
    "integrations/docs-mcp-probe.json",
    { required: false },
  );
  await context.authority.writeSigned(
    "integrations/docs-mcp-probe.json",
    evidence,
    { expectedDigest: prior?.digest ?? null },
  );
  await context.authority.appendEvent("docs-mcp-probe-committed", {
    probeEvidenceDigest: evidence.digest,
    transportDigest: evidence.transportDigest,
    server: evidence.server,
    toolCount: evidence.tools.length,
    toolsCallPerformed: false,
  });
  return {
    probeEvidenceDigest: evidence.digest,
    server: evidence.server,
    protocolVersion: evidence.protocolVersion,
    sessionMode: evidence.sessionMode,
    probeDefinition: evidence.probeDefinition,
    toolsCallPerformed: false,
    toolCount: evidence.tools.length,
    tools: evidence.tools.map((tool) => ({
      name: tool.name,
      schemaDigest: tool.schemaDigest,
      schemaBytes: tool.schemaBytes,
    })),
    next:
      'Use docs-mcp-discover.mjs --session-handle <handle> --show-tool "<exact-name>" to inspect one reviewed schema before staging capabilities.',
  };
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runDocsMcpDiscover());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
