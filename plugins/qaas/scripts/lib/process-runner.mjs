import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  access,
  lstat,
  readFile,
  realpath,
  stat,
} from "node:fs/promises";
import path from "node:path";
import { canonicalDigest, safeEqualHex, sha256 } from "./canonical-json.mjs";
import { redactText, secretFindings } from "./redact.mjs";
import { analyzeProcessVector } from "./shell-analyzer.mjs";

const BASE_ENVIRONMENT_NAMES = [
  "PATH",
  "Path",
  "PATHEXT",
  "SystemRoot",
  "WINDIR",
  "ComSpec",
  "OS",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "APPDATA",
  "LOCALAPPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "TMP",
  "TEMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
];

const INTERPRETERS = new Set([
  "node",
  "py",
  "pwsh",
  "powershell",
  "bash",
  "sh",
  "zsh",
]);

const FORBIDDEN_ENVIRONMENT_NAME =
  /^(?:CLAUDE_|CODEX_|ANTHROPIC_|NODE_OPTIONS$|DOTNET_STARTUP_HOOKS$|MSBUILD(?:EXE|SDKSPATH|LOADMICROSOFTTARGETSREADONLY)|GIT_(?:SSH|SSH_COMMAND|CONFIG|ASKPASS|EXEC_PATH)|LD_PRELOAD$|LD_LIBRARY_PATH$|DYLD_|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$|PROMPT_COMMAND$|PSMODULEPATH$|RUBYOPT$|PERL5OPT$|NPM_CONFIG_USERCONFIG$)/iu;
const FIXED_SAFE_GIT_ENVIRONMENT = Object.freeze({
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
});

const SCRIPT_DESTRUCTIVE =
  /\b(?:rmSync|rm|unlinkSync|unlink|rmdirSync|rmdir|renameSync|rename)\s*\(|\b(?:Remove-Item|Move-Item|Rename-Item)\b|\bchild_process\b[\s\S]{0,200}\bshell\s*:\s*true\b/iu;
const SCRIPT_DYNAMIC =
  /\b(?:eval|Function)\s*\(|\b(?:exec|execSync)\s*\(|\bInvoke-Expression\b/iu;

function executableName(program) {
  return path
    .basename(String(program))
    .replace(/\.(?:exe|cmd|bat)$/iu, "")
    .toLowerCase();
}

function validateArguments(args) {
  if (!Array.isArray(args) || args.some((entry) => typeof entry !== "string")) {
    throw new TypeError("Process args must be an array of strings");
  }
  if (args.some((entry) => entry.includes("\0"))) {
    throw new Error("Process args may not contain NUL bytes");
  }
}

function boundedBufferAppend(chunks, chunk, usedBytes, limitBytes) {
  const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
  const remaining = Math.max(0, limitBytes - usedBytes);
  if (remaining > 0) chunks.push(buffer.subarray(0, remaining));
  return {
    usedBytes: usedBytes + Math.min(remaining, buffer.byteLength),
    truncated: buffer.byteLength > remaining,
  };
}

function redactKnownEnvironmentValues(text, names, environment = process.env) {
  const variants = new Set();
  const shortSensitiveVariants = new Set();
  for (const name of names) {
    const value = environment[name];
    if (typeof value !== "string" || value.length === 0) continue;
    const encoded = [
      value,
      encodeURIComponent(value),
      Buffer.from(value, "utf8").toString("base64"),
      Buffer.from(value, "utf8").toString("base64url"),
    ];
    if (value.length >= 8) {
      encoded.forEach((entry) => variants.add(entry));
    } else if (
      /(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|PRIVATE_KEY|AUTH|CREDENTIAL|COOKIE)/iu.test(
        name,
      )
    ) {
      encoded.forEach((entry) => shortSensitiveVariants.add(entry));
    }
  }
  let output = text;
  for (const value of [...variants].filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.split(value).join("[REDACTED_ENV]");
  }
  for (const value of [...shortSensitiveVariants]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)) {
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    output = output.replace(
      new RegExp(`(^|[^A-Za-z0-9_])${escaped}(?=$|[^A-Za-z0-9_])`, "gu"),
      "$1[REDACTED_ENV]",
    );
  }
  return redactText(output);
}

export function processSpecDigest({
  program,
  executableDigest,
  args = [],
  cwd,
  envNames = [],
  stdinDigest = null,
  outputDirectories = [],
  timeoutMs,
  outputLimitBytes,
  environmentValueDigests = {},
  scopeRoot = null,
}) {
  if (!path.isAbsolute(program)) {
    throw new Error("processSpecDigest requires the resolved absolute executable path");
  }
  return canonicalDigest({
    program,
    executableDigest,
    args,
    cwd: path.resolve(cwd),
    envNames: [...envNames].sort(),
    stdinDigest,
    outputDirectories: [...outputDirectories].sort(),
    timeoutMs,
    outputLimitBytes,
    environmentValueDigests,
    scopeRoot,
    shell: false,
  });
}

async function digestFile(target) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(target);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", resolve);
  });
  return hash.digest("hex");
}

