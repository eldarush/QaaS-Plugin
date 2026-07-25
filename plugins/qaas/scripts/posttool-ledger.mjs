import path from "node:path";
import { isProjectActivated } from "./lib/activation.mjs";
import {
  canonicalApprovalQuestion,
  consumePreauthorization,
  findRegisteredApprovalChallenge,
  mintApproval,
  rejectApprovalChallenge,
  toolInputDigest,
} from "./lib/approval-authority.mjs";
import { safeEqualHex, sha256 } from "./lib/canonical-json.mjs";
import { isDirectExecution, printJson, readJsonInput } from "./lib/cli.mjs";
import {
  evidenceDigestFromToolResponse,
  createEvidenceEvent,
  recordEvidence,
} from "./lib/evidence.mjs";
import {
  actionNeedsApproval,
  classifyToolCall,
  hookEnvironment,
  openExistingAuthority,
  recordSecurityDenial,
  restrictState,
  updateWorkingFingerprint,
} from "./lib/hook-runtime.mjs";
import { readAndValidateLease } from "./lib/lease.mjs";
import { redact, redactText } from "./lib/redact.mjs";
import { mirrorProjectState } from "./lib/project-state-mirror.mjs";
import { commitCheckpoint, commitTransition } from "./lib/state.mjs";
import { completeApprovedLeaseTakeover } from "./session-state.mjs";

function answerFromResponse(response, prompt) {
  const answers =
    response?.answers ??
    response?.result?.answers ??
    response?.output?.answers ??
    null;
  if (!answers || typeof answers !== "object") return null;
  const answer = answers[prompt];
  if (typeof answer === "string") return answer;
  if (Array.isArray(answer) && answer.length === 1) return answer[0];
  return null;
}

function safeTaskId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._-]+$/u.test(value)
    ? value
    : null;
}

function withoutApprovalKinds(approvedDigests, kinds) {
  return Object.fromEntries(
    Object.entries(approvedDigests ?? {}).filter(([kind]) => !kinds.includes(kind)),
  );
}

async function recordRejectedApproval(
  authority,
  challenge,
  stateBefore,
  { sessionId, toolUseId, decision },
) {
  const rules = {
    context: {
      phases: ["CONTEXT_REVIEW"],
      to: "DISCOVERING",
      clear: ["context", "plan", "execution", "mutation"],
    },
    plan: {
      phases: ["PLAN_REVIEW"],
      to: "TASK_DISCOVERY",
      clear: ["plan", "execution", "mutation"],
    },
    execution: {
      phases: ["EXECUTION_REVIEW", "MUTATION_APPROVED"],
      to: "IMPLEMENTED_NOT_RUN",
      clear: ["execution", "mutation"],
    },
    mutation: {
      phases: ["MUTATION_REVIEW"],
      to: "EXECUTION_REVIEW",
      clear: ["execution", "mutation"],
    },
    capabilities: {
      phases: [
        "DISCOVERING",
        "CONTEXT_REVIEW",
        "PROJECT_READY",
        "TASK_DISCOVERY",
      ],
      to: null,
      clear: ["capabilities"],
    },
    "source-checkout": {
      phases: ["DISCOVERING"],
      to: null,
      clear: ["source-checkout"],
    },
    "source-read": {
      phases: [
        "DISCOVERING",
        "CONTEXT_REVIEW",
        "PROJECT_READY",
        "TASK_DISCOVERY",
        "PLAN_REVIEW",
        "PLAN_APPROVED",
        "IMPLEMENTING",
        "DIAGNOSING",
        "REPAIRING",
      ],
      to: null,
      clear: ["source-read"],
    },
    "readiness-fact": {
      phases: ["DISCOVERING"],
      to: null,
      clear: [],
    },
    query: {
      phases: [
        "IMPLEMENTED_NOT_RUN",
        "EXECUTION_APPROVED",
        "DIAGNOSING",
        "VERIFIED",
      ],
      to: null,
      clear: ["query"],
    },
    "lease-takeover": {
      phases: [],
      to: null,
      clear: [],
    },
  };
  const rule = rules[challenge.kind];
  if (!rule) {
    throw new Error(`Unknown approval challenge kind ${challenge.kind}`);
  }
  if (
    challenge.kind !== "lease-takeover" &&
    !rule.phases.includes(stateBefore.phase)
  ) {
    throw new Error(
      `Approval challenge kind ${challenge.kind} is stale in phase ${stateBefore.phase}`,
    );
  }
  await rejectApprovalChallenge(authority, challenge.challengeId, {
    sessionId,
    toolUseId,
    decision,
  });
  if (challenge.kind === "lease-takeover") return stateBefore;
  const patch = {
    approvedDigests: withoutApprovalKinds(
      stateBefore.approvedDigests,
      rule.clear,
    ),
    nextLegalAction:
      decision === "Revise"
        ? `Revise and restage the ${challenge.kind} artifact before requesting a new approval`
        : `Approval cancelled; remain within ${rule.to ?? stateBefore.phase} read-only workflow bounds`,
  };
  if (rule.to && rule.to !== stateBefore.phase) {
    return commitTransition(authority, stateBefore, rule.to, {
      reason: `${decision} rejected ${challenge.kind} approval ${challenge.challengeId}`,
      patch,
    });
  }
  return commitCheckpoint(authority, stateBefore, patch, {
    reason: `${decision} rejected ${challenge.kind} approval ${challenge.challengeId}`,
  });
}

