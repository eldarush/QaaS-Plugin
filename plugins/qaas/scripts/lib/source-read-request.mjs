import {
  computePackageSnapshot,
  resolveProjectPackageSource,
} from "./package-snapshot.mjs";
import { describeConfiguredSourceRead } from "./source-read-adapter.mjs";

export const REVIEWED_SOURCE_READ_SOURCES = Object.freeze([
  "gitlab",
  "artifactory",
  "modules",
  "common-hooks",
]);

const REVIEWED_SOURCE_SET = new Set(REVIEWED_SOURCE_READ_SOURCES);

export async function resolveSourceReadRequest({
  args,
  env = process.env,
  projectRoot,
}) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("Source-read arguments are required");
  }
  if (
    args["base-url"] !== undefined &&
    !REVIEWED_SOURCE_SET.has(args.source)
  ) {
    throw new Error(
      "--base-url is accepted only for exact GitLab, Artifactory, module, or Common Hooks project sources",
    );
  }
  if (
    REVIEWED_SOURCE_SET.has(args.source) &&
    typeof args["base-url"] !== "string"
  ) {
    throw new Error(
      `--base-url is required for exact reviewed ${args.source} reads`,
    );
  }
  let projectBaseUrl = REVIEWED_SOURCE_SET.has(args.source)
    ? args["base-url"]
    : null;
  let packageSnapshotDigest = null;
  let packageSource = null;
  if (args.source === "nuget") {
    const snapshot = await computePackageSnapshot({ projectRoot, env });
    packageSource = resolveProjectPackageSource(
      snapshot,
      typeof args["package-source"] === "string"
        ? args["package-source"]
        : null,
    );
    projectBaseUrl = packageSource.url;
    packageSnapshotDigest = snapshot.digest;
  }
  const description = describeConfiguredSourceRead({
    source: args.source,
    relativeUrl: args["relative-url"],
    credentialEnv: args["credential-env"] ?? null,
    projectBaseUrl,
    outputLimitBytes:
      args["output-limit-bytes"] === undefined
        ? 16 * 1024
        : Number(args["output-limit-bytes"]),
    timeoutMs:
      args["timeout-ms"] === undefined ? 10_000 : Number(args["timeout-ms"]),
    env,
    allowLegacyEnvironment: false,
  });
  return {
    description,
    projectBaseUrl,
    packageSnapshotDigest,
    packageSource:
      packageSource === null
        ? null
        : {
            name: packageSource.name,
            urlDigest: packageSource.urlDigest,
            sourceFiles: packageSource.sourceFiles,
          },
    requiresExactApproval: REVIEWED_SOURCE_SET.has(args.source),
  };
}
