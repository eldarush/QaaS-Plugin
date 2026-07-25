import {
  canonicalDigest,
  isSha256,
  safeEqualHex,
} from "./canonical-json.mjs";
import { secretFindings } from "./redact.mjs";

const SOURCE_CONFIGURATION = Object.freeze({
  modules: Object.freeze({
    url: "QAAS_MODULES_REPO_URL",
    credential: "QAAS_MODULES_CREDENTIAL_ENV",
  }),
  "common-hooks": Object.freeze({
    url: "QAAS_COMMON_HOOKS_REPO_URL",
    credential: "QAAS_COMMON_HOOKS_CREDENTIAL_ENV",
  }),
  "reference-project": Object.freeze({
    url: "QAAS_REFERENCE_PROJECT_REPO_URL",
    credential: "QAAS_REFERENCE_PROJECT_CREDENTIAL_ENV",
  }),
});

function issue(path, message) {
  return { path, message };
}

export function normalizedCheckoutUrl(value) {
  const url = new URL(value);
  if (!["https:", "file:"].includes(url.protocol)) {
    throw new Error("Checkout repositories must use HTTPS or an exact local file URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Checkout repository URL may not contain credentials, query, or fragment");
  }
  if (secretFindings(url.toString()).length > 0) {
    throw new Error("Checkout repository URL contains credential-like data");
  }
  return url.toString();
}

export function checkoutSourceConfiguration(source) {
  return SOURCE_CONFIGURATION[source] ?? null;
}

export function validateSourceCheckout(document, env = process.env) {
  const errors = [];
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    return { valid: false, errors: [issue("$", "must be an object")] };
  }
  const allowed = new Set([
    "schemaVersion",
    "checkoutId",
    "createdAt",
    "source",
    "repositoryUrl",
    "ref",
    "commit",
    "transport",
    "credentialEnv",
    "tlsVerify",
    "tlsRiskAcknowledgement",
    "digest",
  ]);
  for (const key of Object.keys(document)) {
    if (!allowed.has(key)) errors.push(issue(`$.${key}`, "is not allowed"));
  }
  if (document.schemaVersion !== "1.0") {
    errors.push(issue("$.schemaVersion", "must equal 1.0"));
  }
  if (!/^[A-Za-z0-9._-]{1,80}$/u.test(document.checkoutId ?? "")) {
    errors.push(issue("$.checkoutId", "has an invalid identifier"));
  }
  if (!Number.isFinite(Date.parse(document.createdAt))) {
    errors.push(issue("$.createdAt", "must be a date-time"));
  }
  const configuration = checkoutSourceConfiguration(document.source);
  if (!configuration) errors.push(issue("$.source", "is unsupported"));
  let normalized = null;
  try {
    normalized = normalizedCheckoutUrl(document.repositoryUrl);
  } catch (error) {
    errors.push(issue("$.repositoryUrl", error.message));
  }
  if (configuration) {
    try {
      const configured = normalizedCheckoutUrl(env[configuration.url]);
      if (normalized && normalized !== configured) {
        errors.push(
          issue(
            "$.repositoryUrl",
            `must exactly match ${configuration.url}`,
          ),
        );
      }
    } catch (error) {
      errors.push(issue("$.repositoryUrl", `${configuration.url}: ${error.message}`));
    }
  }
  if (
    typeof document.ref !== "string" ||
    document.ref.length < 1 ||
    document.ref.length > 200 ||
    /(?:\0|\s|\.{2}|@\{|[~^:?*\\[]|(?:^|\/)\.|\.lock$|\/$)/u.test(
      document.ref,
    ) ||
    document.ref.startsWith("-")
  ) {
    errors.push(issue("$.ref", "is not a safe exact Git ref"));
  }
  if (!/^[a-f0-9]{40,64}$/u.test(document.commit ?? "")) {
    errors.push(issue("$.commit", "must be one immutable Git object ID"));
  }
  if (!["git", "glab"].includes(document.transport)) {
    errors.push(issue("$.transport", "must be git or glab"));
  }
  const configuredCredential = configuration
    ? env[configuration.credential] ?? null
    : null;
  if (document.credentialEnv !== configuredCredential) {
    errors.push(
      issue(
        "$.credentialEnv",
        `must exactly match ${configuration?.credential ?? "source configuration"}`,
      ),
    );
  }
  if (
    document.credentialEnv !== null &&
    !["GLAB_TOKEN", "GITLAB_TOKEN"].includes(document.credentialEnv)
  ) {
    errors.push(
      issue(
        "$.credentialEnv",
        "private checkout supports only user-configured GLAB_TOKEN or GITLAB_TOKEN",
      ),
    );
  }
  if (document.transport === "git" && document.credentialEnv !== null) {
    errors.push(
      issue("$.transport", "credentialed checkout must use the glab transport"),
    );
  }
  if (document.transport === "glab" && document.credentialEnv === null) {
    errors.push(
      issue("$.transport", "glab checkout requires its configured credential selector"),
    );
  }
  if (
    document.transport === "glab" &&
    normalized &&
    new URL(normalized).protocol !== "https:"
  ) {
    errors.push(issue("$.repositoryUrl", "glab checkout requires HTTPS"));
  }
  if (typeof document.tlsVerify !== "boolean") {
    errors.push(issue("$.tlsVerify", "must be a boolean"));
  }
  if (document.tlsVerify === false) {
    if (
      document.transport !== "git" ||
      !normalized ||
      new URL(normalized).protocol !== "https:"
    ) {
      errors.push(
        issue(
          "$.tlsVerify",
          "one-operation TLS override is supported only by exact HTTPS git transport",
        ),
      );
    }
    if (
      typeof document.tlsRiskAcknowledgement !== "string" ||
      document.tlsRiskAcknowledgement.trim().length < 20
    ) {
      errors.push(
        issue(
          "$.tlsRiskAcknowledgement",
          "must record the explicit one-source, one-operation TLS risk",
        ),
      );
    }
  } else if (document.tlsRiskAcknowledgement !== null) {
    errors.push(
      issue(
        "$.tlsRiskAcknowledgement",
        "must be null when TLS verification remains enabled",
      ),
    );
  }
  const { digest: _claimedDigest, ...checkoutContent } = document;
  const computedDigest = canonicalDigest(checkoutContent);
  if (
    !isSha256(document.digest) ||
    !safeEqualHex(document.digest, computedDigest)
  ) {
    errors.push(issue("$.digest", "does not match canonical checkout content"));
  }
  return { valid: errors.length === 0, errors, computedDigest };
}
