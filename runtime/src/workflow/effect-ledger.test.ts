import { describe, expect, it } from "vitest";

import { createMockMemoryBackend } from "../memory/test-utils.js";
import { EffectLedger } from "./effect-ledger.js";

describe("EffectLedger", () => {
  it("reuses a single effect record across attempts with the same idempotency key", async () => {
    const ledger = EffectLedger.fromMemoryBackend(createMockMemoryBackend());
    const first = await ledger.beginEffect({
      id: "effect-1",
      idempotencyKey: "pipeline:test:step:1",
      toolCallId: "tool-1",
      toolName: "system.bash",
      args: { command: "touch", args: ["a.txt"] },
      scope: { sessionId: "session-1", pipelineId: "pipeline-1", stepName: "mutate", stepIndex: 0 },
      kind: "shell_command",
      effectClass: "shell",
      intentSummary: "touch a.txt",
      targets: [{ kind: "command", command: "touch a.txt" }],
      createdAt: 1,
      requiresApproval: false,
    });

    await ledger.recordOutcome({
      effectId: first.id,
      success: false,
      isError: true,
      result: '{"error":"first attempt failed"}',
      error: "first attempt failed",
    });

    const second = await ledger.beginEffect({
      id: "effect-2",
      idempotencyKey: "pipeline:test:step:1",
      toolCallId: "tool-2",
      toolName: "system.bash",
      args: { command: "touch", args: ["a.txt"] },
      scope: { sessionId: "session-1", pipelineId: "pipeline-1", stepName: "mutate", stepIndex: 0 },
      kind: "shell_command",
      effectClass: "shell",
      intentSummary: "touch a.txt",
      targets: [{ kind: "command", command: "touch a.txt" }],
      createdAt: 2,
      requiresApproval: false,
    });

    expect(second.id).toBe(first.id);
    expect(second.toolCallId).toBe("tool-2");
    expect(second.attempts).toHaveLength(2);
    expect(second.attempts[0]?.status).toBe("failed");
    expect(second.attempts[1]?.status).toBe("intent_recorded");
  });
});

