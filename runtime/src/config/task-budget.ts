/** Default run allocation; explicit zero disables it in every runtime mode. */
export const DEFAULT_TASK_TOKEN_BUDGET = 219_000;

/** Named allocations. Keep numeric values centralized for measured tuning. */
export const TASK_BUDGET_LEVELS = Object.freeze({ eco: 1_000_000, balanced: 2_400_000, max: 0 });
export type TaskBudgetLevel = keyof typeof TASK_BUDGET_LEVELS;
export function isTaskBudgetLevel(value: unknown): value is TaskBudgetLevel {
  return typeof value === "string" && Object.hasOwn(TASK_BUDGET_LEVELS, value);
}
export function taskBudgetLabel(tokens: number): string {
  const level = (Object.keys(TASK_BUDGET_LEVELS) as TaskBudgetLevel[])
    .find((name) => TASK_BUDGET_LEVELS[name] === tokens);
  return `${level ?? "custom"} (${tokens === 0 ? "no token cap" : `${tokens.toLocaleString("en-US")} tokens`})`;
}
