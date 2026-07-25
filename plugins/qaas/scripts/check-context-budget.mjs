import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDirectExecution, printJson } from "./lib/cli.mjs";

const PUBLIC_SKILLS = new Set([
  "onboard",
  "plan",
  "implement",
  "run",
  "diagnose",
  "doctor",
]);
const CLAUDE_LINE_LIMIT = 200;
const SHIPPED_CLAUDE_TOKEN_PROXY_LIMIT = 2_000;

function tokenProxy(text) {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

async function markdownFiles(root) {
  const results = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target);
      else if (entry.isFile() && entry.name.endsWith(".md")) results.push(target);
    }
  }
  await visit(root);
  return results;
}

function descriptionFromSkill(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
  if (!match) return "";
  const line = match[1]
    .split(/\r?\n/u)
    .find((entry) => entry.startsWith("description:"));
  return line ? line.slice("description:".length).trim() : "";
}

export async function checkContextBudget({
  scriptDirectory = path.dirname(fileURLToPath(import.meta.url)),
  projectRoot = process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
} = {}) {
  const pluginRoot = path.resolve(scriptDirectory, "..");
  const errors = [];
  const skillDirectory = path.join(pluginRoot, "skills");
  const skillCosts = {};
  const visibleDescriptionTokens = [];
  for (const entry of await readdir(skillDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const text = await readFile(
      path.join(skillDirectory, entry.name, "SKILL.md"),
      "utf8",
    );
    const cost = tokenProxy(text);
    skillCosts[entry.name] = cost;
    if ((PUBLIC_SKILLS.has(entry.name) || entry.name === "qaas-workflow") && cost > 1_500) {
      errors.push(`${entry.name}/SKILL.md exceeds the 1,500-token proxy budget (${cost})`);
    }
    visibleDescriptionTokens.push(tokenProxy(descriptionFromSkill(text)));
  }
  let projectClaudeTokens = 0;
  let projectClaudeLines = 0;
  try {
    const text = await readFile(
      path.join(path.resolve(projectRoot), ".claude", "CLAUDE.md"),
      "utf8",
    );
    projectClaudeTokens = tokenProxy(text);
    projectClaudeLines = text.replaceAll("\r\n", "\n").split("\n").length;
    if (projectClaudeLines > CLAUDE_LINE_LIMIT) {
      errors.push(
        `project .claude/CLAUDE.md exceeds ${CLAUDE_LINE_LIMIT} lines (${projectClaudeLines})`,
      );
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  const shippedClaudePath = path.join(
    pluginRoot,
    "templates",
    "project-context",
    ".claude",
    "CLAUDE.md",
  );
  const shippedClaudeText = await readFile(shippedClaudePath, "utf8");
  const shippedClaudeTokens = tokenProxy(shippedClaudeText);
  const shippedClaudeLines = shippedClaudeText
    .replaceAll("\r\n", "\n")
    .split("\n").length;
  if (shippedClaudeLines > CLAUDE_LINE_LIMIT) {
    errors.push(
      `shipped template .claude/CLAUDE.md exceeds ${CLAUDE_LINE_LIMIT} lines (${shippedClaudeLines})`,
    );
  }
  if (shippedClaudeTokens > SHIPPED_CLAUDE_TOKEN_PROXY_LIMIT) {
    errors.push(
      "shipped template .claude/CLAUDE.md exceeds the " +
        `${SHIPPED_CLAUDE_TOKEN_PROXY_LIMIT}-token proxy budget ` +
        `(${shippedClaudeTokens})`,
    );
  }
  const referenceFiles = await markdownFiles(path.join(pluginRoot, "references"));
  const referenceCosts = await Promise.all(
    referenceFiles.map(async (file) => tokenProxy(await readFile(file, "utf8"))),
  );
  const maxReference = Math.max(0, ...referenceCosts);
  const maxSpecialist = Math.max(
    0,
    ...Object.entries(skillCosts)
      .filter(([name]) => !PUBLIC_SKILLS.has(name) && name !== "qaas-workflow")
      .map(([, value]) => value),
  );
  const aggregateProxy =
    visibleDescriptionTokens.reduce((sum, value) => sum + value, 0) +
    (skillCosts["qaas-workflow"] ?? 0) +
    Math.max(...[...PUBLIC_SKILLS].map((name) => skillCosts[name] ?? 0)) +
    maxSpecialist +
    maxReference +
    shippedClaudeTokens +
    projectClaudeTokens +
    600 +
    2_000 +
    2_000;
  if (aggregateProxy > 32_000) {
    errors.push(`aggregate weak-model context proxy exceeds 32,000 tokens (${aggregateProxy})`);
  }
  return {
    valid: errors.length === 0,
    errors,
    budgets: {
      skillTokenProxyLimit: 1_500,
      projectClaudeLineLimit: CLAUDE_LINE_LIMIT,
      shippedClaudeLineLimit: CLAUDE_LINE_LIMIT,
      shippedClaudeTokenProxyLimit: SHIPPED_CLAUDE_TOKEN_PROXY_LIMIT,
      sessionStartTokenLimit: 600,
      aggregateTokenProxyLimit: 32_000,
    },
    measured: {
      skillCosts,
      projectClaudeLines,
      projectClaudeTokens,
      shippedClaudeLines,
      shippedClaudeTokens,
      maxReference,
      aggregateProxy,
    },
    caveat:
      "Static UTF-8/4 proxy only; target MiniMax tokenizer measurement remains a deployment checklist item.",
  };
}

if (isDirectExecution(import.meta.url)) {
  const result = await checkContextBudget();
  printJson(result);
  process.exitCode = result.valid ? 0 : 1;
}
