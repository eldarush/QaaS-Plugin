import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCatalog } from "../src/catalog.mjs";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
export const projectDirectory = path.resolve(scriptDirectory, "..");

const defaultConfigPath = path.join(projectDirectory, "site.config.json");
const localConfigPath = path.join(projectDirectory, "site.config.local.json");
const templatePath = path.join(projectDirectory, "src", "index.template.html");
const sourceAssets = Object.freeze([
  ["src/site.css", "assets/site.css"],
  ["src/app.js", "assets/app.js"],
  ["src/catalog.css", "catalog/catalog.css"],
  [
    "src/assets/demo/workflow-capture.png",
    "assets/demo/workflow-capture.png",
  ],
  [
    "src/assets/demo/evidence-capture.png",
    "assets/demo/evidence-capture.png",
  ],
]);
const obsoleteDemoAssets = Object.freeze([
  "assets/demo/workflow-preview.svg",
  "assets/demo/air-gap-preview.svg",
]);
export const maximumCatalogBytes = 16 * 1024;

const envMap = Object.freeze({
  QAAS_DOCS_TITLE: "title",
  QAAS_DOCS_VERSION: "version",
  QAAS_DOCS_DESCRIPTION: "description",
  QAAS_DOCS_REPOSITORY_URL: "repositoryUrl",
  QAAS_PLUGIN_VERSION: "version",
  QAAS_PLUGIN_REPOSITORY_URL: "repositoryUrl",
  QAAS_DOCS_HELM_URL: "helmDocsUrl",
  QAAS_DOCS_WIKIALL_URL: "wikiallDocsUrl",
});

function assertText(value, key, maximumLength) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${key} must be a non-empty string.`);
  }

  const normalized = value.trim();
  if (normalized.length > maximumLength) {
    throw new Error(`${key} must be at most ${maximumLength} characters.`);
  }

  return normalized;
}

function assertRepositoryUrl(value) {
  const normalized = assertText(value, "repositoryUrl", 2048);
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("repositoryUrl must be an absolute HTTPS URL.");
  }

  if (parsed.protocol !== "https:") {
    throw new Error("repositoryUrl must use HTTPS.");
  }

  if (parsed.username || parsed.password) {
    throw new Error("repositoryUrl must not contain credentials.");
  }

  if (parsed.hash) {
    throw new Error("repositoryUrl must not contain a fragment.");
  }

  return parsed.href.replace(/\/$/, "");
}

function assertOptionalServiceUrl(value, key) {
  if (value === undefined || value === null || value === "") {
    return "";
  }

  const normalized = assertText(value, key, 2048);
  let parsed;

  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error(`${key} must be an absolute HTTP or HTTPS URL.`);
  }

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error(`${key} must use HTTP or HTTPS.`);
  }

  if (parsed.username || parsed.password) {
    throw new Error(`${key} must not contain credentials.`);
  }

  if (parsed.hash) {
    throw new Error(`${key} must not contain a fragment.`);
  }

  return parsed.href.replace(/\/$/, "");
}

function validateConfig(candidate) {
  return Object.freeze({
    title: assertText(candidate.title, "title", 80),
    version: assertText(candidate.version, "version", 40),
    description: assertText(candidate.description, "description", 240),
    repositoryUrl: assertRepositoryUrl(candidate.repositoryUrl),
    helmDocsUrl: assertOptionalServiceUrl(candidate.helmDocsUrl, "helmDocsUrl"),
    wikiallDocsUrl: assertOptionalServiceUrl(
      candidate.wikiallDocsUrl,
      "wikiallDocsUrl",
    ),
  });
}

async function readJson(filePath, required) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (!required && error?.code === "ENOENT") {
      return {};
    }

    if (error instanceof SyntaxError) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }

    throw error;
  }
}

export async function resolveConfig({
  env = process.env,
  configPath,
  includeLocal = true,
} = {}) {
  const resolvedConfigPath = path.resolve(
    configPath ?? env.QAAS_DOCS_CONFIG ?? defaultConfigPath,
  );
  const base = await readJson(resolvedConfigPath, true);
  const local =
    includeLocal && resolvedConfigPath === defaultConfigPath
      ? await readJson(localConfigPath, false)
      : {};

  const environment = {};
  for (const [environmentKey, configKey] of Object.entries(envMap)) {
    if (env[environmentKey] !== undefined) {
      environment[configKey] = env[environmentKey];
    }
  }

  return validateConfig({ ...base, ...local, ...environment });
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function serializeInlineJson(value) {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026")
    .replaceAll("\u2028", "\\u2028")
    .replaceAll("\u2029", "\\u2029");
}

export function renderTemplate(template, config) {
  const replacements = {
    "{{SITE_TITLE}}": escapeHtml(config.title),
    "{{SITE_VERSION}}": escapeHtml(config.version),
    "{{SITE_DESCRIPTION}}": escapeHtml(config.description),
    "{{REPOSITORY_URL}}": escapeHtml(config.repositoryUrl),
    "{{SITE_CONFIG_JSON}}": serializeInlineJson(config),
  };

  let rendered = template;
  for (const [token, replacement] of Object.entries(replacements)) {
    rendered = rendered.replaceAll(token, replacement);
  }

  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/g);
  if (unresolved) {
    throw new Error(`Unresolved template token: ${unresolved[0]}`);
  }

  return rendered;
}

async function atomicWrite(filePath, contents) {
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, contents);
  await rename(temporaryPath, filePath);
}

function validateCatalogPage(fileName, contents) {
  const size = Buffer.byteLength(contents);
  if (size > maximumCatalogBytes) {
    throw new Error(
      `catalog/${fileName} is ${size} bytes; maximum is ${maximumCatalogBytes}.`,
    );
  }

  const anchors = Array.from(
    contents.matchAll(/<a\b[^>]*\bhref="([^"]+)"/gi),
    (match) => match[1],
  );
  for (const href of anchors) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//")) {
      throw new Error(`catalog/${fileName} contains an external anchor.`);
    }
    if (href.includes("#") || href.includes("?")) {
      throw new Error(
        `catalog/${fileName} contains a fragment or query anchor: ${href}`,
      );
    }

    const resolved = new URL(
      href,
      `https://catalog.invalid/catalog/${fileName}`,
    );
    if (!resolved.pathname.startsWith("/catalog/")) {
      throw new Error(
        `catalog/${fileName} contains an anchor outside the catalog: ${href}`,
      );
    }
  }
}

