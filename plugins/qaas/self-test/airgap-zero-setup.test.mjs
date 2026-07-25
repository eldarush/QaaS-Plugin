import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runDoctor } from "../scripts/doctor.mjs";
import {
  BUILT_IN_QAAS_ARTIFACTORY_URL,
  BUILT_IN_QAAS_DOCS_URL,
  builtInEndpoint,
} from "../scripts/lib/built-in-endpoints.mjs";
import {
  canonicalDigest,
  sha256,
} from "../scripts/lib/canonical-json.mjs";
import {
  attestDocumentationSourceConfiguration,
  resolveDocumentationQuery,
  resolveDocumentationSources,
} from "../scripts/lib/docs-resolver.mjs";
import {
  classifyToolCall,
  hookEnvironment,
} from "../scripts/lib/hook-runtime.mjs";
import {
  computePackageSnapshot,
  resolveProjectPackageSource,
} from "../scripts/lib/package-snapshot.mjs";
import {
  attestConfiguredSourceConfiguration,
  readConfiguredSource,
} from "../scripts/lib/source-read-adapter.mjs";
import { resolveSourceReadRequest } from "../scripts/lib/source-read-request.mjs";
import { runSourceRead } from "../scripts/source-read.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const repositoryRoot = path.resolve(pluginRoot, "..", "..");

