import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

// Regressions from real resumed and live swarm sessions. Collaboration tool
// names must reach the renderer so historical structured rows remain
// resolvable, but their provider-level input blocks must not create duplicate
// generic rows such as `spawn_agent ({})` beside the named lifecycle cards.

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
  test.each([
    "spawn_agent",
    "wait_agent",
    "close_agent",
    "assign_task",
    "send_message",
    "list_agents",
    "followup_task",
  ])(
    "%s input streaming registers its name without exposing a generic row",
    (toolName) => {
      const callId = `call-${toolName}`;
      const transcript = adaptTranscriptEvents([
        {
          id: `${callId}-start`,
          msg: {
            type: "tool_input_block_start",
            payload: {
              callId,
              index: 2,
              contentBlock: {
                type: "tool_use",
                id: callId,
                name: toolName,
                input: {},
              },
            },
          },
        },
        {
          id: `${callId}-delta`,
          msg: {
            type: "tool_input_delta",
            payload: {
              callId,
              index: 2,
              partialJson: '{"task_name":"audit"}',
            },
          },
        },
      ] as never[]);

      expect(transcript.toolNames.has(toolName)).toBe(true);
      expect(transcript.streamingToolUses).toEqual([]);
    },
  );

  test("suppressed collab tool_call_started still registers the name", () => {
    const transcript = adaptTranscriptEvents([REAL_EVENTS[1]] as never[]);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
  });

  test("the full real replay sequence registers spawn_agent exactly once each way", () => {
    const transcript = adaptTranscriptEvents([...REAL_EVENTS] as never[]);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
    expect(transcript.streamingToolUses).toEqual([]);
  });

  test("a normal tool can reuse a suppressed collaboration input index", () => {
    const transcript = adaptTranscriptEvents([
      REAL_EVENTS[0],
      {
        id: "normal-tool-start",
        msg: {
          type: "tool_input_block_start",
          payload: {
            callId: "call-bash",
            index: 2,
            contentBlock: {
              type: "tool_use",
              id: "call-bash",
              name: "Bash",
              input: {},
            },
          },
        },
      },
      {
        id: "normal-tool-delta",
        msg: {
          type: "tool_input_delta",
          payload: {
            callId: "call-bash",
            index: 2,
            partialJson: '{"command":"pwd"}',
          },
        },
      },
    ] as never[]);

    expect(transcript.streamingToolUses).toHaveLength(1);
    expect(transcript.streamingToolUses[0]).toMatchObject({
      index: 2,
      contentBlock: { id: "call-bash", name: "Bash" },
      unparsedToolInput: '{"command":"pwd"}',
    });
  });

  test("list_agents machine JSON stays in the Agents rail, not the transcript", () => {
    const transcript = adaptTranscriptEvents([
      {
        id: "list-agents-start",
        msg: {
          type: "tool_call_started",
          payload: {
            callId: "call-list-agents",
            toolName: "list_agents",
            args: "{}",
          },
        },
      },
      {
        id: "list-agents-complete",
        msg: {
          type: "tool_call_completed",
          payload: {
            callId: "call-list-agents",
            result:
              '{"agents":[{"agent_name":"/root/a","agent_status":"running"}]}',
            isError: false,
          },
        },
      },
    ] as never[]);

    expect(transcript.toolNames.has("list_agents")).toBe(true);
    expect(transcript.messages).toEqual([]);
    expect(transcript.streamingToolUses).toEqual([]);
  });
});