export async function handlePostToolUse(event, overrides = {}) {
  const context = hookEnvironment(event, overrides);
  let authority = null;
  const canUpdateOutput = event.hook_event_name === "PostToolUse";
  const redactedResponse = redact(
    event.tool_response ?? event.error ?? null,
  );
  const outputChanged =
    JSON.stringify(redactedResponse) !==
    JSON.stringify(event.tool_response ?? event.error ?? null);
  let takeoverContext = null;
  try {
    authority = await openExistingAuthority(event, context);
    if (!authority || !(await isProjectActivated(authority))) {
      return {};
    }

    if (event.tool_name === "AskUserQuestion") {
      const challenge = await findRegisteredApprovalChallenge(authority, {
        sessionId: event.session_id,
        toolUseId: event.tool_use_id,
      });
      if (challenge) {
        if (
          Object.keys(event.tool_input ?? {}).length !== 1 ||
          !Array.isArray(event.tool_input?.questions) ||
          event.tool_input.questions.length !== 1
        ) {
          throw new Error("Final approval tool input contains unapproved fields");
        }
        const finalQuestion = canonicalApprovalQuestion(
          event.tool_input.questions[0],
        );
        if (!safeEqualHex(challenge.questionDigest, sha256(finalQuestion))) {
          throw new Error("Final approval question differs from the signed challenge");
        }
        const prompt = finalQuestion.question;
        const answer = answerFromResponse(event.tool_response, prompt);
        if (answer === "Approve") {
          const stateBeforeApproval = await authority.readSigned(
            "state/current.json",
          );
          const allowedApprovalPhases = {
            context: ["CONTEXT_REVIEW"],
            plan: ["PLAN_REVIEW"],
            execution: ["EXECUTION_REVIEW", "MUTATION_APPROVED"],
            mutation: ["MUTATION_REVIEW"],
            capabilities: [
              "DISCOVERING",
              "CONTEXT_REVIEW",
              "PROJECT_READY",
              "TASK_DISCOVERY"
            ],
            "source-checkout": ["DISCOVERING"],
            "source-read": [
              "DISCOVERING",
              "CONTEXT_REVIEW",
              "PROJECT_READY",
              "TASK_DISCOVERY",
              "PLAN_REVIEW",
              "PLAN_APPROVED",
              "IMPLEMENTING",
              "DIAGNOSING",
              "REPAIRING",
            ],
            "readiness-fact": ["DISCOVERING"],
            query: [
              "IMPLEMENTED_NOT_RUN",
              "EXECUTION_APPROVED",
              "DIAGNOSING",
              "VERIFIED",
            ],
            "lease-takeover": Object.freeze([]),
          };
          if (
            challenge.kind !== "lease-takeover" &&
            !allowedApprovalPhases[challenge.kind]?.includes(
              stateBeforeApproval.payload.phase,
            )
          ) {
            throw new Error(
              `Approval challenge kind ${challenge.kind} is stale in phase ${stateBeforeApproval.payload.phase}`,
            );
          }
          let lease;
          if (challenge.kind === "lease-takeover") {
            const record = await authority.readSigned("lease/current.json");
            lease = record.payload;
            if (
              lease.status !== "active" ||
              lease.leaseId !== challenge.leaseId ||
              lease.projectId !== authority.projectId ||
              !Number.isFinite(Date.parse(lease.heartbeatAt)) ||
              !Number.isFinite(Date.parse(lease.expiresAt))
            ) {
              throw new Error(
                "Lease-takeover approval does not match a valid signed active lease record",
              );
            }
          } else {
            lease = await readAndValidateLease(authority, {
              leaseId: challenge.leaseId,
              sessionId: event.session_id,
            });
          }
          const approval = await mintApproval(
            authority,
            challenge.challengeId,
            {
              sessionId: event.session_id,
              toolUseId: event.tool_use_id,
              answer,
              source: "AskUserQuestion",
            },
          );
          if (approval.kind === "lease-takeover") {
            const takeover = await completeApprovedLeaseTakeover(
              authority,
              event,
              context,
              approval,
            );
            takeoverContext =
              `QaaS lease takeover completed. Session handle: ${takeover.sessionHandle}. ` +
              "Prior approvals were invalidated and exact work must be reapproved.";
          } else if (approval.kind === "readiness-fact") {
            const stateRecord = await authority.readSigned("state/current.json");
            await commitCheckpoint(
              authority,
              stateRecord.payload,
              {
                nextLegalAction:
                  "Continue evidence-bound discovery and confirm only remaining exact facts",
              },
              {
                reason:
                  `Recorded readiness fact ${approval.objectId} from registered answer ${approval.approvalId}`,
              },
            );
          } else {
            const stateRecord = await authority.readSigned("state/current.json");
            const patch = {
              approvedDigests: {
                ...stateRecord.payload.approvedDigests,
                [approval.kind]: approval.approvedDigest,
              },
              nextLegalAction: `Proceed only within approved ${approval.kind} ${approval.objectId}`,
            };
            const approvedPhase = {
              plan: "PLAN_APPROVED",
              execution: "EXECUTION_APPROVED",
              mutation: "MUTATION_APPROVED",
            }[approval.kind];
            if (approvedPhase) {
              await commitTransition(
                authority,
                stateRecord.payload,
                approvedPhase,
                {
                  reason: `Recorded ${approval.kind} approval ${approval.approvalId} on lease ${lease.leaseId}`,
                  patch,
                },
              );
            } else {
              await commitCheckpoint(
                authority,
                stateRecord.payload,
                patch,
                {
                  reason: `Recorded ${approval.kind} approval ${approval.approvalId} on lease ${lease.leaseId}`,
                },
              );
            }
          }
        } else {
          if (!["Revise", "Cancel"].includes(answer)) {
            throw new Error(
              "Final approval answer must be exact Approve, Revise, or Cancel",
            );
          }
          const stateBeforeRejection = (
            await authority.readSigned("state/current.json")
          ).payload;
          await recordRejectedApproval(
            authority,
            challenge,
            stateBeforeRejection,
            {
              sessionId: event.session_id,
              toolUseId: event.tool_use_id,
              decision: answer,
            },
          );
        }
      }
    }

    const syntheticPreEvent = {
      ...event,
      hook_event_name: "PreToolUse",
      tool_input: event.tool_input ?? {},
    };
    let classification;
    try {
      classification = await classifyToolCall(
        syntheticPreEvent,
        context,
        authority,
      );
    } catch (error) {
      if (
        ["Write", "Edit", "NotebookEdit", "Bash", "PowerShell", "Shell"].includes(
          event.tool_name,
        ) ||
        event.tool_name?.startsWith("mcp__")
      ) {
        await restrictState(
          authority,
          "SAFETY_VIOLATION",
          `PostToolUse could not prove the executed action: ${error.message}`,
        );
        await recordSecurityDenial(
          authority,
          event,
          `PostToolUse unclassified executed action: ${error.message}`,
          "UNCLASSIFIED_POST_ACTION",
        );
      }
      classification = { actionClass: "ordinary-read" };
    }

    let token = null;
    const success = event.hook_event_name !== "PostToolUseFailure";
    const resultDigest = evidenceDigestFromToolResponse(redactedResponse);
    if (actionNeedsApproval(classification.actionClass)) {
      try {
        token = await consumePreauthorization(authority, event, {
          success,
          resultDigest,
        });
      } catch (error) {
        await restrictState(
          authority,
          "SAFETY_VIOLATION",
          `Approval-requiring action executed without a matching reserved token: ${error.message}`,
        );
        await recordSecurityDenial(
          authority,
          event,
          error.message,
          "MISSING_POST_PREAUTHORIZATION",
        );
        throw error;
      }
    }

    let stateRecord = await authority.readSigned("state/current.json", {
      required: false,
    });
    if (token && success && stateRecord) {
      stateRecord = {
        payload: await updateWorkingFingerprint(
          authority,
          stateRecord.payload,
          token,
          context,
        ),
      };
    }
    if (stateRecord) {
      await mirrorProjectState(
        context.projectRoot,
        stateRecord.payload,
        `Recorded ${event.hook_event_name}`,
      );
    }
    const taskId = safeTaskId(stateRecord?.payload?.taskId);
    const evidencePaths = (classification.paths ?? [])
      .map((entry) => path.resolve(context.projectRoot, entry.value))
      .map((target) => path.relative(context.projectRoot, target))
      .filter(
        (relative) =>
          relative !== "" &&
          !relative.startsWith("..") &&
          !path.isAbsolute(relative),
      )
      .map((relative) => relative.replaceAll("\\", "/"));
    const evidence = createEvidenceEvent({
      projectId: authority.projectId,
      taskId,
      type: event.tool_name === "AskUserQuestion" ? "approval-question" : "tool-use",
      actionClass: classification.actionClass,
      status: success ? "success" : "failure",
      tool: event.tool_name,
      inputDigest:
        token?.toolInputDigest ??
        toolInputDigest(event.tool_name, event.tool_input ?? {}),
      outputDigest: resultDigest,
      exitCode:
        typeof event.tool_response?.exitCode === "number"
          ? event.tool_response.exitCode
          : null,
      paths:
        token?.scope?.allowedPaths ??
        evidencePaths,
      excerpt:
        typeof redactedResponse?.stderr === "string"
          ? redactText(redactedResponse.stderr).slice(0, 2048)
          : null,
      details: {
        toolUseId: event.tool_use_id,
        preauthorizationId: token?.tokenId ?? null,
        outputWasRedacted: outputChanged,
        provenance: classification.sourceProvenance ?? null,
      },
    });
    const mirrorPath =
      taskId &&
      path.join(
        context.projectRoot,
        ".claude",
        "qaas",
        "state",
        "tasks",
        taskId,
        "evidence.jsonl",
      );
    await recordEvidence(authority, evidence, {
      projectRoot: context.projectRoot,
      mirrorPath: mirrorPath || null,
    });

    return {
      hookSpecificOutput: {
        hookEventName: event.hook_event_name,
        ...(outputChanged && canUpdateOutput
          ? { updatedToolOutput: redactedResponse }
          : {}),
        ...(token
          ? {
              additionalContext: `QaaS recorded signed ${token.actionClass} evidence ${evidence.digest}.`,
            }
          : takeoverContext
            ? { additionalContext: takeoverContext }
            : {}),
      },
    };
  } catch (error) {
    try {
      if (authority) {
        await recordSecurityDenial(
          authority,
          event,
          error.message,
          "POSTTOOL_LEDGER_FAILURE",
        );
      }
    } catch {
      // Preserve the fail-closed response when the ledger is unavailable.
    }
    return {
      hookSpecificOutput: {
        hookEventName: event.hook_event_name,
        ...(outputChanged && canUpdateOutput
          ? { updatedToolOutput: redactedResponse }
          : {}),
        additionalContext:
          `QaaS post-tool integrity failure: ${error.message}. ` +
          "The workflow is read-only until authority is revalidated.",
      },
    };
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await handlePostToolUse(await readJsonInput()));
  } catch (error) {
    printJson({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: `QaaS post-tool hook failed closed: ${error.message}`,
      },
    });
  }
}
