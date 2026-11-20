import { afterEach, describe, expect, it, vi } from "vitest";

// The turn's workspace snapshot is slow here on purpose: it settles only when the test says so.
const snapshot = vi.hoisted(() => ({ release: undefined as (() => void) | undefined, started: 0 }));
vi.mock("../../src/session/workspace-changes.js", () => ({
  beginWorkspaceChanges: vi.fn(() => {
    snapshot.started += 1;
    return new Promise((resolve) => {
      snapshot.release = () => resolve({
        finish: async (turnId: string) => ({ turnId, from: "checkpoint", files: [] }),
        dispose: () => {},
      });
    });
  }),
}));

import { runTurn } from "../../src/session/run-turn.js";
import { ToolBarrier, ToolHolds, clientToolHolds } from "../../src/session/tool-barrier.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { vi.useRealTimers(); snapshot.release = undefined; snapshot.started = 0; });

describe("client tool holds", () => {
  it("release a waiting hold, and keep a release that came first for its hold", async () => {
    const holds = new ToolHolds();
    let held = false;
    const hold = holds.hold("m1").then(() => { held = true; });
    expect(holds.hold("m1")).toBe(holds.hold("m1"));
    await Promise.resolve();
    expect(held).toBe(false);
    expect(holds.release("m1")).toBe(true);
    await hold;
    expect(held).toBe(true);
    // Released before its turn held: the hold does not wait.
    expect(holds.release("m2")).toBe(false);
    await expect(holds.hold("m2")).resolves.toBeUndefined();
  });

  it("do not hold again a message already released, as when a prompt hook waited for it before the turn", async () => {
    const holds = new ToolHolds();
    const first = holds.hold("m1");
    holds.release("m1");
    await first;
    let again = false;
    void holds.hold("m1").then(() => { again = true; });
    await Promise.resolve(); await Promise.resolve();
    expect(again).toBe(true);
  });

  it("stop holding after the timeout, so a client that never releases cannot stall a turn", async () => {
    vi.useFakeTimers();
    const holds = new ToolHolds({ timeoutMs: 1000 });
    let held = false;
    void holds.hold("m1").then(() => { held = true; });
    await vi.advanceTimersByTimeAsync(999);
    expect(held).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(held).toBe(true);
    // Timed out once, it does not hold the same message for another 30 seconds.
    let again = false;
    void holds.hold("m1").then(() => { again = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(again).toBe(true);
  });

  it("let an aborted wait go without waiting for the work", async () => {
    const barrier = new ToolBarrier();
    barrier.add(new Promise(() => {}));
    const abort = new AbortController();
    const wait = barrier.wait(abort.signal);
    abort.abort("interrupt");
    await expect(wait).rejects.toBe("interrupt");
  });
});

/** A turn whose model asks for one tool call, then answers. */
function turnWithOneTool() {
  const probe = vi.fn(async () => ({ content: "probed" }));
  const tools = [{ name: "Probe", description: "Probe", inputSchema: { type: "object" },
    requiresApproval: false, isReadOnly: true, recoveryCategory: "idempotent" as const, execute: probe }];
  const registry: ToolRegistry = { tools,
    toLLMTools: () => tools.map(tool => ({ type: "function", function: {
      name: tool.name, description: tool.description, parameters: tool.inputSchema,
    } })),
    dispatch: async call => tools.find(tool => tool.name === call.name)!.execute(JSON.parse(call.arguments)),
  };
  const requests: LLMMessage[][] = [];
  const provider = mkProvider();
  provider.chatStream = async (messages): Promise<LLMResponse> => {
    requests.push(structuredClone(messages));
    return requests.length === 1
      ? { content: "", toolCalls: [{ id: "probe-1", name: "Probe", arguments: "{}" }], finishReason: "tool_calls", model: "test-model" }
      : { content: "done", toolCalls: [], finishReason: "stop", model: "test-model" };
  };
  const { session } = mkSession({ provider, registry });
  return { session, probe, requests };
}

async function drain(loop: AsyncGenerator<unknown, { reason: string } | undefined>) {
  for (;;) { const next = await loop.next(); if (next.done) return next.value; }
}

describe("a turn's first tool call waits; its model request does not", () => {
  it("sends the model request of a held turn at once and runs its tool only after the release", async () => {
    const { session, probe, requests } = turnWithOneTool();
    const done = drain(runTurn(session, mkCtx(), "Probe it.", { toolHoldId: "message-1" }) as never);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(probe).not.toHaveBeenCalled();
    expect(clientToolHolds.release("message-1")).toBe(true);
    expect((await done)?.reason).toBe("completed");
    expect(probe).toHaveBeenCalledOnce();
    expect(requests).toHaveLength(2);
  });

  it("does not wait at all when the release came before the turn", async () => {
    const { session, probe } = turnWithOneTool();
    clientToolHolds.release("message-2");
    expect((await drain(runTurn(session, mkCtx(), "Probe it.", { toolHoldId: "message-2" }) as never))?.reason).toBe("completed");
    expect(probe).toHaveBeenCalledOnce();
  });

  it("sends the model request before the turn's workspace snapshot is read, and runs the tool after it", async () => {
    const { session, probe, requests } = turnWithOneTool();
    const done = drain(runTurn(session, mkCtx(), "Probe it.", { turnChanges: { includeDiff: false } }) as never);
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    expect(snapshot.started).toBe(1);
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(probe).not.toHaveBeenCalled();
    snapshot.release!();
    expect((await done)?.reason).toBe("completed");
    expect(probe).toHaveBeenCalledOnce();
  });
});
