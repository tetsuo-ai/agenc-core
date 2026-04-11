import { describe, expect, it } from "vitest";

import type { ToolCallRecord } from "../chat-executor-types.js";
import {
  buildStopHookRuntime,
  BUILTIN_TURN_END_STOP_GATE_ID,
  runStopHookPhase,
} from "./stop-hooks.js";

function bashFailure(command: string, stderr: string): ToolCallRecord {
  return {
    name: "system.bash",
    args: { command },
    result: JSON.stringify({
      exitCode: 1,
      stdout: "",
      stderr,
      timedOut: false,
      durationMs: 50,
      truncated: false,
    }),
    isError: true,
    durationMs: 50,
  };
}

describe("stop-hooks", () => {
  it("returns undefined when stop hooks are disabled", () => {
    expect(buildStopHookRuntime(undefined)).toBeUndefined();
    expect(buildStopHookRuntime({ enabled: false })).toBeUndefined();
  });

  it("runs the built-in stop hook and preserves the stop-gate reason", async () => {
    const runtime = buildStopHookRuntime({ enabled: true });
    const result = await runStopHookPhase({
      runtime,
      phase: "Stop",
      matchKey: "session-1",
      context: {
        phase: "Stop",
        sessionId: "session-1",
        finalContent:
          "Phase 0 bootstrap complete. The build succeeded for all files. All tests pass and the binary is ready.",
        allToolCalls: [
          bashFailure("cmake .. && make", "CMake Error: missing readline"),
        ],
      },
    });

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.reason).toBe("false_success_after_failed_bash");
    expect(result.blockingMessage).toMatch(/Failing shell commands/);
    expect(result.hookOutcomes[0]?.hookId).toBe(BUILTIN_TURN_END_STOP_GATE_ID);
  });

  it("honors configured hook ordering and merges evidence by hook id", async () => {
    const runtime = buildStopHookRuntime({
      enabled: true,
      handlers: [
        {
          id: "first-progress",
          phase: "VerificationReady",
          kind: "command",
          target: "sleep 0.05; printf '{\"progressMessages\":[\"first\"]}'",
        },
        {
          id: "second-block",
          phase: "VerificationReady",
          kind: "command",
          target:
            "printf '{\"blockingError\":{\"message\":\"blocked\",\"evidence\":{\"source\":\"second\"}}}'",
        },
      ],
    });

    const result = await runStopHookPhase({
      runtime,
      phase: "VerificationReady",
      matchKey: "session-2",
      context: {
        phase: "VerificationReady",
        sessionId: "session-2",
      },
    });

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.blockingMessage).toBe("blocked");
    expect(result.progressMessages).toEqual([
      { hookId: "first-progress", message: "first" },
    ]);
    expect(result.evidence).toEqual({ "second-block": { source: "second" } });
    expect(result.hookOutcomes.map((outcome) => outcome.hookId)).toEqual([
      "first-progress",
      "second-block",
    ]);
  });

  it("treats hook timeouts as blocking errors", async () => {
    const runtime = buildStopHookRuntime({
      enabled: true,
      handlers: [
        {
          id: "slow-hook",
          phase: "VerificationReady",
          kind: "command",
          target: "sleep 0.1",
          timeoutMs: 1,
        },
      ],
    });

    const result = await runStopHookPhase({
      runtime,
      phase: "VerificationReady",
      matchKey: "session-3",
      context: {
        phase: "VerificationReady",
        sessionId: "session-3",
      },
    });

    expect(result.outcome).toBe("retry_with_blocking_message");
    expect(result.blockingMessage).toMatch(/timed out/);
  });
});
