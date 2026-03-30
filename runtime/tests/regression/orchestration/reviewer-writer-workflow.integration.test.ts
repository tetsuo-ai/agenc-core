import { describe, expect, it, vi } from "vitest";

import { ChatExecutor, type ChatExecuteParams } from "../../../src/llm/chat-executor.js";
import type {
  LLMChatOptions,
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
      .fn<[LLMMessage[], LLMChatOptions?], Promise<LLMResponse>>()
      .mockResolvedValue(mockResponse()),
    chatStream: vi
      .fn<[LLMMessage[], StreamProgressCallback, LLMChatOptions?], Promise<LLMResponse>>()
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

function createParams(
  overrides: Partial<ChatExecuteParams> = {},
): ChatExecuteParams {
  return {
    message: createMessage("hello"),
    history: [],
    systemPrompt: "You are a helpful assistant.",
    sessionId: "session-1",
    ...overrides,
  };
}

function plannerScopePath(workspaceRoot: string, entry: string): string {
  if (!entry || entry === ".") return workspaceRoot;
  if (entry.startsWith("/")) return entry;
  return `${workspaceRoot.replace(/\/+$/, "")}/${entry.replace(/^\/+/, "")}`;
}

function plannerReadOnlyExecutionContext(
  workspaceRoot: string,
  target = "PLAN.md",
): Record<string, unknown> {
  const targetPath = plannerScopePath(workspaceRoot, target);
  return {
    version: "v1",
    workspace_root: workspaceRoot,
    allowed_read_roots: [workspaceRoot],
    required_source_artifacts: [targetPath],
    input_artifacts: [targetPath],
    effect_class: "read_only",
    verification_mode: "grounded_read",
    step_kind: "delegated_review",
    role: "reviewer",
    artifact_relations: [
      {
        relation_type: "read_dependency",
        artifact_path: targetPath,
      },
    ],
  };
}

function plannerWriteExecutionContext(
  workspaceRoot: string,
  target = "PLAN.md",
): Record<string, unknown> {
  const targetPath = plannerScopePath(workspaceRoot, target);
  return {
    version: "v1",
    workspace_root: workspaceRoot,
    allowed_read_roots: [workspaceRoot],
    allowed_write_roots: [workspaceRoot],
    required_source_artifacts: [targetPath],
    target_artifacts: [targetPath],
    effect_class: "filesystem_write",
    verification_mode: "mutation_required",
    step_kind: "delegated_write",
    role: "writer",
    artifact_relations: [
      {
        relation_type: "read_dependency",
        artifact_path: targetPath,
      },
      {
        relation_type: "write_owner",
        artifact_path: targetPath,
      },
    ],
  };
}

function completedDelegatedPlannerResult(
  output: string,
  toolCalls:
    | readonly string[]
    | readonly {
        readonly name?: string;
        readonly args?: unknown;
        readonly result?: string;
        readonly isError?: boolean;
      }[] = ["system.readFile"],
): string {
  return safeJson({
    status: "completed",
    output,
    success: true,
    durationMs: 12,
    failedToolCalls: 0,
    toolCalls: toolCalls.map((entry) =>
      typeof entry === "string"
        ? {
            name: entry,
            isError: false,
          }
        : {
            ...entry,
            isError: entry.isError === true,
          },
    ),
  });
}

function buildRequiredReviewerWriterPlan(workspaceRoot: string): unknown {
  const reviewerDefs = [
    ["architecture_review", "Review architecture alignment only."],
    ["qa_review", "Review QA and test coverage only."],
    ["security_review", "Review security risks only."],
    ["documentation_review", "Review documentation clarity only."],
    ["layout_review", "Review directory layout alignment only."],
    ["completeness_review", "Review completeness and remaining gaps only."],
  ] as const;

  const reviewerSteps = reviewerDefs.map(([name, objective], index) => ({
    name,
    step_type: "subagent_task",
    objective,
    input_contract: `Return grounded findings for ${name}.`,
    acceptance_criteria: [`${name} findings are grounded`],
    required_tool_capabilities: ["system.readFile", "system.listDir"],
    context_requirements: ["repo_context", "plan_context"],
    execution_context: plannerReadOnlyExecutionContext(workspaceRoot),
    max_budget_hint: "2m",
    can_run_parallel: false,
    ...(index > 0 ? { depends_on: [reviewerDefs[index - 1]![0]] } : {}),
  }));

  return {
    reason: "required_plan_review",
    requiresSynthesis: true,
    steps: [
      ...reviewerSteps,
      {
        name: "update_plan_md",
        step_type: "subagent_task",
        objective: "Update PLAN.md with the integrated reviewer findings.",
        input_contract:
          "The six required reviewer outputs have already been produced and must be incorporated into PLAN.md.",
        acceptance_criteria: [
          "PLAN.md is updated with the integrated reviewer findings",
        ],
        required_tool_capabilities: ["system.readFile", "system.writeFile"],
        context_requirements: ["repo_context", "reviewer_outputs"],
        execution_context: plannerWriteExecutionContext(workspaceRoot),
        max_budget_hint: "4m",
        can_run_parallel: false,
        depends_on: ["completeness_review"],
      },
    ],
  };
}

function buildSuccessfulReviewerWriterResults(workspaceRoot: string): Record<string, string> {
  const targetPath = `${workspaceRoot}/PLAN.md`;
  const reviewerToolCalls = [
    {
      name: "system.listDir",
      args: { path: workspaceRoot },
      result: safeJson({ path: workspaceRoot, entries: ["PLAN.md", "src", "tests"] }),
      isError: false,
    },
    {
      name: "system.readFile",
      args: { path: targetPath },
      result: safeJson({
        path: targetPath,
        content:
          "# PLAN\nCurrent architecture, QA, security, documentation, layout, and completeness sections.\n",
      }),
      isError: false,
    },
  ];
  return {
    architecture_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-arch",
      output:
        "Grounded architecture findings from PLAN.md and the current workspace layout: the architecture section still needs the latest runtime cleanup notes.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    qa_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-qa",
      output:
        "Grounded QA findings from PLAN.md and the current workspace layout: the QA section still needs the exact regression coverage added in runtime/tests/regression/orchestration.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    security_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-sec",
      output:
        "Grounded security findings from PLAN.md and the current workspace layout: the plan should keep fail-closed provider routing called out explicitly.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    documentation_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-docs",
      output:
        "Grounded documentation findings from PLAN.md and the current workspace layout: the plan wording should reflect the new canonical workflow contract and incident corpus.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    layout_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-layout",
      output:
        "Grounded layout findings from PLAN.md and the current workspace layout: the eval and regression files now sit in the expected runtime/src/eval and tests/regression/orchestration roots.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    completeness_review: safeJson({
      status: "completed",
      subagentSessionId: "sub-complete",
      output:
        "Grounded completeness findings from PLAN.md and the current workspace layout: the remaining gaps are the exact reviewer/writer orchestration regression and the expanded incident fixtures.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: reviewerToolCalls,
    }),
    update_plan_md: safeJson({
      status: "completed",
      subagentSessionId: "sub-writer",
      output:
        "Updated PLAN.md with the integrated reviewer findings after grounding the current workspace state and target artifact.",
      success: true,
      durationMs: 12,
      failedToolCalls: 0,
      toolCalls: [
        {
          name: "system.listDir",
          args: { path: workspaceRoot },
          result: safeJson({ path: workspaceRoot, entries: ["PLAN.md", "src"] }),
          isError: false,
        },
        {
          name: "system.readFile",
          args: { path: targetPath },
          result: safeJson({ path: targetPath, size: 5614 }),
          isError: false,
        },
        {
          name: "system.writeFile",
          args: {
            path: targetPath,
            content: "# PLAN\nUpdated from required reviewer outputs.\n",
          },
          result: safeJson({
            path: targetPath,
            bytesWritten: 44,
          }),
          isError: false,
        },
      ],
    }),
  };
}

