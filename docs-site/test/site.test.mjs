import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildSite,
  maximumCatalogBytes,
  projectDirectory,
  renderTemplate,
  resolveConfig,
} from "../scripts/build.mjs";
import { startServer } from "../scripts/server.mjs";
import {
  applyConfig,
  applyTheme,
  nextTheme,
  normalizeRoute,
  normalizeTheme,
} from "../src/app.js";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const docsDirectory = path.resolve(testDirectory, "..");
const distDirectory = path.join(docsDirectory, "dist");

const files = {};
const catalogFiles = new Map();

before(async () => {
  const entries = await Promise.all(
    [
      ["html", "dist/index.html"],
      ["css", "dist/assets/site.css"],
      ["js", "dist/assets/app.js"],
      ["catalogCss", "dist/catalog/catalog.css"],
      ["workflowCapture", "dist/assets/demo/workflow-capture.png", null],
      ["evidenceCapture", "dist/assets/demo/evidence-capture.png", null],
      ["template", "src/index.template.html"],
      ["dockerfile", "Dockerfile"],
      ["design", "DESIGN.md"],
      ["product", "PRODUCT.md"],
    ].map(async ([key, relativePath, encoding = "utf8"]) => [
      key,
      await readFile(path.join(docsDirectory, relativePath), encoding ?? undefined),
    ]),
  );

  Object.assign(files, Object.fromEntries(entries));

  const catalogNames = (
    await readdir(path.join(distDirectory, "catalog"))
  ).filter((name) => name.endsWith(".html"));
  await Promise.all(
    catalogNames.map(async (name) => {
      catalogFiles.set(
        name,
        await readFile(path.join(distDirectory, "catalog", name), "utf8"),
      );
    }),
  );
});

describe("build configuration", () => {
  test("ships the requested stable defaults", async () => {
    const config = await resolveConfig({ env: {}, includeLocal: false });

    assert.deepEqual(config, {
      title: "QaaS Plugin",
      version: "0.4.0",
      description:
        "Safety-gated, documentation-backed QaaS test authoring for Claude Code.",
      repositoryUrl: "https://github.com/TheSmokeTeam/QaaS-Plugin",
      helmDocsUrl: "",
      wikiallDocsUrl: "",
    });
  });

  test("canonical runtime variables override defaults", async () => {
    const config = await resolveConfig({
      env: {
        QAAS_PLUGIN_REPOSITORY_URL: "https://example.test/qaas-plugin/",
        QAAS_PLUGIN_VERSION: "0.4.7-test",
        QAAS_DOCS_HELM_URL: "http://helm.internal.test/manual/",
        QAAS_DOCS_WIKIALL_URL: "https://wiki.internal.test/qaas/",
      },
      includeLocal: false,
    });

    assert.equal(config.repositoryUrl, "https://example.test/qaas-plugin");
    assert.equal(config.version, "0.4.7-test");
    assert.equal(config.helmDocsUrl, "http://helm.internal.test/manual");
    assert.equal(config.wikiallDocsUrl, "https://wiki.internal.test/qaas");
  });

  test("legacy docs aliases remain supported", async () => {
    const config = await resolveConfig({
      env: {
        QAAS_DOCS_REPOSITORY_URL: "https://example.test/docs-repository",
        QAAS_DOCS_VERSION: "0.4.1",
      },
      includeLocal: false,
    });

    assert.equal(
      config.repositoryUrl,
      "https://example.test/docs-repository",
    );
    assert.equal(config.version, "0.4.1");
  });

  test("URL inputs reject unsafe protocols, credentials, and fragments", async () => {
    await assert.rejects(
      resolveConfig({
        env: { QAAS_PLUGIN_REPOSITORY_URL: "http://example.test/repository" },
        includeLocal: false,
      }),
      /must use HTTPS/,
    );

    await assert.rejects(
      resolveConfig({
        env: {
          QAAS_PLUGIN_REPOSITORY_URL:
            ["https:/", "/operator:secret@example.test/repository"].join(""),
        },
        includeLocal: false,
      }),
      /must not contain credentials/,
    );

    await assert.rejects(
      resolveConfig({
        env: { QAAS_DOCS_HELM_URL: "file:///etc/passwd" },
        includeLocal: false,
      }),
      /must use HTTP or HTTPS/,
    );

    await assert.rejects(
      resolveConfig({
        env: { QAAS_DOCS_WIKIALL_URL: "https://wiki.test/docs#token" },
        includeLocal: false,
      }),
      /must not contain a fragment/,
    );
  });

  test("template rendering escapes HTML and inline JSON", () => {
    const rendered = renderTemplate(
      [
        "{{SITE_TITLE}}",
        "{{SITE_VERSION}}",
        "{{SITE_DESCRIPTION}}",
        "{{REPOSITORY_URL}}",
        "{{SITE_CONFIG_JSON}}",
      ].join("\n"),
      {
        title: "<QaaS>",
        version: "0.4.0",
        description: '"proof" & safety',
        repositoryUrl: "https://example.test/repository?a=1&b=2",
        helmDocsUrl: "https://example.test/<unsafe>",
        wikiallDocsUrl: "",
      },
    );

    assert.match(rendered, /&lt;QaaS&gt;/);
    assert.match(rendered, /&quot;proof&quot; &amp; safety/);
    assert.match(rendered, /a=1&amp;b=2/);
    assert.match(rendered, /\\u003cunsafe\\u003e/);
    assert.doesNotMatch(rendered, /\{\{[A-Z0-9_]+\}\}/);
  });

  test("build output cannot escape docs-site", async () => {
    await assert.rejects(
      buildSite({ env: {}, outputDirectory: "../outside-docs-site" }),
      /must stay inside docs-site/,
    );
    assert.equal(
      projectDirectory,
      docsDirectory,
      "test and build must agree on the docs-site boundary",
    );
  });
});

