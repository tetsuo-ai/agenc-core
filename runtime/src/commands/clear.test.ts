import { describe, expect, it, vi } from "vitest";
import clearCommand, { clearSession } from "./clear.js";
import type { Session } from "../session/session.js";
import type { SlashCommandContext } from "./types.js";

vi.mock("../prompts/sections.js", () => ({
  clearSystemPromptSections: vi.fn(),
}));

import { clearSystemPromptSections } from "../prompts/sections.js";

function stubSession(opts: {
  history?: unknown[];
  memoryReset?: ReturnType<typeof vi.fn>;
  costReset?: ReturnType<typeof vi.fn>;
  budgetReset?: ReturnType<typeof vi.fn>;
  clearProviderResponseId?: ReturnType<typeof vi.fn>;
  toolApprovalsClear?: ReturnType<typeof vi.fn>;
  networkApprovalClear?: ReturnType<typeof vi.fn>;
  activeTurn?: unknown;
}) {
  const history = opts.history ?? [{ foo: 1 }, { bar: 2 }];
  const sc = { sessionConfiguration: {}, history };
  const svc: Record<string, unknown> = {};
  if (opts.memoryReset) svc["memorySidecar"] = { reset: opts.memoryReset };
  if (opts.costReset) svc["costSidecar"] = { reset: opts.costReset };
  if (opts.toolApprovalsClear) {
    svc["toolApprovals"] = { clear: opts.toolApprovalsClear };
  }
  if (opts.networkApprovalClear) {
    svc["networkApproval"] = {
      clearSessionHosts: opts.networkApprovalClear,
    };
  }
  return {
    state: {
      with: async (fn: (s: typeof sc) => unknown) => fn(sc),
    },
    services: svc,
    activeTurn: { unsafePeek: () => opts.activeTurn ?? null },
    clearProviderResponseId: opts.clearProviderResponseId,
    budgetTracker: opts.budgetReset
      ? { resetSamplingGate: opts.budgetReset }
      : null,
  } as unknown as Session & { _history: unknown[] };
}

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

describe("clearCommand", () => {
  it("exposes /reset and /new aliases and is immediate", () => {
    expect(clearCommand.aliases).toEqual(expect.arrayContaining(["reset", "new"]));
    expect(clearCommand.immediate).toBe(true);
  });

  it("empties history, clears prompt sections, and resets sidecars/budget", async () => {
    const memReset = vi.fn();
    const costReset = vi.fn();
    const budgetReset = vi.fn();
    const clearProviderResponseId = vi.fn();
    const toolApprovalsClear = vi.fn();
    const networkApprovalClear = vi.fn();
    const history: unknown[] = [{}, {}, {}];
    const session = stubSession({
      history,
      memoryReset: memReset,
      costReset: costReset,
      budgetReset,
      clearProviderResponseId,
      toolApprovalsClear,
      networkApprovalClear,
    });
    const res = await clearCommand.execute(mkctx(session));
    expect(res.kind).toBe("text");
    if (res.kind === "text") expect(res.text).toMatch(/Session cleared/);
    expect(history.length).toBe(0);
    expect(clearSystemPromptSections).toHaveBeenCalled();
    expect(memReset).toHaveBeenCalled();
    expect(costReset).toHaveBeenCalled();
    expect(budgetReset).toHaveBeenCalled();
    expect(clearProviderResponseId).toHaveBeenCalled();
    expect(toolApprovalsClear).toHaveBeenCalled();
    expect(networkApprovalClear).toHaveBeenCalled();
  });

  it("tolerates missing sidecars + missing budget tracker", async () => {
    const session = stubSession({});
    await expect(clearSession(session)).resolves.toBeUndefined();
  });

  it("refuses to clear while a turn is in flight", async () => {
    const history: unknown[] = [{ live: true }];
    const clearProviderResponseId = vi.fn();
    const session = stubSession({
      history,
      activeTurn: { turnId: "turn-live" },
      clearProviderResponseId,
    });

    const res = await clearCommand.execute(mkctx(session));

    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/in flight/);
    expect(history.length).toBe(1);
    expect(clearProviderResponseId).not.toHaveBeenCalled();
  });
});
