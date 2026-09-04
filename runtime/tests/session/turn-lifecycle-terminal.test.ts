import { describe, expect, it } from "vitest";

import {
  isLegacyTurnFailureErrorPayload,
  turnLifecycleTerminalFromEvent,
} from "../../src/session/turn-lifecycle-terminal.js";

describe("turnLifecycleTerminalFromEvent", () => {
  it("treats diagnostic error as non-terminal", () => {
    expect(
      turnLifecycleTerminalFromEvent({
        type: "error",
        payload: {
          cause: "stop_hook_threw",
          message: "lint threw",
          turnId: "turn-1",
        },
      }),
    ).toBeUndefined();
    expect(
      isLegacyTurnFailureErrorPayload({
        cause: "stop_hook_threw",
        message: "lint threw",
      }),
    ).toBe(false);
  });

  it("classifies turn_failed as failed", () => {
    expect(
      turnLifecycleTerminalFromEvent({
        type: "turn_failed",
        payload: {
          turnId: "turn-1",
          cause: "background_agent_error",
          message: "boom",
          completedAt: 1_500,
        },
      }),
    ).toEqual({
      kind: "failed",
      turnId: "turn-1",
      cause: "background_agent_error",
      message: "boom",
      completedAt: 1_500,
    });
  });

  it("classifies turn_complete and turn_aborted", () => {
    expect(
      turnLifecycleTerminalFromEvent({
        type: "turn_complete",
        payload: { turnId: "t1", lastAgentMessage: "done", durationMs: 10 },
      }),
    ).toMatchObject({ kind: "completed", turnId: "t1", message: "done" });
    expect(
      turnLifecycleTerminalFromEvent({
        type: "turn_aborted",
        payload: { turnId: "t1", reason: "Interrupted" },
      }),
    ).toMatchObject({ kind: "aborted", turnId: "t1", reason: "Interrupted" });
  });

  it("keeps bounded legacy error terminals for old journals", () => {
    expect(
      turnLifecycleTerminalFromEvent({
        type: "error",
        payload: {
          cause: "background_agent_error",
          message: "legacy boom",
          turnId: "turn-legacy",
        },
      }),
    ).toEqual({
      kind: "failed",
      turnId: "turn-legacy",
      cause: "background_agent_error",
      message: "legacy boom",
    });
    expect(
      turnLifecycleTerminalFromEvent({
        type: "error",
        payload: {
          message: "agent error",
          turnId: "turn-tui",
          terminal: true,
          terminalSource: "agent_status",
        },
      }),
    ).toMatchObject({
      kind: "failed",
      turnId: "turn-tui",
      message: "agent error",
    });
  });
});
