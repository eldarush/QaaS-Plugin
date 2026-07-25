import { isDirectExecution, runJsonValidator } from "./lib/cli.mjs";
import { validateTaskPlan } from "./lib/plan-validation.mjs";

export { validateTaskPlan };

if (isDirectExecution(import.meta.url)) {
  await runJsonValidator("task-plan", validateTaskPlan);
}

