import { isDirectExecution, runJsonValidator } from "./lib/cli.mjs";
import { validateMutationPlan } from "./lib/plan-validation.mjs";

export { validateMutationPlan };

if (isDirectExecution(import.meta.url)) {
  await runJsonValidator("mutation-plan", validateMutationPlan);
}

