import { DEFAULT_TASK_BUDGET_LEVEL } from "./runtime-defaults.js";

/** Named allocations. Keep numeric values centralized for measured tuning. */
export const TASK_BUDGET_LEVELS = Object.freeze({ eco: 1_000_000, balanced: 2_400_000, max: 0 });
export type TaskBudgetLevel = keyof typeof TASK_BUDGET_LEVELS;
/** Default run allocation; explicit zero disables it in every runtime mode. */
export const DEFAULT_TASK_TOKEN_BUDGET = TASK_BUDGET_LEVELS[DEFAULT_TASK_BUDGET_LEVEL];
/** Cold TUI shims expose canonical settings; live sessions expose runtime config. */
export function sessionTaskTokenBudget(config?: {
  readonly taskTokenBudget?: number;
  readonly task_token_budget?: number;
}): number {
  return config?.taskTokenBudget ?? config?.task_token_budget ?? DEFAULT_TASK_TOKEN_BUDGET;
}
export function isTaskBudgetLevel(value: unknown): value is TaskBudgetLevel {
  return typeof value === "string" && Object.hasOwn(TASK_BUDGET_LEVELS, value);
}
export function taskBudgetLabel(tokens: number): string {
  const level = (Object.keys(TASK_BUDGET_LEVELS) as TaskBudgetLevel[])
    .find((name) => TASK_BUDGET_LEVELS[name] === tokens);
  return `${level ?? "custom"} (${tokens === 0 ? "no token cap" : `${tokens.toLocaleString("en-US")} tokens`})`;
}

/** Whole token counts, with optional thousand/million suffixes. Zero removes the cap. */
export function parseTaskTokenBudget(value: string): number | undefined {
  const choice = value.trim();
  if (isTaskBudgetLevel(choice)) return TASK_BUDGET_LEVELS[choice];
  const match = /^(\d+)([km])?$/iu.exec(choice);
  if (!match) return undefined;
  const multiplier = match[2]?.toLowerCase() === "m" ? 1_000_000 : match[2]?.toLowerCase() === "k" ? 1_000 : 1;
  const tokens = Number(match[1]) * multiplier;
  return Number.isSafeInteger(tokens) && tokens >= 0 ? tokens : undefined;
}
