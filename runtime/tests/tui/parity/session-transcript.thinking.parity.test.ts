import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../session-transcript.js";

type Evt = {
  id: string;
  msg: { type: string; payload?: Record<string, unknown> };
};

function turnStart(turnId = "t1"): Evt {
  return {
    id: `turn-start-${turnId}`,
    msg: { type: "turn_started", payload: { turnId } },
  };
}

function turnComplete(turnId = "t1", lastAgentMessage?: string): Evt {
  return {
    id: `turn-complete-${turnId}`,
    msg: {
      type: "turn_complete",
      payload: { turnId, ...(lastAgentMessage ? { lastAgentMessage } : {}) },
    },
  };
}

function thinkStart(index: number, redacted = false): Evt {
  return {
    id: `t-bs-${index}`,
    msg: {
      type: "assistant_thinking_block_start",
      payload: { index, redacted, kind: "thinking" },
    },
  };
}

function thinkDelta(index: number, delta: string): Evt {
  return {
    id: `t-d-${index}-${delta}-${Math.random()}`,
    msg: {
      type: "assistant_thinking_delta",
      payload: { index, delta, kind: "thinking" },
    },
  };
}

function thinkStop(index: number): Evt {
  return {
    id: `t-bp-${index}`,
    msg: {
      type: "assistant_thinking_block_stop",
      payload: { index, kind: "thinking" },
    },
  };
}

function agentThinking(text: string): Evt {
  return {
    id: `at-${text}`,
    msg: { type: "agent_thinking", payload: { text, kind: "thinking" } },
  };
}

function agentMessageDelta(delta: string): Evt {
  return {
    id: `amd-${delta}-${Math.random()}`,
    msg: { type: "agent_message_delta", payload: { delta } },
  };
}

function agentMessage(message: string): Evt {
  return {
    id: `am-${message}`,
    msg: { type: "agent_message", payload: { message } },
  };
}

function turnAborted(reason = "user_cancel"): Evt {
  return {
    id: `ta-${reason}`,
    msg: { type: "turn_aborted", payload: { reason } },
  };
}

describe("session-transcript reducer accumulates streamingThinking", () => {
  test("empty stream → streamingThinking is null", () => {
    const t = adaptTranscriptEvents([]);
    expect(t.streamingThinking).toBeNull();
  });

  test("block_start sets streamingThinking with isStreaming=true and empty thinking", () => {
    const t = adaptTranscriptEvents([turnStart(), thinkStart(0)]);
    expect(t.streamingThinking).not.toBeNull();
    expect(t.streamingThinking?.isStreaming).toBe(true);
    expect(t.streamingThinking?.thinking).toBe("");
    expect(t.streamingThinking?.redacted).toBe(false);
    expect(t.streamingThinking?.kind).toBe("thinking");
  });

  test("deltas append to thinking", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "Hello "),
      thinkDelta(0, "world."),
    ]);
    expect(t.streamingThinking?.thinking).toBe("Hello world.");
    expect(t.streamingThinking?.isStreaming).toBe(true);
  });

  test("block_stop flips isStreaming=false and stamps streamingEndedAt", () => {
    const before = Date.now();
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "Done."),
      thinkStop(0),
    ]);
    expect(t.streamingThinking?.isStreaming).toBe(false);
    expect(t.streamingThinking?.thinking).toBe("Done.");
    expect(t.streamingThinking?.streamingEndedAt).toBeGreaterThanOrEqual(before);
  });

  test("agent_thinking appends a transcript message and dedupes against repeats", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "X"),
      thinkStop(0),
      agentThinking("X"),
      // duplicate event with same payload — must not double-render
      {
        id: "at-dup",
        msg: { type: "agent_thinking", payload: { text: "X" } },
      },
    ]);
    const thinkingRows = t.messages.filter((m: any) =>
      m.type === "assistant" &&
      Array.isArray(m.message?.content) &&
      m.message.content.some(
        (block: any) =>
          block.type === "thinking" || block.type === "redacted_thinking",
      ),
    );
    expect(thinkingRows).toHaveLength(1);
  });

  test("multiple thinking blocks per turn: each block_start replaces the live accumulator, agent_thinking persists each block", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "Plan A"),
      thinkStop(0),
      agentThinking("Plan A"),
      thinkStart(1),
      thinkDelta(1, "Plan B"),
      thinkStop(1),
      agentThinking("Plan B"),
    ]);
    // Live accumulator reflects only the last block
    expect(t.streamingThinking?.thinking).toBe("Plan B");
    expect(t.streamingThinking?.isStreaming).toBe(false);
    // Two persisted thinking rows
    const rows = t.messages.filter((m: any) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b: any) => b.type === "thinking"),
    );
    expect(rows).toHaveLength(2);
  });

  test("turn_aborted preserves partial thinking just like streamingText (Phase 5 #56 parallel)", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "Partial thought"),
      // No block_stop — user pressed Esc mid-thinking
      turnAborted("user_cancel"),
    ]);
    const thinkingRows = t.messages.filter((m: any) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b: any) => b.type === "thinking"),
    );
    expect(thinkingRows).toHaveLength(1);
    expect(thinkingRows[0]!.message.content[0].thinking).toBe("Partial thought");
    // System-message warning row is still emitted
    const warning = t.messages.find(
      (m: any) => m.type === "system" && /Turn aborted/.test(String(m.content ?? "")),
    );
    expect(warning).toBeDefined();
    // Live accumulator cleared
    expect(t.streamingThinking).toBeNull();
  });

  test("turn_started resets a stale accumulator from the previous turn", () => {
    const t = adaptTranscriptEvents([
      turnStart("t1"),
      thinkStart(0),
      thinkDelta(0, "old"),
      // No stop — turn went weird and a new turn began
      turnStart("t2"),
    ]);
    expect(t.streamingThinking).toBeNull();
  });

  test("redacted_thinking block records start/stop without leaking text into deltas", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0, true),
      // Even if a delta arrived (it shouldn't for redacted), the reducer
      // must not concat it because the start payload says redacted:true.
      thinkDelta(0, "<should not render>"),
      thinkStop(0),
    ]);
    expect(t.streamingThinking?.redacted).toBe(true);
    expect(t.streamingThinking?.thinking).toBe("");
    expect(t.streamingThinking?.isStreaming).toBe(false);
  });

  test("agent_message after thinking dedupes correctly against streamingText, no thinking-row leakage", () => {
    const t = adaptTranscriptEvents([
      turnStart(),
      thinkStart(0),
      thinkDelta(0, "thought"),
      thinkStop(0),
      agentThinking("thought"),
      agentMessageDelta("hello"),
      agentMessage("hello"),
      turnComplete("t1", "hello"),
    ]);
    // One thinking row, one assistant text row
    const thinkingRows = t.messages.filter((m: any) =>
      Array.isArray(m.message?.content) &&
      m.message.content.some((b: any) => b.type === "thinking"),
    );
    const assistantTextRows = t.messages.filter((m: any) =>
      m.type === "assistant" &&
      Array.isArray(m.message?.content) &&
      m.message.content.some((b: any) => b.type === "text"),
    );
    expect(thinkingRows).toHaveLength(1);
    expect(assistantTextRows).toHaveLength(1);
    expect(assistantTextRows[0]!.message.content[0].text).toBe("hello");
  });
});
