import {
  actionNeedsApproval,
  allowPreTool,
  authorizeToolCall,
  classifyToolCall,
  denyPreTool,
  hookEnvironment,
  openExistingAuthority,
  recordSecurityDenial,
  restrictState,
} from "./lib/hook-runtime.mjs";
import { isDirectExecution, printJson, readJsonInput } from "./lib/cli.mjs";
import { isProjectActivated } from "./lib/activation.mjs";
import { refreshSessionLiveness } from "./lib/session-liveness.mjs";

function integrityFailure(error) {
  return /(?:signature|integrity|preauthorization|compare-and-swap|event-chain|lease|fingerprint)/iu.test(
    error.message,
  );
}

export async function handlePreToolUse(event, overrides = {}) {
  const context = hookEnvironment(event, overrides);
  let authority = null;
  try {
    authority = await openExistingAuthority(event, context);
    if (!authority || !(await isProjectActivated(authority))) {
      return {};
    }
    await refreshSessionLiveness(authority, {
      sessionId: event.session_id,
      projectRoot: context.projectRoot,
      pluginRoot: context.pluginRoot,
      pluginVersion: context.pluginVersion,
      userHome: context.env.USERPROFILE ?? context.env.HOME ?? null,
    });
    const classification = await classifyToolCall(event, context, authority);
    if (actionNeedsApproval(classification.actionClass)) {
      if (!authority) {
        throw new Error(
          `${classification.actionClass} is denied because protected authority is not initialized`,
        );
      }
      await authorizeToolCall(event, context, authority, classification);
      return allowPreTool(
        `Signed one-use preauthorization reserved for ${classification.actionClass}`,
      );
    }
    return allowPreTool(
      classification.approvalQuestion
        ? "Registered approval question matches the signed pending challenge"
        : `Deterministic QaaS policy permits ${classification.actionClass}`,
      classification.updatedInput ?? null,
    );
  } catch (error) {
    const reason = `QaaS safety denied this tool call: ${error.message}`;
    try {
      if (authority) {
        await recordSecurityDenial(
          authority,
          event,
          error.message,
          error.code ?? "DENIED",
        );
        if (error.code === "STALE") {
          await restrictState(authority, "STALE", error.message);
        } else if (integrityFailure(error)) {
          await restrictState(authority, "SAFETY_VIOLATION", error.message);
        }
      }
    } catch {
      // The denial remains fail-closed even when the security ledger itself is
      // unavailable or corrupt.
    }
    return denyPreTool(reason);
  }
}

if (isDirectExecution(import.meta.url)) {
  try {
    const event = await readJsonInput();
    printJson(await handlePreToolUse(event));
  } catch (error) {
    printJson(denyPreTool(`QaaS safety hook failed closed: ${error.message}`));
  }
}
