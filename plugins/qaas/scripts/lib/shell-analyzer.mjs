import path from "node:path";
import { secretFindings } from "./redact.mjs";

const DESTRUCTIVE_RULES = [
  ["filesystem-delete", /(?:^|[\s;&|])(rm|unlink|shred)\s|(?:^|[\s;&|])find\b[^\r\n]*\s-delete\b/iu],
  ["filesystem-clear", /(?:^|[\s;&|])(?:truncate\s|clear-content\b)|\bset-content\b[^\r\n]*(?:\$null|''|"")|\[(?:system\.)?io\.file\]::writealltext\([^,]+,\s*(?:''|""|\$null)\s*\)|(?:^|[\s;&|])(?:dd)\b[^\r\n]*\bof=/iu],
  ["filesystem-move", /(?:^|[\s;&|])mv\s|(?:^|[\s;&|])(?:move-item|rename-item)\b/iu],
  ["powershell-delete", /(?:^|[\s;&|])(?:remove-item|del|erase|rd|rmdir|ri)\b|\[(?:system\.)?io\.(?:file|directory)\]::(?:delete|move)\b|\.delete\(\)|\.move(?:to)?\(/iu],
  ["cmd-delete-move", /(?:^|[\s;&|])(?:del|erase|rd|rmdir|move|ren|rename)\s/iu],
  ["mirror-delete", /\brobocopy\b[^\r\n]*(?:\/mir|\/purge)\b|\brsync\b[^\r\n]*--delete(?:-\w+)?\b/iu],
  ["git-destructive", /\bgit\s+(?:rm|clean|mv|checkout|switch|restore)\b|\bgit\s+reset\b[^\r\n]*--hard\b|\bgit\s+fetch\b[^\r\n]*--prune\b|\bgit\s+push\b[^\r\n]*(?:--delete\b|(?:^|\s):refs\/)|\bgit\s+branch\b[^\r\n]*(?:-d|-D|--delete)\b|\bgit\s+tag\b[^\r\n]*(?:-d|--delete)\b|\bgit\s+worktree\s+remove\b|\bgit\s+stash\s+clear\b|\bgit\s+remote\s+remove\b|\bgit\s+config\b[^\r\n]*--unset(?:-all)?\b/iu],
  ["git-global-destructive", /\bgit\b[^\r\n]*\b(?:rm|clean|mv|checkout|switch|restore)\b|\bgit\b[^\r\n]*\breset\b[^\r\n]*--hard\b|\bgit\b[^\r\n]*\bfetch\b[^\r\n]*--prune\b|\bgit\b[^\r\n]*\bpush\b[^\r\n]*(?:--delete\b|\s:refs\/)|\bgit\b[^\r\n]*\b(?:branch|tag)\b[^\r\n]*(?:\s-d\b|\s-D\b|--delete\b)/u],
  ["dotnet-clean", /\bdotnet\s+clean\b|\bdotnet\s+build\b[^\r\n]*(?:\/t:|-t:|-target:|--target\s+)(?:clean|rebuild)\b|\bmsbuild\b[^\r\n]*(?:\/t:|-t:|-target:)(?:clean|rebuild)\b/iu],
  ["dotnet-package-delete", /\bdotnet\s+nuget\s+delete\b/iu],
  ["kubernetes-delete", /\bkubectl\s+(?:delete|drain)\b|\bkubectl\s+(?:replace\b[^\r\n]*--force\b|apply\b[^\r\n]*--prune\b)/iu],
  ["helm-uninstall", /\bhelm\s+(?:uninstall|delete)\b|\bhelm\s+(?:upgrade|install)\b[^\r\n]*--force\b/iu],
  ["docker-delete", /\bdocker\s+(?:rm|rmi|image\s+rm|container\s+rm|volume\s+rm|network\s+rm|system\s+prune|image\s+prune|container\s+prune|volume\s+prune|builder\s+prune)\b|\bdocker\s+compose\b[^\r\n]*\b(?:down|rm)\b/iu],
  ["sql-destructive", /(?:^|[\s"'`(])(?:delete\s+from|drop\s+(?:table|database|schema|index)|truncate\s+table)\b/iu],
  ["broker-destructive", /\b(?:delete|purge)[-_ ]?(?:queue|exchange|topic)\b|\brabbitmq(?:admin|ctl)\b[^\r\n]*(?:delete|purge)\b|\bkafka-[^\s]*topics\b[^\r\n]*--delete\b/iu],
  ["elasticsearch-delete", /(?:_delete_by_query|_delete_by_query|indices\.delete|deleteindex|delete-index)/iu],
  ["http-delete", /(?:^|\s)(?:curl|http|httpie)\b[^\r\n]*(?:-X|--request)\s*['"]?DELETE\b|\bmethod\s*[:=]\s*['"]?DELETE\b|\bX-(?:HTTP-)?Method-Override\s*:\s*DELETE\b/iu],
  ["curl-remove-on-error", /\bcurl\b[^\r\n]*--remove-on-error\b/iu],
  ["cleanup-command", /(?:^|[\s;&|])(?:clean|cleanup)\b/iu],
  ["hook-disable", /\b(?:disable|uninstall|remove)\b[^\r\n]*(?:hook|plugin)\b/iu],
];

const OPAQUE_RULES = [
  ["encoded-command", /(?:-enc(?:odedcommand)?\b|frombase64string|base64\s+(?:-d|--decode))/iu],
  ["dynamic-evaluation", /(?:^|[\s;&|])(?:eval|iex|invoke-expression)\b|\b(?:exec|eval)\s*\(/iu],
  ["inline-program", /(?:^|[\s;&|])(?:node|bun|deno)\s+(?:-e|--eval)\b|(?:^|[\s;&|])(?:python|python3|py|ruby|perl)\s+(?:-c|-e)\b/iu],
  ["nested-shell", /(?:^|[\s;&|])(?:bash|sh|zsh|cmd|powershell|pwsh)\s+(?:-c|\/c|-command)\b/iu],
  ["command-substitution", /[$`]/u],
  ["variable-expansion", /%[A-Za-z_][A-Za-z0-9_]*%|![A-Za-z_][A-Za-z0-9_]*!/u],
  ["shell-metacharacter", /[<>;&|\r\n]/u],
  ["glob-or-home-expansion", /[~*?[\]]/u],
  ["response-file", /(?:^|\s)@[^\s]+/u],
];

const READ_ONLY_PROGRAMS = new Set([
  "rg",
  "grep",
  "findstr",
  "type",
  "more",
  "where",
  "which",
  "get-content",
  "select-string",
  "test-path",
  "get-command",
  "git",
  "dotnet",
  "node",
  "py",
  "pwsh",
  "powershell",
  "npm",
  "claude",
  "docker",
  "kubectl",
  "helm",
  "glab",
  "curl",
]);

function executableName(value) {
  return path.basename(String(value)).replace(/\.(?:exe|cmd|bat|ps1)$/iu, "").toLowerCase();
}

export function tokenizeSimpleCommand(command) {
  if (typeof command !== "string" || command.trim() === "") {
    return { ok: false, tokens: [], reason: "Command must be a non-empty string" };
  }
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;
  for (const character of command.trim()) {
    if (escaping) {
      token += character;
      escaping = false;
    } else if (character === "\\" && quote !== "'") {
      escaping = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else token += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/u.test(character)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
    } else {
      token += character;
    }
  }
  if (escaping || quote) {
    return { ok: false, tokens: [], reason: "Unterminated quote or escape" };
  }
  if (token) tokens.push(token);
  return { ok: tokens.length > 0, tokens };
}

function classifyVector(program, args) {
  const executable = executableName(program);
  const lowerArgs = args.map((arg) => String(arg).toLowerCase());
  const versionOnly =
    lowerArgs.length === 1 &&
    ["--version", "-version", "-v"].includes(lowerArgs[0]);
  const structuredVersionOnly =
    (executable === "helm" &&
      lowerArgs[0] === "version" &&
      lowerArgs.slice(1).every((arg) => arg === "--short")) ||
    (executable === "kubectl" &&
      lowerArgs[0] === "version" &&
      lowerArgs.slice(1).every((arg) =>
        ["--client", "--client=true", "--output=yaml"].includes(arg),
      ));
  if (
    READ_ONLY_PROGRAMS.has(executable) &&
    (versionOnly || structuredVersionOnly)
  ) {
    return "ordinary-read";
  }
  if (executable === "git") {
    if (
      lowerArgs[0] === "--git-dir" &&
      typeof args[1] === "string" &&
      path.isAbsolute(args[1]) &&
      ["rev-parse", "show", "ls-tree", "cat-file"].includes(lowerArgs[2]) &&
      !lowerArgs.slice(3).some(
        (arg) =>
          arg === "--output" ||
          arg.startsWith("--output=") ||
          arg === "--exec-path" ||
          arg.startsWith("--exec-path="),
      )
    ) {
      return "ordinary-read";
    }
    if (
      lowerArgs[0] === "-c" &&
      lowerArgs[1] === "http.sslverify=false" &&
      ["clone", "fetch"].includes(lowerArgs[2])
    ) {
      return "source-checkout-write";
    }
    const riskyGitFlags = new Set([
      "-c",
      "--config-env",
      "--exec-path",
      "--ext-diff",
      "--textconv",
      "--no-index",
      "--output",
    ]);
    if (
      lowerArgs.some(
        (arg) =>
          riskyGitFlags.has(arg) ||
          arg.startsWith("--config-env=") ||
          arg.startsWith("--exec-path=") ||
          arg.startsWith("--output="),
      )
    ) {
      return "unknown";
    }
    if (
      ["status", "diff", "log", "show", "rev-parse", "ls-files"].includes(
        lowerArgs[0],
      )
    ) {
      return "ordinary-read";
    }
    if (["clone", "fetch"].includes(lowerArgs[0])) return "source-checkout-write";
  }
  if (executable === "glab") {
    if (lowerArgs[0] === "api") {
      let method = "get";
      for (let index = 1; index < lowerArgs.length; index += 1) {
        if (["-x", "--method"].includes(lowerArgs[index])) {
          method = lowerArgs[index + 1] ?? "unknown";
        } else if (lowerArgs[index].startsWith("--method=")) {
          method = lowerArgs[index].slice("--method=".length);
        }
      }
      return method === "get" ? "configured-source-read" : "unknown";
    }
    if (
      lowerArgs[0] === "repo" &&
      ["view"].includes(lowerArgs[1])
    ) {
      return "configured-source-read";
    }
    if (
      lowerArgs[0] === "release" &&
      ["view", "list"].includes(lowerArgs[1])
    ) {
      return "configured-source-read";
    }
    if (lowerArgs[0] === "repo" && lowerArgs[1] === "clone") {
      return "source-checkout-write";
    }
    return "unknown";
  }
  if (executable === "dotnet") {
    if (["--info", "--version", "--list-sdks", "--list-runtimes"].includes(lowerArgs[0])) {
      return "ordinary-read";
    }
    if (lowerArgs[0] === "restore") return "restore";
    if (lowerArgs[0] === "build") return "build";
    if (lowerArgs[0] === "test") return "test-run";
    if (lowerArgs[0] === "run") {
      const separator = lowerArgs.indexOf("--");
      const qaasVerb = separator >= 0 ? lowerArgs[separator + 1] : null;
      if (qaasVerb === "template") return "template";
      if (qaasVerb === "run" || qaasVerb === "execute") return "test-run";
      return "unknown";
    }
  }
  if (["rg", "grep", "findstr", "type", "more", "where", "which", "get-content", "select-string", "test-path", "get-command"].includes(executable)) {
    if (
      executable === "rg" &&
      lowerArgs.some(
        (arg) =>
          arg === "--pre" ||
          arg.startsWith("--pre=") ||
          arg === "--pre-glob" ||
          arg.startsWith("--pre-glob="),
      )
    ) {
      return "unknown";
    }
    return "ordinary-read";
  }
  if (executable === "node" && lowerArgs.length === 1 && lowerArgs[0] === "--version") {
    return "ordinary-read";
  }
  if (executable === "docker" && ["version", "info", "ps", "inspect"].includes(lowerArgs[0])) {
    return "ordinary-read";
  }
  if (executable === "kubectl") {
    if (["get", "describe", "logs", "version"].includes(lowerArgs[0])) {
      return "configured-source-read";
    }
    if (
      lowerArgs[0] === "config" &&
      ["view", "current-context", "get-contexts"].includes(lowerArgs[1])
    ) {
      return "configured-source-read";
    }
    return "unknown";
  }
  if (executable === "helm" && ["list", "status", "get", "version", "show"].includes(lowerArgs[0])) {
    return "configured-source-read";
  }
  if (executable === "curl") {
    const mutationFlags = [
      "-d",
      "--data",
      "--data-ascii",
      "--data-binary",
      "--data-raw",
      "--data-urlencode",
      "-f",
      "--form",
      "--form-string",
      "-t",
      "--upload-file",
      "--json",
    ];
    const opaqueCurlFlags = [
      "-k",
      "--config",
      "--netrc",
      "--netrc-file",
      "--netrc-optional",
      "--trace",
      "--trace-ascii",
    ];
    const writingCurlFlags = [
      "-o",
      "--output",
      "-O",
      "--remote-name",
      "--remote-header-name",
      "--create-dirs",
    ];
    if (
      lowerArgs.some(
        (arg) =>
          opaqueCurlFlags.includes(arg) ||
          opaqueCurlFlags.some((flag) => arg.startsWith(`${flag}=`)),
      )
    ) {
      return "unknown";
    }
    if (
      args.some((arg) => arg === "-O") ||
      lowerArgs.some(
        (arg) =>
          writingCurlFlags.map((flag) => flag.toLowerCase()).includes(arg) ||
          writingCurlFlags
            .map((flag) => flag.toLowerCase())
            .some((flag) => arg.startsWith(`${flag}=`)),
      )
    ) {
      return "project-write";
    }
    if (
      lowerArgs.some(
        (arg) =>
          mutationFlags.includes(arg) ||
          mutationFlags.some((flag) => arg.startsWith(`${flag}=`)),
      )
    ) {
      return "infrastructure-mutation";
    }
    let method = "get";
    for (let index = 0; index < lowerArgs.length; index += 1) {
      if (["-x", "--request"].includes(lowerArgs[index])) {
        method = lowerArgs[index + 1] ?? "unknown";
      } else if (lowerArgs[index].startsWith("--request=")) {
        method = lowerArgs[index].slice("--request=".length);
      } else if (["-i", "--head"].includes(lowerArgs[index])) {
        method = "head";
      }
    }
    const urls = args.filter((arg) => /^[a-z][a-z0-9+.-]*:\/\//iu.test(arg));
    const safeFlags = new Set([
      "-s",
      "--silent",
      "-S",
      "--show-error",
      "--fail",
      "--fail-with-body",
      "-I",
      "--head",
    ].map((entry) => entry.toLowerCase()));
    for (let index = 0; index < lowerArgs.length; index += 1) {
      const arg = lowerArgs[index];
      if (/^https?:\/\//u.test(arg)) continue;
      if (safeFlags.has(arg)) continue;
      if (["-x", "--request"].includes(arg)) {
        const value = lowerArgs[index + 1];
        if (!["get", "head"].includes(value)) return "unknown";
        index += 1;
        continue;
      }
      if (arg.startsWith("--request=")) {
        if (!["get", "head"].includes(arg.slice("--request=".length))) {
          return "unknown";
        }
        continue;
      }
      return "unknown";
    }
    if (
      urls.length === 0 ||
      urls.some((url) => !/^https?:\/\//iu.test(url))
    ) {
      return "unknown";
    }
    if (["get", "head"].includes(method)) return "configured-source-read";
    if (["post", "put", "patch"].includes(method)) {
      return "infrastructure-mutation";
    }
    return "unknown";
  }
  return "unknown";
}

export function analyzeProcessVector(program, args = []) {
  const rendered = [program, ...args].map((entry) => String(entry)).join(" ");
  const vectorTokens = [program, ...args].map((entry) => String(entry));
  const actionClass = classifyVector(program, args);
  const destructiveReasons = DESTRUCTIVE_RULES.filter(
    ([reason, pattern]) =>
      !(
        reason === "git-global-destructive" &&
        executableName(program) === "git" &&
        actionClass !== "unknown"
      ) && pattern.test(rendered),
  ).map(([reason]) => reason);
  const opaqueReasons = OPAQUE_RULES.filter(([reason, pattern]) => {
    if (reason !== "glob-or-home-expansion") return pattern.test(rendered);
    return vectorTokens.some(
      (token) =>
        /[*?[\]]/u.test(token) ||
        /^~[^/\\]*(?:[/\\]|$)/u.test(token),
    );
  }).map(([reason]) => reason);
  const secrets = secretFindings(rendered);
  const executable = executableName(program);
  if (actionClass === "unknown") {
    opaqueReasons.push(
      READ_ONLY_PROGRAMS.has(executable)
        ? "unknown-program-vector"
        : "unknown-executable",
    );
  }
  if (secrets.length > 0) opaqueReasons.push("credential-literal");
  const destructive = destructiveReasons.length > 0;
  const opaque = opaqueReasons.length > 0;
  return {
    allowedWithoutApproval:
      !destructive && !opaque && actionClass === "ordinary-read",
    decision: destructive || opaque ? "deny" : actionClass === "ordinary-read" ? "allow" : "review",
    destructive,
    opaque,
    reasons: [...new Set([...destructiveReasons, ...opaqueReasons])],
    actionClass,
    program: executable,
  };
}

export function analyzeShellCommand(command) {
  const rendered = typeof command === "string" ? command : "";
  const destructiveReasons = DESTRUCTIVE_RULES.filter(([, pattern]) =>
    pattern.test(rendered),
  ).map(([reason]) => reason);
  const opaqueReasons = OPAQUE_RULES.filter(([, pattern]) =>
    pattern.test(rendered),
  ).map(([reason]) => reason);
  const tokenized = tokenizeSimpleCommand(rendered);
  if (!tokenized.ok) opaqueReasons.push("unparseable-command");
  const vector =
    tokenized.ok && tokenized.tokens.length > 0
      ? analyzeProcessVector(tokenized.tokens[0], tokenized.tokens.slice(1))
      : {
          actionClass: "unknown",
          reasons: [],
          destructive: false,
          opaque: true,
        };
  const secrets = secretFindings(rendered);
  if (secrets.length > 0) opaqueReasons.push("credential-literal");
  const destructive = destructiveReasons.length > 0 || vector.destructive;
  const opaque = opaqueReasons.length > 0 || vector.opaque;
  const reasons = [
    ...destructiveReasons,
    ...opaqueReasons,
    ...vector.reasons,
  ];
  return {
    allowedWithoutApproval:
      !destructive && !opaque && vector.actionClass === "ordinary-read",
    decision:
      destructive || opaque
        ? "deny"
        : vector.actionClass === "ordinary-read"
          ? "allow"
          : "review",
    destructive,
    opaque,
    reasons: [...new Set(reasons)],
    actionClass: vector.actionClass,
    tokens: tokenized.ok ? tokenized.tokens : [],
  };
}
