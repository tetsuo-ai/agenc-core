import { describe, expect, test } from "vitest";

import type { EventMsg } from "./event-log.js";
import { KNOWN_EVENT_TYPES, isKnownEventType } from "./event-log.js";

describe("R6 event-log registers tool_input_block_start and tool_input_delta variants", () => {
  test("isKnownEventType returns true for tool_input_block_start", () => {
    expect(isKnownEventType("tool_input_block_start")).toBe(true);
  });

  test("isKnownEventType returns true for tool_input_delta", () => {
    expect(isKnownEventType("tool_input_delta")).toBe(true);
  });

  test("KNOWN_EVENT_TYPES set contains both new event tags", () => {
    expect(KNOWN_EVENT_TYPES.has("tool_input_block_start")).toBe(true);
    expect(KNOWN_EVENT_TYPES.has("tool_input_delta")).toBe(true);
  });

  test("EventMsg union accepts tool_input_block_start with the documented payload shape (TS-level type check via assignment)", () => {
    const event: EventMsg = {
      type: "tool_input_block_start",
      payload: {
        callId: "toolu_a",
        index: 0,
        contentBlock: {
          type: "tool_use",
          id: "toolu_a",
          name: "Bash",
          input: {},
        },
      },
    };
    expect(event.type).toBe("tool_input_block_start");
    if (event.type === "tool_input_block_start") {
      expect(event.payload.callId).toBe("toolu_a");
      expect(event.payload.index).toBe(0);
      expect(event.payload.contentBlock.type).toBe("tool_use");
    }
  });

  test("EventMsg union accepts tool_input_delta with the documented payload shape", () => {
    const event: EventMsg = {
      type: "tool_input_delta",
      payload: {
        callId: "toolu_a",
        index: 0,
        partialJson: '{"k":1}',
      },
    };
    expect(event.type).toBe("tool_input_delta");
    if (event.type === "tool_input_delta") {
      expect(event.payload.partialJson).toBe('{"k":1}');
    }
  });
});
