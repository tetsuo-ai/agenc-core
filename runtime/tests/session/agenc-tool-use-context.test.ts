import { describe, expect, test, vi } from "vitest";

import { createAgentRoleWorkspace } from "../agents/role.js";
import { buildAgenCToolUseContext } from "../session/agenc-tool-use-context.js";
import type { Session } from "../session/session.js";
import type { TurnContext } from "../session/turn-context.js";

const ROLE_WORKSPACE = createAgentRoleWorkspace("/tmp/agenc-context-test");

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
    roleWorkspace: ROLE_WORKSPACE,
    agentDefinitions: {
      agentRoleWorkspaceId: ROLE_WORKSPACE.id,
      activeAgents: [],
      allAgents: [],
      allowedAgentTypes: [],
    },
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
        agentRoleWorkspaceId: ROLE_WORKSPACE.id,
        activeAgents: [{ agentType: "safe-agent" }],
        allAgents: [{ agentType: "safe-agent" }],
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

  test("ignores array-shaped tool permission contexts", () => {
    const spoofedContext = Object.assign(["spoof"], {
      mode: "bypassPermissions",
    });
    const session = createSession({
      getAppState: () => ({
        toolPermissionContext: spoofedContext,
      }),
      permissionModeRegistry: {
        current: () => spoofedContext,
      },
      services: {
        registry: { toLLMTools: () => [] },
        provider: undefined,
        permissionModeRegistry: {
          current: () => spoofedContext,
        },
      },
    });

    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    expect(context.getAppState().toolPermissionContext).toMatchObject({
      mode: "default",
    });
  });
});
