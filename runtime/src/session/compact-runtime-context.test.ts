import { describe, expect, it, vi } from "vitest";
import { createSessionBackedCompactContext } from "./compact-runtime-context.js";
import type { Session } from "./session.js";

describe("createSessionBackedCompactContext", () => {
  it("reuses live session-backed runtime state instead of fabricating empty placeholders", () => {
    let currentMode = "plan";
    const readFileState = new Map<string, unknown>([
      ["/ws/app.ts", { content: "console.log('x')" }],
    ]);
    const loadedNestedMemoryPaths = new Set<string>(["/ws/AGENTS.md"]);
    const mcpClients = [{ name: "ide" }];
    const activeAgents = [{ name: "worker" }];
    const queryTracking = { chainId: "chain-1", depth: 2 };
    const setStreamMode = vi.fn();
    const setResponseLength = vi.fn();
    const onCompactProgress = vi.fn();
    const setSDKStatus = vi.fn();
    const addNotification = vi.fn();
    const clearProviderResponseId = vi.fn();

    const session = {
      abortController: new AbortController(),
      clearProviderResponseId,
      rolloutStore: undefined,
      services: {
        registry: {
          toLLMTools: () => [{ function: { name: "read_file" } }],
        },
        permissionModeRegistry: {
          current: () => ({
            mode: currentMode,
            additionalWorkingDirectories: new Map([
              ["/extra", { path: "/extra" }],
            ]),
          }),
        },
      },
      state: {
        unsafePeek: () => ({
          sessionConfiguration: {
            cwd: "/ws",
            collaborationMode: { model: "gpt-5" },
          },
        }),
      },
      readFileState,
      loadedNestedMemoryPaths,
      mcpClients,
      agentDefinitions: { activeAgents },
      queryTracking,
      setStreamMode,
      setResponseLength,
      onCompactProgress,
      setSDKStatus,
      addNotification,
    } as unknown as Session;

    const context = createSessionBackedCompactContext(session, {
      querySource: "compact",
      isNonInteractiveSession: true,
      verbose: false,
    });

    expect(context.readFileState).toBe(readFileState);
    expect(context.loadedNestedMemoryPaths).toBe(loadedNestedMemoryPaths);
    expect(context.options.mcpClients).toBe(mcpClients);
    expect(context.options.agentDefinitions.activeAgents).toEqual(activeAgents);
    expect(context.queryTracking).toEqual(queryTracking);
    expect(context.setStreamMode).toBe(setStreamMode);
    expect(context.setResponseLength).toBe(setResponseLength);
    expect(context.onCompactProgress).toBe(onCompactProgress);
    expect(context.setSDKStatus).toBe(setSDKStatus);
    expect(context.addNotification).toBe(addNotification);

    expect(context.getAppState().toolPermissionContext.mode).toBe("plan");
    currentMode = "acceptEdits";
    expect(context.getAppState().toolPermissionContext.mode).toBe("acceptEdits");

    context.clearProviderResponseId?.();
    expect(clearProviderResponseId).toHaveBeenCalledTimes(1);
  });
});
