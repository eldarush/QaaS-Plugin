import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  canonicalDigest,
  sha256,
} from "../scripts/lib/canonical-json.mjs";
import {
  validateExecutionPlan,
  validateTaskPlan,
} from "../scripts/lib/plan-validation.mjs";
import {
  querySpecDigest,
  validateQueryPlan,
} from "../scripts/lib/query-validation.mjs";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const referencePath = path.join(
  pluginRoot,
  "references",
  "workflow",
  "artifact-scaffolds.md",
);

function extractJson(text, label) {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = text.match(
    new RegExp(
      `<!-- artifact-example:${escaped} -->\\s*\`\`\`json\\s*([\\s\\S]*?)\\s*\`\`\``,
      "u",
    ),
  );
  assert.ok(match, `missing ${label} scaffold`);
  return JSON.parse(match[1]);
}

test("lifecycle artifact scaffolds stay aligned with runtime validators", async () => {
  const text = await readFile(referencePath, "utf8");

  const fact = extractJson(text, "readiness-fact");
  assert.deepEqual(Object.keys(fact), [
    "schemaVersion",
    "domain",
    "status",
    "summary",
  ]);
  assert.equal(fact.schemaVersion, "1.0");
  assert.equal(fact.status, "user_confirmed");

  const progress = extractJson(text, "progress");
  assert.deepEqual(Object.keys(progress).sort(), [
    "blocker",
    "completedWork",
    "evidencePaths",
    "nextLegalAction",
    "remainingWork",
  ]);

  const plan = extractJson(text, "plan");
  plan.digest = canonicalDigest(plan);
  const planValidation = validateTaskPlan(plan);
  assert.equal(
    planValidation.valid,
    true,
    planValidation.errors.map((entry) => `${entry.path}: ${entry.message}`).join("; "),
  );

  const execution = extractJson(text, "execution");
  execution.digest = canonicalDigest(execution);
  const executionValidation = validateExecutionPlan(execution);
  assert.equal(
    executionValidation.valid,
    true,
    executionValidation.errors
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join("; "),
  );

  const queryPlan = extractJson(text, "query");
  const [query] = queryPlan.queries;
  assert.equal(query.toolInputDigest, sha256(query.toolInput));
  assert.equal(query.queryDigest, querySpecDigest(query));
  queryPlan.digest = canonicalDigest(queryPlan);
  const queryValidation = validateQueryPlan(queryPlan);
  assert.equal(
    queryValidation.valid,
    true,
    queryValidation.errors
      .map((entry) => `${entry.path}: ${entry.message}`)
      .join("; "),
  );
});

test("planning, context, and query references link the one-hop scaffolds", async () => {
  const relatives = [
    "references/workflow/readiness-and-approvals.md",
    "references/workflow/project-context.md",
    "references/workflow/query-plan.md",
  ];
  for (const relative of relatives) {
    const text = await readFile(path.join(pluginRoot, relative), "utf8");
    assert.match(text, /\(artifact-scaffolds\.md(?:#[^)]+)?\)/u, relative);
  }
});

test("progress scaffold names every field accepted by the checkpoint runtime", async () => {
  const [reference, authority] = await Promise.all([
    readFile(referencePath, "utf8"),
    readFile(path.join(pluginRoot, "scripts", "workflow-authority.mjs"), "utf8"),
  ]);
  const progress = extractJson(reference, "progress");
  const checkpointBody = authority.match(
    /async function checkpointProgress[\s\S]*?\n\}\n\nexport async function runtimeContext/u,
  )?.[0];
  assert.ok(checkpointBody, "checkpointProgress implementation is missing");
  for (const field of Object.keys(progress)) {
    assert.match(
      checkpointBody,
      new RegExp(`"${field}"`, "u"),
      `checkpoint runtime does not accept ${field}`,
    );
  }
  assert.doesNotMatch(
    checkpointBody,
    /"awaitingUser"/u,
    "model checkpoint runtime must not accept the hook-owned waiting flag",
  );
});