async function temporaryDirectory(t, prefix) {
  const directory = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("distribution endpoints are immutable and ignore core URL environment overrides", async () => {
  assert.equal(BUILT_IN_QAAS_DOCS_URL, "https://docs.qaas.online/");
  assert.equal(
    BUILT_IN_QAAS_ARTIFACTORY_URL,
    "https://jfrog.com/artifactory/",
  );

  const docsEndpoint = builtInEndpoint("docs");
  const artifactoryEndpoint = builtInEndpoint("artifactory");
  assert.equal(Object.isFrozen(docsEndpoint), true);
  assert.equal(Object.isFrozen(artifactoryEndpoint), true);
  assert.throws(() => {
    docsEndpoint.url = "https://changed.example.test/";
  }, TypeError);

  const legacyOverrides = {
    QAAS_DOCS_PRIMARY_URL: "https://ignored-primary.example.test/",
    QAAS_DOCS_SECONDARY_URL: "https://ignored-secondary.example.test/",
    QAAS_ARTIFACTORY_URL: "https://ignored-artifactory.example.test/",
    QAAS_ARTIFACTORY_CREDENTIAL_ENV: "IGNORED_TOKEN",
    IGNORED_TOKEN: "not-used",
  };
  const sources = resolveDocumentationSources({ env: legacyOverrides });
  assert.equal(sources.primaryUrl, BUILT_IN_QAAS_DOCS_URL);
  assert.equal(sources.secondaryUrl, null);

  const docsAttestation =
    await attestDocumentationSourceConfiguration(legacyOverrides);
  assert.deepEqual(docsAttestation.builtInEndpoints.docs, docsEndpoint);
  assert.equal(
    docsAttestation.builtInEndpointDigests.docs,
    canonicalDigest(docsEndpoint),
  );

  const artifactoryAttestation =
    attestConfiguredSourceConfiguration({
      source: "artifactory",
      env: legacyOverrides,
      allowLegacyEnvironment: false,
    });
  assert.deepEqual(artifactoryAttestation.configurationNames, []);
  assert.deepEqual(
    artifactoryAttestation.endpoint,
    artifactoryEndpoint,
  );
  assert.equal(
    artifactoryAttestation.endpointDigest,
    canonicalDigest(artifactoryEndpoint),
  );
  assert.equal(
    artifactoryAttestation.selectedCredentialEnvironmentName,
    null,
  );
});

test("project source reads use reviewed direct inputs without URL preconfiguration", async (t) => {
  let authorization = null;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization ?? null;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("bounded module evidence");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/modules/`;
  const env = {
    REVIEWED_MODULE_TOKEN: "loopback-test-credential",
  };

  const result = await readConfiguredSource({
    source: "modules",
    projectBaseUrl: baseUrl,
    credentialEnv: "REVIEWED_MODULE_TOKEN",
    relativeUrl: "catalog/item",
    env,
    allowLegacyEnvironment: false,
  });
  assert.equal(result.excerpt, "bounded module evidence");
  assert.equal(
    authorization,
    [["Bea", "rer"].join(""), "loopback-test-credential"].join(" "),
  );
  assert.equal(result.provenance.configuredBy, "reviewed-command-input");
  assert.equal(
    result.provenance.endpoint.kind,
    "reviewed-project-input",
  );
  assert.equal(
    result.provenance.credentialEnv,
    "REVIEWED_MODULE_TOKEN",
  );

  await assert.rejects(
    runSourceRead(
      [
        "--source",
        "modules",
        "--relative-url",
        "catalog/item",
      ],
      env,
    ),
    /CLAUDE_PLUGIN_DATA is required/u,
  );
  await assert.rejects(
    resolveSourceReadRequest({
      args: {
        source: "artifactory",
        "base-url": baseUrl,
        "relative-url": "catalog/item",
      },
      env: {},
      projectRoot: repositoryRoot,
    }),
    /accepted only/u,
  );
  await assert.rejects(
    resolveSourceReadRequest({
      args: {
        source: "nuget",
        "base-url": baseUrl,
        "relative-url": "catalog/item",
      },
      env: {},
      projectRoot: repositoryRoot,
    }),
    /accepted only/u,
  );
});

test("NuGet URL evidence is derived only from target project metadata", async (t) => {
  const projectRoot = await temporaryDirectory(t, "qaas-package-source-");
  const configuredUrl =
    "https://packages.example.test/project/nuget/v3/index.json";
  await writeFile(
    path.join(projectRoot, "NuGet.Config"),
    [
      "<configuration>",
      "  <packageSources>",
      "    <clear />",
      `    <add value='${configuredUrl}' key='project-feed' />`,
      "  </packageSources>",
      "</configuration>",
    ].join("\n"),
    "utf8",
  );
  await writeFile(
    path.join(projectRoot, "PackageFeeds.targets"),
    [
      "<Project>",
      "  <PropertyGroup>",
      "    <RestoreAdditionalProjectSources>",
      "      https://packages.example.test/secondary/v3/index.json",
      "    </RestoreAdditionalProjectSources>",
      "  </PropertyGroup>",
      "</Project>",
    ].join("\n"),
    "utf8",
  );

  const clean = await computePackageSnapshot({
    projectRoot,
    env: {},
  });
  const legacyOverride = await computePackageSnapshot({
    projectRoot,
    env: {
      QAAS_NUGET_FEED_URL:
        "https://ignored.example.test/nuget/v3/index.json",
    },
  });
  assert.equal(clean.digest, legacyOverride.digest);
  assert.equal(clean.packageSources.length, 2);
  assert.equal(
    resolveProjectPackageSource(clean, "project-feed").url,
    configuredUrl,
  );
  assert.throws(
    () => resolveProjectPackageSource(clean),
    /Multiple project NuGet sources/u,
  );
  assert.throws(
    () => resolveProjectPackageSource(clean, "missing-feed"),
    /current project package metadata/u,
  );
});

test("explicit endpoint reads are capped at 16 KiB", async () => {
  let requestedUrl = null;
  const small = await readConfiguredSource({
    source: "artifactory",
    relativeUrl: "api/system/ping",
    env: {
      QAAS_ARTIFACTORY_URL: "https://ignored.example.test/",
    },
    allowLegacyEnvironment: false,
    fetchImpl: async (url) => {
      requestedUrl = url.toString();
      return new Response("pong", { status: 200 });
    },
  });
  assert.equal(
    requestedUrl,
    "https://jfrog.com/artifactory/api/system/ping",
  );
  assert.equal(small.excerpt, "pong");

  await assert.rejects(
    readConfiguredSource({
      source: "artifactory",
      relativeUrl: "api/system/ping",
      outputLimitBytes: 64 * 1024,
      allowLegacyEnvironment: false,
      fetchImpl: async () =>
        new Response("x".repeat(16 * 1024 + 1), { status: 200 }),
    }),
    /exceeds the output bound/u,
  );
});

test("documentation reads remain explicit and capped at 16 KiB", async (t) => {
  let requests = 0;
  const server = http.createServer((_request, response) => {
    requests += 1;
    response.writeHead(200, { "Content-Type": "text/plain" });
    response.end("x".repeat(16 * 1024 + 1));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const baseUrl = `http://127.0.0.1:${server.address().port}/docs/`;

  await assert.rejects(
    resolveDocumentationQuery({
      query: "bounded response",
      relativeUrl: "page",
      sources: {
        mcp: null,
        primaryUrl: baseUrl,
        secondaryUrl: null,
        zimPath: null,
      },
      outputLimitBytes: 64 * 1024,
    }),
    /documentation sources were unavailable/u,
  );
  assert.equal(requests, 1);
});

test(
  "doctor and hook classification perform no implicit network request",
  { timeout: 60_000 },
  async (t) => {
    const projectRoot = await temporaryDirectory(t, "qaas-airgap-doctor-");
    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = async () => {
      fetchCalls += 1;
      return new Response("unexpected", { status: 200 });
    };
    try {
      resolveDocumentationSources({ env: {} });
      await attestDocumentationSourceConfiguration({});
      attestConfiguredSourceConfiguration({
        source: "artifactory",
        env: {},
        allowLegacyEnvironment: false,
      });

      const event = {
        hook_event_name: "PreToolUse",
        session_id: "airgap-source-session",
        tool_name: "Bash",
        tool_use_id: "airgap-source-read",
        tool_input: {
          command:
            'node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" ' +
            "--source artifactory --relative-url api/system/ping",
        },
      };
      const classification = await classifyToolCall(
        event,
        hookEnvironment(event, {
          env: {},
          projectRoot,
          pluginRoot,
        }),
      );
      assert.equal(classification.actionClass, "configured-source-read");
      assert.deepEqual(
        classification.sourceProvenance.configurationNames,
        [],
      );
      assert.equal(
        classification.sourceProvenance.configurationDigest,
        sha256({}),
      );
      assert.equal(
        classification.sourceProvenance.endpointConfiguration.endpoint.url,
        BUILT_IN_QAAS_ARTIFACTORY_URL,
      );
      assert.equal(
        classification.sourceProvenance.endpointConfiguration.endpointDigest,
        canonicalDigest(builtInEndpoint("artifactory")),
      );
      assert.match(
        classification.sourceProvenance.reviewedInputDigest,
        /^[a-f0-9]{64}$/u,
      );

      const minimalPath = path.dirname(process.execPath);
      const doctor = await runDoctor({
        env: {
          PATH: minimalPath,
          Path: minimalPath,
          PATHEXT: process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM",
          SystemRoot: process.env.SystemRoot,
          WINDIR: process.env.WINDIR,
          USERPROFILE: projectRoot,
          HOME: projectRoot,
        },
        projectRoot,
        pluginRoot,
        pluginVersion: "0.1.0",
      });
      assert.equal(typeof doctor.ok, "boolean");
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("public setup guidance has no core URL or legacy source prompt", async () => {
  const relativeFiles = [
    "README.md",
    "docs/airgap-configuration.md",
    "plugins/qaas/templates/project-context/.claude/qaas/integrations.md",
    "plugins/qaas/skills/upgrade-qaas-project/SKILL.md",
    "plugins/qaas/references/upgrades/version-proof.md",
  ];
  const documents = await Promise.all(
    relativeFiles.map(async (relative) => ({
      relative,
      text: await readFile(path.join(repositoryRoot, relative), "utf8"),
    })),
  );
  const legacySelectors =
    /QAAS_(?:DOCS_(?:PRIMARY|SECONDARY)_URL|ARTIFACTORY_URL|NUGET_FEED_URL|GITLAB_URL|MODULES_REPO_URL|COMMON_HOOKS_REPO_URL)/u;
  for (const document of documents) {
    assert.doesNotMatch(
      document.text,
      legacySelectors,
      `${document.relative} advertises legacy URL setup`,
    );
  }

  const lines = documents.flatMap((document) =>
    document.text
      .split(/\r?\n/u)
      .map((line) => ({ file: document.relative, line })),
  );
  const positivePrompts = lines.filter(
    ({ line }) =>
      /\b(?:ask|prompt|configure|provide|set|supply|enter|required?)\b/iu.test(
        line,
      ) &&
      /(?:\b(?:docs?|documentation|artifactory)\b.{0,80}\burl\b|\burl\b.{0,80}\b(?:docs?|documentation|artifactory)\b)/iu.test(
        line,
      ) &&
      !/\b(?:do not|never|no runtime|not an onboarding|will not)\b/iu.test(
        line,
      ),
  );
  assert.deepEqual(positivePrompts, []);

  const sourceRead = await readFile(
    path.join(pluginRoot, "scripts", "source-read.mjs"),
    "utf8",
  );
  const sourceReadRequest = await readFile(
    path.join(pluginRoot, "scripts", "lib", "source-read-request.mjs"),
    "utf8",
  );
  const hookRuntime = await readFile(
    path.join(pluginRoot, "scripts", "lib", "hook-runtime.mjs"),
    "utf8",
  );
  const doctor = await readFile(
    path.join(pluginRoot, "scripts", "doctor.mjs"),
    "utf8",
  );
  assert.match(sourceRead, /allowLegacyEnvironment:\s*false/u);
  assert.match(
    sourceReadRequest,
    /"gitlab",\s*"modules",\s*"common-hooks"/u,
  );
  assert.match(sourceRead, /activeSession\(context, args\["session-handle"\]\)/u);
  assert.match(sourceRead, /consumeExactSourceReadApproval/u);
  assert.doesNotMatch(hookRuntime, /\bfetch\s*\(/u);
  assert.doesNotMatch(doctor, /\bfetch\s*\(/u);
});
