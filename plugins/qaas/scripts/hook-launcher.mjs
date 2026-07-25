import { spawn } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ALLOWED_HOOK_SCRIPTS = new Set([
  "pretool-safety.mjs",
  "posttool-ledger.mjs",
  "session-state.mjs",
]);

function fail(message) {
  process.stderr.write(`${message}\n`);
  return 2;
}

async function resolveHookScript(argument) {
  if (typeof argument !== "string" || argument.length === 0) {
    throw new Error("QaaS hook launcher requires one fixed plugin script");
  }
  const scriptName = path.basename(argument);
  if (!ALLOWED_HOOK_SCRIPTS.has(scriptName)) {
    throw new Error("QaaS hook launcher rejected an unknown script");
  }
  const launcherDirectory = await realpath(
    path.dirname(fileURLToPath(import.meta.url)),
  );
  const requestedPath = path.resolve(argument);
  const requestedStat = await lstat(requestedPath);
  if (!requestedStat.isFile() || requestedStat.isSymbolicLink()) {
    throw new Error(
      "QaaS hook launcher rejected a script outside its attested directory",
    );
  }
  const canonicalScript = await realpath(requestedPath);
  if (
    path.dirname(canonicalScript) !== launcherDirectory ||
    path.basename(canonicalScript) !== scriptName
  ) {
    throw new Error(
      "QaaS hook launcher rejected a script outside its attested directory",
    );
  }
  return canonicalScript;
}

async function runHookScript(script) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const child = spawn(process.execPath, [script], {
      shell: false,
      stdio: "inherit",
      windowsHide: true,
    });
    child.once("error", (error) => {
      process.stderr.write(`QaaS Node hook process failed closed: ${error.message}\n`);
      finish(2);
    });
    child.once("exit", (exitCode, signal) => {
      if (exitCode === 0 && signal === null) {
        finish(0);
        return;
      }
      const detail = signal === null
        ? `exit ${exitCode}`
        : `signal ${signal}`;
      process.stderr.write(`QaaS Node hook process failed closed (${detail})\n`);
      finish(2);
    });
  });
}

let exitCode;
if (process.argv.length !== 3) {
  exitCode = fail("QaaS hook launcher requires one fixed plugin script");
} else {
  try {
    exitCode = await runHookScript(await resolveHookScript(process.argv[2]));
  } catch (error) {
    exitCode = fail(
      error?.code === "ENOENT"
        ? "QaaS hook launcher rejected a script outside its attested directory"
        : error.message,
    );
  }
}
process.exitCode = exitCode;
