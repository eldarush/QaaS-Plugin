import { canonicalDigest, sha256 } from "./canonical-json.mjs";
import { redactText } from "./redact.mjs";
import { builtInEndpoint } from "./built-in-endpoints.mjs";
import { assertCredentialFreeQueryParameters } from "./url-safety.mjs";

const SOURCE_CONFIGURATION = Object.freeze({
  gitlab: Object.freeze({
    reviewedProjectInput: true,
    legacyUrl: "QAAS_GITLAB_URL",
    legacyCredential: "QAAS_GITLAB_CREDENTIAL_ENV",
  }),
  artifactory: Object.freeze({
    reviewedProjectInput: true,
    legacyUrl: "QAAS_ARTIFACTORY_URL",
    legacyCredential: "QAAS_ARTIFACTORY_CREDENTIAL_ENV",
  }),
  nuget: Object.freeze({
    projectPackageSource: true,
    legacyCredential: "QAAS_NUGET_CREDENTIAL_ENV",
  }),
  modules: Object.freeze({
    reviewedProjectInput: true,
    legacyUrl: "QAAS_MODULES_REPO_URL",
    legacyCredential: "QAAS_MODULES_CREDENTIAL_ENV",
  }),
  "common-hooks": Object.freeze({
    reviewedProjectInput: true,
    legacyUrl: "QAAS_COMMON_HOOKS_REPO_URL",
    legacyCredential: "QAAS_COMMON_HOOKS_CREDENTIAL_ENV",
  }),
});
const DEFAULT_OUTPUT_LIMIT = 16 * 1024;

function isExplicitLoopback(url) {
  const hostname = url.hostname.toLowerCase();
  return (
    hostname === "localhost" ||
    hostname === "[::1]" ||
    /^127(?:\.\d{1,3}){3}$/u.test(hostname)
  );
}

function endpointIdentity({
  source,
  configuration,
  url,
  configuredBy,
}) {
  if (configuration.builtIn) {
    return builtInEndpoint(configuration.builtIn);
  }
  return {
    kind:
      configuration.projectPackageSource
        ? "project-package-metadata"
        : configuredBy === "reviewed-command-input"
          ? "reviewed-project-input"
          : "legacy-project-configuration",
    name: source,
    configuredBy,
    protocol: url.protocol,
    origin: url.origin,
    pathname: url.pathname,
    urlDigest: sha256(url.toString()),
  };
}

function configuredBase(
  source,
  env,
  {
    projectBaseUrl = null,
    credentialEnv = null,
    allowLegacyEnvironment = true,
  } = {},
) {
  const configuration = SOURCE_CONFIGURATION[source];
  if (!configuration) {
    throw new Error(
      "source must be gitlab, artifactory, nuget, modules, or common-hooks",
    );
  }
  const builtIn = configuration.builtIn
    ? builtInEndpoint(configuration.builtIn)
    : null;
  const directBaseProvided =
    projectBaseUrl !== null && projectBaseUrl !== undefined;
  const legacyBase =
    allowLegacyEnvironment && configuration.legacyUrl
      ? env[configuration.legacyUrl] ?? null
      : null;
  const value = builtIn?.url ?? projectBaseUrl ?? legacyBase;
  if (!value) {
    if (configuration.projectPackageSource) {
      throw new Error(
        "NuGet source must come from current project package metadata",
      );
    }
    throw new Error(
      `An exact reviewed --base-url is required for ${source} reads`,
    );
  }
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Configured source must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Configured source may not contain credentials");
  }
  const configuredBy =
    builtIn
      ? `built-in:${configuration.builtIn}`
      : configuration.projectPackageSource
        ? "project-package-metadata"
        : directBaseProvided
          ? "reviewed-command-input"
          : configuration.legacyUrl;
  validateQuery(url, `${configuredBy} configuration`);
  const legacyCredentialEnv =
    allowLegacyEnvironment && configuration.legacyCredential
      ? env[configuration.legacyCredential] ?? null
      : null;
  if (
    allowLegacyEnvironment &&
    configuration.legacyCredential &&
    credentialEnv !== null &&
    legacyCredentialEnv === null
  ) {
    throw new Error(
      "credentialEnv must match user configuration when legacy adapter mode is used",
    );
  }
  if (
    credentialEnv !== null &&
    legacyCredentialEnv !== null &&
    credentialEnv !== legacyCredentialEnv
  ) {
    throw new Error(
      "credentialEnv must match user configuration when a legacy selector is present",
    );
  }
  const selectedCredentialEnv = credentialEnv ?? legacyCredentialEnv;
  if (
    selectedCredentialEnv !== null &&
    (typeof selectedCredentialEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(selectedCredentialEnv) ||
      /^(?:CLAUDE_|CODEX_|ANTHROPIC_)/u.test(selectedCredentialEnv))
  ) {
    throw new Error(
      "credentialEnv must name one user-selected environment variable",
    );
  }
  if (
    selectedCredentialEnv !== null &&
    url.protocol !== "https:" &&
    !isExplicitLoopback(url)
  ) {
    throw new Error(
      "Configured source must use HTTPS or an explicit loopback host when credentials are configured",
    );
  }
  const endpoint = endpointIdentity({
    source,
    configuration,
    url,
    configuredBy,
  });
  return {
    variable: configuredBy,
    configurationNames:
      configuredBy === configuration.legacyUrl
        ? [configuration.legacyUrl]
        : [],
    credentialVariable:
      credentialEnv !== null
        ? "--credential-env"
        : legacyCredentialEnv !== null
          ? configuration.legacyCredential
          : null,
    credentialEnv: selectedCredentialEnv,
    url,
    endpoint,
    endpointDigest: canonicalDigest(endpoint),
  };
}

