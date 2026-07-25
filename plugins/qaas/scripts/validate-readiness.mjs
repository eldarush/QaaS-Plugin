import { isDirectExecution, runJsonValidator } from "./lib/cli.mjs";
import { validateReadiness } from "./lib/validation.mjs";

export { validateReadiness };

if (isDirectExecution(import.meta.url)) {
  await runJsonValidator("readiness", validateReadiness);
}

