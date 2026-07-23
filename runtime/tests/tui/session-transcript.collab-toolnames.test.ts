import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

// Regression for the resumed-swarm "Tool use unavailable: spawn_agent"
// cards that SURVIVED the 0.8.5 history_replaced fix. The real delivery
// path (verbatim event shapes below are lifted from an affected session's
// rollout, conv-mrwq1pfy 2026-07-22) is tool_input_block_start +
// tool_call_started replay — and the reducer's collab branch suppressed
// the generic spawn_agent row WITHOUT registering the name in toolNames,
// while tool_input_block_start built a streaming cell that renders through
// parseToolUse with the name equally unregistered. Both paths must feed
// the renderer tool set.

const REAL_EVENTS = [
  {
    id: "sub-conv-mrwq1pfy-469",
    msg: {
      type: "tool_input_block_start",
      payload: {
        callId: "call-8f8afe95-10d2-4323-a15c-3c19e2b828a7-9",
        index: 2,
        contentBlock: {
          type: "tool_use",
          id: "call-8f8afe95-10d2-4323-a15c-3c19e2b828a7-9",
          name: "spawn_agent",
          input: {},
        },
      },
    },
  },
  {
    id: "sub-conv-mrwq1pfy-471",
    msg: {
      type: "tool_call_started",
      payload: {
        callId: "call-8f8afe95-10d2-4323-a15c-3c19e2b828a7-9",
        toolName: "spawn_agent",
        args: '{"task_name":"m0-audit","message":"You are auditing M0"}',
      },
    },
  },
] as const;

describe("collab tool names reach the renderer tool set", () => {
  test("tool_input_block_start registers the block's tool name", () => {
    const transcript = adaptTranscriptEvents([REAL_EVENTS[0]] as never[]);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
  });

  test("suppressed collab tool_call_started still registers the name", () => {
    const transcript = adaptTranscriptEvents([REAL_EVENTS[1]] as never[]);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
  });

  test("the full real replay sequence registers spawn_agent exactly once each way", () => {
    const transcript = adaptTranscriptEvents([...REAL_EVENTS] as never[]);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
  });
});
