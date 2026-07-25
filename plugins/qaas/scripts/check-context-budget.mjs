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
const AGENT_PROMPT_TOKEN_PROXY_LIMIT = 1_200;
const AGENT_RESPONSE_WORD_LIMIT = 500;
const PROJECT_TOPIC_TOKEN_PROXY_LIMIT = 8_000;
const RETRIEVED_EXCERPT_TOKEN_RESERVE = 8_192;
const AGENT_RESPONSE_TOKEN_RESERVE = 1_000;
const LOCAL_ENCODER_TOOL_TOKEN_RESERVE = 256;
const CONSTRAINED_REFERENCE =
  "workflow/constrained-model-operation.md";
const OPERATOR_REFERENCE = "workflow/operator-protocol.md";

const PHASE_ROUTES = Object.freeze({
  doctor: {
    wrapper: "doctor",
    specialists: [],
    agents: [],
    optionalReferences: [],
  },
  onboard: {
    wrapper: "onboard",
    specialists: ["map-qaas-project", "query-qaas-docs"],
    agents: ["project-mapper", "configuration-tracer"],
    optionalReferences: [
      "workflow/project-context.md",
      "project-mapping/project-model.md",
      "evidence/documentation-provenance.md",
    ],
  },
  plan: {
    wrapper: "plan",
    specialists: [
      "query-qaas-docs",
      "resolve-qaas-module",
      "work-with-qaas-samples",
      "upgrade-qaas-project",
    ],
    agents: ["test-planner", "docs-researcher"],
    optionalReferences: [
      "workflow/readiness-and-approvals.md",
      "test-authoring/authoring-checklist.md",
      "samples/sample-contract.md",
      "project-mapping/module-resolution.md",
      "upgrades/version-proof.md",
    ],
  },
  implement: {
    wrapper: "implement",
    specialists: [
      "author-qaas-csharp",
      "author-qaas-hook",
      "author-qaas-yaml",
      "minimal-change",
    ],
    agents: ["test-implementer", "minimalist-reviewer"],
    optionalReferences: [
      "test-authoring/authoring-checklist.md",
      "hooks/type-a-boundary.md",
      "evidence/evidence-contract.md",
    ],
  },
  run: {
    wrapper: "run",
    specialists: ["verify-qaas-work"],
    agents: ["verifier"],
    optionalReferences: [
      "evidence/evidence-contract.md",
      "workflow/query-plan.md",
    ],
  },
  diagnose: {
    wrapper: "diagnose",
    specialists: ["verify-qaas-work", "minimal-change"],
    agents: ["diagnostician", "test-implementer"],
    optionalReferences: [
      "evidence/evidence-contract.md",
      "test-authoring/authoring-checklist.md",
    ],
  },
});

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

