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
import { ToolBarrier } from "../../src/session/tool-barrier.js";
import type { LLMMessage, LLMResponse } from "../../src/llm/types.js";
import type { ToolRegistry } from "../../src/tool-registry.js";
import { mkCtx, mkProvider, mkSession } from "../fixtures.js";

afterEach(() => { vi.useRealTimers(); snapshot.release = undefined; snapshot.started = 0; });

describe("the turn barrier", () => {
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

describe("a turn's first tool call waits for its workspace snapshot; its model request does not", () => {
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
