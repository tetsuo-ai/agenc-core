import { describe, expect, it, vi } from "vitest";

vi.mock("../tui/ink.js", () => ({
  Box: () => null,
  Text: () => null,
  useApp: () => ({ exit: () => {} }),
  useTerminalFocus: () => true,
  useTerminalTitle: () => {},
}));

vi.mock("bun:bundle", () => ({
  feature: () => false,
}));

vi.mock("../agenc/adapters/upstream-commands.js", () => ({
  loadUpstreamCommandList: () => [],
}));

vi.mock("../agenc/adapters/upstream-agent-list.js", () => ({
  loadUpstreamAgentList: () => [],
}));

vi.mock("../agenc/adapters/upstream-model-switch.js", () => ({
  buildPendingProviderSwitch: () => null,
}));

vi.mock("../agenc/adapters/upstream-attachments.js", () => ({
  pastedContentsToLLMMessage: () => null,
}));

vi.mock("../agenc/upstream/tools.js", () => ({
  assembleToolPool: () => [],
  filterToolsByDenyRules: (tools: unknown) => tools,
  getAllBaseTools: () => [],
  getTools: () => [],
  getToolsForDefaultPreset: () => [],
  parseToolPreset: () => [],
}));

vi.mock("src/tools.js", () => ({
  assembleToolPool: () => [],
  filterToolsByDenyRules: (tools: unknown) => tools,
  getAllBaseTools: () => [],
  getTools: () => [],
}));

