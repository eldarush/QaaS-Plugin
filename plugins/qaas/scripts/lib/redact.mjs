const REDACTED = "[REDACTED]";
const REDACTED_MARKERS = new Set([
  REDACTED,
  "[REDACTED_ENV]",
  "[REDACTED_FIELD]",
]);

const SENSITIVE_KEY =
  /(?:^|[_-])(password|passwd|pwd|token|secret|private[_-]?key|client[_-]?secret|api[_-]?key|access[_-]?key|authorization|cookie|connection[_-]?string)(?:$|[_-])/iu;

const TEXT_PATTERNS = [
  {
    type: "private-key",
    pattern:
      /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/gu,
  },
  {
    type: "authorization",
    pattern: /\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/giu,
  },
  {
    type: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
  },
  {
    type: "credential-assignment",
    pattern:
      /(["']?(?:password|passwd|pwd|token|secret|client[_-]?secret|api[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']?)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|%[A-Za-z_][A-Za-z0-9_]*%|\[REDACTED(?:_ENV|_FIELD)?\])([^"'\s,;`][^"',;`\r\n]{3,})/giu,
    replacement: `$1${REDACTED}`,
  },
  {
    type: "xml-credential",
    pattern:
      /(<(?:password|passwd|pwd|token|secret|clientSecret|apiKey|accessKey)>)(?!\$\{?[A-Za-z_][A-Za-z0-9_]*\}?|\[REDACTED(?:_ENV|_FIELD)?\])([^<]{4,})(<\/(?:password|passwd|pwd|token|secret|clientSecret|apiKey|accessKey)>)/giu,
    replacement: `$1${REDACTED}$3`,
  },
  {
    type: "credential-url",
    pattern: /([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@/\s]+)@/giu,
    replacement: `$1${REDACTED}:${REDACTED}@`,
  },
  {
    type: "connection-password",
    pattern:
      /\b(Password|Pwd|User ID|Uid)\s*=\s*(?!\[REDACTED(?:_ENV|_FIELD)?\])([^;"'\s]{3,})/giu,
    replacement: `$1=${REDACTED}`,
  },
  {
    type: "known-token-prefix",
    pattern:
      /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_-]{12,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/gu,
  },
];

function clonePattern(pattern) {
  return new RegExp(pattern.source, pattern.flags);
}

export function secretFindings(value, path = "$") {
  const findings = [];
  const visit = (item, itemPath) => {
    if (typeof item === "string") {
      for (const { type, pattern } of TEXT_PATTERNS) {
        if (clonePattern(pattern).test(item)) {
          findings.push({ type, path: itemPath });
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      item.forEach((entry, index) => visit(entry, `${itemPath}[${index}]`));
      return;
    }
    if (item && typeof item === "object") {
      for (const [key, entry] of Object.entries(item)) {
        const childPath = `${itemPath}.${key}`;
        if (
          SENSITIVE_KEY.test(key) &&
          entry !== null &&
          entry !== "" &&
          !(typeof entry === "string" && REDACTED_MARKERS.has(entry))
        ) {
          findings.push({ type: "sensitive-field", path: childPath });
        } else {
          visit(entry, childPath);
        }
      }
    }
  };
  visit(value, path);
  return findings;
}

export function redactText(value) {
  if (typeof value !== "string") return value;
  let result = value;
  for (const { pattern, replacement = REDACTED } of TEXT_PATTERNS) {
    result = result.replace(clonePattern(pattern), replacement);
  }
  return result;
}

export function redact(value) {
  if (typeof value === "string") return redactText(value);
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        SENSITIVE_KEY.test(key) && entry !== null && entry !== ""
          ? REDACTED
          : redact(entry),
      ]),
    );
  }
  return value;
}

export function assertNoSecrets(value, label = "value") {
  const findings = secretFindings(value);
  if (findings.length > 0) {
    const locations = findings.map(({ type, path }) => `${type} at ${path}`);
    throw new Error(`${label} contains secret-like data: ${locations.join(", ")}`);
  }
}

export function isCredentialBearingPath(filePath) {
  const normalized = String(filePath).replaceAll("\\", "/").toLowerCase();
  const base = normalized.split("/").at(-1);
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    base === ".npmrc" ||
    base === "nuget.config" ||
    base === ".git-credentials" ||
    base === "appsettings.json" ||
    base?.startsWith("appsettings.") ||
    base === "settings.xml" ||
    base === "gradle.properties" ||
    base === "local.settings.json" ||
    normalized.endsWith("/.git/config") ||
    base === ".pypirc" ||
    base === "credentials" ||
    base === "credentials.json" ||
    base === "secrets.json" ||
    base === "id_rsa" ||
    base === "id_ed25519" ||
    normalized.includes("/.ssh/") ||
    normalized.includes("/.aws/credentials") ||
    normalized.includes("/.azure/") ||
    normalized.includes("/.kube/config")
  );
}

export { REDACTED };
