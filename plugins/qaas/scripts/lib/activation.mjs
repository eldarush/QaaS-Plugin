import { canonicalDigest, safeEqualHex, sha256 } from "./canonical-json.mjs";

const ACTIVATION_PATH = "activation/current.json";

export async function isProjectActivated(authority) {
  const record = await authority.readSigned(ACTIVATION_PATH, {
    required: false,
  });
  if (!record) return false;
  const payload = record.payload;
  return (
    payload.schemaVersion === "1.0" &&
    payload.projectId === authority.projectId &&
    payload.status === "active" &&
    payload.activationSource === "explicit-user-prompt" &&
    typeof payload.userPromptDigest === "string" &&
    /^[a-f0-9]{64}$/u.test(payload.userPromptDigest) &&
    safeEqualHex(payload.digest, canonicalDigest(payload))
  );
}

export async function activateProject(
  authority,
  { sessionId, userPrompt },
) {
  if (
    typeof sessionId !== "string" ||
    sessionId.length === 0 ||
    typeof userPrompt !== "string" ||
    userPrompt.length === 0
  ) {
    throw new Error("Explicit activation requires the user prompt and session ID");
  }
  const prior = await authority.readSigned(ACTIVATION_PATH, {
    required: false,
  });
  if (prior && (await isProjectActivated(authority))) {
    return prior.payload;
  }
  const payload = {
    schemaVersion: "1.0",
    projectId: authority.projectId,
    status: "active",
    activationSource: "explicit-user-prompt",
    activatedBySession: sessionId,
    userPromptDigest: sha256(userPrompt),
    activatedAt: new Date().toISOString(),
    sequence: (prior?.payload.sequence ?? -1) + 1,
  };
  payload.digest = canonicalDigest(payload);
  await authority.writeSigned(ACTIVATION_PATH, payload, {
    expectedSequence: prior?.payload.sequence ?? -1,
  });
  await authority.appendEvent("project-activated", {
    activationDigest: payload.digest,
    sessionId,
    source: payload.activationSource,
  });
  return payload;
}