async function usableFile(target) {
  try {
    await access(target);
    return (await stat(target)).isFile();
  } catch {
    return false;
  }
}

async function canonicalizeNearest(target) {
  const absolute = path.resolve(target);
  const suffix = [];
  let cursor = absolute;
  while (true) {
    try {
      const resolved = await realpath(cursor);
      return path.join(resolved, ...suffix.reverse());
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      suffix.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

export async function resolveExecutablePath(
  program,
  { cwd = process.cwd(), env = process.env } = {},
) {
  if (typeof program !== "string" || !program || program.includes("\0")) {
    throw new Error("Executable name is invalid");
  }
  const hasSeparator = program.includes("/") || program.includes("\\");
  if (path.isAbsolute(program) || hasSeparator) {
    const candidate = path.isAbsolute(program)
      ? program
      : path.resolve(cwd, program);
    if (!(await usableFile(candidate))) {
      throw Object.assign(new Error(`Executable not found: ${candidate}`), {
        code: "ENOENT",
      });
    }
    return realpath(candidate);
  }

  const searchPath = env.PATH ?? env.Path ?? "";
  const directories = searchPath
    .split(path.delimiter)
    .filter((entry) => entry.trim() !== "")
    .map((entry) => path.resolve(entry));
  const extensions =
    process.platform === "win32"
      ? path.extname(program)
        ? [""]
        : (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
            .split(";")
            .filter(Boolean)
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, `${program}${extension}`);
      if (await usableFile(candidate)) return realpath(candidate);
    }
  }
  throw Object.assign(new Error(`Executable not found on PATH: ${program}`), {
    code: "ENOENT",
  });
}

export async function discoverProgram(program, options = {}) {
  try {
    const resolvedPath = await resolveExecutablePath(program, options);
    return {
      available: true,
      resolvedPath,
      executableDigest: await digestFile(resolvedPath),
      attested: false,
    };
  } catch (error) {
    return {
      available: false,
      error: error?.code === "ENOENT" ? "not found" : redactText(error.message),
    };
  }
}

async function inspectInterpreterScript(program, args, cwd, expectedScriptDigest) {
  const executable = executableName(program);
  if (!INTERPRETERS.has(executable)) return null;
  if (
    args.length === 1 &&
    ["--version", "-version", "-v"].includes(args[0].toLowerCase())
  ) {
    return null;
  }
  throw new Error(
    "Project-provided interpreter scripts are denied in v0.1 because static scanning cannot prove no-deletion behavior",
  );
}

function childEnvironment(envNames, environment = process.env) {
  const allowed = new Set([...BASE_ENVIRONMENT_NAMES, ...envNames]);
  const env = {};
  for (const name of allowed) {
    if (Object.hasOwn(environment, name)) env[name] = environment[name];
  }
  return env;
}

function validateProcessSpecification({
  program,
  args,
  cwd,
  envNames,
  environment = process.env,
  stdin,
  timeoutMs,
  outputLimitBytes,
  outputDirectories,
}) {
  if (typeof program !== "string" || program.trim() === "") {
    throw new TypeError("program is required");
  }
  validateArguments(args);
  if (typeof cwd !== "string" || cwd.trim() === "") {
    throw new TypeError("cwd is required");
  }
  if (
    !Array.isArray(envNames) ||
    envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name))
  ) {
    throw new TypeError("envNames must contain environment-variable names");
  }
  const forbiddenEnv = envNames.filter(
    (name) =>
      FORBIDDEN_ENVIRONMENT_NAME.test(name) &&
      !Object.hasOwn(FIXED_SAFE_GIT_ENVIRONMENT, name),
  );
  if (forbiddenEnv.length > 0) {
    throw new Error(
      `Forbidden loader/authority environment variable(s): ${forbiddenEnv.join(", ")}`,
    );
  }
  for (const [name, requiredValue] of Object.entries(
    FIXED_SAFE_GIT_ENVIRONMENT,
  )) {
    if (
      envNames.includes(name) &&
      environment[name] !== requiredValue
    ) {
      throw new Error(
        `${name} is permitted only with the fixed isolated Git configuration value`,
      );
    }
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 10_800_000
  ) {
    throw new Error("timeoutMs must be between 1 and 10,800,000 ms");
  }
  if (
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 10 * 1024 * 1024
  ) {
    throw new Error("outputLimitBytes must be between 1 and 10,485,760 bytes");
  }
  if (
    !Array.isArray(outputDirectories) ||
    outputDirectories.some(
      (entry) => typeof entry !== "string" || entry.includes("\0"),
    )
  ) {
    throw new TypeError("outputDirectories must contain path strings");
  }
  if (secretFindings({ args, stdin }).length > 0) {
    throw new Error("Credential literals are not permitted in process input");
  }
}