export async function buildSite({
  env = process.env,
  outputDirectory,
  configPath,
} = {}) {
  const config = await resolveConfig({ env, configPath });
  const configuredOutput = outputDirectory ?? env.QAAS_DOCS_OUTPUT_DIR ?? "dist";
  const resolvedOutput = path.resolve(projectDirectory, configuredOutput);
  const relativeOutput = path.relative(projectDirectory, resolvedOutput);

  if (
    relativeOutput === "" ||
    relativeOutput.startsWith("..") ||
    path.isAbsolute(relativeOutput)
  ) {
    throw new Error("Build output must stay inside docs-site/.");
  }

  const assetsDirectory = path.join(resolvedOutput, "assets");
  const catalogDirectory = path.join(resolvedOutput, "catalog");
  await mkdir(assetsDirectory, { recursive: true });
  await mkdir(catalogDirectory, { recursive: true });
  await Promise.all(
    obsoleteDemoAssets.map((relativePath) =>
      rm(path.join(resolvedOutput, relativePath), { force: true }),
    ),
  );

  const template = await readFile(templatePath, "utf8");
  await atomicWrite(
    path.join(resolvedOutput, "index.html"),
    renderTemplate(template, config),
  );

  for (const [source, destination] of sourceAssets) {
    const sourcePath = path.join(projectDirectory, source);
    const destinationPath = path.join(resolvedOutput, destination);
    await mkdir(path.dirname(destinationPath), { recursive: true });
    await copyFile(sourcePath, destinationPath);
  }

  const catalogPages = renderCatalog(config);
  for (const [fileName, contents] of catalogPages) {
    validateCatalogPage(fileName, contents);
    await atomicWrite(path.join(catalogDirectory, fileName), contents);
  }

  await atomicWrite(path.join(resolvedOutput, ".nojekyll"), "");

  for (const requiredPath of [
    path.join(resolvedOutput, "index.html"),
    path.join(assetsDirectory, "site.css"),
    path.join(assetsDirectory, "app.js"),
    path.join(assetsDirectory, "demo", "workflow-capture.png"),
    path.join(assetsDirectory, "demo", "evidence-capture.png"),
    path.join(catalogDirectory, "index.html"),
    path.join(catalogDirectory, "catalog.css"),
    path.join(resolvedOutput, ".nojekyll"),
  ]) {
    const result = await stat(requiredPath);
    if (!result.isFile()) {
      throw new Error(`Expected build output is not a file: ${requiredPath}`);
    }
  }

  return Object.freeze({ config, outputDirectory: resolvedOutput });
}

const invokedDirectly =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    const result = await buildSite();
    const relative = path.relative(projectDirectory, result.outputDirectory);
    console.log(
      `Built ${result.config.title} ${result.config.version} in ${relative || "."}`,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