vi.mock("../agenc/upstream/context/fpsMetrics.js", () => ({
  FpsMetricsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("../agenc/upstream/context/stats.js", () => ({
  StatsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("../agenc/upstream/state/onChangeAppState.js", () => ({
  onChangeAppState: () => {},
}));

vi.mock("../tui/components/Messages.js", () => ({
  Messages: () => null,
}));

vi.mock("../tui/components/PromptInput/PromptInput.js", () => ({
  default: () => null,
}));

vi.mock("../tui/context/promptOverlayContext.js", () => ({
  PromptOverlayProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("../tui/keybindings/KeybindingProviderSetup.js", () => ({
  KeybindingSetup: ({ children }: { children: unknown }) => children,
}));

vi.mock("../tui/permission-requests.js", () => ({
  AgenCPermissionOverlay: () => null,
  buildToolUseConfirmQueue: () => [],
  usePermissionRequests: () => [],
}));

vi.mock("../tui/session-transcript.js", () => ({
  useSessionTranscript: () => ({
    messages: [],
    toolNames: [],
    isStreaming: false,
    inProgressToolUseIDs: [],
    streamingToolUses: [],
    streamingText: "",
  }),
}));

vi.mock("../tui/tool-jsx-state.js", () => ({
  useToolJSX: () => [null, () => {}],
}));

vi.mock("../tui/tool-rendering.js", () => ({
  createTuiTools: () => [],
}));

import { AsyncQueue } from "../utils/async-queue.js";
import {
  Session,
  type Event,
  type SessionOpts,
  type SessionServices,
} from "../session/session.js";
import type {
  Config,
  ManagedFeatures,
  ModelInfo,
  SessionConfiguration,
} from "../session/turn-context.js";
import type { LLMProvider } from "../llm/types.js";
import type {
  McpElicitationRequest,
  RequestUserInputArgs,
  RequestUserInputResponse,
} from "./types.js";
import { installElicitationResolvers } from "../tui/components/App.js";

function mkFeatures(): ManagedFeatures {
  return {
    appsEnabledForAuth: () => false,
    useLegacyLandlock: () => false,
  };
}

function mkConfig(): Config {
  return {
    model: "test-model",
    cwd: "/tmp",
    features: mkFeatures(),
    multiAgentV2: {
      usageHintEnabled: false,
      usageHintText: "",
      hideSpawnAgentMetadata: false,
    },
    permissions: {
      allowLoginShell: false,
      shellEnvironmentPolicy: {
        allowedEnvVars: [],
        blockedEnvVars: [],
      },
      windowsSandboxPrivateDesktop: false,
    },
    ghostSnapshot: { enabled: false },
    agentRoles: [],
  };
}

function mkModelInfo(): ModelInfo {
  return {
    slug: "test-model",
    effectiveContextWindowPercent: 100,
    contextWindow: 1024,
    supportedReasoningLevels: [],
    defaultReasoningSummary: "auto",
    truncationPolicy: "off",
    usedFallbackModelMetadata: false,
  };
}

function mkSessionConfiguration(): SessionConfiguration {
  return {
    cwd: "/tmp",
    approvalPolicy: { value: "never" },
    sandboxPolicy: { value: "read_only" },
    fileSystemSandboxPolicy: {
      allowWrite: [],
      denyWrite: [],
      allowRead: [],
      denyRead: [],
    },
    networkSandboxPolicy: {
      allowlist: [],
      denylist: [],
      allowManagedDomainsOnly: false,
    },
    windowsSandboxLevel: "none",
    collaborationMode: { model: "test-model" },
    dynamicTools: [],
    sessionSource: "cli_main",
  };
}

function mkProvider(): LLMProvider {
  return {
    name: "stub-provider",
    chat: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
    chatStream: async () => ({
      content: "",
      toolCalls: [],
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      model: "test-model",
      finishReason: "stop",
    }),
  } as unknown as LLMProvider;
}

function buildSession(): Session {
  const services = {
    mcpConnectionManager: {
      setApprovalPolicy: () => {},
      setSandboxPolicy: () => {},
      requiredStartupFailures: async () => [],
    },
    mcpStartupCancellationToken: {
      cancel: () => {},
      isCancelled: () => false,
    },
    provider: mkProvider(),
    registry: {
      tools: [],
      toLLMTools: () => [],
      dispatch: async () => ({ content: "", isError: false }),
    },
  } as unknown as SessionServices;
  const opts: SessionOpts = {
    conversationId: "conv-elicitation",
    initialState: {
      sessionConfiguration: mkSessionConfiguration(),
      history: [],
    },
    features: mkFeatures(),
    services,
    jsRepl: { id: "repl-elicitation" },
    config: mkConfig(),
    modelInfo: mkModelInfo(),
    eventQueue: new AsyncQueue<Event>(),
  };
  return new Session(opts);
}

const flush = (): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });

const USER_INPUT_ARGS: RequestUserInputArgs = {
  questions: [
    {
      id: "choice",
      header: "Choice",
      question: "Proceed?",
      isOther: true,
      isSecret: false,
      options: [
        { label: "Yes (Recommended)", description: "Continue." },
      ],
    },
  ],
};

const USER_INPUT_RESPONSE: RequestUserInputResponse = {
  answers: { choice: { answers: ["Yes"] } },
};

const FORM_REQUEST: McpElicitationRequest = {
  mode: "form",
  message: "Need details",
  requestedSchema: {
    type: "object",
    properties: { name: { type: "string" } },
  },
};

const URL_REQUEST: McpElicitationRequest = {
  mode: "url",
  message: "Authorize",
  elicitationId: "url-1",
  url: "https://127.0.0.1/auth",
};

describe("Session elicitation pending responders", () => {
  it("returns null when no active turn can own the prompt", async () => {
    const session = buildSession();
    await expect(
      session.requestUserInput("call-1", USER_INPUT_ARGS),
    ).resolves.toBeNull();
    await expect(
      session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST),
    ).resolves.toBeNull();
  });

  it("emits request_user_input and resolves via notifyUserInputResponse", async () => {
    const session = buildSession();
    const events: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => events.push(event));
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });

    const pending = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();

    expect(events.map((event) => event.msg.type)).toContain("request_user_input");
    expect(
      events.find((event) => event.msg.type === "request_user_input")?.msg,
    ).toMatchObject({
      type: "request_user_input",
      payload: {
        requestId: "call-1",
        callId: "call-1",
        turnId: "turn-1",
        questions: USER_INPUT_ARGS.questions,
      },
    });
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(1);
    await expect(
      session.notifyUserInputResponse("call-1", USER_INPUT_RESPONSE),
    ).resolves.toBe(true);
    await expect(pending).resolves.toEqual(USER_INPUT_RESPONSE);
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(0);

    unsubscribe();
  });

  it("delegates request_user_input through an installed direct resolver", async () => {
    const session = buildSession();
    const events: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => events.push(event));
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const resolver = vi.fn().mockResolvedValue(USER_INPUT_RESPONSE);
    session.services.requestUserInputResolver = { request: resolver };

    const pending = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();

    expect(resolver).toHaveBeenCalledWith(
      {
        requestId: "call-1",
        callId: "call-1",
        turnId: "turn-1",
        questions: USER_INPUT_ARGS.questions,
      },
      expect.any(AbortSignal),
    );
    expect(
      events.find((event) => event.msg.type === "request_user_input")?.msg,
    ).toMatchObject({
      type: "request_user_input",
      payload: { requestId: "call-1", callId: "call-1", turnId: "turn-1" },
    });
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(0);
    await expect(pending).resolves.toEqual(USER_INPUT_RESPONSE);

    unsubscribe();
  });

  it("resolves direct TUI resolver submission through the original request_user_input promise", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const prompts: unknown[] = [];
    const controller = installElicitationResolvers(session, (pending) => {
      prompts.push(pending);
    });

    const pending = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();

    expect((prompts.at(-1) as { readonly kind?: unknown } | undefined)?.kind)
      .toBe("user");
    expect(controller.submit("Yes")).toBe(true);
    await expect(pending).resolves.toEqual({
      answers: { choice: { answers: ["Yes"] } },
    });

    controller.cleanup();
  });

  it("propagates direct TUI resolver cleanup as request_user_input cancellation", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const controller = installElicitationResolvers(session, () => {});

    const pending = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();
    controller.cleanup();

    await expect(pending).resolves.toBeNull();
  });

  it("propagates aborts into direct TUI request_user_input prompts", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const prompts: unknown[] = [];
    const renderer = installElicitationResolvers(session, (pending) => {
      prompts.push(pending);
    });
    const controller = new AbortController();

    const pending = session.requestUserInput(
      "call-1",
      USER_INPUT_ARGS,
      controller.signal,
    );
    await flush();
    expect((prompts.at(-1) as { readonly kind?: unknown } | undefined)?.kind)
      .toBe("user");

    controller.abort("test_abort");

    await expect(pending).resolves.toBeNull();
    expect(prompts.at(-1)).toBeNull();
    renderer.cleanup();
  });

  it("keeps overlapping request_user_input waits keyed by call id", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });

    const first = session.requestUserInput("call-1", USER_INPUT_ARGS);
    const second = session.requestUserInput("call-2", USER_INPUT_ARGS);
    await flush();

    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(2);
    await expect(
      session.notifyUserInputResponse("call-2", {
        answers: { choice: { answers: ["Second"] } },
      }),
    ).resolves.toBe(true);
    await expect(second).resolves.toEqual({
      answers: { choice: { answers: ["Second"] } },
    });
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(1);

    await expect(
      session.notifyUserInputResponse("call-1", USER_INPUT_RESPONSE),
    ).resolves.toBe(true);
    await expect(first).resolves.toEqual(USER_INPUT_RESPONSE);
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(0);
  });

  it("delegates MCP elicitations through an installed direct resolver", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const resolver = vi.fn().mockResolvedValue({ action: "decline" });
    session.services.mcpElicitationResolver = { request: resolver };

    const pending = session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST);
    await flush();

    expect(resolver).toHaveBeenCalledWith(
      {
        turnId: "turn-1",
        serverName: "srv",
        requestId: "mcp-1",
        request: FORM_REQUEST,
      },
      expect.any(AbortSignal),
    );
    await expect(
      session.withActiveTurnState((state) => state.pendingElicitations.size),
    ).resolves.toBe(0);
    await expect(pending).resolves.toEqual({ action: "decline" });
  });

  it("resolves direct TUI URL elicitations through completion notifications", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const controller = installElicitationResolvers(session, () => {});

    const pending = session.requestMcpElicitation("srv", "url-1", URL_REQUEST);
    await flush();
    session.emit({
      id: "complete-1",
      msg: {
        type: "mcp_elicitation_complete",
        payload: { serverName: "srv", elicitationId: "url-1" },
      },
    });

    await expect(pending).resolves.toEqual({ action: "accept" });
    controller.cleanup();
  });

  it("propagates aborts into direct TUI MCP prompts", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const prompts: unknown[] = [];
    const renderer = installElicitationResolvers(session, (pending) => {
      prompts.push(pending);
    });
    const controller = new AbortController();

    const pending = session.requestMcpElicitation(
      "srv",
      "mcp-1",
      FORM_REQUEST,
      controller.signal,
    );
    await flush();
    expect((prompts.at(-1) as { readonly kind?: unknown } | undefined)?.kind)
      .toBe("mcp-form");

    controller.abort("test_abort");

    await expect(pending).resolves.toBeNull();
    expect(prompts.at(-1)).toBeNull();
    renderer.cleanup();
  });

  it("cleans up user-input waits on abort", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const controller = new AbortController();
    const pending = session.requestUserInput(
      "call-1",
      USER_INPUT_ARGS,
      controller.signal,
    );
    await flush();
    controller.abort("test_abort");

    await expect(pending).resolves.toBeNull();
    await expect(
      session.withActiveTurnState((state) => state.pendingUserInput.size),
    ).resolves.toBe(0);
  });

  it("keeps MCP pause true until overlapping elicitations are resolved", async () => {
    const session = buildSession();
    const events: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => events.push(event));
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });

    const first = session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST);
    const second = session.requestMcpElicitation("srv", "mcp-2", FORM_REQUEST);
    await flush();

    expect(session.outOfBandElicitationPaused.value).toBe(true);
    expect(
      events.filter((event) => event.msg.type === "mcp_elicitation_request"),
    ).toHaveLength(2);
    await expect(
      session.withActiveTurnState((state) => state.pendingElicitations.size),
    ).resolves.toBe(2);

    await expect(
      session.notifyMcpElicitationResponse("srv", "mcp-1", {
        action: "accept",
        content: { name: "AgenC" },
      }),
    ).resolves.toBe(true);
    await expect(first).resolves.toEqual({
      action: "accept",
      content: { name: "AgenC" },
    });
    expect(session.outOfBandElicitationPaused.value).toBe(true);

    await expect(
      session.notifyMcpElicitationResponse("srv", "mcp-2", {
        action: "decline",
      }),
    ).resolves.toBe(true);
    await expect(second).resolves.toEqual({ action: "decline" });
    expect(session.outOfBandElicitationPaused.value).toBe(false);
    await expect(
      session.withActiveTurnState((state) => state.pendingElicitations.size),
    ).resolves.toBe(0);

    unsubscribe();
  });
});