async function projectTopicCosts(projectRoot, errors) {
  const indexPath = path.join(
    path.resolve(projectRoot),
    ".claude",
    "qaas",
    "context-index.json",
  );
  let index;
  try {
    index = JSON.parse(await readFile(indexPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    errors.push(`project context index is unreadable: ${error.message}`);
    return {};
  }
  const costs = {};
  for (const topic of index?.topics ?? []) {
    if (typeof topic?.path !== "string") continue;
    const target = path.resolve(
      path.dirname(path.dirname(indexPath)),
      ...topic.path.replaceAll("\\", "/").split("/"),
    );
    const relative = path.relative(path.dirname(indexPath), target);
    if (
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !topic.path.toLowerCase().endsWith(".md")
    ) {
      errors.push(`project context topic escapes its index: ${topic.path}`);
      continue;
    }
    try {
      const cost = tokenProxy(await readFile(target, "utf8"));
      costs[topic.path] = cost;
      if (cost > PROJECT_TOPIC_TOKEN_PROXY_LIMIT) {
        errors.push(
          `project topic ${topic.path} exceeds the ` +
            `${PROJECT_TOPIC_TOKEN_PROXY_LIMIT}-token proxy budget (${cost})`,
        );
      }
    } catch (error) {
      errors.push(`project context topic ${topic.path} is unreadable: ${error.message}`);
    }
  }
  return costs;
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
  const agentCosts = {};
  const agentDirectory = path.join(pluginRoot, "agents");
  for (const entry of await readdir(agentDirectory, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const text = await readFile(path.join(agentDirectory, entry.name), "utf8");
    const name = entry.name.slice(0, -3);
    const cost = tokenProxy(text);
    agentCosts[name] = cost;
    if (cost > AGENT_PROMPT_TOKEN_PROXY_LIMIT) {
      errors.push(
        `agent ${entry.name} exceeds the ` +
          `${AGENT_PROMPT_TOKEN_PROXY_LIMIT}-token proxy budget (${cost})`,
      );
    }
    if (!new RegExp(`\\b${AGENT_RESPONSE_WORD_LIMIT} words\\b`, "u").test(text)) {
      errors.push(
        `agent ${entry.name} must cap its response at ${AGENT_RESPONSE_WORD_LIMIT} words`,
      );
    }
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
  const referenceCosts = Object.fromEntries(
    await Promise.all(
      referenceFiles.map(async (file) => [
        path
          .relative(path.join(pluginRoot, "references"), file)
          .replaceAll("\\", "/"),
        tokenProxy(await readFile(file, "utf8")),
      ]),
    ),
  );
  const maxReference = Math.max(0, ...Object.values(referenceCosts));
  const maxSpecialist = Math.max(
    0,
    ...Object.entries(skillCosts)
      .filter(([name]) => !PUBLIC_SKILLS.has(name) && name !== "qaas-workflow")
      .map(([, value]) => value),
  );
  const topicCosts = await projectTopicCosts(projectRoot, errors);
  const maxProjectTopic = Math.max(0, ...Object.values(topicCosts));
  const fixedVisibleCost = visibleDescriptionTokens.reduce(
    (sum, value) => sum + value,
    0,
  );
  const phaseCosts = Object.fromEntries(
    Object.entries(PHASE_ROUTES).map(([phase, route]) => {
      const optionalReference = Math.max(
        0,
        ...route.optionalReferences.map((name) => referenceCosts[name] ?? 0),
      );
      const specialist = Math.max(
        0,
        ...route.specialists.map((name) => skillCosts[name] ?? 0),
      );
      const agent = Math.max(
        0,
        ...route.agents.map((name) => agentCosts[name] ?? 0),
      );
      return [
        phase,
        fixedVisibleCost +
          (skillCosts["qaas-workflow"] ?? 0) +
          (skillCosts[route.wrapper] ?? 0) +
          (referenceCosts[CONSTRAINED_REFERENCE] ?? 0) +
          (referenceCosts[OPERATOR_REFERENCE] ?? 0) +
          optionalReference +
          specialist +
          agent +
          Math.max(shippedClaudeTokens, projectClaudeTokens) +
          maxProjectTopic +
          600 +
          2_000 +
          RETRIEVED_EXCERPT_TOKEN_RESERVE +
          AGENT_RESPONSE_TOKEN_RESERVE +
          LOCAL_ENCODER_TOOL_TOKEN_RESERVE,
      ];
    }),
  );
  const aggregateProxy = Math.max(0, ...Object.values(phaseCosts));
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
      agentPromptTokenProxyLimit: AGENT_PROMPT_TOKEN_PROXY_LIMIT,
      agentResponseWordLimit: AGENT_RESPONSE_WORD_LIMIT,
      projectTopicTokenProxyLimit: PROJECT_TOPIC_TOKEN_PROXY_LIMIT,
      localEncoderToolTokenReserve: LOCAL_ENCODER_TOOL_TOKEN_RESERVE,
      sessionStartTokenLimit: 600,
      aggregateTokenProxyLimit: 32_000,
    },
    measured: {
      skillCosts,
      agentCosts,
      projectClaudeLines,
      projectClaudeTokens,
      shippedClaudeLines,
      shippedClaudeTokens,
      topicCosts,
      maxProjectTopic,
      maxReference,
      phaseCosts,
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
