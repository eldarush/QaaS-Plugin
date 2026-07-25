#!/usr/bin/env node

import process from "node:process";

import {
  inventoryProject,
  serializeProjectInventory,
} from "./lib/project-evidence-inventory.mjs";

const projectRoot = process.env.CLAUDE_PROJECT_DIR;
if (!projectRoot) {
  throw new Error("CLAUDE_PROJECT_DIR is required.");
}
if (process.argv.length !== 2) {
  throw new Error("project-inventory.mjs accepts no arguments.");
}

const inventory = await inventoryProject(projectRoot);
process.stdout.write(serializeProjectInventory(inventory));
