import {
  appendFile,
  chmod,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { canonicalJson, sha256 } from "./canonical-json.mjs";

export async function pathExists(target) {
  try {
    const handle = await open(target, "r");
    await handle.close();
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export async function readJson(target) {
  const text = await readFile(target, "utf8");
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON at ${target}: ${error.message}`, {
      cause: error,
    });
  }
}

export async function ensurePrivateDirectory(target) {
  await mkdir(target, { recursive: true, mode: 0o700 });
  if (process.platform !== "win32") await chmod(target, 0o700);
}

export async function withFileLock(target, action) {
  await ensurePrivateDirectory(path.dirname(target));
  let handle;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      handle = await open(target, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify({
          pid: process.pid,
          createdAt: new Date().toISOString(),
        }),
        "utf8",
      );
      await handle.sync();
      break;
    } catch (error) {
      await handle?.close();
      handle = null;
      if (error?.code !== "EEXIST" || attempt > 0) {
        if (error?.code === "EEXIST") {
          throw new Error(`Concurrent writer lock is held: ${target}`);
        }
        throw error;
      }
      let stale = false;
      let lock;
      try {
        lock = await readJson(target);
      } catch (lockError) {
        throw new Error(`Cannot validate writer lock ${target}: ${lockError.message}`, {
          cause: lockError,
        });
      }
      if (
        !Number.isSafeInteger(lock.pid) ||
        lock.pid < 1 ||
        typeof lock.createdAt !== "string" ||
        !Number.isFinite(Date.parse(lock.createdAt))
      ) {
        throw new Error(`Writer lock metadata is invalid: ${target}`);
      }
      try {
        process.kill(lock.pid, 0);
      } catch (probeError) {
        if (probeError?.code === "ESRCH") stale = true;
        else if (probeError?.code !== "EPERM") throw probeError;
      }
      if (!stale) {
        throw new Error(`Concurrent writer lock is held: ${target}`);
      }
      await unlink(target);
    }
  }
  await handle?.close();

  try {
    return await action();
  } finally {
    try {
      await unlink(target);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}

export async function atomicWriteText(target, text, options = {}) {
  await ensurePrivateDirectory(path.dirname(target));
  const suffix = randomBytes(8).toString("hex");
  const temporary = `${target}.${process.pid}.${suffix}.tmp`;
  const handle = await open(temporary, "wx", options.mode ?? 0o600);
  try {
    await handle.writeFile(text, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  if (process.platform !== "win32") {
    await chmod(target, options.mode ?? 0o600);
  }
}

export async function atomicWriteJson(target, value, options = {}) {
  const text = options.pretty
    ? `${JSON.stringify(value, null, 2)}\n`
    : `${canonicalJson(value)}\n`;
  await atomicWriteText(target, text, options);
}

export async function compareAndSwapJson(
  target,
  value,
  { expectedDigest = null, lockPath = `${target}.lock`, pretty = false } = {},
) {
  return withFileLock(lockPath, async () => {
    let current = null;
    if (await pathExists(target)) {
      current = await readJson(target);
    }
    const currentDigest = current === null ? null : sha256(current);
    if (expectedDigest !== currentDigest) {
      throw new Error(
        `Compare-and-swap failed for ${target}: expected ${expectedDigest ?? "<missing>"}, found ${currentDigest ?? "<missing>"}`,
      );
    }
    await atomicWriteJson(target, value, { pretty });
    return { previous: current, previousDigest: currentDigest, digest: sha256(value) };
  });
}

export async function appendDurableLine(target, value) {
  await ensurePrivateDirectory(path.dirname(target));
  const handle = await open(target, "a", 0o600);
  try {
    await handle.write(`${value}\n`, null, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (process.platform !== "win32") await chmod(target, 0o600);
}

export async function appendText(target, value) {
  await ensurePrivateDirectory(path.dirname(target));
  await appendFile(target, value, { encoding: "utf8", mode: 0o600 });
}
