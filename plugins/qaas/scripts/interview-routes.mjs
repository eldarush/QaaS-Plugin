#!/usr/bin/env node

import process from "node:process";

import {
  DIRECT_USER_INTENTS,
  selectInterviewRoutes,
} from "./lib/interview-route-selector.mjs";
import { inventoryProject } from "./lib/project-evidence-inventory.mjs";
import { isDirectExecution } from "./lib/cli.mjs";

const MAX_OUTPUT_BYTES = 24 * 1024;
const MAX_DIRECT_INTENTS = 3;
const DIRECT_INTENT_SET = new Set(DIRECT_USER_INTENTS);
const INVENTORY_ARGUMENTS = Object.freeze(["--mode", "inventory"]);
const INVENTORY_AND_INTENTS_PREFIX = Object.freeze([
  "--mode",
  "inventory-and-user-intents",
]);

function exactArguments(actual, expected) {
  return (
    actual.length === expected.length &&
    actual.every((value, index) => value === expected[index])
  );
}

export function parseInterviewRouteArguments(argv) {
  if (exactArguments(argv, INVENTORY_ARGUMENTS)) {
    return Object.freeze({ mode: "inventory", intents: Object.freeze([]) });
  }
  if (
    argv.length >= 4 &&
    argv.length <= 2 + MAX_DIRECT_INTENTS * 2 &&
    argv.length % 2 === 0 &&
    argv.slice(0, 2).every(
      (value, index) => value === INVENTORY_AND_INTENTS_PREFIX[index],
    )
  ) {
    const intents = [];
    for (let index = 2; index < argv.length; index += 2) {
      if (argv[index] !== "--intent" || !DIRECT_INTENT_SET.has(argv[index + 1])) {
        throw new Error("interview-routes.mjs received an unknown intent or flag.");
      }
      intents.push(argv[index + 1]);
    }
    if (new Set(intents).size !== intents.length) {
      throw new Error("interview-routes.mjs intent IDs must be unique.");
    }
    return Object.freeze({
      mode: "inventory-and-user-intents",
      intents: Object.freeze(intents),
    });
  }
  throw new Error(
    "interview-routes.mjs accepts exactly '--mode inventory' or " +
      "'--mode inventory-and-user-intents' followed by 1 through 3 " +
      "unique '--intent <documented-route-id>' pairs.",
  );
}

function withoutEvidencePaths(result) {
  return {
    ...result,
    reportingTruncated: true,
    routes: result.routes.map((route) => ({
      ...route,
      provenance: route.provenance.map(
        ({ evidencePaths: _evidencePaths, ...provenance }) => provenance,
      ),
    })),
  };
}

export function serializeInterviewRoutes(result) {
  const complete = {
    ...result,
    reportingTruncated: false,
  };
  let output = `${JSON.stringify(complete, null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") <= MAX_OUTPUT_BYTES) {
    return output;
  }

  output = `${JSON.stringify(withoutEvidencePaths(result), null, 2)}\n`;
  if (Buffer.byteLength(output, "utf8") > MAX_OUTPUT_BYTES) {
    throw new Error("bounded interview routing output exceeds 24 KiB");
  }
  return output;
}

export async function runInterviewRoutes({
  argv = process.argv.slice(2),
  env = process.env,
} = {}) {
  const projectRoot = env.CLAUDE_PROJECT_DIR;
  if (!projectRoot) {
    throw new Error("CLAUDE_PROJECT_DIR is required.");
  }

  const options = parseInterviewRouteArguments(argv);
  const inventory = await inventoryProject(projectRoot);
  const sources = [
    {
      kind: "bounded-tentative-inventory",
      inventory,
    },
  ];
  if (options.intents.length > 0) {
    sources.push({
      kind: "direct-user-intent",
      intents: options.intents,
    });
  }

  return serializeInterviewRoutes(selectInterviewRoutes(sources));
}

if (isDirectExecution(import.meta.url)) {
  process.stdout.write(await runInterviewRoutes());
}
