import { describe, expect, it, vi } from "vitest";

import { ChatExecutor } from "../../../src/llm/chat-executor.js";
import type {
  ChatExecuteParams,
  LLMMessage,
  LLMProvider,
  LLMResponse,
  StreamProgressCallback,
} from "../../../src/llm/types.js";
import type { GatewayMessage } from "../../../src/gateway/message.js";

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
      .fn<[LLMMessage[], unknown?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<[LLMMessage[], StreamProgressCallback, unknown?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    healthCheck: vi.fn<[], Promise<boolean>>().mockResolvedValue(true),
    ...overrides,
  };
}

function createMessage(content: string): GatewayMessage {
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

function createParams(message: GatewayMessage): ChatExecuteParams {
  return {
    message,
    history: [],
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
  };
}

describe("delegation admission integration", () => {
  it("keeps trivial shared-context review inline even when the planner proposes delegation", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            content: safeJson({
              reason: "review_request",
              steps: [
                {
                  name: "review_plan",
                  step_type: "subagent_task",
                  objective: "Review PLAN.md and suggest three improvements",
                  input_contract: "Return three grounded review bullets",
                  acceptance_criteria: ["Every suggestion cites PLAN.md"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["PLAN.md"],
                  max_budget_hint: "2m",
                  can_run_parallel: false,
                },
              ],
            }),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: "Handled inline without spawning a child review.",
          }),
        ),
    });
    const pipelineExecutor = {
      execute: vi.fn(),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn().mockResolvedValue("unused"),
      plannerEnabled: true,
      pipelineExecutor: pipelineExecutor as never,
      delegationDecision: {
        enabled: true,
        scoreThreshold: 0,
      },
    });

    const result = await executor.execute(
      createParams(
        createMessage(
          "First inspect PLAN.md, then delegate a quick review and summarize the top three improvements.",
        ),
      ),
    );

    expect(pipelineExecutor.execute).not.toHaveBeenCalled();
    expect(result.content).toBe("Handled inline without spawning a child review.");
    expect(result.callUsage.map((entry) => entry.phase)).toEqual([
      "planner",
      "initial",
    ]);
    expect(result.plannerSummary?.routeReason).toBe(
      "delegation_veto_trivial_request",
    );
    expect(result.plannerSummary?.delegationDecision).toMatchObject({
      shouldDelegate: false,
      reason: "trivial_request",
    });
  });

  it("preserves bounded delegated investigation when the work is isolated and low-coupling", async () => {
    const provider = createMockProvider("primary", {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            content: safeJson({
              reason: "delegated_investigation",
              requiresSynthesis: true,
              steps: [
                {
                  name: "prep",
                  step_type: "deterministic_tool",
                  tool: "system.bash",
                  args: { command: "pwd" },
                },
                {
                  name: "delegate_logs",
                  step_type: "subagent_task",
                  objective: "Inspect flaky test logs and cluster timeout failures",
                  input_contract: "Return a JSON object with grounded findings",
                  acceptance_criteria: ["Include grounded log findings"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["ci_logs"],
                  max_budget_hint: "2m",
                  can_run_parallel: false,
                  depends_on: ["prep"],
                },
                {
                  name: "finalize",
                  step_type: "synthesis",
                  objective: "Summarize the findings",
                  depends_on: ["delegate_logs"],
                },
              ],
            }),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Clustered failures point to request timeouts in CI. delegate_logs [source:delegate_logs]",
          }),
        ),
    });
    const pipelineExecutor = {
      execute: vi.fn().mockResolvedValue({
        status: "completed",
        context: {
          results: {
            prep: '{"exitCode":0,"stdout":"/tmp\\n"}',
            delegate_logs:
              '{"status":"completed","output":"Clustered failures around request timeouts."}',
          },
        },
        completedSteps: 2,
        totalSteps: 2,
      }),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn().mockResolvedValue("unused"),
      plannerEnabled: true,
      pipelineExecutor: pipelineExecutor as never,
      delegationDecision: {
        enabled: true,
        scoreThreshold: 0,
      },
    });

    const result = await executor.execute(
      createParams(
        createMessage(
          "First run setup checks, then delegate deeper research, then synthesize results.",
        ),
      ),
    );

    expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("completed");
    expect(result.content).toContain("delegate_logs [source:delegate_logs]");
    expect(result.callUsage.map((entry) => entry.phase)).toEqual([
      "planner",
      "planner_synthesis",
    ]);
    expect(result.plannerSummary?.delegationDecision).toMatchObject({
      shouldDelegate: true,
      reason: "approved",
    });
    expect(result.plannerSummary?.routeReason).not.toContain("delegation_veto");
  });
});