function digestEnvironmentValues(envNames, environment) {
  return Object.fromEntries(
    [...new Set([...BASE_ENVIRONMENT_NAMES, ...envNames])]
      .sort()
      .map((name) => [
        name,
        Object.hasOwn(environment, name)
          ? sha256(environment[name])
          : null,
      ]),
  );
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs
  );
}

export async function attestWindowsTreeTerminator() {
  if (process.platform !== "win32") {
    throw new Error("The fixed Windows tree terminator is Windows-only");
  }
  const rawSystemRoot =
    process.env.SystemRoot ?? process.env.WINDIR ?? null;
  if (
    typeof rawSystemRoot !== "string" ||
    !path.win32.isAbsolute(rawSystemRoot) ||
    rawSystemRoot.includes("\0")
  ) {
    throw new Error("A fixed absolute Windows SystemRoot is unavailable");
  }
  const systemRoot = await realpath(path.win32.resolve(rawSystemRoot));
  const useSysnative =
    process.arch === "ia32" &&
    Boolean(process.env.PROCESSOR_ARCHITEW6432);
  const systemDirectoryName = useSysnative ? "Sysnative" : "System32";
  const requestedDirectory = path.win32.join(
    systemRoot,
    systemDirectoryName,
  );
  const directoryInfo = await lstat(requestedDirectory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
    throw new Error("The fixed Windows system directory is not ordinary");
  }
  const systemDirectory = await realpath(requestedDirectory);
  const requestedPath = path.win32.join(
    systemDirectory,
    "taskkill.exe",
  );
  const before = await lstat(requestedPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error(
      "The fixed Windows taskkill helper is unavailable or reparse-backed",
    );
  }
  const resolvedPath = await realpath(requestedPath);
  const relative = path.win32.relative(systemDirectory, resolvedPath);
  if (
    relative.includes("\\") ||
    relative.includes("/") ||
    relative.toLowerCase() !== "taskkill.exe"
  ) {
    throw new Error("The Windows tree terminator escaped fixed System32");
  }
  const executableDigest = await digestFile(resolvedPath);
  const after = await lstat(resolvedPath);
  if (
    !after.isFile() ||
    after.isSymbolicLink() ||
    !sameFileIdentity(before, after)
  ) {
    throw new Error("The fixed Windows tree terminator changed during attestation");
  }
  return {
    schemaVersion: "1.0",
    resolvedPath,
    executableDigest,
    systemDirectory,
    systemDirectoryName,
    processArchitecture: process.arch,
    fileIdentity: {
      device: String(after.dev),
      inode: String(after.ino),
      size: after.size,
      modifiedMs: after.mtimeMs,
    },
    minimalEnvironment: {
      SystemRoot: systemRoot,
      WINDIR: systemRoot,
    },
  };
}

