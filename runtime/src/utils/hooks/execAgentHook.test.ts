import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  logEvent: vi.fn(),
  runRuntimeSubagent: vi.fn(),
}));

vi.mock("../../services/analytics/index.js", () => ({
  logEvent: mocks.logEvent,
}));

vi.mock("../runtimeSubagent.js", () => ({
  runRuntimeSubagent: mocks.runRuntimeSubagent,
}));

vi.mock("../sessionStorage.js", () => ({
  getTranscriptPath: () => "/tmp/session/transcript.md",
  getAgentTranscriptPath: () => "/tmp/agent/transcript.md",
}));

import { execAgentHook } from "./execAgentHook.js";

function makeToolUseContext() {
  return {
    agentId: undefined,
    options: { tools: [] },
    setResponseLength: vi.fn(),
  };
}

describe("execAgentHook", () => {
  beforeEach(() => {
    mocks.logEvent.mockReset();
    mocks.runRuntimeSubagent.mockReset();
  });

  it("returns success when the runtime helper responds with ok=true JSON", async () => {
    mocks.runRuntimeSubagent.mockResolvedValue({
      messages: [],
      finalMessage: '{"ok":true}',
      stopReason: "completed",
      toolCallCount: 2,
    });

    const result = await execAgentHook(
      { prompt: "Verify: $ARGUMENTS" } as never,
      "VerifyPlan",
      "Stop",
      '{"plan":"done"}',
      new AbortController().signal,
      makeToolUseContext() as never,
      "tool-use-1",
      [],
      "reviewer",
    );

    expect(result.outcome).toBe("success");
    expect(mocks.runRuntimeSubagent).toHaveBeenCalledTimes(1);
    expect(mocks.runRuntimeSubagent.mock.calls[0]?.[0]).toMatchObject({
      extraAllowedRoots: ["/tmp/session"],
    });
    expect(mocks.runRuntimeSubagent.mock.calls[0]?.[0]?.taskPrompt).toContain(
      'Reply with JSON only',
    );
  });

  it("returns blocking when the runtime helper responds with ok=false JSON", async () => {
    mocks.runRuntimeSubagent.mockResolvedValue({
      messages: [],
      finalMessage: '{"ok":false,"reason":"missing validation"}',
      stopReason: "completed",
      toolCallCount: 1,
    });

    const result = await execAgentHook(
      { prompt: "Verify: $ARGUMENTS" } as never,
      "VerifyPlan",
      "Stop",
      '{"plan":"done"}',
      new AbortController().signal,
      makeToolUseContext() as never,
      undefined,
      [],
      "reviewer",
    );

    expect(result.outcome).toBe("blocking");
    expect(result.blockingError?.blockingError).toContain("missing validation");
  });
});
