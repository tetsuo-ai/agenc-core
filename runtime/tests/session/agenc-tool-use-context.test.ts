import { describe, expect, test, vi } from "vitest";

import { buildAgenCToolUseContext } from "../session/agenc-tool-use-context.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";

function createTurnContext(): TurnContext {
  return {
    cwd: "/tmp/agenc-context-test",
    modelInfo: {
      slug: "test-model",
      contextWindow: 200_000,
      effectiveContextWindowPercent: 100,
      maxOutputTokens: 4096,
    },
  } as unknown as TurnContext;
}

function createSession(overrides: Record<string, unknown> = {}) {
  return {
    conversationId: "session-1",
    services: {
      registry: { toLLMTools: () => [] },
      provider: undefined,
    },
    emit: vi.fn(),
    nextInternalSubId: () => "internal-1",
    ...overrides,
  };
}

describe("buildAgenCToolUseContext", () => {
  test("ignores array-shaped app-state snapshots", () => {
    const arrayState = Object.assign([], {
      tasks: { unsafe: true },
      agentDefinitions: { activeAgents: ["unsafe-agent"] },
      elicitation: { queue: ["unsafe-question"] },
      promptSuggestionEnabled: "unsafe",
    });
    const session = createSession({
      tasks: { fallback: true },
      getAppState: () => arrayState,
      agentDefinitions: {
        activeAgents: [{ agentType: "safe-agent" }],
        allowedAgentTypes: ["safe-agent"],
      },
    });

    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    expect(context.getAppState()).toMatchObject({
      tasks: { fallback: true },
      agentDefinitions: {
        activeAgents: [{ agentType: "safe-agent" }],
        allowedAgentTypes: ["safe-agent"],
      },
      promptSuggestionEnabled: false,
      elicitation: { queue: [] },
    });
  });
});
