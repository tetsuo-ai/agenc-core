import { describe, expect, it, vi } from "vitest";
import { clearCommand, clearSession } from "./clear.js";
import { buildDefaultRegistry } from "./registry.js";
import { dispatchSlashCommand, parseSlashCommand } from "./dispatcher.js";
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
  emitPhaseEvent?: ReturnType<typeof vi.fn>;
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
    emitPhaseEvent: opts.emitPhaseEvent,
    budgetTracker: opts.budgetReset
      ? { resetSamplingGate: opts.budgetReset }
      : null,
  } as unknown as Session & { _history: unknown[] };
}

function mkctx(session: Session): SlashCommandContext {
  return { session, argsRaw: "", cwd: "/ws", home: "/home/test" };
}

describe("clearCommand", () => {
  it("exposes only explicit destructive aliases and is immediate", () => {
    expect(clearCommand.aliases).toEqual(["reset", "new"]);
    expect(clearCommand.immediate).toBe(true);
  });

  it("does not treat /history as a destructive clear alias", async () => {
    vi.clearAllMocks();
    const history: unknown[] = [{ keep: true }];
    const session = stubSession({ history });
    const parsed = parseSlashCommand("/history");
    expect(parsed).not.toBeNull();

    const outcome = await dispatchSlashCommand(
      parsed!,
      mkctx(session),
      buildDefaultRegistry(),
    );

    expect(outcome.result).toEqual({
      kind: "error",
      message: "Unknown command: /history",
    });
    expect(history).toHaveLength(1);
    expect(clearSystemPromptSections).not.toHaveBeenCalled();
  });

  it("empties history, clears prompt sections, and resets sidecars/budget", async () => {
    const memReset = vi.fn();
    const costReset = vi.fn();
    const budgetReset = vi.fn();
    const clearProviderResponseId = vi.fn();
    const toolApprovalsClear = vi.fn();
    const networkApprovalClear = vi.fn();
    const emitPhaseEvent = vi.fn();
    const history: unknown[] = [{}, {}, {}];
    const session = stubSession({
      history,
      memoryReset: memReset,
      costReset: costReset,
      budgetReset,
      clearProviderResponseId,
      toolApprovalsClear,
      networkApprovalClear,
      emitPhaseEvent,
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
    expect(emitPhaseEvent).toHaveBeenCalledWith({
      type: "history_cleared",
      timestamp: expect.any(Number),
    });
  });

  it("tolerates missing sidecars + missing budget tracker", async () => {
    const session = stubSession({});
    await expect(clearSession(session)).resolves.toBeUndefined();
  });

  it("ignores array-shaped reset surfaces", async () => {
    const memReset = vi.fn();
    const costReset = vi.fn();
    const budgetReset = vi.fn();
    const toolApprovalsClear = vi.fn();
    const networkApprovalClear = vi.fn();
    const history: unknown[] = [{ keep: false }];
    const state = { sessionConfiguration: {}, history };
    const session = {
      state: {
        with: async (fn: (s: typeof state) => unknown) => fn(state),
      },
      services: {
        memorySidecar: Object.assign(["spoof"], { reset: memReset }),
        costSidecar: Object.assign(["spoof"], { reset: costReset }),
        toolApprovals: Object.assign(["spoof"], {
          clear: toolApprovalsClear,
        }),
        networkApproval: Object.assign(["spoof"], {
          clearSessionHosts: networkApprovalClear,
        }),
      },
      budgetTracker: Object.assign(["spoof"], {
        resetSamplingGate: budgetReset,
      }),
      clearProviderResponseId: "not-a-function",
      activeTurn: { unsafePeek: () => null },
      denialTracking: Object.assign(["spoof"], { count: 1 }),
    } as unknown as Session;

    await expect(clearSession(session)).resolves.toBeUndefined();

    expect(history).toHaveLength(0);
    expect(memReset).not.toHaveBeenCalled();
    expect(costReset).not.toHaveBeenCalled();
    expect(budgetReset).not.toHaveBeenCalled();
    expect(toolApprovalsClear).not.toHaveBeenCalled();
    expect(networkApprovalClear).not.toHaveBeenCalled();
  });

  it("clears bridge-like sessions without local history state and still emits a TUI reset", async () => {
    const emitPhaseEvent = vi.fn();
    const session = {
      emitPhaseEvent,
    } as unknown as Session;

    const res = await clearCommand.execute(mkctx(session));

    expect(res.kind).toBe("text");
    expect(emitPhaseEvent).toHaveBeenCalledWith({
      type: "history_cleared",
      timestamp: expect.any(Number),
    });
  });

  it("delegates daemon-backed sessions to the daemon clear path without local duplicate emit", async () => {
    const clearDaemonSession = vi.fn(async () => undefined);
    const emitPhaseEvent = vi.fn();
    const session = {
      clearDaemonSession,
      emitPhaseEvent,
    } as unknown as Session;

    const res = await clearCommand.execute(mkctx(session));

    expect(res.kind).toBe("text");
    expect(clearDaemonSession).toHaveBeenCalledTimes(1);
    expect(emitPhaseEvent).not.toHaveBeenCalled();
  });

  it("refuses to clear while a turn is in flight", async () => {
    const history: unknown[] = [{ live: true }];
    const clearProviderResponseId = vi.fn();
    const emitPhaseEvent = vi.fn();
    const session = stubSession({
      history,
      activeTurn: { turnId: "turn-live" },
      clearProviderResponseId,
      emitPhaseEvent,
    });

    const res = await clearCommand.execute(mkctx(session));

    expect(res.kind).toBe("error");
    if (res.kind === "error") expect(res.message).toMatch(/in flight/);
    expect(history.length).toBe(1);
    expect(clearProviderResponseId).not.toHaveBeenCalled();
    expect(emitPhaseEvent).not.toHaveBeenCalled();
  });
});
