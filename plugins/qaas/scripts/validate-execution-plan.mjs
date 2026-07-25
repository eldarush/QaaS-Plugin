import { isDirectExecution, runJsonValidator } from "./lib/cli.mjs";
import { validateExecutionPlan } from "./lib/plan-validation.mjs";

export { validateExecutionPlan };

if (isDirectExecution(import.meta.url)) {
  await runJsonValidator("execution-plan", validateExecutionPlan);
}

