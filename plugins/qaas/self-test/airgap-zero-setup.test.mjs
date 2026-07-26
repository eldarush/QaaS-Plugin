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

test("the immutable public docs fallback stays separate from reviewed Artifactory input", async () => {
  assert.equal(BUILT_IN_QAAS_DOCS_URL, "https://docs.qaas.online/");

  const docsEndpoint = builtInEndpoint("docs");
  assert.equal(Object.isFrozen(docsEndpoint), true);
  assert.throws(
    () => builtInEndpoint("artifactory"),
    /Unknown built-in QaaS endpoint/u,
  );
  assert.throws(() => {
    docsEndpoint.url = "https://changed.example.test/";
  }, TypeError);

  const configuredEnvironment = {
    QAAS_DOCS_HELM_URL: "https://helm-docs.example.test/qaas/",
    QAAS_DOCS_WIKIALL_URL: "https://wikiall.example.test/qaas/",
  };
  const sources = resolveDocumentationSources({ env: configuredEnvironment });
  assert.deepEqual(
    sources.httpSources.map((entry) => entry.source),
    ["helm-http", "wikiall-http", "built-in-public"],
  );
  assert.equal(
    sources.helmUrl,
    "https://helm-docs.example.test/qaas/",
  );
  assert.equal(
    sources.wikiAllUrl,
    "https://wikiall.example.test/qaas/",
  );
  assert.equal(sources.builtInUrl, BUILT_IN_QAAS_DOCS_URL);

  const docsAttestation =
    await attestDocumentationSourceConfiguration(configuredEnvironment);
  assert.deepEqual(docsAttestation.builtInEndpoints.docs, docsEndpoint);
  assert.equal(
    docsAttestation.builtInEndpointDigests.docs,
    canonicalDigest(docsEndpoint),
  );
  assert.deepEqual(docsAttestation.resolutionOrder, [
    "wikiall-mcp",
    "helm-http",
    "wikiall-http",
    "built-in-public",
  ]);
  assert.equal(
    docsAttestation.helm.effective.urlDigest,
    sha256("https://helm-docs.example.test/qaas/"),
  );
  assert.equal(
    docsAttestation.wikiAll.effective.urlDigest,
    sha256("https://wikiall.example.test/qaas/"),
  );
  assert.deepEqual(docsAttestation.configurationNames, [
    "QAAS_DOCS_HELM_URL",
    "QAAS_DOCS_WIKIALL_URL",
  ]);
  assert.equal(
    docsAttestation.mcp.effective.urlDigest,
    docsAttestation.wikiAll.effective.urlDigest,
  );
  assert.equal(sources.mcpUrl, sources.wikiAllUrl);

  const artifactoryAttestation =
    attestConfiguredSourceConfiguration({
      source: "artifactory",
      env: configuredEnvironment,
      projectBaseUrl: "https://artifactory.example.test/qaas/",
      credentialEnv: "ARTIFACTORY_TOKEN",
      allowLegacyEnvironment: false,
    });
  assert.deepEqual(artifactoryAttestation.configurationNames, []);
  assert.equal(artifactoryAttestation.endpoint.kind, "reviewed-project-input");
  assert.equal(
    artifactoryAttestation.endpoint.urlDigest,
    sha256("https://artifactory.example.test/qaas/"),
  );
  assert.equal(
    artifactoryAttestation.selectedCredentialEnvironmentName,
    "ARTIFACTORY_TOKEN",
  );
});

