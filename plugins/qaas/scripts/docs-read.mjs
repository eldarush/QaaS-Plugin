import { isDirectExecution, parseNamedArguments, printJson } from "./lib/cli.mjs";
import {
  resolveDocumentationQuery,
  resolveDocumentationSources,
} from "./lib/docs-resolver.mjs";
import {
  activeSession,
  runtimeContext,
} from "./workflow-authority.mjs";
import { createStreamableMcpCaller } from "./lib/streamable-mcp-client.mjs";

export async function runDocsRead(argv = process.argv.slice(2), env = process.env) {
  const args = parseNamedArguments(argv);
  if (typeof args.query !== "string") throw new Error("--query is required");
  const outputLimitBytes =
    args["output-limit-bytes"] === undefined
      ? 32 * 1024
      : Number(args["output-limit-bytes"]);
  const timeoutMs =
    args["timeout-ms"] === undefined ? 10_000 : Number(args["timeout-ms"]);
  let capabilityRegistry = null;
  let approvedTransport = null;
  if (typeof args["session-handle"] === "string") {
    const context = await runtimeContext(env);
    await activeSession(context, args["session-handle"]);
    capabilityRegistry = (
      await context.authority.readSigned("integrations/capabilities.json", {
        required: false,
      })
    )?.payload ?? null;
    approvedTransport = (
      await context.authority.readSigned(
        "integrations/docs-mcp-transport.json",
        { required: false },
      )
    )?.payload ?? null;
  }
  const sources = resolveDocumentationSources({ env, capabilityRegistry });
  return resolveDocumentationQuery({
    query: args.query,
    sources,
    relativeUrl:
      typeof args["relative-url"] === "string" ? args["relative-url"] : null,
    callMcp: sources.mcp
      ? createStreamableMcpCaller({
          env,
          timeoutMs,
          approvedTransport,
        })
      : null,
    outputLimitBytes,
    timeoutMs,
  });
}

if (isDirectExecution(import.meta.url)) {
  try {
    printJson(await runDocsRead());
  } catch (error) {
    printJson({ ok: false, error: error.message });
    process.exitCode = 1;
  }
}
