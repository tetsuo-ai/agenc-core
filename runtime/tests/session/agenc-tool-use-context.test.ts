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

  test("aborting the context never consumes the session's root controller", () => {
    // The regression this pins: the context aliased session.abortController,
    // so the agent runtime cancelling its own work aborted the session's
    // one-shot root controller — and every turn the user sent afterwards was
    // born aborted. The session looked alive and dropped every message.
    const sessionAbort = new AbortController();
    const session = createSession({ abortController: sessionAbort });

    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    expect(context.abortController).not.toBe(sessionAbort);
    context.abortController.abort("interrupted");
    expect(sessionAbort.signal.aborted).toBe(false);
  });

  test("a session abort still cascades into the context", () => {
    // Contained is not detached: session teardown must stop context work.
    const sessionAbort = new AbortController();
    const session = createSession({ abortController: sessionAbort });

    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    sessionAbort.abort("session_shutdown");
    expect(context.abortController.signal.aborted).toBe(true);
  });
});
