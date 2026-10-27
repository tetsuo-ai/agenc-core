import { sessionTaskTokenBudget, isTaskBudgetLevel, parseTaskTokenBudget, taskBudgetLabel } from "../config/task-budget.js";
import { updateSettingsForSource } from "../utils/settings/settings.js";
import { runWithCanonicalSettingsAuthority } from "../utils/settings/canonicalAuthority.js";
import { openBudgetMenu } from "./budget-menu.js";
import { replaceSessionTaskTokenBudgetSnapshot, setSessionTaskTokenBudget } from "../session/task-budget.js";
import { requireCommandConfigStore } from "./config-context.js";
import { safeExecute, type SlashCommand } from "./types.js";

export const budgetCommand: SlashCommand = {
  name: "budget",
  description: "Show or set the task budget",
  immediate: true,
  supportsNonInteractive: true,
  execute: async (ctx) => safeExecute(async () => {
    const active = ctx.session.config === undefined ? "unavailable" : taskBudgetLabel(sessionTaskTokenBudget(ctx.session.config));
    const choice = ctx.argsRaw.trim();
    if (!choice && openBudgetMenu(ctx, sessionTaskTokenBudget(ctx.session.config),
      level => budgetCommand.execute({ ...ctx, argsRaw: level }))) return { kind: "skip" };
    if (!choice) return { kind: "text", text: `Current session budget: ${active}.\nChoose /budget eco (1,000,000), balanced (2,400,000), max (no token cap), or a whole token number such as 3m or 500k. Choices apply to this session and new sessions; independent call and cost limits still apply.` };
    const requested = parseTaskTokenBudget(choice);
    if (requested === undefined) return { kind: "error", message: "Budget must be eco, balanced, max, or a whole token number such as 3000000, 3m, or 500k. Use 0 for no cap." };
    const level = isTaskBudgetLevel(choice) ? choice : undefined;
    const store = requireCommandConfigStore(ctx);
    const saved = await runWithCanonicalSettingsAuthority(store, () => updateSettingsForSource("userSettings", {
      budget_level: level,
      task_token_budget: requested,
    }));
    if (saved.error) return { kind: "error", message: `Could not save budget: ${saved.error.message}` };
    const bridge = ctx.session as unknown as { applyDaemonConfig?: (params: { taskBudgetLevel?: "eco" | "balanced" | "max"; taskTokenBudget?: number; reload: boolean }) => Promise<{ taskTokenBudget?: number; summary: string }> };
    const applied = bridge.applyDaemonConfig !== undefined
      ? await bridge.applyDaemonConfig({ ...(level !== undefined ? { taskBudgetLevel: level } : { taskTokenBudget: requested }), reload: true })
      : undefined;
    const effective = applied?.taskTokenBudget ?? (store.current?.().task_token_budget ?? requested);
    if (applied === undefined) setSessionTaskTokenBudget(ctx.session, effective);
    else replaceSessionTaskTokenBudgetSnapshot(ctx.session, effective);
    const override = effective !== requested ? " Explicit CLI, project, or independent admission limits override the saved choice." : "";
    return { kind: "text", text: `Current session budget: ${taskBudgetLabel(effective)}. Saved ${taskBudgetLabel(requested)} for new sessions.${override} Independent call and cost limits still apply.` };
  }),
};