describe("static artifact", () => {
  test("contains the complete Pages-ready file set", async () => {
    for (const relativePath of [
      "index.html",
      "assets/site.css",
      "assets/app.js",
      "assets/demo/workflow-capture.png",
      "assets/demo/evidence-capture.png",
      "catalog/catalog.css",
      "catalog/index.html",
      "catalog/overview.html",
      ".nojekyll",
    ]) {
      const contents = await readFile(path.join(distDirectory, relativePath));
      assert.ok(
        contents.byteLength > 0 || relativePath === ".nojekyll",
        `${relativePath} should exist`,
      );
    }
    assert.deepEqual(
      (await readdir(path.join(distDirectory, "assets", "demo"))).sort(),
      ["evidence-capture.png", "workflow-capture.png"],
      "the artifact must not retain obsolete placeholder SVGs",
    );
  });

  test("exposes exactly one external anchor", () => {
    const everyHtml = [files.html, ...catalogFiles.values()].join("\n");
    const hrefs = Array.from(
      everyHtml.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi),
      (match) => match[1],
    );
    const external = hrefs.filter((href) => /^https?:\/\//i.test(href));

    assert.deepEqual(external, [
      "https://github.com/TheSmokeTeam/QaaS-Plugin",
    ]);
    assert.equal(
      (files.html.match(/\btarget="_blank"/g) ?? []).length,
      1,
      "only the repository control may open a new tab",
    );
    assert.match(
      files.html,
      /rel="external noopener noreferrer"/,
      "the external anchor should be isolated from the opener",
    );
  });

  test("loads only same-artifact runtime resources", async () => {
    const resourceReferences = Array.from(
      files.html.matchAll(
        /<(?:script|link|img|source|iframe)\b[^>]*\b(?:src|href)="([^"]+)"/gi,
      ),
      (match) => match[1],
    );

    assert.deepEqual(resourceReferences, [
      "./assets/site.css",
      "./assets/demo/workflow-capture.png",
      "./assets/demo/evidence-capture.png",
      "./assets/app.js",
    ]);
    assert.doesNotMatch(files.css, /@import|url\(\s*["']?https?:/i);
    assert.doesNotMatch(
      files.catalogCss,
      /@import|url\(\s*["']?https?:/i,
    );
    assert.doesNotMatch(
      files.js,
      /\b(?:fetch|XMLHttpRequest|WebSocket|EventSource)\b|import\s*\(\s*["']https?:/i,
    );
    assert.equal((files.html.match(/<img\b/g) ?? []).length, 2);
    assert.doesNotMatch(files.html, /<(?:svg|video|audio|iframe)\b/i);
    assert.equal(
      (
        files.html.match(
          /Actual terminal capture of a controlled Codex proxy with scripted operator input\./g,
        ) ?? []
      ).length,
      2,
    );
    assert.equal(
      (
        files.html.match(
          /Synthetic fixture; not customer data or live Claude Code\/QaaS runtime evidence\./g,
        ) ?? []
      ).length,
      2,
    );

    const offlineStart = files.html.indexOf('data-route="offline"');
    const architectureStart = files.html.indexOf('data-route="architecture"');
    assert.ok(offlineStart >= 0 && architectureStart > offlineStart);
    assert.doesNotMatch(
      files.html.slice(offlineStart, architectureStart),
      /demo-slot|assets\/demo\//,
      "the Air-gap route should not retain a placeholder figure",
    );
    assert.match(
      files.html,
      /data-route="workflow"[\s\S]*?workflow-capture\.png[\s\S]*?data-route="safety"/,
    );
    assert.match(
      files.html,
      /data-route="architecture"[\s\S]*?evidence-capture\.png[\s\S]*?data-route="reference"/,
    );

    const pngSignature = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    for (const [fileName, capture] of [
      ["workflow-capture.png", files.workflowCapture],
      ["evidence-capture.png", files.evidenceCapture],
    ]) {
      assert.deepEqual(capture.subarray(0, 8), pngSignature);
      assert.equal(capture.toString("ascii", 12, 16), "IHDR");
      assert.equal(capture.readUInt32BE(16), 1212);
      assert.equal(capture.readUInt32BE(20), 766);
      assert.deepEqual(
        capture,
        await readFile(
          path.join(docsDirectory, "src", "assets", "demo", fileName),
        ),
        `${fileName} should be copied byte-for-byte`,
      );
    }
  });

  test("uses hash routes and relative assets for repository subpaths", () => {
    const internalHrefs = Array.from(
      files.html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi),
      (match) => match[1],
    ).filter((href) => !/^https?:\/\//i.test(href));

    assert.ok(internalHrefs.length > 10);
    assert.ok(
      internalHrefs.every(
        (href) => href === "#main-content" || href.startsWith("#/"),
      ),
    );
    assert.match(files.html, /href="\.\/assets\/site\.css"/);
    assert.match(files.html, /src="\.\/assets\/app\.js"/);
    assert.doesNotMatch(files.html, /<base\b/i);
  });

  test("route links exactly match route-equivalent sections", () => {
    const routes = new Set(
      Array.from(
        files.html.matchAll(/\bdata-route="([^"]+)"/g),
        (match) => match[1],
      ),
    );
    const links = new Set(
      Array.from(
        files.html.matchAll(/\bdata-route-link="([^"]+)"/g),
        (match) => match[1],
      ),
    );

    assert.deepEqual(routes, links);
    assert.deepEqual([...routes], [
      "overview",
      "start",
      "workflow",
      "safety",
      "offline",
      "architecture",
      "reference",
    ]);

    for (const route of routes) {
      assert.match(
        files.html,
        new RegExp(
          `<section[\\s\\S]*?data-route="${route}"[\\s\\S]*?<h1\\b`,
        ),
      );
    }
  });

  test("includes core semantic and accessibility affordances", () => {
    assert.match(files.html, /<html lang="en">/);
    assert.match(files.html, /href="#main-content">Skip to documentation/);
    assert.match(files.html, /<nav class="route-rail" aria-label="Documentation">/);
    assert.match(files.html, /<main id="main-content" tabindex="-1">/);
    assert.match(files.html, /aria-live="polite"/);
    assert.match(files.html, /<button[^>]+data-theme-toggle/);
    assert.match(files.html, /data-theme-status[^>]+aria-live="polite"/);
    assert.match(files.html, /<th scope="col">/);
    assert.match(files.html, /aria-labelledby="[^"]+"/);
    assert.match(files.css, /:focus-visible/);
    assert.match(files.css, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(files.css, /@media \(prefers-color-scheme: dark\)/);
    assert.match(files.css, /:root\[data-theme="dark"\]/);
    assert.match(files.css, /@media \(forced-colors: active\)/);
    assert.match(files.css, /@media \(pointer: coarse\)/);
    assert.match(files.css, /@media print/);
    assert.match(files.css, /\.table-scroll\s*\{[\s\S]*?overflow-x:\s*auto/);
    assert.match(
      files.css,
      /\.table-scroll table\s*\{[\s\S]*?min-width:\s*42rem/,
    );
  });

  test("injects parseable config without unresolved tokens", () => {
    const configMatch = files.html.match(
      /<script id="site-config" type="application\/json">([\s\S]*?)<\/script>/,
    );
    assert.ok(configMatch);
    const config = JSON.parse(configMatch[1]);

    assert.equal(config.version, "0.4.0");
    assert.equal(
      config.repositoryUrl,
      "https://github.com/TheSmokeTeam/QaaS-Plugin",
    );
    assert.equal(config.helmDocsUrl, "");
    assert.equal(config.wikiallDocsUrl, "");
    assert.doesNotMatch(files.html, /\{\{[A-Z0-9_]+\}\}/);
    assert.match(files.html, /data-config="helmDocsUrl"/);
    assert.match(files.html, /data-config="wikiallDocsUrl"/);
  });

  test("renders documentation selectors as text rather than links", () => {
    const elements = new Map([
      ["helmDocsUrl", { textContent: "" }],
      ["wikiallDocsUrl", { textContent: "" }],
    ]);
    const source = {
      querySelectorAll: () => [],
      querySelector: (selector) => {
        const match = selector.match(/^\[data-config="([^"]+)"\]$/);
        return match ? elements.get(match[1]) ?? null : null;
      },
    };

    applyConfig(
      {
        title: "QaaS Plugin",
        version: "0.4.0",
        repositoryUrl: "https://example.test/repository",
        helmDocsUrl: "https://helm.internal.test/docs",
        wikiallDocsUrl: "",
      },
      source,
    );

    assert.equal(
      elements.get("helmDocsUrl").textContent,
      "https://helm.internal.test/docs",
    );
    assert.equal(elements.get("wikiallDocsUrl").textContent, "Not configured");
  });

  test("keeps visible guidance evergreen and task-led", () => {
    assert.match(files.html, /<title>QaaS Plugin · Documentation<\/title>/);
    assert.doesNotMatch(
      files.html,
      /data-config="version"|Docs build/,
      "release versions must not be rendered as visible page content",
    );
    const visibleHtml = files.html.replace(
      /<script id="site-config" type="application\/json">[\s\S]*?<\/script>/,
      "",
    );
    const visibleCatalog = Array.from(catalogFiles.values()).join("\n");
    for (const [surface, visibleCopy] of [
      ["main documentation", visibleHtml],
      ["catalog documentation", visibleCatalog],
    ]) {
      assert.doesNotMatch(
        visibleCopy,
        /\bv?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/u,
        `${surface} must not expose semantic versions`,
      );
      assert.doesNotMatch(
        visibleCopy,
        /\bor newer\b/iu,
        `${surface} must use capability-based requirements`,
      );
    }
    assert.match(files.html, /Choose a task/);
    assert.ok(
      (files.html.match(/class="task-card"/g) ?? []).length >= 4,
      "the overview should prioritize short task cards",
    );
  });

  test("documents the exact documentation resolver order and selectors", () => {
    const start = files.html.indexOf('data-route="offline"');
    const end = files.html.indexOf('data-route="architecture"');
    const offline = files.html.slice(start, end);
    const orderedTerms = [
      "WikiAll MCP",
      "Helm HTTP",
      "WikiAll HTTP",
      "Public fallback (connected mode only)",
    ];
    let previous = -1;
    for (const term of orderedTerms) {
      const position = offline.indexOf(term);
      assert.ok(position > previous, `${term} should appear in resolver order`);
      previous = position;
    }
    for (const selector of [
      "QAAS_DOCS_MCP_URL",
      "QAAS_DOCS_MCP_CREDENTIAL_ENV",
      "QAAS_DOCS_HELM_URL",
      "QAAS_DOCS_WIKIALL_URL",
      "QAAS_DOCS_AIRGAP",
      "QAAS_DOCS_ZIM_PATH",
    ]) {
      assert.match(offline, new RegExp(selector));
    }
    assert.match(
      offline.replace(/\s+/g, " "),
      /docs container accepts Helm and WikiAll HTTP values only to display/,
    );

    const compactAirGap = catalogFiles.get("air-gap.html");
    assert.ok(compactAirGap);
    previous = -1;
    for (const selector of [
      "QAAS_DOCS_MCP_URL",
      "QAAS_DOCS_MCP_CREDENTIAL_ENV",
      "QAAS_DOCS_HELM_URL",
      "QAAS_DOCS_WIKIALL_URL",
      "QAAS_DOCS_AIRGAP",
      "QAAS_DOCS_ZIM_PATH",
    ]) {
      const position = compactAirGap.indexOf(selector);
      assert.ok(position > previous, `${selector} should appear in catalog order`);
      previous = position;
    }
  });

  test("cycles an accessible system-aware theme without changing content", () => {
    assert.equal(normalizeTheme("unexpected"), "system");
    assert.equal(nextTheme("system"), "light");
    assert.equal(nextTheme("light"), "dark");
    assert.equal(nextTheme("dark"), "system");

    const root = {
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      removeAttribute(name) {
        this.attributes.delete(name);
      },
    };
    const label = { textContent: "" };
    const icon = { textContent: "" };
    const control = {
      dataset: {},
      attributes: new Map(),
      setAttribute(name, value) {
        this.attributes.set(name, value);
      },
      querySelector(selector) {
        if (selector === "[data-theme-label]") return label;
        if (selector === "[data-theme-icon]") return icon;
        return null;
      },
    };
    const status = { textContent: "" };

    assert.equal(
      applyTheme("dark", { root, control, status, announce: true }),
      "dark",
    );
    assert.equal(root.attributes.get("data-theme"), "dark");
    assert.equal(label.textContent, "Dark");
    assert.equal(icon.textContent, "☾");
    assert.match(control.attributes.get("aria-label"), /Switch to Auto/);
    assert.equal(status.textContent, "Dark color theme selected.");

    applyTheme("system", { root, control, status });
    assert.equal(root.attributes.has("data-theme"), false);
    assert.equal(label.textContent, "Auto");
  });

  test("keeps the documented Impeccable design contract in the surface", () => {
    assert.match(files.design, /Direction: acceptance ledger/);
    assert.match(files.design, /\*\*Read\*\* mode/);
    assert.match(files.design, /45–70 characters/);
    assert.match(files.design, /No nested cards/);
    assert.match(files.design, /Auto → Light → Dark/);
    assert.match(files.product, /Visible guidance is evergreen/);
    assert.match(files.product, /exactly one external anchor/);
    assert.match(files.product, /Node\.js built-ins/);
  });

  test("ships a bounded same-origin plugin documentation catalog", () => {
    assert.deepEqual([...catalogFiles.keys()].sort(), [
      "air-gap.html",
      "architecture.html",
      "getting-started.html",
      "index.html",
      "overview.html",
      "reference.html",
      "safety.html",
      "workflow.html",
    ]);

    for (const [name, html] of catalogFiles) {
      assert.ok(
        Buffer.byteLength(html) <= maximumCatalogBytes,
        `${name} must be no more than 16 KiB`,
      );
      assert.match(html, /QaaS Plugin/);
      assert.match(
        html,
        /not (?:the changing )?external QaaS platform or API documentation/i,
      );
      assert.match(
        html,
        /<link rel="stylesheet" href="\.\/catalog\.css">/,
      );
      assert.doesNotMatch(html, /<(?:script|style|img|iframe)\b/i);

      const anchors = Array.from(
        html.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi),
        (match) => match[1],
      );
      for (const href of anchors) {
        assert.doesNotMatch(href, /^[a-z][a-z0-9+.-]*:|^\/\//i);
        assert.doesNotMatch(href, /[?#]/);
        const resolved = new URL(
          href,
          `https://example.test/catalog/${name}`,
        );
        assert.match(resolved.pathname, /^\/catalog\//);
      }
    }

    const catalogIndexLinks = Array.from(
      catalogFiles
        .get("index.html")
        .matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi),
      (match) => match[1],
    );
    assert.equal(catalogIndexLinks.length, 7);
    assert.ok(Buffer.byteLength(files.catalogCss) <= maximumCatalogBytes);
    assert.match(files.catalogCss, /@media \(prefers-color-scheme: dark\)/);
    assert.doesNotMatch(files.catalogCss, /@import|url\s*\(/i);
  });
});

describe("routing", () => {
  const available = new Set([
    "overview",
    "start",
    "workflow",
    "safety",
    "offline",
    "architecture",
    "reference",
  ]);

  test("normalizes supported hash forms", () => {
    assert.equal(normalizeRoute("#/workflow", available), "workflow");
    assert.equal(normalizeRoute("#safety", available), "safety");
    assert.equal(normalizeRoute("#/offline?print=1", available), "offline");
    assert.equal(normalizeRoute("#/architecture/details", available), "architecture");
  });

  test("falls back to overview for missing or unknown routes", () => {
    assert.equal(normalizeRoute("", available), "overview");
    assert.equal(normalizeRoute("#/unknown", available), "overview");
  });
});

describe("container contract", () => {
  test("declares requested OCI identity and unprivileged runtime", () => {
    const pinnedBase =
      "node:24.14.0-alpine@sha256:7fddd9ddeae8196abf4a3ef2de34e11f7b1a722119f91f28ddf1e99dcafdf114";
    assert.equal(
      (
        files.dockerfile.match(
          new RegExp(
            `FROM ${pinnedBase.replaceAll(".", "\\.").replaceAll("+", "\\+")}`,
            "g",
          ),
        ) ?? []
      ).length,
      2,
      "both stages must use the verified multi-arch Node base",
    );
    assert.match(
      files.dockerfile,
      /org\.opencontainers\.image\.title="qaas-plugin-docs"/,
    );
    assert.match(
      files.dockerfile,
      /org\.opencontainers\.image\.version="0\.4\.0"/,
    );
    assert.match(
      files.dockerfile,
      /org\.opencontainers\.image\.source="https:\/\/github\.com\/TheSmokeTeam\/QaaS-Plugin"/,
    );
    assert.match(files.dockerfile, /\nUSER 1000:1000\n[\s\S]*\nEXPOSE 8080\n/);
    assert.match(files.dockerfile, /\nHEALTHCHECK [\s\S]*\/healthcheck\.mjs"\]\n/);
    assert.match(files.dockerfile, /CMD \["node", "scripts\/server\.mjs"\]/);
    assert.doesNotMatch(files.dockerfile, /\b(?:curl|wget|npm install|apk add)\b/i);
  });

  test("does not rely on a writable runtime filesystem", () => {
    const finalStage = files.dockerfile.split(/^FROM /m).at(-1);
    assert.ok(finalStage);
    const userIndex = finalStage.indexOf("USER 1000:1000");
    assert.ok(userIndex >= 0);
    assert.doesNotMatch(finalStage.slice(userIndex), /\bRUN\b/);
  });
});

describe("runtime server", () => {
  let runtime;
  let baseUrl;

  before(async () => {
    runtime = await startServer({
      host: "127.0.0.1",
      port: 0,
      env: {
        QAAS_PLUGIN_REPOSITORY_URL: "https://example.test/runtime-repository",
        QAAS_PLUGIN_VERSION: "0.4.9-runtime",
        QAAS_DOCS_HELM_URL: "http://helm.internal.test/manual",
        QAAS_DOCS_WIKIALL_URL: "https://wiki.internal.test/qaas",
      },
    });
    baseUrl = `http://127.0.0.1:${runtime.port}`;
  });

  after(async () => {
    if (runtime?.server.listening) {
      await new Promise((resolve, reject) => {
        runtime.server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test("serves health, prefixed HTML, and prefixed static assets", async () => {
    const [
      health,
      page,
      css,
      catalogCss,
      workflowCapture,
      evidenceCapture,
      catalog,
      topic,
    ] =
      await Promise.all([
      fetch(`${baseUrl}/healthz`),
      fetch(`${baseUrl}/qaas-plugin/`),
      fetch(`${baseUrl}/qaas-plugin/assets/site.css`),
      fetch(`${baseUrl}/qaas-plugin/catalog/catalog.css`),
      fetch(`${baseUrl}/qaas-plugin/assets/demo/workflow-capture.png`),
      fetch(`${baseUrl}/qaas-plugin/assets/demo/evidence-capture.png`),
      fetch(`${baseUrl}/qaas-plugin/catalog/`),
      fetch(`${baseUrl}/qaas-plugin/catalog/safety.html`),
      ]);

    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), {
      status: "ok",
      version: "0.4.9-runtime",
    });
    assert.equal(page.status, 200);
    assert.match(page.headers.get("content-type"), /^text\/html/);
    const contentSecurityPolicy = page.headers.get(
      "content-security-policy",
    );
    assert.match(contentSecurityPolicy, /connect-src 'none'/);
    assert.match(contentSecurityPolicy, /style-src 'self'/);
    assert.doesNotMatch(contentSecurityPolicy, /unsafe-inline/);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /^text\/css/);
    assert.equal(catalogCss.status, 200);
    assert.match(catalogCss.headers.get("content-type"), /^text\/css/);
    for (const capture of [workflowCapture, evidenceCapture]) {
      assert.equal(capture.status, 200);
      assert.match(capture.headers.get("content-type"), /^image\/png(?:;|$)/);
    }
    assert.equal(catalog.status, 200);
    assert.ok(
      Buffer.byteLength(await catalog.text()) <= maximumCatalogBytes,
      "runtime catalog index must remain bounded",
    );
    assert.equal(topic.status, 200);
    const topicHtml = await topic.text();
    assert.ok(
      Buffer.byteLength(topicHtml) <= maximumCatalogBytes,
      "runtime focused topic must remain bounded",
    );
    assert.match(topicHtml, /href="\.\/catalog\.css"/);
    assert.doesNotMatch(topicHtml, /<style\b|style="/i);
  });

  test("injects all requested env values without adding an external anchor", async () => {
    const response = await fetch(`${baseUrl}/`);
    const html = await response.text();
    const externalAnchors = Array.from(
      html.matchAll(/<a\b[^>]*\bhref="(https?:\/\/[^"]+)"/gi),
      (match) => match[1],
    );

    assert.deepEqual(externalAnchors, [
      "https://example.test/runtime-repository",
    ]);
    assert.match(html, /0\.4\.9-runtime/);
    assert.doesNotMatch(
      html.replace(
        /<script id="site-config" type="application\/json">[\s\S]*?<\/script>/,
        "",
      ),
      /0\.4\.9-runtime/,
      "the runtime version may remain in internal config but not visible content",
    );
    assert.match(html, /http:\\?\/\\?\/helm\.internal\.test\/manual/);
    assert.match(html, /https:\\?\/\\?\/wiki\.internal\.test\/qaas/);
    assert.doesNotMatch(
      html,
      /href="https?:\/\/(?:helm|wiki)\.internal\.test/i,
    );
  });

  test("allows only GET and HEAD", async () => {
    const [head, post] = await Promise.all([
      fetch(`${baseUrl}/healthz`, { method: "HEAD" }),
      fetch(`${baseUrl}/`, { method: "POST" }),
    ]);

    assert.equal(head.status, 200);
    assert.equal(post.status, 405);
    assert.equal(post.headers.get("allow"), "GET, HEAD");
  });
});
