import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { ConfigStore } from "../../src/config/store.js";
import { ExecutionAdmissionKernel } from "../../src/budget/execution-admission-kernel.js";
import { budgetCommand } from "../../src/commands/budget.js";
import type { SlashCommandContext } from "../../src/commands/types.js";

it.each([["max", 0], ["3m", 3_000_000]] as const)("uses saved %s for a new session in the same daemon kernel without a restart", async (choice, tokens) => {
  const home = await mkdtemp(join(tmpdir(), "agenc-budget-persistence-"));
  const cwd = join(home, "workspace"); await mkdir(cwd);
  const kernel = new ExecutionAdmissionKernel({ agencHome: home });
  try {
    const store = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd }); await store.reload();
    const first = kernel.bindClient({ cwd, scope: { runId: "first", sessionId: "first", autonomous: true, maxTokens: store.current().task_token_budget } });
    const session = { config: Object.freeze({ taskTokenBudget: store.current().task_token_budget }), services: { configStore: store, executionAdmission: first } };
    expect(await budgetCommand.execute({ argsRaw: choice, cwd, home, configStore: store, session } as unknown as SlashCommandContext)).toMatchObject({ kind: "text", text: expect.stringContaining("Current session budget:") });
    expect(first.scope.maxTokens).toBe(tokens || undefined);
    // Bootstrap loads a session-owned store while retaining the running kernel.
    const nextStore = new ConfigStore({ home, env: { AGENC_HOME: home }, cwd }); await nextStore.reload();
    expect(nextStore.current().task_token_budget).toBe(tokens);
    if (choice === "3m") expect(nextStore.current().budget_level).toBeUndefined();
    const next = kernel.bindClient({ cwd, scope: { runId: "next", sessionId: "next", autonomous: true, ...(tokens ? { maxTokens: tokens } : {}) } });
    expect(next.scope.maxTokens).toBe(tokens || undefined);
    expect(session.config.taskTokenBudget).toBe(tokens);
  } finally { kernel.close(); await rm(home, { recursive: true, force: true }); }
});
