import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);
const pluginRoot = path.join(repositoryRoot, "plugins", "qaas");

async function text(relativePath) {
  return readFile(path.join(repositoryRoot, relativePath), "utf8");
}

test("workflow routing is trigger-rich, centralized, and bounded", async () => {
  const workflow = await text("plugins/qaas/skills/qaas-workflow/SKILL.md");
  assert.match(workflow, /every natural-language or command-driven QaaS/iu);
  assert.match(workflow, /create, modify, fix, upgrade, run, diagnose/iu);
  assert.match(workflow, /Route commands and natural language through the same phase gates/iu);
  assert.match(workflow, /one question\/turn/iu);
  assert.match(workflow, /Stop[\s\S]*owns\s+`awaitingUser`/iu);
  assert.match(workflow, /checkpoints cannot set it/iu);
  assert.match(workflow, /safe signed next action/iu);
  assert.ok(Buffer.byteLength(workflow, "utf8") <= 1_500 * 4);

  const skillEntries = await readdir(path.join(pluginRoot, "skills"), {
    withFileTypes: true,
  });
  for (const entry of skillEntries) {
    if (!entry.isDirectory()) continue;
    if (
      ["qaas-workflow", "onboard", "plan", "implement", "run", "diagnose", "doctor"]
        .includes(entry.name)
    ) {
      continue;
    }
    const content = await readFile(
      path.join(pluginRoot, "skills", entry.name, "SKILL.md"),
      "utf8",
    );
    assert.match(content, /Internal/iu, entry.name);
    assert.match(content, /qaas-workflow delegates/iu, entry.name);
  }
});

test("specialist agents share one bounded return envelope", async () => {
  const entries = await readdir(path.join(pluginRoot, "agents"), {
    withFileTypes: true,
  });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const content = await readFile(
      path.join(pluginRoot, "agents", entry.name),
      "utf8",
    );
    assert.match(content, /`status`/u, entry.name);
    assert.match(content, /`OK`/u, entry.name);
    assert.match(content, /`BLOCKED`/u, entry.name);
    assert.match(content, /`CONFLICT`/u, entry.name);
    assert.match(content, /`facts`/u, entry.name);
    assert.match(content, /`unknowns`/u, entry.name);
    assert.match(content, /`nextAction`/u, entry.name);
    assert.match(content, /500 words/iu, entry.name);
  }
});

test("operator guidance uses one-hop progressive disclosure", async () => {
  const index = await text(
    "plugins/qaas/references/workflow/operator-protocol.md",
  );
  const links = [...index.matchAll(/\]\(operator\/([^)#]+\.md)(?:#[^)]+)?\)/gu)]
    .map((match) => match[1]);
  assert.equal(new Set(links).size, 10);
  assert.ok(index.split(/\r?\n/u).length <= 40);

  for (const relative of new Set(links)) {
    const content = await text(
      `plugins/qaas/references/workflow/operator/${relative}`,
    );
    assert.ok(content.split(/\r?\n/u).length <= 120, relative);
  }

  const constrained = await text(
    "plugins/qaas/references/workflow/constrained-model-operation.md",
  );
  assert.doesNotMatch(constrained, /\bUnload prior-phase detail\b/u);
  assert.match(constrained, /stop carrying or rereading\s+prior-phase detail/iu);
  assert.match(constrained, /Never truncate, paraphrase, or split one schema document/iu);
});

test("timing evidence is staged instead of circular", async () => {
  const sources = await Promise.all(
    [
      "plugins/qaas/agents/configuration-tracer.md",
      "plugins/qaas/agents/test-planner.md",
      "plugins/qaas/references/test-authoring/authoring-checklist.md",
      "plugins/qaas/references/workflow/readiness-and-approvals.md",
      "plugins/qaas/skills/verify-qaas-work/SKILL.md",
    ].map(text),
  );
  for (const source of sources) {
    assert.match(source, /docs/iu);
    assert.match(source, /user/iu);
    assert.match(source, /implementation/iu);
    assert.match(source, /template[-\s]+render/iu);
    assert.match(source, /runtime\s+evidence/iu);
    assert.match(source, /observed(?:\s+timing)?\s+behavior/iu);
  }
});

test("README front-loads installation and lifecycle navigation", async () => {
  const readme = await text("README.md");
  assert.match(readme, /## Start in 60 seconds/u);
  assert.match(readme, /## Contents/u);
  assert.match(readme, /\/qaas:doctor/u);
  assert.match(readme, /\/qaas:onboard/u);
  assert.match(readme, /\/effort xhigh/u);
  assert.match(readme, /\*\*use dynamic workflow\*\*/u);
});
