import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(async () => ({ error: null as Error | null })) }));
vi.mock("../../src/utils/settings/settings.js", () => ({ updateSettingsForSource: mocks.update }));
vi.mock("../../src/utils/settings/canonicalAuthority.js", () => ({ runWithCanonicalSettingsAuthority: (_: unknown, fn: () => unknown) => fn() }));
import { budgetCommand } from "../../src/commands/budget.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
const context = (argsRaw: string) => ({ argsRaw, configStore: {}, session: { config: { taskTokenBudget: 1_000_000 } } }) as SlashCommandContext;
beforeEach(() => mocks.update.mockClear());
it("shows the active level without a model call or settings mutation", async () => {
  expect(await budgetCommand.execute(context(""))).toMatchObject({ kind: "text", text: expect.stringContaining("eco (1,000,000 tokens)") });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("saves a level without resetting or raising the live task allocation", async () => {
  const ctx = context("max");
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("Current session keeps eco") });
  expect(mocks.update).toHaveBeenCalledWith("userSettings", { budget_level: "max", task_token_budget: 0 });
  expect(ctx.session.config.taskTokenBudget).toBe(1_000_000);
});
it("rejects invalid choices without saving", async () => {
  expect(await budgetCommand.execute(context("bad"))).toMatchObject({ kind: "error" });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("reports failed saves", async () => {
  mocks.update.mockResolvedValueOnce({ error: new Error("read-only") });
  expect(await budgetCommand.execute(context("balanced"))).toMatchObject({ kind: "error", message: expect.stringContaining("read-only") });
});