async function requestTreeTermination(child, force, expectedHelper = null) {
  if (!Number.isSafeInteger(child.pid) || child.pid < 1) {
    return;
  }
  if (process.platform !== "win32") {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        try {
          child.kill(force ? "SIGKILL" : "SIGTERM");
        } catch {
          // The hard termination deadline remains authoritative.
        }
      }
    }
    return;
  }
  if (!expectedHelper) {
    throw new Error("The fixed Windows tree terminator was not pre-attested");
  }
  const currentHelper = await attestWindowsTreeTerminator();
  if (
    path.win32.resolve(currentHelper.resolvedPath).toLowerCase() !==
      path.win32.resolve(expectedHelper.resolvedPath).toLowerCase() ||
    !safeEqualHex(
      currentHelper.executableDigest,
      expectedHelper.executableDigest,
    ) ||
    canonicalDigest(currentHelper.fileIdentity) !==
      canonicalDigest(expectedHelper.fileIdentity)
  ) {
    throw new Error(
      "The fixed Windows tree terminator changed after process start",
    );
  }
  return new Promise((resolve) => {
    const killer = spawn(
      currentHelper.resolvedPath,
      ["/PID", String(child.pid), "/T", ...(force ? ["/F"] : [])],
      {
        cwd: currentHelper.systemDirectory,
        env: currentHelper.minimalEnvironment,
        windowsHide: true,
        shell: false,
        stdio: "ignore",
      },
    );
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve();
    };
    const deadline = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // The caller's hard deadline will finish independently.
      }
      finish();
    }, 1_000);
    deadline.unref?.();
    killer.once("error", finish);
    killer.once("close", finish);
  });
}

/**
 * Resolves and hashes the exact executable and canonical process scope before
 * review. The returned processSpecDigest is stable and contains no raw
 * environment values.
 */
export async function attestProcessSpecification({
  program,
  args = [],
  cwd,
  envNames = [],
  stdin = null,
  timeoutMs = 30_000,
  outputLimitBytes = 64 * 1024,
  outputDirectories = [],
  scopeRoot = null,
  actionClass = null,
  environment = process.env,
}) {
  validateProcessSpecification({
    program,
    args,
    cwd,
    envNames,
    environment,
    stdin,
    timeoutMs,
    outputLimitBytes,
    outputDirectories,
  });
  const analysis = analyzeProcessVector(program, args);
  if (analysis.destructive || analysis.opaque) {
    throw new Error(
      `Process denied by deterministic analyzer: ${analysis.reasons.join(", ")}`,
    );
  }
  const effectiveAction = actionClass ?? analysis.actionClass;
  if (effectiveAction !== analysis.actionClass) {
    throw new Error(
      `Process action ${analysis.actionClass} does not match requested ${effectiveAction}`,
    );
  }
  const canonicalCwd = await realpath(path.resolve(cwd));
  const resolvedProgram = await resolveExecutablePath(program, {
    cwd: canonicalCwd,
    env: environment,
  });
  const executableDigest = await digestFile(resolvedProgram);
  let canonicalScopeRoot = null;
  const canonicalOutputDirectories = [];
  if (effectiveAction !== "ordinary-read") {
    if (typeof scopeRoot !== "string" || scopeRoot.trim() === "") {
      throw new Error(`${effectiveAction} requires one approved scopeRoot`);
    }
    canonicalScopeRoot = await realpath(path.resolve(scopeRoot));
    const insideScope = (candidate) => {
      const relative = path.relative(canonicalScopeRoot, candidate);
      return (
        relative === "" ||
        (!relative.startsWith("..") && !path.isAbsolute(relative))
      );
    };
    if (!insideScope(canonicalCwd)) {
      throw new Error("Process cwd escapes its approved scopeRoot");
    }
    for (const outputDirectory of outputDirectories) {
      const target = await canonicalizeNearest(
        path.resolve(canonicalCwd, outputDirectory),
      );
      if (!insideScope(target)) {
        throw new Error("Process output directory escapes its approved scopeRoot");
      }
      canonicalOutputDirectories.push(target);
    }
  }
  const environmentValueDigests = digestEnvironmentValues(
    envNames,
    environment,
  );
  const stdinDigest = stdin === null ? null : sha256(String(stdin));
  const specDigest = processSpecDigest({
    program: resolvedProgram,
    executableDigest,
    args,
    cwd: canonicalCwd,
    envNames,
    stdinDigest,
    outputDirectories: canonicalOutputDirectories,
    timeoutMs,
    outputLimitBytes,
    environmentValueDigests,
    scopeRoot: canonicalScopeRoot,
  });
  return {
    schemaVersion: "1.0",
    actionClass: effectiveAction,
    requestedProgram: program,
    resolvedProgram,
    executableDigest,
    args,
    cwd: canonicalCwd,
    envNames: [...envNames].sort(),
    stdinDigest,
    outputDirectories: canonicalOutputDirectories.sort(),
    timeoutMs,
    outputLimitBytes,
    environmentValueDigests,
    scopeRoot: canonicalScopeRoot,
    shell: false,
    processSpecDigest: specDigest,
  };
}

