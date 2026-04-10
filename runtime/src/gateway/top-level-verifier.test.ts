import { describe, expect, it, vi } from "vitest";

import type { ChatExecutorResult } from "../llm/chat-executor.js";
import { maybeRunTopLevelVerifier } from "./top-level-verifier.js";

function createResult(
  overrides: Partial<ChatExecutorResult> = {},
): ChatExecutorResult {
  return {
    content: "Implemented every requested artifact.",
    provider: "grok",
    usedFallback: false,
    toolCalls: [
      {
        name: "system.writeFile",
        args: { path: "/workspace/src/main.c" },
        result: '{"ok":true}',
        isError: false,
        durationMs: 5,
      },
    ],
    tokenUsage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    callUsage: [],
    durationMs: 10,
    compacted: false,
    stopReason: "completed",
    completionState: "completed",
    turnExecutionContract: {
      version: 1,
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
      delegationPolicy: "direct_owner",
      contractFingerprint: "contract-1",
      taskLineageId: "task-1",
    },
    activeTaskContext: {
      version: 1,
      taskLineageId: "task-1",
      contractFingerprint: "contract-1",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: "/workspace",
      sourceArtifacts: ["/workspace/PLAN.md"],
      targetArtifacts: ["/workspace/src/main.c"],
    },
    ...overrides,
  };
}

describe("maybeRunTopLevelVerifier", () => {
  it("spawns the verifier worker with grounded read evidence", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-1",
      output: "### Check: build\nResult: FAIL\nVERDICT: FAIL",
      success: false,
      durationMs: 42,
      toolCalls: [
        {
          name: "system.readFile",
          args: { path: "/workspace/src/main.c" },
          result: '{"ok":true}',
          isError: false,
          durationMs: 2,
        },
      ],
      completionState: "completed",
      stopReason: "completed",
    }));

    const updated = await maybeRunTopLevelVerifier({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: {
        shouldVerifySubAgentResult: vi.fn(() => true),
      },
      agentDefinitions: [
        {
          name: "verify",
          description: "Verification worker",
          model: "inherit",
          tools: ["system.readFile", "system.bash"],
          maxTurns: 8,
          source: "built-in",
          filePath: "/tmp/verify.md",
          body: "Verifier system prompt",
        },
      ],
    });

    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        systemPrompt: "Verifier system prompt",
        tools: ["system.readFile", "system.bash"],
        structuredOutput: expect.objectContaining({
          enabled: true,
          schema: expect.objectContaining({
            name: "agenc_top_level_verifier_decision",
            strict: true,
          }),
        }),
        requiredToolEvidence: expect.objectContaining({
          executionEnvelope: expect.objectContaining({
            verificationMode: "grounded_read",
            targetArtifacts: ["/workspace/src/main.c"],
          }),
        }),
      }),
    );
    expect(updated.completionState).toBe("partial");
    expect(updated.content).toContain("Verification did not pass.");
    expect(updated.stopReasonDetail).toContain("Top-level verifier fail");
  });

  it("prefers structured verifier verdicts over text parsing", async () => {
    const spawn = vi.fn(async () => "subagent:verify-2");
    const waitForResult = vi.fn(async () => ({
      sessionId: "subagent:verify-2",
      output: "Verifier wrote a long narrative without a VERDICT line.",
      success: false,
      durationMs: 25,
      toolCalls: [],
      structuredOutput: {
        type: "json_schema",
        name: "agenc_top_level_verifier_decision",
        parsed: {
          verdict: "fail",
          summary: "Build fails under verifier-run acceptance checks.",
        },
      },
      completionState: "completed",
      stopReason: "completed",
    }));

    const updated = await maybeRunTopLevelVerifier({
      sessionId: "session:test",
      userRequest: "Implement every phase from PLAN.md",
      result: createResult(),
      subAgentManager: { spawn, waitForResult },
      verifierService: {
        shouldVerifySubAgentResult: vi.fn(() => true),
      },
    });

    expect(updated.completionState).toBe("partial");
    expect(updated.content).toContain("Build fails under verifier-run acceptance checks.");
    expect(updated.stopReasonDetail).toContain("Top-level verifier fail");
  });

  it("skips verifier workers for non-workflow turns", async () => {
    const spawn = vi.fn(async () => "subagent:verify-1");

    const updated = await maybeRunTopLevelVerifier({
      sessionId: "session:test",
      userRequest: "hello",
      result: createResult({
        turnExecutionContract: {
          ...createResult().turnExecutionContract,
          turnClass: "dialogue",
          ownerMode: "none",
          targetArtifacts: [],
        },
      }),
      subAgentManager: { spawn, waitForResult: vi.fn(async () => null) },
      verifierService: {
        shouldVerifySubAgentResult: vi.fn(() => true),
      },
    });

    expect(spawn).not.toHaveBeenCalled();
    expect(updated.completionState).toBe("completed");
  });
});
