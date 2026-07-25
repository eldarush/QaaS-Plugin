import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const pluginRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const scriptsRoot = path.join(pluginRoot, "scripts");
const NETWORK_ADAPTERS = new Set([
  "lib/docs-resolver.mjs",
  "lib/query-read-adapter.mjs",
  "lib/source-read-adapter.mjs",
  "lib/streamable-mcp-client.mjs",
]);

async function filesUnder(root, relative = "") {
  const entries = await readdir(path.join(root, relative), {
    withFileTypes: true,
  });
  const result = [];
  for (const entry of entries) {
    const child = relative
      ? path.posix.join(relative, entry.name)
      : entry.name;
    if (entry.isDirectory()) {
      result.push(...(await filesUnder(root, child)));
    } else if (entry.isFile() && entry.name.endsWith(".mjs")) {
      result.push(child);
    }
  }
  return result;
}

test("runtime network code is isolated to explicit bounded read adapters", async () => {
  const networkBearing = [];
  for (const relative of await filesUnder(scriptsRoot)) {
    const content = await readFile(
      path.join(scriptsRoot, ...relative.split("/")),
      "utf8",
    );
    if (
      /\bfetch(?:Impl)?\s*\(/u.test(content) ||
      /from\s+["']node:(?:http|https|net|tls|dgram|dns)["']/u.test(content)
    ) {
      networkBearing.push(relative);
    }
  }
  assert.deepEqual(networkBearing.sort(), [...NETWORK_ADAPTERS].sort());

  for (const relative of [
    "doctor.mjs",
    "hook-launcher.mjs",
    "pretool-safety.mjs",
    "posttool-ledger.mjs",
    "session-state.mjs",
  ]) {
    const content = await readFile(path.join(scriptsRoot, relative), "utf8");
    assert.doesNotMatch(
      content,
      /\bfetch\s*\(|node:(?:http|https|net|tls|dgram|dns)/u,
    );
  }
});
