import type { ModelVerbosity } from "./schema.js";
import type { TaskBudgetLevel } from "./task-budget.js";

// Release choices live here. Explicit configuration and CLI values take precedence.
export const DEFAULT_TASK_BUDGET_LEVEL: TaskBudgetLevel = "balanced";
export const DEFAULT_MODEL_VERBOSITY: ModelVerbosity | undefined = undefined;
