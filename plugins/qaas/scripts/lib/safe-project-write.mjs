import { lstat, mkdir, realpath } from "node:fs/promises";
import path from "node:path";

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function rejectLink(target, label) {
  try {
    const info = await lstat(target);
    if (info.isSymbolicLink()) {
      throw new Error(`${label} contains a symbolic link or junction: ${target}`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

/**
 * Creates and validates a project-owned parent directory without following a
 * pre-existing symlink/junction component. The returned target is canonical
 * with respect to the real project root.
 */
export async function prepareSafeProjectWritePath(projectRoot, target) {
  const lexicalRoot = path.resolve(projectRoot);
  const requested = path.resolve(target);
  if (!isInside(lexicalRoot, requested)) {
    throw new Error("Project mirror target escapes the project root");
  }
  const canonicalRoot = await realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, requested);
  const segments = relative.split(path.sep).filter(Boolean);
  let cursor = lexicalRoot;
  await rejectLink(cursor, "Project root");
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    await rejectLink(cursor, "Project mirror path");
  }
  const parent = path.dirname(requested);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  cursor = lexicalRoot;
  for (const segment of segments.slice(0, -1)) {
    cursor = path.join(cursor, segment);
    await rejectLink(cursor, "Project mirror path");
  }
  await rejectLink(requested, "Project mirror target");
  const canonicalParent = await realpath(parent);
  if (!isInside(canonicalRoot, canonicalParent)) {
    throw new Error("Project mirror parent resolves outside the project root");
  }
  return path.join(canonicalParent, path.basename(requested));
}
