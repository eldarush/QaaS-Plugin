import { canonicalDigest, sha256 } from "./canonical-json.mjs";
import { redactText, secretFindings } from "./redact.mjs";

const SOURCE_CONFIGURATION = Object.freeze({
  gitlab: Object.freeze({
    url: "QAAS_GITLAB_URL",
    credential: "QAAS_GITLAB_CREDENTIAL_ENV",
  }),
  artifactory: Object.freeze({
    url: "QAAS_ARTIFACTORY_URL",
    credential: "QAAS_ARTIFACTORY_CREDENTIAL_ENV",
  }),
  nuget: Object.freeze({
    url: "QAAS_NUGET_FEED_URL",
    credential: "QAAS_NUGET_CREDENTIAL_ENV",
  }),
  modules: Object.freeze({
    url: "QAAS_MODULES_REPO_URL",
    credential: "QAAS_MODULES_CREDENTIAL_ENV",
  }),
  "common-hooks": Object.freeze({
    url: "QAAS_COMMON_HOOKS_REPO_URL",
    credential: "QAAS_COMMON_HOOKS_CREDENTIAL_ENV",
  }),
});

function isExplicitLoopback(url) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function configuredBase(source, env) {
  const configuration = SOURCE_CONFIGURATION[source];
  if (!configuration) {
    throw new Error(
      "source must be gitlab, artifactory, nuget, modules, or common-hooks",
    );
  }
  const value = env[configuration.url];
  if (!value) throw new Error(`${configuration.url} is not configured`);
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error(`${configuration.url} must use HTTP or HTTPS`);
  }
  if (url.username || url.password) {
    throw new Error(`${configuration.url} may not contain credentials`);
  }
  validateQuery(url, `${configuration.url} configuration`);
  const credentialEnv = env[configuration.credential] ?? null;
  if (
    credentialEnv !== null &&
    (typeof credentialEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(credentialEnv) ||
      /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(credentialEnv))
  ) {
    throw new Error(
      `${configuration.credential} must name one user-selected environment variable`,
    );
  }
  if (
    credentialEnv !== null &&
    url.protocol !== "https:" &&
    !isExplicitLoopback(url)
  ) {
    throw new Error(
      `${configuration.url} must use HTTPS or an explicit loopback host when credentials are configured`,
    );
  }
  return {
    variable: configuration.url,
    credentialVariable: configuration.credential,
    credentialEnv,
    url,
  };
}

const CREDENTIAL_QUERY_KEY =
  /(?:token|secret|password|passwd|api[-_]?key|signature|credential|auth)/iu;
const HIGH_ENTROPY_QUERY_VALUE =
  /^(?=.{24,256}$)(?=.*[A-Za-z])(?=.*\d)[A-Za-z0-9._~+/=-]+$/u;

function validateQuery(url, label) {
  for (const [key, value] of url.searchParams) {
    if (CREDENTIAL_QUERY_KEY.test(key)) {
      throw new Error(`${label} may not carry credential query parameters`);
    }
    if (
      secretFindings(value).length > 0 ||
      HIGH_ENTROPY_QUERY_VALUE.test(value)
    ) {
      throw new Error(`${label} contains a secret-like query value`);
    }
  }
}

function scopedUrl(base, relativeUrl) {
  const requested = new URL(relativeUrl, base);
  const basePath = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
  if (
    requested.origin !== base.origin ||
    (requested.pathname !== base.pathname &&
      !requested.pathname.startsWith(basePath))
  ) {
    throw new Error("Read request escaped its configured source base");
  }
  if (requested.username || requested.password) {
    throw new Error("Read request may not contain credentials");
  }
  validateQuery(requested, "Read request");
  return requested;
}

function safeIdentifier(requested) {
  const identifier = new URL(requested);
  identifier.search = "";
  identifier.hash = "";
  return identifier.toString();
}

function redactCredentialValue(text, credential) {
  let output = String(text);
  if (credential) {
    const variants = [
      credential,
      encodeURIComponent(credential),
      Buffer.from(credential, "utf8").toString("base64"),
      Buffer.from(credential, "utf8").toString("base64url"),
    ].sort((a, b) => b.length - a.length);
    for (const value of variants) output = output.split(value).join("[REDACTED]");
  }
  return redactText(output);
}

export async function readConfiguredSource({
  source,
  relativeUrl,
  credentialEnv = null,
  env = process.env,
  outputLimitBytes = 32 * 1024,
  timeoutMs = 10_000,
}) {
  if (typeof relativeUrl !== "string" || relativeUrl.trim() === "") {
    throw new Error("relativeUrl is required");
  }
  if (
    !Number.isSafeInteger(outputLimitBytes) ||
    outputLimitBytes < 1 ||
    outputLimitBytes > 1024 * 1024
  ) {
    throw new Error("outputLimitBytes must be between 1 and 1,048,576");
  }
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 60_000
  ) {
    throw new Error("timeoutMs must be between 1 and 60,000");
  }
  const configured = configuredBase(source, env);
  if (
    credentialEnv !== null &&
    credentialEnv !== configured.credentialEnv
  ) {
    throw new Error(
      `credentialEnv must match user configuration ${configured.credentialVariable}`,
    );
  }
  const approvedCredentialEnv = configured.credentialEnv;
  const credential = approvedCredentialEnv
    ? env[approvedCredentialEnv] ?? null
    : null;
  if (approvedCredentialEnv && !credential) {
    throw new Error(
      `Credential environment variable ${approvedCredentialEnv} is not set`,
    );
  }
  const requested = scopedUrl(configured.url, relativeUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetch(requested, {
      method: "GET",
      redirect: "error",
      signal: controller.signal,
      headers: {
        Accept: "application/json, text/plain, application/xml",
        ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`Configured ${source} source returned HTTP ${response.status}`);
    }
    const declared = Number(response.headers.get("content-length") ?? 0);
    if (declared > outputLimitBytes) {
      throw new Error("Configured source response exceeds the output bound");
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > outputLimitBytes) {
        await reader.cancel();
        throw new Error("Configured source response exceeds the output bound");
      }
      chunks.push(value);
    }
    const excerpt = redactCredentialValue(Buffer.concat(chunks).toString("utf8"), credential);
    const provenance = {
      schemaVersion: "1.0",
      source,
      configuredBy: configured.variable,
      identifier: safeIdentifier(requested),
      queryParameterNames: [...new Set(requested.searchParams.keys())].sort(),
      retrievedAt: new Date().toISOString(),
      method: "GET",
      status: response.status,
      excerptHash: sha256(excerpt),
      byteLength: Buffer.byteLength(excerpt, "utf8"),
      credentialEnv: approvedCredentialEnv,
    };
    provenance.digest = canonicalDigest(provenance);
    return { provenance, excerpt };
  } finally {
    clearTimeout(timer);
  }
}