export function attestConfiguredSourceConfiguration({
  source,
  env = process.env,
  projectBaseUrl = null,
  credentialEnv = null,
  allowLegacyEnvironment = true,
}) {
  const configured = configuredBase(source, env, {
    projectBaseUrl,
    credentialEnv,
    allowLegacyEnvironment,
  });
  return {
    source,
    configuredBy: configured.variable,
    configurationNames: configured.configurationNames,
    credentialSelector: configured.credentialVariable,
    selectedCredentialEnvironmentName: configured.credentialEnv,
    endpoint: configured.endpoint,
    endpointDigest: configured.endpointDigest,
  };
}

function validateQuery(url, label) {
  assertCredentialFreeQueryParameters(url, label);
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

export function describeConfiguredSourceRead({
  source,
  relativeUrl,
  credentialEnv = null,
  env = process.env,
  projectBaseUrl = null,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT,
  timeoutMs = 10_000,
  allowLegacyEnvironment = true,
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
  const configured = configuredBase(source, env, {
    projectBaseUrl,
    credentialEnv,
    allowLegacyEnvironment,
  });
  const requested = scopedUrl(configured.url, relativeUrl);
  return {
    schemaVersion: "1.0",
    source,
    configuredBy: configured.variable,
    baseUrl: configured.url.toString(),
    relativeUrl,
    endpoint: configured.endpoint,
    endpointDigest: configured.endpointDigest,
    requestUrlDigest: sha256(requested.toString()),
    identifier: safeIdentifier(requested),
    queryParameterNames: [...new Set(requested.searchParams.keys())].sort(),
    credentialEnv: configured.credentialEnv,
    outputLimitBytes: Math.min(outputLimitBytes, DEFAULT_OUTPUT_LIMIT),
    timeoutMs,
  };
}

export async function readConfiguredSource({
  source,
  relativeUrl,
  credentialEnv = null,
  env = process.env,
  projectBaseUrl = null,
  outputLimitBytes = DEFAULT_OUTPUT_LIMIT,
  timeoutMs = 10_000,
  fetchImpl = fetch,
  allowLegacyEnvironment = true,
}) {
  const description = describeConfiguredSourceRead({
    source,
    relativeUrl,
    credentialEnv,
    env,
    projectBaseUrl,
    outputLimitBytes,
    timeoutMs,
    allowLegacyEnvironment,
  });
  const configured = configuredBase(source, env, {
    projectBaseUrl,
    credentialEnv,
    allowLegacyEnvironment,
  });
  const effectiveOutputLimitBytes = description.outputLimitBytes;
  const approvedCredentialEnv = configured.credentialEnv;
  const credential = approvedCredentialEnv
    ? env[approvedCredentialEnv] ?? null
    : null;
  if (approvedCredentialEnv && !credential) {
    throw new Error(
      `Credential environment variable ${approvedCredentialEnv} is not set`,
    );
  }
  const requested = new URL(relativeUrl, configured.url);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(requested, {
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
    if (declared > effectiveOutputLimitBytes) {
      throw new Error("Configured source response exceeds the output bound");
    }
    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > effectiveOutputLimitBytes) {
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
      endpointDigest: configured.endpointDigest,
      endpoint: configured.endpoint,
      identifier: description.identifier,
      queryParameterNames: description.queryParameterNames,
      requestUrlDigest: description.requestUrlDigest,
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
