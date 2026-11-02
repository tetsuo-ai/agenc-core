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

vi.mock("../commands.js", () => ({
  listTuiCommandList: () => [],
}));

vi.mock("../agents/role-definitions.js", () => ({
  listAgentRoleDefinitions: () => [],
}));

vi.mock("../llm/pasted-content.js", () => ({
  pastedContentsToLLMMessage: () => null,
}));

vi.mock("../tools.js", () => ({
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

vi.mock("../tui/context/fpsMetrics.js", () => ({
  FpsMetricsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("../tui/context/stats.js", () => ({
  StatsProvider: ({ children }: { children: unknown }) => children,
}));

vi.mock("../tui/state/onChangeAppState.js", () => ({
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
import { PermissionModeRegistry } from "../permissions/permission-mode.js";
import { createEmptyToolPermissionContext } from "../permissions/types.js";
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
    permissionModeRegistry: new PermissionModeRegistry(
      createEmptyToolPermissionContext(),
    ),
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

  it("closes a direct TUI MCP form aborted after a field change and a validation error", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const prompts: Array<{ readonly kind?: unknown; readonly index?: unknown; readonly error?: unknown } | null> = [];
    const renderer = installElicitationResolvers(session, (pending) => {
      prompts.push(pending as (typeof prompts)[number]);
    });
    const serverCancel = new AbortController();
    const pending = session.requestMcpElicitation(
      "srv",
      "mcp-1",
      {
        mode: "form",
        message: "Create a profile",
        requestedSchema: {
          type: "object",
          required: ["name", "age"],
          properties: {
            name: { type: "string" },
            age: { type: "integer" },
          },
        },
      },
      serverCancel.signal,
    );
    await flush();
    expect(renderer.submit("Ada")).toBe(true);
    expect(renderer.submit("abc")).toBe(true);
    expect(prompts.at(-1)).toMatchObject({ kind: "mcp-form", index: 1, error: "age must be a number" });

    serverCancel.abort("server cancelled");

    await expect(pending).resolves.toBeNull();
    expect(prompts.at(-1)).toBeNull();
    // The next request shows at once instead of waiting behind the dead form.
    const next = session.requestMcpElicitation("srv", "mcp-2", FORM_REQUEST);
    await flush();
    expect(prompts.at(-1)).toMatchObject({ kind: "mcp-form", index: 0 });
    expect(renderer.submit("AgenC")).toBe(true);
    await expect(next).resolves.toEqual({ action: "accept", content: { name: "AgenC" } });
    renderer.cleanup();
  });

  it("closes a direct TUI question aborted after its first answer", async () => {
    const session = buildSession();
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    const prompts: Array<{ readonly kind?: unknown; readonly index?: unknown } | null> = [];
    const renderer = installElicitationResolvers(session, (pending) => {
      prompts.push(pending as (typeof prompts)[number]);
    });
    const toolCall = new AbortController();
    const pending = session.requestUserInput(
      "call-1",
      {
        questions: [
          { id: "first", header: "First", question: "First?", isOther: true, isSecret: false },
          { id: "second", header: "Second", question: "Second?", isOther: true, isSecret: false },
        ],
      },
      toolCall.signal,
    );
    await flush();
    expect(renderer.submit("one")).toBe(true);
    expect(prompts.at(-1)).toMatchObject({ kind: "user", index: 1 });

    toolCall.abort("interrupted");

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

describe("Session elicitation close notices", () => {
  function closedEvents(events: readonly Event[]): unknown[] {
    return events
      .filter((event) => event.msg.type === "elicitation_closed")
      .map((event) => event.msg.payload);
  }

  /** The identity of the nth request event of this type: what a close names. */
  function occurrenceOf(
    events: readonly Event[],
    type: "mcp_elicitation_request" | "request_user_input",
    nth = 0,
  ): { readonly requestEventId: string; readonly requestEventSeq: number } {
    const request = events.filter((event) => event.msg.type === type)[nth];
    expect(request?.seq).toEqual(expect.any(Number));
    expect(request?.eventId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
    return { requestEventId: request!.eventId!, requestEventSeq: request!.seq! };
  }

  async function startedSession(): Promise<{
    readonly session: Session;
    readonly events: Event[];
    readonly unsubscribe: () => void;
  }> {
    const session = buildSession();
    const events: Event[] = [];
    const unsubscribe = session.eventLog.subscribe((event) => events.push(event));
    await session.spawnTask({ subId: "turn-1", kind: "regular", autoStart: false });
    return { session, events, unsubscribe };
  }

  it("announces an MCP elicitation the MCP server cancelled before any answer", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const serverCancel = new AbortController();
    const pending = session.requestMcpElicitation(
      "srv",
      7,
      FORM_REQUEST,
      serverCancel.signal,
    );
    await flush();
    expect(closedEvents(events)).toEqual([]);

    serverCancel.abort("server cancelled");

    await expect(pending).resolves.toBeNull();
    expect(closedEvents(events)).toEqual([
      {
        ...occurrenceOf(events, "mcp_elicitation_request"),
        kind: "mcp",
        requestId: 7,
        serverName: "srv",
        turnId: "turn-1",
        outcome: "withdrawn",
      },
    ]);
    await expect(
      session.notifyMcpElicitationResponse("srv", 7, { action: "accept" }),
    ).resolves.toBe(false);
    unsubscribe();
  });

  it("announces an answered MCP elicitation once", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const pending = session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST);
    await flush();

    await expect(
      session.notifyMcpElicitationResponse("srv", "mcp-1", { action: "decline" }),
    ).resolves.toBe(true);

    await expect(pending).resolves.toEqual({ action: "decline" });
    expect(closedEvents(events)).toEqual([
      {
        ...occurrenceOf(events, "mcp_elicitation_request"),
        kind: "mcp",
        requestId: "mcp-1",
        serverName: "srv",
        turnId: "turn-1",
        outcome: "answered",
      },
    ]);
    unsubscribe();
  });

  it("announces a request_user_input withdrawn by its tool call", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const toolCall = new AbortController();
    const pending = session.requestUserInput(
      "call-1",
      USER_INPUT_ARGS,
      toolCall.signal,
    );
    await flush();

    toolCall.abort("interrupted");

    await expect(pending).resolves.toBeNull();
    expect(closedEvents(events)).toEqual([
      {
        ...occurrenceOf(events, "request_user_input"),
        kind: "request_user_input",
        requestId: "call-1",
        turnId: "turn-1",
        outcome: "withdrawn",
      },
    ]);
    unsubscribe();
  });

  it("announces a request_user_input answered with a null response as answered", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const pending = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();

    await expect(session.notifyUserInputResponse("call-1", null)).resolves.toBe(true);

    await expect(pending).resolves.toBeNull();
    expect(closedEvents(events)).toEqual([
      {
        ...occurrenceOf(events, "request_user_input"),
        kind: "request_user_input",
        requestId: "call-1",
        turnId: "turn-1",
        outcome: "answered",
      },
    ]);
    unsubscribe();
  });

  it("announces direct-resolver requests as answered or withdrawn", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const renderer = installElicitationResolvers(session, () => {});
    try {
      const answered = session.requestUserInput("call-1", USER_INPUT_ARGS);
      await flush();
      expect(renderer.submit("Yes")).toBe(true);
      await expect(answered).resolves.toEqual({
        answers: { choice: { answers: ["Yes"] } },
      });

      const serverCancel = new AbortController();
      const withdrawn = session.requestMcpElicitation(
        "srv",
        "mcp-2",
        FORM_REQUEST,
        serverCancel.signal,
      );
      await flush();
      serverCancel.abort("server cancelled");
      await expect(withdrawn).resolves.toBeNull();

      expect(closedEvents(events)).toEqual([
        {
          ...occurrenceOf(events, "request_user_input"),
          kind: "request_user_input",
          requestId: "call-1",
          turnId: "turn-1",
          outcome: "answered",
        },
        {
          ...occurrenceOf(events, "mcp_elicitation_request"),
          kind: "mcp",
          requestId: "mcp-2",
          serverName: "srv",
          turnId: "turn-1",
          outcome: "withdrawn",
        },
      ]);
    } finally {
      renderer.cleanup();
      unsubscribe();
    }
  });

  it("announces nothing for a request that was never published", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const alreadyStopped = new AbortController();
    alreadyStopped.abort("interrupted");

    await expect(
      session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST, alreadyStopped.signal),
    ).resolves.toBeNull();
    await expect(
      session.requestUserInput("call-1", USER_INPUT_ARGS, alreadyStopped.signal),
    ).resolves.toBeNull();

    expect(
      events.filter((event) =>
        event.msg.type === "mcp_elicitation_request" ||
        event.msg.type === "request_user_input" ||
        event.msg.type === "elicitation_closed",
      ),
    ).toEqual([]);
    unsubscribe();
  });

  it("names each occurrence of a request id reused in the same turn", async () => {
    const { session, events, unsubscribe } = await startedSession();
    const first = session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    await flush();
    await session.notifyMcpElicitationResponse("srv", 7, { action: "decline" });
    await expect(first).resolves.toEqual({ action: "decline" });
    const second = session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    await flush();

    const firstOccurrence = occurrenceOf(events, "mcp_elicitation_request", 0);
    const secondOccurrence = occurrenceOf(events, "mcp_elicitation_request", 1);
    expect(secondOccurrence.requestEventId).not.toBe(firstOccurrence.requestEventId);
    expect(session.pendingElicitationSnapshot().pending).toEqual([
      {
        eventId: secondOccurrence.requestEventId,
        sequence: secondOccurrence.requestEventSeq,
        kind: "mcp",
        requestId: 7,
        serverName: "srv",
        turnId: "turn-1",
      },
    ]);

    await session.notifyMcpElicitationResponse("srv", 7, { action: "accept", content: { name: "x" } });
    await expect(second).resolves.toMatchObject({ action: "accept" });
    expect(closedEvents(events)).toEqual([
      expect.objectContaining({ ...firstOccurrence, outcome: "answered" }),
      expect.objectContaining({ ...secondOccurrence, outcome: "answered" }),
    ]);
    unsubscribe();
  });

  it("lists the pending occurrences with the sequence the set was taken at", async () => {
    const { session, events, unsubscribe } = await startedSession();
    expect(session.pendingElicitationSnapshot()).toEqual({
      asOfSequence: session.eventLog.lastSeq,
      pending: [],
    });
    const toolCall = new AbortController();
    const question = session.requestUserInput("call-1", USER_INPUT_ARGS, toolCall.signal);
    const form = session.requestMcpElicitation("srv", "mcp-1", FORM_REQUEST);
    await flush();
    const questionOccurrence = occurrenceOf(events, "request_user_input");
    const formOccurrence = occurrenceOf(events, "mcp_elicitation_request");

    const both = session.pendingElicitationSnapshot();
    expect(both.asOfSequence).toBe(session.eventLog.lastSeq);
    expect(both.asOfSequence).toBeGreaterThanOrEqual(formOccurrence.requestEventSeq);
    expect(both.pending).toEqual([
      {
        eventId: questionOccurrence.requestEventId,
        sequence: questionOccurrence.requestEventSeq,
        kind: "request_user_input",
        requestId: "call-1",
        turnId: "turn-1",
      },
      {
        eventId: formOccurrence.requestEventId,
        sequence: formOccurrence.requestEventSeq,
        kind: "mcp",
        requestId: "mcp-1",
        serverName: "srv",
        turnId: "turn-1",
      },
    ]);

    await session.notifyMcpElicitationResponse("srv", "mcp-1", { action: "decline" });
    await form;
    expect(session.pendingElicitationSnapshot().pending.map((entry) => entry.eventId)).toEqual([
      questionOccurrence.requestEventId,
    ]);

    toolCall.abort("interrupted");
    await expect(question).resolves.toBeNull();
    const none = session.pendingElicitationSnapshot();
    expect(none.pending).toEqual([]);
    // The set is taken after each close: a client compares requests to it.
    expect(none.asOfSequence).toBe(session.eventLog.lastSeq);
    unsubscribe();
  });
  it("rejects an answer for an earlier occurrence after the address is replaced", async () => {
    const { session, unsubscribe } = await startedSession();
    const stop = new AbortController();
    const first = session.requestMcpElicitation("srv", 7, FORM_REQUEST, stop.signal);
    await flush();
    const oldId = session.pendingElicitationSnapshot().pending[0]!.eventId;
    stop.abort();
    await first;
    const replacement = session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    await flush();
    const newId = session.pendingElicitationSnapshot().pending[0]!.eventId;
    expect(await session.notifyMcpElicitationResponse("srv", 7, { action: "decline" }, oldId)).toBe(false);
    expect(session.pendingElicitationSnapshot().pending[0]!.eventId).toBe(newId);
    expect(await session.notifyMcpElicitationResponse("srv", 7, { action: "accept" }, newId)).toBe(true);
    await expect(replacement).resolves.toEqual({ action: "accept" });
    unsubscribe();
  });

  it("fences a delayed user answer inside the turn lock after replacement", async () => {
    const { session, unsubscribe } = await startedSession();
    const stop = new AbortController();
    const first = session.requestUserInput("call-1", USER_INPUT_ARGS, stop.signal);
    await flush();
    const oldId = session.pendingElicitationSnapshot().pending[0]!.eventId;
    const withState = session.withActiveTurnState.bind(session);
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(session, "withActiveTurnState").mockImplementationOnce(async (fn) => {
      await held;
      return withState(fn);
    });
    // The old response is already in delivery, but has not acquired the lock.
    const delayed = session.notifyUserInputResponse("call-1", null, oldId);
    stop.abort();
    await first;
    const replacement = session.requestUserInput("call-1", USER_INPUT_ARGS);
    await flush();
    const newId = session.pendingElicitationSnapshot().pending[0]!.eventId;
    release();
    expect(await delayed).toBe(false);
    expect(await session.notifyUserInputResponse("call-1", null, newId)).toBe(true);
    await replacement;
    unsubscribe();
  });

  it("never reuses an occurrence identity when a fresh runtime reuses journal sequences", async () => {
    const a = await startedSession();
    const b = await startedSession();
    const first = a.session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    const second = b.session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    await flush();
    const old = a.session.pendingElicitationSnapshot().pending[0]!;
    const fresh = b.session.pendingElicitationSnapshot().pending[0]!;
    expect(old.sequence).toBe(fresh.sequence);
    expect(old.eventId).not.toBe(fresh.eventId);
    expect(await b.session.notifyMcpElicitationResponse("srv", 7, { action: "decline" }, old.eventId)).toBe(false);
    await a.session.notifyMcpElicitationResponse("srv", 7, { action: "cancel" });
    await b.session.notifyMcpElicitationResponse("srv", 7, { action: "cancel" });
    await Promise.all([first, second]);
    a.unsubscribe(); b.unsubscribe();
  });

  it("withdrawing a replaced entry cannot delete the replacement resolver", async () => {
    const { session, unsubscribe } = await startedSession();
    const stop = new AbortController();
    const first = session.requestMcpElicitation("srv", 7, FORM_REQUEST, stop.signal);
    await flush();
    const oldId = session.pendingElicitationSnapshot().pending[0]!.eventId;
    const second = session.requestMcpElicitation("srv", 7, FORM_REQUEST);
    await flush();
    const newId = session.pendingElicitationSnapshot().pending.find((entry) => entry.eventId !== oldId)!.eventId;
    stop.abort();
    await first;
    expect(await session.notifyMcpElicitationResponse("srv", 7, { action: "decline" }, newId)).toBe(true);
    await expect(second).resolves.toEqual({ action: "decline" });
    unsubscribe();
  });

});
