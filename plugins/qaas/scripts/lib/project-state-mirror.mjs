import { readFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256 } from "./canonical-json.mjs";
import { appendDurableLine, atomicWriteText } from "./io.mjs";
import { assertNoSecrets } from "./redact.mjs";
import { prepareSafeProjectWritePath } from "./safe-project-write.mjs";
import { validateState } from "./state.mjs";

function mirrorPaths(projectRoot) {
  const root = path.resolve(projectRoot, ".claude", "qaas", "state");
  return {
    current: path.join(root, "current.json"),
    events: path.join(root, "events.jsonl"),
  };
}

async function lastMirrorEvent(target) {
  try {
    const text = await readFile(target, "utf8");
    const lines = text.split(/\r?\n/u).filter(Boolean);
    if (lines.length === 0) return null;
    return JSON.parse(lines.at(-1));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Project state mirror is unreadable: ${error.message}`);
  }
}

export async function mirrorProjectState(
  projectRoot,
  state,
  reason = "state synchronized",
) {
  const validity = validateState(state);
  if (!validity.valid) {
    throw new Error(`Refusing to mirror invalid state: ${validity.errors.join("; ")}`);
  }
  if (
    typeof state.contextDigest !== "string" ||
    !/^[a-f0-9]{64}$/u.test(state.contextDigest) ||
    ["UNONBOARDED", "DISCOVERING", "CONTEXT_REVIEW"].includes(state.phase)
  ) {
    return {
      skipped: true,
      reason: "approved project context has not been committed",
    };
  }
  const stateDigest = sha256(state);
  const mirror = {
    schemaVersion: "1.0",
    projectId: state.projectId,
    phase: state.phase,
    sequence: state.sequence,
    taskId: state.taskId,
    stateDigest,
    hooksAttested: state.hooksAttested,
    approvedDigests: state.approvedDigests,
    fingerprints: state.fingerprints,
    completedWork: state.completedWork,
    remainingWork: state.remainingWork,
    evidencePaths: state.evidencePaths,
    blocker: state.blocker,
    nextLegalAction: state.nextLegalAction,
    updatedAt: state.updatedAt,
  };
  assertNoSecrets(mirror, "project state mirror");
  const requestedTargets = mirrorPaths(projectRoot);
  const targets = {
    current: await prepareSafeProjectWritePath(
      projectRoot,
      requestedTargets.current,
    ),
    events: await prepareSafeProjectWritePath(
      projectRoot,
      requestedTargets.events,
    ),
  };
  const prior = await lastMirrorEvent(targets.events);
  if (
    prior &&
    (!Number.isSafeInteger(prior.sequence) ||
      prior.sequence > mirror.sequence ||
      (prior.sequence === mirror.sequence &&
        prior.stateDigest !== mirror.stateDigest))
  ) {
    throw new Error("Project state mirror sequence/digest is inconsistent");
  }
  await atomicWriteText(
    targets.current,
    `${canonicalJson(mirror)}\n`,
    { mode: 0o600 },
  );
  if (!prior || prior.sequence < mirror.sequence) {
    const event = {
      schemaVersion: "1.0",
      projectId: mirror.projectId,
      sequence: mirror.sequence,
      phase: mirror.phase,
      stateDigest,
      reason,
      mirroredAt: state.updatedAt,
    };
    await appendDurableLine(targets.events, canonicalJson(event));
  }
  return mirror;
}
