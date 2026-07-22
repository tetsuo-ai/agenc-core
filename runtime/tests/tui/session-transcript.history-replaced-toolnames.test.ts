import { describe, expect, test } from "vitest";

import { adaptTranscriptEvents } from "../../src/tui/session-transcript.js";

// Resume regression: history_replaced delivers replayed tool_use blocks as
// ready-made messages with no tool_call_started events. The renderer builds
// its tool set from transcript.toolNames, so clearing it on replacement
// without rescanning made every resumed session render "Tool use
// unavailable" for tools it only used before the resume (spawn_agent /
// close_agent in resumed swarm sessions).

function replacedHistory(): readonly unknown[] {
  return [
    {
      id: "hr",
      msg: {
        type: "history_replaced",
        payload: {
          messages: [
            {
              type: "assistant",
              uuid: "m1",
              message: {
                role: "assistant",
                model: "grok-4.5",
                content: [
                  { type: "text", text: "spawning a worker" },
                  {
                    type: "tool_use",
                    id: "call_spawn",
                    name: "spawn_agent",
                    input: { message: "implement M1", task_name: "m1" },
                  },
                ],
              },
            },
            {
              type: "assistant",
              uuid: "m2",
              message: {
                role: "assistant",
                model: "grok-4.5",
                content: [
                  {
                    type: "tool_use",
                    id: "call_close",
                    name: "close_agent",
                    input: { agent_id: "w1" },
                  },
                ],
              },
            },
          ],
        },
      },
    } as never,
  ];
}

describe("history_replaced repopulates toolNames", () => {
  test("tool_use blocks in replayed messages land in transcript.toolNames", () => {
    const transcript = adaptTranscriptEvents(replacedHistory());
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
    expect(transcript.toolNames.has("close_agent")).toBe(true);
  });

  test("a live tool after the replacement still registers too", () => {
    const events = [
      ...replacedHistory(),
      {
        id: "live",
        msg: {
          type: "tool_call_started",
          payload: { callId: "c9", toolName: "Bash", input: { command: "ls" } },
        },
      } as never,
    ];
    const transcript = adaptTranscriptEvents(events);
    expect(transcript.toolNames.has("spawn_agent")).toBe(true);
    expect(transcript.toolNames.has("Bash")).toBe(true);
  });
});
