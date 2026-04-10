import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "./chat-executor.js";
import type { ChatExecuteParams } from "./chat-executor.js";
import { evaluateArtifactEvidenceGate } from "./chat-executor-stop-gate.js";
import type { ActiveTaskContext } from "./turn-execution-contract-types.js";
import type {
  LLMChatOptions,
  LLMMessage,
  LLMProvider,
  LLMResponse,
} from "./types.js";
import type { GatewayMessage } from "../gateway/message.js";

const WORKSPACE_ROOT = "/tmp/chat-executor-test-workspace";

function mockResponse(overrides: Partial<LLMResponse> = {}): LLMResponse {
  return {
    content: "mock response",
    toolCalls: [],
    usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 },
    model: "mock-model",
    finishReason: "stop",
    ...overrides,
  };
}

function safeJson(value: unknown): string {
  return JSON.stringify(value);
}

function createMockProvider(
  name = "primary",
  overrides: Partial<LLMProvider> = {},
): LLMProvider {
  return {
    name,
    chat: vi
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content = "hello"): GatewayMessage {
  return {
    id: "msg-1",
    channel: "test",
    senderId: "user-1",
    senderName: "Test User",
    sessionId: "session-1",
    content,
    timestamp: Date.now(),
    scope: "dm",
  };
}

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage("Implement every phase"),
    history: [],
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
    runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
    ...overrides,
  };
}

describe("top-level artifact evidence gate", () => {
  it("forces a recovery tool turn for carried workflow implementation tasks", async () => {
    const activeTaskContext: ActiveTaskContext = {
      version: 1,
      taskLineageId: "task-1",
      contractFingerprint: "carryover-contract",
      turnClass: "workflow_implementation",
      ownerMode: "workflow_owner",
      workspaceRoot: WORKSPACE_ROOT,
      sourceArtifacts: [`${WORKSPACE_ROOT}/PLAN.md`],
      targetArtifacts: [
        `${WORKSPACE_ROOT}/src/lexer.c`,
        `${WORKSPACE_ROOT}/src/parser.c`,
      ],
    };

    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/lexer.c",
                  content: "lexer",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "All phases from PLAN.md have been fully implemented and integrated.",
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-2",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/parser.c",
                  content: "parser",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Implemented lexer and parser with grounded file writes.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      safeJson({ ok: true, path: args.path }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        runtimeContext: {
          workspaceRoot: WORKSPACE_ROOT,
          activeTaskContext,
        },
      }),
    );

    expect(result.stopReason).toBe("completed");
    expect(result.completionState).toBe("completed");
    expect(result.validationCode).toBeUndefined();
    expect(result.toolCalls.filter((call) => call.name === "system.writeFile")).toHaveLength(2);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(4);
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls[2]?.[1]).toMatchObject({
      toolChoice: "required",
    });
    expect(result.turnExecutionContract.turnClass).toBe("workflow_implementation");
    expect(result.turnExecutionContract.contractFingerprint).toBe("carryover-contract");
    expect(result.activeTaskContext?.taskLineageId).toBe("task-1");
  });

  it("fails the turn when target artifacts are still missing after the allowed attempts", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
        .mockResolvedValueOnce(
          mockResponse({
            content: "",
            finishReason: "tool_calls",
            toolCalls: [
              {
                id: "tc-1",
                name: "system.writeFile",
                arguments: safeJson({
                  path: "src/lexer.c",
                  content: "lexer",
                }),
              },
            ],
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "All phases from PLAN.md have been fully implemented and integrated.",
          }),
        ),
    });
    const toolHandler = vi.fn(async (_name: string, args: Record<string, unknown>) =>
      safeJson({ ok: true, path: args.path }),
    );
    const executor = new ChatExecutor({ providers: [provider], toolHandler });

    const result = await executor.execute(
      createParams({
        requiredToolEvidence: {
          maxCorrectionAttempts: 0,
          verificationContract: {
            workspaceRoot: WORKSPACE_ROOT,
            targetArtifacts: [
              `${WORKSPACE_ROOT}/src/lexer.c`,
              `${WORKSPACE_ROOT}/src/parser.c`,
            ],
          },
          completionContract: {
            taskClass: "artifact_only",
            placeholdersAllowed: false,
            partialCompletionAllowed: false,
          },
        },
      }),
    );

    expect(result.stopReason).toBe("validation_error");
    expect(result.validationCode).toBe("missing_file_mutation_evidence");
    expect(result.content).toContain(`${WORKSPACE_ROOT}/src/parser.c`);
    expect(result.completionState).toBe("partial");
    expect((provider.chat as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(2);
  });

  it("allows docs-only no-op completions when the target artifact was inspected", () => {
    const decision = evaluateArtifactEvidenceGate({
      runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
      requiredToolEvidence: {
        verificationContract: {
          workspaceRoot: WORKSPACE_ROOT,
          targetArtifacts: [`${WORKSPACE_ROOT}/README.md`],
        },
      },
      allToolCalls: [
        {
          name: "system.readFile",
          args: { path: "README.md" },
          result: safeJson({
            path: `${WORKSPACE_ROOT}/README.md`,
            content: "# Repo\n",
          }),
          isError: false,
          durationMs: 1,
        },
      ],
    });

    expect(decision.shouldIntervene).toBe(false);
  });

  it("allows grounded-read verifier turns when the target artifact was inspected", () => {
    const decision = evaluateArtifactEvidenceGate({
      runtimeContext: { workspaceRoot: WORKSPACE_ROOT },
      requiredToolEvidence: {
        executionEnvelope: {
          workspaceRoot: WORKSPACE_ROOT,
          targetArtifacts: [`${WORKSPACE_ROOT}/src/main.c`],
          verificationMode: "grounded_read",
        },
      },
      allToolCalls: [
        {
          name: "system.readFile",
          args: { path: "src/main.c" },
          result: safeJson({
            path: `${WORKSPACE_ROOT}/src/main.c`,
            content: "int main(void) { return 0; }\n",
          }),
          isError: false,
          durationMs: 1,
        },
      ],
    });

    expect(decision.shouldIntervene).toBe(false);
  });
});
