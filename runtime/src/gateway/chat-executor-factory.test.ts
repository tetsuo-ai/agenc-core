import { describe, expect, it, vi } from "vitest";

import { createChatExecutor } from "./chat-executor-factory.js";
import type { ResolvedSubAgentRuntimeConfig } from "./subagent-infrastructure.js";
import type { GatewayLLMConfig } from "./types.js";
import type { LLMProvider } from "../llm/types.js";

function createProvider(): LLMProvider {
  return {
    name: "primary",
    chat: vi.fn(),
    chatStream: vi.fn(),
    healthCheck: vi.fn().mockResolvedValue(true),
  } as unknown as LLMProvider;
}

function createSubagentConfig(
  overrides: Partial<ResolvedSubAgentRuntimeConfig> = {},
): ResolvedSubAgentRuntimeConfig {
  return {
    enabled: true,
    unsafeBenchmarkMode: true,
    mode: "manager_tools",
    delegationAggressiveness: "aggressive",
    maxConcurrent: 0,
    maxDepth: 0,
    maxFanoutPerTurn: 0,
    maxTotalSubagentsPerRequest: 0,
    maxCumulativeToolCallsPerRequestTree: 0,
    maxCumulativeTokensPerRequestTree: 0,
    maxCumulativeTokensPerRequestTreeExplicitlyConfigured: false,
    defaultTimeoutMs: 0,
    baseSpawnDecisionThreshold: 0,
    spawnDecisionThreshold: 0,
    handoffMinPlannerConfidence: 0.82,
    forceVerifier: false,
    allowParallelSubtasks: true,
    hardBlockedTaskClasses: [],
    childToolAllowlistStrategy: "inherit_intersection",
    childProviderStrategy: "same_as_parent",
    fallbackBehavior: "continue_without_delegation",
    policyLearningEnabled: false,
    policyLearningEpsilon: 0.1,
    policyLearningExplorationBudget: 0,
    policyLearningMinSamplesPerArm: 0,
    policyLearningUcbExplorationScale: 1,
    policyLearningArms: [],
    ...overrides,
  };
}

describe("createChatExecutor", () => {
  it("keeps planner verifier enabled in unsafe benchmark mode when subagents are enabled", () => {
    const executor = createChatExecutor({
      providers: [createProvider()],
      toolHandler: vi.fn(),
      allowedTools: ["system.readFile"],
      maxToolRounds: 0,
      llmConfig: {
        provider: "grok",
        model: "grok-code-fast-1",
        plannerEnabled: true,
      } as GatewayLLMConfig,
      subagentConfig: createSubagentConfig(),
      resolveDelegationScoreThreshold: () => 0,
      resolveHostToolingProfile: () => null,
      resolveHostWorkspaceRoot: () => null,
    });

    expect(executor).not.toBeNull();
    expect((executor as any).subagentVerifierConfig).toMatchObject({
      enabled: true,
      force: false,
    });
  });
});