describe("reviewer/writer orchestration regression", () => {
  it("executes the exact 6 reviewers + 1 writer workflow end to end", async () => {
    const workspaceRoot = "/home/tetsuo/git/stream-test/agenc-shell";
    const provider = createMockProvider("primary", {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            content: safeJson({
              reason: "collapsed_multi_agent_review",
              requiresSynthesis: false,
              steps: [
                {
                  name: "combined_review",
                  step_type: "subagent_task",
                  objective:
                    "Review architecture, QA, security, documentation, layout, and completeness in one pass.",
                  input_contract: "Return consolidated findings",
                  acceptance_criteria: ["Provide consolidated findings"],
                  required_tool_capabilities: ["system.readFile"],
                  context_requirements: ["repo_context", "read_plan_md"],
                  max_budget_hint: "4m",
                  can_run_parallel: false,
                },
              ],
            }),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content: safeJson(buildRequiredReviewerWriterPlan(workspaceRoot)),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Updated PLAN.md after six grounded child reviews and one typed writer step.",
          }),
        ),
    });
    const pipelineExecutor = {
      execute: vi.fn().mockResolvedValue({
        status: "completed",
        completionState: "completed",
        context: {
          results: buildSuccessfulReviewerWriterResults(workspaceRoot),
        },
        completedSteps: 7,
        totalSteps: 7,
      }),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn().mockResolvedValue("unused"),
      plannerEnabled: true,
      pipelineExecutor: pipelineExecutor as any,
      delegationDecision: {
        enabled: true,
        scoreThreshold: 0.99,
        maxFanoutPerTurn: 1,
      },
    });

    const result = await executor.execute(
      createParams({
        message: createMessage(
          "Read PLAN.md, create 6 agents with different roles to review architecture, QA, security, documentation, layout, and completeness, then update PLAN.md with the synthesized result.",
        ),
        runtimeContext: {
          workspaceRoot,
        },
      }),
    );

    expect(provider.chat).toHaveBeenCalledTimes(3);
    expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
    expect(result.callUsage.map((entry) => entry.phase)).toEqual([
      "planner",
      "planner",
      "planner_synthesis",
    ]);
    expect(result.stopReason).toBe("completed");
    expect(result.completionState).toBe("completed");
    expect(result.content).toContain(
      "Updated PLAN.md after six grounded child reviews",
    );
    expect(result.plannerSummary?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "required_subagent_steps_missing",
        }),
        expect.objectContaining({
          code: "planner_required_orchestration_retry",
        }),
      ]),
    );
  });

  it("fails the exact workflow when one required reviewer child does not complete", async () => {
    const workspaceRoot = "/home/tetsuo/git/stream-test/agenc-shell";
    const provider = createMockProvider("primary", {
      chat: vi
        .fn()
        .mockResolvedValueOnce(
          mockResponse({
            content: safeJson(buildRequiredReviewerWriterPlan(workspaceRoot)),
          }),
        )
        .mockResolvedValueOnce(
          mockResponse({
            content:
              "Planner synthesis reported that a required reviewer child did not complete, so the request remains unresolved.",
          }),
        ),
    });
    const pipelineExecutor = {
      execute: vi.fn().mockResolvedValue({
        status: "completed",
        completionState: "completed",
        context: {
          results: {
            ...buildSuccessfulReviewerWriterResults(workspaceRoot),
            security_review: safeJson({
              status: "delegation_fallback",
              output:
                "Security review could not complete because the child lost the required grounded review path.",
              success: false,
              failedToolCalls: 0,
              toolCalls: [
                {
                  name: "system.readFile",
                  args: { path: `${workspaceRoot}/PLAN.md` },
                  result: safeJson({ path: `${workspaceRoot}/PLAN.md`, size: 4096 }),
                  isError: false,
                },
              ],
            }),
          },
        },
        completedSteps: 7,
        totalSteps: 7,
      }),
    };
    const executor = new ChatExecutor({
      providers: [provider],
      toolHandler: vi.fn().mockResolvedValue("unused"),
      plannerEnabled: true,
      pipelineExecutor: pipelineExecutor as any,
      subagentVerifier: {
        enabled: false,
        force: false,
      },
      delegationDecision: {
        enabled: true,
        scoreThreshold: 0.99,
        maxFanoutPerTurn: 1,
      },
    });

    const result = await executor.execute(
      createParams({
        message: createMessage(
          "Review PLAN.md. Sub-agent orchestration plan (required): 1) `architecture_review`: review architecture. 2) `qa_review`: review QA. 3) `security_review`: review security. 4) `documentation_review`: review documentation. 5) `layout_review`: review layout. 6) `completeness_review`: review completeness. Then update PLAN.md with the integrated reviewer findings.",
        ),
        runtimeContext: {
          workspaceRoot,
        },
      }),
    );

    expect(provider.chat).toHaveBeenCalledTimes(2);
    expect(pipelineExecutor.execute).toHaveBeenCalledTimes(1);
    expect(result.stopReason).toBe("validation_error");
    expect(result.plannerSummary?.subagentVerification).toMatchObject({
      enabled: true,
      performed: true,
      overall: "fail",
    });
    expect(
      result.plannerSummary?.subagentVerification.unresolvedItems.join(" "),
    ).toContain("security_review");
    expect(result.content).toContain("required reviewer child did not complete");
  });
});
