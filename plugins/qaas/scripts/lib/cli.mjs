import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function isDirectExecution(importMetaUrl) {
  if (!process.argv[1]) return false;
  return path.resolve(process.argv[1]) === fileURLToPath(importMetaUrl);
}

export async function readStdin(limitBytes = 2 * 1024 * 1024) {
  const chunks = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    total += chunk.length;
    if (total > limitBytes) throw new Error("stdin exceeds the input size limit");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function readJsonInput(filePath = null, limitBytes) {
  const text = filePath
    ? await readFile(path.resolve(filePath), "utf8")
    : await readStdin(limitBytes);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON input: ${error.message}`, { cause: error });
  }
}

export function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function parseNamedArguments(argv = process.argv.slice(2)) {
  const values = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith("--")) {
      values._.push(token);
      continue;
    }
    const equals = token.indexOf("=");
    if (equals > 2) {
      values[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const name = token.slice(2);
    if (argv[index + 1] && !argv[index + 1].startsWith("--")) {
      values[name] = argv[index + 1];
      index += 1;
    } else {
      values[name] = true;
    }
  }
  return values;
}

export async function runJsonValidator(kind, validator) {
  try {
    const args = parseNamedArguments();
    const document = await readJsonInput(args._[0] ?? null);
    const result = validator(document);
    printJson({ kind, ...result });
    process.exitCode = result.valid ? 0 : 1;
  } catch (error) {
    printJson({
      kind,
      valid: false,
      errors: [{ path: "$", message: error.message, keyword: "input" }],
    });
    process.exitCode = 1;
  }
}

