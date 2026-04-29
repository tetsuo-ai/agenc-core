import { describe, expect, it } from "vitest";

import {
  createToolProtocolState,
  getPendingToolProtocolCalls,
  hasPendingToolProtocol,
  noteToolProtocolRepair,
  noteToolProtocolViolation,
  openToolProtocolTurn,
  recordToolProtocolResult,
  responseHasMalformedToolFinish,
  responseHasToolCalls,
} from "./tool-protocol-state.js";

describe("tool-protocol-state", () => {
  it("tracks opened tool calls and clears them as results arrive", () => {
    const state = createToolProtocolState();
    openToolProtocolTurn(state, [
      { id: "tc-1", name: "system.readFile", arguments: "{}" },
      { id: "tc-2", name: "system.listDir", arguments: "{}" },
    ]);

    expect(hasPendingToolProtocol(state)).toBe(true);
    expect(getPendingToolProtocolCalls(state).map((toolCall) => toolCall.id)).toEqual([
      "tc-1",
      "tc-2",
    ]);

    recordToolProtocolResult(state, "tc-1");
    expect(getPendingToolProtocolCalls(state).map((toolCall) => toolCall.id)).toEqual([
      "tc-2",
    ]);

    recordToolProtocolResult(state, "tc-2");
    expect(hasPendingToolProtocol(state)).toBe(false);
  });

  it("records repair and violation counters", () => {
    const state = createToolProtocolState();

    noteToolProtocolRepair(state, "round_aborted");
    noteToolProtocolViolation(state, "missing_tool_calls_for_finish_reason");

    expect(state.repairCount).toBe(1);
    expect(state.lastRepairReason).toBe("round_aborted");
    expect(state.violationCount).toBe(1);
    expect(state.lastViolation).toBe("missing_tool_calls_for_finish_reason");
  });

  it("treats actual tool calls as the continuation signal", () => {
    expect(
      responseHasToolCalls({
        toolCalls: [{ id: "tc-1", name: "system.bash", arguments: "{}" }],
      }),
    ).toBe(true);
    expect(
      responseHasToolCalls({
        toolCalls: [],
      }),
    ).toBe(false);
  });

  it("detects tool_calls finish reasons without tool calls", () => {
    expect(
      responseHasMalformedToolFinish({
        finishReason: "tool_calls",
        toolCalls: [],
      }),
    ).toBe(true);
    expect(
      responseHasMalformedToolFinish({
        finishReason: "stop",
        toolCalls: [{ id: "tc-1", name: "tool", arguments: "{}" }],
      }),
    ).toBe(false);
  });
});
