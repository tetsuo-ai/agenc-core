import { DEFAULT_TASK_TOKEN_BUDGET, TASK_BUDGET_LEVELS, isTaskBudgetLevel, taskBudgetLabel } from "../config/task-budget.js";
import { updateSettingsForSource } from "../utils/settings/settings.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { requireCommandConfigStore } from "./config-context.js";
import { safeExecute, type SlashCommand } from "./types.js";

export const budgetCommand: SlashCommand = {
  name: "budget",
  description: "Show or set the budget for new sessions",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => safeExecute(async () => {
    const active = ctx.session.config === undefined ? "unavailable" : taskBudgetLabel(ctx.session.config.taskTokenBudget ?? DEFAULT_TASK_TOKEN_BUDGET);
    const choice = ctx.argsRaw.trim();
    if (!choice) return { kind: "text", text: `Current session budget: ${active}.\nChoose /budget eco (1,000,000), balanced (2,400,000), or max (no token cap). Choices apply to new sessions; independent call and cost limits still apply.` };
    if (!isTaskBudgetLevel(choice)) return { kind: "error", message: "Usage: /budget [eco|balanced|max]" };
    const store = requireCommandConfigStore(ctx);
    const saved = await runWithCanonicalSettingsAuthority(store, () => updateSettingsForSource("userSettings", {
      budget_level: choice,
      task_token_budget: TASK_BUDGET_LEVELS[choice],
    }));
    if (saved.error) return { kind: "error", message: `Could not save budget: ${saved.error.message}` };
    return { kind: "text", text: `Saved budget: ${taskBudgetLabel(TASK_BUDGET_LEVELS[choice])} for new sessions. Current session keeps ${active}. Explicit CLI or project settings may override the saved choice.` };
  }),
};
