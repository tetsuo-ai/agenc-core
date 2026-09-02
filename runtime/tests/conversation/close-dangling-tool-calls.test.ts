import { describe, expect, it, vi } from "vitest";

import {
  ConversationThreadManager,
  DANGLING_TOOL_CALLS_CLOSED_CAUSE,
  trailingDanglingToolCalls,
} from "../../src/conversation/thread-manager.js";
import type { ResponseItem, RolloutItem } from "../../src/session/rollout-item.js";
import type { Session, SessionState } from "../../src/session/session.js";
import { verifyToolResultIntegrity } from "../../src/session/tool-result-integrity.js";
import { AsyncLock } from "../../src/utils/async-lock.js";

// Live shape (desktop, 2026-09-02): a daemon restart killed a turn after the
// model issued six parallel tool calls and before any result was recorded.
// The resumed session was refused on its next message: "tool-pair history
// rejected during live append: tool results must immediately follow their
// assistant calls; unresolved: call-...-53 ... call-...-58".

function makeSession(conversationId = "conv-resumed") {
  const state = new AsyncLock<SessionState>({
    sessionConfiguration: { cwd: "/tmp/work" } as SessionState["sessionConfiguration"],
    history: [],
  });
  const appendRollout = vi.fn();
  let subId = 0;
  const session = {
    conversationId,
    state,
    emit: vi.fn(),
    seedInternalSubId: vi.fn((next: number) => {
      subId = Math.max(subId, next);
    }),
    nextInternalSubId: vi.fn(() => `sub-${conversationId}-${subId++}`),
    rolloutStore: {
      appendRollout,
      recordProjectionFailure: vi.fn(),
      acknowledgeCompactionReconstruction: vi.fn(),
    },
    agentStatus: { value: { status: "pending_init" }, subscribe: vi.fn(() => vi.fn()) },
  } as unknown as Session & {
    readonly emit: ReturnType<typeof vi.fn>;
    readonly state: AsyncLock<SessionState>;
  };
  return { session, appendRollout };
}

const user: RolloutItem = {
  type: "response_item",
  payload: { role: "user", content: "Add a particle explosion" },
};
const assistantWithCalls: RolloutItem = {
  type: "response_item",
  payload: {
    role: "assistant",
    content: "",
    toolCalls: [
      { id: "call-53", name: "Glob", arguments: '{"pattern":"arcade15/*.js"}' },
      { id: "call-54", name: "FileRead", arguments: '{"file_path":"arcade15/main.js"}' },
    ],
  },
};
const resultFor = (id: string): RolloutItem => ({
  type: "response_item",
  payload: { role: "tool", content: "ok", toolCallId: id, toolName: "FileRead" },
});

describe("trailingDanglingToolCalls", () => {
  it("lists the calls of the last assistant message without a result", () => {
    const history = [user.payload, assistantWithCalls.payload, resultFor("call-54").payload] as ResponseItem[];
    expect(trailingDanglingToolCalls(history)).toEqual([{ id: "call-53", name: "Glob" }]);
  });

  it("returns nothing when every call is resolved or the history ends in text", () => {
    const resolved = [assistantWithCalls.payload, resultFor("call-53").payload, resultFor("call-54").payload] as ResponseItem[];
    expect(trailingDanglingToolCalls(resolved)).toEqual([]);
    expect(trailingDanglingToolCalls([user.payload as ResponseItem])).toEqual([]);
    expect(trailingDanglingToolCalls([])).toEqual([]);
  });
});

describe("replayRolloutIntoSession closes trailing dangling tool calls", () => {
  it("appends sealed error results to the rollout and the history and warns", async () => {
    const { session, appendRollout } = makeSession();
    const manager = new ConversationThreadManager();

    const replay = await manager.replayRolloutIntoSession(session, [user, assistantWithCalls], {
      emitSynthesized: true,
    });

    const history = replay.appliedState.history;
    expect(history).toHaveLength(4);
    const synthesized = history.slice(2);
    expect(synthesized.map((item) => [item.role, item.toolCallId, item.toolName])).toEqual([
      ["tool", "call-53", "Glob"],
      ["tool", "call-54", "FileRead"],
    ]);
    for (const item of synthesized) {
      expect(typeof item.content).toBe("string");
      expect(item.content).toContain("interrupted");
      expect(item.content).toContain(item.toolName as string);
      // Sealed under the session's run id, like a live tool result.
      const verification = verifyToolResultIntegrity({
        integrity: item.toolResultIntegrity,
        expectedRunId: "conv-resumed",
        toolCallId: item.toolCallId as string,
        content: item.content,
      });
      expect(verification.status).toBe("valid");
    }
    // Persisted through the live tool-pair gate, one item per call, in order.
    expect(appendRollout).toHaveBeenCalledTimes(2);
    expect(appendRollout.mock.calls.map(([item]) => [item.type, item.payload.toolCallId])).toEqual([
      ["response_item", "call-53"],
      ["response_item", "call-54"],
    ]);
    expect(appendRollout.mock.calls[0][0].payload).toEqual(synthesized[0]);
    // The session state holds the same repaired history.
    expect(session.state.unsafePeek().history).toEqual(history);
    // One warning names the closed calls.
    const warnings = session.emit.mock.calls
      .map(([event]) => event)
      .filter((event) => event.msg?.type === "warning");
    expect(warnings).toHaveLength(1);
    expect(warnings[0].msg.payload.cause).toBe(DANGLING_TOOL_CALLS_CLOSED_CAUSE);
    expect(warnings[0].msg.payload.message).toContain("Glob call-53");
    expect(warnings[0].msg.payload.message).toContain("FileRead call-54");
  });

  it("repairs the history without emitting when the caller does not replay synthesized events", async () => {
    const { session, appendRollout } = makeSession();
    const manager = new ConversationThreadManager();

    const replay = await manager.replayRolloutIntoSession(session, [user, assistantWithCalls]);

    expect(replay.appliedState.history).toHaveLength(4);
    expect(appendRollout).toHaveBeenCalledTimes(2);
    expect(session.emit.mock.calls.some(([event]) => event.msg?.type === "warning")).toBe(false);
  });

  it("leaves a fully resolved history untouched", async () => {
    const { session, appendRollout } = makeSession();
    const manager = new ConversationThreadManager();

    const replay = await manager.replayRolloutIntoSession(session, [
      user,
      assistantWithCalls,
      resultFor("call-53"),
      resultFor("call-54"),
    ]);

    expect(replay.appliedState.history).toHaveLength(4);
    expect(appendRollout).not.toHaveBeenCalled();
    expect(session.emit.mock.calls.some(([event]) => event.msg?.type === "warning")).toBe(false);
  });
});