test("the two canonical documentation selectors reject unsafe URLs", async () => {
  for (const unsafe of [
    "not-a-url",
    "file:///approved/docs",
    ["https://user", "password@docs.example.test/"].join(":"),
    "https://docs.example.test/#fragment",
    "https://docs.example.test/?token=secret",
  ]) {
    assert.throws(
      () =>
        resolveDocumentationSources({
          env: { QAAS_DOCS_HELM_URL: unsafe },
        }),
      /QAAS_DOCS_HELM_URL/u,
    );
    assert.throws(
      () =>
        resolveDocumentationSources({
          env: { QAAS_DOCS_WIKIALL_URL: unsafe },
        }),
      /QAAS_DOCS_WIKIALL_URL/u,
    );
  }
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
  const artifactory = await resolveSourceReadRequest({
    args: {
      source: "artifactory",
      "base-url": baseUrl,
      "relative-url": "catalog/item",
    },
    env: {},
    projectRoot: repositoryRoot,
  });
  assert.equal(artifactory.requiresExactApproval, true);
  assert.equal(
    artifactory.description.baseUrl,
    baseUrl,
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
    projectBaseUrl: "https://artifactory.example.test/qaas/",
    relativeUrl: "api/system/ping",
    allowLegacyEnvironment: false,
    fetchImpl: async (url) => {
      requestedUrl = url.toString();
      return new Response("pong", { status: 200 });
    },
  });
  assert.equal(
    requestedUrl,
    "https://artifactory.example.test/qaas/api/system/ping",
  );
  assert.equal(small.excerpt, "pong");

  await assert.rejects(
    readConfiguredSource({
      source: "artifactory",
      projectBaseUrl: "https://artifactory.example.test/qaas/",
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
      },
      outputLimitBytes: 64 * 1024,
    }),
    /Documentation response exceeds the configured output bound/u,
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
      assert.throws(
        () =>
          attestConfiguredSourceConfiguration({
            source: "artifactory",
            env: {},
            allowLegacyEnvironment: false,
          }),
        /exact reviewed --base-url is required/u,
      );

      const event = {
        hook_event_name: "PreToolUse",
        session_id: "airgap-source-session",
        tool_name: "Bash",
        tool_use_id: "airgap-source-read",
        tool_input: {
          command:
            'node "${CLAUDE_PLUGIN_ROOT}/scripts/source-read.mjs" ' +
            "--source artifactory " +
            "--base-url https://artifactory.example.test/qaas/ " +
            "--relative-url api/system/ping",
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
        undefined,
      );
      assert.equal(
        classification.sourceProvenance.endpointConfiguration.endpoint.kind,
        "reviewed-project-input",
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
      assert.equal(doctor.documentationSources.configuration.valid, true);
      assert.deepEqual(doctor.documentationSources.resolutionOrder, [
        "wikiall-mcp",
        "helm-http",
        "wikiall-http",
        "built-in-public",
      ]);
      assert.equal(fetchCalls, 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  },
);

test("plugin guidance advertises only the two documentation selectors", async () => {
  const relativeFiles = [
    "README.md",
    "plugins/qaas/references/configuration/documentation-sources.md",
    "plugins/qaas/templates/project-context/.claude/qaas/integrations.md",
    "plugins/qaas/skills/query-qaas-docs/SKILL.md",
    "plugins/qaas/references/upgrades/version-proof.md",
  ];
  const documents = await Promise.all(
    relativeFiles.map(async (relative) => ({
      relative,
      text: await readFile(path.join(repositoryRoot, relative), "utf8"),
    })),
  );
  const legacySelectors =
    /QAAS_(?:NUGET_FEED_URL|GITLAB_URL|MODULES_REPO_URL|COMMON_HOOKS_REPO_URL)/u;
  for (const document of documents) {
    assert.doesNotMatch(
      document.text,
      legacySelectors,
      `${document.relative} advertises legacy URL setup`,
    );
  }
  const combined = documents.map((document) => document.text).join("\n");
  const selectors = [
    "QAAS_DOCS_HELM_URL",
    "QAAS_DOCS_WIKIALL_URL",
  ];
  for (const selector of selectors) {
    assert.match(combined, new RegExp(`\\b${selector}\\b`, "u"));
  }
  assert.deepEqual(
    [...new Set(combined.match(/\bQAAS_DOCS_[A-Z0-9_]*_URL\b/gu))].sort(),
    [...selectors].sort(),
  );

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
      /(?:\bartifactory\b.{0,80}\burl\b|\burl\b.{0,80}\bartifactory\b)/iu.test(
        line,
      ) &&
      !/\b(?:do not|never|no runtime|not an onboarding|will not)\b/iu.test(
        line,
      ),
  );
  assert.ok(positivePrompts.length > 0);
  for (const prompt of positivePrompts) {
    assert.match(prompt.line, /reviewed|one-use|--base-url/iu);
  }

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
    /"gitlab",\s*"artifactory",\s*"modules",\s*"common-hooks"/u,
  );
  assert.match(sourceRead, /activeSession\(context, args\["session-handle"\]\)/u);
  assert.match(sourceRead, /consumeExactSourceReadApproval/u);
  assert.doesNotMatch(hookRuntime, /\bfetch\s*\(/u);
  assert.doesNotMatch(doctor, /\bfetch\s*\(/u);
});
