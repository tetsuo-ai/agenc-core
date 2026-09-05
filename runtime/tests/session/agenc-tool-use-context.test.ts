import { describe, expect, test, vi } from "vitest";

import { createAgentRoleWorkspace } from "../agents/role.js";
import { buildAgenCToolUseContext } from "../session/agenc-tool-use-context.js";
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
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
      skillsManager: {
        skillsForConfig: vi.fn(async () => ({ invokedSkills: [] })),
      },
    },
    config: {},
    emit: vi.fn(),
    nextInternalSubId: () => "internal-1",
    ...overrides,
  };
}

describe("buildAgenCToolUseContext", () => {
  test("carries the exact admitted prompt snapshot into tool execution", () => {
    const session = createSession();
    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      {
        ...createTurnContext(),
        baseInstructions: "base prompt",
        developerInstructions: "developer prompt",
        userInstructions: "user prompt",
      } as TurnContext,
      { llmTools: [] },
    );

    expect(context.renderedSystemPrompt).toEqual([
      "base prompt\n\ndeveloper prompt\n\nuser prompt",
    ]);
  });

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

  test("projects the canonical session cost cap into attachment context", () => {
    const session = createSession({
      config: { maxBudgetUsd: 7.25 },
    });

    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    expect(context.options.maxBudgetUsd).toBe(7.25);
  });

  test("keeps skill discovery and attachment triggers on the exact session", () => {
    const managerA = {
      skillsForConfig: vi.fn(async () => ({ invokedSkills: [] })),
    };
    const managerB = {
      skillsForConfig: vi.fn(async () => ({ invokedSkills: [] })),
    };
    const sessionA = createSession({
      conversationId: "session-a",
      services: {
        registry: { toLLMTools: () => [] },
        provider: undefined,
        skillsManager: managerA,
      },
    });
    const sessionB = createSession({
      conversationId: "session-b",
      services: {
        registry: { toLLMTools: () => [] },
        provider: undefined,
        skillsManager: managerB,
      },
    });

    const contextA = buildAgenCToolUseContext(
      sessionA as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );
    const contextB = buildAgenCToolUseContext(
      sessionB as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );
    contextA.dynamicSkillDirTriggers.add("/tmp/session-a/.agenc/skills");
    const contextAAgain = buildAgenCToolUseContext(
      sessionA as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );

    expect(contextA.skillsManager).toBe(managerA);
    expect(contextB.skillsManager).toBe(managerB);
    expect(contextAAgain.dynamicSkillDirTriggers).toBe(
      contextA.dynamicSkillDirTriggers,
    );
    expect([...contextAAgain.dynamicSkillDirTriggers]).toEqual([
      "/tmp/session-a/.agenc/skills",
    ]);
    expect(contextB.dynamicSkillDirTriggers.size).toBe(0);
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

describe("daemon sessions route tool permission changes through the registry", () => {
  test("EnterPlanMode's update lands in the registry and is visible to the next read", async () => {
    const registry = new PermissionModeRegistry(createEmptyToolPermissionContext());
    const changes: string[] = [];
    registry.subscribeToModeChange((next, previous) => {
      changes.push(`${previous}->${next}`);
    });
    const session = createSession({
      permissionModeRegistry: registry,
      services: {
        registry: { toLLMTools: () => [] },
        provider: undefined,
        permissionModeRegistry: registry,
        skillsManager: {
          skillsForConfig: vi.fn(async () => ({ invokedSkills: [] })),
        },
      },
    });
    const context = buildAgenCToolUseContext(
      session as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );
    const before = context.getAppState().toolPermissionContext as {
      readonly mode: string;
    };
    expect(before.mode).toBe("default");
    expect(context.setAppState).toBeDefined();

    context.setAppState!((prev: { toolPermissionContext: Record<string, unknown> }) => ({
      ...prev,
      toolPermissionContext: {
        ...prev.toolPermissionContext,
        mode: "plan",
        prePlanMode: "default",
      },
    }));
    await vi.waitFor(() => expect(registry.current().mode).toBe("plan"));
    expect(
      (context.getAppState().toolPermissionContext as { mode: string }).mode,
    ).toBe("plan");
    expect(changes).toEqual(["default->plan"]);

    // ExitPlanMode compares against the snapshot it read; a stale snapshot
    // must not move the live context.
    context.setAppState!((prev: { toolPermissionContext: unknown }) =>
      prev.toolPermissionContext === before
        ? { ...prev, toolPermissionContext: { mode: "acceptEdits" } }
        : prev,
    );
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(registry.current().mode).toBe("plan");
    expect(changes).toEqual(["default->plan"]);

    // Returning the same snapshot publishes nothing.
    context.setAppState!((prev: unknown) => prev);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(changes).toEqual(["default->plan"]);
  });

  test("an explicit app-state store still wins", () => {
    const setAppState = vi.fn();
    const context = buildAgenCToolUseContext(
      createSession({ setAppState }) as unknown as Session,
      createTurnContext(),
      { llmTools: [] },
    );
    expect(context.setAppState).toBe(setAppState);
  });
});
