import { beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ update: vi.fn(async () => ({ error: null as Error | null })) }));
vi.mock("../../src/utils/settings/settings.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/utils/settings/settings.js")>(), updateSettingsForSource: mocks.update }));
vi.mock("../../src/utils/settings/canonicalAuthority.js", async importOriginal => ({ ...await importOriginal<typeof import("../../src/utils/settings/canonicalAuthority.js")>(), runWithCanonicalSettingsAuthority: (_: unknown, fn: () => unknown) => fn() }));
import { budgetCommand } from "../../src/commands/budget.js";
import type { SlashCommandContext } from "../../src/commands/types.js";
const context = (argsRaw: string) => ({ argsRaw, configStore: {}, session: { config: { taskTokenBudget: 1_000_000 } } }) as SlashCommandContext;
beforeEach(() => mocks.update.mockClear());
it("shows the active level without a model call or settings mutation", async () => {
  expect(await budgetCommand.execute(context(""))).toMatchObject({ kind: "text", text: expect.stringContaining("eco (1,000,000 tokens)") });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("reads the saved cap from a cold canonical config before the runtime exists", async () => {
  const ctx = context("");
  Object.assign(ctx.session, { config: Object.freeze({ task_token_budget: 0, budget_level: "max" }) });
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("max (no token cap)") });
  const setToolJSX = vi.fn();
  Object.assign(ctx, { appState: { setToolJSX } });
  expect(await budgetCommand.execute(ctx)).toEqual({ kind: "skip" });
  expect(setToolJSX.mock.calls[0]![0].jsx.props.current).toBe(0);
  expect(mocks.update).not.toHaveBeenCalled();
});
it("saves and applies a level to the current session", async () => {
  const ctx = context("max");
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("Current session budget: max") });
  expect(mocks.update).toHaveBeenCalledWith("userSettings", { budget_level: "max", task_token_budget: 0 });
  expect(ctx.session.config.taskTokenBudget).toBe(0);
});
it("rejects invalid choices without saving", async () => {
  expect(await budgetCommand.execute(context("bad"))).toMatchObject({ kind: "error" });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("reports an unavailable live allocation when the session has no config", async () => {
  const ctx = { argsRaw: "", configStore: {}, session: {} } as SlashCommandContext;
  expect(await budgetCommand.execute(ctx)).toMatchObject({
    kind: "text",
    text: expect.stringContaining("Current session budget: unavailable"),
  });
  expect(mocks.update).not.toHaveBeenCalled();
});
it("reports failed saves", async () => {
  mocks.update.mockResolvedValueOnce({ error: new Error("read-only") });
  expect(await budgetCommand.execute(context("balanced"))).toMatchObject({ kind: "error", message: expect.stringContaining("read-only") });
});

it("opens a current-session picker without saving until a choice is applied", async () => {
  const ctx = context("");
  const setToolJSX = vi.fn();
  Object.assign(ctx, { appState: { setToolJSX } });
  expect(await budgetCommand.execute(ctx)).toEqual({ kind: "skip" });
  expect(mocks.update).not.toHaveBeenCalled();
  const menu = setToolJSX.mock.calls[0]![0].jsx;
  expect(menu.props.current).toBe(1_000_000);
  await menu.props.apply("max");
  expect(ctx.session.config.taskTokenBudget).toBe(0);
});
it("applies through the live daemon and reports an explicit override", async () => {
  const ctx = context("max");
  const applyDaemonConfig = vi.fn(async () => ({ taskTokenBudget: 123, summary: "explicit project allowance" }));
  Object.assign(ctx.session, { applyDaemonConfig });
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("override the saved choice") });
  expect(applyDaemonConfig).toHaveBeenCalledWith({ taskBudgetLevel: "max", reload: true });
});

it.each([['eco', 1_000_000], ['balanced', 2_400_000], ['max', 0], ['3m', 3_000_000]] as const)("applies %s through a daemon with a frozen config snapshot", async (choice, tokens) => {
  const ctx = context(choice);
  const original = Object.freeze({ taskTokenBudget: 219_000 });
  Object.assign(ctx.session, { config: original, applyDaemonConfig: vi.fn(async () => ({ taskTokenBudget: tokens, summary: "Budget updated" })) });
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("Current session budget:") });
  expect(ctx.session.config.taskTokenBudget).toBe(tokens);
  expect(original.taskTokenBudget).toBe(219_000);
});
it.each([['3000000', 3_000_000], ['3M', 3_000_000], ['500k', 500_000], ['0', 0]] as const)("saves and applies numeric budget %s with a frozen local config", async (choice, tokens) => {
  const ctx = context(choice);
  Object.assign(ctx.session, { config: Object.freeze({ taskTokenBudget: 219_000 }) });
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text", text: expect.stringContaining("Saved") });
  expect(ctx.session.config.taskTokenBudget).toBe(tokens);
  expect(mocks.update).toHaveBeenCalledWith("userSettings", { budget_level: undefined, task_token_budget: tokens });
});
it.each(['-1', '1.5', 'Infinity', '3mb', '9007199254740992', '9007199254740991m', '3 m'])("rejects invalid numeric budget %s without saving", async choice => {
  expect(await budgetCommand.execute(context(choice))).toMatchObject({ kind: "error", message: expect.stringContaining("whole token number") });
  expect(mocks.update).not.toHaveBeenCalled();
});

it.each([['eco', 1_000_000], ['balanced', 2_400_000], ['max', 0]] as const)("replaces a frozen local config for %s", async (choice, tokens) => {
  const ctx = context(choice);
  const original = Object.freeze({ taskTokenBudget: 219_000 });
  Object.assign(ctx.session, { config: original });
  expect(await budgetCommand.execute(ctx)).toMatchObject({ kind: "text" });
  expect(ctx.session.config.taskTokenBudget).toBe(tokens);
  expect(original.taskTokenBudget).toBe(219_000);
});