/**
 * Runs one exact executable/argv tuple with shell disabled and bounded,
 * redacted output. Approval verification is injected by the caller so this
 * module never treats a model-provided token as authority.
 */
export async function runProcess({
  program,
  args = [],
  cwd,
  envNames = [],
  stdin = null,
  timeoutMs = 30_000,
  outputLimitBytes = 64 * 1024,
  outputDirectories = [],
  scopeRoot = null,
  expectedSpecDigest = null,
  expectedScriptDigest = null,
  approvedExecutablePath = null,
  expectedExecutableDigest = null,
  verifyExecutable = null,
  verifyAuthorization = null,
  actionClass = null,
  environment = process.env,
  executionTimeoutMs = null,
}) {
  if (
    executionTimeoutMs !== null &&
    (!Number.isSafeInteger(executionTimeoutMs) ||
      executionTimeoutMs < 1 ||
      executionTimeoutMs > timeoutMs)
  ) {
    throw new Error("executionTimeoutMs must be positive and no greater than timeoutMs");
  }
  const specification = await attestProcessSpecification({
    program,
    args,
    cwd,
    envNames,
    stdin,
    timeoutMs,
    outputLimitBytes,
    outputDirectories,
    scopeRoot,
    actionClass,
    environment,
  });
  const resolvedProgram = specification.resolvedProgram;
  const executableDigest = specification.executableDigest;
  let executableAttested =
    path.resolve(resolvedProgram) === path.resolve(await realpath(process.execPath));
  if (approvedExecutablePath) {
    const approvedResolved = await realpath(path.resolve(approvedExecutablePath));
    executableAttested =
      path.resolve(approvedResolved) === path.resolve(resolvedProgram) &&
      typeof expectedExecutableDigest === "string" &&
      safeEqualHex(expectedExecutableDigest, executableDigest);
  }
  if (!executableAttested && typeof verifyExecutable === "function") {
    executableAttested =
      (await verifyExecutable({
        resolvedPath: resolvedProgram,
        executableDigest,
        requestedProgram: program,
      })) === true;
  }
  const effectiveAction = specification.actionClass;
  const canonicalScopeRoot = specification.scopeRoot;
  const environmentValueDigests = specification.environmentValueDigests;
  const specDigest = specification.processSpecDigest;
  if (expectedSpecDigest && !safeEqualHex(specDigest, expectedSpecDigest)) {
    throw new Error("Current process specification does not match its approval digest");
  }
  if (effectiveAction !== "ordinary-read") {
    if (typeof verifyAuthorization !== "function") {
      throw new Error(`${effectiveAction} requires signed authorization`);
    }
    const authorized = await verifyAuthorization({
      specDigest,
      actionClass: effectiveAction,
      program: resolvedProgram,
      executableDigest,
      args,
      cwd: path.resolve(cwd),
      outputDirectories: specification.outputDirectories,
      environmentValueDigests,
      scopeRoot: canonicalScopeRoot,
    });
    if (authorized !== true) throw new Error("Process authorization was rejected");
  }
  if (!executableAttested) {
    throw new Error(
      "Resolved executable path and digest are not attested; basename classification is insufficient",
    );
  }
  const script = await inspectInterpreterScript(
    resolvedProgram,
    args,
    cwd,
    expectedScriptDigest,
  );
  if (!safeEqualHex(await digestFile(resolvedProgram), executableDigest)) {
    throw new Error("Executable changed after attestation and before spawn");
  }
  if (script && !safeEqualHex(await digestFile(script.path), script.digest)) {
    throw new Error("Interpreter script changed after inspection and before spawn");
  }
  const treeTerminator =
    process.platform === "win32"
      ? await attestWindowsTreeTerminator()
      : null;

  return new Promise((resolve, reject) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    let usedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let killEscalated = false;
    let killDeadlineExceeded = false;
    let settled = false;
    let forceTimer = null;
    let hardDeadline = null;
    const child = spawn(resolvedProgram, args, {
      cwd,
      env: childEnvironment(envNames, environment),
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardDeadline) clearTimeout(hardDeadline);
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      resolve({
        program: resolvedProgram,
        executableDigest,
        actionClass: effectiveAction,
        specDigest,
        script,
        exitCode,
        signal,
        timedOut,
        killEscalated,
        killDeadlineExceeded,
        truncated,
        stdout: redactKnownEnvironmentValues(stdout, envNames, environment),
        stderr: redactKnownEnvironmentValues(stderr, envNames, environment),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      void requestTreeTermination(child, false, treeTerminator).catch(
        () => {},
      );
      forceTimer = setTimeout(() => {
        killEscalated = true;
        void requestTreeTermination(child, true, treeTerminator).catch(
          () => {},
        );
      }, 500);
      forceTimer.unref?.();
      hardDeadline = setTimeout(() => {
        killDeadlineExceeded = true;
        finish(null, "KILL_DEADLINE_EXCEEDED");
      }, 2_500);
      hardDeadline.unref?.();
    }, executionTimeoutMs ?? timeoutMs);
    timer.unref?.();

    child.stdout.on("data", (chunk) => {
      const bounded = boundedBufferAppend(
        stdoutChunks,
        chunk,
        usedBytes,
        outputLimitBytes,
      );
      usedBytes = bounded.usedBytes;
      truncated ||= bounded.truncated;
    });
    child.stderr.on("data", (chunk) => {
      const bounded = boundedBufferAppend(
        stderrChunks,
        chunk,
        usedBytes,
        outputLimitBytes,
      );
      usedBytes = bounded.usedBytes;
      truncated ||= bounded.truncated;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      if (forceTimer) clearTimeout(forceTimer);
      if (hardDeadline) clearTimeout(hardDeadline);
      if (settled) return;
      settled = true;
      reject(error);
    });
    child.on("close", (exitCode, signal) => {
      finish(exitCode, signal);
    });
    if (stdin !== null) child.stdin.end(String(stdin));
    else child.stdin.end();
  });
}

export async function probeProgram(program, args = ["--version"], options = {}) {
  try {
    const result = await runProcess({
      program,
      args,
      cwd: options.cwd ?? process.cwd(),
      timeoutMs: options.timeoutMs ?? 5_000,
      outputLimitBytes: options.outputLimitBytes ?? 4_096,
      actionClass: "ordinary-read",
      approvedExecutablePath: options.approvedExecutablePath,
      expectedExecutableDigest: options.expectedExecutableDigest,
      verifyExecutable: options.verifyExecutable,
    });
    return {
      available: true,
      exitCode: result.exitCode,
      version: (result.stdout || result.stderr).trim().split(/\r?\n/u)[0] ?? "",
      timedOut: result.timedOut,
    };
  } catch (error) {
    return {
      available: false,
      error:
        error?.code === "ENOENT" ? "not found" : redactText(error.message),
    };
  }
}
